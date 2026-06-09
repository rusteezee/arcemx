"""Aggregate all signals → LLM → save analysis row."""
import os
import json
import pandas as pd
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

from fetchers.prices import load_universe, latest_snapshot
from fetchers.news import fetch_rss, fetch_gnews
from fetchers.trends import fetch_trends
from fetchers.reddit import fetch_hot
from fetchers.fii_dii import fetch_latest as fetch_fii_dii
from analyzer.technical import screen_universe, rank_candidates
from analyzer.llm_router import analyze
from analyzer.feedback import build_feedback as _load_feedback
from analyzer.market_context import build_market_context
from analyzer.news_digest import build_news_digest

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]


def build_payload() -> dict:
    universe = load_universe()
    print(f"Universe: {len(universe)}")

    print("Screening technicals...")
    signals = screen_universe(universe)
    ranked = rank_candidates(signals, n=15)

    print("Fetching news (live + DB lookback)...")
    # Live pull (latest possible)
    live_news = fetch_rss()[:80] + fetch_gnews()[:40]
    # DB lookback: pull last 72h to bridge weekend/gap days
    lookback_hours = 72
    db_news = []
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if url and key:
        try:
            sb = create_client(url, key)
            since = (datetime.utcnow() - timedelta(hours=lookback_hours)).isoformat()
            res = sb.table("news").select("source,title,url,published_at").gte(
                "published_at", since
            ).order("published_at", desc=True).limit(200).execute()
            db_news = res.data or []
            print(f"DB news (last {lookback_hours}h): {len(db_news)}")
        except Exception as e:
            print(f"DB news fetch fail: {e}")

    # Merge + dedupe by URL
    seen_urls = set()
    merged = []
    for n in live_news + db_news:
        u = n.get("url") or ""
        if u and u in seen_urls:
            continue
        if u:
            seen_urls.add(u)
        merged.append(n)
    # Sort by published_at desc
    merged.sort(key=lambda n: n.get("published_at") or "", reverse=True)
    # Structured, deduped, materiality-ranked digest is the primary news signal.
    news_digest = build_news_digest(merged, top_n=20)
    # Keep a small raw tail so the model can still see exact headlines if needed.
    news_compact = [
        {"src": n["source"], "title": n["title"], "pub": n.get("published_at")}
        for n in merged[:30]
    ]
    print(f"News digest: {news_digest.get('n_stories')} stories from "
          f"{news_digest.get('n_raw')} raw; net_sentiment {news_digest.get('net_sentiment')}")

    print("Fetching trends...")
    trends = fetch_trends()

    print("Fetching reddit...")
    reddit_posts = fetch_hot(limit=15)

    print("Index snapshot...")
    idx_snap = latest_snapshot(["^NSEI", "^BSESN", "^NSEBANK", "^DJI", "^IXIC", "^GSPC"])

    print("Market context (index technicals + global cues)...")
    try:
        market_context = build_market_context()
    except Exception as e:
        print(f"market_context fail: {e}")
        market_context = {}

    print("FII / DII flows...")
    flows = None
    try:
        flows = fetch_fii_dii()
        if flows:
            print(f"  FII cash net {flows.get('fii_cash_cr')} cr, "
                  f"DII cash net {flows.get('dii_cash_cr')} cr, "
                  f"PCR {flows.get('pcr')}")
        else:
            print("  no flow data available")
    except Exception as e:
        print(f"flows fail: {e}")

    print("User holdings + wishlist...")
    holdings, wishlist, prior_call = [], [], None
    holding_technicals, wishlist_technicals = {}, {}
    if url and key:
        sb = create_client(url, key)
        h = sb.table("portfolio").select("ticker,qty,avg_buy_price").execute()
        holdings = h.data or []
        w = sb.table("wishlist").select("ticker").execute()
        wishlist = [x["ticker"] for x in (w.data or [])]

        # Per-stock technicals for holdings + wishlist specifically. Most of
        # the user's holdings are smallcap/midcap and NOT in the NIFTY50
        # universe, so screen_universe never produced ATR/SR/RSI for them.
        # The new holding_outlooks_1d / wishlist_outlooks_1d schema demands
        # the model anchor per-stock predictions to ATR + S/R, so we have
        # to enrich here. Tickers stored in DB may or may not have .NS so
        # we tolerate both.
        def _norm(t: str) -> str:
            t = (t or "").strip().upper()
            return t if t.endswith(".NS") else f"{t}.NS"
        focus_tickers = list({_norm(h["ticker"]) for h in holdings if h.get("ticker")}
                             | {_norm(t) for t in wishlist})
        if focus_tickers:
            try:
                focus_signals = screen_universe(focus_tickers)
                holding_set = {_norm(h["ticker"]) for h in holdings if h.get("ticker")}
                wishlist_set = {_norm(t) for t in wishlist}
                for tk, sig in focus_signals.items():
                    if not sig:
                        continue
                    if tk in holding_set:
                        holding_technicals[tk] = sig
                    if tk in wishlist_set:
                        wishlist_technicals[tk] = sig
                print(f"Per-stock technicals: holdings={len(holding_technicals)} "
                      f"wishlist={len(wishlist_technicals)}")
            except Exception as e:
                print(f"focus technicals fail: {e}")
        # Prior analysis for self-context
        try:
            prev = sb.table("analysis").select("run_at,market_mood,raw_json").order(
                "run_at", desc=True
            ).limit(1).execute()
            if prev.data:
                pr = prev.data[0]
                prior_call = {
                    "run_at": pr.get("run_at"),
                    "market_mood": pr.get("market_mood"),
                    "nifty_outlook": (pr.get("raw_json") or {}).get("nifty_outlook"),
                    "sensex_outlook": (pr.get("raw_json") or {}).get("sensex_outlook"),
                    "short_term_picks": (pr.get("raw_json") or {}).get("short_term_picks", [])[:5],
                }
        except Exception as e:
            print(f"Prior call fetch fail: {e}")

    # Order matters: analyze() truncates the JSON payload at ~120k chars,
    # so the highest-leverage signal must come FIRST. self_feedback (the
    # self-learning track record) and market_context (the index ATR/SR
    # anchor) are non-negotiable; if they get cut, the entire reasoning
    # discipline collapses. news_recent is the cheapest tail to lose
    # since news_digest already carries the signal.
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "self_feedback": _load_feedback(),
        "market_context": market_context,
        "flows": flows,
        "indices": idx_snap.to_dict(orient="records") if not idx_snap.empty else [],
        "user_holdings": holdings,
        "user_wishlist": wishlist,
        "holding_technicals": holding_technicals,
        "wishlist_technicals": wishlist_technicals,
        "prior_call": prior_call,
        "technical_bullish_top": ranked["bullish"],
        "technical_bearish_top": ranked["bearish"],
        "news_digest": news_digest,
        "google_trends": trends,
        "reddit_hot": reddit_posts[:20],
        "news_lookback_hours": 72,
        "news_recent": news_compact,
    }


def run(model_name: str | None = None) -> dict:
    payload = build_payload()
    print("Calling Gemini...")
    result = analyze(payload, model_name=model_name)
    save(result, payload)
    return result


def save(result: dict, payload: dict) -> None:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        out_path = ROOT / "data" / f"analysis_{datetime.utcnow().strftime('%Y%m%d_%H%M')}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps({"result": result, "payload_summary": {
            "indices": payload.get("indices"),
            "n_news": len(payload.get("news_recent", [])),
        }}, indent=2, default=str))
        print(f"Saved local: {out_path}")
        return
    sb = create_client(url, key)
    sb.table("analysis").insert({
        "market_mood": result.get("market_mood"),
        "nifty_outlook": json.dumps(result.get("nifty_outlook")),
        "sensex_outlook": json.dumps(result.get("sensex_outlook")),
        "short_term_picks": result.get("short_term_picks"),
        "long_term_picks": result.get("long_term_picks"),
        "reasoning": result.get("reasoning"),
        "raw_json": result,
    }).execute()
    print("Saved to Supabase")


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, indent=2, default=str)[:2000])

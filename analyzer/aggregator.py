"""Aggregate all signals → LLM → save analysis row."""
import os
import json
import pandas as pd
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

from fetchers.prices import load_universe, latest_snapshot
from fetchers.news import fetch_rss, fetch_gnews
from fetchers.trends import fetch_trends
from fetchers.reddit import fetch_hot
from analyzer.technical import screen_universe, rank_candidates
from analyzer.llm import analyze

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]


def build_payload() -> dict:
    universe = load_universe()
    print(f"Universe: {len(universe)}")

    print("Screening technicals...")
    signals = screen_universe(universe)
    ranked = rank_candidates(signals, n=15)

    print("Fetching news...")
    news = fetch_rss()[:80] + fetch_gnews()[:40]
    news_compact = [{"src": n["source"], "title": n["title"], "pub": n.get("published_at")} for n in news]

    print("Fetching trends...")
    trends = fetch_trends()

    print("Fetching reddit...")
    reddit_posts = fetch_hot(limit=15)

    print("Index snapshot...")
    idx_snap = latest_snapshot(["^NSEI", "^BSESN", "^NSEBANK", "^DJI", "^IXIC", "^GSPC"])

    print("User holdings + wishlist...")
    holdings, wishlist = [], []
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if url and key:
        sb = create_client(url, key)
        h = sb.table("portfolio").select("ticker,qty,avg_buy_price").execute()
        holdings = h.data or []
        w = sb.table("wishlist").select("ticker").execute()
        wishlist = [x["ticker"] for x in (w.data or [])]

    return {
        "timestamp": datetime.utcnow().isoformat(),
        "indices": idx_snap.to_dict(orient="records") if not idx_snap.empty else [],
        "technical_bullish_top": ranked["bullish"],
        "technical_bearish_top": ranked["bearish"],
        "news_recent": news_compact[:60],
        "google_trends": trends,
        "reddit_hot": reddit_posts[:20],
        "user_holdings": holdings,
        "user_wishlist": wishlist,
    }


def run() -> dict:
    payload = build_payload()
    print("Calling Gemini...")
    result = analyze(payload)
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

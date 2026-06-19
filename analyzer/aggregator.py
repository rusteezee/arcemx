"""Aggregate all signals → LLM → save analysis row."""
import gc
import os
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf
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


def _ticker_fundamentals(info: dict) -> dict:
    """Distil yfinance Ticker.info into the small subset the LLM
    actually reasons over. info has ~150 fields; most are noise
    (timezone, exchange code, business summary text). Keep the
    valuation, growth, profitability, leverage anchors PLUS the
    analyst-consensus / 52-week / EV / holder fields that Yahoo
    already returns inside the same .info blob (zero extra API
    cost). Earlier passes discarded these alongside the noise; they
    are high-signal for a next-day call grounded in price levels
    and analyst dispersion."""
    def _g(k):
        v = info.get(k)
        return v if isinstance(v, (int, float)) and v == v else None
    mcap = _g("marketCap")
    last = _g("regularMarketPrice") or _g("currentPrice")
    hi52 = _g("fiftyTwoWeekHigh")
    lo52 = _g("fiftyTwoWeekLow")
    target_mean = _g("targetMeanPrice")
    # Position within the 52w range as 0..100 (last == low -> 0, last
    # == high -> 100). Single number replaces three for the prompt and
    # the model handles "near 52w high" reasoning cleanly.
    range_pos = None
    if last is not None and hi52 is not None and lo52 is not None and hi52 > lo52:
        range_pos = round(((last - lo52) / (hi52 - lo52)) * 100, 1)
    # Upside vs analyst mean target as percent. Negative = price above
    # consensus target. Captures both magnitude and direction.
    analyst_upside_pct = None
    if last is not None and target_mean is not None and last > 0:
        analyst_upside_pct = round(((target_mean - last) / last) * 100, 1)
    return {
        "pe_trailing": _g("trailingPE"),
        "pe_forward": _g("forwardPE"),
        "peg": _g("pegRatio"),
        "pb": _g("priceToBook"),
        "ps": _g("priceToSalesTrailing12Months"),
        "ev_to_ebitda": _g("enterpriseToEbitda"),
        "ev_to_revenue": _g("enterpriseToRevenue"),
        "roe_pct": (_g("returnOnEquity") or 0) * 100 if _g("returnOnEquity") is not None else None,
        "roa_pct": (_g("returnOnAssets") or 0) * 100 if _g("returnOnAssets") is not None else None,
        "profit_margin_pct": (_g("profitMargins") or 0) * 100 if _g("profitMargins") is not None else None,
        "op_margin_pct": (_g("operatingMargins") or 0) * 100 if _g("operatingMargins") is not None else None,
        "gross_margin_pct": (_g("grossMargins") or 0) * 100 if _g("grossMargins") is not None else None,
        "debt_to_equity": _g("debtToEquity"),
        "current_ratio": _g("currentRatio"),
        "quick_ratio": _g("quickRatio"),
        "revenue_growth_yoy_pct": (_g("revenueGrowth") or 0) * 100 if _g("revenueGrowth") is not None else None,
        "earnings_growth_yoy_pct": (_g("earningsGrowth") or 0) * 100 if _g("earningsGrowth") is not None else None,
        "earnings_growth_qoq_pct": (_g("earningsQuarterlyGrowth") or 0) * 100 if _g("earningsQuarterlyGrowth") is not None else None,
        "dividend_yield_pct": (_g("dividendYield") or 0) * 100 if _g("dividendYield") is not None else None,
        "payout_ratio_pct": (_g("payoutRatio") or 0) * 100 if _g("payoutRatio") is not None else None,
        "beta": _g("beta"),
        "market_cap_cr": round(mcap / 1e7, 0) if mcap else None,
        "avg_volume_10d": _g("averageVolume10days"),
        "short_pct_float": (_g("shortPercentOfFloat") or 0) * 100 if _g("shortPercentOfFloat") is not None else None,
        # 52-week price anchors. range_pos collapses three numbers into
        # one for the prompt; raw hi/lo kept for cases where the model
        # needs the absolute levels.
        "wk52_high": hi52,
        "wk52_low": lo52,
        "wk52_range_pos_pct": range_pos,
        # Analyst consensus from the .info dict that was already fetched
        # and discarded. recommendationKey is the qualitative
        # ("buy"/"hold"/"sell"); recommendationMean is the 1-5 numeric
        # (1=strong_buy, 5=strong_sell). target_mean + upside complete
        # the picture.
        "analyst_target_mean": target_mean,
        "analyst_target_low": _g("targetLowPrice"),
        "analyst_target_high": _g("targetHighPrice"),
        "analyst_upside_pct": analyst_upside_pct,
        "analyst_recommendation": info.get("recommendationKey"),
        "analyst_recommendation_mean": _g("recommendationMean"),
        "analyst_count": _g("numberOfAnalystOpinions"),
        # Holder breakdown from .info. Full Holders tab would need
        # extra API calls; these two are zero-cost.
        "held_pct_institutions": (_g("heldPercentInstitutions") or 0) * 100 if _g("heldPercentInstitutions") is not None else None,
        "held_pct_insiders": (_g("heldPercentInsiders") or 0) * 100 if _g("heldPercentInsiders") is not None else None,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def _ticker_calendar(t) -> dict:
    """Pull Ticker.calendar for next earnings + ex-dividend dates.
    Soft-fails on every yfinance shape variant (returns dict on newer
    SDKs, DataFrame on older, AttributeError if unsupported). The
    next-earnings flag is decisive for a next-day call: a holding
    that reports tomorrow has a fundamentally different risk profile
    than one whose earnings are 80 days out, and the model was
    previously blind to it."""
    out: dict = {}
    try:
        cal = t.calendar
    except Exception:
        return out
    if cal is None:
        return out
    try:
        # Newer yfinance: dict with 'Earnings Date' as a list of date
        # objects (the reporting window) and 'Ex-Dividend Date' as a
        # single date.
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date") or cal.get("earningsDate")
            if isinstance(ed, (list, tuple)) and ed:
                first = ed[0]
                if hasattr(first, "isoformat"):
                    out["next_earnings_date"] = first.isoformat()[:10]
                else:
                    out["next_earnings_date"] = str(first)[:10]
            elif ed:
                if hasattr(ed, "isoformat"):
                    out["next_earnings_date"] = ed.isoformat()[:10]
                else:
                    out["next_earnings_date"] = str(ed)[:10]
            ex = cal.get("Ex-Dividend Date") or cal.get("exDividendDate")
            if ex:
                if hasattr(ex, "isoformat"):
                    out["ex_dividend_date"] = ex.isoformat()[:10]
                else:
                    out["ex_dividend_date"] = str(ex)[:10]
        else:
            # Older yfinance: DataFrame with columns named after the
            # dates. Skip — the dict form covers every recent version.
            pass
    except Exception:
        pass
    # Days-to-earnings is the field the model will reason over most
    # often, derive it here so the prompt does not have to date-math.
    ned = out.get("next_earnings_date")
    if ned:
        try:
            d = datetime.fromisoformat(ned).date()
            days = (d - datetime.now(timezone.utc).date()).days
            out["days_to_earnings"] = days
        except Exception:
            pass
    return out


def _ticker_news(news: list) -> list:
    """Normalise yfinance Ticker.news across SDK versions. yfinance
    0.2.40+ wraps each item in {content: {...}}; older versions return
    flat {title, publisher, providerPublishTime, ...}. Keep the top 5
    most-recent stories per ticker, title + publisher + iso publish
    date only; the LLM only needs the headline signal, not links."""
    out = []
    for item in (news or [])[:8]:
        if not isinstance(item, dict):
            continue
        c = item.get("content") if isinstance(item.get("content"), dict) else item
        title = c.get("title") or item.get("title")
        if not title:
            continue
        prov = c.get("provider")
        if isinstance(prov, dict):
            publisher = prov.get("displayName")
        else:
            publisher = c.get("publisher") or item.get("publisher")
        pub_raw = (c.get("pubDate") or c.get("displayTime")
                   or item.get("providerPublishTime"))
        published_at = None
        if isinstance(pub_raw, (int, float)):
            try:
                published_at = datetime.utcfromtimestamp(pub_raw).isoformat()
            except (OSError, ValueError):
                published_at = None
        elif isinstance(pub_raw, str):
            published_at = pub_raw
        out.append({
            "title": title,
            "publisher": publisher,
            "published_at": published_at,
        })
        if len(out) >= 5:
            break
    return out


def _fetch_ticker_enrichment(ticker: str) -> tuple[str, dict]:
    """Per-ticker fundamentals + news pull. Returns the ticker plus a
    {fundamentals, news} dict. Soft-fails: yfinance can 429, 404 on
    illiquid Indian symbols, or hang; we never let one bad ticker take
    down the whole morning pipeline. Distils Ticker.info immediately
    and `del`s the raw dict so the ~1 MB blob does not linger; gc
    after each ticker keeps the per-thread heap from accumulating."""
    out = {"fundamentals": None, "news": []}
    try:
        t = yf.Ticker(ticker)
        try:
            info = t.info or {}
        except Exception:
            info = {}
        if info:
            out["fundamentals"] = _ticker_fundamentals(info)
        del info
        try:
            news = t.news or []
        except Exception:
            news = []
        if news:
            out["news"] = _ticker_news(news)
        del news
        # Calendar (next earnings + ex-dividend). Folded into the same
        # fundamentals jsonb so the cache schema stays as-is (ticker,
        # fundamentals, news, updated_at). Adds ~2-3 keys, negligible
        # token cost, but earnings proximity is a decisive next-day
        # signal the model previously had no view of.
        cal = _ticker_calendar(t)
        if cal:
            if out["fundamentals"] is None:
                out["fundamentals"] = {}
            out["fundamentals"].update(cal)
        del t
        gc.collect()
    except Exception as e:
        out["error"] = str(e)[:120]
    return ticker, out


# How long a cached enrichment row stays fresh. Fundamentals (P/E,
# margins, growth) are quarterly anchors and tolerate a day of
# staleness easily; news headlines lose freshness faster but the model
# already gets the broad-market news_digest tail. 24h hits the right
# balance for a once-daily 8:30 IST call.
_ENRICHMENT_TTL_HOURS = 24


def _read_enrichment_cache(sb, tickers: list[str]) -> dict:
    """Return {ticker: {fundamentals, news}} for every ticker whose
    cache row exists AND was updated within the TTL. Soft-fails on a
    missing table (catches the bootstrap window before db/schema.sql is
    applied) and on every Supabase transient: returns {} so callers
    treat it as "nothing cached" and refetch."""
    try:
        cutoff = (datetime.now(timezone.utc)
                  - timedelta(hours=_ENRICHMENT_TTL_HOURS)).isoformat()
        res = sb.table("ticker_enrichment").select(
            "ticker,fundamentals,news,updated_at"
        ).in_("ticker", tickers).gte("updated_at", cutoff).execute().data or []
        return {
            r["ticker"]: {
                "fundamentals": r.get("fundamentals"),
                "news": r.get("news") or [],
            }
            for r in res
        }
    except Exception as e:
        print(f"  enrichment cache read skip: {str(e)[:120]}")
        return {}


def _write_enrichment_cache(sb, fresh: dict) -> None:
    """Upsert freshly fetched enrichment rows. Soft-fails on a missing
    table (the next morning run will retry); never lets a cache write
    failure block payload assembly."""
    if not fresh:
        return
    rows = [
        {
            "ticker": tk,
            "fundamentals": v.get("fundamentals"),
            "news": v.get("news") or [],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        for tk, v in fresh.items()
    ]
    try:
        sb.table("ticker_enrichment").upsert(rows, on_conflict="ticker").execute()
    except Exception as e:
        print(f"  enrichment cache write skip: {str(e)[:120]}")


def _fetch_enrichment(tickers: list[str], sb=None) -> dict:
    """Per-ticker fundamentals + news with a 24h Supabase cache. Reads
    cache first, fans out yfinance only for tickers missing or stale,
    upserts the fresh ones. Render free tier (512 MB) was OOM-killed
    by the original 6-worker uncached fan-out on every restart; now
    the second restart of the day re-fetches almost nothing. Worker
    pool dropped 6 -> 3 to cap simultaneous Ticker.info heap usage."""
    if not tickers:
        return {}
    enr: dict = {}
    missing = list(tickers)
    if sb is not None:
        cached = _read_enrichment_cache(sb, tickers)
        if cached:
            print(f"  enrichment cache hit on {len(cached)}/{len(tickers)} tickers")
            enr.update(cached)
            missing = [t for t in tickers if t not in cached]
    if not missing:
        return enr
    fresh: dict = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(_fetch_ticker_enrichment, t): t for t in missing}
        for f in as_completed(futs):
            try:
                tk, payload = f.result(timeout=20)
                fresh[tk] = payload
            except Exception as e:
                fresh[futs[f]] = {"fundamentals": None, "news": [], "error": str(e)[:120]}
    if sb is not None:
        _write_enrichment_cache(sb, fresh)
    enr.update(fresh)
    gc.collect()
    return enr


def build_payload() -> dict:
    universe = load_universe()
    print(f"Universe: {len(universe)}")

    print("Screening technicals...")
    signals = screen_universe(universe)
    ranked = rank_candidates(signals, n=15)
    # Release the universe-wide signals dict + yfinance candle frames
    # before the heavier per-stock enrichment fan-out runs. On Render's
    # 512 MB free tier this is the difference between staying alive and
    # an OOM-kill during the 8:30 cron.
    del signals, universe
    gc.collect()

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
    holding_enrichment, wishlist_enrichment = {}, {}
    if url and key:
        sb = create_client(url, key)
        h = sb.table("portfolio").select("ticker,qty,avg_buy_price").execute()
        holdings = h.data or []
        w = sb.table("wishlist").select("ticker").execute()
        wishlist_raw = [x["ticker"] for x in (w.data or [])]

        # Filter out tickers that look like US ADRs / non-NSE listings before
        # they reach the prompt. Symbols stored as bare 1-5 letters with no
        # dot suffix and no .NS / .BO indicator (e.g. SFTBY, HMC, PINS) yield
        # no yfinance data when force-suffixed with .NS, so the per-stock
        # technicals enrichment fails silently and the model still emits a
        # row with no ATR/SR anchor (which the no-bluff rule forbids). The
        # cleanest hard guard is upstream: drop them here so the model never
        # sees a ticker we cannot ground in payload data. Indian listings
        # are always either suffixed (".NS"/".BO") or live in our NSE
        # universe; anything else gets routed to the dashboard wishlist
        # display only, not into the LLM call.
        _NSE_SUFFIXES = (".NS", ".BO")

        def _is_indian_listing(t: str) -> bool:
            t = (t or "").strip().upper()
            if not t:
                return False
            if t.endswith(_NSE_SUFFIXES):
                return True
            # Bare-name candidates: accept only if a probe with .NS suffix
            # is genuinely a valid NSE listing in our universe CSV. The
            # universe file is the source of truth for "is this an NSE
            # ticker?" so we don't burn a yfinance call per request.
            try:
                from fetchers.prices import load_universe
                uni = set(load_universe())
            except Exception:
                uni = set()
            return f"{t}.NS" in uni or t in uni

        wishlist = [t for t in wishlist_raw if _is_indian_listing(t)]
        skipped = [t for t in wishlist_raw if t not in wishlist]
        if skipped:
            print(f"Wishlist non-NSE skipped (no yfinance .NS data): {skipped}")

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

        # Per-stock fundamentals + per-ticker news for holdings +
        # wishlist. yfinance Ticker.info gives valuation (P/E, P/B),
        # growth (revenue/earnings YoY+QoQ), profitability (ROE,
        # margins), leverage (D/E, current ratio), and beta;
        # Ticker.news gives 5 most-recent stories per stock. Both are
        # free. Fan out with a small thread pool so 15 tickers do not
        # serially burn 30-45s of wall time.
        holding_enrichment: dict = {}
        wishlist_enrichment: dict = {}
        holding_set = {_norm(h["ticker"]) for h in holdings if h.get("ticker")}
        wishlist_set = {_norm(t) for t in wishlist}
        all_focus = sorted(holding_set | wishlist_set)
        if all_focus:
            print(f"Fetching per-ticker fundamentals + news for {len(all_focus)} names...")
            try:
                enr = _fetch_enrichment(all_focus, sb=sb)
                for tk, payload in enr.items():
                    if tk in holding_set:
                        holding_enrichment[tk] = payload
                    if tk in wishlist_set:
                        wishlist_enrichment[tk] = payload
                n_fund = sum(1 for v in enr.values() if v.get("fundamentals"))
                n_news = sum(1 for v in enr.values() if v.get("news"))
                print(f"  fundamentals on {n_fund}/{len(all_focus)}, news on {n_news}/{len(all_focus)}")
                del enr
            except Exception as e:
                print(f"per-ticker enrichment fail: {e}")
            gc.collect()
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

    # Sensei EOD retrospective from the previous session. The 20:00 IST
    # Sensei cron writes this; tomorrow's analysis reads it as the
    # explicit "homework" block. Tomorrow's prompt mandates the model
    # cite at least one tomorrow_watch / key_insights item in
    # reasoning_breakdown.prior_call_check. If absent (cold start /
    # first run), payload omits the field and prompt falls back to
    # prior_call only.
    sensei_yesterday = None
    if url and key:
        try:
            sn = sb.table("sensei_eod").select(
                "market_close_date,model_used,raw_json"
            ).order("market_close_date", desc=True).limit(1).execute()
            if sn.data:
                sensei_yesterday = {
                    "market_close_date": sn.data[0].get("market_close_date"),
                    "model_used": sn.data[0].get("model_used"),
                    **(sn.data[0].get("raw_json") or {}),
                }
                print(f"sensei_yesterday loaded ({sensei_yesterday.get('market_close_date')})")
        except Exception as e:
            print(f"sensei_yesterday fetch fail: {e}")

    # Order matters: analyze() truncates the JSON payload at ~120k chars,
    # so the highest-leverage signal must come FIRST. self_feedback (the
    # self-learning track record) and market_context (the index ATR/SR
    # anchor) are non-negotiable; if they get cut, the entire reasoning
    # discipline collapses. news_recent is the cheapest tail to lose
    # since news_digest already carries the signal.
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "self_feedback": _load_feedback(),
        "sensei_yesterday": sensei_yesterday,
        "market_context": market_context,
        "flows": flows,
        "indices": idx_snap.to_dict(orient="records") if not idx_snap.empty else [],
        "user_holdings": holdings,
        "user_wishlist": wishlist,
        "holding_technicals": holding_technicals,
        "wishlist_technicals": wishlist_technicals,
        "holding_fundamentals": {tk: v.get("fundamentals") for tk, v in holding_enrichment.items() if v.get("fundamentals")},
        "wishlist_fundamentals": {tk: v.get("fundamentals") for tk, v in wishlist_enrichment.items() if v.get("fundamentals")},
        "holding_news": {tk: v.get("news") for tk, v in holding_enrichment.items() if v.get("news")},
        "wishlist_news": {tk: v.get("news") for tk, v in wishlist_enrichment.items() if v.get("news")},
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


def latest_run_age_minutes() -> float | None:
    """Minutes since the newest analysis row. None when the table is empty
    or Supabase is unconfigured (callers treat None as stale)."""
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        return None
    try:
        sb = create_client(url, key)
        r = sb.table("analysis").select("run_at").order(
            "run_at", desc=True).limit(1).execute()
        if not r.data:
            return None
        run_at = datetime.fromisoformat(
            r.data[0]["run_at"].replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - run_at).total_seconds() / 60
    except Exception as e:
        print(f"latest_run_age check fail: {e}")
        return None


def run_if_stale(max_age_minutes: int = 90,
                 model_name: str | None = None) -> dict | None:
    """Run the analysis only when the newest row is older than the cutoff.

    Two schedulers cover the 08:30 IST morning run: the in-bot APScheduler
    job (primary; GitHub's free-tier cron has fired hours late or skipped
    days outright) and the GH Actions workflow at 08:43 IST (fallback for
    a sleeping Render dyno). Whoever fires second sees a fresh row and
    exits without burning a second LLM call. Returns None when skipped.
    """
    age = latest_run_age_minutes()
    if age is not None and age < max_age_minutes:
        print(f"Analysis is fresh ({age:.0f} min old < {max_age_minutes} min "
              f"cutoff); skipping run")
        return None
    return run(model_name=model_name)


def save(result: dict, payload: dict) -> None:
    # A failed LLM call ({"error": "parse_failed" / "no_choices", ...}) is
    # not an analysis. Saving it poisons everything downstream: the grader
    # scores insight_quality=0 on a missing reasoning_breakdown, prior_call
    # and Sensei read it as a real prediction, and the dashboard renders an
    # empty card. Log and drop instead.
    if not result or result.get("error"):
        print(f"LLM result error ({(result or {}).get('error')}); NOT saving "
              f"an analysis row. raw head: {str((result or {}).get('raw'))[:200]}")
        return
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
    # top_performers / worst_performers are the new primary pick output.
    # Keep writing the legacy short_term_picks / long_term_picks columns
    # (nullable) for backward compat with any reader not yet migrated;
    # they fall back to the new keys so a transition-period row is never
    # empty on either schema. raw_json always carries the full new shape.
    sb.table("analysis").insert({
        "market_mood": result.get("market_mood"),
        "nifty_outlook": json.dumps(result.get("nifty_outlook")),
        "sensex_outlook": json.dumps(result.get("sensex_outlook")),
        "short_term_picks": result.get("short_term_picks") or result.get("top_performers"),
        "long_term_picks": result.get("long_term_picks") or result.get("worst_performers"),
        "reasoning": result.get("reasoning"),
        "raw_json": result,
    }).execute()
    print("Saved to Supabase")


if __name__ == "__main__":
    out = run()
    print(json.dumps(out, indent=2, default=str)[:2000])

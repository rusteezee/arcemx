"""Portfolio defense layer (blueprint 23, Plan C Phase 1).

Cross-references real holdings/wishlist against the three signal sources
this project has actually measured real avoidance edge on -
stocks_to_avoid (avoid_7d t=+7.68), wishlist_signals skip
(t=-6.97, n=176), portfolio_verdicts (hold t=+4.98) - plus
regime_bearish_block (backtest id=11: win rate 40.0% -> 66.67%, first-ever
positive net P&L). Every buy-side dimension measured to date has failed
(top_performer_1d t=-2.56 on n=792, stock_analyst buy rating 0/19 ever -
see KNOWLEDGE_BASE.md section 26/26b); this module makes the one signal
class with proven skill visible where the user actually looks, instead of
leaving it as an internal gate only paper_trader.py/backtest.py ever see.

Display-only. Never opens, closes, or blocks a trade - that enforcement
already exists and shipped separately in blueprint 21 Phases 1 and 4.
Reuses paper_trader._avoid_set()/_bearish_block() directly rather than
re-deriving the same membership logic a third time (this repo has already
been burned twice by hand-duplicated gate logic drifting out of sync -
see KNOWLEDGE_BASE.md section 21).
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from supabase import create_client

from analyzer.paper_trader import _avoid_set, _bearish_block, _normalize_ticker

load_dotenv()


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


REGIME_CAUTION_REASON = (
    "Today's market_mood/nifty_outlook reads bearish (blueprint 21 Phase 4's "
    "regime_bearish_block) - new longs are paused system-wide today. This is "
    "a real but not time-stable signal (66.7% hit rate on 21 down-calls, "
    "10/10 first half vs 4/11 second half of the sample) - track, don't over-read."
)


def _latest_analysis_raw(sb) -> dict:
    row = sb.table("analysis").select("run_at,raw_json").order(
        "run_at", desc=True).limit(1).execute().data
    if not row:
        return {}
    return row[0].get("raw_json") or {}


def _avoid_reason_map(raw: dict) -> dict[str, tuple[str, str]]:
    """normalized ticker -> (reason, source). Mirrors the exact membership
    rule in paper_trader._avoid_set() but keeps the reason text, which that
    function deliberately doesn't return (it's a pure gate, not a display)."""
    out: dict[str, tuple[str, str]] = {}
    for a in (raw.get("stocks_to_avoid") or []):
        if isinstance(a, dict) and a.get("ticker"):
            out[_normalize_ticker(a["ticker"])] = (
                a.get("reason") or "Flagged in stocks_to_avoid.", "stocks_to_avoid")
    for w in (raw.get("wishlist_signals") or []):
        if isinstance(w, dict) and w.get("ticker") and (w.get("signal") or "").lower() == "skip":
            # stocks_to_avoid takes precedence if a ticker somehow appears in
            # both - it's the stronger-measured of the two (t=+7.68 vs
            # t=-6.97 isolated).
            key = _normalize_ticker(w["ticker"])
            out.setdefault(key, (w.get("reason") or "Wishlist signal is skip.", "wishlist_skip"))
    return out


def _verdict_map(raw: dict) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for v in (raw.get("portfolio_verdicts") or []):
        if isinstance(v, dict) and v.get("ticker"):
            out[_normalize_ticker(v["ticker"])] = v
    return out


def _real_universe(sb) -> list[tuple[str, bool]]:
    """(real_ticker_as_stored, is_holding) for every distinct ticker in
    portfolio or wishlist. Real tickers keep their original casing/suffix
    (e.g. "GROWW.NS") since that's what bot/dashboard code already looks
    them up by - normalization only happens internally for matching
    against the LLM's own less consistent ticker formatting."""
    seen: dict[str, bool] = {}
    port = sb.table("portfolio").select("ticker").execute().data or []
    for r in port:
        t = r.get("ticker")
        if t:
            seen[t] = True
    wish = sb.table("wishlist").select("ticker").execute().data or []
    for r in wish:
        t = r.get("ticker")
        if t and t not in seen:
            seen[t] = False
    return list(seen.items())


def compute_snapshot(sb=None) -> list[dict]:
    sb = sb or _sb()
    now_avoid = _avoid_set(sb, datetime.now(timezone.utc))
    bearish = _bearish_block(sb)
    raw = _latest_analysis_raw(sb)
    avoid_reasons = _avoid_reason_map(raw)
    verdicts = _verdict_map(raw)

    rows: list[dict] = []
    for real_ticker, is_holding in _real_universe(sb):
        key = _normalize_ticker(real_ticker)
        v = verdicts.get(key)
        target = None
        stop_loss = None
        if v:
            target = _to_numeric(v.get("target"))
            stop_loss = _to_numeric(v.get("stop_loss"))

        if key in now_avoid:
            reason, source = avoid_reasons.get(
                key, ("Flagged as an avoid/skip signal today.", "stocks_to_avoid"))
            status = "avoid"
        elif v and (v.get("verdict") or "").lower() == "exit":
            status, source = "avoid", "portfolio_verdict"
            reason = v.get("reason") or "Verdict is exit."
        elif v and (v.get("verdict") or "").lower() == "trim":
            status, source = "caution", "portfolio_verdict"
            reason = v.get("reason") or "Verdict is trim."
        elif bearish and is_holding:
            status, source = "caution", "regime"
            reason = REGIME_CAUTION_REASON
        elif v and (v.get("verdict") or "").lower() in ("hold", "add"):
            status, source = "clear", "portfolio_verdict"
            reason = v.get("reason")
        else:
            status, source, reason = "no_data", None, None

        rows.append({
            "ticker": real_ticker,
            "status": status,
            "reason": reason,
            "verdict": (v.get("verdict") if v else None),
            "target": target,
            "stop_loss": stop_loss,
            "source": source,
        })

    if rows:
        sb.table("portfolio_defense_snapshot").upsert(
            rows, on_conflict="ticker").execute()
    return rows


def _to_numeric(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return val
    # target/stop_loss arrive as free-form text despite the prompt's own
    # "MUST be concrete numeric INR" instruction - real live example:
    # GROWW's verdict entry had target="₹205" (currency symbol, no
    # comma) which float() rejects outright. Also handles a range string
    # ("360-400" -> low end) and comma-grouped values ("1,25,000"). Strip
    # everything but digits/dot/minus, then take the first number found.
    s = str(val).replace(",", "")  # strip thousands separators before parsing
    s = re.sub(r"[^0-9.\-]", " ", s)
    match = re.search(r"-?\d+(?:\.\d+)?", s)
    if not match:
        return None
    try:
        return float(match.group())
    except ValueError:
        return None


if __name__ == "__main__":
    result = compute_snapshot()
    print(f"portfolio_defense: computed {len(result)} rows")
    for r in result:
        print(f"  {r['ticker']}: {r['status']}"
              + (f" ({r['source']})" if r['source'] else ""))

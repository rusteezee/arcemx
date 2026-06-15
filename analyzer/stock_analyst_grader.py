"""Deterministic grader for stock_analyses rows.

Walks every `status='ok' AND graded_at IS NULL` row whose
`requested_at + horizon_days` has matured (past trading day plus a
+15 min settle gate), pulls the realized price action via yfinance,
computes three component scores (rating accuracy, phase accuracy,
buy-window hit), and writes back `grade_score` + `grade_notes` +
`graded_at`.

The Stock Analyst LLM's strict learning loop reads these graded rows
on the NEXT call for the same (ticker, horizon) via
analyzer.stock_analyst_llm._prior_predictions, so each grade
literally becomes ground truth the next prediction must reason
against. No row is left ungraded silently: a matured row that
yfinance cannot price is stamped graded_at=now() with a notes string
explaining the gap, so the loop never accumulates orphans.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _matured_rows(sb) -> list[dict]:
    """Page through stock_analyses pulling rows whose horizon has
    elapsed but that have not yet been graded. Settle gate of
    +15 minutes after the horizon's expected close keeps a still-
    trading bar out of the comparison."""
    rows: list[dict] = []
    off = 0
    while True:
        page = sb.table("stock_analyses").select(
            "id,ticker,horizon_days,requested_at,llm_json"
        ).eq("status", "ok").is_("graded_at", "null").order(
            "requested_at", desc=False
        ).range(off, off + 999).execute().data or []
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def _price_window(ticker: str, t0: datetime, t1: datetime) -> dict | None:
    """Pull OHLCV between t0 and t1 (inclusive). Returns
    {t0_close, t1_close, max_high, min_low, n_bars} or None when
    yfinance has no data. t0 and t1 are aware datetimes (UTC); we
    convert to date for the yfinance window."""
    try:
        d0 = t0.date()
        d1 = t1.date()
        # Pad both ends by 3 days so the closest trading-day bar is
        # always inside the fetched window even when t0 / t1 fall on
        # a weekend or holiday.
        ny = yf.download(
            ticker,
            start=(d0 - timedelta(days=3)).isoformat(),
            end=(d1 + timedelta(days=4)).isoformat(),
            progress=False,
            auto_adjust=False,
        )
        if ny is None or ny.empty:
            return None
        if isinstance(ny.columns, pd.MultiIndex):
            ny.columns = [c[0] if isinstance(c, tuple) else c for c in ny.columns]
        ny = ny.dropna(subset=["Close"])
        if ny.empty:
            return None
        ny_idx = ny.index.tz_localize(None) if ny.index.tz is not None else ny.index
        # t0: first session on or after the request date
        t0_pd = pd.Timestamp(d0).tz_localize(None)
        head = ny.loc[ny_idx >= t0_pd]
        if head.empty:
            return None
        t0_close = float(head["Close"].iloc[0])
        # t1: last session on or before the horizon date
        t1_pd = pd.Timestamp(d1).tz_localize(None)
        tail = ny.loc[ny_idx <= t1_pd]
        if tail.empty:
            return None
        t1_close = float(tail["Close"].iloc[-1])
        # Window high / low for buy-zone hit detection
        win = ny.loc[(ny_idx >= t0_pd) & (ny_idx <= t1_pd)]
        if win.empty:
            return None
        return {
            "t0_close": t0_close,
            "t1_close": t1_close,
            "max_high": float(win["High"].max()) if "High" in win else t1_close,
            "min_low": float(win["Low"].min()) if "Low" in win else t1_close,
            "n_bars": int(len(win)),
        }
    except Exception as e:
        print(f"  _price_window {ticker}: {str(e)[:120]}")
        return None


def _score_rating(rating: str, ret_pct: float) -> float:
    """Map rating + realised return to 0-100. Continuous, not binary.
    - buy: linear lift from -10% (score 0) through 0% (50) to +10% (100)
    - sell: mirror (positive return penalises)
    - hold: tent peak at 0%, decays to 0 at +/-10%
    """
    if rating == "buy":
        return max(0.0, min(100.0, 50.0 + ret_pct * 5))
    if rating == "sell":
        return max(0.0, min(100.0, 50.0 - ret_pct * 5))
    if rating == "hold":
        return max(0.0, 100.0 - abs(ret_pct) * 10)
    return 0.0


def _score_phase(phase: str, ret_pct: float) -> float:
    """Map phase label to expected realised return; reward distance
    from miss. The four phases tile the return axis at +10 / +5 / -5
    / -10 % anchors and decay linearly from there.
    """
    if phase == "bullish":
        return max(0.0, min(100.0, 50.0 + ret_pct * 5))
    if phase == "moderate_bullish":
        return max(0.0, 100.0 - abs(ret_pct - 5) * 10)
    if phase == "moderate_bearish":
        return max(0.0, 100.0 - abs(ret_pct + 5) * 10)
    if phase == "bearish":
        return max(0.0, min(100.0, 50.0 - ret_pct * 5))
    return 0.0


def _score_buy_window(bw: dict, prices: dict) -> tuple[float, str]:
    """Did the actual price action visit the called buy zone during
    the horizon window? Returns (score, note). 100 when the window's
    high range crosses the zone; below that, decays with distance
    from the zone as a percent of the call's midpoint.
    """
    try:
        lo = float(bw.get("target_price_low"))
        hi = float(bw.get("target_price_high"))
    except (TypeError, ValueError):
        return 0.0, "no buy_window"
    if not (lo > 0 and hi > 0 and hi >= lo):
        return 0.0, "invalid buy_window"
    max_high = prices["max_high"]
    min_low = prices["min_low"]
    mid = (lo + hi) / 2
    # The user's call zone [lo, hi] is hit when the price range
    # [min_low, max_high] overlaps it: max_high >= lo AND min_low <= hi.
    if max_high >= lo and min_low <= hi:
        return 100.0, f"zone {lo:.2f}-{hi:.2f} touched (low {min_low:.2f} high {max_high:.2f})"
    # No overlap: distance from the zone as percent of midpoint.
    if max_high < lo:
        dist_pct = (lo - max_high) / mid * 100
        return max(0.0, 100 - dist_pct * 10), f"zone {lo:.2f}-{hi:.2f} never reached, max high {max_high:.2f} ({dist_pct:.1f}% below zone)"
    if min_low > hi:
        dist_pct = (min_low - hi) / mid * 100
        return max(0.0, 100 - dist_pct * 10), f"price stayed above zone, min low {min_low:.2f} ({dist_pct:.1f}% above {hi:.2f})"
    return 0.0, "buy_window unscorable"


def _grade_one(row: dict) -> dict | None:
    """Score one stock_analyses row. Returns the patch dict to upsert
    back, or None when the row cannot mature yet (e.g. requested today,
    horizon hasn't passed).
    """
    try:
        req_at = datetime.fromisoformat(
            (row.get("requested_at") or "").replace("Z", "+00:00")
        )
    except Exception:
        return {
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grade_score": 0,
            "grade_notes": "could not parse requested_at",
        }
    horizon_days = int(row.get("horizon_days") or 0)
    if horizon_days <= 0:
        return {
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grade_score": 0,
            "grade_notes": "invalid horizon_days",
        }
    horizon_end = req_at + timedelta(days=horizon_days)
    # +15 min settle gate after the expected close: never trust a
    # still-trading bar as t1.
    if datetime.now(timezone.utc) < horizon_end + timedelta(minutes=15):
        return None  # not yet matured
    ticker = row.get("ticker") or ""
    if not ticker:
        return {
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grade_score": 0,
            "grade_notes": "ticker missing",
        }
    prices = _price_window(ticker, req_at, horizon_end)
    if prices is None:
        return {
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grade_score": 0,
            "grade_notes": f"yfinance had no usable data for {ticker} in [{req_at.date()}, {horizon_end.date()}]",
        }
    if prices["t0_close"] <= 0:
        return {
            "graded_at": datetime.now(timezone.utc).isoformat(),
            "grade_score": 0,
            "grade_notes": f"t0 close invalid for {ticker}",
        }
    ret_pct = (prices["t1_close"] - prices["t0_close"]) / prices["t0_close"] * 100

    llm = row.get("llm_json") or {}
    rating = (llm.get("rating") or "").lower()
    phase = (llm.get("phase") or "").lower()
    bw = llm.get("buy_window") or {}

    rating_score = _score_rating(rating, ret_pct)
    phase_score = _score_phase(phase, ret_pct)
    bw_score, bw_note = _score_buy_window(bw, prices)
    grade_score = round((rating_score + phase_score + bw_score) / 3, 1)

    notes = (
        f"realised {ret_pct:+.2f}% over {prices['n_bars']} sessions. "
        f"rating={rating} score {rating_score:.0f}. "
        f"phase={phase} score {phase_score:.0f}. "
        f"{bw_note} score {bw_score:.0f}."
    )

    return {
        "graded_at": datetime.now(timezone.utc).isoformat(),
        "grade_score": grade_score,
        "grade_notes": notes,
    }


def grade_all() -> int:
    """Grade every matured ungraded stock_analyses row. Returns the
    count graded this pass. Idempotent: rows that grade once never
    grade again (graded_at is the gate)."""
    sb = _sb()
    rows = _matured_rows(sb)
    if not rows:
        print("Stock Analyst grader: no ungraded rows.")
        return 0
    graded = 0
    deferred = 0
    for r in rows:
        try:
            patch = _grade_one(r)
            if patch is None:
                deferred += 1
                continue
            sb.table("stock_analyses").update(patch).eq("id", r["id"]).execute()
            print(f"  graded id={r['id']} {r['ticker']} {r['horizon_days']}d -> {patch.get('grade_score')}")
            graded += 1
        except Exception as e:
            print(f"  fail id={r.get('id')}: {str(e)[:160]}")
    print(f"Stock Analyst grader: graded={graded} deferred={deferred} total_ungraded={len(rows)}")
    return graded


if __name__ == "__main__":
    grade_all()

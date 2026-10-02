"""Grades the US daily briefs against real closes (blueprint 25, Phase 3).

Two falsifiable claims per brief, each graded on its own horizon against the
unadjusted close the brief quoted as `price_at_brief`:
  - direction_1d: close of the brief's session versus price_at_brief
  - direction_5d: close of the 5th session (the brief's session is the first)
A tie (return exactly 0) is a miss for both directions.

The grade also stores SPY's return over the same window and which of
stop/target the daily range touched first (both on one day counts as the
stop: the pessimistic reading). `track_record` compares the model against two
naive baselines, always-up and last-session momentum, because a hit rate
means nothing until it beats those.

Idempotent: a horizon already graded is never rewritten, a session that is
not complete yet is skipped, and a missing session in the data leaves the
brief for the next run.

Run: python -m us.grader [--dry]
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

from us.brief_format import format_grade_line
from us.market_calendar import session_bounds_utc
from us.market_context import fetch_history
from us.notify import send_telegram

load_dotenv()

HORIZON_SESSIONS = 5
_SETTLE_MIN = 30  # minutes after the close before a daily bar is trusted
_BENCHMARK = "SPY"
_LOOKBACK_DAYS = 10


def last_complete_session(now: datetime) -> date | None:
    """Latest trading day whose close, plus a settling margin, has passed."""
    d = now.date()
    for _ in range(_LOOKBACK_DAYS):
        bounds = session_bounds_utc(d)
        if bounds and now >= bounds[1] + timedelta(minutes=_SETTLE_MIN):
            return d
        d -= timedelta(days=1)
    return None


def _return_pct(close: float, base: float) -> float:
    return (close / base - 1.0) * 100.0


def _correct(direction: str, ret_pct: float) -> bool:
    return ret_pct != 0 and (ret_pct > 0) == (direction == "up")


def _level_hit(sessions: pd.DataFrame, stop: float, target: float) -> str:
    """First of stop/target touched by the daily range; a day touching both
    is read as the stop (pessimistic)."""
    for _, bar in sessions.iterrows():
        if float(bar["Low"]) <= stop:
            return "stop"
        if float(bar["High"]) >= target:
            return "target"
    return "none"


def _spy_return(spy: pd.DataFrame, on: pd.Timestamp, base: float | None) -> float | None:
    if base is None or on not in spy.index:
        return None
    return round(_return_pct(float(spy.loc[on, "Close"]), base), 3)


def grade_row(brief: dict, bars: pd.DataFrame, spy: pd.DataFrame,
              complete_through: date, graded_at: str) -> dict:
    """Columns to write for one brief; {} when nothing is gradeable yet."""
    start = pd.Timestamp(brief["brief_date"])
    sessions = bars[(bars.index >= start) & (bars.index <= pd.Timestamp(complete_through))]
    if sessions.empty or sessions.index[0] != start:
        return {}
    base = float(brief["price_at_brief"])
    prior_spy = spy[spy.index < start]
    spy_base = float(prior_spy["Close"].iloc[-1]) if len(prior_spy) else None

    update: dict = {}
    if brief.get("close_1d") is None:
        close = float(sessions["Close"].iloc[0])
        ret = _return_pct(close, base)
        update.update(close_1d=round(close, 4), ret_1d_pct=round(ret, 3),
                      spy_ret_1d_pct=_spy_return(spy, start, spy_base),
                      correct_1d=_correct(brief["direction_1d"], ret))
    if brief.get("close_5d") is None and len(sessions) >= HORIZON_SESSIONS:
        window = sessions.iloc[:HORIZON_SESSIONS]
        close = float(window["Close"].iloc[-1])
        ret = _return_pct(close, base)
        update.update(close_5d=round(close, 4), ret_5d_pct=round(ret, 3),
                      spy_ret_5d_pct=_spy_return(spy, window.index[-1], spy_base),
                      correct_5d=_correct(brief["direction_5d"], ret),
                      hit=_level_hit(window, float(brief["stop_price"]),
                                     float(brief["target_price"])),
                      graded_at=graded_at)
    return update


def _num(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _rate(hits: int, n: int) -> float | None:
    return round(100.0 * hits / n, 1) if n else None


def track_record(rows: list[dict]) -> dict:
    """Hit rates per horizon for the model and two naive baselines (always
    up, and the sign of the prior session's return)."""
    out: dict = {}
    for h, correct_key, ret_key in ((1, "correct_1d", "ret_1d_pct"),
                                    (5, "correct_5d", "ret_5d_pct")):
        graded = [r for r in rows if r.get(correct_key) is not None]
        with_prior = [r for r in graded if r.get("prior_ret_1d_pct") is not None]
        out[f"n{h}"] = len(graded)
        out[f"hit{h}"] = _rate(sum(1 for r in graded if r[correct_key]), len(graded))
        out[f"base_up{h}"] = _rate(sum(1 for r in graded if _num(r[ret_key]) > 0), len(graded))
        out[f"base_mom{h}"] = _rate(
            sum(1 for r in with_prior
                if (_num(r["prior_ret_1d_pct"]) > 0) == (_num(r[ret_key]) > 0)),
            len(with_prior))
    return out


def run(dry: bool = False) -> int:
    now = datetime.now(timezone.utc)
    through = last_complete_session(now)
    if through is None:
        print("us_grader: no completed session in range")
        return 0
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    pending = (sb.table("us_briefs").select("*").is_("close_5d", "null")
               .order("brief_date").execute().data or [])
    if not pending:
        print("us_grader: nothing pending")
        return 0

    history = {sym: fetch_history(sym) for sym in {b["ticker"] for b in pending} | {_BENCHMARK}}
    lines: list[str] = []
    graded = 0
    for brief in pending:
        update = grade_row(brief, history[brief["ticker"]], history[_BENCHMARK],
                           through, now.isoformat())
        if not update:
            continue
        graded += 1
        line = format_grade_line(brief, update)
        print(f"  {line}{' (dry run, not stored)' if dry else ''}")
        if line:
            lines.append(line)
        if not dry:
            sb.table("us_briefs").update(update).eq("id", brief["id"]).execute()
    print(f"us_grader: graded {graded} of {len(pending)} pending briefs through {through}")
    if lines and not dry:
        send_telegram("US grader\n" + "\n".join(lines))
    return graded


if __name__ == "__main__":
    run(dry="--dry" in sys.argv[1:])

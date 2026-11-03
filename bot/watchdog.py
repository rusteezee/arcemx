"""Outage watchdog that runs on GitHub Actions, not on the Oracle server.

Why it exists: the Oracle server went down on the afternoon of 2026-10-26
and nothing noticed for a week, because every alert path (the Telegram bot,
the US brief's failure message, Healthchecks pings) lived on that same
server. This job checks from the outside that each server-written table is
still being written and that the bot's health page answers, and posts one
Telegram message listing whatever is stale.

Age is measured in weekday hours (Saturday and Sunday UTC are not counted),
so a normal weekend never alarms. Once-a-day jobs get 50 weekday hours, which
tolerates one market holiday.

Exits 1 when anything is stale, so the GitHub run also shows red.

Run: python -m bot.watchdog [--dry]
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client

from us.notify import send_telegram

# The always-on Telegram bot lived on the Oracle server, deleted 26/10. Set
# ARCEMX_HEALTH_URL again if the bot is ever hosted somewhere; empty = skip.
HEALTH_URL = os.getenv("ARCEMX_HEALTH_URL", "")
_HEALTH_TIMEOUT_S = 15

# (label, table, timestamp column, max weekday hours since the last write)
CHECKS = (
    ("US holdings sync", "us_holdings", "synced_at", 30),
    ("US daily brief", "us_briefs", "created_at", 50),
    ("Paper trader / India grader", "paper_signals", "evaluated_at", 50),
    ("Stock Analyst dispatch", "stock_analyses", "requested_at", 50),
    ("Daily Market Analysis", "analysis", "run_at", 50),
)


def weekday_hours(start: datetime, end: datetime) -> float:
    """Hours between start and end that fall on Monday to Friday (UTC)."""
    if end <= start:
        return 0.0
    total = 0.0
    day = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    while day < end:
        nxt = day + timedelta(days=1)
        if day.weekday() < 5:
            lo, hi = max(start, day), min(end, nxt)
            if hi > lo:
                total += (hi - lo).total_seconds() / 3600
        day = nxt
    return total


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))


def evaluate(latest: dict, now: datetime, health: tuple[bool, str]) -> list[str]:
    """Pure decision step. latest maps check label to a datetime, None (no
    rows) or an error string. Returns human-readable problems, empty if all
    is fresh."""
    problems: list[str] = []
    for label, _table, _col, max_h in CHECKS:
        ts = latest.get(label)
        if isinstance(ts, str):
            problems.append(f"{label}: check failed ({ts})")
        elif ts is None:
            problems.append(f"{label}: no rows found")
        else:
            age = weekday_hours(ts, now)
            if age > max_h:
                problems.append(f"{label}: last write {ts:%d/%m %H:%M} UTC, "
                                f"{age:.0f} weekday hours ago (limit {max_h})")
    ok, detail = health
    if not ok:
        problems.append(f"Telegram bot health page: {detail}")
    return problems


def check_health(url: str = HEALTH_URL) -> tuple[bool, str]:
    try:
        resp = requests.get(url, timeout=_HEALTH_TIMEOUT_S)
    except requests.RequestException as e:
        return False, f"no response ({type(e).__name__})"
    if resp.status_code == 200 and resp.text.strip() == "OK":
        return True, "OK"
    return False, f"HTTP {resp.status_code}"


def _latest_writes() -> dict:
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    out: dict = {}
    for label, table, col, _max_h in CHECKS:
        try:
            rows = (sb.table(table).select(col).order(col, desc=True)
                    .limit(1).execute().data or [])
            out[label] = _parse(rows[0][col]) if rows and rows[0].get(col) else None
        except Exception as e:
            out[label] = type(e).__name__
    return out


def format_alert(problems: list[str]) -> str:
    return ("Arc'emX watchdog: something is down\n\n"
            + "\n".join(f"- {p}" for p in problems)
            + "\n\nEvery scheduled job runs on GitHub Actions; check the "
              "repository's Actions tab for the failed runs.")


def run(dry: bool = False) -> int:
    now = datetime.now(timezone.utc)
    health = check_health(HEALTH_URL) if HEALTH_URL else (True, "not monitored")
    problems = evaluate(_latest_writes(), now, health)
    if not problems:
        print("watchdog: all fresh")
        return 0
    text = format_alert(problems)
    print(text)
    if not dry:
        send_telegram(text)
    return 1


if __name__ == "__main__":
    sys.exit(run(dry="--dry" in sys.argv[1:]))

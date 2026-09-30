"""US equity market calendar. Pure lookup, no network calls.

Separate from analyzer/market_calendar.py (NSE) on purpose: the US side of
this project is its own pipeline with its own tables, so a US ticker can
never be pushed through India code that force-suffixes ".NS".

Holidays and 1 PM early closes are static yearly JSON (data/nyse_holidays_
YYYY.json, sourced from NYSE's published calendar). A year with no file
fails open to weekday-only, so a cron never hard-fails because the next
year's list has not been added yet.

Session times are defined in America/New_York and converted with zoneinfo,
so the UTC open/close shifts correctly across the March and November DST
changes. That matters here: systemd timers run in UTC, and the same 4 PM
ET close is 20:00 UTC in summer and 21:00 UTC in winter.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_ET = ZoneInfo("America/New_York")
_UTC = ZoneInfo("UTC")
_OPEN_ET = time(9, 30)
_CLOSE_ET = time(16, 0)
_EARLY_CLOSE_ET = time(13, 0)

_cache: dict[int, tuple[set[str], set[str]]] = {}


def _load(year: int) -> tuple[set[str], set[str]]:
    if year in _cache:
        return _cache[year]
    path = _DATA_DIR / f"nyse_holidays_{year}.json"
    if not path.exists():
        _cache[year] = (set(), set())
        return _cache[year]
    data = json.loads(path.read_text(encoding="utf-8"))
    holidays = {h["date"] for h in data.get("holidays", [])}
    early = {h["date"] for h in data.get("early_closes", [])}
    _cache[year] = (holidays, early)
    return _cache[year]


def is_us_trading_day(d: date) -> bool:
    """True on US equity trading weekdays that are not a listed holiday."""
    if d.weekday() >= 5:
        return False
    return d.isoformat() not in _load(d.year)[0]


def is_early_close(d: date) -> bool:
    return d.isoformat() in _load(d.year)[1]


def session_bounds_utc(d: date) -> tuple[datetime, datetime] | None:
    """(open, close) as aware UTC datetimes for trading day d, or None if
    the market is closed that day. Honors early closes."""
    if not is_us_trading_day(d):
        return None
    close_t = _EARLY_CLOSE_ET if is_early_close(d) else _CLOSE_ET
    open_dt = datetime.combine(d, _OPEN_ET, tzinfo=_ET).astimezone(_UTC)
    close_dt = datetime.combine(d, close_t, tzinfo=_ET).astimezone(_UTC)
    return open_dt, close_dt


def next_trading_day(d: date) -> date:
    """First trading day strictly after d."""
    nxt = d + timedelta(days=1)
    while not is_us_trading_day(nxt):
        nxt += timedelta(days=1)
    return nxt


if __name__ == "__main__":
    today = datetime.now(_ET).date()
    print(f"today ET: {today} trading_day={is_us_trading_day(today)}")
    print("session UTC:", session_bounds_utc(today))
    print("next trading day:", next_trading_day(today))
    for d in (date(2026, 7, 3), date(2026, 11, 27), date(2026, 12, 25)):
        print(d, "trading:", is_us_trading_day(d), "early:", is_early_close(d),
              "bounds:", session_bounds_utc(d))

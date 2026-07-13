"""NSE trading-day calendar. Pure lookup, no network calls.

Closes the gap noted in README's Limits section since project inception:
scheduled crons fired on Indian market holidays with nothing to do. The
holiday list is a static yearly JSON (data/nse_holidays_2026.json) -
needs a new file appended each December, not auto-fetched (NSE has no
free holiday API; the list changes once a year)."""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_holiday_cache: dict[int, set[str]] = {}


def _load_holidays(year: int) -> set[str]:
    if year in _holiday_cache:
        return _holiday_cache[year]
    path = _DATA_DIR / f"nse_holidays_{year}.json"
    if not path.exists():
        # No file for this year yet - fail open (weekday-only check still
        # applies). Crons must never hard-fail because December's list
        # hasn't been added.
        _holiday_cache[year] = set()
        return _holiday_cache[year]
    data = json.loads(path.read_text())
    dates = {h["date"] for h in data.get("holidays", [])}
    _holiday_cache[year] = dates
    return dates


def is_trading_day(d: date) -> bool:
    """True on NSE trading weekdays that are not a listed holiday. Years
    with no holiday-list file fall back to weekday-only (fail-open)."""
    if d.weekday() >= 5:  # Sat=5, Sun=6
        return False
    return d.isoformat() not in _load_holidays(d.year)

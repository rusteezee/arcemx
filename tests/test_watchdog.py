"""Tests for bot.watchdog's pure logic. Synthetic timestamps, no network."""
from datetime import datetime, timezone

from bot.watchdog import CHECKS, evaluate, format_alert, weekday_hours

UTC = timezone.utc


def dt(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


def test_weekday_hours_same_day():
    assert weekday_hours(dt(2026, 10, 26, 3), dt(2026, 10, 26, 9)) == 6


def test_weekday_hours_skip_the_weekend():
    # Fri 21:30 -> Mon 12:30 is 2.5 weekday hours on Friday + 12.5 on Monday
    assert weekday_hours(dt(2026, 10, 30, 21, 30), dt(2026, 11, 2, 12, 30)) == 15


def test_weekday_hours_zero_when_reversed():
    assert weekday_hours(dt(2026, 11, 2), dt(2026, 11, 1)) == 0


def fresh(now):
    return {label: now for label, *_ in CHECKS}


def test_all_fresh_means_no_problems():
    now = dt(2026, 11, 2, 6, 17)
    assert evaluate(fresh(now), now, (True, "OK")) == []


def test_normal_weekend_does_not_alarm():
    """Friday's last US sync at 21:30 is fine on Monday morning."""
    now = dt(2026, 11, 2, 6, 17)
    latest = fresh(now)
    latest["US holdings sync (server)"] = dt(2026, 10, 30, 21, 30)
    assert evaluate(latest, now, (True, "OK")) == []


def test_the_real_outage_is_reported():
    """Server writes stopped 26/10 afternoon; checked on Mon 02/11."""
    now = dt(2026, 11, 2, 6, 17)
    latest = fresh(now)
    for label in ("US holdings sync (server)", "US daily brief (server)",
                  "Paper trader / India grader (server)", "Stock Analyst dispatch (server)"):
        latest[label] = dt(2026, 10, 26, 12, 47)
    problems = evaluate(latest, now, (False, "no response (ConnectTimeout)"))
    assert len(problems) == 5
    assert any("US daily brief (server): last write 26/10 12:47 UTC" in p for p in problems)
    assert any("health page: no response" in p for p in problems)
    assert not any("Daily Market Analysis" in p for p in problems)


def test_missing_rows_and_failed_queries_are_problems():
    now = dt(2026, 11, 2, 6, 17)
    latest = fresh(now)
    latest["US daily brief (server)"] = None
    latest["Daily Market Analysis (GitHub)"] = "APIError"
    problems = evaluate(latest, now, (True, "OK"))
    assert "US daily brief (server): no rows found" in problems
    assert "Daily Market Analysis (GitHub): check failed (APIError)" in problems


def test_alert_text_house_style():
    text = format_alert(["X: stale"])
    assert text.startswith("Arc'emX watchdog") and "- X: stale" in text
    assert chr(0x2014) not in text

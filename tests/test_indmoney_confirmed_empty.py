"""Tests for fetchers.indmoney_mcp._is_confirmed_empty. Synthetic replies
shaped like the real networth_holdings response of 2026-10-24."""
from fetchers.indmoney_mcp import _is_confirmed_empty

SOLD_OUT = {
    "is_cached_response": False, "position_error": False, "holdings": [],
    "asset_summary": {"total_value": 0, "invested": 0, "one_day_change": 0},
    "source_status": {"holdings": "success", "positions": "success"},
}


def test_real_sold_out_reply_is_confirmed_empty():
    assert _is_confirmed_empty(SOLD_OUT) is True


def test_string_zero_invested_counts():
    assert _is_confirmed_empty({**SOLD_OUT, "asset_summary": {"invested": "0"}}) is True


def test_glitches_are_not_confirmed():
    assert _is_confirmed_empty({}) is False
    assert _is_confirmed_empty(None) is False
    assert _is_confirmed_empty({"error": "service_error", "message": "API returned 512"}) is False


def test_failed_holdings_source_is_not_confirmed():
    bad = {**SOLD_OUT, "source_status": {"holdings": "failed"}}
    assert _is_confirmed_empty(bad) is False


def test_missing_or_nonzero_invested_is_not_confirmed():
    assert _is_confirmed_empty({**SOLD_OUT, "asset_summary": {}}) is False
    assert _is_confirmed_empty({**SOLD_OUT, "asset_summary": {"invested": 15000}}) is False


def test_non_empty_holdings_is_never_confirmed_empty():
    assert _is_confirmed_empty({**SOLD_OUT, "holdings": [{"investment": "X"}]}) is False

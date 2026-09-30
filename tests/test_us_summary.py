"""Tests for us.summary, the /us Telegram text. Synthetic rows only."""
from us.summary import format_us_summary, inr

HOLDINGS = [
    {"ticker": "AAA", "units": "0.4123", "invested_inr": 12345.4, "value_inr": 13000,
     "pnl_inr": 654.6, "pnl_pct": 5.3, "one_day_change_inr": -120,
     "synced_at": "2026-09-30T12:30:03.123+00:00"},
    {"ticker": "BBB", "units": 10, "invested_inr": 20000, "value_inr": 15000,
     "pnl_inr": -5000, "pnl_pct": -25, "one_day_change_inr": 50,
     "synced_at": "2026-09-30T12:30:03+00:00"},
]
EVENTS = [
    {"ticker": "AAA", "form": "6-K", "filed_date": "2026-09-10", "material": True,
     "material_reason": "keyword: revenue"},
    {"ticker": "BBB", "form": "6-K", "filed_date": "2026-09-04", "material": False,
     "material_reason": None},
]


def test_inr_uses_indian_grouping():
    assert inr(1234567) == "₹12,34,567"
    assert inr(100000) == "₹1,00,000"
    assert inr(999) == "₹999"


def test_inr_signs_and_rounding():
    assert inr(-999.6, signed=True) == "-₹1,000"
    assert inr(654.6, signed=True) == "+₹655"
    assert inr(0, signed=True) == "₹0"


def test_inr_tolerates_missing_values():
    assert inr(None) == "₹0"
    assert inr("not a number") == "₹0"


def test_summary_orders_by_value_and_totals():
    out = format_us_summary(HOLDINGS, EVENTS)
    assert out.index("BBB") < out.index("AAA")
    assert "Invested ₹32,345 -> ₹28,000" in out
    assert "P&L -₹4,345 (-13.4%)" in out


def test_summary_marks_flagged_filings_only():
    out = format_us_summary(HOLDINGS, EVENTS)
    assert "`AAA` 6-K 10/09/2026 [flagged: keyword: revenue]" in out
    assert "`BBB` 6-K 04/09/2026\n" in out


def test_summary_renders_ist_12_hour():
    assert "Synced 30/09/2026 06:00 PM IST" in format_us_summary(HOLDINGS, EVENTS)


def test_summary_house_style():
    out = format_us_summary(HOLDINGS, EVENTS)
    assert chr(0x2014) not in out


def test_summary_handles_no_events():
    assert "None stored yet." in format_us_summary(HOLDINGS, [])


def test_summary_handles_no_holdings():
    assert "No US holdings synced yet" in format_us_summary([], EVENTS)

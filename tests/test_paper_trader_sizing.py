"""Tests for the one-share risk guard in analyzer.paper_trader.
Uses the real PTCIL.NS numbers from 13/10/2026 that exposed the hole."""
from analyzer.paper_trader import (MAX_ONE_SHARE_RISK_MULT, RISK_PER_TRADE,
                                   _one_share_too_risky)

BASE = 29_512.0
BUDGET = BASE * RISK_PER_TRADE  # 590.24


def test_ptcil_case_is_rejected():
    risk_per_share = 23_680.28 - 20_037.27  # fill minus stop, about 3,643
    assert _one_share_too_risky(risk_per_share, BUDGET) is True


def test_ordinary_trade_is_allowed():
    assert _one_share_too_risky(40.0, BUDGET) is False
    assert _one_share_too_risky(BUDGET, BUDGET) is False


def test_boundary_is_exactly_the_multiple():
    limit = MAX_ONE_SHARE_RISK_MULT * BUDGET
    assert _one_share_too_risky(limit, BUDGET) is False
    assert _one_share_too_risky(limit + 0.01, BUDGET) is True


def test_multiple_stays_conservative():
    assert MAX_ONE_SHARE_RISK_MULT <= 2.0

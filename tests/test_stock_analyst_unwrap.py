"""Tests for the wrapper-key unwrap in the Stock Analyst. Synthetic dicts only."""
from analyzer.stock_analyst_llm import _unwrap_candidate

REPORT = {"rating": "hold", "score": 57, "confidence": 55, "phase": "moderate_bullish"}


def test_report_nested_under_empty_key_is_lifted():
    wrapped = {"": dict(REPORT), "horizon_days": 30, "ticker": "PWL.NS"}
    out = _unwrap_candidate(wrapped)
    assert out["rating"] == "hold" and out["confidence"] == 55
    assert out["ticker"] == "PWL.NS" and out["horizon_days"] == 30
    assert "" not in out


def test_report_nested_under_any_single_wrapper_key_is_lifted():
    out = _unwrap_candidate({"analysis": dict(REPORT), "ticker": "X.NS"})
    assert out["rating"] == "hold" and "analysis" not in out


def test_top_level_report_is_untouched():
    flat = {**REPORT, "ticker": "X.NS"}
    assert _unwrap_candidate(flat) is flat


def test_ambiguous_wrappers_are_untouched():
    two = {"a": dict(REPORT), "b": dict(REPORT)}
    assert _unwrap_candidate(two) is two


def test_no_nested_report_is_untouched():
    junk = {"": "text", "horizon_days": 30, "ticker": "X.NS"}
    assert _unwrap_candidate(junk) is junk


def test_non_dict_passes_through():
    assert _unwrap_candidate(None) is None
    assert _unwrap_candidate([1, 2]) == [1, 2]

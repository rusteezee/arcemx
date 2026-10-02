"""Tests for US Phase 3: market context cut, brief validation, grading,
track record and message formatting. Synthetic data only, no network."""
from datetime import date, datetime, timezone

import pandas as pd

from us.brief_format import format_brief, format_grade_line, format_track_record
from us.daily_brief import _json_safe, _resolve_session, validate_brief
from us.grader import grade_row, last_complete_session, track_record
from us.market_context import _as_iso, before, index_snapshot, technicals

EM_DASH = chr(0x2014)


def frame(closes, start="2026-01-02", spread=1.0, volume=1000.0):
    idx = pd.bdate_range(start, periods=len(closes))
    c = pd.Series(closes, index=idx, dtype=float)
    return pd.DataFrame({"Open": c, "High": c + spread, "Low": c - spread,
                         "Close": c, "Volume": float(volume)}, index=idx)


def bars(rows):
    """rows: [(iso_date, close, high, low)]"""
    idx = pd.to_datetime([r[0] for r in rows])
    return pd.DataFrame({"Open": [r[1] for r in rows], "High": [r[2] for r in rows],
                         "Low": [r[3] for r in rows], "Close": [r[1] for r in rows],
                         "Volume": 1000.0}, index=idx)


def utc(y, m, d, h, mi):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


# ---------- market_context ----------

def test_before_drops_session_date_and_later():
    df = frame(range(100, 140))
    cut = df.index[20].date()
    out = before(df, cut)
    assert out.index[-1] == df.index[19]
    assert len(out) == 20


def test_technicals_exposes_close_one_day_return_date_and_volume_ratio():
    df = frame(range(100, 140))
    out = technicals(df)
    assert out["close"] == 139.0
    assert "last_close" not in out
    assert out["ret_1d_pct"] == round((139 / 138 - 1) * 100, 2)
    assert out["last_date"] == df.index[-1].date().isoformat()
    assert out["volume_vs_20d_avg"] == 1.0


def test_index_snapshot_changes():
    snap = index_snapshot(frame([100.0] * 10 + [110.0]))
    assert snap["last"] == 110.0
    assert snap["chg_1d_pct"] == 10.0
    assert snap["chg_5d_pct"] == 10.0


def test_as_iso_handles_list_date_and_junk():
    assert _as_iso([date(2026, 10, 15)]) == "2026-10-15"
    assert _as_iso(date(2026, 12, 10)) == "2026-12-10"
    assert _as_iso(None) is None
    assert _as_iso([]) is None


def test_json_safe_replaces_non_finite_floats():
    assert _json_safe({"a": float("nan"), "b": [1.5, float("inf")], "c": "x"}) == {
        "a": None, "b": [1.5, None], "c": "x"}


# ---------- validate_brief ----------

PRICE = 100.0


def good(**over):
    base = {
        "stance": "hold", "direction_1d": "up", "direction_5d": "up", "confidence": 55,
        "stop_price": 95.0, "target_price": 106.0, "summary": "Steady uptrend, nothing urgent.",
        "reasoning": {"technicals": "RSI 55", "macro": "SPY +0.3%", "events": "none"},
        "reasons_could_be_wrong": ["VIX 16.0 could jump", "Earnings in 13 days"],
    }
    return {**base, **over}


def test_validate_accepts_good_brief_and_coerces_types():
    clean, err = validate_brief(good(confidence="58", stance=" HOLD "), PRICE)
    assert err == "" and clean["confidence"] == 58 and clean["stance"] == "hold"


def test_validate_strips_dashes_from_model_text():
    clean, _ = validate_brief(good(summary=f"Strong{EM_DASH}but fragile."), PRICE)
    assert EM_DASH not in clean["summary"]


def test_validate_rejects_bad_shapes():
    assert validate_brief("nope", PRICE)[0] is None
    assert validate_brief({"error": "empty_content"}, PRICE)[0] is None
    missing = good()
    del missing["summary"]
    assert "missing key: summary" in validate_brief(missing, PRICE)[1]


def test_validate_rejects_bad_enums_and_confidence():
    assert validate_brief(good(stance="buy"), PRICE)[0] is None
    assert validate_brief(good(direction_5d="flat"), PRICE)[0] is None
    assert validate_brief(good(confidence=49), PRICE)[0] is None
    assert validate_brief(good(confidence=96), PRICE)[0] is None
    assert validate_brief(good(confidence="high"), PRICE)[0] is None


def test_validate_enforces_level_sanity():
    assert validate_brief(good(stop_price=100.0), PRICE)[0] is None
    assert validate_brief(good(stop_price=50.0), PRICE)[0] is None
    assert validate_brief(good(target_price=100.0), PRICE)[0] is None
    assert validate_brief(good(target_price=150.0), PRICE)[0] is None


def test_validate_enforces_stance_direction_consistency():
    assert validate_brief(good(stance="add", direction_5d="down"), PRICE)[0] is None
    assert validate_brief(good(stance="exit", direction_5d="up"), PRICE)[0] is None
    assert validate_brief(good(stance="trim", direction_5d="down"), PRICE)[0] is not None


def test_validate_requires_reasoning_and_two_risks():
    assert validate_brief(good(reasons_could_be_wrong=["only one"]), PRICE)[0] is None
    assert validate_brief(good(reasoning={"technicals": "x", "macro": "y"}), PRICE)[0] is None


# ---------- _resolve_session (pre-open guard) ----------

def test_session_live_pre_open_is_today():
    assert _resolve_session(utc(2026, 10, 2, 12, 45), False, None) == date(2026, 10, 2)


def test_session_live_after_open_is_skipped():
    assert _resolve_session(utc(2026, 10, 2, 14, 0), False, None) is None


def test_session_live_on_holiday_or_weekend_is_skipped():
    assert _resolve_session(utc(2026, 11, 26, 12, 45), False, None) is None  # Thanksgiving
    assert _resolve_session(utc(2026, 10, 3, 12, 45), False, None) is None  # Saturday


def test_session_dry_rolls_to_next_trading_day_and_override_wins():
    assert _resolve_session(utc(2026, 10, 3, 12, 0), True, None) == date(2026, 10, 5)
    assert _resolve_session(utc(2026, 10, 3, 12, 0), True, date(2026, 9, 1)) == date(2026, 9, 1)


# ---------- grader ----------

def test_last_complete_session_respects_close_plus_settle():
    assert last_complete_session(utc(2026, 10, 2, 20, 20)) == date(2026, 10, 1)
    assert last_complete_session(utc(2026, 10, 2, 20, 45)) == date(2026, 10, 2)
    assert last_complete_session(utc(2026, 10, 3, 12, 0)) == date(2026, 10, 2)


def brief(**over):
    base = {"brief_date": "2026-10-05", "ticker": "AAA", "price_at_brief": 100.0,
            "direction_1d": "up", "direction_5d": "up", "stop_price": 95.0,
            "target_price": 110.0, "close_1d": None, "close_5d": None}
    return {**base, **over}


SPY = bars([("2026-10-02", 500.0, 501, 499), ("2026-10-05", 505.0, 506, 504),
            ("2026-10-06", 506.0, 507, 505), ("2026-10-07", 507.0, 508, 506),
            ("2026-10-08", 508.0, 509, 507), ("2026-10-09", 510.0, 511, 509)])
STOCK = bars([("2026-10-05", 103.0, 104, 102), ("2026-10-06", 104.0, 105, 103),
              ("2026-10-07", 102.0, 103, 101), ("2026-10-08", 99.0, 100, 98),
              ("2026-10-09", 98.0, 99, 97)])
NOW = "2026-10-10T22:15:00+00:00"


def test_grade_one_day_only_when_five_not_yet_available():
    up = grade_row(brief(), STOCK.iloc[:3], SPY, date(2026, 10, 7), NOW)
    assert up["ret_1d_pct"] == 3.0 and up["correct_1d"] is True
    assert up["spy_ret_1d_pct"] == 1.0
    assert "close_5d" not in up


def test_grade_five_day_miss_with_spy_and_level_none():
    up = grade_row(brief(), STOCK, SPY, date(2026, 10, 9), NOW)
    assert up["ret_5d_pct"] == -2.0 and up["correct_5d"] is False
    assert up["spy_ret_5d_pct"] == 2.0
    assert up["hit"] == "none" and up["graded_at"] == NOW


def test_grade_level_hit_stop_first_and_both_same_day_is_stop():
    deep = bars([("2026-10-05", 103.0, 104, 102), ("2026-10-06", 100.0, 101, 94),
                 ("2026-10-07", 101.0, 112, 100), ("2026-10-08", 101.0, 102, 100),
                 ("2026-10-09", 101.0, 102, 100)])
    assert grade_row(brief(), deep, SPY, date(2026, 10, 9), NOW)["hit"] == "stop"
    both = bars([("2026-10-05", 103.0, 112, 94)]
                + [(f"2026-10-0{d}", 101.0, 102, 100) for d in range(6, 10)])
    assert grade_row(brief(), both, SPY, date(2026, 10, 9), NOW)["hit"] == "stop"


def test_grade_target_touched_first():
    t = bars([("2026-10-05", 103.0, 111, 102)]
             + [(f"2026-10-0{d}", 101.0, 102, 100) for d in range(6, 10)])
    assert grade_row(brief(), t, SPY, date(2026, 10, 9), NOW)["hit"] == "target"


def test_grade_tie_is_a_miss():
    flat = bars([("2026-10-05", 100.0, 101, 99)])
    assert grade_row(brief(), flat, SPY, date(2026, 10, 5), NOW)["correct_1d"] is False


def test_grade_is_idempotent_per_horizon():
    up = grade_row(brief(close_1d=103.0), STOCK, SPY, date(2026, 10, 9), NOW)
    assert "close_1d" not in up and "close_5d" in up


def test_grade_skips_missing_or_incomplete_sessions():
    assert grade_row(brief(), STOCK.iloc[1:], SPY, date(2026, 10, 9), NOW) == {}
    assert grade_row(brief(), STOCK, SPY, date(2026, 10, 2), NOW) == {}


def test_track_record_compares_model_with_baselines():
    rows = [
        {"correct_5d": True, "ret_5d_pct": 2.0, "prior_ret_1d_pct": 1.0,
         "correct_1d": True, "ret_1d_pct": 1.0},
        {"correct_5d": False, "ret_5d_pct": -1.0, "prior_ret_1d_pct": 0.5,
         "correct_1d": False, "ret_1d_pct": -0.5},
        {"correct_5d": True, "ret_5d_pct": -3.0, "prior_ret_1d_pct": -0.2,
         "correct_1d": None, "ret_1d_pct": None},
        {"correct_5d": None, "ret_5d_pct": None, "prior_ret_1d_pct": 1.0,
         "correct_1d": None, "ret_1d_pct": None},
    ]
    rec = track_record(rows)
    assert rec["n5"] == 3 and rec["hit5"] == 66.7
    assert rec["base_up5"] == 33.3     # only the +2.0 row went up
    assert rec["base_mom5"] == 66.7    # momentum right on rows 1 and 3
    assert rec["n1"] == 2 and rec["hit1"] == 50.0


def test_track_record_empty_has_no_rates():
    rec = track_record([])
    assert rec["n5"] == 0 and rec["hit5"] is None


# ---------- formatting ----------

ROW = {"ticker": "AAA", "stance": "hold", "direction_1d": "up", "direction_5d": "down",
       "confidence": 55, "price_at_brief": 459.2, "stop_price": 440.0,
       "target_price": 478.0, "summary": "Range bound.", "next_earnings": "2026-10-15"}


def test_format_brief_layout_and_house_style():
    out = format_brief("2026-10-05", [ROW], None, failed=["BBB"])
    assert "05/10/2026" in out and "AAA: HOLD" in out
    assert "Last $459.20 | Stop $440.00 | Target $478.00" in out
    assert "Next earnings 15/10/2026" in out
    assert "No brief produced for: BBB" in out
    assert "Advisory only" in out and EM_DASH not in out


def test_format_track_record_building_vs_full():
    assert "building (2 graded" in format_track_record({"n5": 2})
    full = {"n5": 8, "hit5": 62.0, "base_up5": 50.0, "base_mom5": 38.0, "hit1": 50.0, "n1": 9}
    out = format_track_record(full)
    assert "hit 62% vs always-up 50% vs momentum 38%" in out
    assert "60 before any claim of edge" in out


def test_format_grade_line_prefers_five_day_and_handles_empty():
    b = {"ticker": "AAA", "brief_date": "2026-10-05", "direction_1d": "up", "direction_5d": "up"}
    five = format_grade_line(b, {"correct_5d": False, "ret_5d_pct": -2.0,
                                 "spy_ret_5d_pct": 2.0, "hit": "none"})
    assert five == "AAA 05/10/2026 5d called UP: -2.0% (SPY +2.0%) MISS"
    one = format_grade_line(b, {"correct_1d": True, "ret_1d_pct": 3.0})
    assert one == "AAA 05/10/2026 1d called UP: +3.0% HIT"
    assert format_grade_line(b, {}) is None

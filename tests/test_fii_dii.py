"""Tests for the FII history fallback used by grader.py's fii_flow_1d scoring.
Synthetic rows and a fake requests.get only, no network."""
from datetime import date, datetime, timedelta
from unittest.mock import patch

import requests

from fetchers import fii_dii

SHORT = {"d": "17-Jun-2026", "fn": -1200.5, "dn": 900.0}
LONG = {"date": "30-Sep-2026", "fii_net": -300, "dii_net": 10}


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error")

    def json(self):
        return self._payload


def fake_get(by_url):
    def _get(url, **kwargs):
        value = by_url[url]
        if isinstance(value, Exception):
            raise value
        return value
    return _get


def test_net_for_date_reads_short_key_schema():
    assert fii_dii._net_for_date([SHORT], "17-Jun-2026") == -1200.5


def test_net_for_date_reads_long_key_schema():
    assert fii_dii._net_for_date([LONG], "30-Sep-2026") == -300.0


def test_net_for_date_is_exact_match_only():
    assert fii_dii._net_for_date([SHORT, LONG], "18-Jun-2026") is None


def test_net_for_date_ignores_junk_rows():
    assert fii_dii._net_for_date(["error", None, {"d": "x"}, SHORT], "17-Jun-2026") == -1200.5


def test_history_rows_falls_back_when_mirror_returns_error_dict():
    """The 2026-09 failure: mirror answers 403 with {"error": ...}."""
    responses = {
        fii_dii.HISTORY_URL: FakeResp({"error": "API access is restricted"}, 403),
        fii_dii.BACKSTOP_URL: FakeResp([LONG]),
    }
    with patch.object(fii_dii.requests, "get", side_effect=fake_get(responses)):
        assert fii_dii._history_rows() == [LONG]


def test_history_rows_rejects_non_list_even_on_200():
    responses = {
        fii_dii.HISTORY_URL: FakeResp({"error": "restricted"}, 200),
        fii_dii.BACKSTOP_URL: FakeResp([LONG]),
    }
    with patch.object(fii_dii.requests, "get", side_effect=fake_get(responses)):
        assert fii_dii._history_rows() == [LONG]


def test_history_rows_prefers_mirror_when_healthy():
    responses = {
        fii_dii.HISTORY_URL: FakeResp([SHORT]),
        fii_dii.BACKSTOP_URL: FakeResp([LONG]),
    }
    with patch.object(fii_dii.requests, "get", side_effect=fake_get(responses)):
        assert fii_dii._history_rows() == [SHORT]


def reset_cache():
    fii_dii._rows_cache["at"] = None
    fii_dii._rows_cache["rows"] = None


def test_history_rows_none_when_both_sources_fail():
    reset_cache()
    responses = {
        fii_dii.HISTORY_URL: requests.ConnectionError("down"),
        fii_dii.BACKSTOP_URL: FakeResp([], 200),
    }
    with patch.object(fii_dii.requests, "get", side_effect=fake_get(responses)):
        assert fii_dii._history_rows() is None
        assert fii_dii.fetch_fii_net_for_date("30-Sep-2026") is None


def test_fetch_fii_net_for_date_end_to_end_via_backstop():
    reset_cache()
    responses = {
        fii_dii.HISTORY_URL: FakeResp({"error": "API access is restricted"}, 403),
        fii_dii.BACKSTOP_URL: FakeResp([LONG]),
    }
    with patch.object(fii_dii.requests, "get", side_effect=fake_get(responses)):
        assert fii_dii.fetch_fii_net_for_date("30-Sep-2026") == -300.0
        assert fii_dii.fetch_fii_net_for_date("01-Oct-2026") is None


def test_rows_are_fetched_once_for_many_dates():
    """grader.py scores 127 analyses in one pass: one fetch, not 127."""
    reset_cache()
    with patch.object(fii_dii, "_history_rows", return_value=[SHORT, LONG]) as rows:
        for _ in range(127):
            assert fii_dii.fetch_fii_net_for_date("17-Jun-2026") == -1200.5
        assert rows.call_count == 1


def test_cache_expires_after_ttl():
    reset_cache()
    with patch.object(fii_dii, "_history_rows", return_value=[SHORT]) as rows:
        fii_dii.fetch_fii_net_for_date("17-Jun-2026")
        fii_dii._rows_cache["at"] -= fii_dii._ROWS_TTL_S + 1
        fii_dii.fetch_fii_net_for_date("17-Jun-2026")
        assert rows.call_count == 2


def test_failed_fetch_is_cached_not_retried_per_call():
    reset_cache()
    with patch.object(fii_dii, "_history_rows", return_value=None) as rows:
        for _ in range(5):
            assert fii_dii.fetch_fii_net_for_date("17-Jun-2026") is None
        assert rows.call_count == 1


# ---------- freshness guard ----------

def fresh_rows(n=6):
    today = datetime.now(fii_dii._IST).date()
    return [{"d": (today - timedelta(days=i)).strftime("%d-%b-%Y"),
             "fn": -100.0 * (i + 1), "dn": 50.0} for i in range(n)]


def test_is_stale_boundary_is_five_days():
    today = date(2026, 10, 13)
    assert fii_dii._is_stale("30-Sep-2026", today) is True    # 13 days old
    assert fii_dii._is_stale("07-Oct-2026", today) is True    # 6 days old
    assert fii_dii._is_stale("08-Oct-2026", today) is False   # 5 days old
    assert fii_dii._is_stale("13-Oct-2026", today) is False


def test_is_stale_trusts_unparseable_dates():
    assert fii_dii._is_stale("garbage", date(2026, 10, 13)) is False
    assert fii_dii._is_stale(None, date(2026, 10, 13)) is False


def test_fetch_history_omits_stale_trend():
    stale = [{"d": "30-Sep-2026", "fn": -1.0, "dn": 1.0}] * 6
    with patch.object(fii_dii, "_history_rows", return_value=stale):
        assert fii_dii.fetch_history() is None


def test_fetch_history_keeps_fresh_trend():
    with patch.object(fii_dii, "_history_rows", return_value=fresh_rows()):
        out = fii_dii.fetch_history()
    assert out is not None and out["fii_streak"] < 0


def test_fetch_latest_drops_stale_and_keeps_fresh():
    with patch.object(fii_dii, "_fetch_latest_unchecked", return_value={"date": "30-Sep-2026"}):
        assert fii_dii.fetch_latest() is None
    today = datetime.now(fii_dii._IST).date().strftime("%d-%b-%Y")
    with patch.object(fii_dii, "_fetch_latest_unchecked", return_value={"date": today}):
        assert fii_dii.fetch_latest() == {"date": today}


def test_exact_date_lookup_is_not_affected_by_staleness():
    """The grader scores old sessions, so lookups must still work."""
    reset_cache()
    with patch.object(fii_dii, "_history_rows", return_value=[LONG]):
        assert fii_dii.fetch_fii_net_for_date("30-Sep-2026") == -300.0

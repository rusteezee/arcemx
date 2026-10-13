"""Tests for the router's rejection of stub JSON replies. Synthetic responses."""
from analyzer.llm_router import _content_ok, _content_reject_reason


def resp(content):
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


def test_literal_stub_from_nemotron_is_rejected():
    """The 2026-10 failure: reply was exactly {"": ""}."""
    assert _content_reject_reason(resp('{"": ""}'), True) == "empty_dict"
    assert _content_ok(resp('{"": ""}'), True) is False


def test_original_empty_object_is_still_rejected():
    assert _content_reject_reason(resp("{}"), True) == "empty_dict"


def test_all_empty_values_are_rejected():
    stub = '{"a": "", "b": null, "c": [], "d": {}}'
    assert _content_reject_reason(resp(stub), True) == "empty_dict"


def test_fenced_stub_is_rejected():
    assert _content_reject_reason(resp('```json\n{"": ""}\n```'), True) == "empty_dict"


def test_real_content_is_accepted():
    assert _content_reject_reason(resp('{"rating": "hold", "score": 57}'), True) is None


def test_zero_and_false_are_real_values_not_empties():
    assert _content_reject_reason(resp('{"x": 0}'), True) is None
    assert _content_reject_reason(resp('{"x": false}'), True) is None


def test_stub_check_only_applies_in_json_mode():
    assert _content_reject_reason(resp('{"": ""}'), False) is None

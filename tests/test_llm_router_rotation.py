"""Tests for model rotation in analyzer.llm_router._post_provider.

Regression for 2026-10-20: the first model in the chain answered 404 and the
router aborted instead of trying the next model, taking every LLM job down.
Fake HTTP only, no network, no sleeping."""
from unittest.mock import patch

import requests

from analyzer import llm_router as r

PROVIDER = next(p for p in r._PROVIDERS if p["name"] == "openrouter")
GOOD = {"choices": [{"message": {"content": '{"rating": "hold"}'}, "finish_reason": "stop"}]}


class FakeResp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self.headers = {}
        self._payload = payload if payload is not None else {"error": {"code": status}}
        self.text = str(self._payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error")


def run(models, responses, max_retries=2):
    sent, queue = [], list(responses)

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append(json["model"])
        return queue.pop(0)

    with patch.object(r.requests, "post", side_effect=fake_post), \
            patch.object(r.time, "sleep", lambda s: None):
        try:
            out = r._post_provider(PROVIDER, [{"role": "user", "content": "x"}], models,
                                   reasoning=False, timeout=5, max_retries=max_retries,
                                   api_key="test-key", json_format=True)
            return out, sent, None
        except Exception as e:
            return None, sent, e


def test_dead_first_model_rotates_to_next():
    out, sent, err = run(["dead:free", "live:free"], [FakeResp(404), FakeResp(200, GOOD)])
    assert err is None and out == GOOD
    assert sent == ["dead:free", "live:free"]


def test_upstream_502_then_ok():
    out, sent, err = run(["a", "b"], [FakeResp(502), FakeResp(200, GOOD)])
    assert out == GOOD and sent == ["a", "b"]


def test_bad_key_401_fails_fast_without_rotating():
    out, sent, err = run(["a", "b"], [FakeResp(401)])
    assert isinstance(err, requests.HTTPError) and sent == ["a"]


def test_every_model_in_a_long_chain_is_tried():
    models = ["a", "b", "c", "d", "e"]
    out, sent, err = run(models, [FakeResp(502)] * 5)
    assert isinstance(err, requests.HTTPError)
    assert sent == models


def test_all_dead_raises_after_last_attempt():
    out, sent, err = run(["a", "b"], [FakeResp(404)] * 3)
    assert isinstance(err, requests.HTTPError) and len(sent) == 3


def test_stub_content_still_rotates():
    stub = {"choices": [{"message": {"content": '{"": ""}'}, "finish_reason": "stop"}]}
    out, sent, err = run(["a", "b"], [FakeResp(200, stub), FakeResp(200, GOOD)])
    assert out == GOOD and sent == ["a", "b"]

"""Tests for the shared Telegram sender and the price-alert delivery order.
Fake HTTP and fake bot only, no network."""
import asyncio
import contextlib
import io
import os
from types import SimpleNamespace
from unittest.mock import patch

import requests
from telegram.error import BadRequest

from analyzer import telegram_notify as tn
from bot import alerts_checker

ENV = {"TELEGRAM_BOT_TOKEN": "123456:SECRET-TOKEN", "TELEGRAM_CHAT_ID": "42"}
PARSE_400 = '{"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities: Can\'t find end of the entity"}'


class FakeResp:
    def __init__(self, status=200, text="{}"):
        self.status_code, self.text = status, text


def run_send(responses, text="hello", env=ENV):
    """Calls send_markdown with a scripted list of responses; returns
    (result, payloads_sent, printed_output)."""
    sent, queue = [], list(responses)

    def fake_post(url, json=None, timeout=None):
        sent.append(json)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    out = io.StringIO()
    with patch.dict(os.environ, env, clear=False), \
            patch.object(tn.requests, "post", side_effect=fake_post), \
            contextlib.redirect_stdout(out):
        result = tn.send_markdown(text)
    return result, sent, out.getvalue()


# ---------- send_markdown ----------

def test_markdown_accepted_first_try():
    ok, sent, _ = run_send([FakeResp(200)])
    assert ok is True and len(sent) == 1 and sent[0]["parse_mode"] == "Markdown"


def test_parse_error_resends_same_text_as_plain():
    ok, sent, log = run_send([FakeResp(400, PARSE_400), FakeResp(200)], text="`X` via stock_analyst")
    assert ok is True and len(sent) == 2
    assert "parse_mode" not in sent[1] and sent[1]["text"] == sent[0]["text"]
    assert "resending as plain text" in log


def test_other_400_is_not_retried():
    ok, sent, _ = run_send([FakeResp(400, '{"description":"Bad Request: chat not found"}')])
    assert ok is False and len(sent) == 1


def test_server_error_is_not_retried_and_never_raises():
    ok, sent, _ = run_send([FakeResp(502, "Bad Gateway")])
    assert ok is False and len(sent) == 1


def test_network_error_returns_false_and_log_has_no_token():
    err = requests.ConnectionError("HTTPSConnectionPool: url: /bot123456:SECRET-TOKEN/sendMessage")
    ok, _, log = run_send([err])
    assert ok is False
    assert "SECRET-TOKEN" not in log and "ConnectionError" in log


def test_missing_credentials_skips_without_posting():
    ok, sent, log = run_send([], env={"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""})
    assert ok is False and sent == [] and "env missing" in log


def test_long_text_is_truncated_to_api_limit():
    _, sent, _ = run_send([FakeResp(200)], text="x" * 9000)
    assert len(sent[0]["text"]) == 4000


# ---------- md_escape ----------

def test_md_escape_escapes_control_characters_only():
    assert tn.md_escape("stock_analyst") == "stock\\_analyst"
    assert tn.md_escape("a*b`c[d") == "a\\*b\\`c\\[d"
    assert tn.md_escape("plain text 1.5%") == "plain text 1.5%"
    assert tn.md_escape(None) == "None"


# ---------- alerts_checker ----------

class FakeBot:
    def __init__(self, behaviours):
        self.behaviours, self.calls = list(behaviours), []

    async def send_message(self, chat_id, text, parse_mode=None):
        self.calls.append(parse_mode)
        item = self.behaviours.pop(0)
        if isinstance(item, Exception):
            raise item


def test_push_falls_back_to_plain_only_on_bad_request():
    bot = FakeBot([BadRequest("can't parse entities"), None])
    assert asyncio.run(alerts_checker._push(bot, 1, "m", 7)) is True
    assert bot.calls == ["Markdown", None]


def test_push_does_not_resend_after_other_errors():
    bot = FakeBot([RuntimeError("network")])
    assert asyncio.run(alerts_checker._push(bot, 1, "m", 7)) is False
    assert bot.calls == ["Markdown"]


def test_push_gives_up_when_plain_text_also_rejected():
    bot = FakeBot([BadRequest("a"), BadRequest("chat not found")])
    assert asyncio.run(alerts_checker._push(bot, 1, "m", 7)) is False


class FakeSb:
    def __init__(self, rows):
        self.rows, self.updates = rows, []

    def table(self, name):
        return self

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def update(self, payload):
        self.updates.append(payload)
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


ALERT = {"id": 1, "ticker": "X.NS", "direction": "above", "threshold_price": 100,
         "user_id": "42", "status": "active"}


def run_check(bot_behaviours):
    sb, bot = FakeSb([dict(ALERT)]), FakeBot(bot_behaviours)
    with patch.dict(os.environ, ENV, clear=False), \
            patch.object(alerts_checker, "create_client", lambda *a, **k: sb), \
            patch.object(alerts_checker, "_safe_last_price", lambda t: 105.0), \
            patch.object(alerts_checker, "Bot", lambda token: bot), \
            contextlib.redirect_stdout(io.StringIO()):
        result = asyncio.run(alerts_checker.check())
    return result, sb


def test_delivered_alert_is_marked_triggered():
    result, sb = run_check([None])
    assert result["triggered"] == 1
    assert len(sb.updates) == 1 and sb.updates[0]["status"] == "triggered"


def test_undelivered_alert_stays_active_for_retry():
    """The old order marked it triggered first, so a failed push lost it."""
    result, sb = run_check([RuntimeError("network down")])
    assert result["triggered"] == 0 and sb.updates == []


def test_parse_error_alert_is_still_delivered_and_marked():
    result, sb = run_check([BadRequest("can't parse entities"), None])
    assert result["triggered"] == 1 and len(sb.updates) == 1

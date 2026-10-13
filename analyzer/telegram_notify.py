"""Shared synchronous Telegram sender for the analyzer jobs (grader, paper
trader, factor mining).

Why this exists: three modules each hand-rolled the same sendMessage POST
with parse_mode=Markdown. Legacy Markdown treats a lone _ * ` or [ as the
start of an entity, so any dynamic text carrying one (the alert "via
stock_analyst" has an underscore) makes Telegram answer 400 "can't parse
entities" and the alert is dropped. That is exactly how the new-trade alert
for PTCIL.NS was lost on 2026-10-13, and the same failure class had already
cost the daily push in July 2026, patched there one sender at a time.

send_markdown tries Markdown first and, on that specific 400, resends the
same text with no parse_mode so the alert always arrives (with literal
marker characters visible, which is better than nothing). md_escape lets a
caller render dynamic text literally inside a formatted message.

Errors are logged by exception type and HTTP status only. A requests
exception message embeds the full URL, and the URL contains the bot token.
"""
from __future__ import annotations

import os
import re

import requests

_API_URL = "https://api.telegram.org/bot{token}/sendMessage"
_TIMEOUT_S = 10
_TEXT_LIMIT = 4000  # API cap is 4096 characters
_PARSE_ERROR = "can't parse entities"
_MARKDOWN_CONTROL = re.compile(r"([_*`\[])")


def md_escape(value) -> str:
    """Escape legacy-Markdown control characters so dynamic text renders
    literally, for example md_escape("stock_analyst") -> stock\\_analyst."""
    return _MARKDOWN_CONTROL.sub(r"\\\1", str(value))


def send_markdown(text: str, tag: str = "telegram_notify") -> bool:
    """Send to the owner chat as Markdown, falling back to plain text on a
    parse error. Returns True if Telegram accepted a message. Never raises:
    a notification problem must not fail the job that produced the data."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print(f"  {tag} skipped (env missing)")
        return False
    url = _API_URL.format(token=token)
    for parse_mode in ("Markdown", None):
        payload = {"chat_id": chat_id, "text": text[:_TEXT_LIMIT],
                   "disable_web_page_preview": True}
        if parse_mode:
            payload["parse_mode"] = parse_mode
        try:
            resp = requests.post(url, json=payload, timeout=_TIMEOUT_S)
        except requests.RequestException as e:
            print(f"  {tag} skipped ({type(e).__name__})")
            return False
        if resp.status_code < 300:
            return True
        if parse_mode and resp.status_code == 400 and _PARSE_ERROR in resp.text:
            print(f"  {tag}: Markdown rejected by Telegram, resending as plain text")
            continue
        print(f"  {tag} HTTP {resp.status_code}: {resp.text[:120]}")
        return False
    return False

"""Telegram push for the US pipeline's standalone jobs.

The scheduled jobs (SEC filings, daily brief, grader) run as systemd oneshots
outside the bot process, so they post straight to the Bot API instead of
going through python-telegram-bot. Plain text only: model-written text can
hold Markdown control characters that make Telegram reject a message.
"""
from __future__ import annotations

import os

import requests

_TELEGRAM_LIMIT = 4000  # API cap is 4096 characters
_TIMEOUT_S = 10


def send_telegram(text: str) -> bool:
    """Best-effort send to the owner chat. Returns False (never raises) when
    credentials are missing or the API call fails, so a notification problem
    can never fail the job that produced the data."""
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat, "text": text[:_TELEGRAM_LIMIT],
                  "disable_web_page_preview": True},
            timeout=_TIMEOUT_S)
        resp.raise_for_status()
        return True
    except requests.RequestException as e:
        print(f"  telegram notify failed: {type(e).__name__}")
        return False

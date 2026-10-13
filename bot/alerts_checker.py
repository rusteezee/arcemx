"""Cron-callable script. Checks every active price alert against a live
quote and pushes a Telegram message the moment one crosses its threshold,
then marks it triggered so it fires exactly once. Mirrors daily_push.py's
standalone shape - no import of telegram_bot.py's Application/handler
machinery, just Bot.send_message.

Dispatched on a 15-minute cron during NSE hours (see
.github/workflows/alerts_checker.yml). Live quote only (no history
download) - one _safe_last_price() call per unique ticker across all
active alerts, not per alert row, so a ticker with 3 alerts costs one
yfinance hit.
"""
import os
import asyncio
from dotenv import load_dotenv
from datetime import datetime, timezone

import yfinance as yf
from telegram import Bot
from telegram.error import BadRequest
from supabase import create_client

load_dotenv()


def _safe_last_price(ticker: str):
    """Same fallback chain as bot/telegram_bot.py's _safe_last_price -
    fast_info first, history close as backup for the tickers where
    yfinance's fast_info 404s."""
    try:
        return yf.Ticker(ticker).fast_info.last_price
    except Exception:
        pass
    try:
        h = yf.Ticker(ticker).history(period="2d")
        if not h.empty:
            return float(h["Close"].iloc[-1])
    except Exception:
        pass
    return None


async def _push(bot: Bot, chat_id, msg: str, alert_id) -> bool:
    """Markdown first; on Telegram's BadRequest (a parse error from a stray
    marker character) resend the same text as plain text. Any other error is
    treated as a failed delivery, not retried here, so a message that may
    already have been delivered is never sent twice."""
    for parse_mode in ("Markdown", None):
        try:
            await bot.send_message(chat_id=chat_id, text=msg, parse_mode=parse_mode)
            return True
        except BadRequest as e:
            print(f"  alert id={alert_id} BadRequest with parse_mode={parse_mode}: {str(e)[:100]}")
        except Exception as e:
            print(f"  alert id={alert_id} push failed ({type(e).__name__})")
            return False
    return False


async def check() -> dict:
    sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
    token = os.getenv("TELEGRAM_BOT_TOKEN")

    rows = sb.table("alerts").select("*").eq("status", "active").execute().data or []
    if not rows:
        print("alerts_checker: no active alerts")
        return {"checked": 0, "triggered": 0}

    tickers = sorted({r["ticker"] for r in rows})
    prices: dict[str, float | None] = {t: _safe_last_price(t) for t in tickers}

    bot = Bot(token) if token else None
    triggered = 0
    for r in rows:
        px = prices.get(r["ticker"])
        if px is None:
            continue
        crossed = (
            (r["direction"] == "above" and px >= float(r["threshold_price"]))
            or (r["direction"] == "below" and px <= float(r["threshold_price"]))
        )
        if not crossed:
            continue

        # Push BEFORE marking triggered. The old order consumed the alert
        # first, so a failed push (parse error, network blip) lost it for
        # good: it never re-fired and the user was never told. Now an
        # undelivered alert stays active and retries on the next run.
        delivered = bot is None
        if bot is not None:
            arrow = "🔔"
            msg = (f"{arrow} *Alert: {r['ticker']}*\n"
                   f"Crossed {r['direction']} ₹{float(r['threshold_price']):.2f}\n"
                   f"Now: ₹{px:.2f}")
            # user_id on the alert row is the Telegram chat id
            # (same convention as portfolio/wishlist - see
            # telegram_bot.py's uid = str(update.effective_user.id)).
            delivered = await _push(bot, r["user_id"], msg, r["id"])
        if not delivered:
            print(f"  alert id={r['id']} left active, will retry next run")
            continue

        sb.table("alerts").update({
            "status": "triggered",
            "triggered_at": datetime.now(timezone.utc).isoformat(),
            "triggered_price": float(px),
        }).eq("id", r["id"]).execute()
        triggered += 1

    print(f"alerts_checker: checked={len(rows)} tickers={len(tickers)} triggered={triggered}")
    return {"checked": len(rows), "triggered": triggered}


if __name__ == "__main__":
    asyncio.run(check())

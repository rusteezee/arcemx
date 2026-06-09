"""Cron-callable script. Pushes latest analysis to configured TELEGRAM_CHAT_ID."""
import os
import asyncio
from dotenv import load_dotenv
from telegram import Bot
from supabase import create_client

load_dotenv()


async def push():
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID")
        return
    sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
    res = sb.table("analysis").select("*").order("run_at", desc=True).limit(1).execute()
    if not res.data:
        await Bot(token).send_message(chat_id=chat_id, text="No analysis available.")
        return
    a = res.data[0]
    raw = a.get("raw_json") or {}
    mood = raw.get("market_mood", "neutral").upper()
    conf = raw.get("confidence", "?")
    short = raw.get("short_term_picks", [])[:5]
    longt = raw.get("long_term_picks", [])[:5]

    msg = f"*Arc'emX! Daily Market Call*\n*Mood:* {mood} (conf: {conf})\n\n"
    msg += f"*Nifty:* {raw.get('nifty_outlook', {}).get('direction', '?')} | {raw.get('nifty_outlook', {}).get('range', '')}\n"
    msg += f"*Sensex:* {raw.get('sensex_outlook', {}).get('direction', '?')} | {raw.get('sensex_outlook', {}).get('range', '')}\n\n"
    msg += "*Short-term:*\n"
    for p in short:
        msg += f"• `{p.get('ticker')}` T:{p.get('target')} SL:{p.get('stop_loss')}\n"
    msg += "\n*Long-term:*\n"
    for p in longt:
        msg += f"• `{p.get('ticker')}`. {(p.get('thesis') or '')[:60]}\n"
    msg += "\n_Not SEBI-registered advice. Educational only. DYOR._"
    await Bot(token).send_message(chat_id=chat_id, text=msg, parse_mode="Markdown")
    print("Pushed.")


if __name__ == "__main__":
    asyncio.run(push())

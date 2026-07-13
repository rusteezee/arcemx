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
    # Filter non-dict entries: the model's JSON generation occasionally
    # glitches on long responses and spills a neighboring key's field
    # names as bare string fragments into these lists (root-caused
    # 2026-07-13). A bare .get() on a str crashes the whole push.
    gainers = [p for p in raw.get("top_performers", []) if isinstance(p, dict)][:5]
    losers = [p for p in raw.get("worst_performers", []) if isinstance(p, dict)][:5]

    msg = f"*Arc'emX! Daily Market Call*\n*Mood:* {mood} (conf: {conf})\n\n"
    msg += f"*Nifty:* {raw.get('nifty_outlook', {}).get('direction', '?')} | {raw.get('nifty_outlook', {}).get('range', '')}\n"
    msg += f"*Sensex:* {raw.get('sensex_outlook', {}).get('direction', '?')} | {raw.get('sensex_outlook', {}).get('range', '')}\n\n"
    msg += "*Gainers:*\n"
    for p in gainers:
        msg += f"• `{p.get('ticker')}` T:{p.get('target')} SL:{p.get('stop_loss')}\n"
    msg += "\n*Losers:*\n"
    for p in losers:
        move = p.get("expected_move_pct")
        move_str = f" ({move}%)" if move is not None else ""
        msg += f"• `{p.get('ticker')}`{move_str}. {(p.get('thesis') or '')[:60]}\n"
    msg += "\n_Not SEBI-registered advice. Educational only. DYOR._"
    await Bot(token).send_message(chat_id=chat_id, text=msg, parse_mode="Markdown")
    print("Pushed.")


if __name__ == "__main__":
    asyncio.run(push())

"""Cron-callable script. Pushes latest analysis to configured TELEGRAM_CHAT_ID."""
import os
import asyncio
from dotenv import load_dotenv
from telegram import Bot
from supabase import create_client

load_dotenv()


def _md_safe(s) -> str:
    """Strip Telegram legacy-Markdown special chars from LLM-generated
    free text before it goes in a parse_mode=Markdown message. Without
    this, a stray _/*/`/[ in the model's own prose (or the 60-char
    thesis truncation slicing through a pair) breaks Telegram's parser
    and silently drops the whole daily push (root-caused 2026-07-26:
    real prod failures on 2026-07-21 and 2026-07-24, byte offsets
    810/805, "can't find end of the entity")."""
    if not s:
        return ""
    for ch in "_*`[]":
        s = s.replace(ch, "")
    return s


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

    nifty_dir = _md_safe(raw.get("nifty_outlook", {}).get("direction", "?"))
    nifty_range = _md_safe(raw.get("nifty_outlook", {}).get("range", ""))
    sensex_dir = _md_safe(raw.get("sensex_outlook", {}).get("direction", "?"))
    sensex_range = _md_safe(raw.get("sensex_outlook", {}).get("range", ""))

    msg = f"*Arc'emX! Daily Market Call*\n*Mood:* {mood} (conf: {conf})\n\n"
    msg += f"*Nifty:* {nifty_dir} | {nifty_range}\n"
    msg += f"*Sensex:* {sensex_dir} | {sensex_range}\n\n"
    msg += "*Gainers:*\n"
    for p in gainers:
        msg += f"• `{_md_safe(p.get('ticker'))}` T:{p.get('target')} SL:{p.get('stop_loss')}\n"
    msg += "\n*Losers:*\n"
    for p in losers:
        move = p.get("expected_move_pct")
        move_str = f" ({move}%)" if move is not None else ""
        thesis = _md_safe((p.get("thesis") or "")[:60])
        msg += f"• `{_md_safe(p.get('ticker'))}`{move_str}. {thesis}\n"
    msg += "\n_Not SEBI-registered advice. Educational only. DYOR._"
    try:
        await Bot(token).send_message(chat_id=chat_id, text=msg, parse_mode="Markdown")
    except Exception as e:
        # Sanitizing should prevent this, but the daily call must never
        # go undelivered - fall back to plain text rather than drop it.
        print(f"Markdown send failed ({e}), retrying as plain text")
        plain = msg.replace("*", "").replace("_", "").replace("`", "")
        await Bot(token).send_message(chat_id=chat_id, text=plain)
    print("Pushed.")


if __name__ == "__main__":
    asyncio.run(push())

"""Telegram bot. Commands:
/start /help /today /nifty /sensex /stock TICKER
/portfolio /wishlist /buy TICKER PRICE QTY /sell TICKER /add_wish TICKER /rm_wish TICKER
/import   (then send CSV file)
"""
import os
import io
import json
import csv
import asyncio
import pandas as pd
import yfinance as yf
from datetime import datetime
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application, CommandHandler, MessageHandler, ContextTypes, filters
)
from supabase import create_client

load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

_sb = None
def sb():
    global _sb
    if _sb is None:
        _sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
    return _sb


DISCLAIMER = "\n\n_Not SEBI-registered advice. Educational only. DYOR._"


def normalize_ticker(t: str) -> str:
    t = t.upper().strip()
    if not t.endswith(".NS") and not t.startswith("^") and "." not in t:
        t += ".NS"
    return t


def _currency(ticker: str) -> str:
    """Indian = ₹, else $ (US)."""
    if ticker.endswith(".NS") or ticker.endswith(".BO") or ticker.startswith("^NSE") or ticker.startswith("^BSE"):
        return "₹"
    return "$"


def _safe_last_price(ticker: str):
    """yfinance fast_info sometimes 404s. Retry via history fallback."""
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


async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Arc'emX! bot ready.\n\n"
        "/today — daily market call\n"
        "/nifty /sensex — index snapshot\n"
        "/stock TICKER — single stock view\n"
        "/portfolio — your holdings + P&L\n"
        "/wishlist — your watchlist\n"
        "/buy TICKER PRICE QTY\n"
        "/sell TICKER\n"
        "/add_wish TICKER /rm_wish TICKER\n"
        "/import — send CSV after (INDmoney export works)\n"
        "/sync — pull holdings + watchlist from INDmoney MCP\n\n"
        f"Your chat ID: `{update.effective_chat.id}`",
        parse_mode="Markdown",
    )


async def today(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Pulling latest analysis...")
    res = sb().table("analysis").select("*").order("run_at", desc=True).limit(1).execute()
    if not res.data:
        await update.message.reply_text("No analysis yet. Run aggregator first.")
        return
    a = res.data[0]
    raw = a.get("raw_json") or {}
    mood = raw.get("market_mood", "neutral").upper()
    conf = raw.get("confidence", "?")
    short = raw.get("short_term_picks", [])[:5]
    longt = raw.get("long_term_picks", [])[:5]
    avoid = raw.get("stocks_to_avoid", [])[:3]

    msg = f"*Market Mood: {mood}* (conf: {conf})\n\n"
    msg += f"*Nifty:* {raw.get('nifty_outlook', {}).get('direction', '?')} | {raw.get('nifty_outlook', {}).get('range', '')}\n"
    msg += f"*Sensex:* {raw.get('sensex_outlook', {}).get('direction', '?')} | {raw.get('sensex_outlook', {}).get('range', '')}\n\n"
    msg += "*Short-term picks:*\n"
    for p in short:
        msg += f"• `{p.get('ticker')}` — {p.get('thesis', '')[:80]} (T:{p.get('target')}, SL:{p.get('stop_loss')})\n"
    msg += "\n*Long-term picks:*\n"
    for p in longt:
        msg += f"• `{p.get('ticker')}` — {p.get('thesis', '')[:80]}\n"
    if avoid:
        msg += "\n*Avoid:*\n"
        for p in avoid:
            msg += f"• `{p.get('ticker')}` — {p.get('reason', '')[:80]}\n"
    msg += "\n_Reasoning:_ " + (raw.get("reasoning", "")[:500])
    msg += DISCLAIMER
    await update.message.reply_text(msg, parse_mode="Markdown", disable_web_page_preview=True)


async def index_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE, symbol: str, name: str):
    try:
        info = yf.Ticker(symbol).fast_info
        last, prev = info.last_price, info.previous_close
        pct = (last - prev) / prev * 100 if prev else 0
        arrow = "🟢" if pct >= 0 else "🔴"
        await update.message.reply_text(
            f"{arrow} *{name}*\nLast: {last:.2f}\nChg: {pct:+.2f}%\nHigh: {info.day_high:.2f}\nLow: {info.day_low:.2f}" + DISCLAIMER,
            parse_mode="Markdown",
        )
    except Exception as e:
        await update.message.reply_text(f"fetch fail: {e}")


async def nifty(update, ctx): await index_cmd(update, ctx, "^NSEI", "NIFTY 50")
async def sensex(update, ctx): await index_cmd(update, ctx, "^BSESN", "SENSEX")


async def stock(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /stock RELIANCE")
        return
    t = normalize_ticker(ctx.args[0])
    try:
        tk = yf.Ticker(t)
        info = tk.fast_info
        last, prev = info.last_price, info.previous_close
        pct = (last - prev) / prev * 100 if prev else 0
        hist = tk.history(period="6mo")
        chg_1m = (last - hist["Close"].iloc[-22]) / hist["Close"].iloc[-22] * 100 if len(hist) > 22 else None
        chg_6m = (last - hist["Close"].iloc[0]) / hist["Close"].iloc[0] * 100 if len(hist) > 0 else None
        msg = f"*{t}*\nLast: {_currency(t)}{last:.2f}\n1D: {pct:+.2f}%\n"
        if chg_1m is not None: msg += f"1M: {chg_1m:+.2f}%\n"
        if chg_6m is not None: msg += f"6M: {chg_6m:+.2f}%\n"
        msg += f"52W H: {info.year_high:.2f}\n52W L: {info.year_low:.2f}"
        msg += DISCLAIMER
        await update.message.reply_text(msg, parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text(f"fail: {e}")


async def portfolio(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_user.id)
    res = sb().table("portfolio").select("*").eq("user_id", uid).execute()
    if not res.data:
        await update.message.reply_text("Empty. Use /buy TICKER PRICE QTY or /import to upload CSV.")
        return
    msg = "*Portfolio*\n"
    total_inv, total_cur = 0, 0
    for h in res.data:
        last = _safe_last_price(h["ticker"])
        if last is None:
            msg += f"`{h['ticker']}` — fetch fail\n"
            continue
        inv = h["avg_buy_price"] * h["qty"]
        cur = last * h["qty"]
        pnl = cur - inv
        pnl_pct = pnl / inv * 100
        total_inv += inv
        total_cur += cur
        arrow = "🟢" if pnl >= 0 else "🔴"
        c = _currency(h["ticker"])
        msg += f"{arrow} `{h['ticker']}` x{h['qty']} @ {c}{h['avg_buy_price']:.2f}\n  Now {c}{last:.2f} | P&L {c}{pnl:+.0f} ({pnl_pct:+.1f}%)\n"
    tot_pnl = total_cur - total_inv
    tot_pct = tot_pnl / total_inv * 100 if total_inv else 0
    msg += f"\n*Total:* Invested ₹{total_inv:.0f} → ₹{total_cur:.0f} | P&L ₹{tot_pnl:+.0f} ({tot_pct:+.2f}%)"
    msg += DISCLAIMER
    await update.message.reply_text(msg, parse_mode="Markdown")


async def buy(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if len(ctx.args) < 3:
        await update.message.reply_text("Usage: /buy RELIANCE 2500 10")
        return
    t = normalize_ticker(ctx.args[0])
    price = float(ctx.args[1])
    qty = float(ctx.args[2])
    uid = str(update.effective_user.id)
    sb().table("portfolio").upsert({
        "user_id": uid, "ticker": t, "qty": qty, "avg_buy_price": price
    }, on_conflict="user_id,ticker").execute()
    await update.message.reply_text(f"Saved: {t} x{qty} @ ₹{price}")


async def sell(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /sell RELIANCE")
        return
    t = normalize_ticker(ctx.args[0])
    uid = str(update.effective_user.id)
    sb().table("portfolio").delete().eq("user_id", uid).eq("ticker", t).execute()
    await update.message.reply_text(f"Removed {t} from portfolio")


async def wishlist(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    uid = str(update.effective_user.id)
    res = sb().table("wishlist").select("*").eq("user_id", uid).execute()
    if not res.data:
        await update.message.reply_text("Wishlist empty. /add_wish TICKER")
        return
    msg = "*Wishlist*\n"
    for w in res.data:
        last = _safe_last_price(w["ticker"])
        if last is None:
            msg += f"• `{w['ticker']}` — n/a\n"
        else:
            msg += f"• `{w['ticker']}` {_currency(w['ticker'])}{last:.2f}\n"
    msg += DISCLAIMER
    await update.message.reply_text(msg, parse_mode="Markdown")


async def add_wish(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /add_wish RELIANCE")
        return
    t = normalize_ticker(ctx.args[0])
    uid = str(update.effective_user.id)
    sb().table("wishlist").upsert({"user_id": uid, "ticker": t}, on_conflict="user_id,ticker").execute()
    await update.message.reply_text(f"Added {t}")


async def rm_wish(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not ctx.args:
        await update.message.reply_text("Usage: /rm_wish RELIANCE")
        return
    t = normalize_ticker(ctx.args[0])
    uid = str(update.effective_user.id)
    sb().table("wishlist").delete().eq("user_id", uid).eq("ticker", t).execute()
    await update.message.reply_text(f"Removed {t}")


async def sync_indmoney(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Pull holdings + watchlist from INDmoney MCP into Supabase."""
    from fetchers.indmoney_mcp import sync_to_supabase
    uid = str(update.effective_user.id)
    await update.message.reply_text("Syncing from INDmoney... (10-30s)")
    try:
        n = await sync_to_supabase(user_id=uid)
        await update.message.reply_text(
            f"✅ Synced {n['holdings']} holdings + {n['watchlist']} watchlist items.\n"
            "Run /portfolio or /wishlist to view."
        )
    except Exception as e:
        await update.message.reply_text(
            f"❌ Sync failed: {e}\n\n"
            "If auth expired, re-run on host: `python -m fetchers.indmoney_auth`"
        )


async def import_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Send CSV with columns: `ticker,qty,avg_buy_price`\n"
        "Example row: `RELIANCE,10,2450.50`\n\n"
        "INDmoney export: app → Holdings → 3-dots → Export → email to self → "
        "open in Excel/Sheets → keep only those 3 columns → save as CSV → send here.",
        parse_mode="Markdown",
    )


async def handle_doc(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    doc = update.message.document
    if not doc.file_name.lower().endswith(".csv"):
        await update.message.reply_text("Send a .csv file")
        return
    f = await doc.get_file()
    buf = io.BytesIO()
    await f.download_to_memory(buf)
    buf.seek(0)
    reader = csv.DictReader(io.StringIO(buf.read().decode("utf-8", errors="ignore")))
    uid = str(update.effective_user.id)
    n = 0
    for row in reader:
        try:
            t = normalize_ticker(row.get("ticker") or row.get("Ticker") or row.get("symbol"))
            qty = float(row.get("qty") or row.get("Qty") or row.get("quantity"))
            price = float(row.get("avg_buy_price") or row.get("Avg Buy Price") or row.get("avg_price"))
            sb().table("portfolio").upsert({
                "user_id": uid, "ticker": t, "qty": qty, "avg_buy_price": price
            }, on_conflict="user_id,ticker").execute()
            n += 1
        except Exception as e:
            print(f"row fail: {e} | {row}")
    await update.message.reply_text(f"Imported {n} holdings. /portfolio to view.")


async def push_daily(app: Application):
    """Called by cron via /push endpoint or separate script."""
    if not CHAT_ID:
        return
    fake_update = type("U", (), {"message": type("M", (), {"reply_text": lambda *a, **k: app.bot.send_message(chat_id=CHAT_ID, text=a[0] if a else k.get("text", ""), parse_mode=k.get("parse_mode"))})()})()
    await today(fake_update, None)


async def scheduled_sync():
    """Daily 8 AM IST INDmoney sync before analysis runs at 8:30."""
    from fetchers.indmoney_mcp import sync_to_supabase
    try:
        n = await sync_to_supabase(user_id=str(CHAT_ID) if CHAT_ID else "default")
        print(f"Scheduled sync: {n}")
    except Exception as e:
        print(f"Scheduled sync failed: {e}")


_BG_TASKS: set = set()


async def _start_health_server(port: int):
    """HTTP server for Render port scan + /trigger/sync webhook."""
    trigger_secret = os.getenv("TRIGGER_SECRET", "")

    async def handle(reader, writer):
        try:
            request_line = (await reader.readline()).decode(errors="ignore").strip()
            method = request_line.split(" ")[0] if request_line else ""
            path = request_line.split(" ")[1] if " " in request_line else "/"

            headers: dict[str, str] = {}
            while True:
                ln = await reader.readline()
                if ln in (b"\r\n", b"\n", b""):
                    break
                line = ln.decode(errors="ignore")
                if ":" in line:
                    k, _, v = line.partition(":")
                    headers[k.strip().lower()] = v.strip()

            content_length = int(headers.get("content-length", "0") or "0")
            body_bytes = await reader.readexactly(content_length) if content_length else b""

            if method == "POST" and path.startswith("/trigger/sync"):
                token = headers.get("x-trigger-token", "")
                if not trigger_secret or token != trigger_secret:
                    msg = b'{"error":"unauthorized"}'
                    resp = (
                        b"HTTP/1.1 401 Unauthorized\r\n"
                        b"Content-Type: application/json\r\n"
                        b"Content-Length: " + str(len(msg)).encode() + b"\r\n"
                        b"Connection: close\r\n\r\n" + msg
                    )
                    writer.write(resp); await writer.drain(); return

                import json as _json
                try:
                    payload = _json.loads(body_bytes or b"{}")
                except Exception:
                    payload = {}
                uid = str(payload.get("user_id") or os.getenv("TELEGRAM_CHAT_ID", "default"))

                from fetchers.indmoney_mcp import sync_to_supabase
                try:
                    result = await sync_to_supabase(user_id=uid)
                    # Kick off Gemini analysis in background. Don't block the
                    # HTTP response on it — the dashboard polls the analysis
                    # table separately so a slow Gemini call will not time out
                    # the client.
                    refresh_analysis = bool(payload.get("refresh_analysis", True))
                    if refresh_analysis:
                        try:
                            from analyzer.aggregator import run as run_analysis
                            import asyncio as _asyncio

                            # Manual dashboard syncs use the lite model
                            # (500/day free quota). Daily cron keeps the
                            # primary model for highest quality.
                            from analyzer.llm import LITE_MODEL as _LITE
                            async def _bg_analysis():
                                try:
                                    print("Background analysis starting...")
                                    loop = _asyncio.get_event_loop()
                                    await loop.run_in_executor(None, lambda: run_analysis(model_name=_LITE))
                                    print("Background analysis refresh complete")
                                except Exception as bgerr:
                                    import traceback
                                    print(f"Background analysis failed: {bgerr}")
                                    traceback.print_exc()

                            task = _asyncio.create_task(_bg_analysis())
                            _BG_TASKS.add(task)
                            task.add_done_callback(_BG_TASKS.discard)
                            result["analysis"] = "queued"
                        except Exception as ae:
                            result["analysis_error"] = str(ae)
                    out = _json.dumps({"ok": True, **result}).encode()
                    status_line = b"HTTP/1.1 200 OK\r\n"
                except Exception as e:
                    out = _json.dumps({"ok": False, "error": str(e)}).encode()
                    status_line = b"HTTP/1.1 500 Internal Server Error\r\n"

                resp = (
                    status_line +
                    b"Content-Type: application/json\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n"
                    b"Connection: close\r\n\r\n" + out
                )
                writer.write(resp); await writer.drain(); return

            # default health response
            body = b"OK"
            resp = (
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/plain\r\n"
                b"Content-Length: 2\r\n"
                b"Connection: close\r\n\r\n" + body
            )
            writer.write(resp)
            await writer.drain()
        except Exception as e:
            print(f"health handler error: {e}")
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, "0.0.0.0", port)
    print(f"Health server on :{port}")
    return server


async def _post_init(app: Application):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")
    scheduler.add_job(scheduled_sync, CronTrigger(hour=8, minute=0, day_of_week="mon-fri"))
    scheduler.start()
    app.bot_data["scheduler"] = scheduler

    port = int(os.getenv("PORT", "0"))
    if port:
        app.bot_data["health"] = await _start_health_server(port)


def main():
    app = Application.builder().token(TOKEN).post_init(_post_init).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", start))
    app.add_handler(CommandHandler("today", today))
    app.add_handler(CommandHandler("nifty", nifty))
    app.add_handler(CommandHandler("sensex", sensex))
    app.add_handler(CommandHandler("stock", stock))
    app.add_handler(CommandHandler("portfolio", portfolio))
    app.add_handler(CommandHandler("wishlist", wishlist))
    app.add_handler(CommandHandler("buy", buy))
    app.add_handler(CommandHandler("sell", sell))
    app.add_handler(CommandHandler("add_wish", add_wish))
    app.add_handler(CommandHandler("rm_wish", rm_wish))
    app.add_handler(CommandHandler("import", import_help))
    app.add_handler(CommandHandler("sync_indmoney", sync_indmoney))
    app.add_handler(CommandHandler("sync", sync_indmoney))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_doc))
    print("Bot running...")
    app.run_polling()


if __name__ == "__main__":
    main()

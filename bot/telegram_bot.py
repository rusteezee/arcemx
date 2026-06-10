"""Telegram bot. Commands:
/start /help /today /nifty /sensex /stock TICKER
/portfolio /wishlist /buy TICKER PRICE QTY /sell TICKER /add_wish TICKER /rm_wish TICKER
/import   (then send CSV file)
"""
import os
import sys


def _emergency_port_bind():
    """Bind the Render-required port BEFORE any heavy imports.

    pandas, yfinance, telegram.ext, and supabase together take 30-60s
    to cold-import on the Render free instance. If we let them load
    first, Render's port scan times out and the deploy fails. Open
    a minimal threaded HTTP server here at module top so the port is
    listening within a couple of seconds, then keep importing.
    """
    port_str = os.getenv("PORT", "0")
    try:
        port = int(port_str)
    except ValueError:
        port = 0
    if not port:
        return None
    try:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class _Stub(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"OK")

            def log_message(self, *a, **k):
                pass

        srv = ThreadingHTTPServer(("0.0.0.0", port), _Stub)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        print(f"Emergency HTTP stub bound on :{port}", flush=True)
        return srv
    except Exception as e:
        print(f"Emergency stub bind failed: {e}", flush=True)
        return None


_STUB_SRV = _emergency_port_bind()


# Heavy imports start here. these take tens of seconds on cold start
# but the port is already listening from the emergency bind above.
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
        "/today. daily market call\n"
        "/nifty /sensex. index snapshot\n"
        "/stock TICKER. single stock view\n"
        "/portfolio. your holdings + P&L\n"
        "/wishlist. your watchlist\n"
        "/buy TICKER PRICE QTY\n"
        "/sell TICKER\n"
        "/add_wish TICKER /rm_wish TICKER\n"
        "/import. send CSV after (INDmoney export works)\n"
        "/sync. pull holdings + watchlist from INDmoney MCP\n\n"
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
        msg += f"• `{p.get('ticker')}`. {p.get('thesis', '')[:80]} (T:{p.get('target')}, SL:{p.get('stop_loss')})\n"
    msg += "\n*Long-term picks:*\n"
    for p in longt:
        msg += f"• `{p.get('ticker')}`. {p.get('thesis', '')[:80]}\n"
    if avoid:
        msg += "\n*Avoid:*\n"
        for p in avoid:
            msg += f"• `{p.get('ticker')}`. {p.get('reason', '')[:80]}\n"
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
            msg += f"`{h['ticker']}`. fetch fail\n"
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
            msg += f"• `{w['ticker']}`. n/a\n"
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


def _flatten_exception(e: BaseException) -> str:
    """The MCP client wraps internal errors in anyio ExceptionGroups, so
    a bare str(e) on the outer exception just reads
    "unhandled errors in a TaskGroup (1 sub-exception)" and hides the
    actual cause. Walk the .exceptions tree and return the first leaf
    message that's not another group, so users see the real reason."""
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return f"{type(e).__name__}: {e}"


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
    except BaseException as e:
        msg = _flatten_exception(e)
        await update.message.reply_text(
            f"❌ Sync failed: {msg}\n\n"
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

# In-flight locks for the expensive single-flight jobs. A double click on
# the dashboard (or a retrying proxy) must not queue a second 7-12 minute
# LLM run: analyses 42-44 in prod were three full quota-burning runs fired
# one minute apart. Contains the job name ("analysis" / "sensei" /
# "grader") while that job runs; triggers answer 409 instead of queueing.
_JOB_RUNNING: set = set()


async def _start_health_server(port: int):
    """HTTP server for Render port scan + /trigger/sync webhook."""
    # Shut down the stub HTTP server first so we can rebind the same port.
    global _STUB_SRV
    if _STUB_SRV is not None:
        try:
            _STUB_SRV.shutdown()
            _STUB_SRV.server_close()
            print("Stub HTTP server shut down; binding real handler")
        except Exception as e:
            print(f"Stub shutdown error (continuing): {e}")
        _STUB_SRV = None
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
                    # HTTP response on it. the dashboard polls the analysis
                    # table separately so a slow Gemini call will not time out
                    # the client.
                    refresh_analysis = bool(payload.get("refresh_analysis", True))
                    if refresh_analysis and "analysis" in _JOB_RUNNING:
                        # Same single-flight lock as /trigger/analysis: an
                        # LLM run is already going, don't queue a second.
                        result["analysis"] = "already_running"
                    elif refresh_analysis:
                        try:
                            from analyzer.aggregator import run as run_analysis
                            import asyncio as _asyncio

                            # OpenRouter migration: there is no separate
                            # lite/primary tier anymore; LITE_MODEL is an
                            # alias for PRIMARY_MODEL kept for back-compat,
                            # and OpenRouter's server-side fallback chain
                            # absorbs rate-limit spikes that previously
                            # justified a second tier.
                            from analyzer.llm_router import LITE_MODEL as _LITE
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
                                finally:
                                    _JOB_RUNNING.discard("analysis")

                            _JOB_RUNNING.add("analysis")
                            task = _asyncio.create_task(_bg_analysis())
                            _BG_TASKS.add(task)
                            task.add_done_callback(_BG_TASKS.discard)
                            result["analysis"] = "queued"
                        except Exception as ae:
                            _JOB_RUNNING.discard("analysis")
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

            # /trigger/sensei + /trigger/grader: dashboard-driven manual
            # runs so the user does not have to click through GitHub Actions.
            # Same X-Trigger-Token auth as /trigger/sync. Each dispatches the
            # underlying job in the asyncio background and returns "queued"
            # immediately so the dashboard fetch does not block on a 7-12
            # minute LLM call or a 30-90 second grader sweep.
            if method == "POST" and (
                path.startswith("/trigger/sensei")
                or path.startswith("/trigger/grader")
            ):
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

                if path.startswith("/trigger/sensei"):
                    aid = payload.get("analysis_id")
                    try:
                        aid_int = int(aid) if aid is not None else None
                    except (TypeError, ValueError):
                        aid_int = None
                    if "sensei" in _JOB_RUNNING:
                        out = _json.dumps({
                            "ok": False, "job": "sensei",
                            "status": "already_running",
                        }).encode()
                        status_line = b"HTTP/1.1 409 Conflict\r\n"
                    else:
                        try:
                            from analyzer.sensei import run as run_sensei
                            import asyncio as _asyncio

                            async def _bg_sensei():
                                try:
                                    print(f"Background Sensei starting (analysis_id={aid_int})...")
                                    loop = _asyncio.get_event_loop()
                                    await loop.run_in_executor(None, lambda: run_sensei(aid_int))
                                    print("Background Sensei complete")
                                except Exception as bgerr:
                                    import traceback
                                    print(f"Background Sensei failed: {bgerr}")
                                    traceback.print_exc()
                                finally:
                                    _JOB_RUNNING.discard("sensei")

                            _JOB_RUNNING.add("sensei")
                            task = _asyncio.create_task(_bg_sensei())
                            _BG_TASKS.add(task)
                            task.add_done_callback(_BG_TASKS.discard)
                            out = _json.dumps({
                                "ok": True, "job": "sensei", "status": "queued",
                                "analysis_id": aid_int,
                            }).encode()
                            status_line = b"HTTP/1.1 202 Accepted\r\n"
                        except Exception as e:
                            _JOB_RUNNING.discard("sensei")
                            out = _json.dumps({"ok": False, "job": "sensei", "error": str(e)}).encode()
                            status_line = b"HTTP/1.1 500 Internal Server Error\r\n"
                else:  # /trigger/grader
                    lookback = payload.get("lookback_days", 90)
                    try:
                        lookback_int = int(lookback)
                    except (TypeError, ValueError):
                        lookback_int = 90
                    if "grader" in _JOB_RUNNING:
                        out = _json.dumps({
                            "ok": False, "job": "grader",
                            "status": "already_running",
                        }).encode()
                        status_line = b"HTTP/1.1 409 Conflict\r\n"
                        resp = (
                            status_line +
                            b"Content-Type: application/json\r\n"
                            b"Access-Control-Allow-Origin: *\r\n"
                            b"Content-Length: " + str(len(out)).encode() + b"\r\n"
                            b"Connection: close\r\n\r\n" + out
                        )
                        writer.write(resp); await writer.drain(); return
                    try:
                        from analyzer.grader import grade_all, compute_summaries
                        import asyncio as _asyncio

                        async def _bg_grader():
                            try:
                                print(f"Background grader starting (lookback={lookback_int}d)...")
                                loop = _asyncio.get_event_loop()
                                await loop.run_in_executor(
                                    None, lambda: grade_all(lookback_days=lookback_int))
                                await loop.run_in_executor(None, compute_summaries)
                                print("Background grader complete")
                            except Exception as bgerr:
                                import traceback
                                print(f"Background grader failed: {bgerr}")
                                traceback.print_exc()
                            finally:
                                _JOB_RUNNING.discard("grader")

                        _JOB_RUNNING.add("grader")
                        task = _asyncio.create_task(_bg_grader())
                        _BG_TASKS.add(task)
                        task.add_done_callback(_BG_TASKS.discard)
                        out = _json.dumps({
                            "ok": True, "job": "grader", "status": "queued",
                            "lookback_days": lookback_int,
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    except Exception as e:
                        _JOB_RUNNING.discard("grader")
                        out = _json.dumps({"ok": False, "job": "grader", "error": str(e)}).encode()
                        status_line = b"HTTP/1.1 500 Internal Server Error\r\n"

                resp = (
                    status_line +
                    b"Content-Type: application/json\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n"
                    b"Connection: close\r\n\r\n" + out
                )
                writer.write(resp); await writer.drain(); return

            # /trigger/calc-explain: enrich a deterministic Calculator run
            # with LLM rationale. Body shape:
            #   { input: {...}, deterministic: {...} }
            # Inserts a calculator_runs row with status='pending', kicks off
            # the LLM call in the background, returns 202 + run_id so the
            # browser can poll the row by id until status != 'pending'.
            if method == "POST" and path.startswith("/trigger/calc-explain"):
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

                input_json = payload.get("input") or {}
                det_json = payload.get("deterministic") or {}
                if not det_json:
                    out = _json.dumps({
                        "ok": False, "error": "missing deterministic payload",
                    }).encode()
                    status_line = b"HTTP/1.1 400 Bad Request\r\n"
                else:
                    try:
                        import os as _os
                        from supabase import create_client as _create_client
                        url = _os.getenv("SUPABASE_URL")
                        key = _os.getenv("SUPABASE_KEY")
                        if not url or not key:
                            raise RuntimeError("Supabase env missing")
                        _sb = _create_client(url, key)
                        ins = _sb.table("calculator_runs").insert({
                            "input_json": input_json,
                            "deterministic_json": det_json,
                            "status": "pending",
                        }).execute()
                        run_id = (ins.data or [{}])[0].get("id")
                        if run_id is None:
                            raise RuntimeError("insert returned no id")

                        from analyzer.calculator_llm import run as run_calc
                        import asyncio as _asyncio

                        async def _bg_calc(rid: int):
                            try:
                                print(f"Background calculator LLM starting (run_id={rid})...")
                                loop = _asyncio.get_event_loop()
                                await loop.run_in_executor(None, lambda: run_calc(rid))
                                print(f"Background calculator LLM complete (run_id={rid})")
                            except Exception as bgerr:
                                import traceback
                                print(f"Background calculator LLM failed: {bgerr}")
                                traceback.print_exc()

                        task = _asyncio.create_task(_bg_calc(run_id))
                        _BG_TASKS.add(task)
                        task.add_done_callback(_BG_TASKS.discard)
                        out = _json.dumps({
                            "ok": True, "job": "calc-explain",
                            "status": "queued", "run_id": run_id,
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    except Exception as e:
                        out = _json.dumps({
                            "ok": False, "job": "calc-explain", "error": str(e),
                        }).encode()
                        status_line = b"HTTP/1.1 500 Internal Server Error\r\n"

                resp = (
                    status_line +
                    b"Content-Type: application/json\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n"
                    b"Connection: close\r\n\r\n" + out
                )
                writer.write(resp); await writer.drain(); return

            # /trigger/analysis: run JUST the LLM analysis pipeline. The
            # /trigger/sync endpoint above already does INDmoney refresh
            # + analysis bundled; this one is the cheap counterpart for
            # the "analysis is stale" case where the user does not need
            # to re-pull positions. Returns 202 + queued immediately so
            # the dashboard does not block on the 7-12 minute LLM call.
            if method == "POST" and path.startswith("/trigger/analysis"):
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
                if "analysis" in _JOB_RUNNING:
                    out = _json.dumps({
                        "ok": False, "job": "analysis",
                        "status": "already_running",
                    }).encode()
                    status_line = b"HTTP/1.1 409 Conflict\r\n"
                else:
                    try:
                        from analyzer.aggregator import run as run_analysis
                        from analyzer.llm_router import LITE_MODEL as _LITE
                        import asyncio as _asyncio

                        async def _bg_analysis_solo():
                            try:
                                print("Background analysis (solo) starting...")
                                loop = _asyncio.get_event_loop()
                                await loop.run_in_executor(
                                    None, lambda: run_analysis(model_name=_LITE))
                                print("Background analysis (solo) complete")
                            except Exception as bgerr:
                                import traceback
                                print(f"Background analysis (solo) failed: {bgerr}")
                                traceback.print_exc()
                            finally:
                                _JOB_RUNNING.discard("analysis")

                        _JOB_RUNNING.add("analysis")
                        task = _asyncio.create_task(_bg_analysis_solo())
                        _BG_TASKS.add(task)
                        task.add_done_callback(_BG_TASKS.discard)
                        out = _json.dumps({
                            "ok": True, "job": "analysis", "status": "queued",
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    except Exception as e:
                        _JOB_RUNNING.discard("analysis")
                        out = _json.dumps({
                            "ok": False, "job": "analysis", "error": str(e),
                        }).encode()
                        status_line = b"HTTP/1.1 500 Internal Server Error\r\n"

                resp = (
                    status_line +
                    b"Content-Type: application/json\r\n"
                    b"Access-Control-Allow-Origin: *\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n"
                    b"Connection: close\r\n\r\n" + out
                )
                writer.write(resp); await writer.drain(); return

            # /trigger/portfolio-score: enrich a deterministic Portfolio
            # Scorecard run with LLM takes. Body shape:
            #   { deterministic: {...} }
            # Inserts a portfolio_score_runs row with status='pending',
            # kicks off the LLM call in the background, returns 202 + run_id.
            if method == "POST" and path.startswith("/trigger/portfolio-score"):
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

                det_json = payload.get("deterministic") or {}
                if not det_json:
                    out = _json.dumps({
                        "ok": False, "error": "missing deterministic payload",
                    }).encode()
                    status_line = b"HTTP/1.1 400 Bad Request\r\n"
                else:
                    try:
                        import os as _os
                        from supabase import create_client as _create_client
                        url = _os.getenv("SUPABASE_URL")
                        key = _os.getenv("SUPABASE_KEY")
                        if not url or not key:
                            raise RuntimeError("Supabase env missing")
                        _sb = _create_client(url, key)
                        ins = _sb.table("portfolio_score_runs").insert({
                            "deterministic_json": det_json,
                            "status": "pending",
                        }).execute()
                        run_id = (ins.data or [{}])[0].get("id")
                        if run_id is None:
                            raise RuntimeError("insert returned no id")

                        from analyzer.portfolio_score_llm import run as run_psc
                        import asyncio as _asyncio

                        async def _bg_psc(rid: int):
                            try:
                                print(f"Background portfolio LLM starting (run_id={rid})...")
                                loop = _asyncio.get_event_loop()
                                await loop.run_in_executor(None, lambda: run_psc(rid))
                                print(f"Background portfolio LLM complete (run_id={rid})")
                            except Exception as bgerr:
                                import traceback
                                print(f"Background portfolio LLM failed: {bgerr}")
                                traceback.print_exc()

                        task = _asyncio.create_task(_bg_psc(run_id))
                        _BG_TASKS.add(task)
                        task.add_done_callback(_BG_TASKS.discard)
                        out = _json.dumps({
                            "ok": True, "job": "portfolio-score",
                            "status": "queued", "run_id": run_id,
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    except Exception as e:
                        out = _json.dumps({
                            "ok": False, "job": "portfolio-score", "error": str(e),
                        }).encode()
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


async def scheduled_grader():
    """Redundant grader trigger from inside the bot. The GitHub Actions
    cron at 17:00 IST is the primary scheduler, but the free tier
    occasionally delays jobs by 10-60+ minutes under load. The bot is
    kept warm by cron-job.org pings so this in-process schedule fires
    reliably even when the GH cron drifts. Both writing to the same
    accuracy_summary / prediction_scores tables is safe; the grader is
    idempotent and dedups by analysis_id + dimension."""
    import asyncio as _asyncio
    try:
        print("In-bot scheduled grader starting...")
        from analyzer.grader import grade_all, compute_summaries
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, lambda: grade_all(lookback_days=90))
        await loop.run_in_executor(None, compute_summaries)
        print("In-bot scheduled grader complete.")
    except Exception as e:
        print(f"In-bot scheduled grader failed: {e}")


async def scheduled_sensei():
    """Redundant Sensei EOD synthesis trigger. Mirrors scheduled_grader:
    GH cron is primary, this is a fallback in case Actions queue lag
    pushes the 20:00 IST run beyond a useful window."""
    import asyncio as _asyncio
    try:
        print("In-bot scheduled Sensei starting...")
        from analyzer.sensei import run as run_sensei
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, lambda: run_sensei(None))
        print("In-bot scheduled Sensei complete.")
    except Exception as e:
        print(f"In-bot scheduled Sensei failed: {e}")


async def scheduled_analysis():
    """PRIMARY 08:30 IST weekday morning analysis, in-bot. GitHub's
    free-tier cron has fired hours late (3h50m drift observed) and on
    10 June 2026 did not fire at all, so the bot owns the morning run
    and the GH workflow becomes the 08:43 IST fallback. run_if_stale
    guards both directions: whoever fires second sees a fresh analysis
    row and exits without burning a second LLM call. On a successful
    run the daily Telegram call is pushed from here, which previously
    only happened when the GH workflow ran."""
    import asyncio as _asyncio
    if "analysis" in _JOB_RUNNING:
        print("In-bot scheduled analysis: already running, skip")
        return
    _JOB_RUNNING.add("analysis")
    try:
        print("In-bot scheduled analysis starting...")
        from analyzer.aggregator import run_if_stale
        loop = _asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: run_if_stale(max_age_minutes=90))
        if result is not None and not result.get("error"):
            try:
                from bot.daily_push import push as _push_daily
                await _push_daily()
            except Exception as pe:
                print(f"Telegram push after analysis failed: {pe}")
        print("In-bot scheduled analysis complete.")
    except Exception as e:
        print(f"In-bot scheduled analysis failed: {e}")
    finally:
        _JOB_RUNNING.discard("analysis")


async def _post_init(app: Application):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    scheduler = AsyncIOScheduler(timezone="Asia/Kolkata")
    scheduler.add_job(scheduled_sync, CronTrigger(hour=8, minute=0, day_of_week="mon-fri"))
    # 08:30 IST: morning analysis, bot-primary (GH cron drifted hours or
    # skipped entirely on free tier; see scheduled_analysis docstring).
    scheduler.add_job(scheduled_analysis, CronTrigger(hour=8, minute=30, day_of_week="mon-fri"))
    # 17:05 IST: grader pass. Run 5 minutes after the GH cron's 17:00
    # target so when GH fires on time both runs grade the same row set
    # (idempotent), and when GH drifts the bot-side run still lands
    # before evening Sensei needs the scores.
    scheduler.add_job(scheduled_grader, CronTrigger(hour=17, minute=5, day_of_week="mon-fri"))
    # 20:05 IST: Sensei EOD. Same 5-minute offset from GH's 20:00 target.
    scheduler.add_job(scheduled_sensei, CronTrigger(hour=20, minute=5, day_of_week="mon-fri"))
    scheduler.start()
    app.bot_data["scheduler"] = scheduler

    port = int(os.getenv("PORT", "0"))
    if port:
        app.bot_data["health"] = await _start_health_server(port)


def main():
    # The stub HTTP server was already bound at module import time via
    # _emergency_port_bind(), so the port is open before any heavy imports
    # finished loading. _start_health_server will swap the stub for the
    # real async handler once PTB's post_init runs.
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

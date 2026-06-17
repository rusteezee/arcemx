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


# GitHub Actions workflow dispatch. Render free tier is 512 MB; the
# in-process aggregator + sensei + grader fan-outs pushed the dyno past
# the ceiling on 12/06/2026, triggering an OOM-restart. Offloading the
# heavy work to a GitHub-hosted runner (~7 GB RAM, free) keeps the bot
# itself a thin scheduler + Telegram router. The bot now fires
# workflow_dispatch instead of importing analyzer modules.
#
# Required env vars on Render:
#   GH_TOKEN  - fine-grained PAT with Actions: write on this repo
#   GH_REPO   - "rusteezee/arcemx"
# When either is missing _dispatch_github_workflow returns False and the
# caller falls back to the in-process path (same code as before this
# patch), so the bot keeps working unchanged if the token is unset.
GH_API_BASE = "https://api.github.com"


async def _dispatch_github_workflow(
    workflow_filename: str,
    inputs: dict | None = None,
    ref: str = "master",
) -> tuple[bool, str]:
    """POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches.

    Returns (success, detail). Soft-fails on missing env vars, network
    errors, or non-204 responses; the detail string explains the miss
    so callers can log it. Uses urllib in a thread to avoid pulling
    aiohttp just for this; the bot already runs async via the Telegram
    long-poll loop so a blocking call inside run_in_executor is safe.
    """
    token = os.getenv("GH_TOKEN")
    repo = os.getenv("GH_REPO")
    if not token or not repo:
        return False, "GH_TOKEN or GH_REPO missing"
    url = f"{GH_API_BASE}/repos/{repo}/actions/workflows/{workflow_filename}/dispatches"
    body = {"ref": ref}
    if inputs:
        # Workflow dispatch inputs are all strings on the API; coerce
        # ints + bools to their string form so the YAML side parses
        # them back without surprises.
        body["inputs"] = {k: str(v) for k, v in inputs.items() if v is not None}
    data = json.dumps(body).encode()
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "arcemx-bot/1.0",
    }
    import urllib.request as _ureq
    import urllib.error as _uerr

    def _post():
        req = _ureq.Request(url, data=data, headers=headers, method="POST")
        try:
            with _ureq.urlopen(req, timeout=15) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except _uerr.HTTPError as e:
            try:
                err = e.read().decode("utf-8", "replace")
            except Exception:
                err = str(e)
            return e.code, err
        except Exception as e:
            return -1, str(e)

    loop = asyncio.get_event_loop()
    status, payload = await loop.run_in_executor(None, _post)
    if status == 204:
        return True, f"dispatched {workflow_filename}"
    return False, f"GH dispatch {workflow_filename} failed: {status} {payload[:200]}"


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


def _acquire_dispatch_lock(name: str, ttl_seconds: int = 600) -> None:
    """Add a job name to _JOB_RUNNING and schedule auto-release after TTL.

    Used by the HTTP trigger GH-dispatch SUCCESS paths. Before this helper,
    the in-process fallback path was the only one wiring up the lock
    (within _bg_<job>'s finally), so a successful GH dispatch returned
    without ever marking the job as running. Two rapid clicks then fired
    two workflow_dispatch events, FORCE_RUN=true bypassed run_if_stale,
    and the 50-req/day OpenRouter free quota burned twice. Same pattern
    that caused the 42-44 in-process incident, just on the GH side.

    Auto-release matters because GH workflows do not call back; if we
    only added the name, the lock would persist until the next bot
    restart and every subsequent click for the rest of the day would
    409. TTL covers the typical GH workflow runtime (analysis ~5-7 min,
    grader ~1-2 min, sensei ~3-5 min) with headroom. After TTL the lock
    is released and a legitimate retry succeeds.
    """
    import asyncio as _asyncio
    _JOB_RUNNING.add(name)

    async def _release_later():
        try:
            await _asyncio.sleep(ttl_seconds)
        finally:
            _JOB_RUNNING.discard(name)

    task = _asyncio.create_task(_release_later())
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)


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
                        # Bundled /trigger/sync: INDmoney refresh runs
                        # locally (cheap, ~2s), analysis offloads to GH.
                        gh_ok, gh_detail = await _dispatch_github_workflow(
                            "daily_analysis.yml")
                        if gh_ok:
                            _acquire_dispatch_lock("analysis", ttl_seconds=600)
                            result["analysis"] = "queued"
                            result["analysis_via"] = "github"
                        else:
                            print(f"  /trigger/sync analysis dispatch: {gh_detail}; falling back in-process")
                            try:
                                from analyzer.aggregator import run as run_analysis
                                import asyncio as _asyncio

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
                                result["analysis_via"] = "in_process"
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
                or path.startswith("/trigger/paper-eval")
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
                        # Fire GH workflow first; fall back to in-process
                        # when GH_TOKEN/GH_REPO are missing or the
                        # dispatch fails. This is the same pattern as
                        # scheduled_sensei and keeps the Render dyno from
                        # holding pandas + yfinance + the full sensei
                        # synthesis at once.
                        gh_ok, gh_detail = await _dispatch_github_workflow(
                            "sensei_eod.yml",
                            inputs={"analysis_id": aid_int} if aid_int is not None else None,
                        )
                        if gh_ok:
                            _acquire_dispatch_lock("sensei", ttl_seconds=600)
                            out = _json.dumps({
                                "ok": True, "job": "sensei", "status": "queued",
                                "via": "github", "analysis_id": aid_int,
                            }).encode()
                            status_line = b"HTTP/1.1 202 Accepted\r\n"
                        else:
                            print(f"  /trigger/sensei: {gh_detail}; falling back in-process")
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
                                    "via": "in_process", "analysis_id": aid_int,
                                }).encode()
                                status_line = b"HTTP/1.1 202 Accepted\r\n"
                            except Exception as e:
                                _JOB_RUNNING.discard("sensei")
                                out = _json.dumps({"ok": False, "job": "sensei", "error": str(e)}).encode()
                                status_line = b"HTTP/1.1 500 Internal Server Error\r\n"
                elif path.startswith("/trigger/grader"):
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
                    # Try GH workflow_dispatch first; fall back to
                    # in-process when the PAT is missing or the API
                    # rejects the dispatch. Same pattern as scheduled_*.
                    gh_ok, gh_detail = await _dispatch_github_workflow("daily_grader.yml")
                    if gh_ok:
                        _acquire_dispatch_lock("grader", ttl_seconds=600)
                        out = _json.dumps({
                            "ok": True, "job": "grader", "status": "queued",
                            "via": "github", "lookback_days": lookback_int,
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    else:
                        print(f"  /trigger/grader: {gh_detail}; falling back in-process")
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
                                "via": "in_process", "lookback_days": lookback_int,
                            }).encode()
                            status_line = b"HTTP/1.1 202 Accepted\r\n"
                        except Exception as e:
                            _JOB_RUNNING.discard("grader")
                            out = _json.dumps({"ok": False, "job": "grader", "error": str(e)}).encode()
                            status_line = b"HTTP/1.1 500 Internal Server Error\r\n"

                elif path.startswith("/trigger/paper-eval"):
                    # Phase A ad-hoc paper trader trigger. The daily
                    # grader runs the trader as part of its sequence,
                    # so this endpoint exists for dashboard-driven
                    # manual evaluation (re-run after a signal correction,
                    # smoke after a schema change, etc). Same GH-first /
                    # in-process fallback shape as /trigger/grader, but
                    # the in-process branch only runs the paper trader
                    # itself rather than the full grader pipeline so a
                    # manual click is cheap.
                    if "paper-eval" in _JOB_RUNNING:
                        out = _json.dumps({
                            "ok": False, "job": "paper-eval",
                            "status": "already_running",
                        }).encode()
                        status_line = b"HTTP/1.1 409 Conflict\r\n"
                    else:
                        gh_ok, gh_detail = await _dispatch_github_workflow("daily_grader.yml")
                        if gh_ok:
                            _acquire_dispatch_lock("paper-eval", ttl_seconds=600)
                            out = _json.dumps({
                                "ok": True, "job": "paper-eval", "status": "queued",
                                "via": "github",
                            }).encode()
                            status_line = b"HTTP/1.1 202 Accepted\r\n"
                        else:
                            print(f"  /trigger/paper-eval: {gh_detail}; falling back in-process")
                            try:
                                import asyncio as _asyncio
                                from analyzer.paper_trader import run_daily as _paper_run

                                async def _bg_paper():
                                    try:
                                        print("Background paper-eval starting...")
                                        loop = _asyncio.get_event_loop()
                                        await loop.run_in_executor(None, _paper_run)
                                        print("Background paper-eval complete")
                                    except Exception as bgerr:
                                        import traceback
                                        print(f"Background paper-eval failed: {bgerr}")
                                        traceback.print_exc()
                                    finally:
                                        _JOB_RUNNING.discard("paper-eval")

                                _JOB_RUNNING.add("paper-eval")
                                task = _asyncio.create_task(_bg_paper())
                                _BG_TASKS.add(task)
                                task.add_done_callback(_BG_TASKS.discard)
                                out = _json.dumps({
                                    "ok": True, "job": "paper-eval", "status": "queued",
                                    "via": "in_process",
                                }).encode()
                                status_line = b"HTTP/1.1 202 Accepted\r\n"
                            except Exception as e:
                                _JOB_RUNNING.discard("paper-eval")
                                out = _json.dumps({"ok": False, "job": "paper-eval", "error": str(e)}).encode()
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
                    # Dispatch the GH workflow first. It carries its own
                    # FORCE_RUN env (true on workflow_dispatch) so an
                    # ad-hoc trigger bypasses the run_if_stale guard the
                    # scheduled cron uses. Falls back in-process when the
                    # PAT env vars are unset.
                    gh_ok, gh_detail = await _dispatch_github_workflow("daily_analysis.yml")
                    if gh_ok:
                        _acquire_dispatch_lock("analysis", ttl_seconds=600)
                        out = _json.dumps({
                            "ok": True, "job": "analysis", "status": "queued",
                            "via": "github",
                        }).encode()
                        status_line = b"HTTP/1.1 202 Accepted\r\n"
                    else:
                        print(f"  /trigger/analysis: {gh_detail}; falling back in-process")
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
                                "via": "in_process",
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

            # /trigger/stock-analyst: Deep per-ticker LLM analysis with
            # cache. Body: { ticker, horizon_days }. Looks up the most
            # recent (ticker, horizon, today_UTC) row; if ok, returns
            # that run_id without burning quota. Else inserts a fresh
            # pending row, kicks the LLM background job, returns 202.
            # Browser polls stock_analyses by id until status != pending.
            if method == "POST" and path.startswith("/trigger/stock-analyst"):
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

                ticker = (payload.get("ticker") or "").strip().upper()
                if ticker and not ticker.endswith(".NS") and not ticker.endswith(".BO") \
                        and not ticker.startswith("^") and "." not in ticker:
                    ticker += ".NS"
                try:
                    horizon = int(payload.get("horizon_days") or 30)
                except (TypeError, ValueError):
                    horizon = 30
                if horizon not in (30, 90, 180):
                    horizon = 30

                if not ticker:
                    out = _json.dumps({"ok": False, "error": "ticker required"}).encode()
                    status_line = b"HTTP/1.1 400 Bad Request\r\n"
                else:
                    try:
                        import os as _os
                        from supabase import create_client as _create_client
                        from datetime import datetime as _dt, timezone as _tz
                        url = _os.getenv("SUPABASE_URL")
                        key = _os.getenv("SUPABASE_KEY")
                        if not url or not key:
                            raise RuntimeError("Supabase env missing")
                        _sb_local = _create_client(url, key)

                        # Cache lookup: same ticker + horizon + today UTC.
                        # Returns the existing run_id when ok so the
                        # browser polls a finished row, no LLM burn.
                        today = _dt.now(_tz.utc).date().isoformat()
                        cache_hit = _sb_local.table("stock_analyses").select(
                            "id,status"
                        ).eq("ticker", ticker).eq("horizon_days", horizon).eq(
                            "cache_day", today
                        ).eq("status", "ok").order(
                            "requested_at", desc=True
                        ).limit(1).execute().data or []
                        if cache_hit:
                            cached_id = cache_hit[0]["id"]
                            out = _json.dumps({
                                "ok": True, "job": "stock-analyst",
                                "status": "cached", "run_id": cached_id,
                                "ticker": ticker, "horizon_days": horizon,
                                "via": "cache",
                            }).encode()
                            status_line = b"HTTP/1.1 200 OK\r\n"
                        else:
                            # Fresh row + background LLM. Same pattern
                            # as /trigger/calc-explain.
                            ins = _sb_local.table("stock_analyses").insert({
                                "ticker": ticker,
                                "horizon_days": horizon,
                                "status": "pending",
                            }).execute()
                            run_id = (ins.data or [{}])[0].get("id")
                            if run_id is None:
                                raise RuntimeError("insert returned no id")

                            from analyzer.stock_analyst_llm import run as run_analyst
                            import asyncio as _asyncio

                            async def _bg_analyst(rid: int):
                                try:
                                    print(f"Background Stock Analyst starting (run_id={rid})...")
                                    loop = _asyncio.get_event_loop()
                                    await loop.run_in_executor(None, lambda: run_analyst(rid))
                                    print(f"Background Stock Analyst complete (run_id={rid})")
                                except Exception as bgerr:
                                    import traceback
                                    print(f"Background Stock Analyst failed: {bgerr}")
                                    traceback.print_exc()

                            task = _asyncio.create_task(_bg_analyst(run_id))
                            _BG_TASKS.add(task)
                            task.add_done_callback(_BG_TASKS.discard)
                            out = _json.dumps({
                                "ok": True, "job": "stock-analyst",
                                "status": "queued", "run_id": run_id,
                                "ticker": ticker, "horizon_days": horizon,
                                "via": "in_process",
                            }).encode()
                            status_line = b"HTTP/1.1 202 Accepted\r\n"
                    except Exception as e:
                        out = _json.dumps({
                            "ok": False, "job": "stock-analyst",
                            "error": str(e),
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
    """Grader trigger from the bot's APScheduler. Now dispatches the
    daily_grader.yml workflow on GH Actions instead of running the
    grader in-process; pandas + yfinance + the full prediction_scores
    sweep tripped the Render 512 MB ceiling on 12/06/2026. The GH
    workflow's own 17:00 IST cron stays the redundancy layer; the
    grader is idempotent so both writing to accuracy_summary /
    prediction_scores is safe. Falls back to in-process when
    GH_TOKEN/GH_REPO are unset."""
    if "grader" in _JOB_RUNNING:
        print("Scheduled grader: already running, skip")
        return
    print("Scheduled grader: dispatching GH workflow...")
    ok, detail = await _dispatch_github_workflow("daily_grader.yml")
    if ok:
        _acquire_dispatch_lock("grader", ttl_seconds=600)
        print(f"  {detail}")
        return
    print(f"  {detail}; falling back to in-process run")
    import asyncio as _asyncio
    try:
        from analyzer.grader import grade_all, compute_summaries
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, lambda: grade_all(lookback_days=90))
        await loop.run_in_executor(None, compute_summaries)
        print("In-bot scheduled grader complete.")
    except Exception as e:
        print(f"In-bot scheduled grader failed: {e}")


async def scheduled_sensei():
    """Sensei EOD synthesis trigger. Dispatches sensei_eod.yml on GH
    Actions; the workflow self-grades before synthesizing so ordering
    against scheduled_grader is irrelevant. Falls back in-process when
    the GH PAT env vars are missing."""
    if "sensei" in _JOB_RUNNING:
        print("Scheduled Sensei: already running, skip")
        return
    print("Scheduled Sensei: dispatching GH workflow...")
    ok, detail = await _dispatch_github_workflow("sensei_eod.yml")
    if ok:
        _acquire_dispatch_lock("sensei", ttl_seconds=600)
        print(f"  {detail}")
        return
    print(f"  {detail}; falling back to in-process run")
    import asyncio as _asyncio
    try:
        from analyzer.sensei import run as run_sensei
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, lambda: run_sensei(None))
        print("In-bot scheduled Sensei complete.")
    except Exception as e:
        print(f"In-bot scheduled Sensei failed: {e}")


async def scheduled_analysis():
    """PRIMARY 08:30 IST weekday morning analysis. Now fires a GitHub
    Actions workflow_dispatch on daily_analysis.yml instead of running
    the aggregator in-process; the runner builds the payload, calls the
    LLM, saves the row, and pushes Telegram itself (the workflow's
    Push-to-Telegram step gated on outputs.ran). Falls back to the
    in-process path if GH_TOKEN/GH_REPO are unset so the bot still
    works without the GH PAT configured.

    The GH workflow's own scheduled 08:43 IST trigger plus its
    run_if_stale guard keeps double-firing safe: whichever runner
    completes second sees a fresh analysis row and exits without
    burning a second LLM call."""
    if "analysis" in _JOB_RUNNING:
        print("Scheduled analysis: already running, skip")
        return
    _JOB_RUNNING.add("analysis")
    held_for_gh = False
    try:
        print("Scheduled analysis: dispatching GH workflow...")
        ok, detail = await _dispatch_github_workflow("daily_analysis.yml")
        if ok:
            print(f"  {detail}")
            # Promote the lock from "held while dispatch runs" to
            # "held for the full GH workflow runtime" so a same-minute
            # click on /trigger/analysis or the next cron fire cannot
            # queue a duplicate run. The TTL-release helper handles
            # the discard; suppress the finally-clause discard below.
            _acquire_dispatch_lock("analysis", ttl_seconds=600)
            held_for_gh = True
            # GH workflow handles Telegram push itself on completion.
            return
        print(f"  {detail}; falling back to in-process run")
        import asyncio as _asyncio
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
    except Exception as e:
        print(f"Scheduled analysis failed: {e}")
    finally:
        if not held_for_gh:
            _JOB_RUNNING.discard("analysis")


async def _startup_catchup():
    """Self-heal after a restart. Render redeploys on every push (13
    restarts on 10/06/2026 alone) and APScheduler state is in-memory, so
    any cron moment spanned by a restart is silently lost; that is how
    the 17:05 grader and 20:05 Sensei both got skipped while GH's crons
    drifted hours. On boot, check what today (IST, weekday) should have
    already produced and run whatever is missing. Every branch is
    guarded by a freshness probe so repeated restarts do not repeat
    work: analysis at most once per day, grader only while summaries
    predate 17:00, sensei only while today's row is missing or was
    written before grading was possible."""
    import asyncio as _asyncio
    await _asyncio.sleep(45)  # let the dyno settle before heavy work
    try:
        from datetime import datetime, timedelta, timezone as _tz
        ist = datetime.now(_tz.utc) + timedelta(hours=5, minutes=30)
        if ist.weekday() > 4:
            return
        today_ist = ist.date()

        from supabase import create_client as _cc
        url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
        if not url or not key:
            return
        sb = _cc(url, key)

        # --- Morning analysis missing? (past 08:35 IST, none today) ---
        if ist.hour > 8 or (ist.hour == 8 and ist.minute >= 35):
            r = sb.table("analysis").select("run_at").order(
                "run_at", desc=True).limit(1).execute().data or []
            latest_ist = None
            if r:
                latest_ist = (datetime.fromisoformat(
                    r[0]["run_at"].replace("Z", "+00:00"))
                    + timedelta(hours=5, minutes=30)).date()
            if latest_ist != today_ist:
                print("Catch-up: no analysis today, running morning analysis")
                await scheduled_analysis()

        # --- Grader pass missing? (past 17:10 IST, summaries stale) ---
        if (ist.hour, ist.minute) >= (17, 10):
            cutoff = datetime(today_ist.year, today_ist.month, today_ist.day,
                              11, 30, tzinfo=_tz.utc)  # 17:00 IST in UTC
            acc = sb.table("accuracy_summary").select("computed_at").order(
                "computed_at", desc=True).limit(1).execute().data or []
            fresh = acc and datetime.fromisoformat(
                acc[0]["computed_at"].replace("Z", "+00:00")) >= cutoff
            if not fresh:
                print("Catch-up: summaries predate 17:00 IST, running grader")
                await scheduled_grader()

        # --- Sensei missing or pre-grading? (past 20:10 IST) ---
        if (ist.hour, ist.minute) >= (20, 10):
            cutoff = datetime(today_ist.year, today_ist.month, today_ist.day,
                              11, 30, tzinfo=_tz.utc)
            sn = sb.table("sensei_eod").select("market_close_date,run_at").eq(
                "market_close_date", today_ist.isoformat()).limit(1).execute().data or []
            ok = False
            if sn and sn[0].get("run_at"):
                wrote = datetime.fromisoformat(
                    sn[0]["run_at"].replace("Z", "+00:00"))
                ok = wrote >= cutoff
            if not ok:
                print("Catch-up: Sensei row missing or predates grading, rerunning")
                await scheduled_sensei()
    except Exception as e:
        print(f"Startup catch-up failed: {e}")


async def _post_init(app: Application):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    # misfire_grace_time: fire a due job up to an hour late instead of
    # the 1-second default, so a busy loop or slow boot does not drop
    # the day's run. coalesce collapses a missed-pileup into one run.
    scheduler = AsyncIOScheduler(
        timezone="Asia/Kolkata",
        job_defaults={"misfire_grace_time": 3600, "coalesce": True},
    )
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
    # Sensei also self-grades before synthesizing, so even a late fire
    # never produces a data-thin retrospective again.
    scheduler.add_job(scheduled_sensei, CronTrigger(hour=20, minute=5, day_of_week="mon-fri"))
    scheduler.start()
    app.bot_data["scheduler"] = scheduler

    # Startup catch-up: run whatever today's missed cron moments should
    # have produced. Kicked as a background task so boot is not blocked.
    import asyncio as _asyncio
    task = _asyncio.create_task(_startup_catchup())
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)

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

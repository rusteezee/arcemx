# Arc'emX!

Zero-cost AI stock market predictor for Indian markets. Telegram bot + Next.js dashboard, powered by OpenRouter.

> **Disclaimer:** Not SEBI-registered investment advice. Educational only. Always DYOR.

## Stack

- **Data:** yfinance, RSS feeds, GNews, PRAW (Reddit)
- **Brain:** OpenRouter free-tier models (nvidia/nemotron-3-super-120b-a12b:free primary)
- **Storage:** Supabase Postgres (free)
- **Bot:** python-telegram-bot
- **Dashboard:** Next.js (Netlify free)
- **Cron:** GitHub Actions (free)

## Setup (one-time)

### 1. Local Python env

```bash
cd stock-ai
python -m venv .venv
.venv\Scripts\activate    # Windows
pip install -r requirements.txt
copy .env.example .env
```

Fill `.env` with your keys.

### 2. Get API keys (all free)

| Service | Where | What to grab |
|---|---|---|
| OpenRouter | https://openrouter.ai/keys | API key |
| Supabase | https://supabase.com → new project | Project URL + anon public key |
| Telegram | Open Telegram → message `@BotFather` → `/newbot` | Bot token |
| Telegram chat ID | Run bot, send `/start`, copy ID from reply | Numeric chat ID |
| GNews (optional) | https://gnews.io → free signup | API key (100/day) |
| Reddit (optional) | https://www.reddit.com/prefs/apps → create app (script type) | client id + secret |

### 3. Setup Supabase DB

Supabase Dashboard → SQL Editor → paste contents of `db/schema.sql` → Run.

### 4. Test locally

```bash
# Fetch prices once
python -m fetchers.prices

# Fetch news once
python -m fetchers.news

# Run full analysis (uses OpenRouter quota)
python -m analyzer.aggregator

# Start bot (Ctrl+C to stop)
python -m bot.telegram_bot
```

In Telegram, message your bot: `/start`. Copy the chat ID it shows into `.env` → `TELEGRAM_CHAT_ID`.

Test push:
```bash
python -m bot.daily_push
```

### 5. Deploy

#### A) Push code to GitHub

```bash
cd stock-ai
git init
git add .
git commit -m "init"
gh repo create arcemx --private --source=. --push
```

(or via github.com → new repo → follow instructions)

#### B) Configure GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret. Add each:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `GNEWS_API_KEY` (optional)
- `REDDIT_CLIENT_ID` (optional)
- `REDDIT_CLIENT_SECRET` (optional)
- `REDDIT_USER_AGENT` (optional)

Workflows in `.github/workflows/` will now run on schedule.

Manually trigger first run: Actions tab → "Daily Market Analysis" → Run workflow.

#### C) Deploy bot 24×7

GitHub Actions only runs the cron push, but the bot needs to be live to respond to `/today`, `/portfolio` etc.

**Option 1: Oracle Cloud Always Free (primary, recommended)** - an ARM VM under systemd, $0 recurring, no sleep/idle behavior like Render free.

1. **[USER]** Sign up at oracle.com/cloud/free with a real credit card, home region Singapore (`ap-singapore-1`). Signup friction from India is real ("Error Processing Transaction" is common) - retry with a different card/day if it happens.
2. **[USER]** Convert the tenancy to Pay-As-You-Go (Billing → Upgrade). This exempts the instance from Always Free's idle-reclaim policy (reclaimed when 7-day p95 CPU/network/memory are all under 20%, which the bot's idle load easily triggers) while staying $0 as long as usage stays inside the Always Free shapes.
3. **[USER]** Create instance: `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 24.04 ARM, 47GB boot volume. Reserve a public IP and attach it (reserved IPs persist across instance rebuilds). Open ingress 80/443/22 in the VCN security list. Save the SSH key.
4. SSH in, then: `git clone https://github.com/rusteezee/arcemx.git /tmp/arcemx-bootstrap && sudo bash /tmp/arcemx-bootstrap/deploy/oracle/setup.sh` (or just clone anywhere and run `deploy/oracle/setup.sh` - it clones its own copy to `/opt/arcemx`).
5. **[USER]** Fill in `/etc/arcemx.env` with the real values (same 10 vars as Render's env, see `deploy/oracle/arcemx.env.template` for the exact list), then `sudo systemctl restart arcemx-bot`.
6. Verify: `curl http://<reserved-ip>/health` returns `OK`, `/today` answers in Telegram, `journalctl -u arcemx-bot -f` shows the APScheduler jobs registering.
7. **[USER]** Cutover: update Netlify env `ARCEMX_BOT_URL` to `http://<reserved-ip>` (both deploy contexts - watch for the greyed-out "same value" UI quirk), redeploy the dashboard, verify a dashboard-triggered sync works end-to-end. Then suspend (don't delete) the Render service for ~2 weeks before retiring it for good.

Recovery doctrine: the box holds **zero unique state** - Supabase has all data, GitHub has all code including this deploy script, INDmoney tokens live in Supabase's `mcp_tokens` table. A destroyed/reclaimed instance is a fresh `setup.sh` run plus refilling `/etc/arcemx.env`, not a disaster.

If Oracle signup fails outright (capacity errors, persistent card rejection): **Hetzner CAX11** (~₹500/mo ARM) is the paid fallback - same `deploy/oracle/` scripts work on any Ubuntu 24.04 box, Oracle-specific only in name.

**Option 2: Render free** (sleeps after 15 min idle but wakes on Telegram poll; forced onto a legacy plan with a 5GB/month bandwidth cap 1 Aug 2026)
- render.com → New Web Service → connect GitHub repo
- Build: `pip install -r requirements.txt`
- Start: `python -m bot.telegram_bot`
- Add same env vars in Render dashboard

**Option 3: Local PC**. just run `python -m bot.telegram_bot` whenever you want it on.

#### D) Deploy dashboard

- Netlify → New site → connect GitHub repo, base dir `web/`
- Add env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_KEY`, `SUPABASE_URL`, `GH_TOKEN`, `GH_REPO`
- Custom domain: point CNAME at the Netlify site, add it in Netlify's domain settings

## Importing portfolio from INDmoney

### Recommended: MCP auto-sync (OAuth)

INDmoney offers a remote MCP server at `https://mcp.indmoney.com/mcp`. We connect to it via OAuth. same flow Claude.ai uses.

**One-time auth (on your PC):**
```powershell
.venv\Scripts\activate
python -m fetchers.indmoney_auth
```
Browser opens → log in to INDmoney → "Allow" → done. Tokens saved to `.indmoney_tokens.json` (gitignored, never leaves your PC).

**Manual sync from Telegram:**
```
/sync
```
Pulls all holdings + watchlist into Supabase. Bot's `/portfolio` + `/wishlist` now show INDmoney data.

**Auto sync:** APScheduler in `bot/telegram_bot.py` runs sync daily at 8:00 AM IST (before 8:30 AM analysis cron). Only works while bot process is alive. so this requires the bot running on Render (Step C in deploy).

**Auth re-do**: if `/sync` fails with auth error → re-run `python -m fetchers.indmoney_auth` on the host where bot runs.

### Fallback: CSV import (no MCP)

1. INDmoney app → **Holdings** → 3-dots → **Export to email**
2. Open CSV, keep columns `ticker,qty,avg_buy_price`
3. Telegram bot → `/import` → attach CSV

### Fallback: manual commands
```
/buy RELIANCE 2450.50 10
/buy TCS 3800 5
/add_wish HDFCBANK
```

### MCP on Render deploy

Render filesystem is ephemeral on free tier. token file disappears on restart. Two options:

**Option 1 (simplest)**: Use Render paid tier ($7/mo) with persistent disk. Or use Fly.io free with volume.

**Option 2 (free)**: Store tokens in Supabase instead of file. Modify `FileTokenStorage` in `fetchers/indmoney_mcp.py` to `SupabaseTokenStorage`. Tell the bot dev (me) → I'll write it when you hit this.

**Option 3 (manual)**: Run `/sync` from Telegram once a day yourself. No persistence needed if you re-auth weekly.

Start with Option 3. Move to Option 2 once habits form.

## Real-order execution (INDstocks)

Staged design, off by default. `INDSTOCKS_EXEC_MODE`:
- `off` (default): fully inert, no proposals, no orders.
- `confirm`: every fresh open long paper trade produces a Telegram message
  with Execute / Skip buttons. An order fires only when you tap Execute.
- `auto`: not implemented. Locked behind the Phase B Tier-1 + DSR gate
  (see ROADMAP.md); setting this env var falls back to `off` at boot with
  a log line naming the gate.

**Daily token routine**: access tokens expire every ~24h and can only be
generated manually. Go to indstocks.com/app/api-trading, generate a token,
then send `/token_ind YOURTOKEN` to the bot. The message is auto-deleted
right after storing so the token never sits in chat history. If the token
goes stale (>20h) while execution is on, the bot warns you at 08:15 IST.

**IP note**: if the API rejects calls from the bot host, whitelist the
host's static IP on the portal's Access Tokens page.

**Caps**: `INDSTOCKS_MAX_ORDER_INR` (default 5000) per-order notional cap,
`INDSTOCKS_MAX_DAILY_ORDERS` (default 3) daily placed-order cap. Both
enforced before every order, not just at proposal time.

**Controls**: `/exec_status` (mode, token age, halted flag, orders today,
funds), `/halt` (immediately stop proposing/executing), `/resume` (re-arm).

₹5 flat brokerage per order. Not SEBI-registered advice; this applies
doubly to real orders placed through this feature - you are responsible
for every trade your thumb confirms.

## LoRA specialist fine-tune (blueprint 13)

A small model fine-tuned on arcemx's own graded prediction history,
run beside the live LLM chain as an advisory second opinion - it never
influences a live pick. Promotion to "counts for something" only
happens if its 30-day accuracy beats the live chain on 2+ dimensions,
and that call is yours, documented in ROADMAP.md, never automated.
Gated on 3,000 `prediction_scores` rows before the first run (cleared
2026-07-26).

**Monthly loop, run by hand:**
1. `python -m analyzer.finetune_export` - writes `data/finetune/train.jsonl` + `eval.jsonl` (gitignored; repo is public, these never get committed)
2. Upload both files as a **Kaggle private dataset**
3. Open `notebooks/arcemx_lora_kaggle.ipynb` on Kaggle, attach that dataset, set a GPU accelerator (T4 x2 or P100), run all cells (~1-3h)
4. Download the exported `.gguf` from the notebook's Output tab
5. Attach it to a new GitHub Release (tag it e.g. `specialist-v1`)
6. Dispatch `.github/workflows/specialist_eval.yml` with that release tag + a `model_slug` (e.g. `specialist-v1`), and set the repo variables so the weekly schedule (Sat 08:30 IST) knows what to run without you dispatching it every time: `gh variable set SPECIALIST_RELEASE_TAG --body specialist-v1` and `gh variable set SPECIALIST_MODEL_SLUG --body specialist-v1`
7. Compare `specialist-v{n}` against the live chain on the accuracy dashboard after ~2-4 weeks of scoring

No always-on serving exists for this model (researched: no viable free
path) - it only ever runs as a scheduled/dispatched CPU batch job via
llama.cpp on GitHub Actions.

## Commands

| Command | Purpose |
|---|---|
| `/today` | Latest LLM market call |
| `/nifty` `/sensex` | Index snapshot |
| `/stock TICKER` | Single stock view |
| `/portfolio` | Holdings + live P&L |
| `/wishlist` | Watchlist with prices |
| `/buy TICKER PRICE QTY` | Add holding |
| `/sell TICKER` | Remove holding |
| `/add_wish TICKER` `/rm_wish TICKER` | Manage wishlist |
| `/alert TICKER PRICE above\|below` | Set a price alert |
| `/alerts` `/rm_alert ID` | List / cancel alerts |
| `/import` | Upload CSV |
| `/sync` | Pull holdings + watchlist from INDmoney |
| `/trade` | Paper-trader status + tier gate |
| `/backtest` | Latest full-history replay result |
| `/token_ind TOKEN` | Store today's INDstocks access token (auto-deletes) |
| `/exec_status` | Real-order execution mode, token age, caps, funds |
| `/halt` `/resume` | Stop / re-arm real-order execution |
| `/real_open` | List open real positions (with ids for /close_order) |
| `/close_order ID` | Cancel the pending stop/target and exit a real position now (confirm button) |

## How the analysis works

1. **Technical screener** (`analyzer/technical.py`). pulls 1yr OHLCV for full universe, computes RSI/MACD/MAs/Bollinger, scores each stock, picks top 15 bullish + 15 bearish. This avoids dumping 500 stocks into the LLM (token cost + rate limit).
2. **News + reddit**. collected fresh.
3. **OpenRouter call**. single big prompt with technical shortlist + news headlines + Reddit hot. Returns structured JSON.
4. **Save → push**. Supabase row + Telegram message.

## Limits / gotchas

- **OpenRouter free**: 20 req/min; 50/day under $10 lifetime credit, 1000/day above it. Daily run = a few calls. Fine.
- **yfinance**: Yahoo can rate-limit if you hammer. Batch downloads only.
- **GitHub Actions**: 2000 min/month free. Hourly news + daily analysis ≈ 100 min/month. Fine.
- **Supabase free**: 500 MB DB, 50k rows/month writes. Plenty.
- **Markets closed days**: yfinance returns last close. `analyzer/market_calendar.is_trading_day()` skips weekends + NSE holidays (see `data/nse_holidays_2026.json`) for the morning analysis and grader crons.
- **WhatsApp**: skipped. Meta charges after free trial. Telegram is the cheap path.

## Roadmap

### v1 (current). India equity
- NSE/BSE stocks (NIFTY 50 + universe + your portfolio + wishlist)
- Daily AI market call (mood, picks, verdicts)
- Telegram bot + Next.js dashboard
- INDmoney MCP sync (Indian holdings + watchlist)

### v2. US + global equity
- US stocks (AAPL, NVDA etc) from INDmoney US portfolio
- Global indices (S&P, Nasdaq, FTSE, Nikkei) deeper integration
- Cross-market correlation signals
- Forex (USD/INR) signal

### v3. multi-asset
- Mutual funds (via INDmoney MF MCP tools. `get_mf_funds_details`, SIPs)
- Bonds + FD comparison
- Gold/silver (commodities)
- Crypto (via INDmoney `CRYPTO` asset_type)
- Net worth across asset classes (use `networth_snapshot` MCP tool)

### v4. automation + polish
- Sector heatmap on dashboard
- F&O / options chain signals (MCP `get_indian_stocks_option_chain` available)
- WhatsApp via paid Twilio if user demand high

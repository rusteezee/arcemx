# Arc'emX!

Zero-cost AI stock market predictor for Indian markets. Telegram bot + Streamlit dashboard, powered by Gemini.

> **Disclaimer:** Not SEBI-registered investment advice. Educational only. Always DYOR.

## Stack

- **Data:** yfinance, RSS feeds, GNews, pytrends, PRAW (Reddit)
- **Brain:** Google Gemini 2.0 Flash (free tier)
- **Storage:** Supabase Postgres (free)
- **Bot:** python-telegram-bot
- **Dashboard:** Streamlit (free Cloud)
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
| Gemini | https://aistudio.google.com/apikey | API key |
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

# Run full analysis (uses Gemini quota)
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

GitHub Actions only runs the cron push, but the bot needs to be live to respond to `/today`, `/portfolio` etc. Pick one:

**Option 1: Render free** (sleeps after 15 min idle but wakes on Telegram poll)
- render.com → New Web Service → connect GitHub repo
- Build: `pip install -r requirements.txt`
- Start: `python -m bot.telegram_bot`
- Add same env vars in Render dashboard

**Option 2: Local PC**. just run `python -m bot.telegram_bot` whenever you want it on.

**Option 3: Fly.io free tier**. better uptime than Render free.

#### D) Deploy dashboard

- share.streamlit.io → New app → pick repo → `dashboard/streamlit_app.py`
- Advanced settings → add secrets (paste contents of .env in TOML format):
  ```
  SUPABASE_URL = "https://..."
  SUPABASE_KEY = "..."
  ```

#### E) Custom domain (you own one)

Streamlit free tier does NOT support custom domains. Options:
- Use the `*.streamlit.app` URL
- v2: rebuild dashboard as Next.js → deploy to Cloudflare Pages free → point your domain via CNAME

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
| `/import` | Upload CSV |

## How the analysis works

1. **Technical screener** (`analyzer/technical.py`). pulls 1yr OHLCV for full universe, computes RSI/MACD/MAs/Bollinger, scores each stock, picks top 15 bullish + 15 bearish. This avoids dumping 500 stocks into Gemini (token cost + rate limit).
2. **News + trends + reddit**. collected fresh.
3. **Gemini call**. single big prompt with technical shortlist + news headlines + trend scores + Reddit hot. Returns structured JSON.
4. **Save → push**. Supabase row + Telegram message.

## Limits / gotchas

- **Gemini free**: 15 req/min, 1500/day for Flash. Daily run = ~2 calls. Fine.
- **yfinance**: Yahoo can rate-limit if you hammer. Batch downloads only.
- **GitHub Actions**: 2000 min/month free. Hourly news + daily analysis ≈ 100 min/month. Fine.
- **Streamlit free**: 1 GB RAM, sleeps after inactivity, wakes on visit.
- **Supabase free**: 500 MB DB, 50k rows/month writes. Plenty.
- **Markets closed days**: yfinance returns last close. Indian holidays handled by skipping weekday-only Mon-Fri cron. extend to skip NSE holidays manually if needed.
- **WhatsApp**: skipped. Meta charges after free trial. Telegram is the cheap path.

## Roadmap

### v1 (current). India equity
- NSE/BSE stocks (NIFTY 50 + universe + your portfolio + wishlist)
- Daily AI market call (mood, picks, verdicts)
- Telegram bot + Streamlit dashboard
- INDmoney MCP sync (Indian holdings + watchlist)

### v2. US + global equity
- US stocks (AAPL, NVDA etc) from INDmoney US portfolio
- Global indices (S&P, Nasdaq, FTSE, Nikkei) deeper integration
- Cross-market correlation signals
- Forex (USD/INR) signal
- Backtest module. replay past LLM calls vs actuals

### v3. multi-asset
- Mutual funds (via INDmoney MF MCP tools. `get_mf_funds_details`, SIPs)
- Bonds + FD comparison
- Gold/silver (commodities)
- Crypto (via INDmoney `CRYPTO` asset_type)
- Net worth across asset classes (use `networth_snapshot` MCP tool)

### v4. automation + polish
- Per-stock alert thresholds (`/alert TICKER 2500 above`)
- Sector heatmap on dashboard
- Replace Streamlit with Next.js (custom domain support)
- F&O / options chain signals (MCP `get_indian_stocks_option_chain` available)
- WhatsApp via paid Twilio if user demand high

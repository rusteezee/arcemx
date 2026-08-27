# Arc'emX! Knowledge Base

Living document. Any LLM (or human) opening this repo cold should read this file
first and know everything needed to keep working without re-deriving context.

**Update rule:** whenever you (LLM or human) ship a change, fix a bug, flip a
gate, change a doctrine, or learn something non-obvious - update this file in
the same session. Stale sections here are worse than no section; keep it
truthful against live code, not against what was once planned. Cross-check
against `ROADMAP.md` (wave/gate status) and `AGENTS.md` (binding style rules)
- this file is the narrative + architecture layer, those two are the
authoritative status/rules layer.

Last verified against live code: 2026-08-27 (full health audit - see §24).

---

## 1. What this project is

Zero-cost, personal (not multi-user), research-grade AI stock market predictor
for Indian equity markets. Telegram bot + Next.js dashboard, powered by
OpenRouter free-tier LLMs. Not SEBI-registered investment advice - educational
only.

**North star:** Sharpe > 2.0, max DD < 8%, PSR > 0.995 (Phase B, not rushed).
**Tier 1 gate to unlock Phase B:** Sharpe > 1.0, DD < 15%, PSR > 0.95 on live
paper trades, **plus DSR >= 0.90**.
**Hard rule:** ₹0 recurring cost. One-time spends are flagged decisions, never
assumptions.

Everything routes through one number: **closed paper trades.** Sharpe/PSR/tier
gates, Kelly activation (60 trades), calibration quality, and the LoRA dataset
all scale with it. As of 2026-08-16: **27/60 closed paper trades.**

## 2. Stack

- **Data:** yfinance, RSS feeds, GNews, PRAW (Reddit), INDmoney MCP (OAuth,
  real portfolio/watchlist), INDstocks API (real-order execution)
- **Brain:** OpenRouter free tier only - `minimax/minimax-m3:free` primary,
  `nvidia/nemotron-3-super-120b-a12b:free` sole fallback (swapped 2026-08-27
  after a real bake-off; see §5 and §21 - Gemini/Groq escalation and the
  gpt-oss-120b/20b fallback pair were removed the same day, so there is
  now nothing to escalate to if both fail in the same call)
- **Storage:** Supabase Postgres (free tier, RLS-locked)
- **Bot:** python-telegram-bot, deployed on Render free tier (Oracle Cloud
  migration investigated and deliberately deprioritized - see §8)
- **Dashboard:** Next.js, deployed on Netlify free tier
- **Marketing site:** separate Next.js app, also Netlify
- **Cron:** GitHub Actions (heavy compute) dispatched reliably by a Cloudflare
  Worker (GH's native `schedule:` cron drifts/skips on free tier)

## 3. Architecture pattern (repeats everywhere)

Render (bot process) does **light scheduling only**. Heavy compute (daily
analysis, grading, backtest, LoRA eval, calculator/portfolio-score explains)
all runs on **GitHub Actions runners**, triggered by:
1. Cloudflare Worker `cron-dispatcher` hitting `workflow_dispatch` (primary,
   reliable clock)
2. The bot's own APScheduler (secondary, only works while bot process alive)
3. Web dashboard API routes (`web/app/api/*`) for on-demand jobs

All triggers are defensively idempotent against double-firing
(`analyzer.aggregator.run_if_stale()` is the shared gate). This pattern exists
because in-process fan-out OOM'd the Render dyno (512MB free tier) on
2026-06-12, and a Render pipeline-minutes blackout (2026-06-26 to 2026-07-11)
silently killed on-demand features when they ran in-process.

## 4. Daily cycle (IST)

| Time | Job | Trigger |
|---|---|---|
| ~08:20 / 08:43 (dual cron) | `daily_analysis.yml` - morning LLM call | Cloudflare dispatcher |
| 07:55 | `daily_sync.yml` - INDmoney holdings/watchlist sync | GH cron (redundant w/ bot's own 08:00 sync, harmless) |
| every hour | `hourly_news.yml` | GH cron |
| every 15 min (NSE hours) | `alerts_checker.yml` | GH cron |
| 17:00 | `daily_grader.yml` - scores prior predictions vs realized outcome | Cloudflare dispatcher |
| 20:11 (deliberately off :00/:30) | `sensei_eod.yml` - EOD retrospective | Cloudflare dispatcher |
| 22:00 | `daily_prices.yml` - EOD OHLCV fetch | GH cron |
| Sat 08:30 | `specialist_eval.yml` - weekly LoRA specialist grading | GH cron |

`backtest.yml`, `calculator.yml`, `portfolio_score.yml`, `stock_analyst.yml`
are `workflow_dispatch`-only, fired by web dashboard actions.

## 5. Core analysis pipeline

1. **`analyzer/technical.py`** - pulls 1yr OHLCV for full NIFTY 500 universe
   (75-ticker batches, partial-failure tolerant), computes RSI/MACD/
   Bollinger/ATR/SMA20/50/200, support/resistance (20d), ATR-derived expected
   daily move. `rank_candidates()` picks top 15 bullish + 15 bearish
   (bearish list requires genuine breakdown signals, not just "not bullish").
2. **`analyzer/aggregator.py`** (`build_payload`) - assembles the full LLM
   prompt: technical screen, per-ticker fundamentals (~24 fields via
   yfinance `.info`, 24h-cached in Supabase `ticker_enrichment` to survive
   Render's 512MB cap, worker pool capped at 3), earnings calendar, per-ticker
   news, news digest (dedup+materiality ranked), Reddit hot, FII/DII flows,
   NIFTY options-chain signals, market context, prior day's call, and
   **`sensei_yesterday`** (EOD retrospective feeding a self-correction loop).
   Filters non-NSE tickers before they reach the LLM.
3. **`analyzer/llm_router.py`** - OpenRouter client. Handles 429 cooldowns,
   JSON-fence stripping, retry/backoff, and (added 2026-08-15)
   `_response_degenerate()` detection - catches a 4th failure mode where
   output is syntactically valid JSON but semantically degenerate (e.g. every
   ticker given the identical call). Chain as of 2026-08-27 (later same day):
   minimax/minimax-m3:free primary -> nemotron-3-super sole fallback,
   OpenRouter only (Gemini/Groq escalation and the gpt-oss-120b/20b pair
   were removed - see §21). Primary/fallback order was swapped from the
   original nemotron-primary setup after a real bake-off (§21) showed
   minimax winning on speed, reliability, and output quality on this
   project's actual payload. `_content_reject_reason()` (commit `78ff458`)
   logs the specific cause of a rejected response (error_field / no_choices
   / empty_content:finish=X / json_parse_failed / empty_dict /
   degenerate_output) instead of a generic "unusable" bucket - this is what
   caught nemotron's own degenerate_output failure live during the bake-off.
4. **Save -> push** - Supabase `analysis` row + Telegram message
   (`bot/daily_push.py`, which strips Markdown special chars from LLM free
   text after a real prod outage from unescaped `_*\``).
5. **`analyzer/grader.py`** (17:00) - scores 12 prediction dimensions
   (direction/range/mood/picks/verdicts/wishlist) against realized yfinance
   outcomes, session-anchored.
6. **`analyzer/sensei.py`** (20:11) - EOD retrospective using an Ultra-class
   reasoning model (different from the morning Super primary), reads
   `prediction_scores` only (never invents scores), writes `sensei_eod` which
   next morning's aggregator reads back as `sensei_yesterday`.

## 6. Paper trading engine (the critical path)

**`analyzer/paper_trader.py`** (Phase A simulated trading, ~1774 lines).

Gate stack, ordered cheapest-first:
idempotency -> circuit breaker -> rating=buy -> edge present -> confidence>=55
-> not already open -> ticker not frozen (3 losses/90d -> 30d freeze) ->
intent price valid -> volatility-scaled geometry -> edge>=1.5% -> regime gate
(blueprint 03) -> earnings blackout (+-3 sessions, blueprint 07) -> liquidity
(>=1cr 20d turnover) -> sector cap (max 2, blueprint 12's sibling fix).

**Sizing:** fixed 2% portfolio risk. Half-Kelly (blueprint 09) is fully
designed but **not yet implemented** - gated on 60 closed trades, currently
27/60.

**Friction model:** cap-tier spread (5/12/25bps), sqrt market-impact (capped
150bps), STT/exchange/SEBI/GST.

**Signal sources:** `stock_analyst` (deep single-stock calls),
`top_performer`/`worst_performer` (independent long/short picks - shorts
tagged "idealized" since real Indian retail can't short delivery),
`holding_outlook_1d`/`wishlist_outlook_1d`.

**Drawdown circuit breaker:** trips at 8% DD, re-arms at 4%. Owner-only
Telegram alert on trip/re-arm.

### The geometry bug (fixed 2026-08-15) - important history
Paper trader entry geometry had a fundamental negative-EV bug: target/stop
came straight from the LLM's freehand price picks with zero volatility
validation (mean target 3.80σ - near unreachable; mean stop 1.67σ - frequent).
Stops were ~28x more likely to hit than targets. **Fixed** with De Prado's
triple-barrier method (`analyzer/geometry.py`, volatility-scaled, sqrt-time):
entry price/side still trusted from LLM, but target/stop reconstructed from
realized volatility, fixed 1.5:1.0 PT:SL ratio. `breakeven_win_rate()` = 40%
at that ratio.

Official post-fix backtest (`backtest_runs` id=5): 64 trades, win rate 20.31%,
**Sharpe -14.1, PSR 0, DSR 0**. Geometry is fixed; the LLM's own directional
accuracy is now the sole remaining blocker to Tier-1 - no infra or math
problem left to fix here, just needs more honest live sample.

**`analyzer/backtest.py`** - full historical replay of the same gate stack via
`HistCache` (no-lookahead-safe yfinance slicing) + in-memory `ShadowBook`,
never touches live tables. Computes Sharpe/Calmar/PSR/DSR/PBO (deflated
Sharpe + probability of backtest overfitting - blueprint 10 "honesty layer").

**`analyzer/skip_attribution.py`** (blueprint 12) - retro-scores *skipped*
signals via the same ShadowBook, answers "what would this skip have earned."
Caveats independent-fill bias.

**`analyzer/calibration.py`** - Platt scaling (stdlib Newton-Raphson)
recalibrates stated LLM confidence -> real hit-rate. Requires >=80 pairs, else
falls back to legacy bias-debit. Isotonic recalibration parked until
~1000+ pairs.

**`analyzer/regime.py`** - 3 cheap indicators (NIFTY 200DMA trend, India VIX
band, realized-vol percentile), not an HMM regime model (deliberate small-N
choice, HMM parked as decorative at current sample size). Fail-open on data
errors.

**`analyzer/market_calendar.py`** - static yearly NSE holiday JSON
(`data/nse_holidays_2026.json`), needs manual annual update.

## 7. LoRA specialist (blueprint 13)

Small model fine-tuned on arcemx's own graded prediction history, runs beside
the live LLM chain as an advisory second opinion - **never influences a live
pick**. Promotion only happens if 30-day accuracy beats the live chain on 2+
dimensions, and that call is manual/documented, never automated.

- Gate: 3,000 `prediction_scores` rows - cleared 2026-07-26.
- **v1**: shipped, found unusable (degenerate output, schema-placeholder
  echo - ~139 training examples/dim was too few for a 3B model regardless of
  hyperparameters).
- **v2**: trained + shipped 2026-08-16 as GitHub Release `specialist-v2`.
  Merged live+historical data (~1,330 examples/dim, ~12x v1), dropped
  `top_performer_1d` entirely (Pearson r=0.0254 vs realized outcome - no
  measurable skill, gated off by the calibration system). Passed local
  inference sanity check (no degenerate output, unlike v1). Advisory-only
  clock started 2026-08-16, needs 14+ days live comparison.

No always-on serving exists (researched: no viable free path) - runs only as
a scheduled/dispatched CPU batch job via llama.cpp on GitHub Actions
(`specialist_eval.yml`, weekly Sat 08:30 IST).

**Outage + fix (2026-08-27):** this workflow silently failed every run from
2026-08-22 onward (would have missed the 08-29 scheduled run too) - found
during a full health audit, root cause and fix in §21, audit detail in §24.
Fixed and verified live in commit `2d1b5aa`, confirmed via a manual test
dispatch (`gh run` id `33093152133`, resolved tag `b10655`, success).

Monthly retrain loop is manual (see README.md "LoRA specialist fine-tune" for
the exact 7-step routine: export -> Kaggle dataset -> Kaggle notebook ->
download GGUF -> GitHub Release -> dispatch eval workflow -> compare).

## 8. Deployment / infra

- **Bot host:** migrating Render -> Oracle Cloud Always Free, **started
  2026-08-19**. Original 2026-08-15 call to deprioritize this (real bandwidth
  usage ~1.6% of Render's cap, not urgent) was reversed once the user's
  Oracle signup friction (the real blocker, card rejection issues from India)
  resolved itself - user now holds a live Always Free account. Deciding
  factor for moving now: bot responsiveness. Render's sleep-after-15min-idle
  matters more today than it did in July, because INDstocks confirm-mode
  buttons (real money, blueprint 19) benefit from an always-on bot rather
  than one waking on Telegram poll.
  `deploy/oracle/setup.sh` is idempotent, installs python3.11 pinned via
  deadsnakes PPA (matches GH Actions, not OS default 3.12), Caddy, systemd
  units. Recovery doctrine: the box holds **zero unique state** - Supabase
  has all data, GitHub has all code, INDmoney tokens live in Supabase
  `mcp_tokens`. A destroyed instance is just a fresh `setup.sh` run +
  refilled `/etc/arcemx.env`.
  **Migration steps** (see README.md "Deploy bot 24x7 -> Option 1" for full
  detail): convert Oracle tenancy to Pay-As-You-Go (still ₹0 inside Always
  Free shapes, exempts from 7-day idle-reclaim) -> create
  `VM.Standard.A1.Flex` 2 OCPU/12GB Ubuntu 24.04 ARM instance, reserved
  public IP, ingress 80/443/22 open -> SSH in, run `setup.sh` -> fill
  `/etc/arcemx.env` (same 10 vars as Render) -> restart `arcemx-bot` ->
  verify `/health`, `/today`, `journalctl -u arcemx-bot -f` -> cutover
  Netlify's `ARCEMX_BOT_URL` to the reserved IP in both deploy contexts,
  redeploy dashboard, verify a dashboard-triggered sync works end-to-end ->
  suspend (don't delete) Render for ~2 weeks before retiring it.
  **Once cutover is verified, update this section to say "live on Oracle"
  and remove the Render fallback framing.**
- **Dashboard host:** Netlify, base dir `web/`.
- **Marketing site host:** Netlify, separate app in `marketing/`.
- **`cloudflare/cron-dispatcher/`** - single-purpose Cloudflare Worker
  (`src/index.js`). No analysis logic itself - maps 3 cron patterns to
  `workflow_dispatch` POSTs (`daily_analysis.yml`, `daily_grader.yml`,
  `sensei_eod.yml`) at `ref: master`, because GH Actions' own cron drifted
  3-4h late or skipped entire days on free tier. Also exposes a manual
  `GET /dispatch/<workflow>.yml` test hook (same `GH_TOKEN` secret).

## 9. Security (shipped 2026-08-15/16)

An audit found the dashboard **fully public with no auth**, and RLS granting
the public anon key unrestricted read on ~19 tables regardless of any login
screen. Fixed:
- Owner-only auth wall: `web/proxy.ts` (Next.js middleware), Google + password
  via Supabase Auth. Uses `getClaims()` deliberately, not `getSession()`
  (session read skips JWT re-verification). Single allowed owner email
  (`ALLOWED_OWNER_EMAIL`), case-insensitive match. Public paths: `/login`,
  `/auth/callback`, manifest, service worker, icons. Everything else
  redirects to `/login` (401 for `/api/*`).
- RLS rewritten to `authenticated` + `auth.uid()`-scoped across all tables
  (real UUID kept out of the public repo, applied manually in Supabase).
- Real CSP / security headers added.
- `next` bumped 16.2.7 -> 16.3.1 (0 vulnerabilities, was 4 high).

Separately, the **Telegram bot had a critical unrelated gap**: zero
caller-identity check on any command, including `/halt /resume /real_open
/close_order` which act on global/live-execution state. Fixed with a single
`_owner_only_guard` (commit `2911377`) - a `group=-1` handler registered
ahead of everything, silently drops (`ApplicationHandlerStop`, no reply) any
message from a Telegram user_id != `TELEGRAM_CHAT_ID`.

## 10. Real-order execution (INDstocks, blueprint 19)

Staged design, **off by default**, env `INDSTOCKS_EXEC_MODE`:
- `off` (default): fully inert.
- `confirm`: every fresh open long paper trade produces a Telegram message
  with Execute/Skip buttons; order fires only on tap.
- `auto`: **not implemented** - locked behind Phase B Tier-1 + DSR gate;
  setting this env var falls back to `off` at boot with a log line naming the
  gate.

Daily token routine: INDstocks access tokens expire ~24h, generated manually
at indstocks.com/app/api-trading, sent via `/token_ind YOURTOKEN` (bot
auto-deletes the message right after storing). Bot warns at 08:15 IST if
token is stale (>20h) while execution is on.

Caps (enforced before every order, not just at proposal time):
`INDSTOCKS_MAX_ORDER_INR` (default 5000), `INDSTOCKS_MAX_DAILY_ORDERS`
(default 3). Controls: `/exec_status`, `/halt`, `/resume`. ₹5 flat brokerage
per order. As of 2026-08-16: Stage 3 auto-execution doesn't exist and no real
orders have been manually confirmed either - ₹0 incurred so far.

## 11. INDmoney integration

- **MCP auto-sync (recommended):** OAuth 2.1 against `https://mcp.indmoney.com/mcp`
  (`fetchers/indmoney_auth.py`, `fetchers/indmoney_mcp.py`), same flow as
  claude.ai. One-time local auth writes `.indmoney_tokens.json` (gitignored).
  Token storage is pluggable - Supabase `mcp_tokens` table is primary
  (survives Render's ephemeral filesystem), local JSON is fallback. `/sync`
  pulls holdings + watchlist into Supabase. Auto-sync via APScheduler daily
  08:00 IST (bot must be alive).
- **CSV import fallback:** INDmoney app -> Holdings -> Export to email -> keep
  `ticker,qty,avg_buy_price` columns -> `/import` in Telegram.
- **Manual command fallback:** `/buy TICKER PRICE QTY`, `/add_wish TICKER`.
- Re-auth: if `/sync` fails, re-run `python -m fetchers.indmoney_auth` on the
  bot's host.

## 12. Database (`db/schema.sql`)

Single evolving SQL file, idempotent (`create table if not exists` +
`alter table`). Key tables:
- `analysis` - daily LLM output
- `portfolio` / `wishlist` / `transactions` / `realized_pnl` - INDmoney-sourced
- `prediction_scores` / `accuracy_summary` / `calibration_log` - grading
- `sensei_eod` - EOD retrospectives
- `paper_trades` / `paper_signals` - Phase A simulation
- `metrics_snapshot` / `backtest_runs` - Sharpe/DSR/PBO history
- `stock_analyses` - deep single-stock LLM calls
- `ticker_enrichment` - 24h fundamentals/news cache
- `mcp_tokens` - INDmoney OAuth token storage
- `prediction_embeddings` - pgvector 1024-dim + `match_exemplars` RPC (RAG,
  blueprint 14)
- `instrument_map` / `real_orders` / `exec_state` - blueprint 19 execution layer
- `news_alerts_sent`, `alerts`
- `calculator_runs` / `portfolio_score_runs` - async LLM-enrichment jobs
  polled by the frontend

RLS: anon has zero access; owner reads via `auth.uid()`-matched policies.
Note: `stock_analyses`, `mcp_tokens`, `prediction_embeddings` were originally
created out-of-band and reconstructed into this file later for rebuild
parity - a documented hygiene gap closed by blueprint 16.

## 13. Fetchers (`fetchers/`)

`prices.py` (yfinance OHLCV, universe + user tickers), `news.py` (RSS +
GNews, ticker-linking alias map from `data/universe.csv`, blocklisted against
common English words to avoid false positives like "IDEA"/"POWER"),
`indmoney_auth.py` / `indmoney_mcp.py` (see §11), `indstocks_api.py` (real
order execution, blueprint 19), `options_chain.py` (NIFTY PCR/max-pain),
`fii_dii.py`, `reddit.py` (PRAW hot posts), `backfill_prices.py`,
`import_indmoney_transactions.py`, `import_realized_pnl.py` (one-off
imports). `fetchers/dev/` - debug/probe scripts, not production path.

## 14. Bot commands (`bot/telegram_bot.py`)

`/start /help /today /nifty /sensex /stock TICKER /portfolio /wishlist /buy
TICKER PRICE QTY /sell TICKER /add_wish TICKER /rm_wish TICKER /alert TICKER
PRICE above|below /alerts /rm_alert ID /import /sync /trade /backtest
/token_ind TOKEN /exec_status /halt /resume /real_open /close_order ID`

Emergency HTTP stub binds Render's `$PORT` **before** heavy imports
(pandas/yfinance/telegram/supabase take 30-60s cold - would fail Render's
port-scan otherwise). `alerts_checker.py` runs every 15 min against live
quotes, fires once then marks triggered. `news_alerts.py` hourly
relevance-based alerting (blueprint 17), dedup via `news_alerts_sent`.

## 15. Dashboard (`web/`)

Pages: `/` (today's call), `/markets`, `/portfolio`, `/wishlist`,
`/backtest`, `/calculator`, `/sensei`, `/trader`, `/accuracy`, `/login`,
`/auth/callback`. API routes are thin proxies: insert a pending row, then
dispatch a GH Actions workflow (`trigger-analysis`, `trigger-grader`,
`trigger-sensei`, `stock-analyst`, `calc-explain`, `portfolio-score-explain`,
`backtest`). PWA shipped (manifest, icons, service worker) - installable
today.

**Important:** `web/AGENTS.md` and `marketing/AGENTS.md` carry a pinned
warning that this project runs a bleeding-edge/custom Next.js version -
read `node_modules/next/dist/docs` before writing Next.js code in either app.
Always check those files before touching `web/` or `marketing/`.

## 16. Native app migration (blueprint 20, Wave 5)

**Research-stage only, 0% built.** No exit gate defined yet - not
build-ready. Findings so far: push notifications with action buttons and
WebAuthn biometric unlock are both achievable **PWA-only**, no native wrapper
needed. Home-screen **interactive widgets** are the one feature that requires
a native wrapper (TWA via Bubblewrap) - the sole forcing reason for this
wave. Goal if pursued: eliminate Telegram entirely, replace with in-app
parity for all bot commands.

## 17. Brand / style rules (binding - see `AGENTS.md` for authoritative copy)

- No em dashes anywhere (code, comments, commits, user-facing). Use period /
  comma / semicolon / middle dot. `scripts/strip_emdash.py` enforces this
  repo-wide (idempotent, safe to re-run). Deliberately built via `chr()` in
  its own source after an earlier self-rewriting bug corrupted the repo.
- No emojis in user-facing text - Lucide icons or brand Unicode glyphs only.
- Title Case headings, `dd/mm/yyyy` dates, 12-hour IST AM/PM uppercase.
- Indian Rupee + Indian comma grouping for all price-level numbers in prose
  (including index levels, e.g. NIFTY 23,070 -> ₹23,070). Standalone index
  quotes outside price-level context (Snapshot card's NIFTY chip, Markets
  heatmap) stay plain comma-formatted, no ₹.
- Card radius 22px. Logo `fill="#ffffff"`.
- Tier palette: A = `var(--gain)` green / `pill-gain`, B = `var(--mid)` lime /
  `pill-mid`, C = `var(--warn)` amber / `pill-warn`.

## 18. Blueprints system (`blueprints/`)

20 numbered blueprints + `_TEMPLATE.md` + `_pending_ab_rag.md`. Format: GOAL /
CONTEXT THE BUILDER NEEDS / CONSTRAINTS / STEP-BY-STEP PLAN / EXACT INPUTS /
DEFINITION OF DONE - written as self-contained prompts for a cold-start
"Builder" agent with no memory of prior chat. Operating rules (from
ROADMAP.md):
1. One blueprint per session/PR; verify live before the next.
2. Any blueprint that changes gates MUST show the before/after backtest delta.
3. New spend of any kind: ask first.
4. Blueprints are exact but not sacred - if the repo drifted, re-ground
   against named files and tag ASSUMPTION on deviations.
5. ROADMAP.md itself drifts - re-verify against real code before trusting it.

`_pending_ab_rag.md` - live A/B tracking doc for blueprint 14 (RAG Phase 1,
activated 2026-07-16). **Review was due 2026-08-06, was still overdue as of
2026-08-16** - check current status before assuming it's resolved.

Wave status (see ROADMAP.md for authoritative live table - this section
summarizes, don't treat as current without cross-checking):
- Wave 0-3 (blueprints 16,02,01,15*,03,07,12,17,18,04,08,10,06,05,11,14,19):
  done. (*15 = Oracle migration, deliberately deprioritized, not "done" in the
  build sense.)
- Wave 4 (09 half-Kelly, 13 LoRA): 13 done (v2 shipped), 09 blocked on trade
  count (27/60).
- Wave 5 (20 native app): research-only, 0% built.

## 19. Parked ideas - do not resurrect casually

- IPO tracker - no verified free data path (NSE blocks datacenter IPs,
  INDmoney MCP has no IPO tool). Revisit only with a working data probe.
- US stocks / MF+US realized-P&L imports - zero real holdings data to
  validate against. Auto-unparks when holdings exist.
- Multi-user / public product - explicitly out of scope (user decision
  2026-07-13).
- Isotonic recalibration - needs ~1000+ calibration pairs; Platt (2-param)
  until then.
- HMM regime detection - decorative at current sample size; trend+VIX filter
  chosen instead.
- Always-on specialist serving - no viable free path (verified July 2026);
  batch-only via GH Actions.
- Vibe-Trading - parked per 2026-07-12 evaluation, needs explicit
  re-confirmation to revive.
- Ensemble revival - if ever reconsidered, fix the vote-fraction dilution
  (`eff_wp = stated_wp * votes/n`) first.
## 20. Known limits / gotchas

- OpenRouter free: 20 req/min, 50/day under $10 lifetime credit ($10 credit
  approved 2026-07-13), 1000/day above it. Daily run uses only a few calls.
- yfinance: Yahoo rate-limits on hammering - batch downloads only.
- GitHub Actions: 2000 min/month free, current usage ~100 min/month.
- Supabase free: 500 MB DB, 50k rows/month writes.
- Markets closed days: yfinance returns last close; `market_calendar.py`
  skips weekends + NSE holidays for morning analysis and grader crons.
- WhatsApp: skipped, Meta charges after free trial - Telegram is the ₹0 path.
  Parked for paid Twilio only if user demand is high (v4 idea).

## 21. Root-caused bugs fixed (institutional memory, kept as comments in code)

- Sector-cap gate silently never fired due to wrong column name (`payload` vs
  `fundamentals`) - fixed 2026-07-14.
- Paper trader geometry bug (raw LLM target/stop unreachable/too-frequent) -
  fixed 2026-08-15, see §6.
- Telegram Markdown-escaping crash silently dropped the daily push - fixed in
  `bot/daily_push.py`.
- Zero caller-identity check on sensitive bot commands - fixed 2026-08-16,
  commit `2911377`.
- Dashboard fully public + open RLS on ~19 tables - fixed 2026-08-15/16.
- `specialist_eval.yml`'s llama.cpp download used no `--tag`, so `gh release
  download` defaulted to the repo's "latest" release. llama.cpp stopped
  marking any build as Latest (recent tags are Pre-release only, e.g.
  `b10655`), so it silently resolved to a stale `v0.3.0` tag with no
  `ubuntu-x64` asset - failing every run 2026-08-22 onward with "no assets
  match the file pattern". Fixed 2026-08-27 (commit `2d1b5aa`): resolve the
  real newest tag via `gh release list --limit 1` first, pass it explicitly.

## 22. `context/` folder

~19 `chat-context-arcemx-*.md` files - persisted Claude session handoff
documents from before this knowledge base existed, one per major work stream
(accuracy engine, backtest/alerts, blueprint waves, bot thin-router, ensemble
finetune, historical replay, infra/reliability, markets polish, phase-A paper
trader, RAG analyst, rankings UI, sensei playground, system audit, v1 ship,
wave3 progress). Plus `arcemx-brand-design.md`. Two unrelated stray files
(`CAT 2026 Prediction`, `protrainy-whatsapp-knowledge-base.md`) are leftovers
from other projects sharing this Claude workspace - not part of Arc'emX,
ignore them for this project's context.

This `KNOWLEDGE_BASE.md` file supersedes the need to read all 19 of those
files from scratch going forward - they remain as historical record, but new
sessions should start here.

## 23. Repo map (top level)

```
analyzer/     core engine: technical screen, LLM aggregation/routing, grading,
              sensei retrospective, paper trader, backtest, calibration,
              regime filter, geometry, LoRA export, RAG embeddings
bot/          Telegram bot, daily push, alerts checker, news alerts
fetchers/     prices, news, INDmoney MCP, INDstocks, options chain, FII/DII,
              reddit, one-off import scripts
db/           schema.sql (single evolving idempotent file)
blueprints/   20 numbered cold-start build specs + template + RAG A/B doc
web/          Next.js owner dashboard (auth-walled), deployed on Netlify
marketing/    separate public landing/waitlist Next.js site, Netlify
cloudflare/   cron-dispatcher Worker (reliable clock for GH Actions)
deploy/oracle/ idempotent Ubuntu bootstrap script (not currently deployed to)
scripts/      strip_emdash.py (brand rule enforcement)
context/      historical Claude session handoff docs (see §22)
notebooks/    Kaggle LoRA fine-tune notebook
data/         universe.csv, NSE holiday JSON, finetune/bakeoff/research dirs
.github/workflows/  12 workflows, see §4
db/, .env(.example), requirements*.txt, README.md, AGENTS.md, ROADMAP.md,
KNOWLEDGE_BASE.md (this file)
```

## 24. Live health audit (2026-08-27)

Full system audit run against live infra (GH Actions run history, Render
API, Supabase REST queries directly against production tables, not just
code reading). Findings:

- **GH Actions crons** - all core daily/hourly/15-min workflows (Daily
  Market Analysis, Daily Prediction Grader, Sensei EOD, Daily Prices Fetch,
  Daily INDmoney Sync, Hourly News Fetch, Alerts Checker) green, on
  schedule, no gaps.
- **Specialist Model Eval** - found broken, root-caused, fixed same session.
  See §7 and §21.
- **Render bot** - live, deploy healthy, `/health` returns `OK` (cold-start
  wake on first ping is normal free-tier behavior, not a bug).
- **Paper trader stall (watch, not confirmed bug):** 0 open trades, none
  closed since 2026-08-14 (13 days idle as of this audit), stuck at 27/60
  toward the Kelly gate. Could be gates correctly filtering weak setups, or
  a real slowdown - consistent with ROADMAP's own caveat that accumulation
  rate got uncertain after `top_performer_1d` (96% of historical volume) was
  gated off for having no measurable skill. Re-check trade count and gate
  logs if this stretches much longer.
- **LLM primary/fallback rate (watch, not confirmed bug):** primary model
  (`nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter) fell back to
  Gemini in **10 of the last 15 daily analysis runs (~67%)**, checked via
  direct Supabase query on `analysis.model_used`. Failover worked correctly
  (no user-facing impact, this is blueprint 01 doing its job) but the rate
  is high enough to be worth checking against OpenRouter's dashboard for
  rate-limit or model-availability issues on the nemotron model specifically
  - GH Actions logs don't surface the underlying HTTP error, so root cause
  is still unknown as of this audit.
- **Confirmed the paper trader stall is not a bug (2026-08-27):** checked 6
  days of live `paper_trader.eval_signals` log output directly. Every day it
  runs fine, evaluates 25-55 signals, enters 0 - skip reasons are `not_buy`
  and `low_conf` (LLM's own rating/stated confidence, not a gate
  malfunction), and NIFTY regime read `trend: down` every day that week.
  This is Wave 2's honesty layer (calibration + the `top_performer_1d`
  degating) working as designed in a down market with genuinely weak
  signals - not something to "fix" by loosening thresholds.
- **Diagnostic logging fix (commit `78ff458`):** `llm_router._content_ok`
  collapsed 5 distinct rejection causes into one generic "response
  unusable (empty/malformed content)" log line. Split into
  `_content_reject_reason` (returns the specific cause: `error_field`,
  `no_choices`, `empty_content:finish=X`, `json_parse_failed`,
  `empty_dict`, `degenerate_output`) so the next nemotron fallback event
  logs the real reason instead of a black box. No behavior change.
- **Fallback chain simplified (2026-08-27, user decision, commit `dc47bb8`):**
  removed Gemini + Groq provider escalation and the gpt-oss-120b/20b
  OpenRouter fallback pair entirely. Replaced with a single OpenRouter
  fallback, `minimax/minimax-m3:free` (free, 1M ctx, confirmed live).
  `GEMINI_API_KEY`/`GROQ_API_KEY` removed from every GH Actions workflow
  that passed them, the Oracle env template, `.env.example`, local `.env`,
  and deleted as GitHub repo secrets. **Real risk accepted knowingly:**
  with only one provider left, a call that exhausts both nemotron and
  minimax now fails the run outright (no Telegram push, no dashboard row)
  instead of degrading further - watch for this given nemotron alone was
  already failing over ~67% of the time before this change. If daily runs
  start going missing, check `_content_reject_reason` in the logs first.
- **Primary/fallback swapped same day (commit `a382b29`):** a real
  bake-off (`analyzer/bakeoff.py`) on the live payload showed nemotron's
  first attempt rejected as `degenerate_output` (15.3 min total after
  retry) vs minimax succeeding clean on attempt 1 (4.6 min, tighter
  range, more complete picks). Chain is now minimax primary, nemotron
  sole fallback - see §5.
- **Dashboard live check** - not done, no domain found in repo config (set
  directly in Netlify, not committed anywhere). Provide the URL to check it
  live in a browser.
- **Local `.env` gaps** - `REDDIT_CLIENT_ID`/`SECRET` and `GNEWS_API_KEY`
  empty locally (both optional per README). GH Actions repo secrets may
  differ from local `.env` - not verified either way.

Useful commands used for this audit (safe to rerun for a future check):
```bash
gh run list --workflow "<Workflow Name>" --limit 5 --json displayTitle,status,conclusion,createdAt,event
gh run view <run-id> --log-failed          # failure logs only
curl -sS -m 60 https://arcemx.onrender.com/health
```
Supabase REST queries (needs `SUPABASE_URL`/`SUPABASE_KEY` from `.env`) -
useful checks: `analysis?select=id,run_at,model_used&order=run_at.desc&limit=15`
(LLM failover pattern), `paper_trades?select=id&exit_at=is.null` (open
trade count), `paper_trades?select=*&exit_at=not.is.null&order=exit_at.desc&limit=3`
(most recent closed trade - staleness check).

---

## Changelog (append new entries at top, dated)

- **2026-08-27 (later still)** - User decision: replaced the Gemini/Groq/
  gpt-oss fallback chain with a single OpenRouter fallback,
  `minimax/minimax-m3:free` (commit `dc47bb8`). Deleted `GEMINI_API_KEY`/
  `GROQ_API_KEY` everywhere (workflows, templates, `.env`, GH repo
  secrets - both now unused). Accepted tradeoff: no more provider
  escalation if both nemotron and minimax fail in one call. See §5, §21.
- **2026-08-27 (even later)** - Ran a real bake-off (`analyzer/bakeoff.py`)
  on the live payload comparing nemotron-3-super vs minimax-m3 head to
  head (commit `a382b29`). nemotron's own first attempt was rejected as
  `degenerate_output` and needed a retry (15.3 min total); minimax
  succeeded clean on attempt 1 in 4.6 min, with a tighter NIFTY range and
  more complete picks. **Swapped primary/fallback order: minimax is now
  primary, nemotron demoted to sole fallback.** See §5, §21 for full
  numbers.
- **2026-08-27 (later same day)** - Root-caused both watch items from the
  morning's audit. Paper trader stall confirmed NOT a bug (live
  `eval_signals` logs show `not_buy`/`low_conf` skips + a `trend: down`
  regime all week - the honesty layer correctly refusing weak signals).
  Added diagnostic logging (commit `78ff458`) so nemotron's ~67% Gemini
  fallback rate logs its specific cause next time instead of a generic
  "unusable" bucket. See §24 and §21.
- **2026-08-27** - Full live health audit run (GH Actions history, Render
  API, direct Supabase queries) - see §24 for the complete findings. Found
  and fixed a real bug: `specialist_eval.yml`'s llama.cpp download was
  broken since 2026-08-22 (see §7, §21), fixed and verified live in commit
  `2d1b5aa`. Two items flagged to watch, not yet confirmed as bugs: paper
  trader idle 13 days at 27/60 trades, and primary LLM falling back to
  Gemini on ~67% of recent runs.
- **2026-08-19** - Oracle Cloud migration started (blueprint 15, reversed the
  2026-08-15 deprioritization). User's Always Free account is live, signup
  friction resolved. Reason: bot responsiveness for INDstocks confirm-mode
  buttons matters more than the original bandwidth-cap trigger. See §8.
  Cutover not yet verified as of this entry - update §8 once `/health` +
  Netlify `ARCEMX_BOT_URL` cutover + Render suspend are all confirmed live.
- **2026-08-19** - Initial creation of this knowledge base file, built from a
  full repo read (README.md, AGENTS.md, ROADMAP.md, plus code-level read of
  every subsystem).

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

- **Bot host: LIVE ON ORACLE as of 2026-08-29.** Migrated off Render.
  `VM.Standard.A1.Flex`, **4 OCPU / 24 GB** (maxed the free allotment,
  deliberately - the plan is to eventually also move GH Actions' heavy
  compute and cron scheduling itself onto this box), Ubuntu 24.04, 200 GB
  boot volume (OCI's minimum custom size turned out to be 50 GB, not the
  47 GB the runbook originally said - went with the full 200 GB free
  allotment since it's the only instance and costs nothing extra). Reserved
  public IP: **`92.4.84.48`**. Recovery doctrine holds: the box has **zero
  unique state** - Supabase has all data, GitHub has all code, INDmoney
  tokens live in Supabase `mcp_tokens`.

  **Real gotchas hit during migration, both fixed:**
  1. The original instance's SSH private key was never actually downloaded
     at creation - Oracle shows it once and never stores it server-side, so
     it was unrecoverable. Fix: terminated and recreated the instance (zero
     state lost, box was still empty) - this time the key was confirmed
     saved before continuing.
  2. **Oracle's stock Ubuntu 24.04 image ships iptables pre-configured to
     allow ONLY port 22**, completely separate from the VCN's cloud-level
     Security List. The Security List correctly allowed 80/443 from
     0.0.0.0/0, but external `curl` to port 80 still timed out while SSH
     worked and `curl localhost` on the box itself worked - that mismatch
     (cloud-level rule correct, OS-level firewall still blocking) is what
     pointed at iptables rather than the Security List. Fixed live via
     `iptables -I INPUT 5 -p tcp -m state --state NEW --dport {80,443} -j
     ACCEPT` + `netfilter-persistent save`, and **added to
     `deploy/oracle/setup.sh` permanently** so a future rebuild doesn't hit
     this again.
  3. Attaching a reserved IP to an instance is NOT done from the Reserved
     Public IPs list page (no attach action there) - it's done from the
     instance's own **Networking tab -> VNIC -> IP administration -> ⋮ on
     the ephemeral IP row -> "Reserve IPv4 address"**. That action also
     does NOT let you pick a pre-existing reserved IP - it converts the
     current ephemeral IP into a brand new reservation. The original
     `141.148.211.234` reservation made earlier sits unused as a result
     (harmless, free, just an orphaned reservation) - the box's real IP is
     `92.4.84.48`.

  Verified end-to-end 2026-08-29: SSH in, ran `setup.sh` clean, wrote
  `/etc/arcemx.env` (pulled `GH_TOKEN`/`GH_REPO`/`INDSTOCKS_EXEC_MODE` from
  the live Render service's env via Render's API, rest from local `.env`),
  `arcemx-bot` + `caddy` both stable, `/health` returns OK externally,
  Netlify's `ARCEMX_BOT_URL` cut over to `http://92.4.84.48` (both deploy
  contexts), and a real `/trigger/sync` call through the full path
  (Netlify's pattern, tested directly) returned
  `{"ok": true, "holdings": 4, "watchlist": 9, "analysis": "queued",
  "analysis_via": "github"}` - genuine INDmoney data, genuine GH Actions
  dispatch.

  **Not yet done:** suspend (don't delete) Render for the ~2-week safety
  window before retiring it for good. Do that once a few days of live
  Oracle-hosted operation confirm stability.

  **Future step (not started):** move GH Actions' heavy analysis compute
  and cron scheduling itself onto this box (systemd timers replacing GH's
  native `schedule:` + the Cloudflare Worker dispatcher) - see §28's
  reframe for why this matters beyond just bot hosting.
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
`fii_dii.py`, `reddit.py` (Apify-backed hot posts, PRAW as dormant
fallback - see §25), `backfill_prices.py`,
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

## 23a. Specialist eval was fully broken since day one, now fixed (2026-08-29)

The weekly `specialist_eval.yml` job (§7, §22) has shown green in CI since
2026-08-15, but **scored 0 real predictions on every single run** -
verified by reproducing the exact `llama-cli` invocation live on the
Oracle box against the real `specialist-v2` GGUF. Two independent bugs,
both now fixed (commits `3c5913f`, `a83ea08`):

1. **`run_llama()` passed `-cnv`, a flag llama.cpp's CLI no longer has.**
   Every call failed immediately with `error: invalid argument: -cnv` and
   empty stdout - which `extract_json()` correctly treated as "no
   parseable JSON," exactly indistinguishable from the model just writing
   prose. `run_llama()` never checked `subprocess.run()`'s returncode or
   looked at stderr, so a hard CLI failure and a genuine model output
   miss looked identical from the caller's side - this is why it went
   undetected for two weeks straight. Fix: drop `-cnv` (conversation mode
   is implied by `--single-turn` on current llama.cpp), and raise with
   the real stderr on a nonzero exit instead of returning garbage for the
   parser to silently fail on.
2. **The workflow's "Install Python deps" step never installed
   `yfinance`/`pandas`.** Once fix #1 got real scores flowing,
   `score_prediction()`'s `range_1d` path (which imports
   `analyzer.grader` for `grade_range`, which imports `yfinance` at
   module level) immediately crashed the entire run with
   `ModuleNotFoundError` - and because `score_prediction()` wasn't
   wrapped in a try/except, that one missing dependency killed every
   remaining not-yet-scored target in the batch, not just `range_1d`'s.
   Fixed both: added the missing deps to the workflow, and wrapped
   `score_prediction()` so one dim's scorer crashing only skips that
   target going forward.

**Verified live, fully working end to end:** `Specialist eval
(specialist-v2): scored 33/33`. Real predictions are now landing in
`prediction_scores` for the first time since the pipeline was built -
the "14+ day live comparison" clock the project's own docs have treated
as running since 2026-08-16 has, in reality, just started for real.

**New observation, not yet investigated - not a script bug, the script
completed successfully:** `direction_1d`/`market_mood_1d` show a healthy
mixed score distribution (0/50/100), but `range_1d` and `top_performer_1d`
scored **0.0 on every single target** (8/8 and 9/9) in this first real
run. Could be genuine model weakness on those two dims (plausible for
`top_performer_1d` specifically, given it's independently proven to have
zero edge in the live chain too - blueprint 21), or a scoring-logic
mismatch unique to those two dims. Worth checking once a few more weekly
runs accumulate real sample size - one run isn't enough to tell which.

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

## 25. Reddit sentiment: from broken to Apify-backed (2026-08-27/28)

**Discovery:** the 2026-08-27 audit's bake-off run logged `"Reddit not
configured"` - `fetchers/reddit.py` (PRAW/official OAuth) has never
actually worked in production, `REDDIT_CLIENT_ID`/`SECRET` were always
empty. Initial assumption (wrong): "5-minute fix, just create a script app
at reddit.com/prefs/apps."

**Real finding:** Reddit closed self-serve app registration in **November
2025** under its Responsible Builder Policy. Confirmed live 2026-08-28 -
the "create app" form no longer creates anything, it redirects to the
policy page. Every new OAuth app now needs manual approval via a separate
contact form, and "small and personal projects are the most-rejected
category." The old `.json`-without-auth fallback is also dead (403 since
2026-05-30). This is now nearly the same risk class as X/Twitter, just
gated by manual review instead of a paywall.

**Decision:** replace with a third-party reseller, same pattern as
twitterapi.io for X. Landed on **Apify** (established platform, not a
self-reviewing SEO shop like a couple of other candidates that turned up
in research). Picked `trudax/reddit-scraper-lite` (39,715 users, by far
the most-used Reddit actor on Apify) over `comchat/reddit-api-scraper`
(no "hot" sort support - it's a keyword-search actor, not a subreddit-
listing one - and requires a paid residential proxy on top) and over
`trudax/reddit-scraper` ($45/month flat rental, rejected outright).

**Real cost, verified via Apify's own API, not blog estimates:**
PAY_PER_EVENT, $0.004/result. At `limit=10` (posts per subreddit): 4 subs
x 10 x ~30 days/month = ~1200 results/month x $0.004 = **~$4.80/month**,
inside Apify's $5/month free platform credit (no card ever charged at
this volume). The original `limit=15` used by `aggregator.py` would NOT
have stayed free (~$7.20/month) - dropped to `limit=10` for this reason.
Raising the limit raises real recurring cost; check this section before
changing it.

**Real reliability findings from live testing (not assumptions):**
- This actor does a genuine headless-browser scrape (scrolling to load
  more than a handful of posts) - single-subreddit run duration measured
  live across several attempts: **184s to 534s+**, highly variable, not
  something fixable via input parameters.
- **Root-caused a false-timeout bug**: running all 4 subreddits
  concurrently via `urllib` holding 4 long-lived synchronous HTTP
  connections open at once caused every single one to report a client-
  side read timeout - but Apify's own run records showed **3 of 4 had
  actually SUCCEEDED server-side** well inside the timeout window (255s/
  319s/341s vs a 630s client timeout). The problem was the client's
  connection handling under concurrency, not Apify or the actor.
- **Fix**: switched to Apify's async start-run -> poll-every-5s -> fetch-
  dataset pattern (using `requests`, not raw `urllib`), which uses many
  short-lived requests instead of one long-held connection per subreddit.
  Confirmed live 2026-08-28: **40/40 posts, all 4 subreddits, zero
  failures.**
- Even a run that ends `FAILED`/`TIMED-OUT`/`ABORTED` may have partial
  results in its dataset - the code fetches the dataset regardless of
  final status (except when no terminal state was ever reached), treating
  a short result as valid best-effort output rather than a hard failure.

**Spend from this whole debugging session: ~$2.11 of the $5 free credit**
(higher than steady-state because several test runs pulled 25 items
instead of 10). This first month may run slightly over the free credit
because of setup/debugging; ongoing months at `limit=10` should land
around $4.80, inside the free tier. Cycle resets 2026-09-26.

**PRAW fallback**: kept in `fetchers/reddit.py` as `_fetch_hot_praw()`,
activates automatically (no code change) if `REDDIT_CLIENT_ID`/`SECRET`
ever get filled in - i.e. if Reddit's manual approval is ever granted, or
the policy loosens. `REDDIT_CLIENT_ID`/`SECRET` stay wired in
`daily_analysis.yml`'s env as a dormant path for exactly this reason.

**Also researched and rejected the same day: Apify for Twitter/X.**
Unlike Reddit, hosting a Twitter scraper on Apify does NOT reduce the
legal exposure (X's ToS liquidated-damages clause, $15,000/1M posts, still
applies - Apify's own actor terms explicitly disclaim responsibility for
ToS compliance) and Apify's own Twitter actors charge **$40/1,000 tweets
on free-tier accounts specifically to discourage this use case** (vs paid
rates of $0.15-0.40/1,000, which need a $49+/month Apify subscription to
unlock). Reddit-via-Apify made sense because Reddit's legal and pricing
profile are both mild; Twitter-via-Apify inherits Twitter's actual
problems unchanged. Twitter/X sentiment stays parked - see §19-adjacent
reasoning, add a Parked-ideas entry in ROADMAP.md if not already there.

## 26. Why the win rate is 20%: the skill audit (2026-08-28)

Full audit of all 4,310 graded `prediction_scores` rows, run to answer
"why is the paper trader losing?". **Full detail, method, and the fix plan
are in `blueprints/21-horizon-pivot.md`.** Headline findings:

- **The traded signal has negative alpha.** `top_performer_1d`, 792
  individually-graded picks: mean alpha -0.181% vs NIFTY, win rate 41.7%,
  t=-2.56, and **negative in all four quarters** of the sample. This source
  drove 47 of 64 backtest trades.
- **Conviction tiers are not informative.** A-tier n=43 t=+0.05, B-tier
  n=622 t=-2.80, C-tier n=125 win rate 50.4%. The "speculative" C picks beat
  the "solid" B picks. Never gate or size on conviction.
- **Skill rises monotonically with horizon.** Target-before-stop scores:
  10-session picks 42.16 (t=-1.96) and shorts 38.28 (t=-2.60), 20-session
  verdicts 56.40 (t=+3.13), **60-session long picks 73.96 (t=+5.71, 52.1%
  target-first vs 4.2% stop-first)**. Also strong: `wishlist_7d` t=+8.31,
  `avoid_7d` t=+7.68.
- **None of the skilled signals are traded.** `wishlist_signals`,
  `stocks_to_avoid`, and `portfolio_verdicts` are never consumed by
  `eval_signals()`; the deep `stock_analyst` path produced zero backtest
  trades (its table is only filled on-demand from the dashboard). All 64
  backtest trades ran at `horizon_days=1`, 59 of 64 long.
- **1-day trading is arithmetically impossible at this account size.**
  Measured 1-day alpha ~0.2% vs a round-trip cost hurdle of 0.5% (large
  positions) to 0.86% (the qty=1 cohort). Cost is 2.5-4.5x the signal. Even
  a correct call cannot pay for its own execution. This is not a tuning
  problem.
- **A real but unstable bearish signal exists.** Model "down" calls on
  NIFTY hit 66.7% (14/21) vs a 29.9% base rate, p=0.00054; `market_mood`
  bear calls 73.7% (14/19) vs 31.0%, p=0.00016. **But it is not time-stable**
  - down-calls went 10/10 in the first half of the sample and 4/11 in the
  second. Track forward, do not trade yet. By contrast the model's bullish
  claims are near-worthless: `direction_5d` up-calls 5.9% correct,
  `direction_20d` down-calls 0/21, `fii_flow_1d` inflow-calls **0/30**.
  There is a systematic optimism bias in its forward-looking bullish output.

**Do not** invert the long-pick signal (overfit trap, and the alpha is below
the cost hurdle in either direction), and **do not** loosen `MIN_CONF` /
`MIN_EDGE_PCT` to recover trade volume.

**Correction found same day, before Phase 1 shipped:** the original plan was
to trade `wishlist_signals` `buy_now` calls at a 60-session horizon,
justified by `long_pick_tp_sl`. Both premises were wrong: `long_pick_tp_sl`
grades `raw.get("long_term_picks")`, a field the CURRENT prompt does not
generate at all (verified real in `analysis.raw_json` for id=24, June 2026 -
the schema has since moved on and left this dimension orphaned, still
scoring old data). And isolating `buy_now` specifically (not the blended
`wishlist_7d` score) shows **no edge**: n=338, mean 7-day return -0.13%,
t=-0.44. The strong `wishlist_7d` number was actually driven by `skip`
calls correctly predicting declines (n=176, mean -2.11%, t=-6.97). See
`blueprints/21-horizon-pivot.md`'s CORRECTION section for the full trail -
caught before any trading code shipped, Phase 1 was rewritten to use
`stocks_to_avoid` + wishlist `skip` as negative filters instead of a new
buy source, since **no positive-edge buy signal currently exists anywhere
in the live schema**.

**Phase 0+1 shipped 2026-08-28** (commit `fe93525`): `top_performer` and
`worst_performer` disabled as trade sources (`TRADE_TOP_PERFORMERS` /
`TRADE_WORST_PERFORMERS = False` in `paper_trader.py`, mirrored in
`backtest.py`), `stocks_to_avoid` + wishlist `skip` wired as hard negative
filters on all remaining sources. Grading stays on for both disabled
sources so the findings stay falsifiable. Fresh backtest (`backtest_runs`
id=9) vs the prior best (id=6): Sharpe -13.245 -> -10.663, win rate
23.1% -> 40.0%, max DD 6.19% -> 0.29%, net P&L -₹3,446 -> -₹133. Real
improvement on every axis, but **not a clean pass** - DSR is still 0.0
(n=5 trades, structurally can't resolve otherwise) and only 6 of 1,798
evaluated signals entered a trade. Removing negative-EV sources worked
exactly as measured; it also means there is now almost nothing left to
trade. **Phase 5 (reviving a real buy-side signal) is the actual
bottleneck going forward**, not a nice-to-have - without it the trade
count will not grow toward the 60-trade Kelly gate at any real pace.

### Honest read on the "₹100-200/day" goal

At the current ~₹52k `portfolio_base`, ₹150/day is ~72%/year. That is not a
realistic sustainable target for a systematic retail strategy; a good one
targets roughly 15-25%/year, which on ₹52k is ₹30-50 per trading day.
₹150/day at a realistic 20%/year needs roughly ₹1.9 lakh deployed; ₹1,000/day
needs roughly ₹12.5 lakh. So once any genuinely positive edge exists, the
rupee target becomes mostly a capital question, not a signal question - but
the edge has to come first, and it does not exist yet (every backtest to
date: Sharpe negative, PSR 0, DSR 0).

## 26a. Blueprint 21 Phase 5: seeding a real buy signal (2026-08-29)

Investigated the two near-term candidates for a positive-edge buy signal
before building anything, to avoid the exact trap that fooled the
original Phase 1 plan (trusting an aggregate score without decomposing
it):

- **`portfolio_verdicts` "add"** - the aggregate `verdict_tp_sl` t=+3.13
  looked promising, but decomposing by verdict type shows it's entirely
  driven by **"hold"** (n=291, t=+4.98) - correctly staying in existing
  positions, not a fresh buy call. "add" itself: **n=199, t=+0.78,
  statistical noise.** "trim" -0.40, "exit" -2.71. Not usable as a buy
  signal.
- **`pick_tp_sl`** turned out to grade `short_term_picks`, a field
  retired before the current schema - unrelated to `stock_analyst`,
  discarded as a red herring.
- **`long_term_picks`/`long_pick_tp_sl`** (t=+5.71, the strongest signal
  in the whole audit) is a **dead field** - the current `SYSTEM_PROMPT`
  doesn't generate it. Last real data around analysis_id 77 (June 2026).
- **`stock_analyst`** (the deep single-ticker path, horizon 30): **13
  rows total, ever**, all manual dashboard clicks, last one 2026-07-12.
  Zero track record either way, but already fully wired end to end in
  both `paper_trader.py` (`_evaluate_one`, the FIRST source
  `eval_signals()` checks) and `backtest.py` - purely a data-starvation
  problem, not a missing-feature problem.

**Decision: build on `stock_analyst`, not revive `long_term_picks`.**
Reasoning: (1) zero new trading-logic code needed - lower risk of the
exact kind of subtle bug hit three times already this week (notional-cap
floor, cost-gate reference point, paper_trader/backtest mirror drift);
(2) structurally sounder design - a dedicated single-ticker call gets
real attention, unlike another array crammed into the already-massive
daily prompt (the same crammed-prompt shape that plausibly produced
`top_performer_1d`'s flat, undifferentiated, negative-alpha output); (3)
`long_term_picks`' old t=+5.71 was itself generated under that same
crammed-prompt regime, months ago, under a different model - less
trustworthy than it looks.

**Built and verified live 2026-08-29** (commit `c7030fd`):
`analyzer/stock_analyst_dispatch.py` runs a fresh, independent technical
screen (NOT the LLM's own `top_performers`, which has proven negative
alpha - seeding from it would reintroduce the same bad candidate
selection one level removed) and dispatches the existing
`stock_analyst.yml` workflow per candidate, exactly matching
`web/app/api/stock-analyst/route.ts`'s insert+dispatch contract. New
workflow `stock_analyst_dispatch.yml`, 6 candidates/day at 09:00 IST,
30-day horizon (matching the long-horizon regime where real skill was
measured - Finding 3). Uses GH Actions' built-in `GITHUB_TOKEN` +
`github.repository` context, not a custom `GH_TOKEN`/`GH_REPO` secret -
confirmed live via `gh secret list` that neither exists on this repo
(those names are Netlify-only env vars for the dashboard's own dispatch
route, a separate credential store).

**First real run**: dispatched 6/6 cleanly (`MEDANTA`, `APARINDS`,
`CARTRADE`, `HINDZINC`, `IFCI`, `JINDALSTEL`), 5 completed before this
was written. **Honest early observation, not yet a problem, just
something to watch**: ratings came back 4 "hold" + 1 "sell" + 0 "buy".
`_evaluate_one` requires `rating == "buy"` to open a trade, so working
candidate generation doesn't guarantee the model will actually call
"buy" often enough on these names to produce trades - that needs a real
run of days to answer, same as everything else in this blueprint. No
shortcut available.

## 26b. Blueprint 21 Phases 2+3: real backtest, not a clean pass (2026-08-29)

Ran the fresh Phase 3 backtest same day as Phase 5 shipped, per the
handoff's own next-step priority. **Real finding, checked before running
anything:** all 19 `stock_analyst` rows that have ever existed (13 old +
the 6 seeded by Phase 5's first live dispatch, same day) are rated hold
or sell - **zero ever rated "buy."** Both `paper_trader._evaluate_one`
and `backtest._eval_stock_analyst` require `rating == "buy"` to open a
position, so this source mechanically cannot contribute a trade yet,
independent of whether the pipeline works (it does - see §26a).

Ran it anyway (user call) to get a formal record. **`backtest_runs`
id=10**: 5 trades, win rate 40.0%, Sharpe -10.663, max DD 0.29%, net
P&L -₹133.18, DSR 0.0 - identical in every number to id=9. Confirms the
prediction: Phase 5 has not yet moved any metric.

**Phase 2 (cost gate re-tune) answered by the same run:**
`skips.cost_dominated = 18` of 1,869 evaluated (~1%), near zero.
Per the blueprint's own rule, **`COST_TO_PROFIT_MAX` left unchanged** -
it's acting as a floor, not a filter.

**Phase 3 bar check** (need all three): Sharpe -10.663 beats -13.245
(pass, but inherited from id=9, not new); DSR 0.0 (fail); net P&L
negative (fail, but with a clean documented reason - see above). **Not
reverting** - nothing regressed, Phase 5 added zero trades net, not a
worse pivot, just an untested one so far. Real Phase 3 test is still
pending on `stock_analyst_dispatch` producing an actual "buy" rating.
Full detail and the re-test plan in `blueprints/21-horizon-pivot.md`
Phase 2/Phase 3 sections (both now marked done/run with results inline).

**Phase 4 built same session, right after this** (was unconfirmed at
handoff time - grepped both files, found zero trace, so built it fresh):
`BEARISH_BLOCK_ON` env-gated flag in both `paper_trader.py` (computed
once per `eval_signals()` pass from the latest `analysis` row, mirroring
`_avoid_set()`'s pattern) and `backtest.py` (no-lookahead checkpoint list
mirroring `avoid_checkpoints`), blocking new LONG entries when
`market_mood == "bear"` or `nifty_outlook.direction == "down"`. Backtest
id=11: 29/1,869 blocked, trade count 5 -> 3, win rate 40.0% -> 66.67%,
**net P&L flipped positive for the first time ever** (+₹17.66, tiny but
real - removed exactly the 2 historically-losing trades). Read with the
same caution the blueprint itself demands: n=3, same 4-day replay window
as every prior run, and Finding 6's own audit showed this exact signal is
NOT time-stable (10/10 first half vs 4/11 second half of 21 down-calls).
Passive filter only, re-test after ~20 more down-calls accumulate. Full
detail in blueprint 21 Phase 4 section.

Blueprint 21 is now functionally complete on all 6 phases. What's left is
real-world waiting: Phase 5's first `stock_analyst` "buy" rating, and
Phase 4's bearish-signal re-test at a larger sample. Live path
(`paper_trader.py`, not just the `backtest.py` mirror) not yet exercised
against production Supabase this session - deliberately, to avoid writing
real rows outside a scheduled run. Verify via a Supabase query for
`paper_signals.skip_reason = 'regime_bearish_block'` once tomorrow's
scheduled cron actually runs the live code.

## 27. Cost-structure fixes to the paper trader (2026-08-28)

Two changes made while diagnosing the above, both shipped:

- **`MAX_NOTIONAL_PCT` 5% -> 8%.** At a ~₹52k base the 5% cap (₹2,621) forced
  `qty=1` on any stock priced above that, and the `max(1, ...)` floor then
  quietly re-exceeded the cap it was meant to enforce. 43% of
  correctly-directioned trades were still losing money because a 1-share
  position cannot absorb ~₹20-25 of round-trip cost.
- **New `cost_dominated` gate** (`paper_trader._cost_dominated`): skips a
  trade when estimated round-trip cost exceeds `COST_TO_PROFIT_MAX` (0.40) of
  the probability-weighted expected profit. Deliberately measured against
  `edge_pct`, NOT profit-at-target: 56% of trades exit via `horizon` (neither
  barrier hit), so a first version that used the optimistic target-case
  profit fired **zero times across 3,296 evaluations**.
- **Trap worth knowing:** `backtest.py`'s gate stack is a hand-written mirror
  of `paper_trader.py`'s evaluators, not a call into them. Adding a gate to
  only one file silently does nothing in replay. Both files must be edited
  together; `backtest.py`'s module docstring now says so.
- **Result was mixed and is recorded honestly.** Run id=8 vs id=6: absolute
  losses improved (-₹3,446 to -₹2,061) and max drawdown improved (6.19% to
  3.80%), but Sharpe got *worse* (-13.245 to -16.199) because trade count
  fell 65 -> 20 and the win rate did not improve. The gate mostly shrank the
  book rather than improving per-trade quality. `COST_TO_PROFIT_MAX` is
  therefore still considered un-tuned - see blueprint 21 Phase 2.

## 28. Missed daily Telegram push (2026-08-28)

No `Daily Market Analysis` GH Actions run fired at all today (a trading
Friday) - not a failed run, zero run records for the entire scheduled
window (08:20/08:43 IST) even ~6.5 hours after it should have fired.
Confirmed the workflow itself is `active`, its YAML is valid, and the repo
has no Actions-level pause. Manually dispatched it
(`gh workflow run "Daily Market Analysis"`, run id `33159821672`) to
deliver the day's update; that run took 16+ minutes on "Run aggregator"
alone (normal - includes the new Apify Reddit fetch, see §25).

**Root cause not fully confirmed - no Cloudflare access in this session
to check the Worker's actual execution log.** Best-evidence hypothesis:
`cloudflare/cron-dispatcher/src/index.js` (the reliable clock built
specifically because GH's own `schedule:` trigger is documented-flaky) maps
its own Cloudflare Cron Trigger to a workflow via an **exact string match**
against a hardcoded table:
```js
const CRON_TO_WORKFLOW = { "50 2 * * 1-5": "daily_analysis.yml", ... };
```
If the Worker's cron trigger fires with any string mismatch, or its
`GH_TOKEN` secret is stale/expired, the dispatch either gets silently
skipped (`console.error` only, no user-visible signal) or fails outright.
**Neither failure mode is currently monitored** - the existing dead-man
ping (`HC_PING_URLS`) only fires when the GH Actions *workflow itself*
completes; if nothing ever triggers the workflow, no ping fires either way.
This is a real observability gap, not yet closed.

**Next step, not yet done:** check the Cloudflare dashboard directly (Workers
& Pages -> cron-dispatcher -> Logs / Triggers) to see whether the Worker's
cron fired today and what `dispatch()` returned. If it's a GH_TOKEN
expiry, rotate it (`gh secret set GH_TOKEN` on the repo AND update the
Worker's own env). Worth adding an independent dead-man check specifically
for "did the dispatcher fire" (e.g. Worker pings a distinct Healthchecks.io
URL on every attempt, success or failure) so a silent miss like today's
surfaces on its own instead of requiring the user to notice a missing
Telegram message.

**Resolution, same day:** Cloudflare Worker Logs were confirmed Disabled
(now Enabled) and the 3 cron triggers were confirmed to match the code's
`CRON_TO_WORKFLOW` table exactly - ruling out a cron-string mismatch. Cause
of the original morning miss stays unconfirmed (logs were off at the time),
but a second, worse problem was found and fixed instead: **5 separate
workflow runs fired between the morning miss and the evening, and all 5
pushed a Telegram message**, because `daily_analysis.yml`'s `FORCE_RUN` was
`true` for ANY `workflow_dispatch` event with no dedup at all. My manual
recovery dispatch (09:32 UTC), two more automated `workflow_dispatch`
events ~20 min later (09:51/09:52 UTC, not from me - most likely the
Cloudflare Worker and/or the bot's own scheduler both catching up), and
both native `schedule` crons finally landing ~12 hours late (14:36/15:17
UTC) each independently force-ran and pushed. Confirmed via `gh api` that
`bot/daily_push.py` has zero internal dedup - it unconditionally sends
whatever the latest `analysis` row is, every time it's invoked. Fixed in
commit `af53825`: `workflow_dispatch` now has an explicit `force` input,
default `false` - a bare dispatch (what the Worker and bot always send)
now respects `run_if_stale` like the scheduled triggers; a genuine forced
recovery needs `gh workflow run "Daily Market Analysis" -f force=true`.

**Oracle migration reframe:** this whole incident is a live demonstration
of exactly why blueprint 15 (Oracle migration) matters beyond just bot
hosting - the user's stated plan (confirmed again 2026-08-28) is to
eventually move cron scheduling itself onto the always-on Oracle VM
(systemd timers / cron on the box), retiring GH Actions' native `schedule:`
trigger and the Cloudflare Worker workaround entirely for time-sensitive
triggers. That's why 4 OCPU/24 GB was chosen over the originally-planned
2/12 - headroom for eventually running heavy analysis in-process on the
box instead of dispatching to GH Actions. See §8 for the actual migration
status - **still mid-flight**, paused after VM creation, not yet at the
reserved-IP/bootstrap steps.

## 29. RAG Phase 1 A/B review: done, 24 days late, verdict is inconclusive not a win (2026-08-30)

The review blueprint 14 itself scheduled for 2026-08-06 never happened -
`blueprints/_pending_ab_rag.md` sat untouched since the 2026-07-16 activation
commit. Done now, from real `accuracy_summary` data, not from the single
most recent snapshot alone (that would have been exactly the kind of
un-decomposed read this project has been burned by twice before - see §26).

**Baseline (2026-07-16, pre-activation, n=25):** direction_1d 54.83%,
range_1d 71.63%, insight_quality 72.65%.

**Full 30d-window trend since activation, not just today's point:**

| Date | direction_1d | range_1d | insight_quality (control) |
|---|---|---|---|
| 2026-07-16 (baseline) | 54.83 | 71.63 | 72.65 |
| 2026-07-28 | 53.98 | 69.41 | 69.42 |
| 2026-08-09 (near the original review date) | 52.78 | 63.71 | 65.24 |
| 2026-08-20 | 63.41 | 65.92 | 65.22 |
| 2026-08-30 (today) | 71.59 | 67.92 | 71.54 |

**The naive read is misleading.** Compared only baseline-vs-today,
direction_1d looks like a clear win (+16.76pp) and range_1d a small loss
(-3.71pp), which technically satisfies blueprint 14's stated pass bar
("direction_1d and/or range_1d improved without insight_quality regressing
meaningfully"). But `insight_quality` is the control dimension - RAG's
exemplar retrieval does not target it at all - and it moved in the exact
same shape as the two targeted dimensions: down through late July/August,
then back up by month end. All three dimensions dipped together and
recovered together. That is the signature of a shared external cause
(most likely the "trend: down" market regime documented through most of
this window in §24/§26), not a RAG-specific effect. A metric RAG never
touches should not move with the metrics it does touch if the touched
ones' movement were really coming from RAG.

**Sharpest evidence against a clean win:** had this review been run on its
originally scheduled date (2026-08-06, closest real snapshot 08-09), the
verdict would have been the opposite - all three dimensions BELOW baseline,
direction_1d included. The only reason today's snapshot looks like a win is
that the review is 24 days late and caught a later recovery that hit every
dimension equally, RAG-targeted or not.

**Verdict: inconclusive.** Not a proven win, not a proven loss, no causal
evidence either way. **Recommendation: leave `RAG_PHASE1_ENABLED` on.**
₹0 marginal cost, no evidence of harm, and the bge-base re-embed work is
sunk and already reused by Phase 0 selection regardless of the flag. Do
not revert on an inconclusive result - that is the same class of mistake
as trading an unproven signal, just in the other direction. A real answer,
if one is ever needed, requires an actual controlled comparison (RAG
alternated on/off across matched days, or a held-out control cohort) to
separate its effect from regime noise - a simple before/after cannot do
this, as demonstrated here.

`blueprints/_pending_ab_rag.md` deleted per its own stated convention
("delete this file once the review is written up") - this section is that
write-up. `ROADMAP.md`'s Wave 3 blueprint 14 row updated to reflect the
review is done, not overdue.

## 30. Blueprint 22 Phase A cutover complete: GH schedule pulled, Oracle timers live (2026-08-31)

All 5 Phase A jobs (`hourly_news`, `daily_prices`, `daily_sync`,
`alerts_checker`, `stock_analyst_dispatch`) confirmed firing cleanly on
their own systemd timers on the Oracle box, then had their GH Actions
`schedule:` trigger removed the same day - `workflow_dispatch:` kept on
all 5 as a manual recovery path. Commit `8638d14`.

**Real evidence this was overdue, not just theoretically correct.**
Checked GH Actions run history at cutover time and found the native
`schedule:` trigger had gone silent on 4 of the 5 jobs, independent of
anything to do with this migration:

- `daily_sync`: last real schedule fire 2026-08-28 - **3 days silent**.
- `alerts_checker`: last real schedule fire 2026-08-28 - **3 days silent**.
- `stock_analyst_dispatch`: **never fired via schedule successfully, ever**
  - every prior run in its history was a manual `workflow_dispatch`.
- `hourly_news`: last fire 01:09 UTC that same morning, then stopped -
  Oracle's timer fired 6 clean times in the hours after that.
- `daily_prices`: not due at either trigger's check time, so not directly
  comparable, but included in the cutover anyway on explicit user
  go-ahead, accepting the small window before its first Oracle fire
  (16:30 UTC) proved out.

Oracle-side verification, all genuine work, not just clean exit codes:
`hourly_news` fetched 261 real news items across 6 fires; `daily_sync`
synced 4 real holdings + 9 watchlist items; `alerts_checker` ran 9 clean
checks (`no active alerts`, a real state read, not a crash); `stock_analyst_dispatch`
dispatched 6 real candidates (APARINDS, CARTRADE, ENGINERSIN, KPITTECH,
PERSISTENT, VOGL) - different tickers from the 2026-08-29 dispatch, as
expected from a fresh daily technical screen.

**Bug found and fixed during this same rollout** (see §21 for the fuller
account): `run_job.sh`'s failure path silently reported success
(`if ! cmd; then rc=$?` reads the negation's exit status, always 0) -
caught by deliberately running a bogus module before any real job ever
touched the wrapper, not by a live incident. Also a `chmod +x` mode
difference wedged the box's `git pull --ff-only`, now fixed by tracking
the file as mode 100755 in git.

**Still open:** `HC_PING_URLS` was never filled in - user chose to enable
Phase A without it rather than wait on a healthchecks.io setup, so these
5 jobs currently run with zero automated dead-man alerting. Manual
`journalctl`/`systemctl` checks are the only failure-detection mechanism
until that gets added. Phase B (the 3 Cloudflare-covered jobs -
`daily_analysis`, `daily_grader`, `sensei_eod`) is unaffected by any of
this and stays exactly where blueprint 22 left it - not started, and
explicitly NOT safe to cut over with the same idempotent-overlap
tolerance Phase A used, since `daily_analysis` pushes Telegram and a
double-fire there is the 2026-08-28 five-message incident all over again.

## 31. Blueprint 23 scoped: Plan C Phase 1, portfolio defense layer (2026-08-31)

Scoped, not built. Follows from the 2026-08-30 expansion review (an
Artifact, not a repo file - "Plan C" in conversation shorthand). The
review's headline finding: every buy-side LLM dimension measured to date
has failed, every avoidance dimension has real edge, and none of that
avoidance signal currently reaches the user anywhere - `/portfolio` in
Telegram and the dashboard both show raw P&L only, nothing from
`stocks_to_avoid`, wishlist `skip`, `portfolio_verdicts`, or
`regime_bearish_block`.

`blueprints/23-portfolio-defense-layer.md` scopes a display-only layer:
a new `portfolio_defense_snapshot` table, a new `analyzer/portfolio_defense.py`
that cross-references live holdings/wishlist against the three existing
signal sources (reusing `paper_trader._avoid_set`/`_bearish_block`
directly rather than re-deriving the same membership logic a third time),
wired into `daily_grader.yml`, surfaced in both Telegram's
`portfolio`/`wishlist` commands and the dashboard's portfolio page. Every
status shown must trace to a real `reason` string already written by the
model - explicitly constrained against fabricating new reasoning text or
defaulting a missing signal to a false "clear."

Deliberately scoped narrower than the expansion review's own Phase 1
description ("defensive-only backtest reaches DSR above zero on 20+
closed trades") - that gate belongs to the trading-side enforcement
already shipped in blueprint 21 Phases 1 and 4, not to a pure display
feature that never opens or closes a trade itself. Not yet built - next
step is running the blueprint.

## 32. Blueprint 23 built and verified live: portfolio defense layer (2026-08-31)

Built and shipped the same day it was scoped (section 31). New
`analyzer/portfolio_defense.py`, wired into `analyzer/grader.py`'s
`__main__` via `_run_portfolio_defense()` (soft-fail, same pattern as
`_run_paper_trader`) - no workflow YAML change needed, it rides the
existing `python -m analyzer.grader` step in `daily_grader.yml`. Surfaced
in `bot/telegram_bot.py`'s `portfolio()`/`wishlist()` handlers and in
`web/app/portfolio/`, `web/app/wishlist/` (new shared `DefensePill.tsx`
component, uses the existing `pill-loss`/`pill-warn` tokens - no new
color introduced).

**Real bug found and fixed by testing before this shipped:** `target`/
`stop_loss` from `portfolio_verdicts` came back `None` on every row.
Root cause: the LLM writes these as free text despite the prompt's own
"MUST be concrete numeric INR" instruction - GROWW's real verdict entry
had `target: "₹205"`, and `float("₹205")` raises outright. Fixed with a
regex extractor that strips thousands-comma separators first, then pulls
the first numeric token (handles a currency symbol, a `"360-400"` range
taking the low end, and comma-grouped values like `"₹12,500"`).
Unit-verified against all of these plus `None`/int/float/empty-string
inputs before re-running against live data.

**Verified live end to end, not just code review:**
- `python -m analyzer.portfolio_defense` computed 12 real rows against
  the actual 4 holdings + 8 wishlist tickers. Spot-checked 3 against the
  source `analysis.raw_json` by hand: GROWW's `trim` verdict/reason,
  PWL's `stocks_to_avoid` entry, ADANIPOWER's wishlist `skip` entry - all
  three traced to real text, correctly classified.
- Fail-open path checked: NTPC/VEDL/ATHERENERG all show `no_data`,
  confirmed each genuinely has no avoid/skip/verdict entry anywhere in
  the source row (each only has a `wait` wishlist signal, which is
  correctly neither a red flag nor a green light).
- Simulated the real Telegram `/portfolio` message body against live
  data: regime banner, per-holding P&L, and the correct glyph + real
  reason text under each flagged holding all render as designed.
- `web/`: `npx tsc --noEmit` clean, and a real `npx next build` compiles
  and generates every route successfully including `/portfolio` and
  `/wishlist` - could not verify the rendered page visually since the
  dashboard is owner-auth-walled and this session has no login
  credentials, so build-level verification is the practical ceiling here.

Schema applied live in Supabase by the user (table + index + RLS-enable +
owner-read policy) - hit two real snags worth remembering: the whole
first paste was one transaction, so the placeholder-UUID policy line
failing rolled back the table creation too (had to resubmit the complete
block together once the real UUID was known), and a plain
`create policy ... using (auth.uid() = '<placeholder>')` fails outright
with an invalid-UUID error rather than a permissions error - the
placeholder must never be pasted literally.

## 33. Root-caused and fixed a real ~26min grader stall: uncached, unbatched yfinance calls (2026-08-31)

Found while verifying blueprint 23's real production entrypoint. Dispatched
a fresh `daily_grader.yml` run against the pushed code and watched it stall
~26 minutes on the exact step containing `_run_portfolio_defense()` -
looked at first like the new code might be hanging. It was not.

**Real cause, confirmed by reading the cancelled run's log:** the stall was
inside pre-existing sector-outlook grading, repeatedly failing on the same
handful of NSE sector index tickers (`^CNXAUTO`, `^CNXFMCG`, `^CNXENERGY`,
`^CNXMETAL`, `^CNXREALTY`, `^CNXMEDIA`, `NIFTY_FIN_SERVICE.NS`) with
"possibly delisted; no price data found." Tested all seven directly against
both a recent window and the EXACT failing historical date range
immediately after - every single one resolved cleanly. **The tickers are
not dead** - this was Yahoo's known shared-runner rate limiting (already
documented in section 20) triggered by an existing, real inefficiency:
`grader._session_bounds(ticker, run_at)` re-downloaded a fresh ~20-day
yfinance window on EVERY call, with zero caching, called once per graded
analysis row across all 6 call sites (NIFTY, Sensex, BankNifty, Midcap,
up to ~10 sectors per row, and every real holding/wishlist stock ticker).
With a 90-day lookback, adjacent rows' narrow windows overlap ~95% -
hundreds of redundant, unbatched calls per run, more than enough to trip
Yahoo's rate limiter on a shared GH Actions IP.

**Fixed:** added `_session_hist()`, a per-process cache keyed by ticker -
one wide (120-day-back/8-day-forward) download per unique ticker, sliced
locally per row thereafter. Same approach `backtest.py`'s `HistCache`
already uses for the identical class of problem, just not previously
reused here. A failed/empty result is cached too, so a genuinely dead
ticker (if one ever appears) is attempted once per run, not once per row -
real defense in depth even though today's specific tickers turned out
to be alive.

**Verified live, not just by inspection:** monkey-patched `yf.download`
to count real calls - 3 `_session_bounds()` calls for the same ticker at
different dates now cost exactly 1 download (previously 3), with correct,
distinct results per date. A genuinely fake ticker also costs exactly 1
attempt across 2 calls, returning `None` both times rather than retrying.

**Real-world impact, beyond just this one stall:** this bug has silently
taxed every `daily_grader` run since sector-outlook grading was added, not
just the one caught today - worth watching whether daily_grader's typical
run duration drops materially once this ships. Also directly benefits
blueprint 23's new `_run_portfolio_defense()` hook, which sits right after
this exact code path in `grader.py`'s `__main__` sequence and was blocked
from ever running by the stall, not by anything in its own logic.

## 33a. The caching fix wasn't the whole story - added a job-level timeout backstop too (2026-08-31)

Dispatched a fresh run to verify section 33's caching fix. The
error-spam pattern was gone (real proof the cache works - no more
repeated "possibly delisted" blocks for the same ticker), but the run
still stalled, this time ~51 minutes before being cancelled by hand -
worse than the original ~26 minutes. Reading the log showed why: the
remaining problem is not repeat-call volume, it's that a SINGLE logical
`yf.download()` call can hang for 9-15 minutes under today's network
conditions - confirmed against `TATAMOTORS.NS`, a real, valid, large-cap
NSE stock, not a dead ticker. yfinance's own `timeout=` parameter
defaults to 10s per HTTP request, but that doesn't bound an internal
retry/backoff loop if Yahoo is actively rate-limiting the runner's shared
IP - a single "download" can still take many minutes end to end.

Also noticed in the same log, separate and unrelated: a few clearly
garbage ticker strings (`REALTY.NS`, `FMCG.NS`, `ERROR.NS`) being queried
- not sector symbols (confirmed grader.py's `_normalize_ticker` correctly
passes `^`-prefixed index tickers through unchanged), so these are stray
fragments leaking into a per-stock ticker field from elsewhere, matching
the already-documented JSON-glitch failure mode noted in
`paper_trader.py`'s own comments (neighboring-key spillover on long LLM
responses). Not fixed tonight - real, but a separate, lower-priority
data-quality issue, not the cause of the stall.

**Rather than chase yfinance's internal retry mechanism further, added
the safety net this repo already uses elsewhere:** `daily_grader.yml`'s
`grade` job had NO `timeout-minutes` at all, unlike `alerts_checker.yml`
(5min), `backtest.yml` (15min), `sensei_eod.yml` (60min) which already
have this. Without it, GH's own default job ceiling is 360 minutes - a
degraded-network day could silently burn hours of runner time before
anyone noticed. Added `timeout-minutes: 30`, matching this repo's
existing convention rather than inventing a new one. This converts a
runaway hang into a bounded, dead-man-ping-triggering failure instead of
an indefinite silent stall - does not fix the underlying yfinance/Yahoo
rate-limit interaction, but bounds its blast radius to a known ceiling.

**Real net effect of both section 33 and this fix together:** the
caching fix genuinely reduces call volume (verified: 3 calls for one
ticker now cost 1 download instead of 3) and should measurably shorten
normal-condition runs going forward. The timeout-minutes backstop is
insurance for whatever Yahoo-side conditions caused today's specific
stalls, whether that recurs or was a one-off. Worth watching real
`daily_grader` run durations over the next several days to see the
actual before/after.

## 34. Blueprint 22 Phase B designed: only one of three jobs needs real care (2026-09-01)

Real investigation before writing anything, rather than assuming the
original placeholder plan (treat all 3 jobs with the same extra-careful
staggered cutover) was correct. Checked each job's actual idempotency:

- `analyzer.grader` writes through `_upsert_score()`, an upsert on a
  stable key - grading twice is a no-op. Safe to port the plain Phase A
  way (single `python -m analyzer.grader` per timer fire).
- `analyzer.sensei`'s own workflow comment says it outright: "Sensei
  self-grades before synthesizing, so double runs are idempotent." Same
  safe, plain port.
- `bot.daily_push` has **no staleness check of its own** - the real
  dedup lives entirely in `daily_analysis.yml`'s YAML plumbing (an
  `id: agg` step's `run_if_stale()` output gates a separate
  `if: steps.agg.outputs.ran == 'true'` push step). A naive systemd port
  running both modules as a sequence would lose that gate and reintroduce
  the 2026-08-28 five-message incident through a new path.

**Designed the fix, not yet built:** a new `bot/daily_analysis_runner.py`
that calls `run_if_stale()` and only invokes `push()` if it actually
produced a fresh row - the exact same conditional the GH workflow already
encodes in YAML, expressed as one Python script instead of two steps
plus an `if:`. No changes needed to `aggregator.py` or `daily_push.py`
themselves.

**Real consequence worth recording:** because `run_if_stale()` checks the
database, not workflow-local state, it correctly dedupes regardless of
which machine calls it or how many trigger sources are live at once. This
means Phase B doesn't need a special atomic cutover procedure after all -
it can follow Phase A's exact shape (enable, confirm one real automatic
fire per job, then pull `schedule:`), as long as
`daily_analysis_runner.py` - not a naive two-command sequence - is what
the Oracle timer calls for `daily_analysis`. Full design in
`blueprints/22-cron-to-oracle-migration.md`'s Phase B section.

## 35. Blueprint 24 scoped: Plan C Phase 2, LLM as factor miner (2026-09-01)

Scoped, not built. Follows blueprint 23 (Plan C Phase 1, shipped
2026-08-31). The 2026-08-30 expansion review's second recommendation:
stop asking the LLM to pick a direction (six dimensions tried, all
failed - see section 26/26b) and instead use it to propose testable
factor hypotheses, validated statistically before any capital risk -
the architecture the published literature (AlphaAgent, SIGKDD 2026)
actually shows working, versus the picker-role this project's own data
already disproved.

`blueprints/24-llm-factor-miner.md` scopes a genuinely new but
maximally-reused design: `analyzer/technical.py`'s existing
`compute_signals()` becomes the feature schema (already point-in-time
safe, no changes needed), a new constrained JSON DSL (never executable
code - a hard security boundary, not a style choice) is the factor
representation, and a new `analyzer/factor_lab.py` backtests each
proposal by reusing `backtest.py`'s `HistCache`/`ShadowBook`,
`paper_trader.py`'s friction/cost functions, and `metrics.py`'s
DSR/PBO honesty layer directly - no cost-model or statistics logic
reimplemented. Mining runs weekly (piggybacks specialist_eval's existing
Saturday cadence), and every proposal is logged regardless of outcome,
winners and rejects both.

**Promotion discipline mirrors blueprint 13's LoRA specialist exactly:**
a factor clearing the statistical bar (DSR > 0, 30+ trades, beats the
live baseline) becomes a surfaced candidate for the user to manually
review - it never trades real or paper capital on its own, and wiring a
promoted factor into paper_trader.py's live gate stack is explicitly
separate, future work with its own blueprint, not something this one
does automatically. Not yet built - next step is running the blueprint.

## 36. Blueprint 24 built and run for real: every mined factor correctly rejected (2026-09-01)

Built the same day it was scoped (section 35). `analyzer/factor_lab.py`
(constrained JSON DSL, `validate_factor`/`evaluate_condition`/
`backtest_factor`, reusing `HistCache`/`ShadowBook`/`_open_shadow_trade`/
friction/geometry wholesale) and `analyzer/factor_dispatch.py` (LLM
proposal + per-batch deflated-Sharpe scoring + `mined_factors` logging).

**`factor_lab.py` verified before any LLM was involved.** A hand-written
smoke-test factor (RSI oversold + above sma200) legitimately matched zero
times on 5 large-cap tickers over ~1 year - checked by hand and confirmed
real (RELIANCE genuinely traded 80-100 points below its 200-DMA with RSI
39-50 the whole window, matching this project's own documented
"trend: down" regime findings), not a bug. Widened to 20 tickers and a
looser factor to get real fills: 37 trades, real entry/exit prices and
exit reasons. Spot-checked BHARTIARTL's trade by hand against real
yfinance OHLCV - entry/target dates and prices matched exactly.
`validate_factor()` also verified to reject all 6 classes of malformed
input tested (unknown field, unknown op, bad side, bad horizon, empty
conditions, missing value). Grep-confirmed zero references to
`paper_trades`/`paper_signals`/`eval(` anywhere in either new file.

**Real end-to-end mining run, not just a code-review pass:**
`python -m analyzer.factor_dispatch` against the live OpenRouter chain
and real market data. The LLM (nemotron-3-super, this run's primary)
proposed 5 real, mechanically distinct hypotheses - oversold-near-support
bounce, resistance-rejection short, MACD/trend bearish continuation,
volume-breakout momentum, MACD/trend bullish continuation - all validated
cleanly on the first try (0 rejected for malformed DSL). Each backtested
with 104-237 real trades. **Every single one came back with negative
Sharpe (-1.8 to -5.8) and DSR 0.0 - all correctly rejected.** This is the
honesty layer working exactly as designed: five individually reasonable-
sounding textbook technical patterns, tested with real transaction costs
on real Indian large-cap data, and none of them survive contact with
reality. Consistent with this project's whole audit history (every
buy-side dimension measured to date has failed - section 26/26b) and
exactly the kind of result this blueprint exists to produce rather than
suppress.

**Real bug found and fixed during this same run:** `factor_dispatch.py`'s
own `FACTOR_MINING_PRIMARY` was set to `nemotron-3-super` directly - which
is ALSO the system's sole configured OpenRouter fallback
(`llm_router.FALLBACK_CHAIN`). `_chain()` filters a model out of its own
fallback list if it equals the primary, so this run's fallback chain
came back empty (`fallbacks: []`) - zero redundancy if nemotron rate-
limited. Fixed by defaulting to `None`, which falls through to the
system's real primary/fallback pair (`minimax-m3` -> `nemotron-3-super`),
verified by direct `_chain(None)` call.

**No promotion path exercised yet** (by design - nothing cleared the
bar this run) and none was expected to on a first pass with naive
textbook hypotheses. The real test of the promotion surface (a Telegram
notification + a human manually reviewing a `mined_factors` row) is
still pending a future run that actually produces a `candidate`.

## 37. The real root cause of the grader stalls: dead tickers re-attempted every single day, forever (2026-09-01)

Section 33's caching fix was real and necessary but incomplete - it only
helped WITHIN one run. The actual full picture, found by finally testing
directly against Oracle's own IP (ruling out the GH-Actions-shared-runner-
rate-limit theory entirely - Oracle had been running yfinance-dependent
jobs all day without incident) and reading the failing tickers by name
instead of assuming they were just slow: `SFTBY`, `HMC`, `PINS` are real
US ADRs with no NSE listing to fall back to, and `RANDK.NS`/`VLT.NS` are
dead `top_performer`/`worst_performer` picks from 2026-06-20. All of them
sit inside `grade_all(lookback_days=90)`'s trailing window and predate
`aggregator.py`'s own US-ADR filter (`_is_indian_listing`, added later) -
confirmed by searching the full 90-day window by date, not just recent
rows, and finding them in real historical `wishlist_signals`/
`wishlist_outlooks_1d`/`top_performers`/`worst_performers` entries from
2026-06-05, 06-09, and 06-20.

**The real bug:** `_session_hist()`'s per-process cache (section 33)
starts empty every single day - a fresh `python -m analyzer.grader`
process has no memory of yesterday's failures. Every day, forever, as
long as these rows stay inside the 90-day window, grader re-attempts a
real yfinance call for tickers that will NEVER resolve. This is the
actual structural cause of the long stalls, independent of whatever
degree of real Yahoo-side slowness was also happening on top of it that
night.

**Fixed:** a new `dead_tickers` table persists a failure across runs.
`_session_hist()` checks it before ever calling yfinance; a ticker
failed within the last `DEAD_TICKER_RETRY_DAYS` (30) is skipped with
zero network calls. A success clears any existing dead-ticker row
(self-healing, not a permanent blacklist - a transient failure or a
genuine relisting won't stay stuck). No read policy needed (RLS enabled,
same as `ticker_enrichment`) - purely an internal optimization cache.

**Verified live, not just by inspection:** a fresh Python process (no
in-memory cache) correctly returned `None` for `SFTBY` with **zero**
`yf.download` calls, confirmed by monkey-patching and counting - proof
the persistent skip works across process boundaries, not just within
one run. Pre-seeded all 5 currently-known dead tickers
(`SFTBY.NS`/`HMC.NS`/`PINS.NS`/`RANDK.NS`/`VLT.NS`) directly rather than
waiting for one more real failure cycle each, since they'd already
failed provably many times tonight.

**Real lesson worth keeping:** the original diagnosis (section 33,
"Yahoo's shared-runner rate limiting") was plausible, cited real
precedent (section 20), and was WRONG - or at least badly incomplete.
The thing that actually found the real cause was running the identical
code from a second, independent IP (Oracle) and treating a repeated
identical failure as a lead to chase by name, not a rate-limit signature
to explain away. Matches this project's own stated discipline
("verify against real data, don't trust the first plausible story") -
just a case where that discipline needed a second pass to actually land.

## 38. Second uncached yfinance path found in the same diagnostic: paper_trader.py's own functions (2026-09-01)

Section 37's fix was real and verified, but a full timed re-run from
Oracle (`time python -m analyzer.grader`, fix live) still ran the full
15-minute timeout, with `TATAMOTORS.NS` - a real, valid, heavily-traded
NSE stock, not a dead ticker - failing repeatedly within the SAME run.
Confirmed the dead_tickers fix itself was NOT the bug (direct call-
counted test showed zero yfinance calls for an already-known-dead
ticker) - a second, separate, previously-unexamined uncached path was
the remaining cause.

**Found:** `paper_trader._yf_realized_sigma()` and
`paper_trader._yf_avg_turnover()` (called via `_run_paper_trader()`
inside the same `grader.py` `__main__` sequence) had zero caching at
all - a fresh `yf.download()` on every single call, and
`eval_signals()` can evaluate the same ticker multiple times per pass
(across stock_analyst/holding/wishlist sources and the 3-day lookback
window each uses). Verified all 8 real call sites use the same default
`days=20`, so a ticker-only cache key is safe.

**Fixed:** added a same-run, per-process cache to both functions -
deliberately NOT the persistent cross-run `dead_tickers` treatment
`grader._session_hist()` has, since this path evaluates real, currently
tradeable stocks; a transient Yahoo hiccup here should not suppress
evaluating a genuinely live stock for 30 days the way it correctly does
for a permanently dead historical ticker. Verified live by call-
counting: 2 calls to each function for the same ticker now cost exactly
1 real download each, correctly deduped.

**Real, separate finding surfaced by this fix, not caused by it:**
`TATAMOTORS.NS` is genuinely 404ing on Yahoo right now, live, verified
by a direct isolated call outside any grader context - this is outside
this project's control (a real Yahoo-side data gap for a major, valid,
massively liquid stock, not a code bug). Worth rechecking in a day or
two; if it persists, it may be worth its own investigation, but nothing
in this codebase can fix Yahoo's own data availability for a real
ticker.

## 39. The actual complete fix: 4 more uncached yfinance functions in grader.py (2026-09-01)

Section 38's fix was also real and verified, but a third full timed
re-run STILL hit the 15-minute timeout, with `VLT.NS` (an already
pre-seeded, confirmed-dead ticker) still failing repeatedly. Direct
isolated testing had already proven both prior fixes correct in
isolation, which meant a THIRD, still-unexamined path had to exist.

**Found by grepping every yf.download/yf.Ticker call site in
grader.py directly** rather than continuing to trace call stacks:
`_close_on_or_after()`, `_close_n_sessions_later()`,
`_vol_regime_ratio()`, and `_ohlc_walk()` were four more completely
separate, uncached functions - grading exactly the
top_performer/worst_performer/pick_tp_sl-family dimensions where the
known dead tickers (`VLT.NS`, `RANDK.NS`) actually live. Neither of the
two earlier fixes touched these at all, since they call yfinance
directly rather than through `_session_bounds`/`_session_hist`.

**Fixed:** all four now slice from `_session_hist()`'s shared per-ticker
cache instead of running their own separate `yf.download()`. This gives
every one of them the SAME dead_tickers persistence for free - a ticker
these functions were failing on gets recognized as dead by the exact
same mechanism section 37 built, with no per-function special-casing
needed. Confirmed by grep: grader.py now has exactly one `yf.download`
call site in the whole file (`_session_hist` itself).

**Verified live:** direct calls to all three ticker-taking functions for
the already-known-dead `VLT.NS` returned safe empty results with ZERO
yfinance calls. `_vol_regime_ratio` (the one index-only function, uses
`^NSEI`, a real live ticker) still correctly fetches and returns a real
computed ratio.

**The actual lesson from this whole multi-round chase:** each fix
tonight was independently real, correctly verified, and still
INCOMPLETE, because `grep`-ing for every call site was the thing that
finally closed it - not tracing one more call stack or building one more
theory. Should have been the first move, not roughly the fourth.

---

## 40. Grader stall genuinely closed, plus two more fixes found chasing it (2026-09-03)

A 4th timed re-run (after section 39's fix) got cut off mid-run by an
SSH connection reset before it could report a result - inconclusive,
not a failure. Its partial output surfaced a real, separate bug before
the reset: `_normalize_ticker()` didn't strip internal whitespace. A
malformed raw ticker with a space in it (e.g. `"HINDUSTAN ZINC"`, not a
real NSE symbol) survived normalization as `"HINDUSTAN ZINC.NS"`, and
`yf.download()` given a *string* (not a list) splits on whitespace
internally - silently querying it as TWO separate tickers
(`"HINDUSTAN"` + `"ZINC.NS"`) instead of one clean 404. This defeated
the dead_tickers cache (each malformed variant got its own row, never
converging) and risked misattributed data if either fragment happened
to collide with a real symbol. **Fixed:** `_normalize_ticker()` now
collapses all whitespace before suffixing. Shipped and deployed.

**5th timed run, clean: `EXIT_CODE:0`, real 6m41.9s.** Down from
15-30 minute timeouts. The stall - all three root causes from sections
37-39 plus this whitespace bug - is genuinely closed. This run also
finally gave direct, real proof that `_run_portfolio_defense()` fires
correctly inside a complete `analyzer.grader` run
(`portfolio_defense: computed 12 rows` in the output), closing
blueprint 23's last open verification gap.

**A second, unrelated bug surfaced in the same output:**
`Embedding pass skipped: sentence-transformers not installed`.
`requirements-embed.txt` was deliberately GH-Actions-only by design
(comment in the file: Render's 512MB dyno can't fit torch+transformers,
so embedding runs off-dyno on GH's ~7GB runners and degrades to Phase 0
score-based exemplar selection when the package is absent). But
blueprint 22 Phase A moved `daily_grader` (which does the embed
backfill) off GH Actions onto Oracle, and Oracle's `setup.sh` only ever
installed `requirements.txt` - so since the 2026-08-31 cutover, RAG
Phase 1 embedding had been silently degrading to Phase 0 on Oracle too,
the exact same failure mode Render always had, just not by design this
time. Checked Oracle's actual headroom before fixing: 23GB RAM / 4 CPU
/ 187GB disk free, far more than the 7GB GH runners this was scoped
for. **Fixed:** `setup.sh` now also installs `requirements-embed.txt`;
installed live on the box to not wait for a future re-provision.
**Verified live:** re-ran the grader, model loaded
(`BAAI/bge-base-en-v1.5`), `backfill: encoded=195 skipped=0 in 47.6s`.
Real embeddings are generating on Oracle now.

This also retroactively colors section 29's RAG Phase 1 A/B review
(inconclusive, left enabled 2026-08-30): if the embed backfill had
already been silently no-op-ing on Oracle before that review (cutover
was 2026-08-31, so probably not yet at review time, but worth noting
the two are now adjacent in the timeline) - not re-litigating that
verdict, just flagging the adjacency for whoever revisits it.

---

## Changelog (append new entries at top, dated)

- **2026-09-03 (latest)** - Grader stall genuinely closed: found and
  fixed a 4th bug (`_normalize_ticker` not stripping internal
  whitespace, which made `yf.download()` silently split one malformed
  ticker into two), then a clean 5th timed run at 6m41.9s (down from
  15-30min timeouts) with `EXIT_CODE:0`. Same run proved
  `_run_portfolio_defense()` fires live inside a real grader run,
  closing blueprint 23's last verification gap. Also found and fixed a
  separate bug hiding in the same output: Oracle's `setup.sh` never
  installed `requirements-embed.txt` (GH-Actions-only by original
  design), so RAG Phase 1 embedding had been silently degrading to
  Phase 0 since the Oracle cutover. Fixed setup.sh, installed live on
  the box (23GB/4CPU, plenty of headroom), verified real embeddings
  generating (`encoded=195 skipped=0`). See section 40.
- **2026-09-01 (final)** - Found and fixed the actual complete set:
  `_close_on_or_after`/`_close_n_sessions_later`/`_vol_regime_ratio`/
  `_ohlc_walk` in grader.py were four more uncached yfinance functions,
  grading exactly the top/worst-performer dimensions where the dead
  tickers live - neither prior fix touched them since they never went
  through `_session_hist`. Found by grepping every yf.download call
  site directly, which should have been the first move rather than the
  fourth. All four now route through `_session_hist`'s shared cache;
  grader.py now has exactly one yf.download call site in the whole
  file. Verified live: zero calls for the already-known-dead VLT.NS
  across all three ticker-taking functions. See section 39.
- **2026-09-01 (yet later)** - Found and fixed a SECOND uncached
  yfinance path the same night: paper_trader._yf_realized_sigma()/
  _yf_avg_turnover() had zero caching at all, called potentially many
  times per eval_signals() pass for the same ticker. A real timed
  re-run (fix from section 37 live) still hit the full 15-min timeout,
  with TATAMOTORS.NS - a genuine, valid, heavily-traded stock - failing
  repeatedly. Fixed with a same-run cache (deliberately not the
  persistent cross-run treatment section 37 used, since this evaluates
  real currently-tradeable stocks). Verified live: 2 calls now cost 1
  download, correctly deduped. Separately confirmed TATAMOTORS.NS is
  genuinely 404ing on Yahoo right now - real, outside this project's
  control, not a code bug. See section 38.
- **2026-09-01 (even later still)** - Found and fixed the REAL root
  cause behind the grader stalls (section 33's fix was real but
  incomplete). Testing the identical code from Oracle's own IP - which
  had been running yfinance jobs all day without incident - ruled out
  GH-Actions-rate-limiting entirely. The real cause: historical analysis
  rows inside grade_all's 90-day window reference tickers
  (SFTBY/HMC/PINS - real US ADRs with no NSE listing; RANDK.NS/VLT.NS -
  dead picks from 2026-06-20) that will never resolve, and the prior
  fix's cache only held within one run - every day, forever, grader
  re-attempted them from scratch. New dead_tickers table persists a
  failure across runs (self-healing, 30-day retry, not a permanent
  blacklist). Verified live: a fresh process made zero yfinance calls
  for an already-known-dead ticker. All 5 currently-known offenders
  pre-seeded directly. See section 37.
- **2026-09-01 (latest)** - Wired blueprint 24's weekly trigger:
  `arcemx-factor-mining` on the Oracle box (Sat 03:30 UTC = 09:00 IST,
  piggybacking specialist_eval's cadence per the blueprint's own plan,
  offset 30min). Wired directly onto Oracle rather than a new GH Actions
  workflow - the project's actual trajectory, matching Phase A's proven
  pattern. Verified live with a real manual trigger from the box itself:
  1min 50s wall clock, 5 more real distinct candidates proposed and
  correctly rejected (10 total rows now), and the earlier redundancy
  fix confirmed working for real - this run's fallback chain showed
  `['nemotron-3-super']` instead of the empty list the bug produced.
- **2026-09-01 (even later)** - Built blueprint 24 and ran it for real
  the same day it was scoped. factor_lab.py's backtest mechanism
  verified by hand (a smoke-test factor's zero matches confirmed real,
  not a bug; a real trade spot-checked against actual yfinance OHLCV;
  validation tested against 6 classes of malformed input). Real mining
  run: LLM proposed 5 mechanically distinct, well-formed hypotheses, all
  backtested with 104-237 real trades each, and every single one came
  back negative Sharpe / DSR 0.0 - correctly rejected. The honesty layer
  working as designed, not a bug. Found and fixed a real redundancy gap
  the same run: factor_dispatch's chosen primary model was also the
  system's sole fallback, so _chain() zeroed out its own fallback list -
  fixed by defaulting to the system's real primary/fallback pair. See
  section 36.
- **2026-09-01 (later)** - Scoped blueprint 24 (Plan C Phase 2: LLM as
  factor miner). New constrained JSON DSL for LLM-proposed factors
  (never executable code), backtested by reusing HistCache/ShadowBook/
  friction/metrics wholesale rather than reimplementing any of it.
  Promotion discipline mirrors the LoRA specialist's manual-only rule -
  a mined factor never trades capital automatically. Not yet built. See
  section 35.
- **2026-09-01** - Designed blueprint 22 Phase B (not yet built). Real
  investigation found only daily_analysis needs special care - the
  push-dedup logic lives entirely in GH Actions YAML plumbing today
  (`if: steps.agg.outputs.ran`), not in any Python module, so a naive
  systemd port would silently lose it and reintroduce the 2026-08-28
  five-message incident. Designed a new `bot/daily_analysis_runner.py`
  to carry that same conditional as one script. daily_grader and
  sensei_eod are both already safely idempotent (verified against real
  upsert/self-grading logic) and can port the plain Phase A way. See
  section 34.
- **2026-08-31 (latest)** - Section 33's caching fix verified real (no
  more repeat "possibly delisted" spam), but a follow-up run still
  stalled ~51min - the remaining problem is a single yf.download() call
  hanging 9-15min under today's network conditions, confirmed against a
  real valid ticker (TATAMOTORS.NS), not a dead one. Added
  `timeout-minutes: 30` to daily_grader.yml's grade job - it was the only
  heavy job in this repo missing this safety net that alerts_checker/
  backtest/sensei_eod already have. Bounds the blast radius rather than
  fixing the underlying Yahoo rate-limit interaction. See section 33a.
- **2026-08-31 (even later)** - Root-caused and fixed a real ~26min
  grader stall found while verifying blueprint 23's real production
  entrypoint. Not a new bug from today's code - a pre-existing
  inefficiency in grader._session_bounds() (uncached, unbatched yfinance
  downloads, once per graded row across 6 call sites) that tripped
  Yahoo's shared-runner rate limiting on ~90 days of heavily-overlapping
  sector-index requests. Fixed with a per-process ticker cache
  (_session_hist()), mirroring backtest.py's existing HistCache pattern.
  Verified live by call-counting: 3 calls for one ticker now cost 1
  download instead of 3, with correct results. Likely been silently
  taxing every daily_grader run since sector grading was added. See
  section 33.
- **2026-08-31 (latest)** - Built and shipped blueprint 23 (portfolio
  defense layer), same day it was scoped. New analyzer/portfolio_defense.py,
  wired into grader.py (no workflow YAML change needed), surfaced in
  Telegram's /portfolio and /wishlist and in the dashboard's matching
  pages via a new shared DefensePill component. Real bug found and fixed
  before shipping: target/stop_loss parsing silently dropped every value
  because the LLM writes them with a currency symbol
  (float("₹205") raises) - fixed with a proper numeric extractor,
  unit-tested, then re-verified live. Verified end to end: 12 real rows
  computed against actual holdings/wishlist, 3 spot-checked by hand
  against the source analysis row, fail-open path confirmed correct,
  full Telegram message body simulated against live data, dashboard
  type-checks clean and a real production build succeeds. See section 32.
- **2026-08-31 (later)** - Scoped blueprint 23 (Plan C Phase 1: portfolio
  defense layer) - a display-only feature surfacing the three signal
  sources with proven avoidance edge (stocks_to_avoid, wishlist skip,
  portfolio_verdicts) plus regime_bearish_block against real holdings in
  both Telegram and the dashboard, none of which currently reaches the
  user anywhere. Reuses paper_trader's existing avoid-set/bearish-block
  functions rather than re-deriving them. Not yet built. See section 31.
- **2026-08-31** - Blueprint 22 Phase A fully cut over: all 5 jobs
  confirmed firing cleanly on Oracle's systemd timers with real work done
  (news fetched, INDmoney synced, candidates dispatched, alerts checked),
  then GH Actions' `schedule:` trigger removed from all 5 workflow YAMLs
  (`workflow_dispatch` kept as manual fallback). Found live production
  evidence GH's native schedule had already gone silent on 4 of 5 jobs
  independent of this migration - `daily_sync`/`alerts_checker` hadn't
  fired via schedule in 3 days, `stock_analyst_dispatch` had never fired
  via schedule successfully at all. Commit `8638d14`. `HC_PING_URLS` still
  not configured (user chose to proceed without it) - these 5 jobs
  currently have no automated dead-man alerting. See §30.
- **2026-08-30 (even later still)** - Did the overdue RAG Phase 1 A/B
  review (blueprint 14) - 24 days late, file untouched since activation.
  Pulled the full accuracy_summary trend since 2026-07-16, not just the
  latest snapshot: a naive baseline-vs-today read looks like a win
  (direction_1d +16.76pp), but the control dimension (insight_quality,
  which RAG doesn't target) moved in the identical shape - dip through
  August, recovery by month end - across all three dimensions together.
  That is regime noise, not a RAG effect. Had the review run on its
  original 2026-08-06 date it would have shown the opposite (all three
  below baseline). **Verdict: inconclusive, not a proven win.**
  Recommendation: leave RAG_PHASE1_ENABLED on (₹0 marginal cost, no
  evidence of harm, sunk re-embed work already reused regardless) rather
  than revert on an inconclusive result. Deleted
  `blueprints/_pending_ab_rag.md` per its own convention now that the
  review is written up; updated `ROADMAP.md`'s Wave 3 row. See §29.
- **2026-08-30 (latest)** - Blueprint 22 **Phase A built and installed on
  the box, timers deliberately NOT yet enabled.** Added
  `deploy/oracle/run_job.sh` (shared wrapper) plus service/timer pairs for
  the 5 jobs the Cloudflare dispatcher never covered (hourly_news,
  daily_prices, daily_sync, alerts_checker, stock_analyst_dispatch), and
  a `git-pull` timer (every 5 min, `--ff-only`) so jobs always run against
  recent code. Box confirmed `Etc/UTC`, so every cron string ported
  directly; all 6 `OnCalendar=` expressions validated with
  `systemd-analyze calendar` on the real box, including the 15-min
  stepping on alerts_checker. Verified live end to end:
  `arcemx-daily-sync.service` ran clean against real INDmoney data
  (4 holdings, 9 watchlist, token refresh, Supabase write, exit 0).

  **Two real bugs found by testing rather than trusting the code:**
  1. `run_job.sh` reported **success on every failed job**. The loop used
     `if ! "$PY" -m "$module"; then rc=$?`, where `$?` is the exit status
     of the `!` negation (always 0), not the module's - it literally
     printed `FAILED (exit 0)` and exited 0, which would have pinged
     Healthchecks with SUCCESS on every failure. Same green-but-did-
     nothing class as the specialist eval bug (§23a). Found by running a
     bogus module against the wrapper on purpose. Fixed: run bare, read
     `$?` on the next line.
  2. `setup.sh`'s `chmod +x run_job.sh` created a file-mode difference
     against the committed 644, which made `git pull --ff-only` on the
     box **abort** instead of fast-forwarding - so the box silently kept
     running the stale, still-broken wrapper even after the fix was
     pushed. Fixed by tracking the file as mode 100755 in git, making
     that chmod a true no-op. Worth remembering: a mode-only local change
     is enough to wedge the box's auto-pull, and it fails loudly in the
     journal but silently in effect.

  **Blocked on two secrets before the timers can be enabled**, both
  recoverable from their own dashboards (neither is in local `.env` or
  readable back from GH Secrets, which are write-only via API):
  `GNEWS_API_KEY` from gnews.io (optional - `fetchers/news.py` works on
  RSS alone without it) and `HC_PING_URLS` from healthchecks.io (a JSON
  map of job name to ping URL; a missing key just means that job runs
  unmonitored). Both added to `deploy/oracle/arcemx.env.template` with
  the exact expected shape. Timers stay disabled until these are in
  `/etc/arcemx.env` - a job going live unmonitored is the exact failure
  mode the dead-man switch exists to prevent. The GH Actions `schedule:`
  blocks are ALSO still in place on purpose, so nothing double-fires;
  they get removed only after the timers run clean for a few days.
- **2026-08-30 (even later)** - Scoped the long-stated cron-to-Oracle
  migration (see §8/§28's "future step, not started" and §18's Wave
  status). Wrote `blueprints/22-cron-to-oracle-migration.md`: a scope +
  design document, not yet approved for build - phased (A: 5 jobs with
  no Cloudflare coverage today, lowest risk; B: the 3 Cloudflare-covered
  business-critical jobs, after A proves stable; C: weekly specialist_eval
  cleanup), reuses the existing `arcemx-bot.service` systemd pattern +
  `/etc/arcemx.env`, ports the currently-YAML-only `HC_PING_URLS`
  dead-man-ping logic into a shared wrapper script (doesn't exist in any
  Python module today, would otherwise be silently lost).

  **Two real findings while scoping, not yet acted on:** (1) the
  Cloudflare Worker's `CRON_TO_WORKFLOW` only covers 3 of the repo's 10
  scheduled workflows (`daily_analysis`, `daily_grader`, `sensei_eod`) -
  the other 7 (hourly_news, daily_prices, daily_sync, alerts_checker,
  stock_analyst_dispatch, specialist_eval) rely purely on GH's native
  `schedule:` with zero reliable-clock backup, previously undocumented as
  a specific count anywhere in this repo. (2) The Worker's own
  `CRON_TO_WORKFLOW` maps `sensei_eod.yml` to `"35 14 * * 1-5"`, but the
  workflow YAML's own schedule is `"41 14 * * 1-5"` - a 6-minute mismatch
  between the two files. Whether the Cloudflare dashboard's actual live
  trigger is 35 or 41 is unconfirmed from repo state alone (dashboard
  config isn't in the repo) - harmless either way (nothing depends on the
  exact minute) but worth resolving during Phase B, not urgent now.

  Explicitly flagged in the blueprint: this consolidates scheduling onto
  the Oracle box as a second single-point-of-failure (today, a box outage
  only silences the bot; after this, it stops the whole pipeline) -
  stated plainly as a tradeoff to weigh, not buried. Awaiting user
  go-ahead before Phase A starts.
- **2026-08-30 (later)** - Re-checked the paper trader stall via real
  `paper_trades` queries: still 27 closed / 0 open, unchanged since
  2026-08-14 (16 days now, spanning Phase 0/1/5 shipping). Confirmed via
  4 recent on-time grader run logs that `paper_trader.eval_signals()` is
  NOT broken - it fires every time, logs clean, enters 0 with benign skip
  reasons (`not_buy`/`low_conf`/`avoid_or_skip_listed`, the last one
  confirming Phase 1's negative filter is live). Real structural reason:
  all 27 historical trades came from `top_performer`/`worst_performer`
  (checked `source_kind` on recent closes), both disabled by Phase 0/1;
  the remaining live sources haven't produced an entry yet
  (`stock_analyst` still 0/19 buy-rated, outlook sources cleared zero
  gates across every run checked). Expected continuation of the known
  state, not a new problem.

  **Side finding, real and separate:** one native `schedule:`-triggered
  grader run (`33212699538`, fired 2026-08-28T21:28 UTC) landed after
  midnight IST and hit `is_trading_day(datetime.now(IST).date())` against
  the WRONG calendar day (the next one, a Saturday) - exited via
  `SystemExit(0)` before running grading, paper_trader, or anything else
  in `grader.py`'s `__main__` block. Same drift class already known from
  §28 (GH's native schedule can land hours late on free tier); this is a
  fresh concrete instance of it silently skipping the ENTIRE grader
  pipeline, not just producing a late push. The Cloudflare-dispatched
  `workflow_dispatch` path is unaffected when it lands on time (checked
  2 same-day runs, both ran clean).

  **Fixed same session:** `grader.py`'s `__main__` gate now also accepts
  yesterday having been a trading day, but ONLY before 06:00 IST -
  narrow enough that a genuine new day's run (which would never
  legitimately fire that early) can't be misread as a late-drifted one.
  Sanity-simulated against both real cases: the actual drifted run
  (Saturday 02:58 IST, yesterday=Friday=trading day) now correctly
  proceeds; today's genuine Sunday 08:20 IST case (yesterday=Saturday=
  not a trading day either) still correctly skips. `aggregator.py`'s own
  `is_trading_day` call (run_if_stale, 08:20 IST target) deliberately
  left untouched - low exposure (needs ~24h drift, not ~7h, to cross
  midnight) and semantically different (it fetches a LIVE intraday
  snapshot; "running it for yesterday" would fetch today's live data
  mislabeled as yesterday's, which is wrong in a different way than the
  bug it would be fixing).
- **2026-08-30** - Checked whether the Cloudflare Worker dispatcher's
  natural 08:20 IST trigger fired cleanly today (the real test from the
  2026-08-28 dedup incident, see §28) - could not use the Cloudflare
  dashboard directly (no authenticated Cloudflare MCP this session,
  browser automation against it caused instability last time it was
  tried). Checked via `gh run list` instead: one clean `workflow_dispatch`
  run at 02:50 UTC (08:20 IST), success, no duplicate spam. But the log
  itself (`gh run view --log`) shows `Not an NSE trading day
  (weekend/holiday); skipping run` - **2026-08-30 is a Sunday**, so
  `run_if_stale()` correctly no-op'd. The dispatcher is confirmed alive
  and firing on schedule, but the real end-to-end test (does a live
  trading day complete clean, no dupes) still needs an actual weekday -
  **check again after Monday 2026-08-31's run.**
- **2026-08-29 (latest)** - Blueprint 21 Phase 4: built `regime_bearish_block`
  (was only planned, confirmed unbuilt via grep before starting). Env-gated
  `BEARISH_BLOCK_ON` flag, mirrored in `paper_trader.py` (once-per-pass,
  latest `analysis` row) and `backtest.py` (no-lookahead checkpoint list).
  Blocks new LONG entries when market_mood/nifty_outlook reads bearish.
  Backtest id=11: 29/1,869 blocked, trade count 5->3, win rate
  40.0%->66.67%, net P&L flipped positive for the first time ever
  (+₹17.66). Real but n=3 and same 4-day window as every prior run - not
  over-reading it, blueprint 21 itself flags this exact signal as not yet
  time-stable. Live paper_trader.py path deliberately not manually
  exercised (would write real production rows) - verify via tomorrow's
  scheduled cron + a Supabase check instead. See §26b.
- **2026-08-29 (even later)** - Blueprint 21 Phases 2+3: ran the fresh
  Phase 3 backtest same day as Phase 5. Confirmed via direct Supabase
  query first that all 19 `stock_analyst` rows ever written are rated
  hold/sell (zero buy), so the result was predictable before running -
  ran it anyway for the formal record. `backtest_runs` id=10: identical
  to id=9 in every number (5 trades, 40.0% win, Sharpe -10.663, DD 0.29%,
  net -₹133.18, DSR 0.0). Phase 2 answered by the same run:
  `cost_dominated` is 18/1,869 (~1%), near zero - `COST_TO_PROFIT_MAX`
  left unchanged. Not a clean Phase 3 pass (DSR still 0, net still
  negative) but with a clean documented reason, and nothing regressed -
  not reverting. See §26b.
- **2026-08-29 (later)** - Blueprint 21 Phase 5: ruled out `portfolio_
  verdicts` "add" as a buy signal (t=+0.78, noise - the aggregate score
  was driven by "hold" instead) and confirmed `long_term_picks` is a
  dead prompt field. Built `analyzer/stock_analyst_dispatch.py` +
  `stock_analyst_dispatch.yml` to systematically seed the already-wired
  but data-starved `stock_analyst` path (13 rows ever before this) with
  6 fresh technical-screen candidates/day. Verified live: 6/6 dispatched,
  5/6 completed with real ratings. See §26a.
- **2026-08-29** - Discovered and fixed the specialist eval pipeline has
  been fully broken since it was built (2026-08-15) - scored 0 real
  predictions on every run despite showing green in CI. Two bugs: a dead
  `-cnv` CLI flag (llama.cpp removed it upstream) that `run_llama()` never
  detected because it didn't check returncode/stderr, and a missing
  `yfinance` dependency in the workflow that then crashed the whole batch
  once the first bug was fixed (score_prediction() wasn't exception-safe
  per-target). Reproduced live on the newly-migrated Oracle box against
  the real specialist-v2 GGUF to find both. Verified fully fixed:
  `scored 33/33` on a real run. Commits `3c5913f`, `a83ea08`. See §23a.
- **2026-08-28 (night)** - Root-caused and fixed a 5-Telegram-messages-in-
  one-day incident: `daily_analysis.yml`'s `workflow_dispatch` had no
  dedup, so every dispatch (manual, Worker, bot) force-ran and pushed
  regardless of staleness. Added an explicit `force` input, default false
  (commit `af53825`). Confirmed live: Cloudflare Worker cron triggers match
  the code exactly (ruled out), Worker Logs were Disabled (now Enabled).
  Reconfirmed the Oracle migration plan includes eventually moving cron
  scheduling itself onto the VM - see §8, §28.
- **2026-08-28 (evening)** - Shipped blueprint 21 Phase 0+1 (disabled
  top_performer/worst_performer as trade sources, added stocks_to_avoid +
  wishlist-skip negative filters) after catching and correcting a real
  error in the same day's earlier audit - see §26. Also investigated a
  missed daily Telegram push: no GH Actions run fired at all today,
  manually dispatched to recover it, root cause narrowed to the
  Cloudflare cron-dispatcher but not confirmed (no Cloudflare access this
  session) - see §28.
- **2026-08-28 (later)** - Ran a full skill audit over all 4,310 graded
  `prediction_scores` rows to root-cause the 20% win rate. Found the traded
  signal (`top_performer_1d`) has persistently negative alpha, conviction
  tiers carry no information, model skill rises monotonically with horizon
  (60-session picks t=+5.71 vs 10-session t=-1.96), none of the skilled
  long-horizon signals are traded at all, and 1-day trading is
  arithmetically unprofitable at this account size (cost hurdle 2.5-4.5x
  the signal). Wrote `blueprints/21-horizon-pivot.md` with the fix plan.
  See §26. Also shipped two cost-structure fixes with a mixed, honestly
  recorded result - see §27.
- **2026-08-28** - Reddit sentiment fully rebuilt on Apify after
  discovering Reddit's own OAuth app approval is gated shut (Responsible
  Builder Policy, Nov 2025). Root-caused and fixed a false-timeout bug
  from concurrent `urllib` connections (switched to async poll pattern).
  Verified live: 40/40 posts, all 4 subreddits, ~$4.80/month real cost,
  inside Apify's free credit. Also researched and rejected Apify-hosted
  Twitter scraping the same day (doesn't reduce X's legal risk, priced
  punitively on free tier). Commit `905d417`. See §25 for full detail.
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

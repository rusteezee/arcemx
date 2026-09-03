# Blueprint 23: Portfolio Defense Layer (Plan C Phase 1) - BUILT AND VERIFIED LIVE 2026-08-31

See `KNOWLEDGE_BASE.md` section 32 for full build/verification detail, including a real bug found and fixed (target/stop_loss numeric parsing) and the exact Supabase migration snags hit.

4th verification path (the real GH-Actions-equivalent entrypoint, `python -m analyzer.grader` end to end on Oracle) was blocked for several days by an unrelated grader stall - see KNOWLEDGE_BASE.md sections 33/37/38/39/40. Closed 2026-09-03: a clean timed run confirmed `_run_portfolio_defense()` fires correctly inside a real, complete grader run (`portfolio_defense: computed 12 rows`). All four verification paths now pass.

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(cross-references data that already exists, no new LLM calls, no new
trading logic - assembly and display work, well-scoped)

## GOAL

Every avoidance signal this project has ever measured with real edge -
`stocks_to_avoid` (t=+7.68), wishlist `skip` (t=-6.97), `portfolio_verdicts`
`hold` (t=+4.98), and `regime_bearish_block` (backtest id=11: win rate
40.0%->66.67%, first-ever positive net P&L) - already exists, is already
computed daily, and is currently invisible to the user. `/portfolio` in
Telegram shows raw P&L only. The dashboard's portfolio page shows the same.
None of the defensive signal reaches the one place the user actually
looks at their real holdings.

When this ships: every real holding and wishlist ticker shows a status
(clear / caution / avoid) with the actual reason text the model already
wrote, refreshed daily, visible in both Telegram and the dashboard. This
is a display layer only - it does not open, close, or block any trade.
The trading-side enforcement of these same signals already exists and
shipped separately (blueprint 21 Phases 1 and 4).

## CONTEXT THE BUILDER NEEDS

**This is Plan C Phase 1**, from the 2026-08-30 expansion research review
(published as an Artifact, not a repo file - the roadmap it proposed is
being scoped into real blueprints one phase at a time, starting here).
The review's own finding: every buy-side LLM dimension measured to date
has failed (`top_performer_1d` t=-2.56 on n=792, `stock_analyst` buy
rating 0/19 ever, etc. - see `KNOWLEDGE_BASE.md` section 26/26b), while
every avoidance dimension has real, repeatedly-confirmed edge. The
system's proven skill is telling the user what NOT to hold, not what to
buy. This blueprint makes that the visible product instead of a buried
internal gate.

**The three source signals, exact shapes** (all already in
`analysis.raw_json`, written daily by `bot.daily_push` via
`daily_analysis.yml`, same as blueprint 21 Phase 1 reads them):

```
raw_json.stocks_to_avoid    -> [{"ticker": "...", "reason": "..."}]
raw_json.wishlist_signals   -> [{"ticker": "...", "signal": "buy_now|wait|skip", "entry_zone": "...", "reason": "..."}]
raw_json.portfolio_verdicts -> [{"ticker": "...", "verdict": "hold|add|trim|exit", "reason": "...", "target": "...", "stop_loss": "..."}]
```

`portfolio_verdicts` is generated only for tickers in the user's real
`portfolio` table (see `llm_router.py` line ~503: "If user_holdings empty,
return empty portfolio_verdicts"). `wishlist_signals` is generated only
for tickers in the `wishlist` table, same pattern.

**Regime-bearish state**: `analyzer.paper_trader._bearish_block(sb) -> bool`
already exists (built 2026-08-29, blueprint 21 Phase 4) - True when the
latest `analysis` row's `market_mood == "bear"` or
`raw_json.nifty_outlook.direction == "down"`. Import and reuse this
function directly. Do NOT reimplement the query - that duplication is
exactly the class of bug this repo already got burned by twice
(`backtest.py`/`paper_trader.py` gate-stack drift, see section 21 of
`KNOWLEDGE_BASE.md`).

**Avoid-set lookup**: `analyzer.paper_trader._avoid_set(sb, now) -> set[str]`
also already exists (blueprint 21 Phase 1) - normalized ticker set from
`stocks_to_avoid` + wishlist `skip`. Import and reuse this too, rather
than re-parsing `stocks_to_avoid`/`wishlist_signals` from scratch. It
does not carry the `reason` text though (it only returns the ticker set),
so the new module still needs its own pass over `raw_json` for the
reason strings to display - just don't duplicate the MEMBERSHIP logic,
only the text extraction.

**Existing display code to extend, not replace:**
- `bot/telegram_bot.py`'s `portfolio()` handler (~line 331) - currently
  shows only `ticker / qty / avg_buy_price / last / P&L`. Also `wishlist()`
  (~line 386) - same gap, shows ticker + live price only.
- `web/app/portfolio/` - the dashboard's portfolio page.
  **Read `web/AGENTS.md` before touching anything in `web/`** - this repo
  pins a warning that the Next.js version is bleeding-edge/custom.
- Existing cache-table pattern to follow: `ticker_enrichment`
  (`db/schema.sql` ~line 211) - a `ticker primary key` table, written once
  daily, read live by request-time code without hitting the LLM/network
  again. This blueprint's new table follows the identical shape.

## CONSTRAINTS

- Must stay inside: a new `analyzer/portfolio_defense.py`, a new
  `portfolio_defense_snapshot` table in `db/schema.sql`, one new step in
  `daily_grader.yml` (or `daily_analysis.yml` - pick whichever already
  runs after the day's `analysis` row exists; `daily_grader` is later in
  the day and already does several similar "read raw_json, derive
  something" steps, e.g. `_run_paper_trader` at line 1730 - follow that
  same soft-fail pattern), `bot/telegram_bot.py`'s `portfolio`/`wishlist`
  handlers, and `web/app/portfolio/`.
- Must not change: `analyzer/paper_trader.py`, `analyzer/backtest.py`, or
  any trading/gate logic. This is read-only downstream of signals that
  already exist and are already enforced elsewhere. If this blueprint's
  builder finds itself editing gate logic, it has gone out of scope.
- Must not invent a new opinion. Every status this feature shows must
  trace to a real, already-written `reason` string or a real verdict/flag
  - never synthesize new reasoning text. If a ticker has no signal either
  way (not avoided, no verdict written, e.g. a very recently bought
  holding before the next `daily_analysis` run), show it as
  **neutral/no-data**, not a fabricated "clear" - fail open to "unknown,"
  never to a false-positive green.
- Non-negotiables: 0 recurring cost (no new API calls, no new LLM
  calls - purely reads data already being written). No em dashes,
  Title Case headings, Rupee symbol + Indian comma grouping for any price
  shown (per `AGENTS.md`).

## STEP-BY-STEP PLAN

1. **`db/schema.sql`**: add

   ```sql
   create table if not exists portfolio_defense_snapshot (
       ticker text primary key,
       status text not null,        -- 'avoid' | 'caution' | 'clear' | 'no_data'
       reason text,
       verdict text,                -- raw portfolio_verdicts.verdict, if any
       target numeric,
       stop_loss numeric,
       source text,                 -- 'stocks_to_avoid' | 'wishlist_skip' | 'portfolio_verdict' | null
       computed_at timestamptz default now()
   );
   create index if not exists idx_portfolio_defense_computed on portfolio_defense_snapshot(computed_at desc);
   ```

   Also add `alter table portfolio_defense_snapshot enable row level
   security;` next to the other RLS lines, and the matching owner-scoped
   policy following whatever pattern the surrounding tables use. Give the
   updated SQL to the user to paste into Supabase's SQL Editor - Python/JS
   clients cannot run DDL (see `blueprints/_TEMPLATE.md`'s repo-wide facts).

2. **`analyzer/portfolio_defense.py`**, new file:

   ```python
   def compute_snapshot(sb) -> list[dict]:
       """Cross-references every ticker in portfolio+wishlist against
       today's stocks_to_avoid, wishlist skip, portfolio_verdicts, and
       regime_bearish_block. Advisory only - writes a display cache,
       never touches paper_trades/paper_signals."""
   ```

   - Reuse `paper_trader._avoid_set(sb, now)` and `paper_trader._bearish_block(sb)`
     directly (import, do not reimplement).
   - Pull the latest `analysis` row's `raw_json` once (same row
     `_avoid_set`/`_bearish_block` already read) for the `reason` text
     on `stocks_to_avoid` and `wishlist_signals` entries, and for the
     full `portfolio_verdicts` list.
   - Pull real `portfolio` + `wishlist` table tickers (all users, not
     just `user_id='default'` - the schema supports multiple, mirror
     however `paper_trader`/`bot` already scope this).
   - For each ticker, in this precedence order (most severe wins):
     1. `avoid`: ticker in `_avoid_set()`'s output (source: whichever of
        `stocks_to_avoid` / wishlist `skip` matched - use that entry's
        real `reason` text).
     2. `avoid`: `portfolio_verdicts` verdict == `"exit"` (real reason
        text from that entry).
     3. `caution`: `portfolio_verdicts` verdict == `"trim"`, OR
        (`_bearish_block()` is True AND the ticker is a long holding) -
        for the regime case, reason is a fixed string naming today's
        bearish call, not fabricated per-ticker reasoning.
     4. `clear`: `portfolio_verdicts` verdict in `("hold", "add")` and
        not avoid-flagged.
     5. `no_data`: none of the above matched (fail-open, per CONSTRAINTS).
   - Upsert one row per ticker into `portfolio_defense_snapshot`
     (`on_conflict="ticker"`), matching the `stock_analyses`/
     `ticker_enrichment` upsert style already in this codebase.
   - Wrap the whole function body in the same soft-fail try/except shape
     as `grader._run_paper_trader()` (line ~1539-1543) - a broken snapshot
     compute must never block the rest of the grader run.

3. **`.github/workflows/daily_grader.yml`**: add one step calling
   `python -m analyzer.portfolio_defense` after the existing
   `_run_paper_trader` call, same simple step (it's allowed to fail
   without an `if: always()` guard since nothing downstream depends on
   it - matches the soft-fail-inside-Python approach above rather than a
   workflow-level guard).
   **If Phase A of blueprint 22 has already moved `daily_grader` off GH
   Actions by the time this is built (it has not, as of 2026-08-31 -
   Phase B is separately gated and not started), add the equivalent step
   to whatever mechanism is currently authoritative instead. Check
   `KNOWLEDGE_BASE.md` section 30 for current cutover status before
   assuming GH Actions is still the live path.**

4. **`bot/telegram_bot.py`**: in `portfolio()` (~line 331), after
   resolving each holding's price/P&L, look up that ticker in
   `portfolio_defense_snapshot` (one query before the loop, not per
   ticker) and prepend a status glyph + one-line reason:
   - `avoid` -> a warning glyph + reason
   - `caution` -> a caution glyph + reason
   - `clear` -> no extra line (keep the view uncluttered - silence is
     itself informative here)
   - `no_data` -> no extra line
   If `_bearish_block()`-driven caution flags are present on any holding,
   add one banner line at the very top of the message (naming today's
   bearish regime call), not per-ticker repetition of the same regime
   note. Apply the identical pattern to `wishlist()` (~line 386).

5. **`web/app/portfolio/`**: read `web/AGENTS.md` first. Add the same
   snapshot lookup (Supabase client read, `portfolio_defense_snapshot`
   joined against the existing holdings list by ticker) and render a
   badge per holding row using this repo's existing tier-palette
   convention (`AGENTS.md` section 17: A/gain-green, B/mid-lime,
   C/warn-amber - map avoid to the warn palette, caution to the mid
   palette, clear to no badge).

## EXACT INPUTS TO USE

- Files to read first, in order: `analyzer/paper_trader.py` (`_avoid_set`,
  `_bearish_block`, both near line 152-172), `analyzer/grader.py`
  (`_run_paper_trader` at line 1509 for the soft-fail wrapper pattern to
  copy), `bot/telegram_bot.py` lines 331-397, `web/AGENTS.md`,
  `db/schema.sql` lines 208-217 (`ticker_enrichment`) and the RLS block
  around line 495.
- The 2026-08-30 expansion review Artifact (ask the user for the link if
  not already in this session's context) for the full Plan C rationale -
  this blueprint implements only its Phase 1.

## DEFINITION OF DONE

- [ ] `portfolio_defense_snapshot` table live in Supabase (SQL handed to
      user, confirmed applied).
- [ ] `analyzer/portfolio_defense.py` runs standalone
      (`python -m analyzer.portfolio_defense`) against real data and
      writes real rows - verify against the actual current holdings
      (GROWW.NS, ETERNAL.NS, NYKAA.NS, SUZLON.NS as of 2026-08-31, but
      re-check live since this drifts) and real wishlist.
- [ ] Every row's `reason` text traces to a real string from `raw_json` -
      spot-check at least 3 rows against the source `analysis` row by
      hand.
- [ ] No ticker ever shows a fabricated reason or a false "clear" when
      data is actually missing (`no_data` case verified by testing
      against a ticker known to have no verdict yet).
- [ ] `_avoid_set`/`_bearish_block` imported, not reimplemented - grep
      confirms no duplicate query logic.
- [ ] Wired into the daily pipeline, verified via one real scheduled (or
      manually dispatched) run producing fresh rows.
- [ ] Telegram `/portfolio` and `/wishlist` show real status lines against
      live data, screenshotted or pasted for confirmation.
- [ ] Dashboard portfolio page shows the same, verified in a browser
      against the live site, not just code review.
- [ ] `KNOWLEDGE_BASE.md` updated in the same session per this repo's
      own update discipline.

## IF SOMETHING IS UNCLEAR (anti-stall)

Make the smallest safe assumption, write it at the top of the output as
"ASSUMPTION: ...", and keep going. Never stall, never invent big new
scope. If torn between adding this to `daily_grader.yml` vs
`daily_analysis.yml`, default to `daily_grader.yml` (it already contains
the closest analogous soft-fail step) and note the assumption rather than
asking.

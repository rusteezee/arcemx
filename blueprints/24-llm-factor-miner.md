# Blueprint 24: LLM as Factor Miner (Plan C Phase 2) - BUILT AND RUN LIVE 2026-09-01

See `KNOWLEDGE_BASE.md` section 36 for full build/verification detail - a real mining run, LLM proposed 5 factors, all correctly rejected (negative Sharpe, DSR 0.0), the honesty layer working exactly as designed. Also documents a real redundancy bug found and fixed the same run.

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(genuinely novel architecture, not plumbing - budget real design judgment
time, but every load-bearing piece it reuses already exists and is named
exactly below)

## GOAL

Every buy-side dimension this project has ever measured has failed
(`top_performer_1d` t=-2.56 on n=792, `stock_analyst` buy rating 0/19
ever - see `KNOWLEDGE_BASE.md` section 26/26b). The published literature
finds the identical failure mode: LLMs give reasonable estimates of price
*magnitude* but are weak on *direction* (2026 research, cited in the
2026-08-30 expansion review Artifact). The architectures that DO show
durable results (AlphaAgent, SIGKDD 2026) don't ask the LLM to pick a
direction - they use it to propose quantitative factor *hypotheses*,
then validate every one statistically before any capital is committed.

This blueprint moves this project's LLM from "picker" to "factor miner":
propose a candidate rule as a structured, safe-to-evaluate expression
over data already computed here; backtest it with the harness that
already exists; only promote what survives deflated-Sharpe and PBO
screening. The daily narrative call (`daily_analysis.yml` /
`bot.daily_push`) is untouched and stays for readability - this is a
new, separate, offline mining loop, not a replacement for the morning
push.

**Deliberately scoped as an MVP.** AlphaAgent's own regularizers
(originality-vs-existing-alphas via AST similarity, hypothesis-factor
semantic alignment) are real and worth having eventually, but this
blueprint's constrained JSON DSL (below) makes most of that moot for a
first version - a rule expressed as `{field, op, value}` triples has no
AST to compare and is trivially deduplicatable by exact structural
match. Note AST-based novelty scoring as a stated future enhancement,
not required here.

## CONTEXT THE BUILDER NEEDS

**This is Plan C Phase 2**, following blueprint 23 (Plan C Phase 1,
built and shipped 2026-08-31 - see `KNOWLEDGE_BASE.md` section 32). Read
`blueprints/23-portfolio-defense-layer.md` first for the project's
current defensive-signal state; this blueprint builds the OTHER half -
an actual attempt at a validated buy-side signal, done the way the
literature says works instead of repeating the six already-failed
attempts.

**The reusable feature layer already exists, verified real:**
`analyzer/technical.py`'s `compute_signals(df: pd.DataFrame) -> dict`
(line 47) takes any OHLCV DataFrame and returns ~19 named numeric
features from its LAST row: `rsi`, `macd`, `macd_signal`, `sma20`,
`sma50`, `sma200`, `bb_upper`, `bb_lower`, `chg_1d`, `chg_5d`, `chg_30d`,
`vol_avg_20`, `vol_last`, `support_20d`, `resistance_20d`,
`dist_to_support_pct`, `dist_to_resistance_pct`, `atr_14`,
`expected_daily_move_pct`. This is already point-in-time-safe in
principle - call it with a DataFrame slice ending at any historical
date and it computes exactly what was knowable as of that date, no
lookahead, since it only ever reads `.iloc[-1]`/`.tail(N)` off whatever
slice it's given. This function is THE feature schema for the factor
DSL below - do not invent new fields, and do not modify this function
(other callers depend on its exact current shape).

**The backtest/scoring machinery already exists, verified real:**
`analyzer/backtest.py`'s `HistCache` (no-lookahead OHLCV slicing per
ticker, one download per ticker for the whole window) and `ShadowBook`
(in-memory position tracking, never touches live tables) are generic -
built for the existing gate stack, but nothing about them is coupled to
it. `_open_shadow_trade()` (line 433), the friction/cost functions in
`paper_trader.py` (`_broker_friction` line 430, `_apply_slippage` line
401, `_cost_dominated` line 451), and the volatility-scaled barrier
geometry in `analyzer/geometry.py` are all ticker/side/price-generic -
reuse them directly for a mined factor's simulated trades rather than
reimplementing P&L/friction a second time.

**The statistical honesty layer already exists, verified real:**
`analyzer/metrics.py`'s `sharpe()`, `deflated_sharpe()`, `pbo_cscv()`,
`psr()`, `max_drawdown()` all take plain `list[float]` returns or
`list[dict]` trades - genuinely generic, not coupled to any specific
signal source. This is the exact honesty layer blueprint 10 built for
the live gate stack; reuse it unchanged to score a mined factor's
backtest the same rigorous way.

**Real precedent for promotion discipline in this codebase:** the LoRA
specialist (blueprint 13) runs as an advisory second opinion and "never
influences a live pick... [p]romotion only happens if 30-day accuracy
beats the live chain on 2+ dimensions, and that call is manual/
documented, never automated." Mined factors follow the identical
discipline - see CONSTRAINTS.

## CONSTRAINTS

- Must stay inside: a new `analyzer/factor_lab.py` (proposal + backtest
  harness), a new `mined_factors` table in `db/schema.sql`, a new
  low-frequency mining workflow/script. Must NOT modify
  `analyzer/technical.py`, `analyzer/backtest.py`'s existing gate
  functions, `analyzer/paper_trader.py`'s existing gate stack, or
  `analyzer/metrics.py` - every one of those gets called, none gets
  edited.
- **A mined factor never trades real or paper capital automatically,
  ever.** A factor that clears the statistical bar becomes a logged
  candidate, surfaced to the user (Telegram/dashboard), for a human to
  manually review and decide whether to wire into `paper_trader.py`'s
  live gate stack as an actual new signal source - matching blueprint
  13's LoRA promotion discipline exactly. This is non-negotiable: the
  whole point of this blueprint is adding a validation step before
  capital risk, not automating around one.
- Factor expressions are a **constrained JSON DSL, never executable
  code.** `{"field": "rsi", "op": "<", "value": 30}` -style condition
  objects only, combined by `AND`/`OR`, validated against a fixed field
  allowlist (the `compute_signals()` output keys) before ever being
  evaluated. No `eval()`, no arbitrary expressions, no LLM-authored code
  path of any kind - this is a hard security boundary, not a style
  preference.
- Non-negotiables: 0 recurring cost. The mining LLM call is occasional
  (weekly, see STEP-BY-STEP), not daily, and uses the same free
  OpenRouter chain already wired (`analyzer/llm_router.py`) - no new
  provider, no new spend. No em dashes, Title Case headings, Rupee
  symbol + Indian comma grouping for any price shown (per `AGENTS.md`).

## STEP-BY-STEP PLAN

1. **`db/schema.sql`**: add

   ```sql
   create table if not exists mined_factors (
       id bigserial primary key,
       proposed_at timestamptz default now(),
       name text not null,
       hypothesis text,              -- the LLM's own stated reasoning
       side text not null,           -- 'long' | 'short'
       horizon_days int not null,
       conditions jsonb not null,    -- the DSL condition list, verbatim
       combine text not null,        -- 'AND' | 'OR'
       trade_count int,
       win_rate_pct numeric,
       sharpe numeric,
       dsr numeric,
       pbo numeric,
       status text not null default 'proposed',  -- 'proposed' | 'rejected' | 'candidate' | 'promoted' | 'archived'
       reviewed_at timestamptz,
       notes text
   );
   create index if not exists idx_mined_factors_status on mined_factors(status);
   ```

   Hand the SQL to the user for Supabase's SQL Editor (Python/JS clients
   cannot run DDL). Add RLS enable + the owner-read policy loop entry,
   same pattern as blueprint 23's migration.

2. **`analyzer/factor_lab.py`**, new file:

   ```python
   FACTOR_FIELDS = {  # the compute_signals() output keys, the only
                       # legal DSL field names - reject anything else
       "rsi", "macd", "macd_signal", "sma20", "sma50", "sma200",
       "bb_upper", "bb_lower", "chg_1d", "chg_5d", "chg_30d",
       "vol_avg_20", "vol_last", "support_20d", "resistance_20d",
       "dist_to_support_pct", "dist_to_resistance_pct", "atr_14",
       "expected_daily_move_pct", "last",
   }

   def validate_factor(factor: dict) -> str | None:
       """Return an error string, or None if the factor is well-formed
       and every field/op referenced is in FACTOR_FIELDS. Called before
       a factor is ever evaluated - a malformed or out-of-schema
       proposal is rejected here, not partway through a backtest."""

   def evaluate_condition(cond: dict, signals: dict) -> bool:
       """One condition against one compute_signals() dict. Supports a
       fixed numeric `value` or a `value_field` (comparing two computed
       fields, e.g. last > sma200). Ops: <, <=, >, >=, ==."""

   def backtest_factor(factor: dict, universe: list[str],
                       hist) -> dict:
       """Walks `universe` across `hist`'s full window (HistCache,
       imported from analyzer.backtest), computing compute_signals() at
       each no-lookahead point via a rolling window slice, checking the
       factor's conditions, and opening a ShadowBook trade via the
       EXACT SAME _open_shadow_trade/_broker_friction/geometry path
       backtest.py's own evaluators use - so a mined factor's simulated
       cost structure is identical to a real signal's, not a simplified
       approximation. Returns trade list + sharpe/dsr/pbo via
       analyzer.metrics, same functions blueprint 21's honesty layer
       already calls."""
   ```

   `backtest_factor()` is the one genuinely new piece of simulation
   logic - everything it calls (HistCache, ShadowBook,
   `_open_shadow_trade`, friction, geometry, metrics) is imported and
   reused, not reimplemented. Keep it that way; if the builder finds
   itself re-deriving cost/friction math here, it has gone out of scope.

3. **Mining prompt + dispatch.** A new, low-frequency (weekly, Saturday
   alongside `specialist_eval.yml`'s existing slot logic - reuse that
   cadence choice, don't invent a new one) script/workflow:
   `analyzer/factor_dispatch.py` + `.github/workflows/factor_mining.yml`.
   Prompts the LLM (via the existing `llm_router.py` chain, structured
   output) with: the `FACTOR_FIELDS` schema, a handful of REAL historical
   (ticker, date, feature-vector, forward-N-day-return) examples pulled
   from real `prices`/`prediction_scores` data (grounding - never invent
   examples), and asks for 3-5 candidate factors as the DSL above with a
   stated hypothesis. Each candidate is validated (`validate_factor`),
   backtested (`backtest_factor`) against the full available history,
   and logged to `mined_factors` regardless of outcome (a rejected
   factor is real information too - do not only log winners).

4. **Promotion surface, not promotion automation.** A factor with
   `dsr > 0`, a minimum trade count (30+, matching this project's own
   established "DSR can't resolve on tiny n" caution from blueprint 21),
   and Sharpe beating the current live baseline gets `status = 'candidate'`
   and a one-line Telegram notification + a new small section on the
   dashboard listing candidates with their real backtest numbers. A
   human (the user) reviews and manually flips `status` to `'promoted'`
   only when they decide to wire it into `paper_trader.py` as an actual
   new `_evaluate_*` source - which is separate work, out of this
   blueprint's scope, and should get its own blueprint when/if it
   happens (matching this project's "one blueprint per session/PR"
   operating rule).

## EXACT INPUTS TO USE

- Files to read first: `analyzer/technical.py` (`compute_signals`, line
  47), `analyzer/backtest.py` (`HistCache` class, `_open_shadow_trade`
  line 433, and `_eval_stock_analyst`/`_eval_outlook` as worked examples
  of the exact reuse pattern to follow), `analyzer/paper_trader.py`
  (`_broker_friction` line 430, `_apply_slippage` line 401,
  `_cost_dominated` line 451), `analyzer/metrics.py` (`sharpe`,
  `deflated_sharpe`, `pbo_cscv`), `analyzer/geometry.py`
  (`volatility_scaled_barriers`), `blueprints/13-lora-finetune-pipeline.md`
  for the promotion-discipline precedent to mirror.
- The 2026-08-30 expansion review Artifact for the full research
  citations (AlphaAgent, the direction-vs-magnitude literature finding)
  - ask the user for the link if not already in session context.
- Baseline to beat: the current live gate stack's own backtest numbers
  (`backtest_runs`, latest id as of build time - check
  `KNOWLEDGE_BASE.md`'s most recent backtest section before assuming
  which id is current, it changes).

## DEFINITION OF DONE

- [ ] `mined_factors` table live in Supabase (SQL handed to user,
      confirmed applied).
- [ ] `validate_factor()` rejects any out-of-schema field/op before
      evaluation - verified with at least one deliberately malformed
      test case (unknown field, unknown op, missing required key).
- [ ] `backtest_factor()` run standalone against at least one hand-
      written test factor (not LLM-proposed yet) and produces a real
      trade list with plausible P&L - spot-checked by hand against 2-3
      individual trades the way blueprint 23's rows were spot-checked.
- [ ] Confirmed `backtest_factor()` reuses `_open_shadow_trade`/friction/
      geometry rather than reimplementing them - grep confirms no
      duplicate cost-model logic.
- [ ] One real mining dispatch run end to end: LLM proposes real
      candidates, each gets validated + backtested + logged to
      `mined_factors`, including at least one that gets rejected (proves
      the reject path is real, not just the happy path).
- [ ] Zero factors ever reach `paper_trades`/`paper_signals` directly -
      grep confirms `factor_lab.py`/`factor_dispatch.py` never import or
      call anything that opens a live/paper position.
- [ ] `KNOWLEDGE_BASE.md` updated in the same session per this repo's
      own update discipline.

## IF SOMETHING IS UNCLEAR (anti-stall)

Make the smallest safe assumption, write it at the top of the output as
"ASSUMPTION: ...", and keep going. Never stall, never invent big new
scope - in particular, do not build the AST-based originality/complexity
regularizers from the AlphaAgent paper in this pass; the DSL's structural
constraints already prevent the worst overfitting failure modes for a
first version, and that refinement can be its own later blueprint if the
MVP shows real promise.

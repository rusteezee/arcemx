BLUEPRINT 8: Drawdown circuit breaker

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(State machine across eval passes with Telegram side effects. moderate care.)

GOAL
When the paper book's equity curve falls more than a threshold from its peak, the trader
stops opening NEW positions until the curve recovers halfway, and tells the user on
Telegram both when it trips and when it re-arms. Open positions still mark-to-market and
exit normally. the breaker only blocks entries.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/metrics.py` (`equity_curve` :90, `max_drawdown` :151 -
  reuse, do not reimplement), `analyzer/paper_trader.py` (`eval_signals` :573,
  `_resolve_portfolio_base` :93), `analyzer/backtest.py` (ShadowBook :146),
  `bot/alerts_checker.py` (the minimal Bot.send_message pattern for pushes outside the
  bot process).
- Decisions (made here): BREAKER_DD_PCT = 8.0 (trips when current drawdown from peak
  exceeds 8% of (portfolio_base + peak). same denominator convention as
  metrics.max_drawdown). Re-arm when drawdown recovers to less than half the trip level
  (4%). Persist breaker state in the existing `metrics_snapshot` flow? NO. decision:
  compute statelessly each pass from closed trades (equity curve is deterministic), so
  no new table and no state drift; the "tripped" condition is pure arithmetic. Hysteresis
  handled by tracking whether the LAST snapshot was tripped: read the most recent
  metrics_snapshot row's bundle JSON for key `breaker_tripped` (add it when writing) -
  metrics_snapshot already writes every grader pass (grader.py:1490).
- Skip reason string: `"circuit_breaker"`. Telegram copy (exact):
  trip: "⛔ Circuit breaker TRIPPED: paper book drawdown {dd:.1f}% > 8%. New entries
  paused until drawdown < 4%. Open positions continue to manage themselves."
  re-arm: "✅ Circuit breaker re-armed: drawdown recovered to {dd:.1f}%. Entries resume."
- Gotchas: (1) With few closed trades the curve is noisy. breaker only activates when
  closed trade count >= 10 (below that, pass-through). (2) Backtest mirrors the same
  logic against the ShadowBook's closed list as-of each event. (3) Telegram push must
  never crash the eval (try/except, same as alerts_checker).

CONSTRAINTS
- Must stay inside: `analyzer/paper_trader.py`, `analyzer/backtest.py`,
  `analyzer/metrics.py` (only: include breaker_tripped in compute_paper_metrics bundle),
  `web/app/trader/page.tsx` (SKIP_LABEL + one Stat showing breaker state from the
  latest metrics_snapshot bundle).
- Must not change: mark_to_market/exits, sizing, thresholds of other gates, schema (the
  bundle jsonb column absorbs the new key. no DDL).
- Non-negotiables: breaker never blocks exits; min-10-closed-trades activation floor.

STEP-BY-STEP PLAN
1. `analyzer/paper_trader.py`. constants `BREAKER_DD_PCT = 8.0`,
   `BREAKER_REARM_PCT = 4.0`, `BREAKER_MIN_TRADES = 10`. New function
   `_breaker_state(sb, portfolio_base) -> tuple[bool, float]`: pull closed paper_trades
   (status like 'closed_%'), build metrics.equity_curve, compute current dd% from
   running peak (same denominator as metrics.max_drawdown), apply hysteresis using the
   previous tripped flag read from the latest metrics_snapshot bundle; return
   (tripped, dd_pct).
2. `eval_signals` (:573): call once per pass; when tripped, log every would-be entry as
   skip `"circuit_breaker"` (evaluators receive the flag as a parameter. cheapest gate,
   check it FIRST) and, on a trip/re-arm TRANSITION (state differs from previous
   snapshot's flag), send the exact Telegram copy via the alerts_checker Bot pattern
   (env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
3. `analyzer/metrics.py` compute_paper_metrics: add `"breaker_tripped": bool,
   "breaker_dd_pct": float` to the returned bundle (recomputed the same way) so
   metrics_snapshot persists it each grader pass.
4. `analyzer/backtest.py`. mirror in the replay loop: maintain running peak over the
   ShadowBook's closed equity as events process; same trip/re-arm arithmetic (no
   Telegram); count `circuit_breaker` skips.
5. `web/app/trader/page.tsx`. SKIP_LABEL `circuit_breaker: "Circuit breaker"`; in the
   Edge Metrics section add one Stat "Breaker" showing ARMED/TRIPPED from the latest
   metrics_snapshot bundle.
6. Verify: REPL-simulate a curve with a 10% drop across 12 fake closed trades and assert
   trip; then recovery to 3.5% asserts re-arm. Run the full backtest; report whether the
   June drawdown (peak-to-trough -6.8% in backtest_runs id 2) would have tripped it (it
   should NOT. 6.8 < 8; state this check explicitly in the summary).

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 08-drawdown-circuit-breaker.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says."

DEFINITION OF DONE
[ ] Simulated 10%-dd curve trips; 3.5% recovery re-arms (REPL evidence in summary).
[ ] Under 10 closed trades the breaker never activates.
[ ] Trip/re-arm transitions send the exact Telegram copy; steady states send nothing.
[ ] Backtest mirror counts circuit_breaker skips; June-window non-trip check reported.
[ ] Exits/mark_to_market provably untouched (diff review).
[ ] py_compile all files; SKIP_LABEL + Stat added.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going.

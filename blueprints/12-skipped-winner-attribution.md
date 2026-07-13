BLUEPRINT 12: Skipped-winner attribution (which gate rejects profitable signals?)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Described in schema.sql comments since day one, never built. Reuses backtest machinery.)

GOAL
Every skipped signal gets retro-scored: "had this entered anyway, what would net P&L
have been?" — aggregated per skip_reason, so gate tuning stops being guesswork. The
answer to "which gate rejected the most ultimately-profitable signals" (described at
db/schema.sql:276-278 but never implemented) becomes a weekly number on the trader page.

CONTEXT THE BUILDER NEEDS
- Files to read first: `db/schema.sql:276-278` (the original intent comment),
  `analyzer/paper_trader.py` (`_log_signal` :392 — paper_signals rows carry
  confidence/edge/meta but NOT the full geometry today; the evaluators have
  intent/target/stop in hand when they skip), `analyzer/backtest.py` (HistCache +
  `_mark_shadow_book` — the walk-forward exit simulator to reuse), `analyzer/grader.py`
  (:1418 `_run_paper_trader` — the daily hook where the new pass runs).
- Design (decided here):
  1. Capture: at skip time, when the evaluator has geometry (intent_px/target_px/
     stop_px/horizon), store it in the signal's meta as
     `"geometry": {"intent": f, "target": f, "stop": f, "horizon_days": n}`.
     Skips before geometry exists (not_buy, pre_schema, low_conf, low_edge on
     pre-geometry paths) store nothing extra — they are attributable only by count.
  2. Retro-score: new module `analyzer/skip_attribution.py` with `score_skips(days=7)`:
     pull paper_signals where action='skip' AND meta->geometry exists AND evaluated_at
     older than horizon+2 days (outcome must be resolvable), not yet scored
     (meta->retro is null); simulate the entry exactly like backtest._mark_shadow_book
     (next-open fill + slippage + friction via paper_trader's imported functions, OHLC
     walk to stop/target/horizon); write the result back into the signal row's meta as
     `"retro": {"net_pnl": f, "exit_reason": s, "scored_at": iso}` (UPDATE meta —
     PostgREST jsonb update of the whole meta object).
  3. Aggregate: `summarize(days=90) -> list[dict]` — per skip_reason: count, scored
     count, would-be win rate, total would-be net_pnl, avg net_pnl. Print + return.
  4. Hook: call `score_skips()` from grader's `_run_paper_trader` step (after eval),
     wrapped in try/except so attribution can never break grading.
- Gotchas: (1) survivor honesty — retro P&L ignores sector-cap/book interactions (a
  skipped trade might have blocked another real one); state this in a docstring and a
  `"caveat": "independent_fill"` key in retro. (2) Do not double-score (meta->retro
  null check). (3) PostgREST jsonb: read meta, mutate in Python, write whole object
  back. (4) yfinance history via one HistCache instance per pass, not per signal.

CONSTRAINTS
- Must stay inside: new `analyzer/skip_attribution.py`, `analyzer/paper_trader.py`
  (meta geometry capture, ~6 lines per evaluator), `analyzer/grader.py` (one hook call),
  `web/app/trader/page.tsx` (new Section rendering the aggregate), `analyzer/backtest.py`
  (import reuse only — no behavior change).
- Must not change: gate decisions themselves, schema (meta jsonb absorbs everything).
- Non-negotiables: attribution failures never break grading; independent-fill caveat
  documented; ₹0.

STEP-BY-STEP PLAN
1. `analyzer/paper_trader.py` — in each evaluator's skip paths AFTER geometry is known
   (post intent/target/stop parse), include the geometry dict in `_log_signal`'s meta.
2. Create `analyzer/skip_attribution.py` — `score_skips(days=7)` + `summarize(days=90)`
   per the design; reuse paper_trader._apply_slippage/_broker_friction and a local
   HistCache import from backtest.
3. `analyzer/grader.py` — in `_run_paper_trader` (:1418), after eval_signals: 
   `try: skip_attribution.score_skips() except Exception as e: print(...)`.
4. `web/app/trader/page.tsx` — new Section "Skipped Winners" (after Signal Activity):
   table per skip_reason of scored count / would-be win rate / total would-be P&L,
   computed client-side from paper_signals meta.retro (already fetched on that page —
   extend the existing signals query's selected columns if needed).
5. Verify: run score_skips() over the real 747 historical skips WITH geometry (many
   low_edge/low_conf rows carry it once step 1's capture exists only going forward —
   so ALSO run a one-time backfill: for historical top_performer skips, geometry is
   recoverable from the analysis row's raw_json pick fields; implement
   `backfill_geometry(limit=500)` in the same module doing exactly that join). Report
   the first real aggregate table in the summary.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 12-skipped-winner-attribution.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says, including the one-time geometry backfill."

DEFINITION OF DONE
[ ] score_skips() resolves real historical skips into retro results (show >= 20 scored
    rows' aggregate in summary).
[ ] Per-reason aggregate answers the headline question with real numbers ("low_edge
    rejected X signals worth ₹Y net").
[ ] No double-scoring on re-run (idempotent — second run scores 0 new).
[ ] Grading pass still succeeds when attribution raises (fault injection test).
[ ] Trader page renders the section. py_compile + tsc pass.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going.

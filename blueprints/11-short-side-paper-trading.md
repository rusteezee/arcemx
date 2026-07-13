BLUEPRINT 11: Short-side paper trading (leveled worst_performers)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Prompt-schema change + full short lifecycle through trader/backtest — the largest
blueprint; follow the long-side code as the exact structural mirror.)

GOAL
The system's bearish calls stop being grade-only and start trading: worst_performers
gain model-committed entry/target/stop levels, the paper trader opens SHORT positions
on them through the same gate stack, and the dormant pick_tp_sl grading dim reactivates.
Doubles the trade sample rate (faster path to the 60-trade Kelly gate and Tier-1
significance) and hedges the book.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/llm_router.py` SYSTEM_PROMPT (:108-513, find the
  worst_performers schema block), `_enforce_pick_quality` (:981 — currently
  geometry-truths LONG picks; shorts need mirrored logic), `analyzer/paper_trader.py`
  (`_evaluate_top_performer` :659 is the structural template; `_mark_one` :1087 exits;
  `_close_trade` :1048 P&L arithmetic — all long-only today; grounding note: "direction
  != 'up' skipped at :920"), `analyzer/backtest.py` (mirrors), `analyzer/grader.py`
  (:796-803 — dormant pick_tp_sl dim, deliberately reading retired keys; :347
  grade_pick_tp_sl OHLC walk).
- Short mechanics (decided here — delivery shorting doesn't exist for retail overnight
  in India; this is a RESEARCH simulation, so model it as an idealized short with
  honest friction):
  entry: fill BELOW reference on sell (adverse direction flips), gross_pnl =
  (fill_px - exit_px) * qty; target BELOW entry, stop ABOVE entry; exit walk: stop hits
  when bar HIGH >= stop_px (pessimistic stop-first on ambiguous bars, mirroring longs);
  target hits when bar LOW <= target_px; horizon exit at close. STT applies on both
  legs for intraday-style treatment — keep the existing _broker_friction call pattern
  but pass action="sell" on entry and "buy" on exit. Tag every such trade
  side="short" (the paper_trades.side column already exists).
  Add a `meta.simulation_note = "idealized_short"` on every short trade — the honesty
  marker that these fills assume borrow availability that Indian retail delivery lacks.
- SYSTEM_PROMPT schema addition: worst_performers entries gain REQUIRED fields
  `entry`, `target`, `stop_loss` (target < entry < stop for a short), plus the same
  expected_edge_pct machinery as top_performers. `_enforce_pick_quality` mirror:
  risk_reward = (entry - target) / (stop - entry); reject/flag degenerate geometry
  (target >= entry or stop <= entry) exactly like the long-side guard at
  paper_trader.py:728.
- Gate stack for shorts: same order/constants; conviction via _conf_from_winprob
  unchanged; regime interaction (if blueprint 03 landed): shorts are ALLOWED in
  risk_mode "off" (that's when shorts shine) but blocked in vix_band "stressed" with
  trend "up"; if 03 not landed, no regime interaction.
- Gotchas: (1) grader's pick_tp_sl reactivation: point it at worst_performers WITH
  levels (only rows that have entry/target/stop — old rows without levels keep grading
  under the legacy path); (2) sector-cap and ticker-freeze checks are side-agnostic —
  an open LONG in a ticker must block a SHORT in the same ticker (`_has_open_position`
  already keys on ticker only — correct, keep); (3) `metrics.equity_curve` sums net_pnl
  by exit date — side-agnostic already, no change.

CONSTRAINTS
- Must stay inside: `analyzer/llm_router.py` (SYSTEM_PROMPT worst_performers block +
  _enforce_pick_quality), `analyzer/paper_trader.py`, `analyzer/backtest.py`,
  `analyzer/grader.py` (:796-803 block), `web/app/trader/page.tsx` (side column in
  tables).
- Must not change: long-side behavior (byte-identical), friction constants, schema
  (side column exists).
- Non-negotiables: pessimistic exits (stop-first); simulation_note honesty tag; long
  regression guard — run the backtest before AND after, long-side trade list must be
  identical.

STEP-BY-STEP PLAN
1. `analyzer/llm_router.py` — SYSTEM_PROMPT: extend the worst_performers schema with
   entry/target/stop_loss + edge fields (copy the top_performers field descriptions,
   invert the geometry language). `_enforce_pick_quality`: add the short-side mirror
   pass over worst_performers (tier from stated win_prob, short risk_reward formula,
   geometry truth-check, same *_stated/*_pregeo audit conventions).
2. `analyzer/paper_trader.py` — new `_evaluate_worst_performer(sb, analysis_row, wp,
   now, portfolio_base)` mirroring _evaluate_top_performer with inverted geometry +
   side="short" + simulation_note; register in eval_signals' analysis loop (source_kind
   "worst_performer"). `_mark_one`: branch on t_row["side"] for the exit walk
   (short: stop on high>=stop, target on low<=target). `_close_trade`: short P&L =
   (fill - exit)*qty; entry friction action="sell" (STT applies), exit action="buy".
3. `analyzer/backtest.py` — mirror evaluator + exit walk + close arithmetic in the
   shadow book path; add worst_performers (with levels) to the event stream builder.
4. `analyzer/grader.py` — :796-803: extend pick_tp_sl to grade worst_performers rows
   that carry levels via grade_pick_tp_sl with inverted hit logic; keep the legacy
   read for old rows. New dim name for clarity: `short_pick_tp_sl`.
5. `web/app/trader/page.tsx` — open/closed tables: add a Side pill column (LONG/SHORT).
6. Verify: (a) run backtest BEFORE the change, save the long trade list; (b) after, rerun
   — long list identical, plus N short trades appear (report N + short-side P&L);
   (c) REPL walk one short trade's bars by hand and check stop-first pessimism.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 11-short-side-paper-trading.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Long-side behavior must remain
  byte-identical — verify with the before/after backtest check in step 6."

DEFINITION OF DONE
[ ] Before/after backtest: long trade lists identical; shorts appear with
    side="short" and simulation_note tags.
[ ] One short trade's exit hand-verified against real bars (arithmetic in summary).
[ ] SYSTEM_PROMPT schema + _enforce_pick_quality short mirror in place; degenerate
    short geometry rejected with the mirrored guard.
[ ] short_pick_tp_sl dim writes prediction_scores on the next grading of a leveled row.
[ ] Trader page shows Side; py_compile + tsc pass.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not model borrow costs or
SLB fees — the simulation_note tag covers the idealization honestly.

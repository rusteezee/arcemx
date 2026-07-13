BLUEPRINT 10: Deflated Sharpe + PBO honesty layer (and backtest compounding fix)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Statistical formulas given exactly; numeric implementation care required.)

GOAL
The system stops being able to fool itself: every backtest run reports (a) the Deflated
Sharpe Ratio — the probability the observed Sharpe beats zero AFTER correcting for how
many strategy variants were tried — and (b) PBO, the probability that the walk-forward's
chosen parameter is overfit. The backtest also gains a compounding equity mode. These
numbers gate Phase B honesty: a Tier-1 Sharpe with DSR < 0.9 is not a real Tier-1.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/metrics.py` (`psr` :201 — the PSR machinery being
  extended; `_norm_cdf` :45; `walk_forward_confidence_floor` :361 — the "trials" source
  for PBO; `sharpe` :135), `analyzer/backtest.py` (`run_backtest` :463, sizing note :20).
- Exact math (Bailey & López de Prado 2014; implement literally, stdlib only):
  DSR = PSR evaluated at benchmark SR* where
    SR* = sqrt(Var[{SR_n}]) * ((1 - γ) * z(1 - 1/N) + γ * z(1 - 1/(N*e)))
    γ = 0.5772156649 (Euler–Mascheroni), e = 2.71828..., N = number of trials,
    Var[{SR_n}] = variance of the per-period Sharpe estimates across the N trials,
    z(·) = inverse standard normal CDF.
  Implement z(·) with Acklam's rational approximation (max abs error ~1.15e-9; the
  standard coefficient set — builder writes it as `_norm_ppf(p)` with the canonical
  a/b/c/d coefficient arrays; cite "Acklam 2003" in the docstring).
  Trials definition (decided here): N = the walk-forward grid size (9 floors, 40..80
  step 5) — the parameter sweep IS the multiple-testing event; Var[{SR_n}] = variance
  of the 9 grid Sharpes on the full trade set via metrics._window_sharpe.
  If N < 2 or variance is 0, DSR = PSR (no deflation possible) — flag "dsr_degenerate".
  PBO via CSCV (Bailey et al. 2015), minimal correct version:
    Take the chronological per-trade return series (net_pnl / portfolio_base) of ALL
    closed trades. Split into S = 8 equal contiguous blocks (not 16 — sample is small).
    For each of the C(8,4) = 70 ways to pick 4 blocks as in-sample: for each grid floor,
    compute IS Sharpe (trades with confidence >= floor inside IS blocks) and OOS Sharpe
    (same filter on the other 4 blocks). Find the floor with best IS Sharpe; record its
    OOS rank r among all floors (0 = best). PBO = fraction of the 70 combos where the
    IS-best floor's OOS Sharpe is in the bottom half (relative rank > 0.5).
    Guard: if fewer than 40 closed trades, return None ("pbo_insufficient_data").
  Compounding mode: in backtest, add `compounding: bool = True` parameter — equity base
  starts at portfolio_base and each closed trade's net_pnl adds to it; position sizing
  reads the CURRENT base. Report both simple and compounded total return.
- Gotchas: (1) trade count today ~47 — PBO will return None until ~40+ (it may just
  clear the guard; fine either way). (2) metrics.py deliberately avoids scipy — keep it
  that way. (3) Everything lands in the backtest_runs.results jsonb — no DDL.

CONSTRAINTS
- Must stay inside: `analyzer/metrics.py`, `analyzer/backtest.py`,
  `web/app/backtest/page.tsx` (render the new numbers), `web/lib/metrics.ts` (mirror
  DSR only if trivially portable — else render server-computed values verbatim; decide:
  render verbatim from results JSON, do NOT port the math to TS).
- Must not change: psr()'s existing signature/behavior, tier gate thresholds, schema.
- Non-negotiables: stdlib only; every degenerate path returns a flagged None rather than
  a fake number.

STEP-BY-STEP PLAN
1. `analyzer/metrics.py` — add `_norm_ppf(p)` (Acklam), `deflated_sharpe(returns,
   trial_sharpes) -> dict` ({"dsr": float, "sr_star_annual": float, "n_trials": int,
   "degenerate": bool}), and `pbo_cscv(trades, grid, base_inr, blocks=8) -> dict | None`
   ({"pbo": float, "combos": 70, "grid": [...]}) exactly per the math above.
2. `analyzer/backtest.py` — after computing the metrics bundle in run_backtest: derive
   trial Sharpes across the confidence-floor grid (reuse
   metrics._filter_trades_by_confidence + _window_sharpe on the shadow closed list),
   call deflated_sharpe + pbo_cscv, add to results dict as `"dsr": {...}, "pbo": {...}`.
   Add the `compounding` mode (default True) to the sizing base; include
   `"compounded_final_equity"` and `"simple_total_net_pnl"` in results.
3. `web/app/backtest/page.tsx` — Edge Metrics section: add Stats "DSR" (green >= 0.90),
   "PBO" (green <= 0.30, render "n/a" when null) reading results.dsr.dsr / results.pbo.pbo.
4. Validation (report all in summary): (a) synthetic check — 100 N(0.001, 0.01) i.i.d.
   returns with 9 fake trials of similar Sharpe: DSR must be LOWER than PSR;
   (b) `_norm_ppf(0.975)` must equal 1.959964 ±1e-5; (c) run the real backtest, report
   PSR vs DSR vs PBO for the current 47-trade history.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 10-dsr-pbo-honesty-layer.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. The formulas are exact — implement them
  literally and run the three validation checks."

DEFINITION OF DONE
[ ] _norm_ppf(0.975) == 1.959964 within 1e-5.
[ ] Synthetic DSR < PSR check passes.
[ ] Real backtest_runs.results carries dsr + pbo (or flagged None) + compounded equity.
[ ] Backtest page renders DSR/PBO Stats with the color thresholds.
[ ] No scipy/numpy added to metrics.py. py_compile + tsc pass.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not add more trial
definitions (e.g. counting every historical code change as a trial) — grid-only, stated
in a comment.

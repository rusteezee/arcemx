BLUEPRINT 4: Platt recalibration of LLM win-prob at the entry gate

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Small numeric model implemented from an exact formula; wiring into two eval paths.)

GOAL
The paper trader stops trusting the LLM's raw stated confidence and instead gates on a
recalibrated probability learned from the system's own track record: a Platt-scaled
(logistic) mapping fitted on calibration_log's (stated_confidence, realized_score) pairs.
This replaces guesswork with measured calibration, and upgrades the existing crude
linear bias debit (`_dim_confidence_bias`) which only shifts, never reshapes.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/paper_trader.py` (`_dim_confidence_bias` :132-163 — the
  mechanism being upgraded; `_evaluate_outlook` :885 which consumes it; `_conf_from_winprob`
  :814), `analyzer/backtest.py` (`_calibration_bias` :174 — the as-of mirror).
- Data: `calibration_log` table (214 rows live, growing daily): columns `dimension`,
  `stated_confidence` (0-100), `realized_score` (0-100), `prediction_date`, `graded_at`.
  Treat realized "hit" as `realized_score >= 60` (scores are graded 0-100 where >=60 is
  a materially correct call — consistent with grader's gradient scoring).
- Exact math (implement literally, pure Python, no sklearn):
  Platt scaling fits `p_cal = 1 / (1 + exp(-(a*x + b)))` where x = stated_confidence/100,
  y = hit (0/1), via Newton-Raphson on the 2-parameter logistic log-likelihood:
  initialize a=1, b=0; iterate 25 steps:
    `p = sigmoid(a*x+b)`; gradient g = [Σ(p-y)*x, Σ(p-y)];
    Hessian H = [[Σp(1-p)x², Σp(1-p)x], [Σp(1-p)x, Σp(1-p)]];
    [a,b] -= H⁻¹g (2x2 inverse by hand). Add 1e-6 ridge to the Hessian diagonal.
  Use Platt's target smoothing: y+ = (N+ + 1)/(N+ + 2), y- = 1/(N- + 2) instead of raw 1/0.
- Minimum data rule (decided here): fit per-dimension when that dim has >= 80 pairs;
  else fit one GLOBAL model pooling all dims when total >= 80; else return None and the
  caller falls back to the existing `_dim_confidence_bias` debit unchanged. (Live counts
  today: 214 total — global model fits now; per-dim comes free as data grows.)
- Gotchas: (1) backtest must fit ONLY on rows with `graded_at` strictly before the event
  (extend the existing as-of pattern at backtest.py:174). (2) The recalibrated value
  feeds the SAME threshold constants (MIN_CONF, OUTLOOK_MIN_CONF) — do not retune
  thresholds in this blueprint. (3) calibration_log realized_score and prediction_scores
  .score are different scales (0-100 vs 0-1) — only use calibration_log here.

CONSTRAINTS
- Must stay inside: new file `analyzer/calibration.py`, `analyzer/paper_trader.py`,
  `analyzer/backtest.py`.
- Must not change: grader, schema, thresholds, `_conf_from_winprob`'s selection logic.
- Non-negotiables: pure stdlib math; deterministic (no randomness); fallback path to the
  old bias debit must remain intact and reachable.

STEP-BY-STEP PLAN
1. Create `analyzer/calibration.py`:
   - `fit_platt(pairs: list[tuple[float, int]]) -> tuple[float, float] | None` — the
     Newton-Raphson above; returns (a, b) or None if len(pairs) < 80 or fit diverges
     (any non-finite parameter).
   - `load_pairs(sb, dimension: str | None, before: datetime | None) -> list` — pulls
     calibration_log (paginate with .range()), filters dim and graded_at < before,
     maps to (stated_confidence/100, 1 if realized_score >= 60 else 0).
   - `recalibrate(sb, stated_conf: float, dimension: str, before=None) -> float | None` —
     per-dim fit if >=80 pairs else global fit if >=80 else None; returns calibrated
     confidence on the 0-100 scale. Module-level cache keyed (dimension, day) so one
     eval pass fits once, not per signal.
2. `analyzer/paper_trader.py` — in `_evaluate_outlook` (:885) where
   `effective_conf = stated - bias` is computed: first try
   `calibration.recalibrate(...)`; use it when not None, else keep the bias path.
   Record which path was used in the signal meta (`"conf_method": "platt"|"bias"`).
   Same treatment in `_evaluate_top_performer` for the `_conf_from_winprob` output.
3. `analyzer/backtest.py` — mirror: pre-load all calibration rows once (already done at
   :473), pass `before=asof` so fits are as-of. Same meta tagging.
4. Validation script (run it, report numbers): fit the global model on all 214 pairs,
   print (a, b) and the calibrated value at stated 40/55/65/80. Sanity: calibrated curve
   must be monotone increasing in stated conf (a > 0). If a <= 0, the track record says
   stated confidence is anti-signal — still ship (that IS the finding) but flag loudly
   in the summary.
5. Run the full backtest; report trade_count/sharpe delta vs previous run in the summary.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 04-winprob-recalibration-platt.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says."

DEFINITION OF DONE
[ ] `fit_platt` reproduces a known case: pairs generated from a true sigmoid (a=2,b=-1)
    with 500 samples recover a within ±0.5, b within ±0.3 (write this as a quick inline
    test in the validation script).
[ ] With <80 pairs for a dim and <80 global, evaluators fall back to the bias debit
    (prove via a filtered REPL call).
[ ] Backtest respects as-of: no calibration row with graded_at >= event time enters any fit.
[ ] Validation numbers + backtest delta reported in the summary.
[ ] py_compile passes on all three files.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not swap in isotonic
regression — at 214 pairs Platt's 2 parameters are the right capacity; isotonic waits
until ~1,000+ pairs (noted in ROADMAP.md).

BLUEPRINT 9: Half-Kelly position sizing with shrunk estimates (activates at 60 closed trades)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Exact formula given; the care is in the shrinkage and the activation gate.)

GOAL
Once the paper book has 60+ closed trades, position sizing graduates from fixed 2%-risk
to half-Kelly computed from the system's OWN measured win rate and win/loss ratio, with
Bayesian shrinkage so a lucky streak cannot balloon size. Below 60 trades, nothing
changes. This was pre-planned: paper_trader.py:27-28 documents the deferral.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/paper_trader.py` (sizing block :512-518 inside
  `_evaluate_one`, and the twin sizing lines in `_evaluate_top_performer` /
  `_evaluate_outlook`; constants :53-86), `analyzer/backtest.py` (same sizing inline in
  its `_eval_*` functions + `_open_shadow_trade`).
- Exact math (implement literally):
  From the last 90 days of closed trades (status like 'closed_%', exit_at within 90d,
  minimum 60 rows. else fixed sizing):
    p_raw = wins / n              (win = net_pnl > 0)
    b = avg_win_inr / avg_loss_inr  (absolute values; if avg_loss == 0, fixed sizing)
    Shrinkage: p = (n * p_raw + K_PSEUDO * 0.5) / (n + K_PSEUDO), K_PSEUDO = 20
      (20 pseudo-observations at coin-flip. a 60-trade sample moves p only 75% of the
      way from 0.5 to p_raw).
    kelly_f = p - (1 - p) / b
    If kelly_f <= 0: fixed sizing (the edge is not positive. do not size up on noise).
    half_kelly = 0.5 * kelly_f
    risk_fraction = min(half_kelly, 0.04)   # hard cap: never risk >4% per trade
    risk_budget = portfolio_base * risk_fraction
  Then the existing qty computation proceeds unchanged
  (qty_by_risk = risk_budget / risk_per_share, capped by MAX_NOTIONAL_PCT as today).
- Gotchas: (1) The three evaluators each have their own sizing lines. extract ONE
  helper `_position_risk_fraction(sb) -> tuple[float, str]` returning (fraction,
  method) where method ∈ {"fixed", "half_kelly"}; call it once per eval PASS (cache in
  eval_signals and pass down), not per signal. (2) Record method + inputs
  (p_raw, p_shrunk, b, kelly_f, n) in each trade's meta for auditability. (3) Backtest
  mirror: compute from the ShadowBook's own closed trades as-of each event (rolling,
  no lookahead). this makes the backtest self-consistently adaptive. (4) MAX_NOTIONAL_PCT
  (5%) stays as the outer cap regardless of Kelly.

CONSTRAINTS
- Must stay inside: `analyzer/paper_trader.py`, `analyzer/backtest.py`.
- Must not change: entry gates, exit logic, friction model, RISK_PER_TRADE constant
  (it remains the fixed-mode value), schema.
- Non-negotiables: activation floor 60 closed trades; 4% risk hard cap; kelly_f <= 0
  falls back to fixed; all Kelly inputs logged in trade meta.

STEP-BY-STEP PLAN
1. `analyzer/paper_trader.py`. constants: `KELLY_MIN_TRADES = 60`, `KELLY_PSEUDO = 20`,
   `KELLY_RISK_CAP = 0.04`, `KELLY_LOOKBACK_DAYS = 90`.
2. New `_position_risk_fraction(sb) -> tuple[float, str, dict]` implementing the math
   above (dict = audit inputs). Wire into `eval_signals`: compute once, pass to the
   three evaluators; each replaces its `portfolio_base * RISK_PER_TRADE` line with
   `portfolio_base * risk_fraction` and stores `{"sizing": method, **audit}` into meta.
3. `analyzer/backtest.py`. same helper logic reading the ShadowBook (list comprehension
   over book.closed as-of event date); wire identically.
4. Verify: synthetic REPL test. feed 80 fake trades (55% win, b=1.4): expect
   p_shrunk=(80*.55+10)/100=0.54, kelly_f=0.54-0.46/1.4≈0.211, half≈0.106 → capped 0.04.
   Show the arithmetic. Then run the full backtest (which now sizes adaptively as its
   shadow history grows) and report equity/sharpe delta vs previous run.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 09-half-kelly-sizing.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says."

DEFINITION OF DONE
[ ] Synthetic test reproduces the worked arithmetic above exactly.
[ ] With <60 closed trades (current live state), sizing is byte-identical to today -
    verified by running eval_signals and confirming method=="fixed" in signal handling.
[ ] Kelly path caps at 4% risk; kelly_f<=0 falls back to fixed (both REPL-proven).
[ ] Trade meta carries sizing method + audit inputs.
[ ] Backtest delta reported. py_compile passes.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not implement full-Kelly,
volatility targeting, or per-ticker Kelly. half-Kelly on book-level stats only.

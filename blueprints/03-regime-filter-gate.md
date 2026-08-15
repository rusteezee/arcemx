BLUEPRINT 3: Market-regime filter gating paper-trader entries and sizing

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Touches the gate stack in two evaluel files with a no-lookahead mirror in backtest. needs care.)

GOAL
The paper trader (and the backtest replay identically) refuses new long entries. or
halves position size. when the market regime is hostile, using three cheap, robust,
small-sample-safe indicators: NIFTY 200DMA trend state, India VIX level, and realized
20d volatility percentile. Research verdict (small-N literature): simple trend + vol
filters are robust at this scale; HMMs are decorative. deliberately NOT used.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/paper_trader.py` (gate stack: constants :53-86,
  `_evaluate_one` :423, `_evaluate_top_performer` :659, `_evaluate_outlook` :885),
  `analyzer/backtest.py` (mirrored gates `_eval_stock_analyst`/`_eval_top_performer`/
  `_eval_outlook`, HistCache :80), `analyzer/market_context.py` (India VIX already
  fetched at :56 as `india_vix` for the LLM payload. the LLM sees it; the mechanical
  gate does not exist yet).
- Verified: `yf.Ticker("^INDIAVIX").history()` works (13.33 close on 2026-07-11);
  `^NSEI` history is already used throughout the repo.
- Data shapes: regime function returns
  `{"trend": "up"|"down", "vix": float, "vix_band": "calm"|"normal"|"stressed", "rv20_pctile": float, "risk_mode": "on"|"half"|"off"}`.
- Decision rules (made here, builder implements literally):
  trend = "up" iff NIFTY close > its 200-session SMA. vix_band: calm < 14, normal 14-20,
  stressed > 20. rv20_pctile = percentile of current 20d realized vol vs trailing 252
  sessions. risk_mode = "off" (no new entries) when trend=="down" AND vix_band=="stressed";
  "half" (halve qty after all sizing) when trend=="down" OR vix_band=="stressed" OR
  rv20_pctile > 90; else "on".
- Gotchas: (1) backtest must compute the SAME regime as-of each event date from cached
  history. no live calls, no lookahead (slice bars strictly before the event date).
  (2) yfinance MultiIndex columns. flatten (pattern: `paper_trader._flatten_yf_columns`).
  (3) Every skip must log to paper_signals with a NEW skip_reason string `"regime_off"`
  so the attribution histogram stays complete. (4) Add the same skip label to
  `web/app/trader/page.tsx` SKIP_LABEL map (:65).

CONSTRAINTS
- Must stay inside: new file `analyzer/regime.py`, `analyzer/paper_trader.py`,
  `analyzer/backtest.py`, `web/app/trader/page.tsx` (SKIP_LABEL only).
- Must not change: gate order before the regime gate, sizing formulas (only a post-multiplier),
  grader, aggregator, any schema.
- Stack: pure yfinance + stdlib; no scipy/sklearn/hmmlearn.
- Non-negotiables: regime gate runs AFTER the cheap JSON gates but BEFORE the yfinance
  liquidity hit in live mode (it is one cached index download per eval pass, not per
  signal). Fail-open: if regime data cannot be fetched, log `regime_data_missing` in
  meta and proceed as risk_mode="on". a data hiccup must never silently freeze trading.

STEP-BY-STEP PLAN
1. Create `analyzer/regime.py`:
   - `fetch_regime(now=None) -> dict`. downloads ^NSEI 1y daily + ^INDIAVIX 5d via
     yfinance (flatten columns), computes the three indicators and risk_mode per the
     decision rules above. Module-level 30-min in-process cache (dict + timestamp) so one
     eval pass = max one download set.
   - `regime_from_history(nifty_bars, vix_value, asof_date) -> dict`. pure function used
     by both paths; `fetch_regime` calls it with live data; backtest calls it with
     HistCache slices strictly before asof.
2. `analyzer/paper_trader.py`. constants block: add `REGIME_GATE_ON = True` (env
   override `ARCEMX_REGIME_GATE`, default on) and `REGIME_HALF_MULT = 0.5`.
   In `eval_signals` (:573): fetch regime once, pass into evaluators.
   In each of the three evaluators: after the edge gate, if `regime["risk_mode"]=="off"`,
   log skip `"regime_off"` (meta=regime dict) and return; if `"half"`, multiply final
   `qty = max(1, int(qty * REGIME_HALF_MULT))` and record `"regime": regime` in trade meta.
3. `analyzer/backtest.py`. build a NIFTY+VIX HistCache entry once per run; compute
   regime per event date via `regime_from_history`; apply identical gate/multiplier in
   all three `_eval_*` functions; count `regime_off` in the skips histogram.
4. `web/app/trader/page.tsx`. SKIP_LABEL: add `regime_off: "Regime risk-off"`.
5. Run a real backtest locally (`.venv\Scripts\python.exe -m analyzer.backtest`) and
   compare trade_count/sharpe vs the previous run (backtest_runs id 2: 47 trades,
   sharpe -13.3). report both numbers in the summary. A regime gate that changes
   nothing is suspicious; one that filters some June entries is expected.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 03-regime-filter-gate.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says."

DEFINITION OF DONE
[ ] `.venv\Scripts\python.exe -c "from analyzer.regime import fetch_regime; print(fetch_regime())"`
    prints a dict with all 5 keys and a valid risk_mode.
[ ] Live evaluators and backtest evaluators both apply the gate (grep shows `regime` in
    both paper_trader.py and backtest.py eval paths).
[ ] Backtest run completes; summary reports old-vs-new trade_count and sharpe.
[ ] Regime fetch failure path proven: temporarily monkeypatch fetch to raise in a REPL,
    confirm eval continues risk-on with `regime_data_missing` meta.
[ ] py_compile passes on all three Python files; SKIP_LABEL updated.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. Do not add more indicators.

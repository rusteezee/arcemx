BLUEPRINT 7: Earnings-blackout entry gate

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Gate-stack change mirrored in backtest; date logic needs care but data plumbing exists.)

GOAL
The paper trader refuses new entries in any stock within N sessions BEFORE its scheduled
quarterly results date. the single most predictable source of gap risk that stops and
targets cannot protect against. Backtest mirrors it.

CONTEXT THE BUILDER NEEDS
- Files to read first: `analyzer/aggregator.py:110` (`_ticker_calendar`. ALREADY parses
  yfinance's calendar dict per ticker: keys include "Earnings Date"; verified live on
  RELIANCE.NS returning dict with 'Earnings Date', 'Ex-Dividend Date'), and the
  enrichment cache flow (`_fetch_enrichment` :300 writes `ticker_enrichment` table with
  24h TTL. earnings dates ride this cache; check the payload subkey name it stores
  under), `analyzer/paper_trader.py` (gate stack), `analyzer/backtest.py` (mirror).
- Decision (made here): EARNINGS_BLACKOUT_SESSIONS = 3 (no new entries when the next
  earnings date is within 3 trading sessions ahead, or yesterday/today. post-result
  drift is allowed from the 2nd session after). Skip reason string: `"earnings_blackout"`.
- Gotchas: (1) yfinance "Earnings Date" is often a LIST of candidate dates (range) -
  take the earliest future one. (2) Not every ticker has calendar data. missing date =
  gate passes (fail-open), but record `"earnings_date": null` in meta. (3) Backtest
  as-of problem: historical earnings dates are NOT retrievable from yfinance's calendar
  (it only shows upcoming). For the backtest mirror, use `yf.Ticker(t).earnings_dates`
  (a DataFrame of past + future events) sliced as-of the event date; if that call fails
  for a ticker, the backtest gate passes fail-open for it. document this asymmetry in
  a comment. (4) Trading-session arithmetic: use the ticker's own bar dates from
  HistCache (backtest) or a simple weekday walk (live). do not import a holiday lib.

CONSTRAINTS
- Must stay inside: `analyzer/paper_trader.py`, `analyzer/backtest.py`,
  `analyzer/aggregator.py` (only if the enrichment cache does not already expose the
  next-earnings date. then extend `_ticker_calendar`'s stored shape),
  `web/app/trader/page.tsx` (SKIP_LABEL map only).
- Must not change: gate order of existing gates, sizing, grader.
- Non-negotiables: fail-open on missing data; one yfinance calendar hit per unique
  ticker per eval pass max (respect the existing enrichment cache; do not add a fresh
  per-signal network call).

STEP-BY-STEP PLAN
1. `analyzer/paper_trader.py`. constant `EARNINGS_BLACKOUT_SESSIONS = 3`. New helper
   `_next_earnings_date(sb, ticker) -> date | None`: read the ticker_enrichment cache
   row (pattern: `_ticker_sector_and_cap` :352 reads the same table); if the cached
   payload lacks a calendar/earnings key, fall back to one direct
   `yf.Ticker(t).calendar` call (flatten/parse per aggregator._ticker_calendar's logic).
   New gate in all three evaluators after the regime gate (or after the edge gate if
   blueprint 03 is not yet merged): if next earnings date is within
   EARNINGS_BLACKOUT_SESSIONS trading days ahead (weekday walk), log skip
   `"earnings_blackout"` with meta `{"earnings_date": iso}` and return.
2. `analyzer/backtest.py`. per-ticker earnings history via
   `yf.Ticker(t).earnings_dates` cached in HistCache (new method
   `earnings_dates(ticker)` caching the DataFrame once per ticker); gate mirrors live
   logic using bar-date session arithmetic, as-of the event date only.
3. `web/app/trader/page.tsx`. SKIP_LABEL: `earnings_blackout: "Earnings blackout"`.
4. Verify: unit-style REPL check on a ticker with known upcoming results (July 2026
   earnings season. RELIANCE.NS calendar verified working); then full backtest run,
   report how many historical entries the gate removes and the sharpe delta.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 07-earnings-blackout-gate.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then the named files,
  then build exactly what it says."

DEFINITION OF DONE
[ ] A ticker with results inside 3 sessions is skipped with reason earnings_blackout
    (prove with one real ticker in July earnings season, shown in summary).
[ ] Missing calendar data passes the gate and records earnings_date null in meta.
[ ] Backtest gate uses only as-of information; asymmetry comment present.
[ ] Backtest delta (entries removed, sharpe change) reported.
[ ] py_compile passes; SKIP_LABEL updated.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going.

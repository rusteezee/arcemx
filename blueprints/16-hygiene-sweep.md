BLUEPRINT 16: Hygiene sweep (schema parity, dead code, dead secrets, security check)

BUILDER: Claude Haiku, working alone, cold start, cannot ask questions.
(A checklist of small, independent, mechanical fixes. No design decisions left.)

GOAL
Every known piece of repo drift is closed: schema.sql matches the live DB, dead
pipelines and secrets are removed, the one security-unknown (mcp_tokens RLS) is
verified, and stale validation code matches the current schema.

CONTEXT THE BUILDER NEEDS
- Findings being fixed (from the 2026-07-13 grounding audit):
  a. Four LIVE tables missing from db/schema.sql: `stock_analyses` (16 rows),
     `mcp_tokens` (2 rows — holds INDmoney OAuth tokens), `prediction_embeddings`
     (2,273 rows), `realized_pnl` (11 rows). A rebuild from schema.sql would drop them.
  b. mcp_tokens RLS posture is UNDOCUMENTED — if anon can read it, the user's INDmoney
     OAuth tokens are exposed to the browser key. Must verify and lock.
  c. `trends` table: 0 rows EVER; fetchers/trends.py is called from aggregator but
     pytrends fails silently. DECISION: kill it — remove the aggregator call + the
     payload key + fetchers/trends.py + the table (keep pytrends out of requirements
     too). Google Trends added no measured value in 5 weeks of never working.
  d. Dead GH Actions secrets: OPENROUTER_ENSEMBLE, OPENROUTER_ENSEMBLE_MODELS,
     OPENROUTER_API_KEY_1/2/3 (ensemble removed 2026-07-12; Render's copies already
     deleted).
  e. `analyzer/bakeoff.py` REQUIRED_KEYS still validates the RETIRED
     short_term_picks/long_term_picks schema — update to top_performers/worst_performers.
  f. `bot/telegram_bot.py` `push_daily()` (~:594) — vestigial fake-update shim for a
     /push endpoint that does not exist; bot/daily_push.py superseded it. Delete.
  g. NSE-holiday cron gap: crons fire on Indian market holidays. Fix zero-cost: commit
     `data/nse_holidays_2026.json` (builder fills from the official NSE 2026 trading
     holiday list — hardcode the dates, cite the list in a comment) + helper
     `analyzer/market_calendar.py::is_trading_day(d)` (weekday AND not in holiday
     json) + guard at the TOP of aggregator.run_if_stale and grader.__main__:
     print + exit 0 on non-trading days.
  h. `fetchers/indmoney_probe_transactions.py`, `fetchers/indmoney_debug.py` — move to
     a new `fetchers/dev/` subfolder with a README line ("discovery scripts, not
     pipeline") so the pipeline folder stays clean. Do NOT delete (probe.txt evidence
     is referenced by blueprints).
  i. `nsepython==2.95` in requirements.txt line ~12: installed, ZERO imports anywhere,
     and NSE blocks cloud IPs anyway. Remove from requirements.txt.
  j. README stale claims: "powered by Gemini" (brain is OpenRouter), /alert +
     backtest listed as future roadmap items (both live as of 2026-07-12). Fix both.
- DDL for (a): reverse-engineer CREATE TABLE statements from live column shapes (query
  a sample row per table via the service client and map types conservatively:
  text/numeric/jsonb/timestamptz/bigserial pk). Append to schema.sql under a comment
  "-- Tables created out-of-band, reconstructed 2026-07 for parity". Add all four to
  the RLS-enable block; anon-read policy ONLY for stock_analyses + realized_pnl
  (the web reads them); prediction_embeddings and mcp_tokens get NO anon policy.
- Verification for (b): with the ANON key (web/.env.local NEXT_PUBLIC_SUPABASE_ANON_KEY),
  attempt `select * from mcp_tokens limit 1`. Empty/denied = good; rows = CRITICAL —
  print the exact `alter table mcp_tokens enable row level security;` remediation for
  the user to run IMMEDIATELY and flag at the top of the summary.

CONSTRAINTS
- Must stay inside: files named above + db/schema.sql + README.md + requirements.txt.
- Must not change: any live behavior except the intentional deletions listed.
- Non-negotiables: (b) runs FIRST (security); user-run SQL is printed, never assumed
  applied; each sub-fix is its own commit for revertability.

STEP-BY-STEP PLAN (each letter = one commit, in this order)
1. (b) mcp_tokens RLS probe with anon key; print remediation SQL if exposed.
2. (a) schema parity: reconstruct 4 CREATE TABLEs; append + RLS lines; print the SQL
   block for the user to run in Supabase (idempotent `if not exists` forms).
3. (c) trends kill: remove aggregator call/key, delete fetchers/trends.py, drop
   pytrends from requirements.txt, print `drop table trends;` for the user (their call).
4. (d) `gh secret delete OPENROUTER_ENSEMBLE OPENROUTER_ENSEMBLE_MODELS
   OPENROUTER_API_KEY_1 OPENROUTER_API_KEY_2 OPENROUTER_API_KEY_3` (one per invocation).
5. (e) bakeoff REQUIRED_KEYS update. 6. (f) push_daily deletion.
7. (g) holiday calendar + guards. 8. (h) dev-scripts move. 9. (i) nsepython removal.
10. (j) README fixes. 11. Full test: py_compile every touched module; dispatch
   daily_sync.yml once (proves workflows unbroken); `.venv\Scripts\python.exe -c "from
   analyzer.market_calendar import is_trading_day; from datetime import date;
   print(is_trading_day(date(2026,8,15)))"` → False (Independence Day).

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 16-hygiene-sweep.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Work the lettered checklist in order,
  one commit each, security probe first."

DEFINITION OF DONE
[ ] mcp_tokens verified anon-inaccessible (or remediation printed FIRST and flagged).
[ ] schema.sql rebuild-parity: every live table present incl. the 4 reconstructed.
[ ] trends pipeline fully gone; analysis payload no longer carries the key.
[ ] 5 dead GH secrets deleted (gh secret list shows none of them).
[ ] is_trading_day guard proven on a 2026 NSE holiday; crons exit clean on holidays.
[ ] bakeoff validates current keys; push_daily gone; dev scripts moved; nsepython
    removed; README accurate. All commits pushed, daily_sync dispatch green.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going.

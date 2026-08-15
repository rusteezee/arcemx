BLUEPRINT 6: FII/DII flow trend from the mirror's history endpoint

BUILDER: Claude Haiku, working alone, cold start, cannot ask questions.
(One fetcher function + one payload key, exactly mirroring an existing pattern.)

GOAL
The morning payload's FII/DII block gains trend context: 5-day and 20-day cumulative
net flows and a streak counter, so the LLM sees "FII sold 4 of last 5 sessions,
-6,400cr cumulative" instead of only yesterday's single number.

CONTEXT THE BUILDER NEEDS
- Files to read first: `fetchers/fii_dii.py` (83 lines. the whole existing module;
  `fetch_latest` :58 hits `https://fii-diidata.mrchartist.com/api/data`; module
  docstring documents an unused `/api/history` endpoint returning ~60 days; `_shape`
  :30 shows the compact dict convention), `analyzer/aggregator.py` (where flows are
  added to the payload. grep `fii`), `analyzer/llm_router.py:823` (_PAYLOAD_DROP_ORDER).
- Gotchas: (1) grader.py's `fii_flow_1d` dim discovered the mirror's row keys are SHORT
  names (`d`, `fn`). verify actual history keys by fetching once and printing before
  parsing. (2) The GitHub raw history.json backstop pattern in fetch_latest should apply
  to history too. (3) Signals must be computed from TRADING days present in the data -
  do not calendar-pad.

CONSTRAINTS
- Must stay inside: `fetchers/fii_dii.py`, `analyzer/aggregator.py`,
  `analyzer/llm_router.py` (drop order + one SYSTEM_PROMPT sentence).
- Must not change: fetch_latest, grader's fii_flow_1d dim.
- Non-negotiables: ₹0; failure returns None and the payload omits the key.

STEP-BY-STEP PLAN
1. `fetchers/fii_dii.py`. add `fetch_history(days: int = 20) -> dict | None`:
   GET `/api/history`, parse rows (verify keys by printing first row on first run),
   compute: `{"fii_net_5d": float, "fii_net_20d": float, "dii_net_5d": float,
   "dii_net_20d": float, "fii_streak": int, "read": str}` where fii_streak is signed
   consecutive-day count of same-sign FII cash net (e.g. -4 = 4 straight selling days),
   and read is one sentence composed from fixed rules (streak >= 3 or |net_5d| > 5000cr
   is "notable", else "mixed").
2. `analyzer/aggregator.py`. next to the existing flows fetch: add
   `payload["flows_trend"] = fetch_history()` (try/except → None).
3. `analyzer/llm_router.py`. add "flows_trend" to _PAYLOAD_DROP_ORDER (after
   "options_signals" if blueprint 05 landed, else after "reddit"). SYSTEM_PROMPT: one
   sentence where flows are described: "flows_trend (when present) gives 5d/20d
   cumulative FII/DII nets and a same-direction streak. weigh persistent flows more
   than any single day."
4. Verify: run the fetch locally, print the dict; run build_payload confirming the key.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 06-fii-dii-history-trend.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Verify the history endpoint's real row
  keys before parsing."

DEFINITION OF DONE
[ ] fetch_history() returns the exact dict shape with real numbers from the live mirror.
[ ] Streak arithmetic hand-checked against the raw rows for the latest 6 sessions
    (show in summary).
[ ] Payload carries flows_trend; drop order + prompt sentence added.
[ ] Endpoint failure path returns None without raising (test with a bad URL).

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. If /api/history does not exist
or returns <10 days, fall back to accumulating fetch_latest daily into a new Supabase
table. but STOP and flag first, since that needs user-run DDL.

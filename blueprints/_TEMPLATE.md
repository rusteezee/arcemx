# Blueprint template

Every blueprint in this folder fills in exactly these fields, in this order, so the
builder model always knows where to look. Written by the planning model (Fable 5) on
2026-07-13, grounded in the real repo + live July-2026 research. The builder is a
cheaper model working alone, cold start, cannot ask questions.

---

BLUEPRINT [n]: [short name]

BUILDER: [Claude Sonnet | Claude Haiku], working alone, cold start, cannot ask questions.
(one line on why this model fits this item)

GOAL
One or two plain sentences: what exists and works when this is done.

CONTEXT THE BUILDER NEEDS (it has no memory of the planning chat)
- Files to read first: [real repo paths]
- Real inputs, in full: [data shapes, env vars, API endpoints. if not written here it does not exist]
- Gotchas: [traps found while grounding]

CONSTRAINTS
- Must stay inside: [exact files/modules]
- Must not change: [files/APIs/schemas to leave alone]
- Stack to respect: [languages, libs, patterns already in use]
- Non-negotiables: [₹0 recurring cost, style, naming, safety rules]

STEP-BY-STEP PLAN (in build order)
1. [exact file]. [exact change with signatures/shapes]
2. ...

EXACT INPUTS TO USE
- The one prompt to hand the builder: "[kick-off instruction]"
- Copy / values / snippets to use verbatim: [...]

DEFINITION OF DONE (checklist. every box pass or fail)
[ ] [observable behavior]
[ ] [exact command/test that must pass]
[ ] [edge case handled]
[ ] [nothing in CONSTRAINTS violated]

IF SOMETHING IS UNCLEAR (anti-stall)
Make the smallest safe assumption, write it at the top of the output as
"ASSUMPTION: ...", and keep going. Never stall, never invent big new scope.

---

## Repo-wide facts every builder must know (restated in each blueprint where relevant)

- Repo: `C:\Users\rahul\Downloads\stock-ai`, GitHub `rusteezee/arcemx`, branch `master`.
- Python 3.11 via `.venv\Scripts\python.exe` (system python is 3.14. never use bare `python`).
- Supabase Postgres; Python/JS clients CANNOT run DDL. Any `CREATE TABLE`/`ALTER` goes in
  `db/schema.sql` AND is given to the user to paste into Supabase's SQL Editor.
- PostgREST caps every response at 1000 rows regardless of `.limit()`. paginate with `.range()`.
- yfinance returns MultiIndex columns even for one ticker. flatten before column access
  (see `paper_trader._flatten_yf_columns`).
- The LLM payload is capped at 120k chars; new payload fields must be added to
  `llm_router._PAYLOAD_DROP_ORDER` (llm_router.py:823) if droppable.
- `backtest.py` imports gate constants + friction functions from `paper_trader.py` -
  tune knobs ONLY in paper_trader.py; add any new gate in BOTH evaluators.
- All 1d grading is session-anchored via `grader._session_bounds`. never calendar-day windows.
- Telegram messages use legacy Markdown: no literal underscores in display text.
- Verify live after deploy: Netlify needs ~60-90s post-push; `gh run list --workflow=X` can
  falsely show empty right after a new workflow's first dispatch.
- ₹0 recurring cost is a hard rule. One-time spends must be flagged to the user, never assumed.

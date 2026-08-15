BLUEPRINT 5: Options-chain signals via INDmoney MCP (PCR, OI walls, max pain)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(New fetcher against a remote MCP tool with unknown-shape output. needs probe-first discipline.)

GOAL
The morning analysis payload carries a compact options-derived signal block for NIFTY
(and optionally the user's holdings): put-call ratio, top OI strike walls
(support/resistance implied by open interest), and max-pain strike. Sourced through the
INDmoney MCP tool `get_indian_stocks_option_chain`. which rides the user's existing
OAuth session and is NOT blocked from datacenter IPs (unlike NSE's own endpoints, which
are blocked from GH Actions runners. verified constraint, do not attempt nsepython here).

CONTEXT THE BUILDER NEEDS
- Files to read first: `fetchers/indmoney_mcp.py` (the MCP client: SupabaseTokenStorage
  :53, `_refresh_tokens_if_needed` :327, tool-calling pattern inside `sync_to_supabase`
  :404. REUSE this client, do not write a new one), `fetchers/fii_dii.py` (the shape of
  a compact signal dict embedded in the payload), `analyzer/aggregator.py:335`
  (build_payload. where the new key plugs in), `analyzer/llm_router.py:823`
  (_PAYLOAD_DROP_ORDER) and SYSTEM_PROMPT (:108-513, where a usage paragraph is added).
- PROBE FIRST (mandatory step 1): the exact response shape of
  `get_indian_stocks_option_chain` is UNKNOWN. Before writing the transformer, call the
  tool once with the pattern from `fetchers/indmoney_debug.py` and save the raw JSON to
  `fetchers/probe_option_chain.json`. Build the parser against the REAL shape. If the
  tool needs an instrument key, resolve NIFTY via the `lookup_ind_keys` tool (existing
  usage in indmoney_mcp.py ticker-resolution chain).
- Signal math (decided here):
  PCR = total put OI / total call OI across the nearest expiry.
  OI walls = top 2 strikes by call OI (resistance) and top 2 by put OI (support).
  Max pain = the standard construction: for each candidate strike K (every listed
  strike), total buyer payout = Σ over call strikes c: OI_c * max(0, K - c) + Σ over put
  strikes p: OI_p * max(0, p - K); max_pain = the K with the minimum total payout.
  Output dict (keep under ~600 chars serialized):
  `{"pcr": 0.92, "expiry": "2026-07-31", "call_walls": [25600, 26000], "put_walls": [25000, 24800], "max_pain": 25400, "spot": 25480.5, "read": "PCR<1 mildly bearish; heavy call OI 25600 caps upside"}`
  The `read` line is computed from fixed rules: PCR > 1.2 = "put-heavy, supportive";
  0.8-1.2 = "balanced"; < 0.8 = "call-heavy, capped upside". Mention nearest wall.
- Gotchas: (1) OAuth tokens live in Supabase mcp_tokens. the fetcher works from GH
  Actions only because of that shared storage; test from a GH-dispatched run too.
  (2) INDmoney occasionally 512s. wrap in 3-retry like sync_to_supabase does, and on
  total failure return None so the payload simply omits the key (analysis must not fail
  because options data hiccuped). (3) Add `options_signals` to _PAYLOAD_DROP_ORDER
  (droppable, after reddit) so it can never crowd out core fields.

CONSTRAINTS
- Must stay inside: new file `fetchers/options_chain.py`, `analyzer/aggregator.py`,
  `analyzer/llm_router.py` (drop order + one SYSTEM_PROMPT paragraph),
  `fetchers/probe_option_chain.json` (committed probe snapshot).
- Must not change: indmoney_mcp.py sync logic, grader, paper_trader.
- Non-negotiables: ₹0; total failure of options fetch must not block or delay the
  morning analysis by more than the 3-retry budget (~15s).

STEP-BY-STEP PLAN
1. Probe: minimal script inside `fetchers/options_chain.py` under
   `if __name__ == "__main__":`. connect via the existing client machinery from
   indmoney_mcp.py, call `get_indian_stocks_option_chain` for NIFTY, dump raw JSON to
   `fetchers/probe_option_chain.json`, print the top-level keys. RUN IT. Read the output.
2. Write `fetch_options_signals(symbols: list[str] | None = None) -> dict | None` in the
   same file: NIFTY always; parse per the REAL probed shape; compute PCR/walls/max-pain
   per the math above; 3-retry on 512; return None on failure.
3. `analyzer/aggregator.py` build_payload: add
   `payload["options_signals"] = fetch_options_signals()` alongside the existing flows
   fetch (mirror fii_dii's try/except style).
4. `analyzer/llm_router.py`: add "options_signals" to _PAYLOAD_DROP_ORDER after
   "reddit". SYSTEM_PROMPT: add one paragraph in the inputs section (near where flows
   are described). exact copy:
   "options_signals (when present): NIFTY option-chain read. pcr (put/call OI ratio),
   call_walls (heavy call-OI strikes = likely resistance), put_walls (put-OI strikes =
   likely support), max_pain (expiry gravitation level). Use for nifty_outlook range
   placement and to sanity-check top_performers entries near walls. Do not invent
   options data for individual stocks; it is index-level only unless a ticker block exists."
5. Verify: run `.venv\Scripts\python.exe -m fetchers.options_chain` locally (probe), then
   a full local `build_payload()` confirming the key exists and serializes < 1KB, then
   dispatch `daily_analysis.yml` once and confirm the run log shows options_signals
   fetched (or cleanly skipped) from a GH runner.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 05-options-signals-indmoney.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Step 1 is a mandatory probe. run it and
  read the real JSON before writing the parser."

DEFINITION OF DONE
[ ] probe_option_chain.json committed with real (non-empty) response.
[ ] fetch_options_signals() returns the exact output dict shape with real numbers, or
    None on simulated failure (test by breaking the token env temporarily).
[ ] PCR/max-pain hand-verified once against the probed chain (show the arithmetic for
    one expiry in the summary).
[ ] payload contains options_signals; _PAYLOAD_DROP_ORDER contains it; SYSTEM_PROMPT
    paragraph added verbatim.
[ ] One real GH-runner execution confirms datacenter-IP viability.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. If the MCP tool turns out to
not exist or returns entitlement errors, STOP after the probe, commit the probe evidence,
and report. do not fall back to scraping NSE (blocked, wasted effort).

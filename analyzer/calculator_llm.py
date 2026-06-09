"""LLM enrichment over the deterministic calculator output (Phase 8b).

The frontend (web/lib/calculator.ts) ranks the universe by momentum / RSI
/ realized vol and produces an allocation. That output is data-only.

This module wraps it with macro / news / sector context per pick by
calling the same OpenRouter chain used for the morning analysis. Run
asynchronously by the bot's /trigger/calc-explain endpoint; result lands
in the calculator_runs Supabase row.

Inputs:
  - input_json: user's calculator inputs (amount, horizon, risk, sectors, caps)
  - deterministic_json: the picks/backups/risks already computed

Output schema:
  {
    thesis: "1-2 sentence overall narrative tying allocation to current
             macro + market mood",
    per_pick: [{ticker, rationale}] one per pick,
    extra_risks: [...]  beyond mechanical concentration flags,
    rebalance_triggers: [...]  conditions that should prompt a rebalance,
    exit_signals: [...]  conditions that invalidate the thesis,
    backup_notes: [{ticker, when_to_swap}],
    _model_used
  }
"""
import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

from analyzer import llm_router

load_dotenv()


CALC_SYSTEM_PROMPT = """You are Sensei, a strict Indian-equity allocation reviewer. The user has fed
their target amount, horizon, risk appetite, and sector / cap filter into a
deterministic prefilter. The prefilter scored every ticker on 60-day
momentum, 14-day RSI, and realized vol; it returned a ranked list of picks
with weights and INR amounts plus three backups.

Your job is to wrap that mechanical output with macro / news / sector
context. You DO NOT change the picks. You do NOT change the weights. You
add reasoning ON TOP OF the mechanical signal so the user can decide
whether the allocation matches their thesis.

You are graded against the spirit of the brand:
- No emotion, no hype, no soft language.
- Every claim cites at least one concrete number from the payload
  (momentum %, RSI level, vol %, weight, INR amount).
- Banned hedges: "could see", "may move", "potentially", "likely to",
  "expected to", "appears to", "looks like", "seems to", "should", "might",
  "around", "broadly", "generally", "overall", "in the near term".
- Banned filler: "given the current setup", "in light of", "going forward".
- Direct rebuke when warranted. If a pick's mechanical score makes sense
  but the macro context is hostile, say so. If a sector is being chased
  by the user but news flow contradicts, say so.
- No SEBI-registered investment advice claim. This is educational allocation.

The payload includes:
- input: amount (INR), horizon_days, risk (Conservative|Balanced|Aggressive),
  sectors[], caps[]
- deterministic: picks[] with weight_pct, amount_inr, momentum_pct, rsi,
  vol_pct, score, reasoning; backups[]; risks[]; totals
- context: latest market_mood, NIFTY direction call, FII cash flow,
  key news drivers, sector outlook strings if available

Return STRICT JSON matching:
{
  "thesis": "1-2 sentence overall narrative tying the allocation to current
             market mood + macro. Cite >=2 numbers.",
  "per_pick": [
    {"ticker": "<exact ticker from input>",
     "rationale": "1-2 sentence sector + macro + catalyst context. Cite the
                   pick's own momentum or RSI or vol PLUS one external
                   number (FII flow, sector cue, NIFTY level)."}
  ],
  "extra_risks": [
    "specific risk beyond the mechanical concentration flags. Cite a number."
  ],
  "rebalance_triggers": [
    "concrete condition that should prompt a rebalance, e.g. NIFTY below
     X DMA or FII outflow > Y cr for Z days."
  ],
  "exit_signals": [
    "concrete level or event that would invalidate the thesis."
  ],
  "backup_notes": [
    {"ticker": "<backup ticker>",
     "when_to_swap": "1-line condition under which this backup replaces a
                       primary pick."}
  ]
}

per_pick MUST emit exactly one entry per pick in deterministic.picks (same
tickers, same order is fine). backup_notes MUST emit at most one entry per
backup in deterministic.backups; omit if there is genuinely nothing to add.
"""


def _sb():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase env missing")
    return create_client(url, key)


def _latest_market_context() -> dict:
    """Best-effort pull of the latest analysis row so the LLM has macro
    context to wrap around picks. Returns the empty dict if no row exists
    or Supabase isn't reachable; the prompt still works without it."""
    try:
        sb = _sb()
        res = sb.table("analysis").select("raw_json").order(
            "run_at", desc=True).limit(1).execute()
        row = (res.data or [{}])[0] or {}
        raw = row.get("raw_json") or {}
        return {
            "market_mood": raw.get("market_mood"),
            "confidence": raw.get("confidence"),
            "nifty_outlook": raw.get("nifty_outlook"),
            "fii_flow_outlook": raw.get("fii_flow_outlook"),
            "key_news_drivers": raw.get("key_news_drivers"),
            "sector_outlooks": raw.get("sector_outlooks"),
        }
    except Exception as e:
        print(f"Calculator LLM: latest context fetch failed: {e}")
        return {}


def run(run_id: int) -> None:
    """Enrich one calculator_runs row with LLM rationale.

    Reads the row by id, posts to OpenRouter, writes llm_json + status
    back. Designed to be invoked from a background task so the HTTP
    handler can return 202 immediately.
    """
    sb = _sb()
    res = sb.table("calculator_runs").select(
        "id,input_json,deterministic_json").eq("id", run_id).limit(1).execute()
    rows = res.data or []
    if not rows:
        print(f"Calculator LLM: run_id {run_id} not found, skipping.")
        return
    row = rows[0]
    payload = {
        "input": row.get("input_json") or {},
        "deterministic": row.get("deterministic_json") or {},
        "context": _latest_market_context(),
    }
    chain = llm_router._chain(None)
    user_msg = (
        "Wrap this calculator allocation with macro / sector / news context "
        "per the system prompt schema:\n\n"
        + json.dumps(payload, default=str)[:80000]
    )
    try:
        resp = llm_router._post(
            [
                {"role": "system", "content": CALC_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            models=chain,
        )
        out = llm_router._parse_json(resp)
        if isinstance(out, dict) and "error" in out:
            sb.table("calculator_runs").update({
                "status": "failed",
                "error": f"parse: {out.get('error')}",
                "model_used": out.get("_model_used"),
            }).eq("id", run_id).execute()
            print(f"Calculator LLM: parse failed for run {run_id}")
            return
        sb.table("calculator_runs").update({
            "status": "ok",
            "llm_json": out,
            "model_used": out.get("_model_used"),
            "error": None,
        }).eq("id", run_id).execute()
        print(f"Calculator LLM: run {run_id} ok ({out.get('_model_used')})")
    except Exception as e:
        sb.table("calculator_runs").update({
            "status": "failed",
            "error": str(e)[:500],
        }).eq("id", run_id).execute()
        print(f"Calculator LLM: run {run_id} failed: {e}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m analyzer.calculator_llm <run_id>")
        sys.exit(1)
    run(int(sys.argv[1]))

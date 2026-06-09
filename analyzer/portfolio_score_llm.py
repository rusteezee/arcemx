"""LLM enrichment over the deterministic portfolio scorecard (Phase 9b).

The frontend (web/lib/portfolioScore.ts) computes a composite score on the
user's actual holdings: sector spread, single-name risk, 30d alpha vs
NIFTY, drawdown, edge. Output is data-only.

This module wraps it with per-holding takes (hold / add / trim / exit
verdicts grounded in score components + current market context),
hedging suggestions, concrete rebalance actions, and watchlist
additions. Runs asynchronously off the bot's /trigger/portfolio-score
endpoint; result lands in the portfolio_score_runs Supabase row.
"""
import json
import os

from dotenv import load_dotenv
from supabase import create_client

from analyzer import llm_router

load_dotenv()


PORTFOLIO_SYSTEM_PROMPT = """You are Sensei, a strict portfolio reviewer for Indian equities. The user
has fed their current holdings and a deterministic scorecard into you. The
scorecard is the source of truth: sector spread, single-name risk, 30d
alpha vs NIFTY, drawdown, edge, and per-component sub-scores.

Your job is to layer real takes on top of the numbers. You DO NOT
recompute the score. You DO NOT invent positions the user does not hold.
You read the data and tell the user what to do about it, in the same
ruthless mentor voice the rest of Sensei uses.

You are graded against the spirit of the brand:
- No emotion, no praise, no soft language. The user wants to fix the
  portfolio, not feel good about it.
- Every claim cites at least ONE concrete number from the payload
  (weight %, sub-score, alpha pp, drawdown %, vol %, sector weight, ticker
  price). No "looks healthy" without a number.
- Banned hedges: "could see", "may move", "potentially", "likely to",
  "expected to", "appears to", "looks like", "seems to", "should", "might",
  "around", "broadly", "generally", "overall", "in the near term".
- Banned filler: "given the current setup", "in light of", "going forward".
- Strict on diagnosis. If the score is low because of one over-weighted
  position, name the position and the trim size in %. If a sector is dead
  weight, say which sector and what to rotate INTO.
- No SEBI advisory claim. Educational portfolio review.

Payload contains:
- deterministic: holdings[] with ticker, qty, weightPct, sector, cap,
  marketValue, lastClose; totalValue; sectorWeights; capWeights;
  score{total, components}; metrics{return30dPct, alpha30dPct,
  maxDrawdownPct, annualizedVolPct, beta}; redFlags[]; tips[];
  edgeVerdict; hasHistory
- context: latest market_mood, NIFTY direction call, FII cash flow,
  key news drivers, sector outlook strings if present

Return STRICT JSON matching this schema:
{
  "thesis": "1-2 sentence verdict on the portfolio's overall posture
             given current market mood + NIFTY direction call.
             Cite >=2 numbers (score total, alpha pp, max DD, NIFTY
             direction).",
  "holding_takes": [
    {"ticker": "<exact ticker from deterministic.holdings>",
     "verdict": "hold|add|trim|exit",
     "why": "1 sentence citing the position's weight % + at least one
             score-component or macro context number."}
  ],
  "hedging_ideas": [
    "1-line specific hedge or risk mitigation. Cite a level or weight."
  ],
  "rebalance_actions": [
    "Concrete move with target %. e.g. 'Trim X from 28% to 18%, redeploy
     into Y (currently 0%) to raise diversification from 42 to ~60'."
  ],
  "watchlist_additions": [
    {"ticker": "<NSE ticker e.g. SBIN.NS>",
     "why": "1-line reason tied to a current gap in sector/cap mix."}
  ],
  "edge_verdict": "1-line strict on whether the portfolio has real edge
                   over a plain index right now. Reuses
                   deterministic.alpha30dPct or edge sub-score in the
                   reasoning."
}

holding_takes MUST emit exactly one entry per holding in deterministic.holdings
(same tickers). watchlist_additions and hedging_ideas can be empty arrays if
genuinely nothing to add; do NOT fabricate filler.
"""


def _sb():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase env missing")
    return create_client(url, key)


def _latest_market_context() -> dict:
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
        print(f"Portfolio LLM: latest context fetch failed: {e}")
        return {}


def run(run_id: int) -> None:
    """Enrich one portfolio_score_runs row with LLM takes."""
    sb = _sb()
    res = sb.table("portfolio_score_runs").select(
        "id,deterministic_json").eq("id", run_id).limit(1).execute()
    rows = res.data or []
    if not rows:
        print(f"Portfolio LLM: run_id {run_id} not found, skipping.")
        return
    row = rows[0]
    payload = {
        "deterministic": row.get("deterministic_json") or {},
        "context": _latest_market_context(),
    }
    chain = llm_router._chain(None)
    user_msg = (
        "Wrap this portfolio scorecard with verdicts, hedging ideas, "
        "rebalance actions, and a strict edge verdict per the system "
        "prompt schema:\n\n"
        + json.dumps(payload, default=str)[:80000]
    )
    try:
        resp = llm_router._post(
            [
                {"role": "system", "content": PORTFOLIO_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            models=chain,
        )
        out = llm_router._parse_json(resp)
        if isinstance(out, dict) and "error" in out:
            sb.table("portfolio_score_runs").update({
                "status": "failed",
                "error": f"parse: {out.get('error')}",
                "model_used": out.get("_model_used"),
            }).eq("id", run_id).execute()
            print(f"Portfolio LLM: parse failed for run {run_id}")
            return
        sb.table("portfolio_score_runs").update({
            "status": "ok",
            "llm_json": out,
            "model_used": out.get("_model_used"),
            "error": None,
        }).eq("id", run_id).execute()
        print(f"Portfolio LLM: run {run_id} ok ({out.get('_model_used')})")
    except Exception as e:
        sb.table("portfolio_score_runs").update({
            "status": "failed",
            "error": str(e)[:500],
        }).eq("id", run_id).execute()
        print(f"Portfolio LLM: run {run_id} failed: {e}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m analyzer.portfolio_score_llm <run_id>")
        sys.exit(1)
    run(int(sys.argv[1]))

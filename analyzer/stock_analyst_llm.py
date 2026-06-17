"""Stock Analyst LLM module.

Consumes analyzer.stock_deep.deep_fetch output for one ticker and
produces a strict-JSON deep analysis with rating, score, phase,
buy-window, summary, and reasoning. Persisted to the stock_analyses
table (row pre-inserted by the bot trigger; this module updates it
in place to status='ok' or status='failed').

Learning loop is strict: every prior graded prediction for the SAME
ticker at the SAME horizon is injected into the user prompt as
`prior_self_predictions` so the model literally sees its own past
calls and outcomes for this stock before issuing the new one. The
note doctrine instructs the model that high-grade past wins are
patterns to repeat and low-grade past misses are patterns to avoid
verbatim.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from dotenv import load_dotenv
from supabase import create_client

from analyzer.llm_router import (
    FALLBACK_CHAIN, PRIMARY_MODEL, _post,
)
from analyzer.stock_deep import deep_fetch


load_dotenv()


_SYSTEM_PROMPT = """You are a deep equity analyst for the Indian market.
You analyse ONE stock at a time end-to-end and produce a strict-JSON deep
report at a specific time horizon (30 / 90 / 180 days).

ANTI-HINDSIGHT INSTRUCTION (non-negotiable):
You may use ONLY information available up to and including the requested_at
timestamp in the payload. Do NOT reference, infer, or condition on any
event, price, news, earnings result, or market move that occurred after
that timestamp. Every figure you cite must be sourced from a field in the
deep_payload, which is point-in-time as of that date. If a figure is
absent, say "no data" rather than guessing. Violation poisons the
learning loop because the grader replays the future against your call.

You receive every free data point yfinance exposes for the ticker:
- distilled company info + business summary
- full financials (income statement, balance sheet, cashflow) annual + quarterly
- analyst recommendations + price targets + upgrades/downgrades + estimates
- holders breakdown (institutional, insider, mutual fund)
- options chain summary (nearest expiry, PCR, IV, max pain) when available
- daily history since IPO + monthly closes 5y back + a derived technical
  battery (RSI14, MACD, SMA20/50/200 distances, ATR, 52w range pos,
  trailing returns, realised vol)
- calendar (next earnings + ex-dividend) and recent news

You are graded brutally: a deterministic grader compares your rating, phase,
and buy_window against the ticker's ACTUAL price movement at the horizon
you predicted. Score 0-100. The grade flows back into `prior_self_predictions`
on every future call for this ticker so your own track record is the
ground truth you reason against.

LEARNING LOOP DOCTRINE (strict, non-negotiable):
- Read `prior_self_predictions` BEFORE forming today's view. The block
  carries your last 8 graded predictions for this exact ticker at this
  exact horizon, with their grade_score (0-100) and grade_notes.
- A prior LOSS (score < 30) at a similar setup is a hard ceiling on
  today's confidence — your past self made that exact mistake.
- A prior WIN (score > 70) at a similar setup is a pattern you may
  repeat. Cite the date(s) you are leaning on in `reasoning.prior_calls`.
- Phase calls must be progressive. Do not flip-flop bullish->bearish->
  bullish across consecutive calls without a hard fundamental or
  technical catalyst in the data.

CONFIDENCE ANCHOR (calibrated, not "play it safe"):
Default-anchoring to 50-55 because the call feels uncertain is a failure
mode, not calibration. The grader does not reward hedged confidence; it
rewards conviction that matches outcome. Map evidence -> confidence band
BEFORE writing the number:

  80-92: All three pillars (technicals, fundamentals, flow / sentiment)
         agree with the rating. No active red flag. Prior wins at this
         setup. Reserve 90+ for the rare case where the setup is textbook
         AND your own track record (prior_self_predictions) is >=70.
  65-78: Two of three pillars agree; the third is neutral, not opposed.
         No prior loss at this exact setup.
  50-62: Mixed signal. One pillar agrees, two neutral / one opposed.
         Genuinely a coin-flip with light tilt.
  30-48: Weak / opposed evidence base. Rating is taken anyway because of
         a single decisive driver (catalyst, sector flow). Material
         downside risk acknowledged.
  10-28: Speculative. Issuing the call because of asymmetric R:R, not
         conviction. Most prior calls of this shape lost.

Discipline check: distribution of confidence across your last 10 buy
calls should have visible spread (stdev >= 10). If every call clusters
within +/-5 of the same number, you are anchor-bound, not calibrated.
Push the strong cases UP and the weak cases DOWN.

Consistency rule: rating=buy with confidence < 50 is a self-
contradiction (you do not believe your own call). Either raise
confidence or downgrade rating to hold.

SELF-CRITIQUE STEP (mandatory):
Before finalising confidence, list the strongest reasons your call could
be wrong in `reasons_could_be_wrong[]`. Be concrete (cite the data field
that contradicts you). If the list contains 2+ material reasons, drop
`confidence` by 10-20 points. This is metacognition, not modesty: each
listed risk is a real failure mode you have considered and chosen to
accept. Apply the dampening AFTER picking the anchor band, not as the
reason for picking the band.

EXPECTED EDGE (mandatory, used downstream by the paper trader):
Quote `expected_edge_pct` as a signed number in percent. It is
   expected_return_pct * win_prob - expected_loss_pct * loss_prob
where expected_return_pct is the upside if the call is right (% from
entry to target), expected_loss_pct is the downside if wrong (% from
entry to stop), and win_prob = confidence / 100. The paper-trade entry
gate filters out anything below +1.5% because round-trip friction
(spread + STT + brokerage + GST) eats roughly that much in this market.
Sub-1.5% edges are net-negative even if the direction is right.

OUTPUT (strict JSON, no prose outside JSON, no markdown):
{
  "ticker": "...",
  "horizon_days": 30 | 90 | 180,
  "rating": "buy" | "hold" | "sell",
  "score": 0-100 integer (your conviction in the rating, NOT a price target),
  "phase": "bearish" | "moderate_bearish" | "moderate_bullish" | "bullish",
  "summary": "1-2 sentence plain-English read for an Indian retail investor",
  "buy_window": {
    "target_price_low": float,   // best price to add at
    "target_price_high": float,  // upper bound of the entry zone
    "time_window_text": "e.g. 'next 2-3 weeks on a retest of 1280-1300'"
  },
  "exit_window": {
    "target_price": float | null,  // upside target for buy/hold; null for sell
    "stop_loss": float | null      // protective stop; null for sell
  },
  "reasoning": {
    "technicals": "what RSI/MACD/DMA distances/52w pos say (cite real numbers)",
    "valuation": "PE/PB/EV-EBITDA/PEG vs sector + history (cite numbers)",
    "fundamentals": "growth/margins/leverage/cashflow trajectory (cite numbers)",
    "news_flow": "what recent news + analyst flow signals",
    "catalysts": "upcoming earnings/dividend/sector events",
    "risks": ["concrete risk 1", "concrete risk 2", "..."],
    "prior_calls": "cite at least one prior_self_predictions entry by date"
  },
  "reasons_could_be_wrong": [
    "concrete reason 1 with the data field that contradicts the call",
    "concrete reason 2 ..."
  ],
  "expected_return_pct": float (positive, upside % from entry to target if right),
  "expected_loss_pct": float (positive, downside % from entry to stop if wrong),
  "win_prob": float in [0,1] (probability the call is right; should mirror confidence/100),
  "loss_prob": float in [0,1] (probability the call is wrong; win_prob + loss_prob = 1.0),
  "expected_edge_pct": float (signed, MUST equal expected_return_pct * win_prob
                              - expected_loss_pct * loss_prob within 0.5%),
  "confidence": 0-100 integer (calibrated to your past grade_score history,
                              dropped 10-20 pts if reasons_could_be_wrong
                              has 2+ material entries)
}

No certainty language. No "guaranteed", "definitely", "will". Probabilistic only.
No markdown. Strict JSON only.
"""


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _prior_predictions(sb, ticker: str, horizon_days: int, limit: int = 8) -> list[dict]:
    """Pull this ticker's last `limit` GRADED predictions at this exact
    horizon. Returns compact one-line dicts for the prompt: date, rating,
    score, phase, grade_score, grade_notes. Strict learning loop spine:
    the model literally sees its own past calls for this stock before
    issuing the new one.
    """
    try:
        rows = sb.table("stock_analyses").select(
            "id,requested_at,ticker,horizon_days,llm_json,grade_score,grade_notes"
        ).eq("ticker", ticker).eq("horizon_days", horizon_days).eq(
            "status", "ok"
        ).not_.is_("graded_at", "null").order(
            "requested_at", desc=True
        ).limit(limit).execute().data or []
    except Exception as e:
        print(f"  prior_predictions skipped: {str(e)[:120]}")
        return []
    out = []
    for r in rows:
        lj = r.get("llm_json") or {}
        out.append({
            "date": (r.get("requested_at") or "")[:10],
            "rating_called": lj.get("rating"),
            "phase_called": lj.get("phase"),
            "confidence_at_call": lj.get("confidence"),
            "grade_score": r.get("grade_score"),
            "grade_notes": (r.get("grade_notes") or "")[:200],
        })
    return out


def _strip_for_prompt(payload: dict, max_chars: int = 90000) -> dict:
    """Drop the heaviest sub-blocks if the deep payload risks bloating
    past the LLM context. Mirrors aggregator._PAYLOAD_DROP_ORDER logic
    but for the single-stock payload. Order: drop holders detail
    first (lowest leverage), then full historical monthly_close, then
    raw news bodies, then financial details, until the JSON fits.
    """
    drop_order = [
        "mutualfund_holders",
        "insider_roster_holders",
        "sustainability",
        "insider_transactions",
        "institutional_holders",
        "major_holders",
        "history_summary.monthly_close",
        "balance_sheet_quarterly",
        "cashflow_quarterly",
        "income_stmt_quarterly",
        "history_summary.tail_60d",
        "balance_sheet_annual",
        "cashflow_annual",
        "income_stmt_annual",
    ]
    p = dict(payload)
    js = json.dumps(p, default=str)
    if len(js) <= max_chars:
        return p
    for path in drop_order:
        if "." in path:
            top, sub = path.split(".", 1)
            if top in p and isinstance(p[top], dict) and sub in p[top]:
                p[top].pop(sub, None)
        else:
            p.pop(path, None)
        js = json.dumps(p, default=str)
        if len(js) <= max_chars:
            break
    return p


def _parse_llm_json(resp: dict) -> dict | None:
    """Extract the assistant's strict-JSON content from a chat.completions
    response. Mirrors analyzer.llm_router's parse loop: the routed
    provider sometimes wraps the JSON in markdown fences."""
    try:
        choices = resp.get("choices") or []
        if not choices:
            return None
        msg = (choices[0].get("message") or {}).get("content") or ""
        msg = msg.strip()
        if msg.startswith("```"):
            msg = msg.lstrip("`")
            if msg.lower().startswith("json"):
                msg = msg[4:].lstrip()
            if msg.endswith("```"):
                msg = msg[: -3]
        return json.loads(msg)
    except Exception as e:
        print(f"  parse_llm_json fail: {str(e)[:160]}")
        return None


def _validate(out: dict, ticker: str, horizon_days: int) -> tuple[bool, str]:
    """Strict shape check. Returns (ok, error_msg). Anything missing
    is a hard fail so we never persist a half-shaped row.

    Three new required fields this commit, all consumed by the Phase A
    paper trader: reasons_could_be_wrong (metacognition list, drives
    confidence dampening), expected_edge_pct (signed % edge that the
    entry gate filters on with a +1.5% floor matching round-trip
    friction), and the existing confidence read against a wider 0-100
    range. Soft-fall behaviour for older callers: confidence
    auto-dampens by 12 pts per material item in reasons_could_be_wrong
    beyond the first, capped at -25 total, so a model that lists the
    list but forgets to dampen its own confidence still ends up with a
    calibrated number downstream. expected_edge_pct must be present and
    finite; a missing value is a half-shaped row, not a recoverable
    default."""
    required = ["ticker", "horizon_days", "rating", "score", "phase",
                "summary", "buy_window", "reasoning", "confidence",
                "expected_edge_pct", "reasons_could_be_wrong",
                "expected_return_pct", "expected_loss_pct",
                "win_prob", "loss_prob"]
    for k in required:
        if k not in out:
            return False, f"missing key: {k}"
    if out["rating"] not in ("buy", "hold", "sell"):
        return False, f"invalid rating: {out['rating']}"
    if out["phase"] not in ("bearish", "moderate_bearish",
                            "moderate_bullish", "bullish"):
        return False, f"invalid phase: {out['phase']}"
    if not isinstance(out["score"], (int, float)) or not (0 <= out["score"] <= 100):
        return False, f"invalid score: {out.get('score')}"
    if not isinstance(out["confidence"], (int, float)) or not (0 <= out["confidence"] <= 100):
        return False, f"invalid confidence: {out.get('confidence')}"
    bw = out.get("buy_window") or {}
    for k in ("target_price_low", "target_price_high", "time_window_text"):
        if k not in bw:
            return False, f"buy_window missing: {k}"
    edge = out.get("expected_edge_pct")
    if not isinstance(edge, (int, float)):
        return False, f"invalid expected_edge_pct: {edge}"
    if edge != edge or edge in (float("inf"), float("-inf")):
        return False, f"non-finite expected_edge_pct: {edge}"
    if not (-100 <= edge <= 100):
        return False, f"expected_edge_pct out of range: {edge}"
    rcbw = out.get("reasons_could_be_wrong")
    if not isinstance(rcbw, list):
        return False, f"reasons_could_be_wrong must be a list, got {type(rcbw).__name__}"
    # Edge decomposition: the four components that derive expected_edge_pct
    # must be present + numerically consistent. Without these the edge
    # value is unauditable. Tolerance is 0.5% to absorb model rounding;
    # tighter tolerances catch fewer real errors and reject more honest
    # rounding. Probabilities must sum to ~1.0 (allow 0.05 slop for
    # model floating-point output).
    for k in ("expected_return_pct", "expected_loss_pct", "win_prob", "loss_prob"):
        v = out.get(k)
        if not isinstance(v, (int, float)):
            return False, f"missing/invalid {k}: {v}"
        if v != v or v in (float("inf"), float("-inf")):
            return False, f"non-finite {k}: {v}"
    R = float(out["expected_return_pct"])
    L = float(out["expected_loss_pct"])
    Pw = float(out["win_prob"])
    Pl = float(out["loss_prob"])
    if not (0.0 <= Pw <= 1.0) or not (0.0 <= Pl <= 1.0):
        return False, f"probabilities out of [0,1]: win={Pw}, loss={Pl}"
    if abs((Pw + Pl) - 1.0) > 0.05:
        return False, f"win_prob + loss_prob must equal 1.0 (got {Pw + Pl:.3f})"
    if R < 0 or L < 0:
        return False, f"expected_return_pct + expected_loss_pct must be positive magnitudes (got R={R}, L={L})"
    derived_edge = R * Pw - L * Pl
    if abs(derived_edge - edge) > 0.5:
        return False, (
            f"expected_edge_pct inconsistent: stated={edge:.3f}, "
            f"R*Pw - L*Pl = {derived_edge:.3f}"
        )
    # Auto-dampen confidence if the model produced the self-critique
    # list but did not lower its own confidence to match. 12 pts per
    # material item beyond the first, capped at -25. Modifies `out` in
    # place so the persisted row carries the calibrated number.
    n_material = sum(1 for r in rcbw if isinstance(r, str) and len(r.strip()) >= 20)
    if n_material >= 2:
        dampen = min(25, 12 * (n_material - 1))
        out["confidence_raw"] = out["confidence"]
        out["confidence"] = max(0, out["confidence"] - dampen)
        out["confidence_dampen_applied"] = dampen
    # Consistency: rating=buy with confidence < 50 is a self-contradiction
    # (model does not believe its own call). Auto-flip rating to "hold"
    # rather than reject the row, so we keep the analysis as a signal of
    # "the model leaned bullish but lacks conviction" instead of losing
    # the row entirely. Preserves the original rating in meta for audit.
    if out.get("rating") == "buy" and out["confidence"] < 50:
        out["rating_raw"] = "buy"
        out["rating"] = "hold"
        out["rating_downgrade_reason"] = (
            f"buy + confidence={out['confidence']} below 50 -> downgraded to hold"
        )
    return True, ""


def run(run_id: int) -> dict:
    """Execute one Stock Analyst pass for a stock_analyses row. The
    bot trigger pre-inserts the row with status='pending'; this
    function reads the ticker + horizon off it, builds the deep
    payload + prior predictions, calls the LLM, validates the
    response, and writes back the result + final status.

    Soft-fail policy: any exception updates the row to status='failed'
    with the error text. The bot endpoint returns run_id immediately
    and the browser polls; a failed row surfaces in the UI as a
    "retry" affordance, not a silent disappearance.
    """
    sb = _sb()
    row = sb.table("stock_analyses").select("*").eq("id", run_id).execute().data
    if not row:
        raise RuntimeError(f"stock_analyses id={run_id} not found")
    r = row[0]
    ticker = r["ticker"]
    horizon = int(r["horizon_days"])
    print(f"stock_analyst run_id={run_id} ticker={ticker} horizon={horizon}d")

    try:
        # 1. Deep fetch.
        t0 = time.time()
        payload = deep_fetch(ticker)
        print(f"  deep_fetch in {time.time() - t0:.1f}s, payload ~{len(json.dumps(payload, default=str))} chars")

        # 2. Prior self-predictions (learning loop spine).
        prior = _prior_predictions(sb, ticker, horizon)
        print(f"  prior graded predictions for ({ticker}, {horizon}d): {len(prior)}")

        # 3. Compress if needed, then assemble user message.
        payload = _strip_for_prompt(payload, max_chars=85000)
        # requested_at is the anti-hindsight cutoff the system prompt
        # references. Use the row's request timestamp (set at /trigger
        # time by the bot) as the hard horizon; nothing after this
        # instant may be used in reasoning. Without surfacing it
        # explicitly the model defaults to "today" and silently
        # leaks recency.
        requested_at = r.get("requested_at") or datetime.now(timezone.utc).isoformat()
        user_payload = {
            "instruction": (
                f"Produce a strict-JSON deep analysis for {ticker} at a "
                f"{horizon}-day horizon. Information cutoff: {requested_at}. "
                "Do not use any data dated after that. Follow the LEARNING "
                "LOOP DOCTRINE and cite at least one prior_self_predictions "
                "entry in reasoning.prior_calls. Populate "
                "reasons_could_be_wrong with concrete failure modes, emit "
                "expected_return_pct + expected_loss_pct + win_prob + "
                "loss_prob, and ensure expected_edge_pct equals "
                "expected_return_pct * win_prob - expected_loss_pct * "
                "loss_prob within 0.5%."
            ),
            "ticker": ticker,
            "horizon_days": horizon,
            "requested_at": requested_at,
            "deep_payload": payload,
            "prior_self_predictions": prior,
        }
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, default=str)},
        ]

        # 4. LLM call via the same OpenRouter chain the morning
        # analyzer uses. reasoning=True so Nemotron Super does its
        # thinking pass; deep analysis warrants it.
        model_chain = [PRIMARY_MODEL] + FALLBACK_CHAIN
        t1 = time.time()
        resp = _post(messages, model_chain, reasoning=True, timeout=300)
        model_used = resp.get("model") or PRIMARY_MODEL
        print(f"  LLM in {time.time() - t1:.1f}s via {model_used}")

        out = _parse_llm_json(resp)
        if out is None:
            raise RuntimeError("LLM response did not contain valid JSON")
        # Sometimes models echo wrong ticker / horizon. Stamp ours.
        out["ticker"] = ticker
        out["horizon_days"] = horizon

        ok, err = _validate(out, ticker, horizon)
        if not ok:
            raise RuntimeError(f"output validation failed: {err}")

        # 5. Persist success.
        sb.table("stock_analyses").update({
            "deep_payload": payload,
            "llm_json": out,
            "model_used": model_used,
            "status": "ok",
        }).eq("id", run_id).execute()
        print(f"  stock_analyst id={run_id} OK rating={out.get('rating')} phase={out.get('phase')}")
        return out
    except Exception as e:
        err_text = f"{type(e).__name__}: {str(e)[:400]}"
        print(f"  stock_analyst id={run_id} FAIL: {err_text}")
        try:
            sb.table("stock_analyses").update({
                "status": "failed",
                "error": err_text,
            }).eq("id", run_id).execute()
        except Exception:
            pass
        raise


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m analyzer.stock_analyst_llm <stock_analyses_id>")
        sys.exit(1)
    run(int(sys.argv[1]))

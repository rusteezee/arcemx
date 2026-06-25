"""End-of-day synthesis ("Sensei").

After the 17:00 IST grader pass scores any same-day-graded dimensions
(direction_1d, range_1d, sector_*, holding_*, wishlist_*, index_pair_1d,
cap_pair_1d, fii_flow_1d, insight_quality), this 20:00 IST cron asks
Ultra to retrospect on today's morning call vs the day's actual market
behaviour and produce a structured note. Tomorrow's morning analysis
reads the latest sensei_eod row (via aggregator.build_payload) as the
"sensei_yesterday" block so the next call starts with explicit
retrospection on yesterday's misses / wins.

Why Ultra not Super for this job: the morning bake-off showed Super
follows tight numeric prediction schemas better (44% narrower ranges);
Ultra (550B) is the stronger reasoner for narrative retrospective
synthesis. Different jobs, different model strengths. Free-tier
50-req/day cap easily absorbs the extra call.

The grader is the source of truth for scores. Sensei never invents a
score; it READS prediction_scores and tells a story about WHY the
miss / win happened, rooted in today's actuals. No bluff.
"""
import os
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

from analyzer.llm_router import _post, _parse_json, _chain
from analyzer.market_context import INDEX_SYMBOLS, SECTOR_SYMBOLS
from analyzer.grader import _session_bounds

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]


# Super primary for Sensei (120B/12B-active MoE). Was nemotron-3-ultra-
# 550b, but that model was dropped from the ensemble on 20/06 after it
# took 31 minutes of wall clock and returned a prose preamble instead of
# JSON; as Sensei's primary it failed identically every EOD and silently
# fell back to Super (observed model_used on all recent sensei_eod rows),
# so each run paid the Ultra timeout/retry tax for nothing. Point the
# primary straight at the proven Super checkpoint the runs already land
# on. Same fallback chain still applies for a rate-limit / outage.
SENSEI_PRIMARY = os.getenv(
    "OPENROUTER_SENSEI_PRIMARY",
    "nvidia/nemotron-3-super-120b-a12b:free",
)


SENSEI_SYSTEM_PROMPT = """You are the END-OF-DAY REVIEWER for an Indian equity analyst's
morning call. Your job is to honestly retrospect on today's predictions vs the day's actual
market behaviour and prepare a tight, data-anchored note that tomorrow's analyst will read
BEFORE making the next call.

You do NOT make new predictions. You explain what happened, what the morning call got right,
what it got wrong, and what setups the next session should watch. The deterministic grader
in prediction_scores is the source of truth for hit/miss judgments. You do not invent scores;
you read them and tell the story.

The payload you receive has these blocks:
- morning_call: the analyst's full morning JSON output (nifty_outlook, sensex_outlook,
  sector_outlooks, holding_outlooks_1d, wishlist_outlooks_1d, index_pair_outlook,
  cap_pair_outlook, fii_flow_outlook, short_term_picks, long_term_picks,
  portfolio_verdicts, wishlist_signals, conviction tiers, reasoning_breakdown, confidence).
- todays_actuals: actual closes today for NIFTY, Sensex, BankNifty, MIDCAP150, 10 NSE
  sectors, every holding ticker, every wishlist ticker; FII/DII final cash + derivatives;
  USDINR / DXY moves.
- grader_results: prediction_scores rows already scored for today's analysis_id
  (1d dimensions only; 5d/7d/20d/30d/60d/180d horizons are still in-flight and
  show as such). Each row has dimension, predicted, actual, score (0-100), delta,
  notes. TRUST these scores; do not relitigate them.
- recent_calibration: latest accuracy_summary per (window_days, dimension), 7d/30d/90d.

Return STRICT JSON only matching this schema:
{
  "what_worked": [
    {"call": "<one-line description of the call, e.g. 'NIFTY sideways with 23070-23346 range'>",
     "dimension": "<dimension key from prediction_scores, e.g. direction_1d>",
     "score_pct": 0-100,
     "evidence": "<one-line citation of >=2 numbers: actual vs predicted with the gap>"}
  ],
  "what_missed": [
    {"call": "<one-line description>",
     "dimension": "<dimension key>",
     "actual": "<what actually happened, numeric>",
     "gap": "<signed numeric gap, e.g. '+1.8% vs called sideways'>",
     "root_cause": "regime_shift | flow_surprise | news_catalyst | technical_break | overconfidence | data_thin | model_noise"}
  ],
  "conviction_review": {
    "tier_A": {"n_picks": <int>, "n_hits": <int>, "comment": "<one-line read on whether A-tier conviction matched performance>"},
    "tier_B": {"n_picks": <int>, "n_hits": <int>, "comment": "..."},
    "tier_C": {"n_picks": <int>, "n_hits": <int>, "comment": "..."}
  },
  "key_insights": [
    "<3-5 strings, each one ACTIONABLE READ of today's data, e.g. 'BankNifty led NIFTY by +0.6% despite FII outflow, DII absorption decisive at 23070 support'. Cite >=2 numbers per insight.>"
  ],
  "tomorrow_watch": [
    "<3-5 strings, each one a SPECIFIC LEVEL OR EVENT to track at next open, e.g. 'NIFTY 23070 support; break opens 22900 next leg' or 'US10Y 4.42% rising into Powell speech, watch FII reaction'. Cite >=2 numbers per item.>"
  ],
  "calibration_note": "<one-line read on stated confidence vs realized accuracy, e.g. 'Stated 55 confidence delivered 60% direction hit, calibration healthy' or 'Overconfidence on sector calls: stated 65 avg, delivered 48%'>",
  "insight_quality_avg": "<the insight_quality score for today's reasoning_breakdown if present in grader_results, else null>"
}

LANGUAGE DISCIPLINE (binding, identical to morning prompt):
- Every item MUST cite at least TWO concrete numbers from todays_actuals, morning_call,
  grader_results, or recent_calibration. One number = vague = rewrite.
- Banned vague phrases: "could see", "may", "potentially", "likely to", "expected to",
  "appears to", "looks like", "seems to", "tends to", "should", "might", "around",
  "approximately". Use concrete numbers instead.
- Banned filler: "given the setup", "in the near term", "going forward", "amid global cues",
  "in light of", "broadly", "generally", "overall". Cut them. State the specific signal.
- Numbers are your only currency. If you cannot cite one, do not include the item.
- PLAIN ENGLISH ONLY in every prose field (call, evidence, actual, gap, root_cause prose,
  key_insights, tomorrow_watch, calibration_note, tier comments). NEVER write internal
  dimension keys or underscore tokens like direction_1d, sector_dir_1d, range_1d,
  wishlist_dir_1d, grader_results, what_worked. Write the human name instead:
  "NIFTY 1-day direction", "sector direction calls", "the NIFTY range call",
  "wishlist direction calls". The "dimension" JSON field is the ONLY place a raw
  key may appear. A reader who has never seen the codebase must understand every
  sentence.
- Be brutally honest. Confidence at 55 delivering 60% direction is healthy calibration.
  Confidence at 80 delivering 55% is overconfidence. surface it. The next-day analyst
  reads this; lying to them breaks the entire feedback loop.
- RANGE DISCIPLINE (binding): when a range call CONTAINED the close (score >= 80),
  say so and state the band width vs the actual move (e.g. "band 1.2% wide, close
  moved 0.3%; band must tighten tomorrow"). A wide band that always hits is a
  useless prediction. When range accuracy is high, key_insights MUST include one
  item demanding a tighter band with the specific current width and target width.
  Never praise a hit on a loose band. Never settle.

If a dimension has no graded result yet (5d/7d/20d/30d/60d/180d horizons), do NOT
fabricate. Either skip the item or include it under what_missed with root_cause
"data_thin" and explain (e.g. "long_pick TVS thesis still in-flight, age 0/60").

If grader_results is empty or near-empty (e.g. only insight_quality scored because
horizons have not elapsed yet), return EMPTY ARRAYS for what_worked and what_missed.
Do NOT fill those arrays with "0 graded rows" descriptive filler. that pollutes
tomorrow's prompt with prose where it expects numeric anchors. The calibration_note
should explicitly state that today is data-thin and that the retrospective will be
richer once the next grader pass lands. An empty what_worked / what_missed array is
the HONEST output on a data-thin day, not a failure mode.

When what_missed entries are returned, the "actual" field MUST be a SHORT numeric or
tight phrase (e.g. "+1.2%" or "23446 (above 23346)"), not a multi-clause sentence.
The "gap" field MUST be a signed numeric (e.g. "+0.8%" or "+250 pts"). Long prose
goes in calibration_note or root_cause, never in actual / gap.

If conviction tiers had zero picks at a level today, set n_picks=0 and comment
"no A picks today" or similar. Do not fabricate hits.

PORTFOLIO VERDICT DISCIPLINE (carry this finding into every retrospective):
The grader has documented a structural HOLD bias in portfolio_verdicts: across
the recent 90-day window, ~89% of verdicts were "hold", ~10% were "add", and
"exit" was emitted ZERO times. The hold calls landed with mean realized 7d
return of +4.15%, meaning the holdings were rallying while the model said
"stay flat" — a verdict bias, not calibration. Average verdict_7d accuracy
under the rebuilt grader is 44.47, BELOW the coin-flip baseline.

When you write what_missed entries for verdict_7d, you MUST cite this hold
bias by name in the root_cause OR calibration_note when the relevant trace
shows a hold that should have been an add or trim. Do NOT excuse a missed
add with "market was bullish so hold was reasonable" — that defends the
documented failure mode. Push tomorrow's analysis to engage the per-holding
7d directional pillars (RSI / DMA / sector flow) and pick add / trim / exit
when the evidence warrants it, not default to hold.

If today's grader_results show verdict_7d below 55, include at least ONE
what_missed entry with root_cause="overconfidence" or "model_noise" and a
calibration_note that explicitly names the hold-bias finding.
"""


def _sb():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY missing")
    return create_client(url, key)


def _pct(curr: float | None, prev: float | None) -> float | None:
    if curr is None or prev is None or prev == 0:
        return None
    return round((curr - prev) / prev * 100, 3)


def _todays_actuals(run_at: datetime, raw: dict) -> dict:
    """Build the actuals block: target-session close vs prior-session close
    for every universe the morning call took a position on. Uses the
    grader's _session_bounds so Sensei reads exactly the numbers the
    grader scored against: the first session whose close follows run_at,
    baselined on the session before it. The old run_at+1day window asked
    for a bar that does not exist at 20:00 IST, so every today_close came
    back None and the retrospective was permanently data-thin.
    """
    actuals: dict = {"indices": {}, "sectors": {}, "holdings": {}, "wishlist": {}}

    def _bounds(sym: str) -> dict:
        b = _session_bounds(sym, run_at)
        if not b:
            return {"prior_close": None, "today_close": None, "chg_pct": None}
        p, c, d = b
        return {"prior_close": round(p, 2), "today_close": round(c, 2),
                "chg_pct": _pct(c, p), "session": d}

    # Indices (NIFTY, Sensex, BankNifty, Midcap150)
    for name, sym in INDEX_SYMBOLS.items():
        actuals["indices"][name] = _bounds(sym)

    # Sectors (10 NSE)
    for name, sym in SECTOR_SYMBOLS.items():
        actuals["sectors"][name] = _bounds(sym)

    # Per-stock holdings + wishlist (from morning call's emitted lists,
    # so we only fetch tickers the model actually predicted on)
    def _norm(t: str) -> str:
        t = (t or "").strip().upper()
        return t if t.endswith(".NS") else f"{t}.NS"

    for src_key, target_key in (("holding_outlooks_1d", "holdings"),
                                ("wishlist_outlooks_1d", "wishlist")):
        for o in (raw.get(src_key) or []):
            tk = (o.get("ticker") or "").strip().upper()
            if not tk:
                continue
            actuals[target_key][tk] = _bounds(_norm(tk))

    return actuals


def _prediction_scores(sb, analysis_id: int) -> list[dict]:
    res = sb.table("prediction_scores").select(
        "dimension,horizon_days,predicted,actual,score,delta,notes"
    ).eq("analysis_id", analysis_id).execute()
    return res.data or []


def _calibration(sb) -> list[dict]:
    """Latest accuracy_summary per (window_days, dimension). Mirrors how
    analyzer.feedback._latest_summaries dedups (newest insert wins)."""
    res = sb.table("accuracy_summary").select(
        "window_days,dimension,accuracy_pct,sample_size,bias,computed_at"
    ).order("computed_at", desc=True).limit(400).execute()
    seen: dict[tuple, dict] = {}
    for r in (res.data or []):
        k = (r["window_days"], r["dimension"])
        if k not in seen:
            seen[k] = {
                "window_days": r["window_days"],
                "dimension": r["dimension"],
                "accuracy_pct": r.get("accuracy_pct"),
                "sample_size": r.get("sample_size"),
                "bias": r.get("bias"),
            }
    return list(seen.values())


def _last_completed_close_utc() -> datetime:
    """Most recent 15:30 IST (10:00 UTC) session close that has already
    completed AND settled (15 min buffer, matching _session_bounds).

    Steps back one calendar day at a time until the close moment is in
    the past, so a run at 01:38 IST resolves to YESTERDAY's close, not
    today's future close. That midnight rollover is exactly how the
    11/06 ghost row happened: a post-midnight manual trigger treated
    "today" as the close date of a session that had not even opened.
    Weekends/holidays are fine: the cutoff is only used to pick which
    analysis to retrospect; _session_bounds resolves the actual traded
    session from real bars.
    """
    now = datetime.now(timezone.utc)
    candidate = datetime(now.year, now.month, now.day, 10, 0,
                         tzinfo=timezone.utc)
    while now < candidate + timedelta(minutes=15):
        candidate -= timedelta(days=1)
    return candidate


def _resolve_analysis(sb, analysis_id: int | None) -> dict:
    """Pick the analysis to retrospect on.

    NOT simply the latest row: an analysis run AFTER a session close
    targets the NEXT session, so retrospecting it before that session
    completes finds zero graded 1d dims and produces a data-thin note.
    The correct subject is the latest analysis whose run_at precedes
    the most recent COMPLETED close, at any hour of day. Fall back to
    the absolute latest only when no such row exists (first day).
    """
    if analysis_id is not None:
        r = sb.table("analysis").select("id,run_at,raw_json").eq(
            "id", analysis_id).single().execute()
        return r.data
    close_utc = _last_completed_close_utc()
    r = sb.table("analysis").select("id,run_at,raw_json").lt(
        "run_at", close_utc.isoformat()).order(
        "run_at", desc=True).limit(1).execute()
    if not r.data:
        r = sb.table("analysis").select("id,run_at,raw_json").order(
            "run_at", desc=True).limit(1).execute()
    if not r.data:
        raise RuntimeError("no analysis rows in DB")
    return r.data[0]


def build_payload(analysis_id: int | None = None) -> dict:
    sb = _sb()
    a = _resolve_analysis(sb, analysis_id)
    aid = a["id"]
    run_at = datetime.fromisoformat(a["run_at"].replace("Z", "+00:00"))
    raw = a.get("raw_json") or {}

    print(f"Sensei: retrospecting analysis_id={aid} run_at={a['run_at']}")
    print("Fetching today's actuals...")
    actuals = _todays_actuals(run_at, raw)
    print("Reading prediction_scores...")
    scores = _prediction_scores(sb, aid)
    print(f"  {len(scores)} dimensions scored")
    print("Reading recent calibration...")
    calib = _calibration(sb)

    return {
        "timestamp": datetime.utcnow().isoformat(),
        "morning_analysis_id": aid,
        "morning_run_at": a.get("run_at"),
        "morning_call": raw,
        "todays_actuals": actuals,
        "grader_results": scores,
        "recent_calibration": calib,
    }


def synthesize(payload: dict, model_name: str | None = None) -> dict:
    chain = _chain(model_name or SENSEI_PRIMARY)
    print(f"Sensei OpenRouter primary: {chain[0]} | fallbacks: {chain[1:]}")
    user_msg = ("Retrospect on this morning's call vs today's actuals and "
                "today's grader_results. Return JSON per schema.\n\n"
                + json.dumps(payload, default=str)[:120000])
    resp = _post(
        [{"role": "system", "content": SENSEI_SYSTEM_PROMPT},
         {"role": "user", "content": user_msg}],
        models=chain,
    )
    return _parse_json(resp)


def save(result: dict, analysis_id: int, close_date: str) -> None:
    sb = _sb()
    sb.table("sensei_eod").upsert({
        # run_at explicitly set: the column default only applies on
        # INSERT, so an upsert that overwrites an earlier same-day row
        # (manual click before the cron) would otherwise keep the stale
        # first-write time. The startup catch-up in the bot uses run_at
        # to decide whether the row predates grading and needs a redo.
        "run_at": datetime.now(timezone.utc).isoformat(),
        "analysis_id": analysis_id,
        "market_close_date": close_date,
        "model_used": result.get("_model_used"),
        "raw_json": result,
        "what_worked": result.get("what_worked"),
        "what_missed": result.get("what_missed"),
        "conviction_review": result.get("conviction_review"),
        "key_insights": result.get("key_insights"),
        "tomorrow_watch": result.get("tomorrow_watch"),
        "calibration_note": result.get("calibration_note"),
        "insight_quality_avg": result.get("insight_quality_avg"),
    }, on_conflict="market_close_date").execute()
    print(f"Sensei saved for {close_date} (analysis_id={analysis_id})")


def run(analysis_id: int | None = None) -> dict:
    # Self-sufficient: grade BEFORE synthesizing so grader_results are
    # guaranteed present regardless of whether the separate grader cron
    # fired (or fired late). On 10/06 the GH grader landed at 20:06 IST,
    # one minute AFTER the 20:05 Sensei, and the retrospective went out
    # data-thin; this ordering dependency is now gone. grade_all is
    # idempotent (upsert per analysis+dimension+horizon) so double
    # grading with the cron is harmless. Short lookback keeps the pass
    # fast; the daily cron still grades the full 90d window.
    try:
        from analyzer.grader import grade_all, compute_summaries
        print("Sensei: running grader pass first (lookback 10d)...")
        grade_all(lookback_days=10)
        compute_summaries()
    except Exception as e:
        print(f"Sensei: pre-grade pass failed, continuing with existing scores: {e}")

    payload = build_payload(analysis_id)
    aid = payload["morning_analysis_id"]

    # The close date the retrospective covers is the analysis's TARGET
    # session (first session whose close follows its run_at), never the
    # wall-clock date at save time. _session_bounds also refuses while
    # the target session is still in flight or unsettled, which makes
    # any-hour manual triggers safe: a 01:38 IST click can no longer
    # mint a row for a session that has not traded.
    a_run_at = datetime.fromisoformat(
        str(payload["morning_run_at"]).replace("Z", "+00:00"))
    bounds = _session_bounds("^NSEI", a_run_at)
    if not bounds:
        msg = (f"analysis {aid} targets a session that has not closed or "
               f"settled yet; refusing to write a data-thin retrospective")
        print(f"Sensei: {msg}")
        return {"error": msg, "analysis_id": aid}
    close_date = bounds[2] if isinstance(bounds[2], str) else str(bounds[2])

    result = synthesize(payload)
    if "error" in result:
        print(f"Sensei synthesis error: {result.get('error')}")
        return result
    save(result, aid, close_date)
    return result


if __name__ == "__main__":
    aid_arg = int(sys.argv[1]) if len(sys.argv) > 1 else None
    out = run(aid_arg)
    print(json.dumps(out, indent=2, default=str)[:3000])

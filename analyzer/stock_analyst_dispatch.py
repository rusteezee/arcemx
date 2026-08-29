"""Blueprint 21 Phase 5: systematically seed real stock_analyst coverage.

stock_analyst is the paper trader's FIRST signal source
(paper_trader._evaluate_one, already fully wired end to end in both
paper_trader.py and backtest.py) but produced ZERO backtest trades
because stock_analyses rows only ever got created from a manual
dashboard click - 13 rows total, ever, last one 2026-07-12. This is a
data-generation fix, not a new trading feature: candidates get the
exact same insert+dispatch contract web/app/api/stock-analyst/route.ts
already uses, so stock_analyst.yml and the paper trader's consumption
of it need zero changes.

Candidate source is a FRESH, independent technical screen
(analyzer.technical.screen_universe + rank_candidates), NOT the LLM's
own top_performers list - top_performer_1d has proven persistently
negative alpha (blueprint 21 Finding 1, t=-2.56 across 792 picks), so
seeding stock_analyst from it would just reintroduce the same bad
candidate selection one level removed. A plain technical bullish-
momentum screen is a structurally independent, unbiased source of
"what's worth a deep look today" - different design, not just a
different horizon.
"""
import os
from datetime import date

import requests
from dotenv import load_dotenv
from supabase import create_client

from fetchers.prices import load_universe
from analyzer.technical import screen_universe, rank_candidates

load_dotenv()

# 30d matches the long-horizon regime blueprint 21 Finding 3 measured real
# skill in (60-session long_pick_tp_sl t=+5.71 vs 10-session t=-1.96 to
# -2.60) - stock_analyst's own horizon options are 30/90/180, and 30 is
# the closest fit without waiting even longer for the first read.
HORIZON_DAYS = 30
# Trivial against OpenRouter's free-tier limits (20/min, 50-1000/day);
# kept small deliberately while this is unvalidated - grow only once
# real graded data justifies it, not before.
DAILY_CANDIDATES = 6


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _dispatch_workflow(run_id: int) -> None:
    token = os.getenv("GH_TOKEN")
    repo = os.getenv("GH_REPO")
    if not token or not repo:
        raise RuntimeError("GH_TOKEN or GH_REPO not set")
    r = requests.post(
        f"https://api.github.com/repos/{repo}/actions/workflows/stock_analyst.yml/dispatches",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        json={"ref": "master", "inputs": {"run_id": str(run_id)}},
        timeout=30,
    )
    r.raise_for_status()


def pick_candidates(n: int) -> list[str]:
    universe = load_universe()
    print(f"Universe: {len(universe)}")
    print("Screening technicals...")
    signals = screen_universe(universe)
    # Headroom over n: some candidates get skipped below (already
    # requested today), so overfetch the ranked list rather than the
    # exact count needed.
    ranked = rank_candidates(signals, n=n * 4)
    return [row["ticker"] for row in ranked["bullish"]]


def run(n: int = DAILY_CANDIDATES) -> dict:
    sb = _sb()
    today = date.today().isoformat()
    candidates = pick_candidates(n)

    dispatched: list[dict] = []
    skipped: list[dict] = []
    for ticker in candidates:
        if len(dispatched) >= n:
            break
        existing = sb.table("stock_analyses").select("id,status").eq(
            "ticker", ticker
        ).eq("horizon_days", HORIZON_DAYS).gte(
            "requested_at", f"{today}T00:00:00Z"
        ).execute().data
        if existing:
            skipped.append({"ticker": ticker, "reason": "already requested today"})
            continue
        ins = sb.table("stock_analyses").insert({
            "ticker": ticker, "horizon_days": HORIZON_DAYS, "status": "pending",
        }).execute()
        if not ins.data:
            skipped.append({"ticker": ticker, "reason": "insert failed"})
            continue
        run_id = ins.data[0]["id"]
        try:
            _dispatch_workflow(run_id)
            dispatched.append({"ticker": ticker, "run_id": run_id})
        except Exception as e:
            sb.table("stock_analyses").update({
                "status": "failed",
                "error": f"dispatch failed: {str(e)[:200]}",
            }).eq("id", run_id).execute()
            skipped.append({"ticker": ticker, "reason": f"dispatch failed: {e}"})

    print(f"stock_analyst_dispatch: dispatched={len(dispatched)} skipped={len(skipped)}")
    for d in dispatched:
        print(f"  dispatched {d['ticker']} (run_id={d['run_id']})")
    for s in skipped:
        print(f"  skipped {s['ticker']}: {s['reason']}")
    return {"dispatched": dispatched, "skipped": skipped}


if __name__ == "__main__":
    run()

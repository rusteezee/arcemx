"""Blueprint 13: builds the chat-format JSONL dataset for the LoRA
fine-tune, from prediction_scores + prediction_embeddings.feature_text
+ accuracy_summary. GATED: refuses below 3,000 total prediction_scores
rows (the same accumulation gate blueprint 13 itself waited on).

Repo is public (confirmed live via `gh repo view --json isPrivate`), so
this writes JSONL to a local, gitignored directory only - the blueprint's
own CONSTRAINT for a public repo is a Kaggle private dataset upload, not
a git commit. Upload data/finetune/*.jsonl to Kaggle yourself before
running the training notebook.

ASSUMPTIONS (tagged per the blueprint's own anti-stall rule - no single
"correct" answer exists in the stored data for these, smallest safe
choice taken):
  - range_1d "correct call": a synthetic +/-0.5% band around the actual
    close, not the model's own predicted band. Teaches "what a tight,
    correct band would have looked like", not one specific right answer
    (infinitely many bands technically contain the close).
  - top_performer_1d "correct call": the subset of the ORIGINALLY PICKED
    tickers whose realized alpha vs Nifty was positive. We only have
    outcome data for tickers the model actually picked, not the full
    universe it chose from, so "what should have been picked instead"
    is not recoverable from stored data.
  - direction_1d / market_mood_1d labels are NOT assumptions - derived
    via the exact same 0.4%-flat-band threshold analyzer.grader.py's
    own grade_direction() uses, so the training labels agree with how
    the live system itself defines "correct".
"""
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "finetune"

GATE_MIN_TOTAL = 3000
TARGET_DIMS = ["direction_1d", "range_1d", "market_mood_1d", "top_performer_1d"]
EVAL_FRACTION = 0.20
FLAT = 0.4  # matches analyzer.grader.grade_direction's noise band exactly

SYSTEM_PROMPT_BASE = "You are a calibrated Indian-market signal grader."

# Same market-state text repeats across dimensions for one analysis row
# (direction_1d, range_1d, market_mood_1d, top_performer_1d all share the
# identical feature_text). Without a per-dimension task instruction, the
# training set contains contradictory (same input, different target)
# pairs - confirmed live: 87 of 89 unique prompts in the Jul-2026 export
# had 2+ different target answers, causing train loss -> ~0 while eval
# loss stayed ~4.6 (memorization, not generalization; not a hyperparameter
# problem, an ambiguous-prompt problem).
DIM_INSTRUCTIONS = {
    "direction_1d": (
        "Predict NIFTY's next-session direction. Output JSON: "
        '{"call": "up"|"down"|"sideways", "confidence": 0-100}'
    ),
    "range_1d": (
        "Predict NIFTY's next-session closing price range. Output JSON: "
        '{"call": [low, high], "confidence": 0-100}'
    ),
    "market_mood_1d": (
        "Predict the next-session overall market mood. Output JSON: "
        '{"call": "bull"|"bear"|"neutral", "confidence": 0-100}'
    ),
    "top_performer_1d": (
        "Of the originally picked tickers, predict which will show "
        'positive alpha next session. Output JSON: {"call": [tickers...], '
        '"confidence": 0-100}'
    ),
}


def _system_prompt(dim: str) -> str:
    return f"{SYSTEM_PROMPT_BASE} {DIM_INSTRUCTIONS[dim]}"


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _page(sb, table: str, select: str, **filters):
    rows = []
    off = 0
    while True:
        q = sb.table(table).select(select)
        for k, v in filters.items():
            q = q.eq(k, v)
        page = q.range(off, off + 999).execute().data or []
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def _direction_label(pct: float) -> str:
    if pct > FLAT:
        return "up"
    if pct < -FLAT:
        return "down"
    return "sideways"


def _mood_label(pct: float) -> str:
    if pct > FLAT:
        return "bull"
    if pct < -FLAT:
        return "bear"
    return "neutral"


def _assistant_call(dimension: str, actual: dict, confidence: float) -> dict | None:
    """Returns the assistant JSON target, or None if this row can't be
    scored (missing/malformed actual for its dimension)."""
    if dimension in ("direction_1d", "market_mood_1d"):
        pct = actual.get("pct")
        if not isinstance(pct, (int, float)):
            return None
        label = _direction_label(pct) if dimension == "direction_1d" else _mood_label(pct)
        return {"call": label, "confidence": confidence}

    if dimension == "range_1d":
        close = actual.get("close")
        if not isinstance(close, (int, float)) or close <= 0:
            return None
        lo = round(close * 0.995, 2)
        hi = round(close * 1.005, 2)
        return {"call": [lo, hi], "confidence": confidence}

    if dimension == "top_performer_1d":
        results = actual.get("results")
        if not isinstance(results, list) or not results:
            return None
        picks = [
            r.get("ticker") for r in results
            if isinstance(r, dict) and isinstance(r.get("alpha"), (int, float)) and r["alpha"] > 0
        ]
        return {"call": picks, "confidence": confidence}

    return None


def build_dataset() -> tuple[list[dict], dict]:
    sb = _sb()

    total = sb.table("prediction_scores").select("id", count="exact").execute().count
    if total < GATE_MIN_TOTAL:
        raise SystemExit(
            f"Refusing: only {total} total prediction_scores rows, need >= {GATE_MIN_TOTAL}."
        )

    # trailing accuracy per dim, prefer the 90d window per the blueprint's
    # dataset design; fall back to the widest available window if 90d
    # hasn't been computed for a dim yet.
    conf_by_dim: dict[str, float] = {}
    for dim in TARGET_DIMS:
        rows = sb.table("accuracy_summary").select("*").eq("dimension", dim).order(
            "computed_at", desc=True
        ).limit(50).execute().data or []
        by_window = {r["window_days"]: r for r in rows}
        r = by_window.get(90) or (rows[0] if rows else None)
        conf_by_dim[dim] = round(r["accuracy_pct"], 1) if r and r.get("accuracy_pct") is not None else 50.0

    examples = []
    skipped = Counter()
    for dim in TARGET_DIMS:
        ps_rows = _page(sb, "prediction_scores", "analysis_id,dimension,actual", dimension=dim)
        if not ps_rows:
            continue
        analysis_ids = list({r["analysis_id"] for r in ps_rows if r.get("analysis_id") is not None})
        # analysis_id -> run_at, chunked to keep in_() small
        run_at_by_id: dict[int, str] = {}
        for i in range(0, len(analysis_ids), 500):
            chunk = analysis_ids[i:i + 500]
            ar = sb.table("analysis").select("id,run_at").in_("id", chunk).execute().data or []
            run_at_by_id.update({a["id"]: a["run_at"] for a in ar})

        for r in ps_rows:
            aid = r.get("analysis_id")
            if aid is None or aid not in run_at_by_id:
                skipped["no_run_at"] += 1
                continue
            emb = sb.table("prediction_embeddings").select("feature_text").eq(
                "analysis_id", aid
            ).eq("dimension", dim).limit(1).execute().data
            if not emb or not emb[0].get("feature_text"):
                skipped["no_embedding"] += 1
                continue
            actual = r.get("actual") or {}
            assistant = _assistant_call(dim, actual, conf_by_dim[dim])
            if assistant is None:
                skipped["unscoreable_actual"] += 1
                continue
            examples.append({
                "dimension": dim,
                "run_at": run_at_by_id[aid],
                "messages": [
                    {"role": "system", "content": _system_prompt(dim)},
                    {"role": "user", "content": emb[0]["feature_text"]},
                    {"role": "assistant", "content": json.dumps(assistant)},
                ],
            })

    examples.sort(key=lambda e: e["run_at"])
    return examples, dict(skipped)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    args = ap.parse_args()

    examples, skipped = build_dataset()
    if not examples:
        raise SystemExit("Refusing: 0 scoreable examples assembled.")

    n_eval = max(1, int(len(examples) * EVAL_FRACTION))
    train = examples[:-n_eval]
    eval_ = examples[-n_eval:]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    train_path = out_dir / "train.jsonl"
    eval_path = out_dir / "eval.jsonl"

    with open(train_path, "w", encoding="utf-8") as f:
        for e in train:
            f.write(json.dumps({"messages": e["messages"]}) + "\n")
    with open(eval_path, "w", encoding="utf-8") as f:
        for e in eval_:
            f.write(json.dumps({"messages": e["messages"]}) + "\n")

    by_dim = Counter(e["dimension"] for e in examples)
    print(f"Total examples: {len(examples)} (train={len(train)}, eval={len(eval_)})")
    print(f"By dimension: {dict(by_dim)}")
    print(f"Skipped: {skipped}")
    print(f"Train date range: {train[0]['run_at']} -> {train[-1]['run_at']}")
    print(f"Eval date range:  {eval_[0]['run_at']} -> {eval_[-1]['run_at']}")
    print(f"Temporal split OK: {train[-1]['run_at'] <= eval_[0]['run_at']}")
    print(f"\nWrote {train_path} and {eval_path}")
    print("\n--- 3-example preview (train) ---")
    for e in train[:3]:
        print(json.dumps({"messages": e["messages"]}, indent=2))


if __name__ == "__main__":
    main()

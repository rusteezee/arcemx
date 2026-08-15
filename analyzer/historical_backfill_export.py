"""Historical backfill export for direction_1d / range_1d / market_mood_1d.

Problem this closes: the live daily pipeline has only been running
since ~June 2026 (~64 trading days), producing at most ~1 example per
target dimension per day - the LoRA export (finetune_export.py) tops
out around 500-600 total examples across all 4 dims, live-confirmed
2026-08-15 to be too small for a 3B-param model to learn a real mapping
from (train loss -> ~0, eval loss stuck ~4.5-4.6: memorization, not
generalization).

3 of the 4 target dimensions do NOT need an LLM call at all - they are
pure functions of NIFTY/India VIX price history (the same technical
features analyzer.embed._yf_features_on_date computes, graded by the
same rule analyzer.grader.grade_direction uses). yfinance has years of
that history for free. top_performer_1d is NOT backfillable this way -
it depends on which tickers the LLM actually picked that day, which
cannot be reconstructed without re-running the LLM historically (not
attempted here; out of scope).

Feature construction deliberately mirrors analyzer.embed._yf_features_on_date
+ features_to_text exactly (same keys, same rounding, same RSI formula
- including its simple-mean-not-Wilder-smoothed quirk, replicated
faithfully rather than "corrected", since the point is matching what
the live pipeline actually produces, not producing a more textbook-
correct RSI) so backfilled and live examples share one input
distribution. Vectorized via pandas rolling ops over one bulk download,
NOT one yfinance call per historical day (which is what
_yf_features_on_date does and is far too slow/rate-limit-prone across
years of dates) - this is a deliberate reimplementation, not a call
into that function.

Honest asymmetry, flagged: live examples' feature_text is prefixed with
stated_mood/stated_confidence/stated_call (the model's own view at call
time, from raw_json). Backfilled examples have none of that - there was
no LLM call on a purely historical day, so there is nothing honest to
put there. Fabricating a plausible-looking value would be worse than
omitting it. Anyone concatenating live + backfilled train files should
expect some rows to start with "mood=..." and some not to.

Labels reuse finetune_export._direction_label / _mood_label directly
(same 0.4% flat band as analyzer.grader.grade_direction) and the same
+/-0.5% synthetic range_1d band, so backfilled and live labels are
scored by identical rules - not a separate, looser standard.

Confidence: same conf_by_dim lookup as finetune_export.build_dataset()
(90d trailing accuracy_summary per dim) - a property of the grading
system's measured track record, not of any individual example, so it
applies uniformly to backfilled rows too.

Output is separate from finetune_export.py's train.jsonl/eval.jsonl
(this repo is public - Kaggle private dataset only, never committed).
Combine before uploading: cat the historical + live jsonl files
together, or upload as an extra dataset file and edit the notebook's
TRAIN_JSONL_PATH/EVAL_JSONL_PATH list.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

from analyzer.finetune_export import (
    TARGET_DIMS as LIVE_TARGET_DIMS,
    _direction_label,
    _mood_label,
    _system_prompt,
)

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "finetune"

BACKFILL_DIMS = ["direction_1d", "range_1d", "market_mood_1d"]
FLAT = 0.4  # matches analyzer.grader.grade_direction / finetune_export.FLAT
EVAL_FRACTION = 0.20
DEFAULT_YEARS_BACK = 6

# Same 12-key layout as analyzer.embed.features_to_text, minus the
# stated_* trio (never present here - see module docstring).
_KEYMAP = [
    ("vix", "india_vix"),
    ("vix_chg", "india_vix_change_pct"),
    ("dma20", "nifty_dma20_dist_pct"),
    ("dma50", "nifty_dma50_dist_pct"),
    ("rsi", "nifty_rsi14"),
    ("nifty_5d", "nifty_change_5d_pct"),
    ("nifty_20d", "nifty_change_20d_pct"),
    ("wkday", "weekday"),
    ("month", "month"),
]


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _flatten(df):
    if df is not None and hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
        df = df.copy()
        df.columns = df.columns.get_level_values(0)
    return df


def build_feature_frame(years_back: int) -> pd.DataFrame:
    """One bulk download each for NIFTY + India VIX, then every feature
    computed via pandas rolling ops across the whole series at once -
    the vectorized equivalent of calling
    analyzer.embed._yf_features_on_date once per historical day."""
    start = (date.today() - timedelta(days=int(years_back * 365.25) + 90)).isoformat()
    nifty = _flatten(yf.download("^NSEI", start=start, progress=False, auto_adjust=False))
    vix = _flatten(yf.download("^INDIAVIX", start=start, progress=False, auto_adjust=False))
    if nifty is None or nifty.empty:
        raise SystemExit("No NIFTY history returned - cannot backfill.")
    nifty = nifty.dropna(subset=["Close"]).copy()

    close = nifty["Close"]
    dma20 = close.rolling(20).mean()
    dma50 = close.rolling(50).mean()
    delta = close.diff()
    gain14 = delta.clip(lower=0).rolling(14).mean()
    loss14 = (-delta.clip(upper=0)).rolling(14).mean()
    # Matches _yf_features_on_date's exact edge-case handling: rsi=100
    # when there have been only gains in the window (loss14 == 0 and
    # gain14 > 0), left as NaN (dropped by features_to_text) otherwise.
    rsi = 100 - (100 / (1 + gain14 / loss14.replace(0, pd.NA)))
    rsi = rsi.where(~((loss14 == 0) & (gain14 > 0)), 100.0)

    frame = pd.DataFrame({
        "close": close,
        "next_close": close.shift(-1),
        "nifty_dma20_dist_pct": ((close - dma20) / dma20 * 100).round(2),
        "nifty_dma50_dist_pct": ((close - dma50) / dma50 * 100).round(2),
        "nifty_change_5d_pct": (close.pct_change(5) * 100).round(2),
        "nifty_change_20d_pct": (close.pct_change(20) * 100).round(2),
        "nifty_rsi14": rsi.round(1),
    })

    if vix is not None and not vix.empty:
        vix = vix.dropna(subset=["Close"]).copy()
        vclose = vix["Close"]
        vix_frame = pd.DataFrame({
            "india_vix": vclose.round(2),
            "india_vix_change_pct": (vclose.pct_change() * 100).round(2),
        })
        frame = frame.join(vix_frame, how="left")
    else:
        frame["india_vix"] = pd.NA
        frame["india_vix_change_pct"] = pd.NA

    frame["weekday"] = [
        ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][d.weekday()] for d in frame.index
    ]
    frame["month"] = [d.month for d in frame.index]
    # Need real DMA50/RSI history behind each row and a real next_close
    # ahead of it - both edges are inherently NaN and must be dropped.
    return frame.dropna(subset=["close", "next_close", "nifty_dma50_dist_pct", "nifty_rsi14"])


def _features_to_text(row: pd.Series) -> str:
    parts = []
    for short, full in _KEYMAP:
        v = row.get(full)
        if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v):
            continue
        if isinstance(v, float):
            parts.append(f"{short}={v:.2f}")
        else:
            parts.append(f"{short}={v}")
    return " ".join(parts) or "no features"


def _conf_by_dim(sb) -> dict[str, float]:
    out = {}
    for dim in LIVE_TARGET_DIMS:
        rows = sb.table("accuracy_summary").select("*").eq("dimension", dim).order(
            "computed_at", desc=True
        ).limit(50).execute().data or []
        by_window = {r["window_days"]: r for r in rows}
        r = by_window.get(90) or (rows[0] if rows else None)
        out[dim] = round(r["accuracy_pct"], 1) if r and r.get("accuracy_pct") is not None else 50.0
    return out


def build_dataset(years_back: int) -> tuple[list[dict], dict]:
    sb = _sb()
    conf_by_dim = _conf_by_dim(sb)
    frame = build_feature_frame(years_back)

    examples = []
    skipped = Counter()
    for ts, row in frame.iterrows():
        close, next_close = row["close"], row["next_close"]
        if close <= 0 or next_close <= 0:
            skipped["bad_price"] += 1
            continue
        pct = (next_close - close) / close * 100.0
        feature_text = _features_to_text(row)
        run_at_iso = pd.Timestamp(ts).tz_localize("UTC").isoformat() if pd.Timestamp(ts).tzinfo is None \
            else pd.Timestamp(ts).isoformat()

        for dim in BACKFILL_DIMS:
            if dim == "direction_1d":
                assistant = {"call": _direction_label(pct), "confidence": conf_by_dim[dim]}
            elif dim == "market_mood_1d":
                assistant = {"call": _mood_label(pct), "confidence": conf_by_dim[dim]}
            else:  # range_1d
                lo, hi = round(close * 0.995, 2), round(close * 1.005, 2)
                assistant = {"call": [lo, hi], "confidence": conf_by_dim[dim]}
            examples.append({
                "dimension": dim,
                "run_at": run_at_iso,
                "messages": [
                    {"role": "system", "content": _system_prompt(dim)},
                    {"role": "user", "content": feature_text},
                    {"role": "assistant", "content": json.dumps(assistant)},
                ],
            })

    examples.sort(key=lambda e: e["run_at"])
    return examples, dict(skipped)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--years-back", type=int, default=DEFAULT_YEARS_BACK)
    args = ap.parse_args()

    examples, skipped = build_dataset(args.years_back)
    if not examples:
        raise SystemExit("Refusing: 0 examples assembled.")

    n_eval = max(1, int(len(examples) * EVAL_FRACTION))
    train = examples[:-n_eval]
    eval_ = examples[-n_eval:]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    train_path = out_dir / "train_historical.jsonl"
    eval_path = out_dir / "eval_historical.jsonl"

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
    print(f"Date range: {train[0]['run_at']} -> {eval_[-1]['run_at']}")
    print(f"Temporal split OK: {train[-1]['run_at'] <= eval_[0]['run_at']}")
    print(f"\nWrote {train_path} and {eval_path}")
    print("\nTo combine with the live export before uploading to Kaggle:")
    print(f"  cat {OUT_DIR / 'train.jsonl'} {train_path} > {OUT_DIR / 'train_combined.jsonl'}")
    print(f"  cat {OUT_DIR / 'eval.jsonl'} {eval_path} > {OUT_DIR / 'eval_combined.jsonl'}")
    print("\n--- 2-example preview ---")
    for e in train[:2]:
        print(json.dumps({"messages": e["messages"]}, indent=2))


if __name__ == "__main__":
    main()

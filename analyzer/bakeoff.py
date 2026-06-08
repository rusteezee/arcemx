"""Bake-off harness: run the same real payload through N OpenRouter models
and compare structured-output quality side by side.

Use this BEFORE switching the production aggregator over. Free models cost
nothing so this is free reconnaissance: which model actually obeys our
strict 150-line prompt on YOUR payload, returns valid JSON first try,
emits a tight ATR-anchored range, gives honest confidence, and fills every
schema field? Benchmarks pick the prior; this picks the winner.

Examples
--------
Build a live payload and run the default 3-model bake-off:
    .venv/Scripts/python.exe -m analyzer.bakeoff

Re-run on a saved payload snapshot against a custom model list (no
live data refetch, no cost, fast):
    .venv/Scripts/python.exe -m analyzer.bakeoff \\
        --payload-file data/bakeoff/payload_XXXX.json \\
        --models nvidia/nemotron-3-ultra:free deepseek/deepseek-chat:free

Outputs land in data/bakeoff/ as one JSON per model plus the payload
snapshot, so you can diff full responses by hand if the summary table
is close. Writes nothing to Supabase. Safe to re-run.
"""
import argparse
import json
import re
import time
from pathlib import Path
from dotenv import load_dotenv

from analyzer.llm_router import _post, _parse_json, SYSTEM_PROMPT

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "bakeoff"

DEFAULT_MODELS = [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
]


def _range_width_pct(rng) -> float | None:
    """Parse `'23200-23500'` style → width as % of midpoint."""
    nums = re.findall(r"\d+(?:\.\d+)?", str(rng).replace(",", ""))
    if len(nums) < 2:
        return None
    a, b = float(nums[0]), float(nums[1])
    lo, hi = min(a, b), max(a, b)
    mid = (lo + hi) / 2
    if mid <= 0:
        return None
    return (hi - lo) / mid * 100


REQUIRED_KEYS = (
    "market_mood", "confidence", "nifty_outlook", "nifty_5d_outlook",
    "nifty_20d_outlook", "volatility_regime", "sensex_outlook",
    "short_term_picks", "long_term_picks", "portfolio_verdicts",
    "wishlist_signals", "reasoning_breakdown",
)
RB_KEYS = ("technicals", "macro", "news_flow", "sentiment", "prior_call_check")


def _score(out: dict) -> dict:
    """Reduce a model's structured output to a comparable scorecard."""
    if not isinstance(out, dict) or out.get("error"):
        return {"valid_json": False,
                "error": (out or {}).get("error", "non_dict")}
    missing = [k for k in REQUIRED_KEYS if k not in out]
    nifty = out.get("nifty_outlook") or {}
    rng_w = _range_width_pct(nifty.get("range") or "")
    picks = out.get("short_term_picks") or []
    picks_with_targets = sum(
        1 for p in picks
        if isinstance(p, dict) and p.get("target") and p.get("stop_loss"))
    rb = out.get("reasoning_breakdown") or {}
    rb_filled = [k for k in RB_KEYS
                 if isinstance(rb.get(k), str) and rb[k].strip()]
    return {
        "valid_json": True,
        "missing_fields": missing,
        "confidence": out.get("confidence"),
        "nifty_direction": (nifty.get("direction") or "").lower(),
        "nifty_range_width_pct": round(rng_w, 2) if rng_w is not None else None,
        "n_short_picks": len(picks),
        "picks_with_target_and_sl": picks_with_targets,
        "reasoning_breakdown_filled": len(rb_filled),
        "model_used": out.get("_model_used"),
    }


def _build_payload_live() -> dict:
    """Import lazily so missing optional deps don't break --payload-file mode."""
    from analyzer.aggregator import build_payload
    return build_payload()


def _save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=str), encoding="utf-8")


def run_bakeoff(models: list[str], payload: dict) -> list[dict]:
    """Send the same payload through each model with NO fallback chain so
    each row reflects that model alone (not whatever OpenRouter routed to)."""
    user_msg = ("Analyze this market snapshot and return JSON per schema:\n\n"
                + json.dumps(payload, default=str)[:120000])
    results = []
    ts = int(time.time())
    for m in models:
        print(f"\n=== {m} ===")
        t0 = time.time()
        try:
            resp = _post(
                [{"role": "system", "content": SYSTEM_PROMPT},
                 {"role": "user", "content": user_msg}],
                models=[m],
                max_retries=1,
            )
            out = _parse_json(resp)
        except Exception as e:
            out = {"error": f"{type(e).__name__}: {e}"}
        dt = time.time() - t0
        sc = _score(out)
        sc["latency_s"] = round(dt, 1)
        sc["model"] = m
        results.append({"model": m, "score": sc, "output": out})
        slug = m.replace("/", "_").replace(":", "_")
        _save_json(OUT_DIR / f"out_{slug}_{ts}.json", out)
        print(json.dumps(sc, indent=2, default=str))
    return results


def _fmt(v, w: int) -> str:
    if v is None:
        return f"{'-':>{w}}"
    return f"{v!s:>{w}}"


def print_summary(results: list[dict]) -> None:
    print("\n=== SUMMARY ===")
    cols = (("model", 42, "<"), ("json", 5, ">"), ("conf", 5, ">"),
            ("dir", 9, ">"), ("rng%", 6, ">"), ("picks", 5, ">"),
            ("tp/sl", 6, ">"), ("rb", 3, ">"), ("miss", 4, ">"),
            ("sec", 5, ">"), ("served_by", 36, "<"))
    header = " ".join(f"{name:{align}{w}}" for name, w, align in cols)
    print(header)
    print("-" * len(header))
    for r in results:
        s = r["score"]
        served = (s.get("model_used") or "").split("/")[-1][:36]
        row = (
            f"{r['model'][:42]:<42} "
            f"{'OK' if s.get('valid_json') else 'FAIL':>5} "
            f"{_fmt(s.get('confidence'), 5)} "
            f"{(s.get('nifty_direction') or '-')[:9]:>9} "
            f"{_fmt(s.get('nifty_range_width_pct'), 6)} "
            f"{_fmt(s.get('n_short_picks'), 5)} "
            f"{_fmt(s.get('picks_with_target_and_sl'), 6)} "
            f"{_fmt(s.get('reasoning_breakdown_filled'), 3)} "
            f"{_fmt(len(s.get('missing_fields') or []), 4)} "
            f"{_fmt(s.get('latency_s'), 5)} "
            f"{served:<36}"
        )
        print(row)
    print(f"\nFull outputs and payload snapshot in: {OUT_DIR}/")
    print("Columns: rng% = NIFTY range width as % of midpoint (lower is "
          "tighter, anchor ~1x ATR). tp/sl = short picks with both target "
          "AND stop_loss (out of n_short_picks). rb = reasoning_breakdown "
          "keys filled (max 5). miss = required schema fields missing "
          "(should be 0).")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", nargs="+", default=DEFAULT_MODELS,
                    help="Model IDs to bake off (default: %(default)s)")
    ap.add_argument("--payload-file", default=None,
                    help="Path to a saved payload JSON. If omitted, builds "
                         "a live payload from market data (~30-60s, no DB write).")
    args = ap.parse_args()

    if args.payload_file:
        payload = json.loads(Path(args.payload_file).read_text(encoding="utf-8"))
        print(f"Loaded payload from {args.payload_file}")
    else:
        print("Building live payload (takes ~30-60s)...")
        payload = _build_payload_live()
        ts = int(time.time())
        snap = OUT_DIR / f"payload_{ts}.json"
        _save_json(snap, payload)
        print(f"Saved payload snapshot to {snap}")

    results = run_bakeoff(args.models, payload)
    print_summary(results)


if __name__ == "__main__":
    main()

"""Build a compact self-feedback block from accuracy_summary.

Injected into Gemini prompt so each new call sees its track record + biases.
"""
import os
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        return None
    return create_client(url, key)


def build_feedback() -> dict | None:
    sb = _sb()
    if not sb:
        return None
    # Latest summary per (window, dimension)
    res = sb.table("accuracy_summary").select("*").order(
        "computed_at", desc=True
    ).limit(200).execute()
    rows = res.data or []
    if not rows:
        return None
    # Dedupe: keep latest per (window, dimension)
    latest: dict[tuple, dict] = {}
    for r in rows:
        k = (r["window_days"], r["dimension"])
        if k not in latest:
            latest[k] = r

    by_window: dict[int, list[dict]] = {}
    for (w, dim), r in latest.items():
        by_window.setdefault(w, []).append({
            "dimension": dim,
            "accuracy_pct": r.get("accuracy_pct"),
            "avg_delta": r.get("avg_delta"),
            "sample_size": r.get("sample_size"),
            "bias": r.get("bias"),
        })

    advisories = []
    for w, items in by_window.items():
        for it in items:
            acc = it.get("accuracy_pct") or 0
            dim = it["dimension"]
            n = it.get("sample_size") or 0
            if n < 3:
                continue
            if dim.startswith("direction") and acc < 55:
                advisories.append(
                    f"Direction calls ({dim}, n={n}, last {w}d) only {acc:.0f}% accurate. "
                    f"Reduce confidence on directional bets."
                )
            if dim.startswith("range") and acc < 50:
                advisories.append(
                    f"Range predictions ({dim}, n={n}) miss often ({acc:.0f}%). "
                    f"Widen ranges OR justify tighter ranges with strong signal."
                )
            if dim.startswith("short_pick") and acc < 45:
                advisories.append(
                    f"Short-term picks ({dim}, n={n}) underperform NIFTY. "
                    f"Be more selective. Require stronger technical + news confluence."
                )
            if dim == "avoid_7d" and acc < 50:
                advisories.append(
                    f"Avoid-list picks underperformed less than expected. "
                    f"Tighten avoid criteria."
                )

    return {
        "track_record": by_window,
        "advisories": advisories,
        "note": (
            "Use this feedback to calibrate. If you have been wrong systematically, "
            "adjust this call. If accuracy is high, hold the line."
        ),
    }


if __name__ == "__main__":
    import json
    fb = build_feedback()
    print(json.dumps(fb, indent=2, default=str) if fb else "no feedback yet")

"""Build a strict, honest self-feedback block from the scored track record.

Injected into the Gemini prompt so each new call confronts its real
performance: per-dimension accuracy, confidence calibration error, the
specific recent predictions it got wrong, and hard corrective rules. The
goal is brutal honesty, not encouragement. LLMs calibrate far better from
concrete recent misses ("on 02/06 you called up, NIFTY fell 1.2%") than
from vague advice, so we surface both the aggregates and the specifics.
"""
import os
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        return None
    return create_client(url, key)


def _latest_summaries(sb) -> dict[tuple, dict]:
    res = sb.table("accuracy_summary").select("*").order(
        "computed_at", desc=True
    ).limit(300).execute()
    latest: dict[tuple, dict] = {}
    for r in (res.data or []):
        k = (r["window_days"], r["dimension"])
        if k not in latest:
            latest[k] = r
    return latest


def _direction_history(sb) -> list[dict]:
    """Recent direction predictions joined to their analysis date + the
    confidence the model stated when it made them. FK-independent join."""
    # Newest first so the 200-row cap keeps the RECENT track record once
    # history grows past it (unordered reads return an arbitrary subset).
    ds = sb.table("prediction_scores").select(
        "analysis_id,score,delta,predicted"
    ).eq("dimension", "direction_1d").order(
        "id", desc=True).limit(200).execute().data or []
    ids = list({r["analysis_id"] for r in ds if r.get("analysis_id") is not None})
    meta: dict[int, dict] = {}
    if ids:
        ar = sb.table("analysis").select("id,run_at,raw_json").in_(
            "id", ids
        ).execute().data or []
        meta = {a["id"]: a for a in ar}
    items = []
    for s in ds:
        a = meta.get(s.get("analysis_id"))
        if not a:
            continue
        raw = a.get("raw_json") or {}
        conf = raw.get("confidence")
        items.append({
            "date": (a.get("run_at") or "")[:10],
            "score": s.get("score"),
            "delta": s.get("delta"),
            "called": (s.get("predicted") or {}).get("direction"),
            "confidence": conf if isinstance(conf, (int, float)) else None,
        })
    items.sort(key=lambda x: x["date"])
    return items


def build_feedback() -> dict | None:
    sb = _sb()
    if not sb:
        return None

    latest = _latest_summaries(sb)
    if not latest:
        return None

    by_window: dict[int, list[dict]] = {}
    for (w, dim), r in latest.items():
        by_window.setdefault(w, []).append({
            "dimension": dim,
            "accuracy_pct": r.get("accuracy_pct"),
            "avg_delta": r.get("avg_delta"),
            "sample_size": r.get("sample_size"),
            "bias": r.get("bias"),
        })

    # ---- Confidence calibration + specific recent misses ----
    hist = _direction_history(sb)
    conf_items = [h for h in hist if h["confidence"] is not None and h["score"] is not None]
    calibration = None
    if len(conf_items) >= 5:
        avg_conf = sum(h["confidence"] for h in conf_items) / len(conf_items)
        avg_score = sum(h["score"] for h in conf_items) / len(conf_items)
        calibration = {
            "avg_stated_confidence": round(avg_conf, 1),
            "avg_realized_direction_score": round(avg_score, 1),
            "overconfidence_gap": round(avg_conf - avg_score, 1),
            "n": len(conf_items),
        }

    # One entry per date: several analyses can run on the same day (daily cron
    # plus manual syncs), and 5 copies of the same miss is noise to the model.
    miss_by_date: dict[str, dict] = {}
    for h in hist:
        if h["score"] != 0 or not h["date"]:
            continue
        miss_by_date[h["date"]] = {
            "date": h["date"],
            "called": h["called"] or "unspecified",
            "actual_move_pct": round(h["delta"], 2) if isinstance(h["delta"], (int, float)) else None,
        }
    recent_misses = sorted(miss_by_date.values(), key=lambda x: x["date"])[-5:]

    # ---- Strict corrective rules tied to each failing dimension ----
    rules: list[str] = []

    # Prefer the 30d window for stable signal, fall back to whatever exists.
    window_items = by_window.get(30) or next(iter(by_window.values()), [])
    dim_map = {it["dimension"]: it for it in window_items}

    def _acc(dim):
        it = dim_map.get(dim)
        return (it.get("accuracy_pct") if it else None), (it.get("sample_size", 0) if it else 0)

    dir_acc, dir_n = _acc("direction_1d")
    if dir_acc is not None and dir_n >= 5:
        cap = int(min(dir_acc, 70))
        rules.append(
            f"Direction accuracy is {dir_acc:.0f}% over n={dir_n}. Set your "
            f"`confidence` no higher than {cap}. Only commit to up/down when "
            f"technicals AND news clearly align; otherwise call sideways."
        )

    if calibration and calibration["overconfidence_gap"] > 8:
        rules.append(
            f"You are OVERCONFIDENT by {calibration['overconfidence_gap']:.0f} points "
            f"(stated {calibration['avg_stated_confidence']:.0f} vs realized "
            f"{calibration['avg_realized_direction_score']:.0f}). Lower confidence to "
            f"match what you actually deliver."
        )
    elif calibration and calibration["overconfidence_gap"] < -8:
        rules.append(
            f"You are UNDERCONFIDENT by {abs(calibration['overconfidence_gap']):.0f} points. "
            f"When signals align you may raise confidence."
        )

    # Range discipline: NEVER settle. A hit band must tighten the next
    # day, every day, until it starts missing; only a miss buys back
    # width. The window-average rule pressures the trend; the
    # yesterday-specific rule pressures the very next call with the
    # exact width it must beat.
    for dim, label in (("range_1d", "NIFTY range"), ("sensex_range_1d", "Sensex range")):
        it = dim_map.get(dim)
        if not it or (it.get("sample_size", 0) < 3):
            continue
        acc = it.get("accuracy_pct") or 0
        width = (it.get("bias") or {}).get("avg_band_width_pct")
        if acc >= 90 and isinstance(width, (int, float)):
            tighter = round(width * 0.7, 2)
            rules.append(
                f"{label} hits {acc:.0f}% at an average band width of {width:.2f}%. "
                f"That band is too loose to be useful. Tighten toward {tighter:.2f}% "
                f"width while keeping the close inside it. Do NOT repeat "
                f"{width:.2f}%; a hit at the same width is a wasted day of learning."
            )
        elif acc >= 70 and isinstance(width, (int, float)):
            tighter = round(width * 0.85, 2)
            rules.append(
                f"{label} hits {acc:.0f}% at an average band width of {width:.2f}%. "
                f"Good containment earns a tighter test: bring the band toward "
                f"{tighter:.2f}% width. Never settle at a width that keeps hitting."
            )
        elif acc < 50:
            rules.append(
                f"{label} only contains the close {acc:.0f}% of the time. Widen the band "
                f"OR justify a tight band with an explicit, strong signal."
            )

    # Yesterday-specific range pressure: if the latest graded band
    # contained the close, today's band MUST be narrower than it.
    for dim, label, rule_label in (
            ("range_1d", "^NSEI", "NIFTY"),
            ("sensex_range_1d", "^BSESN", "Sensex")):
        try:
            last = sb.table("prediction_scores").select(
                "score,predicted,notes"
            ).eq("dimension", dim).order("id", desc=True).limit(1).execute().data or []
        except Exception:
            last = []
        if not last:
            continue
        row = last[0]
        score = row.get("score")
        rng = (row.get("predicted") or {}).get("range")
        if (not isinstance(score, (int, float)) or score < 80
                or not isinstance(rng, (list, tuple)) or len(rng) < 2):
            continue
        try:
            lo, hi = float(rng[0]), float(rng[1])
        except (TypeError, ValueError):
            continue
        mid = (lo + hi) / 2
        if mid <= 0 or hi <= lo:
            continue
        w_pct = round((hi - lo) / mid * 100, 2)
        target = round(w_pct * 0.85, 2)
        rules.append(
            f"Your latest graded {rule_label} band {lo:.0f}-{hi:.0f} "
            f"({w_pct:.2f}% wide) CONTAINED the close (score {score:.0f}). "
            f"Mandatory: today's {rule_label} band must be NARROWER than "
            f"{w_pct:.2f}% of midpoint; target {target:.2f}% or tighter. The only "
            f"acceptable reason to widen is an explicit volatility-expansion "
            f"signal (event day, VIX or ATR up >10%), and you must cite it."
        )

    for dim, label in (("short_pick_7d", "Short picks 7d"),
                       ("short_pick_30d", "Short picks 30d")):
        acc, n = _acc(dim)
        if acc is not None and n >= 5 and acc < 50:
            rules.append(
                f"{label} underperform NIFTY ({acc:.0f}%, n={n}). Raise the bar: require "
                f"RSI 50-65, a bullish MACD crossover, a recent news catalyst, AND volume "
                f"confirmation before listing a pick. Fewer, higher-conviction picks."
            )

    v_acc, v_n = _acc("verdict_7d")
    if v_acc is not None and v_n >= 5 and v_acc < 55:
        rules.append(
            f"Portfolio verdicts are only {v_acc:.0f}% right (n={v_n}). Be decisive: do not "
            f"default to hold. Call add only on genuine strength and exit/trim on real weakness."
        )

    w_acc, w_n = _acc("wishlist_7d")
    if w_acc is not None and w_n >= 5 and w_acc < 55:
        rules.append(
            f"Wishlist signals are only {w_acc:.0f}% right (n={w_n}). Tighten entry zones and "
            f"reserve buy_now for clear setups."
        )

    return {
        "track_record": by_window,
        "calibration": calibration,
        "recent_direction_misses": recent_misses,
        "corrective_rules": rules,
        "note": (
            "This is your scored track record, graded brutally against real outcomes. "
            "Obey the corrective_rules. Make your `confidence` reflect your realized "
            "direction accuracy, not optimism. Give the NARROWEST range you can defend "
            "with signal, not a safe wide band. RANGE DOCTRINE: a band that contained "
            "yesterday's close MUST be tighter today; never repeat a width after a hit. "
            "Keep tightening every hit until a band misses, then widen one notch, not "
            "back to the old comfort width. A wide band that always hits teaches "
            "nothing. Learn from the specific recent_misses."
        ),
    }


if __name__ == "__main__":
    import json
    fb = build_feedback()
    print(json.dumps(fb, indent=2, default=str) if fb else "no feedback yet")

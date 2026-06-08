"""Score past predictions against actual market outcomes.

Runs daily 9 PM IST via cron. For each analysis row, computes scores per
dimension when the horizon has elapsed.

Dimensions scored:
- direction_1d : NIFTY direction next session vs prediction
- direction_5d : 5-trading-day direction
- range_1d     : did NIFTY close in predicted range
- short_pick_7d, short_pick_14d, short_pick_30d : avg pick return vs NIFTY
- long_pick_180d : avg long pick return vs NIFTY (way later)
- avoid_7d     : did avoid-list underperform NIFTY
- verdict_7d   : portfolio verdict correctness (hold steady, add → up, exit → down)
"""
import os
import re
import json
from datetime import datetime, timedelta, timezone
import yfinance as yf
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase env missing")
    return create_client(url, key)


def _close_on_or_after(ticker: str, ts: datetime) -> float | None:
    """Closest trading-day close at-or-after ts."""
    try:
        end = ts + timedelta(days=10)
        df = yf.download(ticker, start=ts.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"),
                         interval="1d", progress=False, auto_adjust=True)
        if df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        return float(df["Close"].iloc[0])
    except Exception:
        return None


def _close_n_sessions_later(ticker: str, base_ts: datetime, n: int) -> float | None:
    """Close after n trading sessions from base_ts."""
    try:
        end = base_ts + timedelta(days=max(n * 2, 7))
        df = yf.download(ticker, start=base_ts.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"),
                         interval="1d", progress=False, auto_adjust=True)
        if df.empty or len(df) <= n:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        return float(df["Close"].iloc[n])
    except Exception:
        return None


def _parse_range(rng: str) -> tuple[float, float] | None:
    """`23200-23500` or `23200 - 23500` → (23200, 23500)."""
    if not rng:
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", str(rng).replace(",", ""))
    if len(nums) >= 2:
        a, b = float(nums[0]), float(nums[1])
        return (min(a, b), max(a, b))
    return None


def grade_direction(predicted_dir: str, last_close: float, next_close: float) -> tuple[float, float]:
    """Strict direction score 0-100 + raw delta %.

    Brutal by design: a directional call (up/down) is either right or wrong,
    no half credit for a near-flat day. Only an explicit sideways call earns
    partial credit, since calling sideways IS a claim of low movement.
    """
    if last_close is None or next_close is None or last_close == 0:
        return 0, 0
    pct = (next_close - last_close) / last_close * 100
    p = (predicted_dir or "").lower()
    if p == "up":
        score = 100 if pct > 0.1 else 0
    elif p == "down":
        score = 100 if pct < -0.1 else 0
    elif p in ("sideways", "flat", "neutral"):
        if abs(pct) <= 0.4: score = 100
        elif abs(pct) <= 0.8: score = 50
        else: score = 0
    else:
        score = 0
    return float(score), float(pct)


def grade_range(rng_tuple: tuple[float, float] | None, actual_close: float) -> tuple[float, float]:
    """Interval score 0-100 that rewards tightness, not just containment.

    A loose band that always contains the close is useless, so plain
    containment is not enough. This is a 0-100 mapping of the standard
    interval-score idea:
      - Hit: start at 100 and subtract a width penalty, so the tightest band
        that still holds scores highest (width 0% -> 100, ~1.7% -> ~86,
        3% -> ~76).
      - Miss: collapse to a low score that decays fast with distance, so a
        confident (narrow) wrong band is punished hard (0.5% miss -> ~28,
        1% -> ~15, >=1.6% -> 0).
    This makes the model hunt for the narrowest band it can actually hit.
    Returns (score, width_pct on hit / -miss_pct on miss).
    """
    if not rng_tuple or actual_close is None:
        return 0, 0
    lo, hi = rng_tuple
    mid = (lo + hi) / 2
    if mid <= 0:
        return 0, 0
    width_pct = (hi - lo) / mid * 100
    if lo <= actual_close <= hi:
        return max(0.0, 100 - 8 * width_pct), float(width_pct)
    miss = (lo - actual_close) if actual_close < lo else (actual_close - hi)
    miss_pct = miss / mid * 100
    return max(0.0, 40 - 25 * miss_pct), float(-miss_pct)


def _ret_pct(ticker: str, base_ts: datetime, n: int) -> float | None:
    """Return % move of ticker over n trading sessions from base_ts."""
    a = _close_on_or_after(ticker, base_ts)
    b = _close_n_sessions_later(ticker, base_ts, n)
    if a is None or b is None or a == 0:
        return None
    return (b - a) / a * 100


def grade_verdict(verdict: str, ret_pct: float) -> float:
    """Score a portfolio verdict against the holding's realized move.

    add  -> expected up; hold -> expected to not crater; trim -> expected to
    cool off; exit -> expected down. Scored 0-100.
    """
    v = (verdict or "").lower()
    if v == "add":
        return 100.0 if ret_pct > 0.5 else (50.0 if ret_pct > -1 else 0.0)
    if v == "hold":
        return 100.0 if ret_pct > -2 else (40.0 if ret_pct > -4 else 0.0)
    if v == "trim":
        return 100.0 if ret_pct < 1 else (40.0 if ret_pct < 3 else 0.0)
    if v == "exit":
        return 100.0 if ret_pct < 0 else (40.0 if ret_pct < 1.5 else 0.0)
    return 0.0


def grade_wishlist_signal(signal: str, ret_pct: float) -> float:
    """Score a wishlist signal. buy_now wants an up move; wait/skip are right
    when the stock did NOT run away from the user."""
    s = (signal or "").lower()
    if s == "buy_now":
        return 100.0 if ret_pct > 0.5 else (50.0 if ret_pct > -1 else 0.0)
    if s == "wait":
        return 100.0 if ret_pct <= 1 else (40.0 if ret_pct < 3 else 0.0)
    if s == "skip":
        return 100.0 if ret_pct < 1 else (40.0 if ret_pct < 3 else 0.0)
    return 0.0


def grade_pick(ticker: str, base_ts: datetime, horizon: int) -> tuple[float | None, float | None]:
    """Return (pick_pct, nifty_pct) over horizon trading days."""
    nifty_now = _close_on_or_after("^NSEI", base_ts)
    nifty_later = _close_n_sessions_later("^NSEI", base_ts, horizon)
    pick_now = _close_on_or_after(ticker, base_ts)
    pick_later = _close_n_sessions_later(ticker, base_ts, horizon)
    if None in (nifty_now, nifty_later, pick_now, pick_later):
        return None, None
    pick_pct = (pick_later - pick_now) / pick_now * 100
    nifty_pct = (nifty_later - nifty_now) / nifty_now * 100
    return pick_pct, nifty_pct


def _upsert_score(sb, analysis_id: int, dimension: str, horizon_days: int,
                  predicted, actual, score: float, delta: float, notes: str = ""):
    sb.table("prediction_scores").upsert({
        "analysis_id": analysis_id,
        "dimension": dimension,
        "horizon_days": horizon_days,
        "predicted": predicted,
        "actual": actual,
        "score": float(score),
        "delta": float(delta),
        "notes": notes,
    }, on_conflict="analysis_id,dimension,horizon_days").execute()


def grade_all(lookback_days: int = 90):
    """Iterate past analyses, score whatever horizons are now elapsed."""
    sb = _sb()
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).isoformat()
    res = sb.table("analysis").select("id,run_at,raw_json").gte(
        "run_at", since
    ).order("run_at", desc=False).execute()
    rows = res.data or []
    print(f"Grading {len(rows)} analyses (lookback {lookback_days}d)...")

    now = datetime.now(timezone.utc)
    for row in rows:
        try:
            aid = row["id"]
            run_at = datetime.fromisoformat(row["run_at"].replace("Z", "+00:00"))
            age = (now - run_at).days
            raw = row.get("raw_json") or {}

            # ----- Direction + Range (1d horizon) -----
            if age >= 1:
                last_close = _close_on_or_after("^NSEI", run_at - timedelta(days=1))
                next_close = _close_on_or_after("^NSEI", run_at + timedelta(days=1))
                pred_dir = (raw.get("nifty_outlook") or {}).get("direction", "")
                pred_rng = _parse_range((raw.get("nifty_outlook") or {}).get("range", ""))

                score, delta = grade_direction(pred_dir, last_close, next_close)
                _upsert_score(sb, aid, "direction_1d", 1,
                              {"direction": pred_dir}, {"pct": delta},
                              score, delta)
                if pred_rng:
                    rscore, rdelta = grade_range(pred_rng, next_close)
                    _upsert_score(sb, aid, "range_1d", 1,
                                  {"range": list(pred_rng)},
                                  {"close": next_close}, rscore, rdelta)

                # ----- Sensex direction + range (1d) -----
                s_last = _close_on_or_after("^BSESN", run_at - timedelta(days=1))
                s_next = _close_on_or_after("^BSESN", run_at + timedelta(days=1))
                s_dir = (raw.get("sensex_outlook") or {}).get("direction", "")
                s_rng = _parse_range((raw.get("sensex_outlook") or {}).get("range", ""))
                if s_dir and s_last and s_next:
                    sscore, sdelta = grade_direction(s_dir, s_last, s_next)
                    _upsert_score(sb, aid, "sensex_direction_1d", 1,
                                  {"direction": s_dir}, {"pct": sdelta},
                                  sscore, sdelta)
                if s_rng and s_next:
                    srscore, srdelta = grade_range(s_rng, s_next)
                    _upsert_score(sb, aid, "sensex_range_1d", 1,
                                  {"range": list(s_rng)},
                                  {"close": s_next}, srscore, srdelta)

            # ----- NIFTY multi-day direction (5d, 20d): trend, more signal -----
            for h, key in ((5, "nifty_5d_outlook"), (20, "nifty_20d_outlook")):
                if age < h + 1:
                    continue
                base = _close_on_or_after("^NSEI", run_at)
                later = _close_n_sessions_later("^NSEI", run_at, h)
                pdir = (raw.get(key) or {}).get("direction", "")
                if pdir and base and later:
                    msc, mdl = grade_direction(pdir, base, later)
                    _upsert_score(sb, aid, f"direction_{h}d", h,
                                  {"direction": pdir}, {"pct": mdl}, msc, mdl)

            # ----- Short-term picks (7d, 14d, 30d) -----
            for h in (7, 14, 30):
                if age < h + 1:
                    continue
                picks = raw.get("short_term_picks", []) or []
                deltas = []
                ticker_results = []
                for p in picks[:5]:
                    tk = p.get("ticker")
                    if not tk:
                        continue
                    pick_pct, nifty_pct = grade_pick(tk, run_at, h)
                    if pick_pct is None:
                        continue
                    alpha = pick_pct - (nifty_pct or 0)
                    deltas.append(alpha)
                    ticker_results.append({"ticker": tk, "pick_pct": pick_pct,
                                            "nifty_pct": nifty_pct, "alpha": alpha})
                if deltas:
                    avg_alpha = sum(deltas) / len(deltas)
                    # score: +5% alpha = 100, 0 = 50, -5% = 0
                    score = max(0, min(100, 50 + avg_alpha * 10))
                    _upsert_score(sb, aid, f"short_pick_{h}d", h,
                                  {"picks": [p.get("ticker") for p in picks[:5]]},
                                  {"results": ticker_results},
                                  score, avg_alpha,
                                  notes=f"avg alpha vs NIFTY: {avg_alpha:+.2f}%")

            # ----- Long picks (180d) -----
            if age >= 181:
                lpicks = raw.get("long_term_picks", []) or []
                deltas = []
                results = []
                for p in lpicks[:5]:
                    tk = p.get("ticker")
                    if not tk:
                        continue
                    pick_pct, nifty_pct = grade_pick(tk, run_at, 180)
                    if pick_pct is None:
                        continue
                    alpha = pick_pct - (nifty_pct or 0)
                    deltas.append(alpha)
                    results.append({"ticker": tk, "pick_pct": pick_pct,
                                     "nifty_pct": nifty_pct, "alpha": alpha})
                if deltas:
                    avg = sum(deltas) / len(deltas)
                    score = max(0, min(100, 50 + avg * 5))
                    _upsert_score(sb, aid, "long_pick_180d", 180,
                                  {"picks": [p.get("ticker") for p in lpicks[:5]]},
                                  {"results": results}, score, avg,
                                  notes=f"avg alpha vs NIFTY 180d: {avg:+.2f}%")

            # ----- Avoid list (7d) -----
            if age >= 8:
                avoids = raw.get("stocks_to_avoid", []) or []
                deltas = []
                results = []
                for p in avoids[:5]:
                    tk = p.get("ticker")
                    if not tk:
                        continue
                    pick_pct, nifty_pct = grade_pick(tk, run_at, 7)
                    if pick_pct is None:
                        continue
                    # Want avoid to UNDERperform NIFTY → negative alpha = good
                    alpha = pick_pct - (nifty_pct or 0)
                    deltas.append(-alpha)  # invert: negative real alpha = positive score
                    results.append({"ticker": tk, "pick_pct": pick_pct,
                                     "nifty_pct": nifty_pct, "alpha": alpha})
                if deltas:
                    avg = sum(deltas) / len(deltas)
                    score = max(0, min(100, 50 + avg * 10))
                    _upsert_score(sb, aid, "avoid_7d", 7,
                                  {"avoid": [p.get("ticker") for p in avoids[:5]]},
                                  {"results": results}, score, -avg,
                                  notes=f"avoid underperformance vs NIFTY: {-avg:+.2f}%")

            # ----- Portfolio verdicts (7d) -----
            if age >= 8:
                verdicts = raw.get("portfolio_verdicts", []) or []
                vscores = []
                vresults = []
                for vd in verdicts:
                    tk = vd.get("ticker")
                    verdict = vd.get("verdict")
                    if not tk or not verdict:
                        continue
                    ret = _ret_pct(tk, run_at, 7)
                    if ret is None:
                        continue
                    sc = grade_verdict(verdict, ret)
                    vscores.append(sc)
                    vresults.append({"ticker": tk, "verdict": verdict,
                                     "ret_pct": round(ret, 2), "score": sc})
                if vscores:
                    avg_v = sum(vscores) / len(vscores)
                    _upsert_score(sb, aid, "verdict_7d", 7,
                                  {"verdicts": [{"ticker": v["ticker"],
                                                 "verdict": v["verdict"]} for v in vresults]},
                                  {"results": vresults}, avg_v, 0,
                                  notes=f"avg verdict score across {len(vscores)} holdings")

            # ----- Wishlist signals (7d) -----
            if age >= 8:
                wsignals = raw.get("wishlist_signals", []) or []
                wscores = []
                wresults = []
                for ws in wsignals:
                    tk = ws.get("ticker")
                    sig = ws.get("signal")
                    if not tk or not sig:
                        continue
                    ret = _ret_pct(tk, run_at, 7)
                    if ret is None:
                        continue
                    sc = grade_wishlist_signal(sig, ret)
                    wscores.append(sc)
                    wresults.append({"ticker": tk, "signal": sig,
                                     "ret_pct": round(ret, 2), "score": sc})
                if wscores:
                    avg_w = sum(wscores) / len(wscores)
                    _upsert_score(sb, aid, "wishlist_7d", 7,
                                  {"signals": [{"ticker": w["ticker"],
                                                "signal": w["signal"]} for w in wresults]},
                                  {"results": wresults}, avg_w, 0,
                                  notes=f"avg wishlist signal score across {len(wscores)} names")

            print(f"  graded analysis {aid} ({age}d old)")
        except Exception as e:
            print(f"  fail analysis {row.get('id')}: {e}")

    print("Done grading.")


def compute_summaries(windows=(7, 30, 90)):
    """Compute accuracy summaries per dimension per window."""
    sb = _sb()
    for window in windows:
        since = (datetime.now(timezone.utc) - timedelta(days=window)).isoformat()
        res = sb.table("prediction_scores").select(
            "dimension,score,delta,predicted"
        ).gte("scored_at", since).execute()
        rows = res.data or []
        by_dim: dict[str, list[dict]] = {}
        for r in rows:
            by_dim.setdefault(r["dimension"], []).append(r)
        for dim, items in by_dim.items():
            scores = [it["score"] for it in items if it.get("score") is not None]
            deltas = [it["delta"] for it in items if it.get("delta") is not None]
            if not scores:
                continue
            avg_score = sum(scores) / len(scores)
            avg_delta = sum(deltas) / len(deltas) if deltas else 0
            bias = {}
            if dim.startswith("direction"):
                # bull-tilt = avg delta positive when calling up
                bias = {"avg_delta_pct": round(avg_delta, 3)}
            elif dim.startswith("range"):
                # A high range hit rate is only meaningful if the predicted
                # band is tight. Record the average band width as a % of its
                # midpoint so a 97% hit rate on a +/-5% band reads honestly.
                widths = []
                for it in items:
                    pred = it.get("predicted") or {}
                    rng = pred.get("range")
                    if isinstance(rng, (list, tuple)) and len(rng) >= 2:
                        lo, hi = float(rng[0]), float(rng[1])
                        mid = (lo + hi) / 2
                        if mid > 0:
                            widths.append((hi - lo) / mid * 100)
                if widths:
                    bias = {"avg_band_width_pct": round(sum(widths) / len(widths), 3)}
            sb.table("accuracy_summary").insert({
                "window_days": window,
                "dimension": dim,
                "accuracy_pct": round(avg_score, 2),
                "avg_delta": round(avg_delta, 3),
                "sample_size": len(scores),
                "bias": bias,
            }).execute()
    print("Summaries computed.")


if __name__ == "__main__":
    grade_all(lookback_days=90)
    compute_summaries()

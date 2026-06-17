"""Score past predictions against actual market outcomes.

Runs daily 5 PM IST (17:00, 90 min after close) via cron. For each analysis
row, computes scores per dimension once that horizon has elapsed.

All 1-day dimensions are SESSION-anchored via _session_bounds: a prediction
made at run_at targets the first session whose close follows run_at, and is
graded as that session's close vs the close of the session immediately
before it. One session, exactly. This makes the 17:00 IST pass score the
same morning's call (so Sensei at 20:00 reads real grades), handles weekend
and post-close runs correctly, and never compares a bar against itself.

Dimensions scored (see grade_all for the full set):
- direction_1d / 5d / 20d : NIFTY direction, horizon-scaled noise band
- range_1d                : interval score (tightness-penalised) for NIFTY band
- sensex_direction_1d / sensex_range_1d : same for Sensex
- vol_regime_5d           : volatility expansion/contraction/normal call
- short_pick_7d/14d/30d   : avg pick alpha vs NIFTY
- pick_tp_sl              : short pick hit target before stop (OHLC walk)
- long_pick_180d          : avg long pick alpha vs NIFTY
- long_pick_tp_sl         : long pick target-before-stop (interim ~60 sessions)
- avoid_7d                : did avoid-list underperform NIFTY
- verdict_7d              : portfolio verdict direction correctness
- verdict_tp_sl           : holding target-before-stop (~20 sessions)
- wishlist_7d             : wishlist signal correctness
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


# NSE/BSE cash session closes 15:30 IST = 10:00 UTC. A prediction made
# before the close targets THAT session; made after the close (or on a
# non-trading day) it targets the NEXT session. Grading must compare the
# target session's close against the close of the session immediately
# before it, one session, no more. The old calendar-day windowing
# (run_at-1d vs run_at+1d) graded a TWO-session move on weekdays and a
# zero move (same bar on both sides) for weekend runs, which handed
# sideways calls free 100s and directional calls fake 0s.
_SESSION_CLOSE_UTC = 10


def _session_bounds(ticker: str, run_at: datetime) -> tuple[float, float, str] | None:
    """Resolve (prev_close, target_close, target_date) for the session a
    prediction made at run_at is about.

    target session = first trading session whose close happens after
    run_at. prev_close = close of the session immediately before it.
    Returns None when the target session has not closed yet (call still
    in flight, grade on a later pass) or data is missing. yfinance
    serves a partial in-progress bar for the current session, so we
    additionally require now to be past the target session's close
    (+15 min settle buffer) before trusting the bar.
    """
    try:
        start = run_at - timedelta(days=12)
        end = run_at + timedelta(days=8)
        df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"), interval="1d",
                         progress=False, auto_adjust=True)
        if df.empty or len(df) < 2:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        run_date = run_at.date()
        cutoff = run_date if run_at.hour < _SESSION_CLOSE_UTC else run_date + timedelta(days=1)
        target_idx = None
        for i, ix in enumerate(df.index):
            if ix.date() >= cutoff:
                target_idx = i
                break
        if target_idx is None or target_idx == 0:
            return None
        target_date = df.index[target_idx].date()
        settle = datetime(target_date.year, target_date.month, target_date.day,
                          _SESSION_CLOSE_UTC, 15, tzinfo=timezone.utc)
        if datetime.now(timezone.utc) < settle:
            return None
        prev_close = float(df["Close"].iloc[target_idx - 1])
        target_close = float(df["Close"].iloc[target_idx])
        if prev_close <= 0 or target_close <= 0:
            return None
        return prev_close, target_close, target_date.isoformat()
    except Exception:
        return None


def _parse_range(rng: str) -> tuple[float, float] | None:
    """`23200-23500` or `23200 - 23500` -> (23200, 23500). Returns None on a
    placeholder "0-0" or any range with non-positive bounds, since the model
    occasionally emits zeros for data-thin tickers (US ADRs absent from
    yfinance .NS) and scoring those would inject pure garbage into the
    grader average."""
    if not rng:
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", str(rng).replace(",", ""))
    if len(nums) >= 2:
        a, b = float(nums[0]), float(nums[1])
        lo, hi = min(a, b), max(a, b)
        if lo <= 0 or hi <= 0 or hi == lo:
            return None
        return (lo, hi)
    return None


# Horizon-scaled "flat" band in %: moves inside it are noise, not a trend. A
# flat 1-day session and a flat 20-day stretch are different sizes, so the
# band must scale or multi-day calls become trivially easy (any drift clears a
# 0.4% bar over 20 sessions) while sideways becomes impossible to hit.
DIRECTION_FLAT = {1: 0.4, 5: 1.2, 20: 2.5}


def grade_direction(predicted_dir: str, last_close: float, next_close: float,
                    flat: float = 0.4) -> tuple[float, float]:
    """Strict, horizon-aware direction score 0-100 + raw delta %.

    `flat` is the noise band for this horizon. Brutal by design: a directional
    call (up/down) is right ONLY if the move clears the flat band in that
    direction. A move that stayed inside the noise band earns the up/down call
    nothing, even if the sign was technically correct, because it was not a
    real move. Only an explicit sideways call earns partial credit, since
    calling sideways IS a claim that the move stays small.
    """
    if last_close is None or next_close is None or last_close == 0:
        return 0, 0
    pct = (next_close - last_close) / last_close * 100
    p = (predicted_dir or "").lower()
    if p == "up":
        score = 100 if pct > flat else 0
    elif p == "down":
        score = 100 if pct < -flat else 0
    elif p in ("sideways", "flat", "neutral"):
        if abs(pct) <= flat: score = 100
        elif abs(pct) <= 2 * flat: score = 50
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

    Continuous gradients (replaces the old trinary 0/40-50/100 cliffs).
    Previous version mean-scored verdict_7d at ~98 with stdev 4.7 because
    "hold" returned 100 for any return > -2% and most holdings stay
    within that band on a 7d window. The skill ratio rolled up to 10.2
    standard deviations above coin-flip, which read as "perfect calibration"
    but was actually a generous threshold on the default verdict. The
    rebuild gives each call a real loss function: add/exit are directional
    bets that earn full credit only on a clear move; hold earns full credit
    only when the holding is genuinely flat (|r| <= 1.5%); trim earns
    credit for a softening move and loses it on a rally.
    """
    v = (verdict or "").lower()
    r = float(ret_pct)
    if v == "add":
        # Up bet. Linear: +3% -> 100, 0% -> 50, -3% -> 0. Clamp.
        return max(0.0, min(100.0, 50.0 + r * 16.67))
    if v == "hold":
        # Flat call. Tight band: |r|<=1.5 -> 100, <=3 -> 70, <=5 -> 40,
        # else 10. "Did not crater" is a free pass; "stayed flat" is not.
        ar = abs(r)
        if ar <= 1.5: return 100.0
        if ar <= 3.0: return 70.0
        if ar <= 5.0: return 40.0
        return 10.0
    if v == "trim":
        # Cool-off bet. -2% -> 90, 0% -> 60, +2% -> 30, +4% -> 0.
        return max(0.0, min(100.0, 60.0 - r * 15.0))
    if v == "exit":
        # Down bet. Mirror of add. -3% -> 100, 0% -> 50, +3% -> 0.
        return max(0.0, min(100.0, 50.0 - r * 16.67))
    return 0.0


def _vol_regime_ratio(base_ts: datetime, horizon: int = 5) -> float | None:
    """Ratio of realized avg daily range over the next `horizon` sessions to
    the prior ~10 sessions. >1 = volatility expanded, <1 = contracted."""
    try:
        start = base_ts - timedelta(days=30)
        end = base_ts + timedelta(days=max(horizon * 2, 12))
        df = yf.download("^NSEI", start=start.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"), interval="1d",
                         progress=False, auto_adjust=True)
        if df.empty or len(df) < 12:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        rng = ((df["High"] - df["Low"]) / df["Close"] * 100).reset_index(drop=True)
        # Index of the first bar on/after base_ts.
        base_str = base_ts.strftime("%Y-%m-%d")
        idx_list = [i for i, ts in enumerate(df.index) if ts.strftime("%Y-%m-%d") >= base_str]
        if not idx_list:
            return None
        b = idx_list[0]
        prior = rng.iloc[max(0, b - 10):b]
        nxt = rng.iloc[b:b + horizon]
        if len(prior) < 3 or len(nxt) < horizon:
            return None
        pm, nm = prior.mean(), nxt.mean()
        if pm <= 0:
            return None
        return float(nm / pm)
    except Exception:
        return None


def grade_vol_regime(call: str, ratio: float) -> float:
    c = (call or "").lower()
    if c == "expansion":
        return 100.0 if ratio > 1.2 else (50.0 if ratio > 1.0 else 0.0)
    if c == "contraction":
        return 100.0 if ratio < 0.8 else (50.0 if ratio < 1.0 else 0.0)
    if c in ("normal", "stable", "neutral"):
        return 100.0 if 0.8 <= ratio <= 1.2 else (40.0 if 0.7 <= ratio <= 1.4 else 0.0)
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


def _parse_num(s) -> float | None:
    """First numeric value from a string like '₹8,500' or '360-400'."""
    if s is None:
        return None
    nums = re.findall(r"\d+(?:\.\d+)?", str(s).replace(",", ""))
    return float(nums[0]) if nums else None


def _ohlc_walk(ticker: str, base_ts: datetime, sessions: int) -> list[tuple[float, float, float]]:
    """(high, low, close) for up to `sessions` trading days on/after base_ts."""
    try:
        end = base_ts + timedelta(days=max(sessions * 2, 12))
        df = yf.download(ticker, start=base_ts.strftime("%Y-%m-%d"),
                         end=end.strftime("%Y-%m-%d"), interval="1d",
                         progress=False, auto_adjust=True)
        if df.empty:
            return []
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        rows = []
        for _, r in df.head(sessions).iterrows():
            rows.append((float(r["High"]), float(r["Low"]), float(r["Close"])))
        return rows
    except Exception:
        return []


def grade_pick_tp_sl(ticker: str, base_ts: datetime, entry, target, stop,
                     sessions: int = 10) -> float | None:
    """Did the pick hit its target before its stop_loss? Long if target>entry.
    100 target-first, 0 stop-first, 50 ambiguous same-day, else partial by how
    far the close travelled toward target."""
    t = _parse_num(target)
    s = _parse_num(stop)
    e = _parse_num(entry) or _close_on_or_after(ticker, base_ts)
    if t is None or s is None or e is None:
        return None
    rows = _ohlc_walk(ticker, base_ts, sessions)
    if not rows:
        return None
    long = t >= e
    for high, low, _close in rows:
        if long:
            hit_t, hit_s = high >= t, low <= s
        else:
            hit_t, hit_s = low <= t, high >= s
        if hit_t and hit_s:
            return 50.0
        if hit_t:
            return 100.0
        if hit_s:
            return 0.0
    last_close = rows[-1][2]
    denom = (t - e) if long else (e - t)
    if denom == 0:
        return 50.0
    progress = ((last_close - e) if long else (e - last_close)) / denom
    return float(max(0.0, min(100.0, 50 + progress * 40)))


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


# Tokens that prove the model anchored a claim to a payload field. Counted
# per reasoning_breakdown key by case-insensitive substring match. Order
# does not matter; same term counted once per key, not per occurrence.
_PAYLOAD_FIELD_TOKENS = (
    "rsi", "macd", "atr", "sma", "dma", "ema", "bollinger",
    "support", "resistance", "vix", "india vix", "usdinr", "usd/inr",
    "crude", "brent", "wti", "dxy", "us10y", "10-year", "10y",
    "nikkei", "hangseng", "hang seng", "sp500", "s&p", "nasdaq", "dow",
    "fii", "dii", "expiry", "month-end", "month end",
    "net_sentiment", "materiality", "news_digest",
    "above sma", "below sma", "above dma", "below dma",
    "above 20", "above 50", "above 200", "below 20", "below 50", "below 200",
)

# Hedge phrases banned by the SYSTEM_PROMPT language-discipline block.
# Each occurrence in a key subtracts from that key's score. Strict.
_BANNED_HEDGES = (
    "could see", "may move", "potentially", "likely to",
    "expected to", "appears to", "looks like", "seems to", "tends to",
    "should", "might", "around ", "approximately",
    "given the current setup", "in the near term", "going forward",
    "amid global cues", "in light of", "broadly", "generally", "overall",
)

_NUM_RE = re.compile(r"-?\d+(?:[\.,]\d+)?%?")


def _audit_key(text: str) -> tuple[float, dict]:
    """Score one reasoning_breakdown key 0-100.

    Composite of three signals:
    - numeric density: every concrete number cited is evidence the claim is
      anchored to the data, not vibes.
    - payload field citations: proves the model actually used the structured
      input we send instead of regurgitating priors.
    - banned hedges: each hedge phrase removes credit. The SYSTEM_PROMPT
      bans them; the auditor enforces the ban.
    """
    if not isinstance(text, str) or not text.strip():
        return 0.0, {"empty": True}
    low = text.lower()
    nums = _NUM_RE.findall(text)
    n_nums = len(nums)
    cited = {t for t in _PAYLOAD_FIELD_TOKENS if t in low}
    n_cited = len(cited)
    hedges = [h for h in _BANNED_HEDGES if h in low]
    n_hedge = len(hedges)
    # 50 base, +6 per number (cap 30), +5 per cited field (cap 25),
    # -8 per hedge. Clamp 0-100. A clean key with 4 numbers + 3 cited
    # fields + 0 hedges scores ~90; a vague 0-number key with 2 hedges
    # scores ~34.
    score = 50 + min(30, 6 * n_nums) + min(25, 5 * n_cited) - 8 * n_hedge
    return max(0.0, min(100.0, float(score))), {
        "n_numbers": n_nums,
        "n_fields_cited": n_cited,
        "fields": sorted(cited),
        "n_hedges": n_hedge,
        "hedges": hedges,
    }


def audit_reasoning_breakdown(rb: dict) -> tuple[float, dict]:
    """Aggregate audit across the 5 required keys. Avg of present keys.
    Returns (avg_score, per_key_detail)."""
    keys = ("technicals", "macro", "news_flow", "sentiment", "prior_call_check")
    per_key = {}
    scores = []
    for k in keys:
        sc, det = _audit_key((rb or {}).get(k, ""))
        per_key[k] = {"score": round(sc, 1), **det}
        scores.append(sc)
    avg = sum(scores) / len(scores) if scores else 0.0
    return round(avg, 2), per_key


def _upsert_score(sb, analysis_id: int, dimension: str, horizon_days: int,
                  predicted, actual, score: float, delta: float, notes: str = "",
                  stated_confidence=None, prediction_date=None):
    """Upsert a prediction_scores row and, when the caller knows the
    confidence the model stated at call time, also upsert a paired
    calibration_log row capturing the (stated_confidence, realized_score)
    pair for that prediction. The calibration table is the spine for
    the per-dim "stated vs realized" scatter on the accuracy page and
    feeds the paper-trader's confidence-recalibration step (map raw
    confidence to a calibrated number before applying the entry gate).

    stated_confidence + prediction_date are paired: both must be
    provided for the calibration row to be written. A None on either
    is a soft-skip with no log row, so existing call sites that have
    not yet been wired keep working unchanged. The calibration upsert
    is wrapped in its own try/except so a constraint failure (e.g. a
    pre-existing duplicate during a re-grade) cannot break the score
    upsert it shadows.
    """
    res = sb.table("prediction_scores").upsert({
        "analysis_id": analysis_id,
        "dimension": dimension,
        "horizon_days": horizon_days,
        "predicted": predicted,
        "actual": actual,
        "score": float(score),
        "delta": float(delta),
        "notes": notes,
    }, on_conflict="analysis_id,dimension,horizon_days").execute()

    if stated_confidence is None or prediction_date is None:
        return
    ps_id = None
    if getattr(res, "data", None):
        ps_id = (res.data[0] or {}).get("id")
    if ps_id is None:
        try:
            existing = sb.table("prediction_scores").select("id").eq(
                "analysis_id", analysis_id
            ).eq("dimension", dimension).eq("horizon_days", horizon_days).limit(1).execute()
            if existing.data:
                ps_id = existing.data[0].get("id")
        except Exception:
            pass
    if ps_id is None:
        return
    pdate = prediction_date
    if hasattr(pdate, "date"):
        pdate = pdate.date()
    try:
        sb.table("calibration_log").upsert({
            "prediction_score_id": ps_id,
            "dimension": dimension,
            "stated_confidence": float(stated_confidence),
            "realized_score": float(score),
            "prediction_date": str(pdate),
        }, on_conflict="prediction_score_id").execute()
    except Exception as e:
        print(f"  calibration_log upsert skip ({dimension}): {str(e)[:120]}")


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

            # ----- Insight quality audit (horizon 0, scored immediately) -----
            # Pure text-quality signal: did the model cite numbers + payload
            # fields and avoid banned hedges in its reasoning_breakdown?
            # Catches the failure mode where every directional dim is hit-
            # or-miss noise but the prose around it stays honestly-shaped.
            rb = raw.get("reasoning_breakdown") or {}
            iq_score, iq_detail = audit_reasoning_breakdown(rb)
            _upsert_score(sb, aid, "insight_quality", 0,
                          {"keys": list(rb.keys())},
                          {"per_key": iq_detail},
                          iq_score, 0,
                          notes=f"avg text quality across reasoning_breakdown keys")

            # ----- Direction + Range (1d horizon) -----
            # Session-anchored: graded the same day once the target session
            # has closed (the 17:00 IST grader pass scores the morning call
            # against that day's actual close). _session_bounds returns None
            # while the call is still in flight, so no age gate is needed.
            nifty_anchor = _session_bounds("^NSEI", run_at)
            if nifty_anchor:
                last_close, next_close, target_d = nifty_anchor
                nifty_outlook = raw.get("nifty_outlook") or {}
                pred_dir = nifty_outlook.get("direction", "")
                pred_rng = _parse_range(nifty_outlook.get("range", ""))
                stated_conf = nifty_outlook.get("confidence")

                score, delta = grade_direction(pred_dir, last_close, next_close)
                _upsert_score(sb, aid, "direction_1d", 1,
                              {"direction": pred_dir}, {"pct": delta},
                              score, delta,
                              notes=f"target session {target_d}",
                              stated_confidence=stated_conf,
                              prediction_date=run_at)
                if pred_rng:
                    rscore, rdelta = grade_range(pred_rng, next_close)
                    _upsert_score(sb, aid, "range_1d", 1,
                                  {"range": list(pred_rng)},
                                  {"close": next_close}, rscore, rdelta,
                                  notes=f"target session {target_d}",
                                  stated_confidence=stated_conf,
                                  prediction_date=run_at)

                # ----- Market mood (bull / bear / neutral on NIFTY 1d) -----
                # Same horizon-scaled flat band as direction_1d. Mood maps
                # bull -> up, bear -> down, neutral -> sideways and runs
                # through the shared grade_direction logic so it sits on
                # the same scale as the rest of the 1d direction dims.
                mood = (raw.get("market_mood") or "").strip().lower()
                if mood in ("bull", "bear", "neutral"):
                    mapped = {"bull": "up", "bear": "down", "neutral": "sideways"}[mood]
                    mscore, mdelta = grade_direction(mapped, last_close, next_close)
                    _upsert_score(sb, aid, "market_mood_1d", 1,
                                  {"mood": mood}, {"pct": mdelta},
                                  mscore, mdelta,
                                  notes=f"NIFTY 1d move {mdelta:+.2f}% on {target_d} vs mood {mood}")

            # ----- Sensex direction + range (1d) -----
            sensex_anchor = _session_bounds("^BSESN", run_at)
            if sensex_anchor:
                s_last, s_next, s_target = sensex_anchor
                sensex_outlook = raw.get("sensex_outlook") or {}
                s_dir = sensex_outlook.get("direction", "")
                s_rng = _parse_range(sensex_outlook.get("range", ""))
                s_conf = sensex_outlook.get("confidence")
                if s_dir:
                    sscore, sdelta = grade_direction(s_dir, s_last, s_next)
                    _upsert_score(sb, aid, "sensex_direction_1d", 1,
                                  {"direction": s_dir}, {"pct": sdelta},
                                  sscore, sdelta,
                                  notes=f"target session {s_target}",
                                  stated_confidence=s_conf,
                                  prediction_date=run_at)
                if s_rng:
                    srscore, srdelta = grade_range(s_rng, s_next)
                    _upsert_score(sb, aid, "sensex_range_1d", 1,
                                  {"range": list(s_rng)},
                                  {"close": s_next}, srscore, srdelta,
                                  notes=f"target session {s_target}",
                                  stated_confidence=s_conf,
                                  prediction_date=run_at)

            # ----- NIFTY multi-day direction (5d, 20d): trend, more signal -----
            for h, key in ((5, "nifty_5d_outlook"), (20, "nifty_20d_outlook")):
                if age < h + 1:
                    continue
                base = _close_on_or_after("^NSEI", run_at)
                later = _close_n_sessions_later("^NSEI", run_at, h)
                pdir = (raw.get(key) or {}).get("direction", "")
                if pdir and base and later:
                    msc, mdl = grade_direction(pdir, base, later,
                                               flat=DIRECTION_FLAT.get(h, 0.4))
                    _upsert_score(sb, aid, f"direction_{h}d", h,
                                  {"direction": pdir}, {"pct": mdl}, msc, mdl)

            # ----- Volatility regime (next ~5 sessions) -----
            if age >= 6:
                vcall = (raw.get("volatility_regime") or {}).get("call", "")
                if vcall:
                    ratio = _vol_regime_ratio(run_at, 5)
                    if ratio is not None:
                        vsc = grade_vol_regime(vcall, ratio)
                        _upsert_score(sb, aid, "vol_regime_5d", 5,
                                      {"call": vcall}, {"realized_ratio": round(ratio, 3)},
                                      vsc, round(ratio - 1, 3))

            # ----- Short-term picks (7d, 14d, 30d) -----
            # Scored as avg alpha vs NIFTY over the horizon. The aggregate
            # short_pick_{h}d dim stays so historical scores remain
            # comparable. Stratified-by-conviction dims short_pick_A_7d,
            # short_pick_B_7d, short_pick_C_7d expose whether the A/B/C
            # tiering is real signal: if A picks consistently out-alpha
            # C picks the model knows what it knows; if A/B/C track
            # together the model is bullshitting conviction and the
            # feedback loop should punish it.
            for h in (7, 14, 30):
                if age < h + 1:
                    continue
                picks = raw.get("short_term_picks", []) or []
                deltas = []
                ticker_results = []
                by_tier: dict[str, list[tuple[str, float]]] = {"A": [], "B": [], "C": []}
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
                                            "nifty_pct": nifty_pct, "alpha": alpha,
                                            "conviction": (p.get("conviction") or "").upper()})
                    tier = (p.get("conviction") or "").upper()
                    if tier in by_tier:
                        by_tier[tier].append((tk, alpha))
                if deltas:
                    avg_alpha = sum(deltas) / len(deltas)
                    # score: +5% alpha = 100, 0 = 50, -5% = 0
                    score = max(0, min(100, 50 + avg_alpha * 10))
                    _upsert_score(sb, aid, f"short_pick_{h}d", h,
                                  {"picks": [p.get("ticker") for p in picks[:5]]},
                                  {"results": ticker_results},
                                  score, avg_alpha,
                                  notes=f"avg alpha vs NIFTY: {avg_alpha:+.2f}%")
                    # Only emit per-tier dims when there are picks of that
                    # tier on this day; the per-day dedup in
                    # compute_summaries will still average correctly across
                    # days even when some days are missing a tier.
                    if h == 7:
                        for tier in ("A", "B", "C"):
                            items = by_tier[tier]
                            if not items:
                                continue
                            t_alphas = [a for _t, a in items]
                            t_avg = sum(t_alphas) / len(t_alphas)
                            t_score = max(0, min(100, 50 + t_avg * 10))
                            _upsert_score(sb, aid, f"short_pick_{tier}_7d", 7,
                                          {"picks": [t for t, _a in items]},
                                          {"alphas": t_alphas}, t_score, t_avg,
                                          notes=f"tier-{tier} avg alpha vs NIFTY: {t_avg:+.2f}% n={len(items)}")

            # ----- Short pick target/SL hit (did it hit target before stop) -----
            if age >= 11:
                picks = raw.get("short_term_picks", []) or []
                tp_scores = []
                tp_results = []
                for p in picks[:5]:
                    tk = p.get("ticker")
                    if not tk:
                        continue
                    sc = grade_pick_tp_sl(tk, run_at, p.get("entry"),
                                          p.get("target"), p.get("stop_loss"), 10)
                    if sc is None:
                        continue
                    tp_scores.append(sc)
                    tp_results.append({"ticker": tk, "score": sc,
                                        "target": p.get("target"), "stop_loss": p.get("stop_loss")})
                if tp_scores:
                    avg_tp = sum(tp_scores) / len(tp_scores)
                    _upsert_score(sb, aid, "pick_tp_sl", 10,
                                  {"picks": [r["ticker"] for r in tp_results]},
                                  {"results": tp_results}, avg_tp, 0,
                                  notes=f"target-before-stop hit score across {len(tp_scores)} picks")

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

            # ----- Long pick target/SL hit (interim ~60-session OHLC walk) -----
            # Long targets are months out, so 180d alpha alone leaves the
            # target/stop calls ungraded for half a year. Grade the journey:
            # did the target or the thesis-break stop come first over ~60
            # sessions? Neither yet -> partial credit by progress toward target.
            if age >= 61:
                lpicks = raw.get("long_term_picks", []) or []
                lt_scores, lt_results = [], []
                for p in lpicks[:5]:
                    tk = p.get("ticker")
                    if not tk:
                        continue
                    sc = grade_pick_tp_sl(tk, run_at, p.get("entry_zone"),
                                          p.get("target"), p.get("stop_loss"), 60)
                    if sc is None:
                        continue
                    lt_scores.append(sc)
                    lt_results.append({"ticker": tk, "score": sc,
                                        "target": p.get("target"),
                                        "stop_loss": p.get("stop_loss")})
                if lt_scores:
                    avg_lt = sum(lt_scores) / len(lt_scores)
                    _upsert_score(sb, aid, "long_pick_tp_sl", 60,
                                  {"picks": [r["ticker"] for r in lt_results]},
                                  {"results": lt_results}, avg_lt, 0,
                                  notes=f"long target-before-stop over 60 sessions, {len(lt_scores)} picks")

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

            # ----- Holding verdict target/SL hit (~20-session OHLC walk) -----
            # The verdict's target/stop are real, scoreable levels too. Did the
            # holding reach its take-profit target before its thesis-break stop
            # over ~20 sessions? entry defaults to the close on the prediction
            # day (current_price is not stored on the verdict).
            if age >= 21:
                verdicts = raw.get("portfolio_verdicts", []) or []
                vt_scores, vt_results = [], []
                for vd in verdicts:
                    tk = vd.get("ticker")
                    if not tk:
                        continue
                    sc = grade_pick_tp_sl(tk, run_at, None,
                                          vd.get("target"), vd.get("stop_loss"), 20)
                    if sc is None:
                        continue
                    vt_scores.append(sc)
                    vt_results.append({"ticker": tk, "score": sc,
                                        "verdict": vd.get("verdict"),
                                        "target": vd.get("target"),
                                        "stop_loss": vd.get("stop_loss")})
                if vt_scores:
                    avg_vt = sum(vt_scores) / len(vt_scores)
                    _upsert_score(sb, aid, "verdict_tp_sl", 20,
                                  {"verdicts": [r["ticker"] for r in vt_results]},
                                  {"results": vt_results}, avg_vt, 0,
                                  notes=f"holding target-before-stop over 20 sessions, {len(vt_scores)} holdings")

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

            # ----- Sector outlooks (1d direction per NSE sector index) -----
            # Same horizon-scaled grade_direction used for NIFTY. Aggregated
            # to one avg-direction sample per prediction-day so the per-day
            # dedup in compute_summaries holds.
            _SECTOR_YF = {
                "BANK": "^NSEBANK", "IT": "^CNXIT", "AUTO": "^CNXAUTO",
                "PHARMA": "^CNXPHARMA", "FMCG": "^CNXFMCG",
                "ENERGY": "^CNXENERGY", "METAL": "^CNXMETAL",
                "REALTY": "^CNXREALTY", "MEDIA": "^CNXMEDIA",
                # ^CNXFINANCE 404s on yfinance; NIFTY_FIN_SERVICE.NS is the
                # working alias (same mapping as market_context.SECTOR_SYMBOLS).
                "FINSERV": "NIFTY_FIN_SERVICE.NS",
            }
            souts = raw.get("sector_outlooks", []) or []
            if souts:
                s_scores, s_results = [], []
                sr_scores, sr_results = [], []
                for so in souts:
                    sname = (so.get("sector") or "").strip().upper()
                    yf_sym = _SECTOR_YF.get(sname)
                    if not yf_sym:
                        continue
                    anchor = _session_bounds(yf_sym, run_at)
                    if not anchor:
                        continue
                    last_close, next_close, _target = anchor
                    sc, delta = grade_direction(
                        so.get("direction") or "", last_close, next_close,
                        flat=DIRECTION_FLAT.get(1, 0.4))
                    s_scores.append(sc)
                    s_results.append({"sector": sname,
                                       "direction": so.get("direction"),
                                       "actual_pct": round(delta, 2),
                                       "score": sc})
                    # Per-sector range: same interval scoring as NIFTY range.
                    # Tightest band that still contains the close wins.
                    rng = _parse_range(so.get("range") or "")
                    if rng:
                        rsc, rdelta = grade_range(rng, next_close)
                        sr_scores.append(rsc)
                        sr_results.append({"sector": sname,
                                            "range": list(rng),
                                            "close": next_close,
                                            "score": rsc,
                                            "delta": rdelta})
                if s_scores:
                    avg_s = sum(s_scores) / len(s_scores)
                    _upsert_score(sb, aid, "sector_dir_1d", 1,
                                  {"sectors": [{"sector": r["sector"],
                                                "direction": r["direction"]}
                                               for r in s_results]},
                                  {"results": s_results}, avg_s, 0,
                                  notes=f"avg sector 1d direction across {len(s_scores)} sectors")
                if sr_scores:
                    avg_sr = sum(sr_scores) / len(sr_scores)
                    _upsert_score(sb, aid, "sector_range_1d", 1,
                                  {"sectors": [{"sector": r["sector"],
                                                "range": r["range"]}
                                               for r in sr_results]},
                                  {"results": sr_results}, avg_sr, 0,
                                  notes=f"avg sector 1d range across {len(sr_scores)} sectors")

            # ----- FII flow outlook (target-session FII cash net direction) -----
            # Graded against the actual FII cash net of the SAME target
            # session the direction call is about (the session anchor above).
            # Exact-date match only: walking forward to the next published
            # row would grade the call against a different session's flows.
            # If the row is not published yet at grade time, skip and let a
            # later pass score it. >500 cr threshold matches the prompt's
            # inflow/outflow deadband.
            if nifty_anchor:
                fco = raw.get("fii_flow_outlook") or {}
                pred = (fco.get("direction") or "").strip().lower()
                if pred in ("inflow", "outflow", "flat"):
                    try:
                        import requests as _rq
                        from datetime import date as _date
                        hist = _rq.get(
                            "https://fii-diidata.mrchartist.com/api/history-full",
                            headers={"User-Agent": "arcemx/1.0"}, timeout=12,
                        ).json()
                        target_str = _date.fromisoformat(
                            nifty_anchor[2]).strftime("%d-%b-%Y")
                        # API schema uses short keys: `d` for the
                        # session date (e.g. "17-Jun-2026") and `fn`
                        # for FII cash net in cr. The earlier code
                        # looked up `date` / `fii_net`, which silently
                        # returned None for every row, so actual_net
                        # stayed None and no score was ever upserted
                        # (zero scored fii_flow_1d rows over weeks of
                        # predictions). Keep tolerant fallbacks so a
                        # future schema flip back to long names still
                        # works without a code change.
                        actual_net = None
                        for row in hist:
                            row_date = row.get("d") or row.get("date")
                            if row_date == target_str:
                                actual_net = row.get("fn")
                                if actual_net is None:
                                    actual_net = row.get("fii_net")
                                break
                        if actual_net is None:
                            print(f"  fii_flow grade skip: no row for {target_str} in {len(hist)} API rows")
                        if actual_net is not None:
                            if pred == "inflow":
                                score = 100.0 if actual_net > 500 else (50.0 if -500 <= actual_net <= 500 else 0.0)
                            elif pred == "outflow":
                                score = 100.0 if actual_net < -500 else (50.0 if -500 <= actual_net <= 500 else 0.0)
                            else:  # flat
                                score = 100.0 if -500 <= actual_net <= 500 else 0.0
                            _upsert_score(sb, aid, "fii_flow_1d", 1,
                                          {"direction": pred,
                                           "expected_cash_net_cr": fco.get("expected_cash_net_cr")},
                                          {"actual_fii_cash_cr": actual_net},
                                          score, round(float(actual_net), 1),
                                          notes=f"actual FII cash net {actual_net:+.0f} cr vs call {pred}")
                    except Exception as e:
                        print(f"  fii_flow grade skip: {e}")

            # ----- Index pair (NIFTY vs BankNifty relative outperformer) -----
            if nifty_anchor:
                ip = raw.get("index_pair_outlook") or {}
                pred = (ip.get("outperformer") or "").strip().upper()
                if pred in ("NIFTY", "BANKNIFTY", "EVEN"):
                    bank_anchor = _session_bounds("^NSEBANK", run_at)
                    if bank_anchor:
                        n_l, n_n, _ = nifty_anchor
                        b_l, b_n, _ = bank_anchor
                        n_pct = (n_n - n_l) / n_l * 100
                        b_pct = (b_n - b_l) / b_l * 100
                        spread = b_pct - n_pct  # +ve = BANKNIFTY outperformed
                        if pred == "BANKNIFTY":
                            score = 100.0 if spread > 0.15 else (50.0 if abs(spread) < 0.15 else 0.0)
                        elif pred == "NIFTY":
                            score = 100.0 if spread < -0.15 else (50.0 if abs(spread) < 0.15 else 0.0)
                        else:  # EVEN
                            score = 100.0 if abs(spread) < 0.15 else 0.0
                        _upsert_score(sb, aid, "index_pair_1d", 1,
                                      {"outperformer": pred},
                                      {"actual_spread_pct": round(spread, 3),
                                        "nifty_pct": round(n_pct, 2),
                                        "banknifty_pct": round(b_pct, 2)},
                                      score, round(spread, 3),
                                      notes=f"BankNifty-NIFTY spread {spread:+.2f}% vs call {pred}")

            # ----- Cap pair (NIFTY vs MIDCAP150 large- vs mid-cap rotation) -----
            # Midcap pair runs noisier than the bank pair (broader basket,
            # heavier retail/DII flow). Deadband widened to 0.20 absolute %
            # to match.
            if nifty_anchor:
                cp = raw.get("cap_pair_outlook") or {}
                pred = (cp.get("outperformer") or "").strip().upper()
                if pred in ("NIFTY", "MIDCAP150", "EVEN"):
                    mid_anchor = _session_bounds("NIFTYMIDCAP150.NS", run_at)
                    if mid_anchor:
                        n_l, n_n, _ = nifty_anchor
                        m_l, m_n, _ = mid_anchor
                        n_pct = (n_n - n_l) / n_l * 100
                        m_pct = (m_n - m_l) / m_l * 100
                        spread = m_pct - n_pct  # +ve = MIDCAP150 outperformed
                        if pred == "MIDCAP150":
                            score = 100.0 if spread > 0.20 else (50.0 if abs(spread) < 0.20 else 0.0)
                        elif pred == "NIFTY":
                            score = 100.0 if spread < -0.20 else (50.0 if abs(spread) < 0.20 else 0.0)
                        else:  # EVEN
                            score = 100.0 if abs(spread) < 0.20 else 0.0
                        _upsert_score(sb, aid, "cap_pair_1d", 1,
                                      {"outperformer": pred},
                                      {"actual_spread_pct": round(spread, 3),
                                        "nifty_pct": round(n_pct, 2),
                                        "midcap150_pct": round(m_pct, 2)},
                                      score, round(spread, 3),
                                      notes=f"MIDCAP150-NIFTY spread {spread:+.2f}% vs call {pred}")

            # ----- Per-holding + per-wishlist 1-day direction + range -----
            # Schema fields holding_outlooks_1d / wishlist_outlooks_1d give a
            # per-stock next-day call (separate from the 7d verdict / signal).
            # Graded with the same horizon-scaled grade_direction (flat=0.4%
            # for 1d) and grade_range (interval, tightness-penalised) used
            # for NIFTY, so per-stock results sit on the same scale as the
            # index dims. Aggregated to one (avg_dir, avg_range) sample per
            # prediction-day per dim, matching how compute_summaries dedups.
            #
            # combined_stock_results collects EVERY per-stock range score
            # from holdings + wishlist so a single rolled-up stock_range_1d
            # dim can be upserted once all groups are processed. This is
            # the new "Stock Range (1d)" dim on the accuracy page: it
            # tracks stock-level range discipline as one number per day,
            # independent of which group each ticker belongs to.
            combined_stock_results: list[dict] = []
            for src_key, dir_dim, range_dim, label in (
                ("holding_outlooks_1d", "holding_outlook_dir_1d",
                 "holding_outlook_range_1d", "holding"),
                ("wishlist_outlooks_1d", "wishlist_outlook_dir_1d",
                 "wishlist_outlook_range_1d", "wishlist"),
            ):
                outlooks = raw.get(src_key, []) or []
                if not outlooks:
                    continue
                dir_scores, range_scores, results = [], [], []
                for o in outlooks:
                    tk = (o.get("ticker") or "").strip().upper()
                    if not tk:
                        continue
                    yf_tk = tk if tk.endswith(".NS") else f"{tk}.NS"
                    anchor = _session_bounds(yf_tk, run_at)
                    if not anchor:
                        continue
                    last_close, next_close, _target = anchor
                    dscore, delta = grade_direction(
                        o.get("direction") or "", last_close, next_close,
                        flat=DIRECTION_FLAT.get(1, 0.4))
                    dir_scores.append(dscore)
                    rng = _parse_range(o.get("range") or "")
                    rscore = None
                    rdelta = 0
                    if rng:
                        rscore, rdelta = grade_range(rng, next_close)
                        range_scores.append(rscore)
                    stock_row = {
                        "ticker": tk,
                        "direction": o.get("direction"),
                        "range": o.get("range"),
                        "actual_pct": round(delta, 2),
                        "dir_score": dscore,
                        "range_score": rscore,
                    }
                    results.append(stock_row)
                    if rscore is not None:
                        combined_stock_results.append({
                            "group": label, **stock_row
                        })
                if dir_scores:
                    avg_d = sum(dir_scores) / len(dir_scores)
                    _upsert_score(sb, aid, dir_dim, 1,
                                  {"outlooks": [{"ticker": r["ticker"],
                                                 "direction": r["direction"]}
                                                for r in results]},
                                  {"results": results}, avg_d, 0,
                                  notes=f"avg per-{label} 1d direction across {len(dir_scores)} names")
                if range_scores:
                    avg_r = sum(range_scores) / len(range_scores)
                    _upsert_score(sb, aid, range_dim, 1,
                                  {"outlooks": [{"ticker": r["ticker"],
                                                 "range": r["range"]}
                                                for r in results]},
                                  {"results": results}, avg_r, 0,
                                  notes=f"avg per-{label} 1d range across {len(range_scores)} names")

            # ----- Combined stock-level range discipline (1d) -----
            # New rolled-up dim that averages every per-stock range score
            # from holdings + wishlist into ONE per-analysis sample. Lets
            # the accuracy page surface "is the model tight on individual
            # stock bands" as a single trackable line, independent of
            # which group each ticker belongs to. holding_outlook_range_1d
            # and wishlist_outlook_range_1d remain as the per-group split;
            # this dim is the union.
            if combined_stock_results:
                cs_scores = [r["range_score"] for r in combined_stock_results
                             if isinstance(r.get("range_score"), (int, float))]
                if cs_scores:
                    avg_cs = sum(cs_scores) / len(cs_scores)
                    _upsert_score(sb, aid, "stock_range_1d", 1,
                                  {"outlooks": [{"ticker": r["ticker"],
                                                 "group": r["group"],
                                                 "range": r["range"]}
                                                for r in combined_stock_results]},
                                  {"results": combined_stock_results},
                                  avg_cs, 0,
                                  notes=f"avg per-stock 1d range across {len(cs_scores)} names (holdings + wishlist combined)")

            print(f"  graded analysis {aid} ({age}d old)")
        except Exception as e:
            print(f"  fail analysis {row.get('id')}: {e}")

    print("Done grading.")


def compute_summaries(windows=(7, 30, 90, 180, 365, 1095, 1825, 99999)):
    """Compute accuracy summaries per dimension per window.

    Windowed by the prediction's run_at (when the call was MADE), NOT by
    scored_at: grade_all re-scores the full lookback on every run, so scored_at
    bunches all of history at "today" and would make the 7d / 30d / 90d windows
    return identical sets. We therefore join each score to its analysis run_at.

    Samples are also collapsed to one per prediction-DAY per dimension: several
    analyses can run on the same date (daily cron + manual syncs) and would
    otherwise count as several near-identical samples, inflating n and letting
    a single day dominate. sample_size below is distinct prediction-days.
    """
    sb = _sb()
    # PostgREST caps any single response at max_rows (1000 on this project)
    # no matter what .limit() asks for, so page with .range() until a short
    # page arrives. A silent 1000-row cap here would compute summaries on
    # an arbitrary subset once history grows past ~5 weeks.
    scores: list[dict] = []
    off = 0
    while True:
        page = sb.table("prediction_scores").select(
            "dimension,score,delta,predicted,analysis_id"
        ).order("id", desc=False).range(off, off + 999).execute().data or []
        scores.extend(page)
        if len(page) < 1000:
            break
        off += 1000

    # analysis_id -> run_at (chunked to keep the in_() filter small).
    ids = list({r["analysis_id"] for r in scores if r.get("analysis_id") is not None})
    run_at_by_id: dict[int, datetime] = {}
    for i in range(0, len(ids), 200):
        ar = sb.table("analysis").select("id,run_at").in_(
            "id", ids[i:i + 200]).execute().data or []
        for a in ar:
            try:
                run_at_by_id[a["id"]] = datetime.fromisoformat(
                    a["run_at"].replace("Z", "+00:00"))
            except Exception:
                pass

    now = datetime.now(timezone.utc)
    for window in windows:
        cutoff = now - timedelta(days=window)
        # dim -> prediction-date -> list of score rows on that date
        by_dim_date: dict[str, dict[str, list[dict]]] = {}
        for r in scores:
            ra = run_at_by_id.get(r.get("analysis_id"))
            if ra is None or ra < cutoff:
                continue
            d = ra.strftime("%Y-%m-%d")
            by_dim_date.setdefault(r["dimension"], {}).setdefault(d, []).append(r)

        for dim, by_date in by_dim_date.items():
            day_scores, day_deltas, all_items = [], [], []
            for _d, items in by_date.items():
                s = [it["score"] for it in items if it.get("score") is not None]
                dl = [it["delta"] for it in items if it.get("delta") is not None]
                if not s:
                    continue
                day_scores.append(sum(s) / len(s))  # one sample per day
                if dl:
                    day_deltas.append(sum(dl) / len(dl))
                all_items.extend(items)
            if not day_scores:
                continue
            avg_score = sum(day_scores) / len(day_scores)
            avg_delta = sum(day_deltas) / len(day_deltas) if day_deltas else 0
            bias = {}
            if dim.startswith("direction"):
                # bull-tilt = avg delta positive when calling up
                bias = {"avg_delta_pct": round(avg_delta, 3)}
            elif dim.startswith("range"):
                # A high range hit rate is only meaningful if the predicted
                # band is tight. Record the average band width as a % of its
                # midpoint so a 97% hit rate on a +/-5% band reads honestly.
                widths = []
                for it in all_items:
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
                "sample_size": len(day_scores),
                "bias": bias,
            }).execute()
    print("Summaries computed.")


def _embed_new_predictions() -> None:
    """Incremental Phase 1 RAG: embed any prediction_scores rows that
    do not yet have a matching prediction_embeddings row. Called once
    per grader pass right after compute_summaries. Soft-fails on
    import (sentence-transformers absent on the Render in-process
    fallback path) and on every Supabase / yfinance / model hiccup
    so the grader run itself is never blocked by embedding work.

    Costs ~5-10 seconds per day at steady state once backfill has
    run; cold first call after a model swap can take 1-2 minutes
    while the HuggingFace cache fills."""
    try:
        from analyzer.embed_backfill import run as _backfill_run
    except ImportError as e:
        print(f"Embedding pass skipped (sentence-transformers absent): {str(e)[:120]}")
        return
    try:
        _backfill_run(force=False)
    except Exception as e:
        print(f"Embedding pass skipped: {str(e)[:160]}")


def _grade_stock_analyses() -> None:
    """Run the deterministic Stock Analyst grader after the main pass.
    Soft-fails so the daily grader never blocks on a yfinance hiccup
    against a single ticker. Idempotent: only matured + ungraded rows
    are touched (graded_at IS NULL gate)."""
    try:
        from analyzer.stock_analyst_grader import grade_all as _stock_grade
    except ImportError as e:
        print(f"Stock Analyst grade skipped (import failed): {str(e)[:120]}")
        return
    try:
        _stock_grade()
    except Exception as e:
        print(f"Stock Analyst grade skipped: {str(e)[:160]}")


def _run_paper_trader() -> None:
    """Phase A paper trader hook. Order matters: mark_to_market first
    so any newly-closed slot frees sector cap / open count BEFORE
    eval_signals runs against the freshly-graded stock_analyses rows.
    Soft-fails so a yfinance/network blip in the paper trader cannot
    block the rest of the grader pipeline."""
    try:
        from analyzer.paper_trader import run_daily as _paper_run
    except ImportError as e:
        print(f"Paper trader skipped (import failed): {str(e)[:120]}")
        return
    try:
        _paper_run()
    except Exception as e:
        print(f"Paper trader skipped: {str(e)[:160]}")


if __name__ == "__main__":
    grade_all(lookback_days=90)
    compute_summaries()
    _grade_stock_analyses()
    _run_paper_trader()
    _embed_new_predictions()

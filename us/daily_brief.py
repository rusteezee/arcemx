"""US daily brief (blueprint 25, Phase 3): advisory verdicts, no trading.

Runs once before the US open. For each held ticker the LLM sees only data
dated before the session (market_context enforces the cut), returns a strict
JSON verdict, and the row is stored in `us_briefs` for us.grader to score
against real closes. Nothing in this pipeline can place an order.

Honesty rules baked in:
  - a brief is only produced before the session opens, so every stored call
    is a genuine pre-open prediction (a replayed timer after the open skips);
  - a stored brief is never overwritten, so a call cannot be revised after
    its outcome is known;
  - the prompt tells the model that liquid large caps are efficiently priced
    and that 50 to 58 percent confidence is the honest default;
  - the Telegram footer shows the model's hit rate next to two naive
    baselines, so the track record is visible from day one.

Run: python -m us.daily_brief [--dry] [--date YYYY-MM-DD]
  --dry  call the model and print the message, store and send nothing, and
         skip the pre-open guard (so it can be tested any time).
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

from analyzer.llm_router import _chain, _parse_json, _post
from us.brief_format import format_brief
from us.grader import track_record
from us.market_calendar import is_us_trading_day, next_trading_day, session_bounds_utc
from us.market_context import build_context
from us.notify import send_telegram

load_dotenv()

_LLM_MAX_ATTEMPTS = 3
_LLM_RETRY_DELAY_S = 15
_STANCES = {"hold", "add", "trim", "exit"}
_DIRECTIONS = {"up", "down"}
_MIN_CONF, _MAX_CONF = 50, 95
_LEVEL_BAND = 0.4  # stop within 40% below the price, target within 40% above
_PRIOR_LIMIT = 8
_FILINGS_DAYS = 14
_RECORD_ROWS = 500
_RECORD_COLUMNS = ("ticker,direction_1d,direction_5d,ret_1d_pct,ret_5d_pct,"
                   "correct_1d,correct_5d,prior_ret_1d_pct")
_REQUIRED = ("stance", "direction_1d", "direction_5d", "confidence", "stop_price",
             "target_price", "summary", "reasoning", "reasons_could_be_wrong")
_REASONING_KEYS = ("technicals", "macro", "events")

_SYSTEM_PROMPT = """You are a US equity analyst advising one retail investor on a stock they already hold. Each trading day, BEFORE the US open, you issue one verdict. A deterministic grader later compares it with the real closes, and your own track record is fed back to you.

ANTI-HINDSIGHT (non-negotiable):
Use ONLY the fields in the payload. All of them are dated before session_date. Do not use any knowledge of prices, news or events on or after session_date. If a figure is absent, say "no data" instead of guessing.

WHAT YOU PREDICT
- direction_1d: will the close of session_date be above ("up") or below ("down") last_close in the payload.
- direction_5d: will the close of the 5th session, counting session_date as the first, be above or below that same last_close.
- stance, what the holder should do now: hold, add, trim or exit. add requires direction_5d up. trim and exit require direction_5d down.
- confidence: integer 50 to 95, your probability that direction_5d is right. 50 is a coin flip.
- stop_price: a USD level below last_close where the bullish case is invalid. target_price: a USD level above last_close, the 5-session upside objective. Both are required for every stance.

CALIBRATION (read twice)
Large US-listed stocks are efficiently priced. A 5-session direction call is usually worth 50 to 58 percent. Go above 65 only with a specific cited catalyst AND agreement between trend, macro and flow data. If prior_self_predictions shows a 5-session hit rate under 50 percent over 8 or more calls, you have no demonstrated edge here: stay at or below 55 and prefer hold. A boring honest answer scores better than a bold wrong one. Do not invent conviction.

DATA NOTES
- Prices and technicals are USD per share. Position fields (value, gain) are in INR and include the FX move: use them only to judge size and gain, never as price levels.
- A next_earnings date inside the 5-session window is a binary event: widen the stop and cut confidence.
- Analyst estimates are intentionally absent. Do not quote figures you were not given.
- recent_filings are SEC filings already screened by keyword. Use them only if relevant.

OUTPUT: strict JSON only, no markdown, no prose outside the JSON:
{
  "stance": "hold" | "add" | "trim" | "exit",
  "direction_1d": "up" | "down",
  "direction_5d": "up" | "down",
  "confidence": 50-95 integer,
  "stop_price": float,
  "target_price": float,
  "summary": "1 or 2 plain-English sentences for a retail investor, no certainty language",
  "reasoning": {
    "technicals": "cite real numbers from the payload",
    "macro": "what SPY, QQQ, SOXX, VIX, dollar index, 10-year yield and USDINR say",
    "events": "earnings date, ex-dividend, recent filings, or 'none'"
  },
  "reasons_could_be_wrong": ["at least 2 concrete reasons, each citing a payload number"]
}
No em dashes. No "guaranteed", "definitely" or "will". Probabilistic language only."""


def _clean_text(value: str) -> str:
    return value.replace(chr(0x2014), ", ").replace(chr(0x2013), "-").strip()


def _num(value, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} is not a number: {value!r}") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} is not finite")
    return number


def _json_safe(value):
    """Recursively replace non-finite floats with None so the payload is
    valid JSON for Postgres (json.dumps would emit NaN, which it rejects)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def validate_brief(raw: dict, price: float) -> tuple[dict | None, str]:
    """Strict shape and sanity check. Returns (clean_dict, "") or (None,
    reason). The clean dict has coerced types and em dashes stripped."""
    if not isinstance(raw, dict):
        return None, "output is not an object"
    if raw.get("error"):
        return None, f"router error: {raw['error']}"
    for key in _REQUIRED:
        if key not in raw:
            return None, f"missing key: {key}"
    try:
        stance = str(raw["stance"]).strip().lower()
        d1 = str(raw["direction_1d"]).strip().lower()
        d5 = str(raw["direction_5d"]).strip().lower()
        confidence = int(round(_num(raw["confidence"], "confidence")))
        stop = _num(raw["stop_price"], "stop_price")
        target = _num(raw["target_price"], "target_price")
    except ValueError as e:
        return None, str(e)
    if stance not in _STANCES:
        return None, f"bad stance: {stance}"
    if d1 not in _DIRECTIONS or d5 not in _DIRECTIONS:
        return None, f"bad direction: {d1}/{d5}"
    if not _MIN_CONF <= confidence <= _MAX_CONF:
        return None, f"confidence {confidence} outside {_MIN_CONF}-{_MAX_CONF}"
    if not price * (1 - _LEVEL_BAND) < stop < price:
        return None, f"stop {stop} not within {_LEVEL_BAND:.0%} below last close {price}"
    if not price < target < price * (1 + _LEVEL_BAND):
        return None, f"target {target} not within {_LEVEL_BAND:.0%} above last close {price}"
    if stance == "add" and d5 != "up":
        return None, "stance add contradicts direction_5d down"
    if stance in ("trim", "exit") and d5 != "down":
        return None, f"stance {stance} contradicts direction_5d up"
    summary = raw["summary"]
    reasoning = raw["reasoning"]
    reasons = raw["reasons_could_be_wrong"]
    if not isinstance(summary, str) or not summary.strip():
        return None, "summary missing"
    if not isinstance(reasoning, dict) or not all(
            isinstance(reasoning.get(k), str) and reasoning[k].strip() for k in _REASONING_KEYS):
        return None, f"reasoning needs non-empty {', '.join(_REASONING_KEYS)}"
    if not isinstance(reasons, list) or sum(
            1 for r in reasons if isinstance(r, str) and r.strip()) < 2:
        return None, "reasons_could_be_wrong needs at least 2 entries"
    return {
        "stance": stance, "direction_1d": d1, "direction_5d": d5, "confidence": confidence,
        "stop_price": round(stop, 4), "target_price": round(target, 4),
        "summary": _clean_text(summary),
        "reasoning": {k: _clean_text(reasoning[k]) for k in _REASONING_KEYS},
        "reasons_could_be_wrong": [_clean_text(r) for r in reasons
                                   if isinstance(r, str) and r.strip()],
    }, ""


def _call_llm(messages: list[dict], price: float) -> tuple[dict, str]:
    """Bounded retry. Each retry rotates the model chain so it starts on a
    different model than the one that just returned a bad answer."""
    chain = _chain(None)
    last_err = "no attempt made"
    for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
        t0 = time.time()
        try:
            resp = _post(messages, chain, reasoning=True, timeout=300)
            clean, err = validate_brief(_parse_json(resp), price)
            if clean is not None:
                model = resp.get("model") or "unknown"
                print(f"  LLM ok in {time.time() - t0:.1f}s via {model} "
                      f"(attempt {attempt}/{_LLM_MAX_ATTEMPTS})")
                return clean, model
            last_err = err
        except Exception as e:
            last_err = f"{type(e).__name__}: {str(e)[:160]}"
        print(f"  attempt {attempt}/{_LLM_MAX_ATTEMPTS} failed: {last_err}")
        if attempt < _LLM_MAX_ATTEMPTS:
            chain = chain[1:] + chain[:1]
            time.sleep(_LLM_RETRY_DELAY_S * attempt)
    raise RuntimeError(f"LLM brief failed after {_LLM_MAX_ATTEMPTS} attempts: {last_err}")


def _prior_calls(sb, ticker: str) -> list[dict]:
    rows = (sb.table("us_briefs")
            .select("brief_date,direction_1d,direction_5d,confidence,ret_1d_pct,ret_5d_pct,"
                    "correct_1d,correct_5d")
            .eq("ticker", ticker).order("brief_date", desc=True).limit(30).execute().data or [])
    return [r for r in rows if r.get("correct_1d") is not None][:_PRIOR_LIMIT]


def _recent_filings(sb, ticker: str, session: date) -> list[dict]:
    since = (session - timedelta(days=_FILINGS_DAYS)).isoformat()
    return (sb.table("us_events").select("form,filed_date,material,material_reason")
            .eq("ticker", ticker).gte("filed_date", since)
            .order("filed_date", desc=True).execute().data or [])


def _messages(session: date, ticker: str, ctx: dict, holding: dict, weight_pct: float,
              filings: list[dict], prior: list[dict]) -> list[dict]:
    tk = ctx["tickers"][ticker]
    payload = {
        "instruction": (f"Issue the verdict for {ticker} for the session on {session.isoformat()}. "
                        f"Information cutoff: the close before {session.isoformat()}."),
        "session_date": session.isoformat(),
        "ticker": ticker,
        "last_close": tk["technicals"]["close"],
        "technicals": tk["technicals"],
        "next_earnings": tk["next_earnings"],
        "ex_dividend": tk["ex_dividend"],
        "market_context": ctx["market"],
        "position": {"weight_in_us_book_pct": round(weight_pct, 1),
                     "gain_pct_in_inr": holding.get("pnl_pct")},
        "recent_filings": filings,
        "prior_self_predictions": prior,
    }
    return [{"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(_json_safe(payload), default=str)}]


def _resolve_session(now: datetime, dry: bool, override: date | None) -> date | None:
    """The session this run briefs, or None to skip. Live runs only brief
    today's session and only before its open."""
    if override is not None:
        return override
    today = now.date()
    if dry:
        return today if is_us_trading_day(today) else next_trading_day(today)
    if not is_us_trading_day(today):
        print(f"us_brief: no US session on {today}, nothing to do")
        return None
    if now >= session_bounds_utc(today)[0]:
        print("us_brief: past the open, skipping so every stored call stays pre-open")
        return None
    return today


def run(dry: bool = False, session_override: date | None = None) -> int:
    now = datetime.now(timezone.utc)
    session = _resolve_session(now, dry, session_override)
    if session is None:
        return 0
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    holdings = (sb.table("us_holdings").select("*")
                .eq("user_id", os.environ["TELEGRAM_CHAT_ID"]).execute().data or [])
    if not holdings:
        print("us_brief: no US holdings synced yet")
        return 0
    done = {r["ticker"] for r in sb.table("us_briefs").select("ticker")
            .eq("brief_date", session.isoformat()).execute().data or []}
    todo = holdings if dry else [h for h in holdings if h["ticker"] not in done]
    if not todo:
        print(f"us_brief: already briefed {session}, nothing to do")
        return 0

    try:
        ctx = build_context([h["ticker"] for h in todo], session)
    except Exception as e:
        if not dry:
            send_telegram(f"US brief for {session.isoformat()} could not build market data: "
                          f"{str(e)[:160]}")
        raise
    total_value = sum(float(h.get("value_inr") or 0) for h in holdings) or 1.0
    rows: list[dict] = []
    failed: list[str] = []
    for h in todo:
        t = h["ticker"]
        price = ctx["tickers"][t]["technicals"]["close"]
        print(f"us_brief: {t} session {session} last_close {price}")
        try:
            messages = _messages(session, t, ctx, h,
                                 100.0 * float(h.get("value_inr") or 0) / total_value,
                                 _recent_filings(sb, t, session), _prior_calls(sb, t))
            clean, model = _call_llm(messages, price)
        except Exception as e:
            print(f"  {t} FAILED: {e}")
            failed.append(t)
            continue
        row = {"brief_date": session.isoformat(), "ticker": t, **clean,
               "price_at_brief": price,
               "prior_ret_1d_pct": ctx["tickers"][t]["technicals"].get("ret_1d_pct"),
               "context": _json_safe({"market": ctx["market"], "ticker": ctx["tickers"][t]}),
               "model_used": model}
        rows.append({**row, "next_earnings": ctx["tickers"][t]["next_earnings"]})
        if not dry:
            sb.table("us_briefs").insert(row).execute()

    record = track_record(sb.table("us_briefs").select(_RECORD_COLUMNS)
                          .order("brief_date", desc=True).limit(_RECORD_ROWS).execute().data or [])
    if rows:
        text = format_brief(session.isoformat(), rows, record, failed)
        print(text)
        if not dry:
            send_telegram(text)
    elif failed and not dry:
        send_telegram(f"US brief for {session.isoformat()} failed for: {', '.join(failed)}. "
                      "Check journalctl -u arcemx-us-brief.")
    if failed:
        raise RuntimeError(f"brief failed for {', '.join(failed)}")
    return len(rows)


if __name__ == "__main__":
    argv = sys.argv[1:]
    override = date.fromisoformat(argv[argv.index("--date") + 1]) if "--date" in argv else None
    run(dry="--dry" in argv, session_override=override)

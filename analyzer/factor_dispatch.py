"""Factor mining dispatch (blueprint 24, Plan C Phase 2).

Weekly (piggybacks specialist_eval.yml's Saturday cadence - no new
schedule invented). Prompts the LLM with the factor DSL schema plus real
grounded historical examples (never invented), asks for a handful of
candidate factors, backtests every one via analyzer.factor_lab, and logs
all of them to mined_factors regardless of outcome - a rejected factor
is real information too, not just winners.

Deflated Sharpe (blueprint 10's honesty layer) is computed ACROSS this
run's whole candidate batch, not per-factor inside factor_lab - the
number of trials in a proper deflation is the number of factors tried
together in one mining session, matching blueprint 10's own definition
("the parameter sweep itself IS the multiple-testing event").

A factor never trades real or paper capital - see factor_lab.py's own
module docstring. This script only ever writes to mined_factors.
"""
from __future__ import annotations

import json
import os
import random
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import create_client

from analyzer import factor_lab, metrics
from analyzer.backtest import HistCache
from analyzer.llm_router import _chain, _parse_json, _post
from analyzer.technical import compute_signals

load_dotenv()

# No dedicated override by default: None -> _chain() falls through to
# llm_router's own PRIMARY_MODEL/FALLBACK_CHAIN, giving this job the same
# real fallback redundancy the daily analysis has. A real first run
# (2026-09-01) picked nemotron here directly - since nemotron is ALSO the
# system's sole configured fallback, _chain() filtered it out of its own
# fallback list and left this job with zero redundancy. Only set
# OPENROUTER_FACTOR_PRIMARY if there's a specific reason to diverge from
# the system default, and pick something that ISN'T also the sole
# fallback.
FACTOR_MINING_PRIMARY = os.getenv("OPENROUTER_FACTOR_PRIMARY") or None

# Liquid large/mid-cap subset, same names blueprint 24's own smoke test
# used - real, tradeable, no data-thin small caps to bias the examples.
UNIVERSE = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
    "LT.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS", "TITAN.NS",
    "SUNPHARMA.NS", "ULTRACEMCO.NS", "NESTLEIND.NS", "WIPRO.NS", "NTPC.NS",
]
N_CANDIDATES = 5
MIN_TRADES_FOR_CANDIDATE = 30
LOOKBACK_DAYS = 450  # comfortably covers sma200's 200-session requirement


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


FACTOR_SYSTEM_PROMPT = f"""You are a QUANTITATIVE FACTOR RESEARCHER for an Indian equity
systematic strategy. Every buy-side prediction dimension this project's own LLM analyst has
tried so far has measurably FAILED against real graded outcomes (negative alpha, near-zero
hit rate on hundreds of real picks). Your job is different: propose TESTABLE, MECHANICAL
factor hypotheses that a backtest can score objectively - not a subjective call on where a
stock is headed.

A factor is a JSON rule, NOT free text and NOT code. Every condition MUST use ONLY these
field names (computed by a fixed technical-indicator function, nothing else exists):
{sorted(factor_lab.FACTOR_FIELDS)}

Allowed comparison operators: {sorted(factor_lab._OPS.keys())}
Each condition is either {{"field": ..., "op": ..., "value": <number>}} (compare against a
fixed number) or {{"field": ..., "op": ..., "value_field": <another field name>}} (compare
two computed fields against each other, e.g. last > sma200).

You will be shown REAL historical examples: a ticker, a date, its actual computed feature
values on that date, and what its price actually did over the following 10 sessions. Use
these to ground your hypotheses in real, observed patterns - do not invent examples of your
own reasoning that aren't backed by the data you were shown.

Return STRICT JSON only:
{{
  "factors": [
    {{
      "name": "short_snake_case_name",
      "hypothesis": "one or two sentences: what pattern, why you think it might predict a move",
      "side": "long" or "short",
      "horizon_days": <int, 1-120>,
      "combine": "AND" or "OR",
      "conditions": [{{"field": "...", "op": "...", "value": <number>}} or {{"field": "...", "op": "...", "value_field": "..."}}]
    }}
  ]
}}

Propose {N_CANDIDATES} factors. Vary the hypotheses genuinely - do not propose trivial
restatements of the same idea. Each must be mechanically checkable from the fields above
alone; do not reference news, sentiment, or anything not in the field list."""


def _real_examples(hist: HistCache, n: int = 15) -> list[dict]:
    """Real (ticker, date, signals, fwd_10d_return_pct) grounding
    examples, sampled from the same universe/window the backtest itself
    will use - never invented, never a different data source than what
    actually gets tested."""
    examples: list[dict] = []
    attempts = 0
    rng = random.Random(42)  # deterministic sample, not a claim about randomness quality
    tickers = list(UNIVERSE)
    rng.shuffle(tickers)
    for ticker in tickers:
        if len(examples) >= n:
            break
        df = hist.get(ticker)
        if df is None or len(df) < 220:
            continue
        dates = sorted(df.index)
        # Sample from the middle of the window so a real +10-session
        # forward return is always available to report.
        candidates_idx = list(range(210, len(dates) - 12))
        if not candidates_idx:
            continue
        rng.shuffle(candidates_idx)
        for idx in candidates_idx[:3]:
            attempts += 1
            asof_ts = dates[idx]
            sliced = df[df.index < asof_ts]
            sig = compute_signals(sliced)
            if not sig:
                continue
            fwd_close = float(df["Close"].iloc[idx + 10])
            last = sig.get("last")
            if not last:
                continue
            fwd_ret_pct = round((fwd_close - last) / last * 100.0, 2)
            examples.append({
                "ticker": ticker,
                "date": asof_ts.date().isoformat(),
                "signals": {k: (round(v, 2) if isinstance(v, float) else v)
                           for k, v in sig.items()},
                "fwd_10d_return_pct": fwd_ret_pct,
            })
            break
        if attempts > n * 8:
            break
    return examples[:n]


def propose_factors(hist: HistCache) -> list[dict]:
    examples = _real_examples(hist)
    chain = _chain(FACTOR_MINING_PRIMARY)
    print(f"factor_dispatch OpenRouter primary: {chain[0]} | fallbacks: {chain[1:]}")
    user_msg = ("Real grounding examples (ticker, date, computed signals, "
                "actual forward 10-session return):\n\n"
                + json.dumps(examples, default=str)
                + "\n\nPropose factors per the schema in your system prompt.")
    resp = _post(
        [{"role": "system", "content": FACTOR_SYSTEM_PROMPT},
         {"role": "user", "content": user_msg}],
        models=chain,
    )
    parsed = _parse_json(resp)
    return parsed.get("factors", []) if isinstance(parsed, dict) else []


def _log_factor(sb, factor: dict, bt: dict | None, sharpe_v: float | None,
                dsr_bundle: dict | None, status: str, notes: str) -> None:
    row = {
        "name": factor.get("name", "unnamed"),
        "hypothesis": factor.get("hypothesis"),
        "side": factor.get("side"),
        "horizon_days": factor.get("horizon_days"),
        "conditions": factor.get("conditions"),
        "combine": factor.get("combine"),
        "trade_count": (bt or {}).get("trade_count"),
        "win_rate_pct": (bt or {}).get("win_rate_pct"),
        "sharpe": round(sharpe_v, 3) if sharpe_v is not None else None,
        "dsr": round(dsr_bundle["dsr"], 4) if dsr_bundle else None,
        "status": status,
        "notes": notes,
    }
    sb.table("mined_factors").insert(row).execute()


def _notify_candidate(factor: dict, bt: dict, dsr_bundle: dict) -> None:
    """Best-effort Telegram ping when a factor clears the bar - a
    NOTIFICATION, not a promotion. The user still has to manually review
    and flip status to 'promoted' before it means anything for real
    trading (see factor_lab.py's module docstring)."""
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return
    try:
        import requests
        msg = (f"\U0001f9ea New factor candidate: `{factor.get('name')}`\n"
               f"{factor.get('hypothesis', '')}\n"
               f"Trades: {bt['trade_count']} | Win rate: {bt['win_rate_pct']}% | "
               f"DSR: {dsr_bundle['dsr']:.3f}\n"
               f"Review in mined_factors before wiring anything live.")
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": msg, "parse_mode": "Markdown"},
            timeout=10,
        )
    except Exception as e:
        print(f"  factor candidate notify skipped: {str(e)[:120]}")


def run() -> dict:
    sb = _sb()
    end = date.today()
    start = end - timedelta(days=LOOKBACK_DAYS)
    hist = HistCache(start, end)

    raw_candidates = propose_factors(hist)
    print(f"factor_dispatch: LLM proposed {len(raw_candidates)} candidates")

    evaluated: list[tuple[dict, dict, float]] = []  # (factor, bt, sharpe)
    rejected_count = 0
    for factor in raw_candidates:
        err = factor_lab.validate_factor(factor)
        if err:
            _log_factor(sb, factor, None, None, None, "rejected",
                       f"failed validation: {err}")
            rejected_count += 1
            continue
        bt = factor_lab.backtest_factor(factor, UNIVERSE, hist)
        if bt.get("error"):
            _log_factor(sb, factor, bt, None, None, "rejected",
                       f"backtest error: {bt['error']}")
            rejected_count += 1
            continue
        curve = metrics.equity_curve(bt["trades"])
        returns = metrics.daily_returns(curve, base_inr=52130.0)
        sharpe_v = metrics.sharpe(returns)
        evaluated.append((factor, bt, sharpe_v, returns))

    # Deflation across the whole batch - see module docstring for why
    # this happens here, not inside factor_lab.backtest_factor.
    trial_sharpes = [s for _, _, s, _ in evaluated]
    candidate_count = 0
    for factor, bt, sharpe_v, returns in evaluated:
        dsr_bundle = metrics.deflated_sharpe(returns, trial_sharpes)
        is_candidate = (
            dsr_bundle["dsr"] > 0
            and bt["trade_count"] >= MIN_TRADES_FOR_CANDIDATE
        )
        status = "candidate" if is_candidate else "rejected"
        notes = (f"trade_count={bt['trade_count']}, "
                f"min_required={MIN_TRADES_FOR_CANDIDATE}, "
                f"dsr={dsr_bundle['dsr']:.4f}")
        _log_factor(sb, factor, bt, sharpe_v, dsr_bundle, status, notes)
        if is_candidate:
            candidate_count += 1
            _notify_candidate(factor, bt, dsr_bundle)

    result = {
        "proposed": len(raw_candidates),
        "rejected_pre_backtest": rejected_count,
        "evaluated": len(evaluated),
        "candidates": candidate_count,
    }
    print(f"factor_dispatch: {result}")
    return result


if __name__ == "__main__":
    run()

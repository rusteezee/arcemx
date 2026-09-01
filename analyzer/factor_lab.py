"""Factor lab (blueprint 24, Plan C Phase 2): LLM-proposed factor
hypotheses, backtested with the machinery this project already has.

Every buy-side dimension measured so far has failed (see
KNOWLEDGE_BASE.md section 26/26b). The literature finds the same
weakness generally - LLMs are weak on direction, better used as
hypothesis generators validated statistically before capital risk
(AlphaAgent, SIGKDD 2026). This module is that validation step.

Reuses, does not reimplement: analyzer.technical.compute_signals() is
the feature schema, analyzer.backtest's HistCache/ShadowBook/
_open_shadow_trade/_mark_shadow_book run the simulation, analyzer.
paper_trader's friction/cost/sizing functions price it, analyzer.
geometry builds the entry/target/stop, and analyzer.metrics scores the
result. A factor NEVER trades real or paper capital - this only ever
writes to mined_factors, never to paper_trades/paper_signals.

Factor expressions are a constrained JSON DSL, never executable code -
a hard security boundary. See FACTOR_FIELDS for the only legal field
names and _OPS for the only legal comparisons.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from analyzer import geometry as vol_geometry
from analyzer.backtest import HistCache, ShadowBook, _mark_shadow_book, _open_shadow_trade
from analyzer.paper_trader import (
    LIQUIDITY_MIN_CR,
    MAX_NOTIONAL_PCT,
    RISK_PER_TRADE,
    SECTOR_CAP,
    _cost_dominated,
    _normalize_ticker,
    _sb,
    _ticker_sector_and_cap,
)
from analyzer.technical import compute_signals

# The only fields a factor condition may reference - exactly
# compute_signals()'s output keys. Anything else is rejected before a
# factor is ever evaluated.
FACTOR_FIELDS = {
    "last", "rsi", "macd", "macd_signal", "sma20", "sma50", "sma200",
    "bb_upper", "bb_lower", "chg_1d", "chg_5d", "chg_30d",
    "vol_avg_20", "vol_last", "support_20d", "resistance_20d",
    "dist_to_support_pct", "dist_to_resistance_pct", "atr_14",
    "expected_daily_move_pct",
}

_OPS = {
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
    "==": lambda a, b: a == b,
}

# Factors carry no LLM-stated confidence the way portfolio_verdicts or
# stock_analyst do - documented simplification for sizing purposes only,
# not a claim about the factor's real win probability. Set at MIN_CONF's
# floor so the same edge-formula shape used elsewhere still produces a
# sane, non-zero position size.
FACTOR_FIXED_CONFIDENCE = 60.0
MIN_HIST_BARS = 50  # compute_signals() itself requires >= 50 rows


def validate_factor(factor: dict) -> str | None:
    """Return an error string, or None if well-formed. Called before a
    factor is ever evaluated - a malformed or out-of-schema proposal is
    rejected here, not partway through a backtest."""
    if not isinstance(factor, dict):
        return "factor must be a dict"
    if factor.get("side") not in ("long", "short"):
        return "side must be 'long' or 'short'"
    horizon = factor.get("horizon_days")
    if not isinstance(horizon, int) or not (1 <= horizon <= 120):
        return "horizon_days must be an int between 1 and 120"
    if factor.get("combine") not in ("AND", "OR"):
        return "combine must be 'AND' or 'OR'"
    conditions = factor.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        return "conditions must be a non-empty list"
    for i, cond in enumerate(conditions):
        if not isinstance(cond, dict):
            return f"condition {i} must be a dict"
        field = cond.get("field")
        if field not in FACTOR_FIELDS:
            return f"condition {i}: unknown field {field!r}"
        op = cond.get("op")
        if op not in _OPS:
            return f"condition {i}: unknown op {op!r}"
        has_value = "value" in cond and isinstance(cond["value"], (int, float))
        value_field = cond.get("value_field")
        has_value_field = value_field is not None and value_field in FACTOR_FIELDS
        if not has_value and not has_value_field:
            return (f"condition {i}: must set a numeric 'value' or a "
                    f"'value_field' that is itself a legal field")
    return None


def evaluate_condition(cond: dict, signals: dict) -> bool:
    """One condition against one compute_signals() dict. Caller must
    have already validated the factor - this assumes field/op are legal
    and does not re-check."""
    left = signals.get(cond["field"])
    if left is None:
        return False
    if "value_field" in cond and cond["value_field"] is not None:
        right = signals.get(cond["value_field"])
    else:
        right = cond.get("value")
    if right is None:
        return False
    return _OPS[cond["op"]](left, right)


def _factor_signals_at(hist: HistCache, ticker: str, asof_date) -> dict | None:
    """compute_signals() as of a historical date - strictly before
    asof_date, same no-lookahead discipline as HistCache's own
    avg_turnover/realized_sigma methods."""
    df = hist.get(ticker)
    if df is None:
        return None
    sliced = df[df.index.date < asof_date]
    if len(sliced) < MIN_HIST_BARS:
        return None
    sig = compute_signals(sliced)
    return sig or None


def backtest_factor(factor: dict, universe: list[str], hist: HistCache,
                    portfolio_base: float = 52130.0) -> dict:
    """Walks `universe` across `hist`'s window, evaluating `factor` at
    every no-lookahead point and opening a ShadowBook trade through the
    exact same friction/geometry/cost path backtest.py's own evaluators
    use. Returns raw trade-level results - NOT deflated-Sharpe/PBO, that
    happens once across a whole mining session's candidates (see
    analyzer.factor_dispatch), since the number of trials in a proper
    deflation is the number of factors tried together, not one."""
    err = validate_factor(factor)
    if err:
        return {"error": err, "trades": []}

    book = ShadowBook()
    side = factor["side"]
    horizon_days = factor["horizon_days"]
    combine = factor["combine"]
    conditions = factor["conditions"]
    sector_cache: dict[str, tuple] = {}
    sb = _sb()

    # One combined, sorted date index across the whole universe so every
    # ticker gets evaluated on every date it has a bar for, oldest first -
    # mirrors run_backtest()'s single chronological event stream.
    all_dates: set = set()
    for ticker in universe:
        df = hist.get(ticker)
        if df is not None:
            all_dates.update(d.date() for d in df.index)
    for asof in sorted(all_dates):
        asof_dt = datetime.combine(asof, datetime.min.time()).replace(tzinfo=timezone.utc)
        _mark_shadow_book(book, hist, asof_dt)
        for ticker in universe:
            norm = _normalize_ticker(ticker)
            if book.has_open(ticker) or book.ticker_frozen(ticker, asof_dt):
                continue
            signals = _factor_signals_at(hist, ticker, asof)
            if not signals:
                continue
            matched = (all(evaluate_condition(c, signals) for c in conditions)
                      if combine == "AND"
                      else any(evaluate_condition(c, signals) for c in conditions))
            if not matched:
                continue

            intent_px = signals.get("last")
            if not intent_px or intent_px <= 0:
                continue
            sigma = hist.realized_sigma(ticker, asof)
            if sigma is None:
                continue
            target_px, stop_px = vol_geometry.volatility_scaled_barriers(
                intent_px, side, sigma, horizon_days)
            risk_per_share = abs(intent_px - stop_px)
            if risk_per_share <= 0:
                continue

            avg_turnover = hist.avg_turnover(ticker, asof)
            if avg_turnover is None or (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
                continue

            if ticker not in sector_cache:
                sector_cache[ticker] = _ticker_sector_and_cap(sb, ticker)
            sector, cap_tier = sector_cache[ticker]
            if sector and book.open_in_sector(sector) >= SECTOR_CAP:
                continue

            tgt_pct = abs(target_px - intent_px) / intent_px * 100.0
            stp_pct = abs(intent_px - stop_px) / intent_px * 100.0
            win_prob = FACTOR_FIXED_CONFIDENCE / 100.0
            edge_pct = tgt_pct * win_prob - stp_pct * (1.0 - win_prob)

            risk_budget = portfolio_base * RISK_PER_TRADE
            qty = max(1, min(int(risk_budget / risk_per_share),
                             int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)))

            if _cost_dominated(qty, intent_px, target_px, edge_pct, cap_tier,
                              avg_turnover, side):
                continue

            _open_shadow_trade(
                book, source_kind="mined_factor",
                source_run_id=factor.get("name", "unnamed"), ticker=ticker,
                entered_at=asof_dt, intent_px=intent_px, target_px=target_px,
                stop_px=stop_px, horizon_days=horizon_days, qty=qty,
                confidence=FACTOR_FIXED_CONFIDENCE, edge=edge_pct,
                sector=sector, cap_tier=cap_tier, avg_turnover=avg_turnover,
                hist=hist, side=side,
            )

    # Final pass: resolve whatever can be resolved with all data through today.
    _mark_shadow_book(book, hist, datetime.now(timezone.utc))

    closed = book.closed
    trade_count = len(closed)
    wins = sum(1 for t in closed if (t.get("net_pnl") or 0) > 0)
    win_rate_pct = (wins / trade_count * 100.0) if trade_count else 0.0
    total_net_pnl = sum((t.get("net_pnl") or 0.0) for t in closed)

    return {
        "error": None,
        "trade_count": trade_count,
        "win_rate_pct": round(win_rate_pct, 2),
        "total_net_pnl": round(total_net_pnl, 2),
        "still_open": len(book.open),
        "trades": closed,
    }


if __name__ == "__main__":
    # Standalone smoke test against a real, hand-written factor - not
    # LLM-proposed. Per blueprint 24's own Definition of Done: verify
    # backtest_factor() produces plausible real trades before the mining
    # loop (analyzer.factor_dispatch) ever generates a factor from an
    # LLM call.
    from datetime import date, timedelta as _td
    import json

    test_factor = {
        "name": "pullback_smoke_test",
        "hypothesis": "5-day pullback (chg_5d < -3%) while still above sma50 tends to bounce within 10 sessions",
        "side": "long",
        "horizon_days": 10,
        "combine": "AND",
        "conditions": [
            {"field": "chg_5d", "op": "<", "value": -3.0},
            {"field": "last", "op": ">", "value_field": "sma50"},
        ],
    }
    err = validate_factor(test_factor)
    print("validate_factor:", "OK" if err is None else f"FAIL: {err}")

    universe = [
        "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
        "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
        "LT.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS", "TITAN.NS",
        "SUNPHARMA.NS", "ULTRACEMCO.NS", "NESTLEIND.NS", "WIPRO.NS", "NTPC.NS",
    ]
    end = date.today()
    # sma200 needs 200 real trading sessions (~280+ calendar days) before
    # compute_signals() ever populates it - anything shorter silently
    # evaluates every sma200 condition to None -> False for the WHOLE
    # window, which looks exactly like "the factor never matches" rather
    # than an error. A caller referencing sma200 needs at least this much
    # runway; HistCache's own 35-day default buffer is sized for 20d
    # turnover, not this.
    start = end - _td(days=400)
    hist = HistCache(start, end)
    result = backtest_factor(test_factor, universe, hist)
    print(json.dumps({k: v for k, v in result.items() if k != "trades"}, indent=2))
    for t in result["trades"][:5]:
        print(" ", t["ticker"], t["entered_at"].date(), t["side"],
              "entry", round(t["fill_px"], 2), "exit", round(t.get("exit_px", 0), 2),
              t.get("exit_reason"), "net_pnl", round(t.get("net_pnl", 0), 2))

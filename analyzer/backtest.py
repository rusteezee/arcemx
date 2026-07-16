"""Backtest v2: replay the full analysis history through the live paper
trader's gate stack, as if it had been running since day 1.

Reuses paper_trader.py's exact thresholds and cost-model functions
(imported, not copied) so a future tune of MIN_CONF/MIN_EDGE_PCT/etc.
automatically reflects here. Does NOT touch paper_trader.py or write to
the live paper_trades/paper_signals tables. every simulated position
lives in an in-memory "shadow" book for the duration of one replay, and
only the final aggregate result (equity curve + trade list) is persisted,
to backtest_runs.

No-lookahead-bias discipline (the one way a backtest lies to you):
  - Every gate decision uses only data dated on/before the pick's own
    run_at/requested_at: historical OHLCV sliced up to that date,
    calibration_log rows graded before that date, and a shadow trade/
    position book built by walking chronologically forward (never
    peeking at a shadow trade that "hasn't happened yet" in the replay).
  - Position sizing uses ONE portfolio_base resolved once at the start
    (today's real cost basis), not a compounding equity curve. Simpler,
    and keeps position sizes directly comparable to what live trades
    size today. A compounding v3 is a clearly separable future step.
  - Sector/cap-tier classification reads the live ticker_enrichment
    cache (today's sector/market-cap), not an as-of snapshot. sector
    rarely changes and cap-tier drifts slowly, so this is a documented
    approximation, not a lookahead leak that would flip gate outcomes.

Entry point: run_backtest() -> dict bundle (same shape as
metrics.compute_paper_metrics, plus a `trades` list and `params`).
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

from analyzer import calibration, metrics
from analyzer.paper_trader import (
    MIN_CONF,
    MIN_EDGE_PCT,
    MIN_RR,
    SECTOR_CAP,
    LIQUIDITY_MIN_CR,
    RISK_PER_TRADE,
    MAX_NOTIONAL_PCT,
    TICKER_FREEZE_LOSSES,
    TICKER_FREEZE_LOOKBACK_DAYS,
    TICKER_FREEZE_DURATION_DAYS,
    OUTLOOK_MIN_CONF,
    OUTLOOK_MIN_EDGE_PCT,
    CALIBRATION_LOOKBACK_DAYS,
    CALIBRATION_MIN_PAIRS,
    REGIME_GATE_ON,
    REGIME_HALF_MULT,
    EARNINGS_BLACKOUT_SESSIONS,
    BREAKER_DD_PCT,
    BREAKER_REARM_PCT,
    BREAKER_MIN_TRADES,
    _weekday_sessions_between,
    _apply_slippage,
    _broker_friction,
    _conf_from_winprob,
    _parse_inr,
    _parse_range_band,
    _resolve_portfolio_base,
    _ticker_sector_and_cap,
)
from analyzer.regime import regime_from_history

load_dotenv()


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


# ---------------------------------------------------------------------------
# Historical price cache: one yfinance download per ticker for the whole
# replay window, sliced locally for every as-of-date lookup. Avoids one
# network call per (ticker, signal) pair and guarantees every lookup for
# a given ticker sees the same bars. auto_adjust=False throughout (raw
# prices) so fills/targets/stops match the real quoted INR the model's
# picks were written against, not split-adjusted values.
# ---------------------------------------------------------------------------
class HistCache:
    def __init__(self, start: date, end: date):
        # 35-day lookback buffer so the earliest signal's 20d turnover
        # window has real data behind it.
        self.start = start - timedelta(days=35)
        self.end = end + timedelta(days=1)
        self._cache: dict[str, Any] = {}
        self._earnings_cache: dict[str, Any] = {}

    def get(self, ticker: str):
        if ticker in self._cache:
            return self._cache[ticker]
        # The regime gate's trend indicator needs a real 200-session SMA
        # even at the replay's very first event - the class's normal
        # 35-day buffer (sized for 20d turnover lookback) is nowhere near
        # enough. 320 calendar days comfortably covers 200 NSE trading
        # sessions through weekends/holidays.
        start = (self.start - timedelta(days=285)
                if ticker in ("^NSEI", "^INDIAVIX") else self.start)
        try:
            h = yf.download(
                ticker,
                start=start.isoformat(),
                end=self.end.isoformat(),
                interval="1d",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
            if h is not None and hasattr(h.columns, "nlevels") and h.columns.nlevels > 1:
                h = h.copy()
                h.columns = h.columns.get_level_values(0)
            if h is None or h.empty:
                h = None
        except Exception:
            h = None
        self._cache[ticker] = h
        return h

    def avg_turnover(self, ticker: str, asof: date, days: int = 20) -> float | None:
        h = self.get(ticker)
        if h is None or "Volume" not in h or "Close" not in h:
            return None
        window = h[h.index.date < asof].tail(days)
        turnover = (window["Volume"] * window["Close"]).dropna()
        if turnover.empty:
            return None
        return float(turnover.mean())

    def next_open(self, ticker: str, after: date) -> float | None:
        h = self.get(ticker)
        if h is None or "Open" not in h:
            return None
        for ts, row in h.iterrows():
            if ts.date() > after:
                v = row["Open"]
                if v == v and v > 0:
                    return float(v)
        return None

    def regime(self, asof: date) -> dict:
        """As-of market regime (blueprint 03), computed from ^NSEI/
        ^INDIAVIX bars strictly before `asof` - the same no-lookahead
        discipline as avg_turnover/next_open above, just for the regime
        gate instead of liquidity/fill data. ^NSEI/^INDIAVIX are fetched
        through this same cache (see get()'s wider start date for these
        two symbols), so a whole replay costs one download set for both,
        not one per event."""
        nifty = self.get("^NSEI")
        nifty_sliced = nifty[nifty.index.date < asof] if nifty is not None else None
        vix_value = None
        vix_h = self.get("^INDIAVIX")
        if vix_h is not None and "Close" in vix_h:
            vix_sliced = vix_h[vix_h.index.date < asof]["Close"].dropna()
            if not vix_sliced.empty:
                vix_value = float(vix_sliced.iloc[-1])
        return regime_from_history(nifty_sliced, vix_value, asof)

    def next_earnings_asof(self, ticker: str, asof: date) -> date | None:
        """As-of next-earnings date for the earnings-blackout gate
        (blueprint 07). Documented asymmetry vs the live path
        (paper_trader._next_earnings_date): yfinance's Ticker.calendar
        only ever shows genuinely UPCOMING events, which is exactly what
        a live call wants but useless for replaying a past date - there
        is no way to ask "what did the calendar say on 20 June" after
        the fact. Ticker.earnings_dates instead returns a DataFrame
        covering BOTH past (with Reported EPS filled) and future events,
        so this reconstructs what the live gate would have seen as
        "upcoming" at `asof` by taking the earliest event on/after it.
        This is the only way to get as-of-correct historical earnings
        dates from yfinance - not a shortcut, the live endpoint simply
        has no historical coverage at all. Cached once per ticker (not
        per event) same as get() above. Fails open (returns None) if
        the ticker has no earnings_dates data at all."""
        if ticker not in self._earnings_cache:
            try:
                df = yf.Ticker(ticker).earnings_dates
            except Exception:
                df = None
            self._earnings_cache[ticker] = df
        df = self._earnings_cache[ticker]
        if df is None or df.empty:
            return None
        try:
            dates = sorted({d.date() if hasattr(d, "date") else d for d in df.index})
        except Exception:
            return None
        for d in dates:
            if d >= asof:
                return d
        return None

    def bars_after(self, ticker: str, since: date, until: date):
        h = self.get(ticker)
        if h is None:
            return None
        window = h[(h.index.date > since) & (h.index.date <= until)]
        if window.empty:
            return None
        return window


# ---------------------------------------------------------------------------
# Shadow book: in-memory stand-in for the live paper_trades/paper_signals
# tables. Never touches the real DB.
# ---------------------------------------------------------------------------
class ShadowBook:
    def __init__(self):
        self.open: dict[str, dict] = {}   # ticker -> trade dict
        self.closed: list[dict] = []      # closed trade dicts

    def has_open(self, ticker: str) -> bool:
        return ticker in self.open

    def open_in_sector(self, sector: str | None) -> int:
        if not sector:
            return 0
        return sum(1 for t in self.open.values() if t.get("sector") == sector)

    def ticker_frozen(self, ticker: str, asof: datetime) -> bool:
        since = asof - timedelta(days=TICKER_FREEZE_LOOKBACK_DAYS)
        losses = [
            t for t in self.closed
            if t["ticker"] == ticker
            and (t.get("net_pnl") or 0) < 0
            and t.get("exit_at")
            and since <= t["exit_at"] <= asof
        ]
        if len(losses) < TICKER_FREEZE_LOSSES:
            return False
        latest_loss_at = max(t["exit_at"] for t in losses)
        return asof < latest_loss_at + timedelta(days=TICKER_FREEZE_DURATION_DAYS)


def _calibration_bias(calib_by_dim: dict[str, list[dict]], dim: str, asof: datetime) -> float:
    """As-of-date version of paper_trader._dim_confidence_bias: only uses
    calibration_log rows graded strictly before `asof`, so a signal never
    gets calibrated against feedback that hadn't happened yet."""
    since = asof - timedelta(days=CALIBRATION_LOOKBACK_DAYS)
    rows = [
        r for r in calib_by_dim.get(dim, [])
        if r["graded_at"] < asof and r["graded_at"] >= since
    ]
    if len(rows) < CALIBRATION_MIN_PAIRS:
        return 0.0
    stated = [r["stated_confidence"] for r in rows]
    realized = [r["realized_score"] for r in rows]
    gap = sum(stated) / len(stated) - sum(realized) / len(realized)
    return max(-25.0, min(25.0, gap))


_platt_pairs_cache: dict[str, dict[str, list[tuple[float, int]]]] = {}
_platt_fit_cache: dict[tuple[str, str], tuple[float, float] | None] = {}


def _platt_recalibrate(calib_by_dim: dict[str, list[dict]], dim: str, asof: datetime,
                       stated_conf: float) -> float | None:
    """As-of Platt recalibration (blueprint 04) mirroring
    analyzer.calibration.recalibrate, but reusing the calib_by_dim
    structure already preloaded once at the top of run_backtest instead
    of re-querying Supabase per event. Fits per-dim if that dim alone
    has >= calibration.MIN_PAIRS rows graded strictly before asof; else
    pools ALL dims into one global fit if the total has >= MIN_PAIRS;
    else None (caller falls back to the legacy bias debit). Cached per
    (dim, asof-date) so a replay day with many same-day events fits
    once, not once per event."""
    if not isinstance(stated_conf, (int, float)):
        return None
    day_key = asof.date().isoformat()
    if day_key not in _platt_pairs_cache:
        pairs_by_dim: dict[str, list[tuple[float, int]]] = {}
        for d, rows in calib_by_dim.items():
            pairs_by_dim[d] = [
                (r["stated_confidence"] / 100.0, 1 if r["realized_score"] >= 60 else 0)
                for r in rows if r["graded_at"] < asof
            ]
        _platt_pairs_cache[day_key] = pairs_by_dim
    cache_key = (dim, day_key)
    if cache_key not in _platt_fit_cache:
        _platt_fit_cache[cache_key] = calibration.fit_for_dimension(_platt_pairs_cache[day_key], dim)
    fit = _platt_fit_cache[cache_key]
    if fit is None:
        return None
    return calibration.apply(fit, float(stated_conf))


def _update_breaker(book: ShadowBook, portfolio_base: float, prev_tripped: bool) -> bool:
    """Drawdown circuit breaker (blueprint 08), backtest mirror. Mirrors
    paper_trader._breaker_state's arithmetic (current drawdown from the
    running peak, same denominator convention), but walked forward
    across the replay instead of reading a persisted metrics_snapshot
    row - hysteresis carries via prev_tripped, the caller's own running
    state through the events loop (no Telegram; the caller just counts
    circuit_breaker skips like any other skip reason)."""
    if len(book.closed) < BREAKER_MIN_TRADES:
        return False
    trades_for_metrics = [
        {**t, "exit_at": t["exit_at"].isoformat() if isinstance(t.get("exit_at"), datetime) else t.get("exit_at")}
        for t in book.closed
    ]
    curve = metrics.equity_curve(trades_for_metrics)
    if not curve:
        return False
    peak = curve[0][1]
    for _, v in curve:
        if v > peak:
            peak = v
    denom = portfolio_base + peak
    dd_pct = ((peak - curve[-1][1]) / denom * 100.0) if denom > 0 else 0.0
    if prev_tripped:
        return dd_pct >= BREAKER_REARM_PCT
    return dd_pct > BREAKER_DD_PCT


# ---------------------------------------------------------------------------
# Mark-to-market on the shadow book (mirrors paper_trader._mark_one /
# _close_trade, but reads cached historical bars instead of a live
# yfinance hit, and writes to the shadow book instead of Supabase).
# ---------------------------------------------------------------------------
def _close_shadow(book: ShadowBook, t: dict, exit_at: datetime, exit_ref_px: float, exit_reason: str) -> None:
    qty = t["qty"]
    fill_px = t["fill_px"]
    cap_tier = t.get("cap_tier", "small")
    avg_turnover = t.get("avg_turnover_inr") or 1e8

    sim_exit_fill, exit_slippage = _apply_slippage(exit_ref_px, qty, "sell", cap_tier, avg_turnover)
    sell_friction, stt_amt = _broker_friction(sim_exit_fill * qty, "sell")

    gross_pnl = (sim_exit_fill - fill_px) * qty
    buy_friction = t.get("brokerage") or 0.0
    buy_slippage = t.get("slippage_cost") or 0.0
    net_pnl = gross_pnl - (buy_friction + sell_friction) - (buy_slippage + exit_slippage)

    t.update({
        "exit_at": exit_at,
        "exit_px": sim_exit_fill,
        "exit_reason": exit_reason,
        "gross_pnl": gross_pnl,
        "brokerage": buy_friction + sell_friction,
        "stt": stt_amt,
        "slippage_cost": buy_slippage + exit_slippage,
        "net_pnl": net_pnl,
        "status": f"closed_{exit_reason}",
    })
    del book.open[t["ticker"]]
    book.closed.append(t)


def _mark_shadow_book(book: ShadowBook, hist: HistCache, asof: datetime) -> None:
    """Walk every shadow-open position and close it if target/stop/horizon
    resolved on or before `asof`. Same pessimistic same-bar ordering as
    live (stop wins ties)."""
    for ticker in list(book.open.keys()):
        t = book.open[ticker]
        entered_at = t["entered_at"]
        horizon_days = t["horizon_days"]
        expiry = entered_at + timedelta(days=horizon_days)
        bars = hist.bars_after(ticker, entered_at.date(), min(asof, expiry + timedelta(days=2)).date())
        if bars is None or not all(c in bars.columns for c in ("High", "Low", "Close")):
            continue
        for ts, row in bars.iterrows():
            bar_date = ts.date()
            bar_dt = datetime.combine(bar_date, datetime.min.time()).replace(tzinfo=timezone.utc)
            if bar_dt > asof:
                break
            high, low, close = float(row["High"]), float(row["Low"]), float(row["Close"])
            if low <= t["stop_px"]:
                _close_shadow(book, t, bar_dt, t["stop_px"], "stop")
                break
            if high >= t["target_px"]:
                _close_shadow(book, t, bar_dt, t["target_px"], "target")
                break
            if bar_dt >= expiry:
                _close_shadow(book, t, bar_dt, close, "horizon")
                break


# ---------------------------------------------------------------------------
# Gate evaluators. Same order/thresholds as paper_trader.py's live
# evaluators, reading shadow state + cached history instead of live
# Supabase/yfinance calls.
# ---------------------------------------------------------------------------
def _open_shadow_trade(book: ShadowBook, *, source_kind, source_run_id, ticker, entered_at,
                       intent_px, target_px, stop_px, horizon_days, qty, confidence,
                       edge, sector, cap_tier, avg_turnover, hist: HistCache,
                       conf_method: str | None = None) -> None:
    next_open = hist.next_open(ticker, entered_at.date())
    anchor = next_open if next_open else intent_px
    fill_px, slippage_cost = _apply_slippage(anchor, qty, "buy", cap_tier, avg_turnover or 1e8)
    buy_friction, _ = _broker_friction(fill_px * qty, "buy")
    book.open[ticker] = {
        "source_kind": source_kind, "source_run_id": source_run_id, "ticker": ticker,
        "entered_at": entered_at, "intent_px": intent_px, "fill_px": fill_px, "qty": qty,
        "target_px": target_px, "stop_px": stop_px, "horizon_days": horizon_days,
        "brokerage": buy_friction, "slippage_cost": slippage_cost,
        "confidence": confidence, "expected_edge_pct": edge,
        "sector": sector, "cap_tier": cap_tier, "avg_turnover_inr": avg_turnover,
        "status": "open", "conf_method": conf_method,
    }


def _eval_stock_analyst(row: dict, book: ShadowBook, hist: HistCache, sb, portfolio_base: float,
                        breaker_tripped: bool = False) -> str | None:
    sa_id = row["id"]
    ticker = row["ticker"]
    j = row.get("llm_json") or {}
    rating = j.get("rating")
    confidence = j.get("confidence")
    edge = j.get("expected_edge_pct")
    horizon = int(row.get("horizon_days") or j.get("horizon_days") or 30)
    asof = row["_asof"]

    if breaker_tripped:
        return "circuit_breaker"
    if rating != "buy":
        return "not_buy"
    if not isinstance(edge, (int, float)):
        return "pre_schema"
    if not isinstance(confidence, (int, float)) or confidence < MIN_CONF:
        return "low_conf"
    if edge < MIN_EDGE_PCT:
        return "low_edge"
    if book.has_open(ticker):
        return "already_open"
    if book.ticker_frozen(ticker, asof):
        return "ticker_freeze"

    bw = j.get("buy_window") or {}
    lo, hi = bw.get("target_price_low"), bw.get("target_price_high")
    intent_px = ((lo or 0) + (hi or 0)) / 2 if lo and hi else None
    if not intent_px or intent_px <= 0:
        return "no_intent_px"
    ew = j.get("exit_window") or {}
    target_px, stop_px = ew.get("target_price"), ew.get("stop_loss")
    if not target_px or not stop_px or target_px <= 0 or stop_px <= 0:
        return "no_target_stop"
    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        return "bad_risk"

    if REGIME_GATE_ON:
        regime = hist.regime(asof.date())
        if regime.get("risk_mode") == "off":
            return "regime_off"
    else:
        regime = None

    next_earnings = hist.next_earnings_asof(ticker, asof.date())
    if next_earnings is not None:
        delta = _weekday_sessions_between(asof.date(), next_earnings)
        if -1 <= delta <= EARNINGS_BLACKOUT_SESSIONS:
            return "earnings_blackout"

    avg_turnover = hist.avg_turnover(ticker, asof.date())
    if avg_turnover is None:
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and book.open_in_sector(sector) >= SECTOR_CAP:
        return "sector_cap"

    risk_budget = portfolio_base * RISK_PER_TRADE
    qty = max(1, min(int(risk_budget / risk_per_share), int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)))
    if regime and regime.get("risk_mode") == "half":
        qty = max(1, int(qty * REGIME_HALF_MULT))

    _open_shadow_trade(book, source_kind="stock_analyst", source_run_id=sa_id, ticker=ticker,
                       entered_at=asof, intent_px=intent_px, target_px=target_px, stop_px=stop_px,
                       horizon_days=horizon, qty=qty, confidence=confidence, edge=edge,
                       sector=sector, cap_tier=cap_tier, avg_turnover=avg_turnover, hist=hist)
    return "enter"


def _eval_top_performer(a_id: int, tp: dict, asof: datetime, book: ShadowBook, hist: HistCache,
                        sb, portfolio_base: float, calib_by_dim: dict,
                        breaker_tripped: bool = False) -> str | None:
    raw_ticker = (tp.get("ticker") or "").strip().upper()
    if not raw_ticker:
        return None
    ticker = raw_ticker if (raw_ticker.endswith(".NS") or raw_ticker.endswith(".BO") or raw_ticker.startswith("^")) else raw_ticker + ".NS"

    if breaker_tripped:
        return "circuit_breaker"

    conf = _conf_from_winprob(tp)
    edge = tp.get("expected_edge_pct")
    if not isinstance(edge, (int, float)):
        return "pre_schema"
    # Platt recalibration (blueprint 04): no legacy bias debit exists for
    # this path, so "not enough data" just means gate on raw conf as before.
    platt_conf = _platt_recalibrate(calib_by_dim, "top_performer_1d", asof, conf)
    effective_conf = platt_conf if platt_conf is not None else conf
    conf_method = "platt" if platt_conf is not None else "raw"
    if effective_conf < MIN_CONF:
        return "low_conf"
    if edge < MIN_EDGE_PCT:
        return "low_edge"
    rr = tp.get("risk_reward")
    if isinstance(rr, (int, float)) and rr < MIN_RR:
        return "low_rr"

    intent_px = _parse_inr(tp.get("entry"))
    target_px = _parse_inr(tp.get("target"))
    stop_px = _parse_inr(tp.get("stop_loss"))
    if not intent_px or intent_px <= 0:
        return "no_intent_px"
    if not target_px or not stop_px or target_px <= 0 or stop_px <= 0:
        return "no_target_stop"
    if target_px <= intent_px or stop_px >= intent_px:
        return "degenerate_geometry"
    if book.has_open(ticker):
        return "already_open"
    if book.ticker_frozen(ticker, asof):
        return "ticker_freeze"

    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        return "bad_risk"

    if REGIME_GATE_ON:
        regime = hist.regime(asof.date())
        if regime.get("risk_mode") == "off":
            return "regime_off"
    else:
        regime = None

    next_earnings = hist.next_earnings_asof(ticker, asof.date())
    if next_earnings is not None:
        delta = _weekday_sessions_between(asof.date(), next_earnings)
        if -1 <= delta <= EARNINGS_BLACKOUT_SESSIONS:
            return "earnings_blackout"

    avg_turnover = hist.avg_turnover(ticker, asof.date())
    if avg_turnover is None:
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and book.open_in_sector(sector) >= SECTOR_CAP:
        return "sector_cap"

    risk_budget = portfolio_base * RISK_PER_TRADE
    qty = max(1, min(int(risk_budget / risk_per_share), int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)))
    if regime and regime.get("risk_mode") == "half":
        qty = max(1, int(qty * REGIME_HALF_MULT))
    horizon = int(tp.get("horizon_days") or 1)

    _open_shadow_trade(book, source_kind="top_performer", source_run_id=a_id, ticker=ticker,
                       entered_at=asof, intent_px=intent_px, target_px=target_px, stop_px=stop_px,
                       horizon_days=horizon, qty=qty, confidence=conf, edge=edge,
                       sector=sector, cap_tier=cap_tier, avg_turnover=avg_turnover, hist=hist,
                       conf_method=conf_method)
    return "enter"


def _eval_outlook(a_id: int, outlook: dict, source_kind: str, asof: datetime, book: ShadowBook,
                  hist: HistCache, sb, portfolio_base: float, calib_by_dim: dict,
                  breaker_tripped: bool = False) -> str | None:
    raw_ticker = (outlook.get("ticker") or "").strip().upper()
    if not raw_ticker:
        return None
    ticker = raw_ticker if (raw_ticker.endswith(".NS") or raw_ticker.endswith(".BO") or raw_ticker.startswith("^")) else raw_ticker + ".NS"

    if breaker_tripped:
        return "circuit_breaker"

    direction = (outlook.get("direction") or "").lower()
    if direction != "up":
        return "not_buy"

    dim = "holding_outlook_dir_1d" if source_kind == "holding_outlook_1d" else "wishlist_outlook_dir_1d"
    stated_conf = outlook.get("confidence")
    if not isinstance(stated_conf, (int, float)):
        return "low_conf"
    platt_conf = _platt_recalibrate(calib_by_dim, dim, asof, float(stated_conf))
    if platt_conf is not None:
        effective_conf = platt_conf
        conf_method = "platt"
    else:
        bias = _calibration_bias(calib_by_dim, dim, asof)
        effective_conf = float(stated_conf) - bias
        conf_method = "bias"
    if effective_conf < OUTLOOK_MIN_CONF:
        return "low_conf"

    band = _parse_range_band(outlook.get("range"))
    if not band:
        return "no_intent_px"
    lo, hi = band
    intent_px, target_px, stop_px = (lo + hi) / 2.0, hi, lo
    expected_return_pct = (target_px - intent_px) / intent_px * 100.0
    expected_loss_pct = (intent_px - stop_px) / intent_px * 100.0
    win_prob = max(0.0, min(1.0, effective_conf / 100.0))
    edge = expected_return_pct * win_prob - expected_loss_pct * (1.0 - win_prob)
    if edge < OUTLOOK_MIN_EDGE_PCT:
        return "low_edge"
    if book.has_open(ticker):
        return "already_open"
    if book.ticker_frozen(ticker, asof):
        return "ticker_freeze"

    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        return "bad_risk"

    if REGIME_GATE_ON:
        regime = hist.regime(asof.date())
        if regime.get("risk_mode") == "off":
            return "regime_off"
    else:
        regime = None

    next_earnings = hist.next_earnings_asof(ticker, asof.date())
    if next_earnings is not None:
        delta = _weekday_sessions_between(asof.date(), next_earnings)
        if -1 <= delta <= EARNINGS_BLACKOUT_SESSIONS:
            return "earnings_blackout"

    avg_turnover = hist.avg_turnover(ticker, asof.date())
    if avg_turnover is None:
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and book.open_in_sector(sector) >= SECTOR_CAP:
        return "sector_cap"

    risk_budget = portfolio_base * RISK_PER_TRADE
    qty = max(1, min(int(risk_budget / risk_per_share), int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)))
    if regime and regime.get("risk_mode") == "half":
        qty = max(1, int(qty * REGIME_HALF_MULT))

    _open_shadow_trade(book, source_kind=source_kind, source_run_id=a_id, ticker=ticker,
                       entered_at=asof, intent_px=intent_px, target_px=target_px, stop_px=stop_px,
                       horizon_days=1, qty=qty, confidence=stated_conf, edge=edge,
                       sector=sector, cap_tier=cap_tier, avg_turnover=avg_turnover, hist=hist,
                       conf_method=conf_method)
    return "enter"


# ---------------------------------------------------------------------------
# Main replay
# ---------------------------------------------------------------------------
def _parse_dt(s) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def run_backtest() -> dict[str, Any]:
    sb = _sb()
    portfolio_base = _resolve_portfolio_base(sb)

    sa_rows = sb.table("stock_analyses").select(
        "id,ticker,horizon_days,requested_at,llm_json,status"
    ).eq("status", "ok").order("requested_at").execute().data or []
    a_rows = sb.table("analysis").select(
        "id,run_at,raw_json"
    ).order("run_at").execute().data or []
    calib_rows = sb.table("calibration_log").select(
        "dimension,stated_confidence,realized_score,graded_at"
    ).execute().data or []

    calib_by_dim: dict[str, list[dict]] = {}
    for r in calib_rows:
        dt = _parse_dt(r.get("graded_at"))
        if dt is None:
            continue
        calib_by_dim.setdefault(r["dimension"], []).append({
            "graded_at": dt,
            "stated_confidence": float(r["stated_confidence"]),
            "realized_score": float(r["realized_score"]),
        })

    # Build one chronological event stream across both sources.
    events: list[tuple[datetime, str, dict]] = []
    for r in sa_rows:
        asof = _parse_dt(r.get("requested_at"))
        if asof is None:
            continue
        r["_asof"] = asof
        events.append((asof, "stock_analyst", r))
    for a in a_rows:
        asof = _parse_dt(a.get("run_at"))
        if asof is None:
            continue
        raw = a.get("raw_json") or {}
        for source_kind, key in (("holding_outlook_1d", "holding_outlooks_1d"),
                                 ("wishlist_outlook_1d", "wishlist_outlooks_1d")):
            for outlook in (raw.get(key) or []):
                # Older rows occasionally carry a bare ticker string instead
                # of the full outlook object; not tradeable, skip.
                if not isinstance(outlook, dict):
                    continue
                events.append((asof, source_kind, {"a_id": a["id"], "outlook": outlook}))
        for tp in (raw.get("top_performers") or []):
            # Same legacy-schema guard as outlooks above.
            if not isinstance(tp, dict):
                continue
            events.append((asof, "top_performer", {"a_id": a["id"], "tp": tp}))
    events.sort(key=lambda e: e[0])

    if not events:
        return {"trade_count": 0, "note": "no analysis history to replay", "trades": []}

    earliest = events[0][0].date()
    latest_today = datetime.now(timezone.utc)
    hist = HistCache(earliest, latest_today.date())
    book = ShadowBook()

    counts = {"evaluated": 0, "entered": 0}
    skips: dict[str, int] = {}
    breaker_tripped = False

    for asof, kind, payload in events:
        _mark_shadow_book(book, hist, asof)
        counts["evaluated"] += 1
        breaker_tripped = _update_breaker(book, portfolio_base, breaker_tripped)
        if kind == "stock_analyst":
            outcome = _eval_stock_analyst(payload, book, hist, sb, portfolio_base,
                                          breaker_tripped=breaker_tripped)
        elif kind == "top_performer":
            outcome = _eval_top_performer(payload["a_id"], payload["tp"], asof, book, hist, sb, portfolio_base,
                                          calib_by_dim, breaker_tripped=breaker_tripped)
        else:
            outcome = _eval_outlook(payload["a_id"], payload["outlook"], kind, asof, book, hist, sb, portfolio_base,
                                    calib_by_dim, breaker_tripped=breaker_tripped)
        if outcome == "enter":
            counts["entered"] += 1
        elif outcome:
            skips[outcome] = skips.get(outcome, 0) + 1

    # Final pass: resolve whatever can be resolved with all data through today.
    _mark_shadow_book(book, hist, latest_today)

    closed = book.closed
    trades_for_metrics = [
        {**t, "exit_at": t["exit_at"].isoformat() if isinstance(t.get("exit_at"), datetime) else t.get("exit_at")}
        for t in closed
    ]
    curve = metrics.equity_curve(trades_for_metrics)
    rets = metrics.daily_returns(curve, base_inr=portfolio_base)
    sharpe_v = metrics.sharpe(rets)
    dd = metrics.max_drawdown(curve, base_inr=portfolio_base)
    psr_v = metrics.psr(rets) if len(rets) >= 4 else 0.0
    total_net = curve[-1][1] if curve else 0.0
    span_days = ((curve[-1][0] - curve[0][0]).days + 1) if len(curve) >= 2 else 0
    annual_ret_pct = (total_net / portfolio_base) * (365.0 / span_days) * 100.0 if span_days > 0 else 0.0
    calmar_v = metrics.calmar(sharpe_v, dd["max_dd_pct"], annual_ret_pct)
    tiers = metrics.evaluate_tiers(sharpe_v, dd["max_dd_pct"], psr_v)
    wins = sum(1 for t in closed if (t.get("net_pnl") or 0) > 0)
    win_rate = (wins / len(closed) * 100.0) if closed else 0.0

    return {
        "portfolio_base": portfolio_base,
        "replay_window": {"from": earliest.isoformat(), "to": latest_today.date().isoformat()},
        "counts": counts,
        "skips": skips,
        "still_open": len(book.open),
        "trade_count": len(closed),
        "win_rate_pct": round(win_rate, 2),
        "span_days": span_days,
        "total_net_pnl": float(total_net),
        "annual_return_pct": round(annual_ret_pct, 2),
        "sharpe": round(sharpe_v, 3),
        "max_drawdown": dd,
        "calmar": round(calmar_v, 3),
        "psr": round(psr_v, 4),
        "tier_eval": tiers,
        "equity_curve": [(d.isoformat(), v) for d, v in curve],
        "trades": [
            {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in t.items()}
            for t in closed
        ],
    }


def _result_row(bundle: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "ok",
        "error": None,
        "params": {"portfolio_base": bundle.get("portfolio_base"),
                   "replay_window": bundle.get("replay_window")},
        "trade_count": bundle.get("trade_count"),
        "win_rate_pct": bundle.get("win_rate_pct"),
        "sharpe": bundle.get("sharpe"),
        "max_dd_pct": (bundle.get("max_drawdown") or {}).get("max_dd_pct"),
        "calmar": bundle.get("calmar"),
        "psr": bundle.get("psr"),
        "total_net_pnl": bundle.get("total_net_pnl"),
        "annual_return_pct": bundle.get("annual_return_pct"),
        "results": bundle,
    }


def save_backtest_run(bundle: dict[str, Any], run_id: int | None = None) -> int | None:
    """Insert a new row (CLI/ad-hoc use), or update an existing pending
    row when run_id is given (GH Actions dispatch path. the API route
    already inserted the pending row before triggering the workflow)."""
    sb = _sb()
    row = _result_row(bundle)
    if run_id is not None:
        sb.table("backtest_runs").update(row).eq("id", run_id).execute()
        return run_id
    res = sb.table("backtest_runs").insert(row).execute()
    return (res.data or [{}])[0].get("id") if res.data else None


def run(run_id: int | None = None) -> None:
    sb = _sb()
    try:
        b = run_backtest()
    except Exception as e:
        if run_id is not None:
            sb.table("backtest_runs").update({
                "status": "failed", "error": str(e)[:500],
            }).eq("id", run_id).execute()
        print(f"Backtest failed: {e}")
        raise
    saved_id = save_backtest_run(b, run_id=run_id)
    print(f"Saved backtest_runs id={saved_id}")
    print(f"trades={b.get('trade_count')} sharpe={b.get('sharpe')} "
          f"max_dd={  (b.get('max_drawdown') or {}).get('max_dd_pct')} psr={b.get('psr')}")


if __name__ == "__main__":
    import sys
    arg_run_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
    run(arg_run_id)

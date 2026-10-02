"""Point-in-time market inputs for the US daily brief (blueprint 25, Phase 3).

Everything handed to the LLM is dated strictly BEFORE the session the brief
is for, so a brief can never see the day it predicts. Network access is
isolated in `fetch_history` and `next_events`; the rest is pure and unit
tested on synthetic frames.

The technical battery reuses analyzer.stock_deep._technicals_from_history,
a pure DataFrame function with no market-specific logic (RSI14, SMA
distances, MACD, ATR, 52-week position, trailing returns). This module adds
only what it lacks: last session date, 1-day return and a volume ratio.

Prices are unadjusted closes (auto_adjust=False) so stop and target levels
compare against the same numbers a broker quotes. Known small bias: an
ex-dividend gap shows as a price drop (TSM pays about 0.3 percent a quarter).

SKHY's yfinance calendar carries KRW-denominated estimates next to a USD
price, so only dates are ever read from it, never the estimate figures.
"""
from __future__ import annotations

import math
import time
from datetime import date

import pandas as pd

from analyzer.stock_deep import _technicals_from_history

# symbol -> what the LLM is told it is
CONTEXT_SYMBOLS = {
    "SPY": "S&P 500 ETF",
    "QQQ": "Nasdaq 100 ETF",
    "SOXX": "semiconductor ETF",
    "^VIX": "VIX volatility index (level)",
    "DX-Y.NYB": "US dollar index",
    "^TNX": "US 10-year Treasury yield (percent)",
    "USDINR=X": "USD per INR rate (rupees per dollar)",
}
_HISTORY_PERIOD = "1y"
_FETCH_ATTEMPTS = 2
_FETCH_RETRY_DELAY_S = 2
_MIN_BARS = 30


def fetch_history(symbol: str, period: str = _HISTORY_PERIOD) -> pd.DataFrame:
    """Daily OHLCV, ascending, index = naive midnight session dates."""
    import yfinance as yf

    last_err: Exception | None = None
    for attempt in range(_FETCH_ATTEMPTS):
        try:
            h = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=False)
            if not h.empty:
                h = h[["Open", "High", "Low", "Close", "Volume"]].copy()
                h.index = pd.to_datetime(h.index.date)
                return h.sort_index()
            last_err = RuntimeError("empty history")
        except Exception as e:  # yfinance raises assorted network and parse errors
            last_err = e
        if attempt < _FETCH_ATTEMPTS - 1:
            time.sleep(_FETCH_RETRY_DELAY_S)
    raise RuntimeError(f"no history for {symbol}: {last_err}")


def before(df: pd.DataFrame, session_date: date) -> pd.DataFrame:
    """Rows strictly earlier than session_date. This is the anti-hindsight
    cut: today's partial bar and anything later never reach the model."""
    return df[df.index < pd.Timestamp(session_date)]


def _r(value: float | None, nd: int = 2) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), nd)


def _change_pct(close: pd.Series, k: int) -> float | None:
    """Percent change of the last close versus k sessions earlier."""
    if len(close) <= k:
        return None
    then = float(close.iloc[-1 - k])
    return _r((float(close.iloc[-1]) / then - 1.0) * 100.0) if then else None


def technicals(df: pd.DataFrame) -> dict:
    """Technical battery for a daily frame already cut to before the
    session. Keys are absent or None when history is too short."""
    out = _technicals_from_history(df)
    close = df["Close"].astype(float)
    # The helper names it last_close; one name only, so the brief reads the
    # same key it quotes to the model.
    out.pop("last_close", None)
    out["close"] = _r(float(close.iloc[-1]))
    out["last_date"] = df.index[-1].date().isoformat()
    out["ret_1d_pct"] = _change_pct(close, 1)
    if len(df) > 21:
        avg = float(df["Volume"].iloc[-21:-1].mean())
        out["volume_vs_20d_avg"] = _r(float(df["Volume"].iloc[-1]) / avg) if avg > 0 else None
    return out


def index_snapshot(df: pd.DataFrame) -> dict:
    close = df["Close"].astype(float)
    return {
        "last_date": df.index[-1].date().isoformat(),
        "last": _r(float(close.iloc[-1]), 4),
        "chg_1d_pct": _change_pct(close, 1),
        "chg_5d_pct": _change_pct(close, 5),
    }


def _as_iso(value) -> str | None:
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    return value.isoformat() if hasattr(value, "isoformat") else None


def next_events(symbol: str, session_date: date) -> dict:
    """Upcoming earnings and ex-dividend dates only (see module docstring on
    why no estimate figures). Past dates are dropped. Never raises."""
    out = {"next_earnings": None, "ex_dividend": None}
    try:
        import yfinance as yf
        cal = yf.Ticker(symbol).calendar or {}
    except Exception:
        return out
    for key, field in (("Earnings Date", "next_earnings"), ("Ex-Dividend Date", "ex_dividend")):
        iso = _as_iso(cal.get(key))
        if iso and iso >= session_date.isoformat():
            out[field] = iso
    return out


def build_context(tickers: list[str], session_date: date) -> dict:
    """Everything the brief may use, cut before session_date. Raises if a
    held ticker has too little history (a brief without its own price is
    worthless); a missing context symbol degrades to None instead."""
    market: dict = {}
    for sym, label in CONTEXT_SYMBOLS.items():
        try:
            market[sym] = {"what": label, **index_snapshot(before(fetch_history(sym), session_date))}
        except Exception as e:
            print(f"  context {sym} unavailable: {str(e)[:100]}")
            market[sym] = {"what": label, "last": None}
    per_ticker: dict = {}
    for t in tickers:
        bars = before(fetch_history(t), session_date)
        if len(bars) < _MIN_BARS:
            raise RuntimeError(f"{t}: only {len(bars)} bars before {session_date}, too few")
        per_ticker[t] = {"technicals": technicals(bars), **next_events(t, session_date)}
    return {"session_date": session_date.isoformat(), "market": market, "tickers": per_ticker}

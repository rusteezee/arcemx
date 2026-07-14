"""Market-regime filter: NIFTY 200DMA trend, India VIX band, realized 20d
volatility percentile. Gates paper-trader entries and halves position
size in adverse regimes.

Deliberately three cheap, robust indicators instead of an HMM - the
small-N literature verdict (backed research for this project, July 2026)
is that simple trend + vol filters hold up at small sample sizes while
regime-switching models are decorative complexity that overfits on a
book this young. See ROADMAP.md blueprint 03 for the full reasoning.

Two entry points:
- fetch_regime(): live path, downloads real data, module-level 30-min
  cache so one paper_trader eval pass costs at most one download set.
- regime_from_history(): pure function, no I/O. fetch_regime() calls it
  with live data; the backtest replay calls it with HistCache slices
  taken strictly before each event's own date, so both paths compute
  the regime identically without the backtest ever seeing the future.

Fail-open by design: any fetch/compute error returns risk_mode="on"
with regime_data_missing=True rather than freezing the book. A yfinance
hiccup must never silently stop trading.
"""
from __future__ import annotations

import time
from datetime import date, datetime, timezone

import yfinance as yf

# vix_band thresholds (India VIX level)
_VIX_CALM_MAX = 14.0
_VIX_NORMAL_MAX = 20.0
# realized-vol percentile above which risk_mode downgrades to "half"
_RV20_PCTILE_HALF = 90.0

_CACHE: dict = {}
_CACHE_TTL_SECONDS = 30 * 60


def _flatten_yf_columns(h):
    """Same MultiIndex flatten as paper_trader._flatten_yf_columns -
    duplicated rather than imported to keep this module import-cheap and
    dependency-free of paper_trader (backtest imports both, and a
    regime<->paper_trader import cycle is easy to create by accident)."""
    if h is not None and hasattr(h.columns, "nlevels") and h.columns.nlevels > 1:
        h = h.copy()
        h.columns = h.columns.get_level_values(0)
    return h


def _fail_open(vix_value: float | None, asof_date: date, reason: str) -> dict:
    return {
        "trend": "up",
        "vix": vix_value,
        "vix_band": "normal",
        "rv20_pctile": 0.0,
        "risk_mode": "on",
        "regime_data_missing": True,
        "asof": asof_date.isoformat(),
        "_reason": reason,
    }


def regime_from_history(nifty_bars, vix_value: float | None,
                        asof_date: date) -> dict:
    """Pure function, no I/O. `nifty_bars` must already be whatever
    history the caller considers valid as-of `asof_date` - this function
    does not itself slice for no-lookahead; the backtest replay is
    responsible for passing only bars dated before the event (see
    HistCache.avg_turnover for the same pattern already used elsewhere
    in this codebase). `asof_date` is carried through into the result
    for audit/debugging, not used to re-slice.

    trend = "up" iff NIFTY close > its 200-session SMA.
    vix_band: calm < 14, normal 14-20, stressed > 20.
    rv20_pctile = percentile of current 20d realized vol vs trailing
    252 sessions (higher = more turbulent than usual).
    risk_mode = "off" (no new entries) when trend=="down" AND
    vix_band=="stressed"; "half" (halve qty) when trend=="down" OR
    vix_band=="stressed" OR rv20_pctile > 90; else "on".
    """
    if nifty_bars is None or nifty_bars.empty or "Close" not in nifty_bars:
        return _fail_open(vix_value, asof_date, "no_nifty_bars")

    closes = nifty_bars["Close"].dropna()
    if len(closes) < 200:
        return _fail_open(vix_value, asof_date, "insufficient_history_for_sma200")

    sma200 = float(closes.tail(200).mean())
    last_close = float(closes.iloc[-1])
    trend = "up" if last_close > sma200 else "down"

    rets = closes.pct_change().dropna()
    if len(rets) < 40:
        return _fail_open(vix_value, asof_date, "insufficient_history_for_rv20")
    rv20 = rets.rolling(20).std().dropna()
    trailing = rv20.tail(252)
    if trailing.empty:
        return _fail_open(vix_value, asof_date, "insufficient_history_for_rv20")
    current_rv = float(trailing.iloc[-1])
    rv20_pctile = float((trailing <= current_rv).mean() * 100.0)

    vix = float(vix_value) if isinstance(vix_value, (int, float)) else None
    if vix is None:
        # Missing VIX alone doesn't warrant a full fail-open (trend + vol
        # are still real signal) - default to "normal" so it neither
        # forces "off" nor silently loosens the gate.
        vix_band = "normal"
    elif vix < _VIX_CALM_MAX:
        vix_band = "calm"
    elif vix <= _VIX_NORMAL_MAX:
        vix_band = "normal"
    else:
        vix_band = "stressed"

    if trend == "down" and vix_band == "stressed":
        risk_mode = "off"
    elif trend == "down" or vix_band == "stressed" or rv20_pctile > _RV20_PCTILE_HALF:
        risk_mode = "half"
    else:
        risk_mode = "on"

    return {
        "trend": trend,
        "vix": vix,
        "vix_band": vix_band,
        "rv20_pctile": round(rv20_pctile, 1),
        "risk_mode": risk_mode,
        "asof": asof_date.isoformat(),
    }


def fetch_regime(now: datetime | None = None) -> dict:
    """Live path. Downloads ^NSEI 1y + ^INDIAVIX 5d daily bars, computes
    the regime. Module-level 30-min cache keyed on wall-clock time (not
    on `now`) so a burst of eval_signals() calls within the same window
    costs one download set total."""
    now = now or datetime.now(timezone.utc)
    cached = _CACHE.get("data")
    cached_at = _CACHE.get("at", 0.0)
    if cached is not None and (time.monotonic() - cached_at) < _CACHE_TTL_SECONDS:
        return cached

    try:
        nifty = yf.download("^NSEI", period="1y", interval="1d",
                            auto_adjust=True, progress=False, threads=False)
        nifty = _flatten_yf_columns(nifty)
        vix_hist = yf.download("^INDIAVIX", period="5d", interval="1d",
                               auto_adjust=True, progress=False, threads=False)
        vix_hist = _flatten_yf_columns(vix_hist)
        vix_value = None
        if vix_hist is not None and not vix_hist.empty and "Close" in vix_hist:
            vclose = vix_hist["Close"].dropna()
            if not vclose.empty:
                vix_value = float(vclose.iloc[-1])
        result = regime_from_history(nifty, vix_value, now.date())
    except Exception as e:
        print(f"regime.fetch_regime failed, failing open to risk_mode=on: "
              f"{str(e)[:200]}")
        result = _fail_open(None, now.date(), f"fetch_error:{type(e).__name__}")

    _CACHE["data"] = result
    _CACHE["at"] = time.monotonic()
    return result

"""Rich market-context block for the analyzer payload.

The base payload only carried bare index price snapshots, so the model
predicted NIFTY direction and range with no technical read on the index
itself and no overnight global cues. That capped direction accuracy near
a coin flip and produced loose, unanchored ranges. This module adds:

- Index technicals (RSI, MACD state, DMA position, 20d support/resistance,
  ATR) for NIFTY, Sensex, and Bank Nifty, so the model reasons on levels.
- An ATR-based expected daily move, so the next-day range can be anchored
  to real volatility instead of guessed.
- Global / overnight cues (India VIX, USDINR, crude, US 10Y, DXY, Nikkei,
  Hang Seng, US index futures, gold). GIFT Nifty is not on yfinance, so US
  futures + Asian indices are the overnight risk proxy for NIFTY's open.

All data is free via yfinance.
"""
import numpy as np
import pandas as pd
import yfinance as yf

INDEX_SYMBOLS = {
    "NIFTY": "^NSEI",
    "SENSEX": "^BSESN",
    "BANKNIFTY": "^NSEBANK",
}

# label -> (symbol, short note on why it matters for NIFTY's next session)
GLOBAL_CUES = {
    "india_vix": ("^INDIAVIX", "fear gauge; high = expect wider moves"),
    "usdinr": ("INR=X", "rupee weakness pressures equities"),
    "crude_wti": ("CL=F", "higher crude hurts Indian importers/inflation"),
    "us_10y_yield": ("^TNX", "rising US yields pull FII money out"),
    "dxy": ("DX-Y.NYB", "strong dollar = EM outflows"),
    "nikkei": ("^N225", "Asian risk tone into India open"),
    "hangseng": ("^HSI", "Asian risk tone into India open"),
    "sp500_future": ("ES=F", "overnight US risk proxy"),
    "nasdaq_future": ("NQ=F", "overnight US tech risk proxy"),
    "dow_future": ("YM=F", "overnight US risk proxy"),
    "gold": ("GC=F", "safe-haven bid = risk-off"),
}


def _rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    ag = gain.ewm(alpha=1 / length, adjust=False).mean()
    al = loss.ewm(alpha=1 / length, adjust=False).mean()
    rs = ag / al.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _atr(df: pd.DataFrame, length: int = 14) -> float | None:
    if len(df) < length + 1:
        return None
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr = tr.rolling(length).mean().iloc[-1]
    return float(atr) if not pd.isna(atr) else None


def _round(x, n=2):
    return round(float(x), n) if x is not None and not pd.isna(x) else None


def _index_signal(symbol: str) -> dict | None:
    try:
        df = yf.download(symbol, period="1y", interval="1d",
                         auto_adjust=True, progress=False)
        if df.empty or len(df) < 60:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        close = df["Close"]
        last = float(close.iloc[-1])
        prev = float(close.iloc[-2])

        r = _rsi(close, 14)
        ema_fast = close.ewm(span=12, adjust=False).mean()
        ema_slow = close.ewm(span=26, adjust=False).mean()
        macd_line = ema_fast - ema_slow
        macd_sig = macd_line.ewm(span=9, adjust=False).mean()
        macd_bull = bool(macd_line.iloc[-1] > macd_sig.iloc[-1])

        sma20 = close.rolling(20).mean().iloc[-1]
        sma50 = close.rolling(50).mean().iloc[-1]
        sma200 = close.rolling(200).mean().iloc[-1] if len(close) >= 200 else np.nan

        res_20d = float(df["High"].tail(20).max())
        sup_20d = float(df["Low"].tail(20).min())
        atr = _atr(df, 14)
        atr_pct = _round(atr / last * 100) if atr else None

        def _pos(v):
            return None if pd.isna(v) else ("above" if last > v else "below")

        return {
            "last": _round(last),
            "chg_1d_pct": _round((last - prev) / prev * 100),
            "chg_5d_pct": _round((last - float(close.iloc[-6])) / float(close.iloc[-6]) * 100) if len(close) > 6 else None,
            "rsi_14": _round(r.iloc[-1]),
            "macd_bullish": macd_bull,
            "vs_sma20": _pos(sma20),
            "vs_sma50": _pos(sma50),
            "vs_sma200": _pos(sma200),
            "support_20d": _round(sup_20d),
            "resistance_20d": _round(res_20d),
            "dist_to_support_pct": _round((last - sup_20d) / last * 100),
            "dist_to_resistance_pct": _round((res_20d - last) / last * 100),
            "atr_14": _round(atr) if atr else None,
            "expected_daily_move_pct": atr_pct,
        }
    except Exception as e:
        print(f"index signal fail {symbol}: {e}")
        return None


def _cue_snapshot(symbol: str) -> dict | None:
    try:
        fi = yf.Ticker(symbol).fast_info
        last = fi.last_price
        prev = fi.previous_close
        if last is None or prev is None:
            return None
        return {"last": _round(last), "chg_pct": _round((last - prev) / prev * 100)}
    except Exception as e:
        print(f"cue fail {symbol}: {e}")
        return None


def build_market_context() -> dict:
    indices = {}
    for name, sym in INDEX_SYMBOLS.items():
        sig = _index_signal(sym)
        if sig:
            indices[name] = sig

    cues = {}
    for label, (sym, note) in GLOBAL_CUES.items():
        snap = _cue_snapshot(sym)
        if snap:
            snap["note"] = note
            cues[label] = snap

    return {
        "indices": indices,
        "global_cues": cues,
        "note": (
            "GIFT Nifty is unavailable, so US index futures (sp500/nasdaq/dow) "
            "plus Nikkei and Hang Seng are the overnight risk proxy for NIFTY's "
            "open. Use index technicals for the direction call and the index's "
            "expected_daily_move_pct (ATR-based) to size the next-day range: a "
            "normal session moves about 1 ATR, so the range band should be near "
            "that width, tighter when India VIX is low, wider when it is high."
        ),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(build_market_context(), indent=2, default=str))

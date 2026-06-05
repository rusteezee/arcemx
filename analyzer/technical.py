"""Technical screener: RSI, MACD, MAs, momentum. Pure pandas, no pandas-ta."""
import pandas as pd
import numpy as np
import yfinance as yf


def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / length, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line


def bbands(close: pd.Series, length: int = 20, std: float = 2.0):
    mid = close.rolling(length).mean()
    s = close.rolling(length).std()
    return mid + std * s, mid - std * s


def compute_signals(df: pd.DataFrame) -> dict:
    if df.empty or len(df) < 50:
        return {}
    close = df["Close"]
    r = rsi(close, 14)
    m_line, m_sig = macd(close)
    sma20 = close.rolling(20).mean()
    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean() if len(close) >= 200 else None
    bb_up, bb_lo = bbands(close, 20, 2.0)

    last = close.iloc[-1]
    prev = close.iloc[-2]
    chg_1d = (last - prev) / prev * 100
    chg_5d = (last - close.iloc[-6]) / close.iloc[-6] * 100 if len(close) > 6 else None
    chg_30d = (last - close.iloc[-31]) / close.iloc[-31] * 100 if len(close) > 31 else None

    return {
        "last": float(last),
        "rsi": float(r.iloc[-1]) if not pd.isna(r.iloc[-1]) else None,
        "macd": float(m_line.iloc[-1]) if not pd.isna(m_line.iloc[-1]) else None,
        "macd_signal": float(m_sig.iloc[-1]) if not pd.isna(m_sig.iloc[-1]) else None,
        "sma20": float(sma20.iloc[-1]) if not pd.isna(sma20.iloc[-1]) else None,
        "sma50": float(sma50.iloc[-1]) if not pd.isna(sma50.iloc[-1]) else None,
        "sma200": float(sma200.iloc[-1]) if sma200 is not None and not pd.isna(sma200.iloc[-1]) else None,
        "bb_upper": float(bb_up.iloc[-1]) if not pd.isna(bb_up.iloc[-1]) else None,
        "bb_lower": float(bb_lo.iloc[-1]) if not pd.isna(bb_lo.iloc[-1]) else None,
        "chg_1d": float(chg_1d),
        "chg_5d": float(chg_5d) if chg_5d is not None else None,
        "chg_30d": float(chg_30d) if chg_30d is not None else None,
        "vol_avg_20": float(df["Volume"].tail(20).mean()),
        "vol_last": float(df["Volume"].iloc[-1]),
    }


def screen_universe(tickers: list[str]) -> dict:
    data = yf.download(tickers, period="1y", interval="1d", group_by="ticker",
                       auto_adjust=True, threads=True, progress=False)
    out = {}
    for t in tickers:
        try:
            sub = data[t].dropna()
            out[t] = compute_signals(sub)
        except (KeyError, AttributeError):
            continue
    return out


def rank_candidates(signals: dict, n: int = 20) -> dict:
    rows = []
    for t, s in signals.items():
        if not s:
            continue
        score = 0
        if s.get("rsi") and 50 < s["rsi"] < 70: score += 2
        if s.get("rsi") and s["rsi"] > 70: score -= 1
        if s.get("rsi") and s["rsi"] < 30: score += 1
        if s.get("macd") and s.get("macd_signal") and s["macd"] > s["macd_signal"]: score += 2
        if s.get("sma20") and s.get("sma50") and s["sma20"] > s["sma50"]: score += 1
        if s.get("chg_5d") and s["chg_5d"] > 5: score += 1
        if s.get("chg_30d") and s["chg_30d"] > 10: score += 1
        if s.get("vol_last") and s.get("vol_avg_20") and s["vol_last"] > 1.5 * s["vol_avg_20"]: score += 1
        rows.append({"ticker": t, "score": score, "signals": s})
    rows.sort(key=lambda r: r["score"], reverse=True)
    return {"bullish": rows[:n], "bearish": rows[-n:][::-1]}

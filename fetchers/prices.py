"""Fetch OHLCV for universe + portfolio tickers via yfinance."""
import os
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
UNIVERSE_CSV = ROOT / "data" / "universe.csv"


def load_universe() -> list[str]:
    df = pd.read_csv(UNIVERSE_CSV)
    return df["ticker"].tolist()


def fetch_ohlcv(tickers: list[str], period: str = "6mo", interval: str = "1d") -> pd.DataFrame:
    data = yf.download(
        tickers=tickers,
        period=period,
        interval=interval,
        group_by="ticker",
        auto_adjust=True,
        threads=True,
        progress=False,
    )
    rows = []
    for t in tickers:
        try:
            sub = data[t].dropna()
            for ts, row in sub.iterrows():
                rows.append({
                    "ticker": t,
                    "ts": ts.isoformat(),
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                    "volume": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
                })
        except (KeyError, AttributeError):
            continue
    return pd.DataFrame(rows)


def push_to_supabase(df: pd.DataFrame) -> int:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        print("Supabase not configured; skipping push")
        return 0
    sb = create_client(url, key)
    records = df.to_dict(orient="records")
    batch = 500
    inserted = 0
    for i in range(0, len(records), batch):
        chunk = records[i:i + batch]
        sb.table("prices").upsert(chunk, on_conflict="ticker,ts").execute()
        inserted += len(chunk)
    return inserted


def latest_snapshot(tickers: list[str]) -> pd.DataFrame:
    """Single-row latest quote per ticker. Used by analyzer + bot."""
    rows = []
    for t in tickers:
        try:
            info = yf.Ticker(t).fast_info
            rows.append({
                "ticker": t,
                "last": info.last_price,
                "prev_close": info.previous_close,
                "day_high": info.day_high,
                "day_low": info.day_low,
                "pct_change": ((info.last_price - info.previous_close) / info.previous_close) * 100
                if info.previous_close else None,
            })
        except Exception as e:
            print(f"snapshot fail {t}: {e}")
    return pd.DataFrame(rows)


if __name__ == "__main__":
    tickers = load_universe()
    print(f"Fetching {len(tickers)} tickers...")
    df = fetch_ohlcv(tickers, period="6mo")
    print(f"Rows: {len(df)}")
    n = push_to_supabase(df)
    print(f"Pushed {n} rows to Supabase")

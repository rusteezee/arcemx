"""One-time historical price backfill.

Pulls daily OHLCV from Yahoo Finance for every ticker that appears in
the `transactions` table (plus optionally `portfolio` and `wishlist`)
going back to the earliest execution date for that ticker, and
upserts everything into `prices`. After this runs the Portfolio Value
Timeline has enough history to multiply each historical day's close
by the qty held on that day for every position the user ever owned —
including ones long since sold.

Usage:
    python -m fetchers.backfill_prices
    python -m fetchers.backfill_prices --since 2023-10-01
    python -m fetchers.backfill_prices --tickers SUZLON.NS GROWW.NS

Re-running is safe: `prices` upserts on (ticker, ts).
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta
from typing import Iterable

import pandas as pd
import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


def _sb():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise SystemExit("SUPABASE_URL / SUPABASE_KEY missing from environment / .env")
    return create_client(url, key)


def _earliest_dates_by_ticker(sb) -> dict[str, datetime]:
    """For every ticker in `transactions`, return the earliest execution
    date. Used to scope each ticker's Yahoo lookback so we don't waste
    requests on years before the user ever bought it."""
    out: dict[str, datetime] = {}
    res = sb.table("transactions").select("ticker,execution_date").execute()
    for row in (res.data or []):
        t = row.get("ticker")
        d = row.get("execution_date")
        if not t or not d:
            continue
        ts = pd.to_datetime(d).to_pydatetime().replace(tzinfo=None)
        cur = out.get(t)
        if cur is None or ts < cur:
            out[t] = ts
    return out


def _fetch_one(ticker: str, start: datetime, end: datetime) -> pd.DataFrame:
    """yfinance per-ticker pull. We use single-ticker download so a
    failure on one symbol doesn't poison a batch dataframe."""
    try:
        df = yf.download(
            tickers=ticker,
            start=start.strftime("%Y-%m-%d"),
            end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as e:
        print(f"  [fail] {ticker}: yfinance error — {e!r}")
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    # When a single ticker is requested yfinance can still return a
    # MultiIndex columns DataFrame in some versions; flatten it.
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.dropna(subset=["Close"])
    rows = []
    for ts, row in df.iterrows():
        rows.append({
            "ticker": ticker,
            "ts": ts.isoformat(),
            "open": float(row["Open"]) if not pd.isna(row.get("Open")) else None,
            "high": float(row["High"]) if not pd.isna(row.get("High")) else None,
            "low": float(row["Low"]) if not pd.isna(row.get("Low")) else None,
            "close": float(row["Close"]),
            "volume": int(row["Volume"]) if not pd.isna(row.get("Volume")) else 0,
        })
    return pd.DataFrame(rows)


def _push(sb, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    records = df.to_dict(orient="records")
    batch = 500
    n = 0
    for i in range(0, len(records), batch):
        chunk = records[i : i + batch]
        try:
            sb.table("prices").upsert(chunk, on_conflict="ticker,ts").execute()
            n += len(chunk)
        except Exception as e:
            print(f"  [push fail] rows {i}-{i+len(chunk)}: {e!r}")
    return n


def backfill(tickers: Iterable[str] | None = None, since: datetime | None = None) -> dict:
    sb = _sb()
    earliest = _earliest_dates_by_ticker(sb)
    selected: list[str] = sorted(set(tickers)) if tickers else sorted(earliest.keys())
    if not selected:
        print("Nothing to backfill — `transactions` is empty and no --tickers passed.")
        return {"tickers": 0, "rows": 0}

    end = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    total_rows = 0
    summary: dict[str, int] = {}

    for t in selected:
        start = since or earliest.get(t)
        if start is None:
            print(f"  [skip] {t}: no execution date and no --since override")
            continue
        # Pull a small cushion before the first txn so weekend gaps are covered.
        start = start - timedelta(days=2)
        print(f"  -> {t}: {start.date()} to {end.date()}")
        df = _fetch_one(t, start, end)
        if df.empty:
            print(f"    (Yahoo returned no rows — possibly SME / delisted / wrong suffix)")
            summary[t] = 0
            continue
        n = _push(sb, df)
        summary[t] = n
        total_rows += n
        print(f"    {n} rows upserted")

    print("\n" + "=" * 60)
    print(f"Backfilled {len(selected)} ticker(s), {total_rows} rows total")
    missing = [t for t, n in summary.items() if n == 0]
    if missing:
        print(f"No Yahoo data for: {missing}")
        print("  (likely SME / delisted; their qty stays in the ledger but"
              " can't contribute to historical value)")
    return {"tickers": len(selected), "rows": total_rows, "missing": missing}


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--since",
        type=lambda s: datetime.strptime(s, "%Y-%m-%d"),
        default=None,
        help="Override start date (YYYY-MM-DD). Default: each ticker's "
             "earliest execution_date from `transactions`.",
    )
    p.add_argument(
        "--tickers",
        nargs="*",
        default=None,
        help="Limit to a specific ticker list (e.g. SUZLON.NS GROWW.NS). "
             "Default: every distinct ticker in `transactions`.",
    )
    args = p.parse_args()
    backfill(tickers=args.tickers, since=args.since)


if __name__ == "__main__":
    main()

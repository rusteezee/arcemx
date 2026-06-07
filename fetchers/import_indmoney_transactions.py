"""Import INDmoney "Transactions Report" XLSX files into Supabase.

INDmoney's MCP doesn't expose a historical buy / sell ledger, so we
backfill the `transactions` table from the user's downloadable XLSX
reports (one per FY). Once loaded, the Portfolio Value Timeline can
replay total value across every position ever held, including ones
that were later sold off.

Usage:
    python -m fetchers.import_indmoney_transactions <file1.xlsx> [file2.xlsx ...]
    python -m fetchers.import_indmoney_transactions W:/Indmoney-TransactionsReport-*.xlsx

Each XLSX is expected to carry a sheet named "Equity transactions
report" with a header row at index 6:
    Execution Date | Scrip Name | Scrip Symbol | ISIN | Type |
    Quantity | Price | Exchange | Exchange Order Id | Order Status

Re-running the importer is safe: rows are upserted by (user_id,
order_id), so repeated runs won't duplicate.
"""
from __future__ import annotations

import glob
import os
import sys
from datetime import datetime
from typing import Iterable

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

# Load Supabase credentials from .env the same way every other fetcher
# in this repo does — keeps the local CLI experience consistent so the
# user doesn't have to export env vars before running the importer.
load_dotenv()

EQUITY_SHEET = "Equity transactions report"
HEADER_ROW_INDEX = 6  # zero-indexed; the row before this is blank


def _sb_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise SystemExit(
            "SUPABASE_URL / SUPABASE_KEY env vars are required. "
            "Set them in your shell before running this importer."
        )
    return create_client(url, key)


def _normalise_ticker(scrip_symbol: str) -> str:
    """Map an INDmoney scrip symbol to a Yahoo Finance NSE ticker.

    INDmoney rows can be filled from BSE orders too (Exchange == "BSE"),
    but the underlying instrument is the same and Yahoo's NSE feed is
    the most reliable for daily closes. SME / unlisted symbols Yahoo
    doesn't carry will silently fail price backfill later — the
    importer still stores them so the qty ledger is complete.
    """
    return f"{scrip_symbol.strip().upper()}.NS"


def _expand_paths(args: Iterable[str]) -> list[str]:
    out: list[str] = []
    for a in args:
        matched = glob.glob(a)
        out.extend(matched if matched else [a])
    # Stable, deterministic order.
    return sorted(set(out))


def _read_equity_rows(path: str) -> pd.DataFrame:
    """Load the Equity sheet, strip the metadata header band, and drop
    the 'No transactions done in the time period' sentinel."""
    df = pd.read_excel(path, sheet_name=EQUITY_SHEET, header=HEADER_ROW_INDEX)
    df = df.dropna(subset=["Execution Date"])
    df = df[df["Execution Date"].astype(str) != "No transactions done in the time period"]
    return df


def _row_to_record(row: pd.Series, user_id: str) -> dict | None:
    """Map one XLSX row to the Supabase `transactions` schema. Returns
    None if the row is unusable (missing required field)."""
    raw_date = row.get("Execution Date")
    if pd.isna(raw_date):
        return None
    if isinstance(raw_date, datetime):
        execution_date = raw_date
    else:
        try:
            execution_date = pd.to_datetime(raw_date).to_pydatetime()
        except Exception:
            return None

    side = str(row.get("Type", "")).strip().upper()
    if side not in ("BUY", "SELL"):
        return None

    try:
        qty = float(row.get("Quantity"))
        price = float(row.get("Price"))
    except (TypeError, ValueError):
        return None

    scrip_symbol = str(row.get("Scrip Symbol", "")).strip()
    if not scrip_symbol:
        return None

    order_id_raw = row.get("Exchange Order Id")
    order_id = None if pd.isna(order_id_raw) else str(order_id_raw).strip()
    if not order_id:
        return None

    return {
        "user_id": user_id,
        "execution_date": execution_date.isoformat(),
        "scrip_symbol": scrip_symbol,
        "ticker": _normalise_ticker(scrip_symbol),
        "scrip_name": _nan_to_none(row.get("Scrip Name")),
        "isin": _nan_to_none(row.get("ISIN")),
        "side": side,
        "qty": qty,
        "price": price,
        "exchange": _nan_to_none(row.get("Exchange")),
        "order_id": order_id,
        "order_status": _nan_to_none(row.get("Order Status")),
        "source": "indmoney_xlsx",
    }


def _nan_to_none(value):
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def import_files(paths: list[str], user_id: str = "default") -> dict:
    sb = _sb_client()
    total_loaded = 0
    total_skipped = 0
    per_file: dict[str, int] = {}
    all_tickers: set[str] = set()

    for path in paths:
        if not os.path.exists(path):
            print(f"[skip] {path}: file not found")
            continue
        try:
            df = _read_equity_rows(path)
        except Exception as e:
            print(f"[skip] {path}: read failed — {e!r}")
            continue

        records: list[dict] = []
        for _, row in df.iterrows():
            rec = _row_to_record(row, user_id)
            if rec is None:
                total_skipped += 1
                continue
            records.append(rec)
            all_tickers.add(rec["ticker"])

        if not records:
            print(f"[empty] {os.path.basename(path)}: 0 valid rows")
            per_file[path] = 0
            continue

        # Upsert in chunks so a single bad row doesn't fail the whole batch.
        chunk = 100
        loaded = 0
        for i in range(0, len(records), chunk):
            batch = records[i : i + chunk]
            try:
                sb.table("transactions").upsert(
                    batch, on_conflict="user_id,order_id"
                ).execute()
                loaded += len(batch)
            except Exception as e:
                print(f"  [batch fail] {os.path.basename(path)} rows {i}-{i+len(batch)}: {e!r}")
        per_file[path] = loaded
        total_loaded += loaded
        print(f"[ok]   {os.path.basename(path)}: {loaded} rows upserted")

    print("\n" + "=" * 60)
    print(f"Imported: {total_loaded} rows across {len(per_file)} files")
    print(f"Skipped:  {total_skipped} rows (missing/invalid fields)")
    print(f"Unique tickers seen: {len(all_tickers)}")
    print(f"Tickers: {sorted(all_tickers)}")
    return {
        "loaded": total_loaded,
        "skipped": total_skipped,
        "tickers": sorted(all_tickers),
        "per_file": per_file,
    }


def main():
    args = sys.argv[1:]
    if not args:
        print(
            "Usage: python -m fetchers.import_indmoney_transactions "
            "<file.xlsx> [file2.xlsx ...]"
        )
        sys.exit(2)
    user_id = os.getenv("ARCEMX_USER_ID", "default")
    paths = _expand_paths(args)
    if not paths:
        print("No matching files.")
        sys.exit(2)
    print(f"Importing {len(paths)} file(s) for user_id={user_id}:")
    for p in paths:
        print(f"  - {p}")
    print()
    import_files(paths, user_id=user_id)


if __name__ == "__main__":
    main()

"""Sync the user's US stock holdings from INDmoney into Supabase us_holdings.

Read-only against INDmoney: uses the same authorized MCP session and shared
Supabase-backed OAuth token as fetchers/indmoney_mcp.sync_to_supabase, and
only the networth_holdings tool with asset_type=US_STOCK. The MCP exposes no
US order tool, so nothing here can place or change a trade.

Deliberately NOT routed through analyzer/ or fetchers/indmoney_mcp's India
path: US symbols are stored exactly as INDmoney returns them (plain, never
".NS"-suffixed) in their own table, so a ticker like TSM can never be
mistaken for an NSE symbol by any India code.

Values from INDmoney arrive in INR (the account is funded via LRS), so
invested/value/pnl columns are *_inr. Original per-row payload is kept in
`raw` so a schema change on INDmoney's side does not lose data.

Run: python -m us.holdings_sync   (needs SUPABASE_URL/KEY, TELEGRAM_CHAT_ID)
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv
from supabase import create_client

from fetchers.indmoney_mcp import _refresh_tokens_if_needed, call_tool

load_dotenv()


def _num(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _to_row(user_id: str, h: dict) -> dict | None:
    ticker = (h.get("investment_code") or "").strip().upper()
    if not ticker:
        return None
    return {
        "user_id": user_id,
        "ticker": ticker,
        "name": h.get("investment"),
        "units": _num(h.get("total_units")),
        "invested_inr": _num(h.get("invested_amount")),
        "value_inr": _num(h.get("market_value")),
        "pnl_inr": _num(h.get("total_pnl")),
        "pnl_pct": _num(h.get("pnl_per")),
        "one_day_change_inr": _num(h.get("one_day_change")),
        "broker": h.get("broker"),
        "raw": h,
        "synced_at": "now()",
    }


async def fetch_us_holdings(user_id: str) -> list[dict]:
    """Raw US_STOCK holdings rows. Proactive token refresh first, same as
    sync_to_supabase: the MCP SDK's own auto-refresh is documented as
    unreliable with our Supabase token storage."""
    await _refresh_tokens_if_needed(user_id)
    out = await call_tool("networth_holdings", {"asset_type": "US_STOCK"}, user_id=user_id)
    rows = out.get("holdings") if isinstance(out, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError(f"unexpected networth_holdings response shape: {type(out).__name__}")
    return rows


async def sync_us_holdings(user_id: str | None = None) -> int:
    user_id = user_id or os.getenv("TELEGRAM_CHAT_ID", "default")
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL/SUPABASE_KEY missing")
    sb = create_client(url, key)

    rows = [r for r in (_to_row(user_id, h) for h in await fetch_us_holdings(user_id)) if r]
    for r in rows:
        sb.table("us_holdings").upsert(r, on_conflict="user_id,ticker").execute()

    # Drop positions no longer held (sold in the app). Skipped when INDmoney
    # returns nothing: an empty answer can be transient, and wiping the table
    # on a blip is worse than showing a stale row for a day.
    if rows:
        live = {r["ticker"] for r in rows}
        existing = sb.table("us_holdings").select("ticker").eq("user_id", user_id).execute().data or []
        for stale in {e["ticker"] for e in existing} - live:
            sb.table("us_holdings").delete().eq("user_id", user_id).eq("ticker", stale).execute()
            print(f"  pruned sold position: {stale}")

    print(f"Synced: {len(rows)} US holdings ({', '.join(r['ticker'] for r in rows) or 'none'})")
    return len(rows)


if __name__ == "__main__":
    asyncio.run(sync_us_holdings())

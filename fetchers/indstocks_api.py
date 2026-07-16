"""INDstocks Trading API client. Real-money order placement, gated by callers.

Base URL and endpoint shapes verified live 2026-07-13 from api-docs.indstocks.com.
This module never places an order on its own; callers (bot/telegram_bot.py) own
every safety gate. The access token is a live trading credential: never logged,
never echoed back, stored only in mcp_tokens (RLS, no anon policy).
"""
import csv
import io
from datetime import datetime, timedelta, timezone

import requests

BASE = "https://api.indstocks.com"
PROVIDER = "indstocks"


class IndstocksError(Exception):
    pass


class IndstocksClient:
    def __init__(self, sb, user_id: str = "default"):
        self._sb = sb
        self.user_id = user_id
        self._token_row = None

    def _row(self) -> dict | None:
        try:
            res = (
                self._sb.table("mcp_tokens")
                .select("*")
                .eq("provider", PROVIDER)
                .eq("user_id", self.user_id)
                .limit(1)
                .execute()
            )
            return res.data[0] if res.data else None
        except Exception as e:
            print(f"indstocks token read fail: {e}")
            return None

    def token_age_hours(self) -> float | None:
        row = self._row()
        if not row or not row.get("updated_at"):
            return None
        try:
            updated = datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00"))
        except Exception:
            return None
        return (datetime.now(timezone.utc) - updated).total_seconds() / 3600.0

    def _token(self) -> str | None:
        row = self._row()
        if not row or not row.get("tokens"):
            return None
        age = self.token_age_hours()
        if age is None or age > 24:
            return None
        return row["tokens"].get("access_token")

    def _headers(self) -> dict:
        token = self._token()
        return {"Authorization": token or "", "Content-Type": "application/json"}

    def store_token(self, token: str):
        payload = {
            "provider": PROVIDER,
            "user_id": self.user_id,
            "tokens": {"access_token": token},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self._sb.table("mcp_tokens").upsert(payload, on_conflict="provider,user_id").execute()

    def _get(self, path: str, params: dict | None = None):
        r = requests.get(f"{BASE}{path}", headers=self._headers(), params=params, timeout=15)
        if r.status_code != 200:
            raise IndstocksError(r.text[:200])
        return r.json()

    def _post(self, path: str, body: dict):
        r = requests.post(f"{BASE}{path}", headers=self._headers(), json=body, timeout=15)
        if r.status_code != 200:
            raise IndstocksError(r.text[:200])
        return r.json()

    def funds(self) -> dict:
        return self._get("/funds")

    def holdings(self) -> list:
        return self._get("/portfolio/holdings")

    def order_book(self) -> list:
        return self._get("/order-book")

    def ltp(self, security_id: str) -> float | None:
        # ASSUMPTION: exact query param shape undocumented in our notes; using
        # security_id/exchange/segment. Adjust here if the real API rejects it.
        try:
            data = self._get(
                "/market/quotes/ltp",
                params={"security_id": security_id, "exchange": "NSE", "segment": "EQUITY"},
            )
        except IndstocksError:
            return None
        try:
            return float(data["data"]["ltp"])
        except Exception:
            try:
                return float(data["ltp"])
            except Exception:
                return None

    def resolve_security_id(self, symbol_root: str) -> str | None:
        cached = (
            self._sb.table("instrument_map")
            .select("security_id")
            .eq("symbol_root", symbol_root)
            .limit(1)
            .execute()
        )
        if cached.data:
            return cached.data[0]["security_id"]

        r = requests.get(f"{BASE}/market/instruments", headers=self._headers(), timeout=60)
        if r.status_code != 200:
            raise IndstocksError(r.text[:200])

        # ASSUMPTION: CSV column names undocumented in our notes; detect by
        # header inspection (symbol/trading + security/id substrings).
        reader = csv.DictReader(io.StringIO(r.text))
        fieldnames = reader.fieldnames or []
        symbol_col = next(
            (c for c in fieldnames if "symbol" in c.lower() or "trading" in c.lower()), None
        )
        security_col = next(
            (c for c in fieldnames if "security" in c.lower() or c.lower() == "id"), None
        )
        exchange_col = next((c for c in fieldnames if "exchange" in c.lower()), None)
        if not symbol_col or not security_col:
            return None

        for row in reader:
            if row.get(symbol_col, "").strip().upper() != symbol_root.upper():
                continue
            if exchange_col and row.get(exchange_col, "").strip().upper() not in ("NSE", ""):
                continue
            security_id = row.get(security_col, "").strip()
            if not security_id:
                continue
            self._sb.table("instrument_map").upsert(
                {
                    "symbol_root": symbol_root,
                    "security_id": security_id,
                    "exchange": "NSE",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="symbol_root",
            ).execute()
            return security_id
        return None

    def place_gtt_buy(
        self, security_id: str, qty: int, limit_price: float, sl: float, tgt: float
    ) -> dict:
        body = {
            "txn_type": "BUY",
            "exchange": "NSE",
            "segment": "EQUITY",
            "product": "CNC",
            "order_type": "LIMIT",
            "validity": "DAY",
            "security_id": security_id,
            "qty": qty,
            "algo_id": "99999",
            "limit_price": limit_price,
            "sl_trigger_price": sl,
            "sl_limit_price": round(sl * 0.998, 1),
            "tgt_trigger_price": tgt,
            "tgt_limit_price": round(tgt * 0.998, 1),
        }
        data = self._post("/smart/order", body)
        return data["data"]["order_data"][0]

    def cancel_order(self, order_id: str) -> dict:
        return self._post("/smart/order/cancel", {"order_id": order_id, "segment": "EQUITY"})

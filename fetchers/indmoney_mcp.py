"""INDmoney MCP client. OAuth 2.1 via local callback server."""
import os
import json
import asyncio
import urllib.parse
from pathlib import Path
from dotenv import load_dotenv

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import OAuthClientMetadata, OAuthToken, OAuthClientInformationFull
from supabase import create_client

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]

MCP_URL = os.getenv("INDMONEY_MCP_URL", "https://mcp.indmoney.com/mcp")
TOKEN_FILE = ROOT / os.getenv("INDMONEY_TOKEN_FILE", ".indmoney_tokens.json")
CALLBACK_PORT = 3030


class FileTokenStorage:
    """Local-only fallback (used if no Supabase env)."""

    def __init__(self, path: Path):
        self.path = path
        self.client_path = path.with_suffix(".client.json")

    async def get_tokens(self):
        if not self.path.exists():
            return None
        try:
            return OAuthToken(**json.loads(self.path.read_text()))
        except Exception:
            return None

    async def set_tokens(self, tokens):
        self.path.write_text(json.dumps(tokens.model_dump(mode="json")))

    async def get_client_info(self):
        if not self.client_path.exists():
            return None
        try:
            return OAuthClientInformationFull(**json.loads(self.client_path.read_text()))
        except Exception:
            return None

    async def set_client_info(self, info):
        self.client_path.write_text(json.dumps(info.model_dump(mode="json")))


class SupabaseTokenStorage:
    """OAuth tokens persisted in Supabase mcp_tokens table. Works across hosts."""

    PROVIDER = "indmoney"

    def __init__(self, user_id: str = "default"):
        self.user_id = user_id
        self._sb = None

    def _client(self):
        if self._sb is None:
            url = os.getenv("SUPABASE_URL")
            key = os.getenv("SUPABASE_KEY")
            if not url or not key:
                raise RuntimeError("SUPABASE_URL/SUPABASE_KEY missing")
            self._sb = create_client(url, key)
        return self._sb

    def _row(self) -> dict | None:
        try:
            res = self._client().table("mcp_tokens").select("*").eq(
                "provider", self.PROVIDER
            ).eq("user_id", self.user_id).limit(1).execute()
            return res.data[0] if res.data else None
        except Exception as e:
            print(f"Supabase read fail: {e}")
            return None

    def _upsert(self, fields: dict):
        payload = {
            "provider": self.PROVIDER,
            "user_id": self.user_id,
            "updated_at": "now()",
            **fields,
        }
        self._client().table("mcp_tokens").upsert(
            payload, on_conflict="provider,user_id"
        ).execute()

    async def get_tokens(self):
        row = self._row()
        if not row or not row.get("tokens"):
            return None
        try:
            return OAuthToken(**row["tokens"])
        except Exception as e:
            print(f"Token parse fail: {e}")
            return None

    async def set_tokens(self, tokens):
        self._upsert({"tokens": tokens.model_dump(mode="json")})

    async def get_client_info(self):
        row = self._row()
        if not row or not row.get("client_info"):
            return None
        try:
            return OAuthClientInformationFull(**row["client_info"])
        except Exception as e:
            print(f"Client info parse fail: {e}")
            return None

    async def set_client_info(self, info):
        self._upsert({"client_info": info.model_dump(mode="json")})


def _pick_storage(user_id: str = "default"):
    """Use Supabase if configured, else local file."""
    if os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_KEY"):
        return SupabaseTokenStorage(user_id=user_id)
    return FileTokenStorage(TOKEN_FILE)


async def _capture_callback() -> tuple[str, str]:
    """Run tiny HTTP server on localhost:3030 → capture code+state from redirect."""
    captured: dict = {}
    done = asyncio.Event()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await reader.readline()
            line = request_line.decode(errors="ignore").strip()
            # e.g. "GET /callback?code=XXX&state=YYY HTTP/1.1"
            if "GET " in line:
                path = line.split(" ")[1]
                if "?" in path:
                    qs = path.split("?", 1)[1]
                    params = urllib.parse.parse_qs(qs)
                    captured["code"] = params.get("code", [None])[0]
                    captured["state"] = params.get("state", [None])[0]
            # drain headers
            while True:
                ln = await reader.readline()
                if ln in (b"\r\n", b"\n", b""):
                    break
            body = (
                "<html><body><h2>Arc'emX! auth complete.</h2>"
                "<p>You can close this tab and return to PowerShell.</p></body></html>"
            )
            resp = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/html\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n" + body
            )
            writer.write(resp.encode())
            await writer.drain()
        finally:
            writer.close()
            done.set()

    server = await asyncio.start_server(handle, "127.0.0.1", CALLBACK_PORT)
    try:
        await asyncio.wait_for(done.wait(), timeout=300)
    finally:
        server.close()
        await server.wait_closed()
    return captured.get("code"), captured.get("state")


def _build_auth_sync(user_id: str = "default"):
    storage = _pick_storage(user_id)

    is_headless = bool(os.getenv("RENDER") or os.getenv("ARCEMX_NO_BROWSER"))

    async def redirect_handler(url: str):
        if is_headless:
            raise RuntimeError(
                "INDmoney OAuth re-auth required. Tokens expired or revoked. "
                "Re-run `python -m fetchers.indmoney_auth` locally to refresh."
            )
        import webbrowser
        print(f"\nAuthorize INDmoney in browser:\n{url}\n")
        webbrowser.open(url)

    async def callback_handler():
        if is_headless:
            raise RuntimeError("Headless host cannot run interactive OAuth flow.")
        print("Waiting for browser callback on http://localhost:3030/callback ...")
        code, state = await _capture_callback()
        if not code:
            raise RuntimeError("No 'code' in callback URL")
        print("Callback received.")
        return code, state

    return OAuthClientProvider(
        server_url=MCP_URL,
        client_metadata=OAuthClientMetadata(
            client_name="arcemx-bot",
            redirect_uris=[f"http://localhost:{CALLBACK_PORT}/callback"],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            scope="portfolio:read",
        ),
        storage=storage,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )


async def _build_auth(user_id: str = "default"):
    return _build_auth_sync(user_id)


async def call_tool(tool_name: str, args: dict, user_id: str = "default") -> dict:
    auth = _build_auth_sync(user_id)
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, args)
            return _extract(result)


def _extract(result) -> dict:
    if not result.content:
        return {}
    for item in result.content:
        if hasattr(item, "text"):
            try:
                return json.loads(item.text)
            except json.JSONDecodeError:
                return {"raw": item.text}
    return {}


async def fetch_holdings(asset_type: str = "IND_STOCK") -> list[dict]:
    out = await call_tool("networth_holdings", {"asset_type": asset_type})
    if isinstance(out, dict):
        return out.get("holdings") or []
    return out or []


async def fetch_watchlist_flat() -> list[dict]:
    """Flatten all watchlists into [{ticker, ind_key}]. Filter nulls."""
    out = await call_tool("user_watchlist", {})
    flat = []
    if not isinstance(out, dict):
        return flat
    for wl in out.get("watchlists", []):
        for s in wl.get("stocks", []):
            tk = s.get("ticker")
            if tk:
                flat.append({"ticker": tk, "ind_key": s.get("ind_key", "")})
    return flat


async def fetch_networth() -> dict:
    return await call_tool("networth_snapshot", {})


async def _lookup_ticker(session, name: str) -> str | None:
    """Use lookup_ind_keys MCP tool to map company name → NSE ticker."""
    try:
        r = await session.call_tool("lookup_ind_keys", {"query": name})
        data = _extract(r)
        if isinstance(data, dict):
            results = data.get("results") or data.get("data") or []
            if isinstance(data.get("ind_key"), str):
                return data["ind_key"]
            for item in results:
                if isinstance(item, dict):
                    tk = item.get("ticker") or item.get("nse_symbol") or item.get("symbol")
                    if tk:
                        return tk
        if isinstance(data, list) and data:
            first = data[0]
            return first.get("ticker") or first.get("symbol") if isinstance(first, dict) else None
    except Exception as e:
        print(f"lookup_ind_keys fail '{name}': {e}")
    return None


def to_yf(ticker: str) -> str:
    """`SUZLON` → `SUZLON.NS`. `NSE:RELIANCE` → `RELIANCE.NS`."""
    if not ticker:
        return ticker
    if ticker.endswith(".NS") or ticker.endswith(".BO"):
        return ticker
    if ":" in ticker:
        exch, sym = ticker.split(":", 1)
        if exch.upper() == "NSE":
            return f"{sym}.NS"
        if exch.upper() == "BSE":
            return f"{sym}.BO"
        return sym
    return f"{ticker}.NS"


# Manual fallback map: INDmoney company name → NSE ticker
# Add more as you discover them.
NAME_TO_NSE = {
    "Angel One Ltd": "ANGELONE",
    "Eternal Ltd": "ETERNAL",
    "Suzlon Energy Ltd": "SUZLON",
    "Waaree Renewable Technologies Ltd": "WAAREERTL",
    "Billionbrains Garage Ventures Ltd": "GROWW",
    "Reliance Industries Ltd": "RELIANCE",
    "Tata Consultancy Services Ltd": "TCS",
    "HDFC Bank Ltd": "HDFCBANK",
    "Infosys Ltd": "INFY",
    "ICICI Bank Ltd": "ICICIBANK",
    "State Bank of India": "SBIN",
    "Bharti Airtel Ltd": "BHARTIARTL",
    "Adani Power Ltd": "ADANIPOWER",
    "Adani Green Energy Ltd": "ADANIGREEN",
    "Tata Power Co Ltd": "TATAPOWER",
    "NTPC Ltd": "NTPC",
    "Power Grid Corporation of India Ltd": "POWERGRID",
    "Vedanta Ltd": "VEDL",
    "Ambuja Cements Ltd": "AMBUJACEM",
    "Ather Energy Ltd": "ATHERENERG",
}


async def _refresh_tokens_if_needed(user_id: str) -> bool:
    """Manually refresh access token via INDmoney token endpoint.
    Bypasses SDK auto-refresh which doesn't work reliably with our storage.
    Returns True if tokens valid after this call.
    """
    import httpx
    import time

    storage = SupabaseTokenStorage(user_id=user_id)
    row = storage._row()
    if not row or not row.get("tokens"):
        return False
    tokens = row["tokens"]
    client_info = row.get("client_info") or {}

    refresh_token = tokens.get("refresh_token")
    client_id = client_info.get("client_id")
    if not refresh_token or not client_id:
        print("Missing refresh_token or client_id")
        return False

    # Check if access likely still valid (updated_at + expires_in - 60s buffer)
    try:
        from datetime import datetime, timezone
        updated_at = datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00"))
        expires_in = int(tokens.get("expires_in", 3600))
        if datetime.now(timezone.utc).timestamp() < updated_at.timestamp() + expires_in - 60:
            print(f"Access token still valid for user {user_id}, skipping refresh")
            return True
    except Exception:
        pass

    # Discover token endpoint
    discovery_url = MCP_URL.rstrip("/").rsplit("/", 1)[0] + "/.well-known/oauth-authorization-server"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            disc = await client.get(discovery_url)
            disc.raise_for_status()
            token_endpoint = disc.json().get("token_endpoint")
        except Exception as e:
            print(f"Discovery failed: {e}")
            # Fallback common endpoint
            token_endpoint = MCP_URL.rstrip("/").rsplit("/", 1)[0] + "/token"

        # Hit token endpoint with refresh_token grant
        data = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        }
        client_secret = client_info.get("client_secret")
        if client_secret:
            data["client_secret"] = client_secret

        try:
            r = await client.post(token_endpoint, data=data,
                                  headers={"Content-Type": "application/x-www-form-urlencoded"})
            if r.status_code != 200:
                print(f"Token refresh failed: {r.status_code} {r.text[:200]}")
                return False
            new_tokens = r.json()
            # Preserve refresh_token if not returned (common OAuth practice)
            if "refresh_token" not in new_tokens and refresh_token:
                new_tokens["refresh_token"] = refresh_token
            # Persist via direct DB update
            sb = storage._client()
            sb.table("mcp_tokens").update({
                "tokens": new_tokens,
                "updated_at": "now()",
            }).eq("provider", "indmoney").eq("user_id", user_id).execute()
            print(f"Token refreshed for user {user_id}")
            return True
        except Exception as e:
            print(f"Token refresh error: {e}")
            return False


async def sync_to_supabase(user_id: str = "default"):
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    sb = create_client(url, key)

    # Proactively refresh access token before MCP session
    refreshed = await _refresh_tokens_if_needed(user_id)
    if not refreshed:
        raise RuntimeError(
            "INDmoney tokens expired or refresh failed. Run "
            "`python -m fetchers.indmoney_auth` locally to re-authorize."
        )

    auth = _build_auth_sync(user_id)
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # ----- Watchlist (clean tickers already) -----
            print("Fetching INDmoney watchlist...")
            wl_resp = await session.call_tool("user_watchlist", {})
            wl_data = _extract(wl_resp)
            code_to_ticker: dict[str, str] = {}
            n_w = 0
            for wl in wl_data.get("watchlists", []):
                for s in wl.get("stocks", []):
                    tk = s.get("ticker")
                    code = s.get("ind_key", "")
                    if not tk:
                        continue
                    # INDS* = Indian (NSE, add .NS). Else = US (raw ticker).
                    if code.startswith("INDS"):
                        ticker = to_yf(tk)
                    else:
                        ticker = tk
                    try:
                        sb.table("wishlist").upsert({
                            "user_id": user_id, "ticker": ticker
                        }, on_conflict="user_id,ticker").execute()
                        n_w += 1
                        if code.startswith("INDS"):
                            code_to_ticker[code] = tk
                    except Exception as e:
                        print(f"wishlist fail {tk}: {e}")

            # ----- Holdings -----
            # INDmoney's MCP occasionally returns HTTP 512 / service_error
            # for /v1/holdings/ from Render's IP range. Retry a couple of
            # times before giving up; on persistent failure raise so the
            # caller (Telegram bot) can surface the actual cause.
            print("Fetching INDmoney holdings...")
            holdings: list = []
            last_error_msg: str | None = None
            for attempt in range(1, 4):
                h_resp = await session.call_tool(
                    "networth_holdings", {"asset_type": "IND_STOCK"}
                )
                h_data = _extract(h_resp)
                # When INDmoney upstream errors the MCP wraps it as
                # {"error": "service_error", "message": "API returned 512: ..."}
                # rather than a holdings array. Detect both shapes.
                if isinstance(h_data, dict) and h_data.get("error"):
                    last_error_msg = h_data.get("message") or str(h_data)
                    print(
                        f"[attempt {attempt}/3] INDmoney holdings error: "
                        f"{last_error_msg}"
                    )
                    if attempt < 3:
                        await asyncio.sleep(2 * attempt)
                        continue
                    raise RuntimeError(
                        "INDmoney holdings API is rate-limiting this host. "
                        f"Last error: {last_error_msg}. Try again in a few "
                        "minutes, or run `python -m fetchers.indmoney_mcp` "
                        "locally."
                    )
                holdings = h_data.get("holdings", []) if isinstance(h_data, dict) else []
                print(
                    f"[debug] holdings parse: type={type(h_data).__name__} "
                    f"keys={list(h_data.keys())[:10] if isinstance(h_data, dict) else 'N/A'} "
                    f"holdings_len={len(holdings)}"
                )
                if holdings:
                    break
                # Empty array without an error string. also retry once.
                if attempt < 3:
                    print(f"[attempt {attempt}/3] holdings empty, retrying...")
                    await asyncio.sleep(2 * attempt)
                    continue
            n_h = 0
            for h in holdings:
                name = h.get("investment", "")
                code = h.get("investment_code", "")
                qty = float(h.get("total_units") or 0)
                invested = float(h.get("invested_amount") or 0)
                if qty <= 0 or invested <= 0:
                    continue
                avg = invested / qty

                # Resolve ticker: code lookup → name map → MCP lookup
                raw_ticker = code_to_ticker.get(code) or NAME_TO_NSE.get(name)
                if not raw_ticker:
                    raw_ticker = await _lookup_ticker(session, name)
                if not raw_ticker:
                    print(f"⚠️  No ticker mapping for: {name} (code {code}). skip")
                    continue

                ticker = to_yf(raw_ticker)
                try:
                    sb.table("portfolio").upsert({
                        "user_id": user_id, "ticker": ticker,
                        "qty": qty, "avg_buy_price": round(avg, 2),
                    }, on_conflict="user_id,ticker").execute()
                    n_h += 1
                    print(f"  ✓ {ticker}: {qty:g} units @ ₹{avg:.2f}")
                except Exception as e:
                    print(f"holding upsert fail {ticker}: {e}")

    # Log sync timestamp
    try:
        sb.table("sync_log").insert({
            "user_id": user_id,
            "source": "manual",
            "ok": True,
        }).execute()
    except Exception as e:
        print(f"sync_log insert fail: {e}")

    print(f"\nSynced: {n_h} holdings, {n_w} watchlist items")
    return {"holdings": n_h, "watchlist": n_w}


if __name__ == "__main__":
    uid = os.getenv("TELEGRAM_CHAT_ID", "default")
    asyncio.run(sync_to_supabase(user_id=uid))

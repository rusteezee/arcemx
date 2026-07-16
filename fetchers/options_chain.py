"""NIFTY options-chain signals via the INDmoney MCP tool
get_indian_stocks_option_chain (blueprint 05). Reuses the OAuth client
machinery in fetchers/indmoney_mcp.py - same Supabase-backed token
storage the daily portfolio sync already depends on, so this rides
the user's existing OAuth session rather than a fresh auth flow.

Probe-first: the tool's real response shape was unknown going in, and
the blueprint's own assumed arg names (symbol=, query=) were wrong -
see fetchers/probe_option_chain.json for the captured raw sample and
the __main__ block below for how the real shape was discovered:
  - get_indian_stocks_option_chain takes ind_key + use_expiry_date
    (bool, required) + optional expiry_date/strikes_around_atm - NOT
    a bare symbol string.
  - lookup_ind_keys takes names (a list), not query.
  - NIFTY 50's ind_key is "INDI00012", resolved live 2026-07-16 and
    hardcoded below so production calls don't re-resolve it every run.
"""
import asyncio
import json
import os
import time

from dotenv import load_dotenv

from fetchers.indmoney_mcp import (
    ClientSession,
    _build_auth_sync,
    _extract,
    call_tool,
    streamablehttp_client,
    MCP_URL,
)

load_dotenv()

NIFTY_IND_KEY = "INDI00012"  # "NIFTY 50", resolved via lookup_ind_keys, verified live 2026-07-16
_RETRIES = 3


def _classify_pcr(pcr: float) -> str:
    if pcr > 1.2:
        return "put-heavy, supportive"
    if pcr < 0.8:
        return "call-heavy, capped upside"
    return "balanced"


def fetch_options_signals(symbols: list[str] | None = None) -> dict | None:
    """NIFTY options-chain read: PCR (total put OI / total call OI across
    the nearest expiry), OI-implied support/resistance walls (top 2
    strikes by call OI and by put OI), and the max-pain strike (the
    strike minimizing total option-buyer payout across every listed
    strike). 3-retry on the mirror's occasional 512s (same pattern as
    indmoney_mcp.sync_to_supabase); returns None on total failure or
    any parse gap so the payload simply omits the key rather than
    embedding a partial read.

    ASSUMPTION: `symbols` is accepted for future per-ticker extension
    but unused today - the blueprint's GOAL/DoD both scope this
    strictly to NIFTY ("optionally the user's holdings" is aspirational
    phrasing, not something the DoD checklist actually tests)."""
    user_id = os.getenv("TELEGRAM_CHAT_ID", "default")
    args = {"ind_key": NIFTY_IND_KEY, "use_expiry_date": False, "strikes_around_atm": 7}

    data = None
    last_error = None
    for attempt in range(1, _RETRIES + 1):
        try:
            resp = asyncio.run(call_tool("get_indian_stocks_option_chain", args, user_id=user_id))
        except Exception as e:
            resp = None
            last_error = str(e)
        if isinstance(resp, dict) and resp.get("option_chain_data") and not resp.get("error") and not resp.get("raw"):
            data = resp
            break
        if isinstance(resp, dict):
            last_error = resp.get("message") or resp.get("raw") or str(resp)[:200]
        if attempt < _RETRIES:
            time.sleep(2 * attempt)
    if data is None:
        print(f"options_chain fetch fail after {_RETRIES} attempts: {last_error}")
        return None

    try:
        chain = data.get("option_chain_data") or []
        if not chain:
            return None
        spot = (data.get("entity_details") or {}).get("live_price")
        expiry_raw = data.get("selected_expiry")  # e.g. "20260721"
        expiry = (
            f"{expiry_raw[:4]}-{expiry_raw[4:6]}-{expiry_raw[6:8]}"
            if expiry_raw and len(expiry_raw) == 8 else expiry_raw
        )

        total_call_oi = sum((r.get("call_data") or {}).get("oi") or 0 for r in chain)
        total_put_oi = sum((r.get("put_data") or {}).get("oi") or 0 for r in chain)
        if not total_call_oi:
            return None
        pcr = round(total_put_oi / total_call_oi, 3)

        call_walls = [r["strike_price"] for r in
                     sorted(chain, key=lambda r: -((r.get("call_data") or {}).get("oi") or 0))[:2]]
        put_walls = [r["strike_price"] for r in
                    sorted(chain, key=lambda r: -((r.get("put_data") or {}).get("oi") or 0))[:2]]

        strikes = [r["strike_price"] for r in chain]
        best_k, best_payout = None, None
        for k in strikes:
            payout = 0.0
            for r in chain:
                call_oi = (r.get("call_data") or {}).get("oi") or 0
                payout += call_oi * max(0, k - r["strike_price"])
            for r in chain:
                put_oi = (r.get("put_data") or {}).get("oi") or 0
                payout += put_oi * max(0, r["strike_price"] - k)
            if best_payout is None or payout < best_payout:
                best_payout, best_k = payout, k

        if spot is None or best_k is None or not call_walls or not put_walls:
            return None

        nearest_call_wall = min(call_walls, key=lambda k: abs(k - spot))
        read = f"PCR {pcr:.2f}, {_classify_pcr(pcr)}; heavy call OI at {nearest_call_wall}"

        return {
            "pcr": pcr,
            "expiry": expiry,
            "call_walls": call_walls,
            "put_walls": put_walls,
            "max_pain": best_k,
            "spot": spot,
            "read": read,
        }
    except Exception as e:
        print(f"options_chain parse fail: {e}")
        return None


if __name__ == "__main__":
    async def _probe():
        """Discovery script (kept for reference / future re-probing if
        the mirror's schema ever changes). Connects directly instead of
        via call_tool() so it can also call list_tools() + lookup_ind_keys
        in the same session."""
        user_id = os.getenv("TELEGRAM_CHAT_ID", "default")
        auth = _build_auth_sync(user_id)
        async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()

                tools = await session.list_tools()
                print("Available tools:", [t.name for t in tools.tools])
                target = next((t for t in tools.tools if t.name == "get_indian_stocks_option_chain"), None)
                if target:
                    print("get_indian_stocks_option_chain inputSchema:",
                          json.dumps(target.inputSchema, indent=2))

                print("\nresolving NIFTY ind_key via lookup_ind_keys...")
                lk_resp = await session.call_tool("lookup_ind_keys", {"names": ["NIFTY", "NIFTY 50"]})
                lk_data = _extract(lk_resp)
                print("lookup_ind_keys raw:", json.dumps(lk_data, indent=2, default=str)[:1500])

                args = {"ind_key": NIFTY_IND_KEY, "use_expiry_date": False, "strikes_around_atm": 7}
                print(f"\ncalling get_indian_stocks_option_chain with {args}")
                resp = await session.call_tool("get_indian_stocks_option_chain", args)
                data = _extract(resp)
                print("top-level keys:", list(data.keys()) if isinstance(data, dict) else type(data))
                with open("fetchers/probe_option_chain.json", "w", encoding="utf-8") as f:
                    json.dump({"_call_args": args, **data}, f, indent=2, default=str)
                print("saved to fetchers/probe_option_chain.json")

    asyncio.run(_probe())
    print()
    print(json.dumps(fetch_options_signals(), indent=2, default=str))

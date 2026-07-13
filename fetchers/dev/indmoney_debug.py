"""Debug: dump raw INDmoney MCP responses to see actual JSON structure."""
import asyncio
import json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from fetchers.indmoney_mcp import _build_auth_sync, MCP_URL


async def main():
    auth = _build_auth_sync()
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            print("\n=== networth_holdings(IND_STOCK) ===")
            r = await session.call_tool("networth_holdings", {"asset_type": "IND_STOCK"})
            for item in r.content:
                if hasattr(item, "text"):
                    try:
                        print(json.dumps(json.loads(item.text), indent=2)[:3000])
                    except Exception:
                        print(item.text[:3000])

            print("\n\n=== user_watchlist() ===")
            r = await session.call_tool("user_watchlist", {})
            for item in r.content:
                if hasattr(item, "text"):
                    try:
                        print(json.dumps(json.loads(item.text), indent=2)[:3000])
                    except Exception:
                        print(item.text[:3000])

            print("\n\n=== networth_snapshot() ===")
            r = await session.call_tool("networth_snapshot", {})
            for item in r.content:
                if hasattr(item, "text"):
                    try:
                        print(json.dumps(json.loads(item.text), indent=2)[:2000])
                    except Exception:
                        print(item.text[:2000])


if __name__ == "__main__":
    asyncio.run(main())

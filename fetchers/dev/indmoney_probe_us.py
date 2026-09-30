"""Read-only probe: what does the INDmoney MCP expose beyond IND_STOCK?

Lists every tool with a short description, then prints the input schema of
the holdings-type tools so the accepted asset_type values (US stocks etc.)
are read from the server instead of guessed. Writes nothing.

Run on the Oracle box (needs the shared Supabase token + env):
  sudo bash -c 'set -a; source /etc/arcemx.env; set +a; export ARCEMX_NO_BROWSER=1; \
    cd /opt/arcemx && .venv/bin/python -m fetchers.dev.indmoney_probe_us'
"""
import asyncio
import json
import os

from fetchers.indmoney_mcp import (
    ClientSession,
    MCP_URL,
    _build_auth_sync,
    _refresh_tokens_if_needed,
    streamablehttp_client,
)

_SCHEMA_TOOLS = ("networth_holdings", "networth_summary", "user_watchlist")


async def main() -> None:
    uid = os.getenv("TELEGRAM_CHAT_ID", "default")
    await _refresh_tokens_if_needed(uid)
    auth = _build_auth_sync(uid)
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = (await session.list_tools()).tools
            print(f"{len(tools)} tools:")
            for t in tools:
                desc = (t.description or "").replace("\n", " ")[:120]
                print(f"  {t.name} - {desc}")
            for t in tools:
                if t.name in _SCHEMA_TOOLS or "us" in t.name.lower().split("_"):
                    print(f"\n--- inputSchema: {t.name} ---")
                    print(json.dumps(t.inputSchema, indent=1)[:1800])


if __name__ == "__main__":
    asyncio.run(main())

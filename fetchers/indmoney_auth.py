"""One-time OAuth login for INDmoney MCP.

Run: python -m fetchers.indmoney_auth

Opens browser → log in to INDmoney → "Allow access" → redirect captured locally.
Tokens saved to .indmoney_tokens.json (gitignored).
After this, all bot/cron calls use saved refresh token automatically.
"""
import asyncio
import os
from pathlib import Path
from dotenv import load_dotenv

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from fetchers.indmoney_mcp import _build_auth, MCP_URL, TOKEN_FILE

load_dotenv()


async def main():
    print(f"INDmoney MCP: {MCP_URL}")
    print(f"Token file:   {TOKEN_FILE}")
    print()
    print("Starting OAuth flow. Browser will open. Log in + authorize.")
    print()

    auth = await _build_auth()
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print(f"\nAuth OK. {len(tools.tools)} tools available:")
            for t in tools.tools:
                print(f"  - {t.name}")
            print(f"\nTokens saved → {TOKEN_FILE}")
            print("You can now run: python -m fetchers.indmoney_mcp")


if __name__ == "__main__":
    asyncio.run(main())

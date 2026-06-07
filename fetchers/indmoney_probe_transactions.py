"""Probe: discover INDmoney MCP tools related to transactions / order
history so we can wire a historical-buy-and-sell ingest for the
Portfolio Value Timeline.

Step 1: lists every tool the authenticated session exposes, with its
input schema. Step 2: tries a hard-coded list of common transaction-y
tool names against the live session and dumps whatever JSON comes
back so we can see field shapes (ticker, qty, price, side, date).

Run from the repo root after auth has been set up:
    python -m fetchers.indmoney_probe_transactions

Paste the entire stdout back into the chat and I'll wire the fetcher
against whichever tool returns the historical ledger.
"""
import asyncio
import json
import sys

# Windows default stdout codec is cp1252, which can't encode Unicode
# characters that show up in INDmoney tool descriptions (e.g. "→").
# Reconfigure stdout / stderr to UTF-8 so the probe never blows up on
# a print, regardless of the host's locale.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from fetchers.indmoney_mcp import _build_auth_sync, MCP_URL


# Common naming patterns brokers / MCP wrappers use for transaction history.
# We try each in turn with an empty arg set, then with asset_type=IND_STOCK
# in case the server requires the same scoping it uses for holdings.
CANDIDATE_TOOLS = [
    "user_transactions",
    "transactions",
    "transaction_history",
    "order_history",
    "user_orders",
    "orders",
    "trade_book",
    "trades",
    "user_trades",
    "networth_transactions",
    "stock_transactions",
    "holdings_transactions",
    "investment_history",
    "portfolio_history",
    "ledger",
    "user_ledger",
]


def _truncate(s: str, n: int = 3000) -> str:
    return s if len(s) <= n else s[:n] + f"\n... [truncated, total {len(s)} chars]"


def _dump_content(content) -> None:
    """Walk the .content list a CallToolResult gives back and pretty-print
    each text item as JSON when possible."""
    for item in content:
        if hasattr(item, "text"):
            try:
                parsed = json.loads(item.text)
                print(_truncate(json.dumps(parsed, indent=2)))
            except Exception:
                print(_truncate(item.text))
        else:
            print(repr(item))


async def main():
    auth = _build_auth_sync()
    async with streamablehttp_client(MCP_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            print("=" * 70)
            print("PART 1 — ALL AVAILABLE MCP TOOLS")
            print("=" * 70)
            try:
                tools_resp = await session.list_tools()
                for t in tools_resp.tools:
                    print(f"\n--- {t.name} ---")
                    if t.description:
                        print(f"description: {t.description.strip()[:400]}")
                    schema = getattr(t, "inputSchema", None)
                    if schema:
                        try:
                            print(
                                "inputSchema: "
                                + json.dumps(schema, indent=2)[:600]
                            )
                        except Exception:
                            print(f"inputSchema (raw): {schema!r}")
            except Exception as e:
                print(f"list_tools failed: {e!r}")

            print("\n\n" + "=" * 70)
            print("PART 2 — PROBING CANDIDATE TRANSACTION TOOLS")
            print("=" * 70)
            for name in CANDIDATE_TOOLS:
                for args_label, args in (
                    ("no args", {}),
                    ("asset_type=IND_STOCK", {"asset_type": "IND_STOCK"}),
                ):
                    print(f"\n>>> call_tool({name!r}, {args_label})")
                    try:
                        r = await session.call_tool(name, args)
                        _dump_content(r.content)
                    except Exception as e:
                        # Tool doesn't exist OR args wrong. We report and move on.
                        msg = str(e)
                        # Trim long stack traces so the report stays readable.
                        if len(msg) > 300:
                            msg = msg[:300] + "..."
                        print(f"  ERROR: {msg}")


if __name__ == "__main__":
    # Tee everything we print into probe.txt with explicit UTF-8 so the
    # PowerShell `>` redirect is no longer required and we never lose
    # Unicode tool descriptions to a host codec mismatch.
    import io
    import builtins

    real_print = builtins.print
    buffer = io.StringIO()

    def tee_print(*args, **kwargs):
        # Mirror to the buffer with the same separators/end as the call.
        text = (kwargs.get("sep", " ") or " ").join(str(a) for a in args)
        end = kwargs.get("end", "\n")
        buffer.write(text + end)
        real_print(*args, **kwargs)

    builtins.print = tee_print
    try:
        asyncio.run(main())
    finally:
        try:
            with open("probe.txt", "w", encoding="utf-8", errors="replace") as f:
                f.write(buffer.getvalue())
            real_print("\n[probe.txt written]")
        except Exception as e:
            real_print(f"\n[probe.txt write failed: {e!r}]")

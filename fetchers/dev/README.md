# fetchers/dev

Discovery scripts, not pipeline. Run manually to probe INDmoney's MCP surface; nothing
here is called by any cron, workflow, or the bot. Kept for reference. `probe.txt`
(one-time output) documents that INDmoney's MCP has no transaction/order-history tool,
which is why `fetchers/import_indmoney_transactions.py` exists as an XLSX-import
fallback instead.

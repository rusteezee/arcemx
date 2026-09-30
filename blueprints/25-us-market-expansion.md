# Blueprint 25: US Market Expansion - PHASE 1 BUILT 2026-09-30, PHASES 2 TO 4 SCOPED

Trigger: the user started investing in US stocks (held via INDmoney's US
partner broker, Alpaca) and asked to extend Arc'emX! to cover them.

## Goal

Cover the user's real US money with the same discipline the India side
has, without touching or destabilising the India pipeline.

## What Discovery Found (live, 2026-09-30)

- INDmoney's MCP already exposes US data on the token the project holds:
  `networth_holdings` accepts `asset_type=US_STOCK`, plus
  `get_us_stocks_details`, `get_us_stocks_ohlc`, `get_us_stocks_movers`,
  `us_stocks_sips`. It is **read-only for US: there is no order tool**, so
  nothing built on it can place or change a trade.
- Current US book: 2 positions (SK Hynix `SKHY`, TSMC `TSM`, fractional
  units), roughly 23,000 INR total. All amounts arrive in INR.
- India coupling is deep: 16 files force-suffix `.NS` onto bare tickers and
  33 files carry NIFTY, NSE, SEBI or INR logic. A US symbol like `TSM`
  pushed through those paths silently becomes `TSM.NS`, a wrong symbol that
  returns wrong or empty data. This project has been burned by exactly that
  bug class before (grader whitespace/ticker normalisation, dead tickers).

## Architecture Decision

**Separate US pipeline, not a retrofit.** New top-level package `us/`, its
own `us_*` tables, its own systemd units, its own market calendar. It
shares only generic utilities (LLM router, Supabase client pattern, metrics
honesty layer). Zero edits to India code paths. Symbols are stored exactly
as INDmoney returns them, never suffixed.

## Phases

**Phase 1 - Foundation, read-only (built).**
- `us/market_calendar.py`: NYSE holidays and 1 PM early closes from NYSE's
  published calendar (`data/nyse_holidays_2026.json`, `_2027.json`),
  DST-correct session bounds in UTC (same 4 PM ET close is 20:00 UTC in
  summer, 21:00 UTC in winter).
- `us/holdings_sync.py`: INDmoney `US_STOCK` holdings into `us_holdings`.
- `arcemx-us-sync` timer: 12:30 UTC (before the open) and 21:30 UTC (after
  the close), Mon to Fri.
- Telegram `/us` built (reads stored rows only, `us/summary.py`).
- Still to do in this phase: dashboard page.
- DDL for `us_holdings` must be applied by hand in the Supabase SQL editor.

**Phase 2 - Information layer (the part with real precedent). BUILT.** The
one genuinely valuable source added on the India side was official exchange
filings (NSE announcements). The US equivalent is SEC EDGAR: free,
official, structured JSON. Filtered to a material allow-list like
`fetchers/nse_announcements.py`, for holdings only.
- `us/sec_filings.py`, timer `arcemx-us-filings` (hourly 11:00 to 23:00 UTC
  Mon to Fri), table `us_events` keyed on accession number.
- Both current holdings (TSM, SKHY) are foreign private issuers: they file
  6-K and 20-F, and the `items` field is empty on every 6-K. So 6-K and 8-K
  text is read and keyword-classified (phrase-level keywords, audited
  against 13 real filings), periodic reports are material by form, 8-K item
  codes are honoured when present.
- Form 3/4 insider parsing is deliberately not built: for a foreign issuer
  the Form 4s under its CIK are its own holdings in other companies, not
  insider trades in it. Add it when a domestic issuer enters the book.
- SEC contact email lives only in `/etc/arcemx.env` (`SEC_CONTACT_EMAIL`),
  never in the repo.
- First real run backfills 30 days silently; only filings up to 3 days old
  send a Telegram alert.

**Phase 3 - US daily brief, no trading.** Pre-open (about 18:00 IST) LLM
brief per holding: hold, add, trim or exit with numeric stop and target,
grounded in US context (SPY, QQQ, SOXX, VIX, DXY, US 10Y, USDINR) plus the
Phase 2 events. Graded after the US close against real session bounds by a
US grader. Verdicts only, nothing executes.

**Phase 4 - Gated.** US paper trading and backtesting only if Phase 3's
graded verdicts show real, deflated edge over enough samples (same honesty
layer and 60-trade gate the India side uses). Real order execution is out
of scope: INDmoney's MCP cannot do it, and a direct broker API is a
separate, explicit decision.

## Honest Expectations

- The India side has not yet proven stock-level edge (lifetime Sharpe -23,
  single-stock direction accuracy below chance, section 26 of the KB).
  Adding a market does not add edge. The US large-cap market is if anything
  more efficient.
- What this can honestly deliver: real monitoring of real US money, better
  information (filings the user would otherwise miss), and a second
  falsifiable test bed. Phase 4 exists so nothing trades on hope.
- FX and tax (USD/INR moves, LRS, TCS, US withholding, capital gains) are
  not modelled anywhere here. Amounts are shown in INR as INDmoney reports
  them, which already embeds the FX move.

## Open Decisions (need the user)

1. RESOLVED 2026-09-30: SEC User-Agent contact is the user's personal
   email, set only in `/etc/arcemx.env`.
2. Whether Phase 3 stays advisory only (recommended) or later feeds a US
   paper book (Phase 4, only after evidence). Working assumption: advisory
   only, the user has not objected.

## Definition Of Done, Phase 1

- Calendar returns correct session bounds across DST and early closes.
- `us_holdings` populated from the live INDmoney response, rows match the
  app, sold positions prune, an empty response does not wipe the table.
- Timer installed and enabled on Oracle, first automatic fire verified.
- No file under `analyzer/` or `bot/` (India pipeline) changed except the
  additive Telegram `/us` command.

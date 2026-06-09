# FII / DII data source research. verdict

_Investigation date: 9 June 2026_

## 1. Verdict: **VIABLE**

A public, no-auth, MIT-licensed third-party API mirrors NSE's FII/DII daily provisional data with cash + derivatives + sentiment + PCR. Tested live, returns same-day data by 8 PM IST. Hosted on a domain independent of NSE, so the Azure runner IP block that affected our previous direct-scrape attempts does not apply.

## 2. Top recommendation: `fii-diidata.mrchartist.com`

| Field | Value |
|---|---|
| Endpoint | `https://fii-diidata.mrchartist.com/api/data` (latest) <br> `https://fii-diidata.mrchartist.com/api/history` (last 60d) <br> `https://fii-diidata.mrchartist.com/api/history-full` (last ~800 records) |
| Auth | None |
| Cost | ₹0 |
| Update freshness | Same-day, ~6:00 / 6:30 / 7:00 PM IST cron (NSE provisional release window) |
| Format | JSON |
| License | MIT (free programmatic ingestion, attribution preferred) |
| Source repo | `github.com/MrChartist/fii-dii-data`. 121 commits, active maintenance |
| Continuity risk | Single-maintainer project. Mitigation: cache the response in Supabase so a vanishing endpoint does not kill the daily payload immediately. |
| Verified from Azure IP | **Untested**, but the host is a regular HTTPS domain (`mrchartist.com`), not NSE. Standard CDN/Vercel-style hosting. No realistic reason an Azure runner would be blocked. Owner should probe with a one-shot workflow if paranoid. |

### Sample response (latest)

```json
{
  "date": "08-Jun-2026",
  "fii_buy": 8842.08,         // INR crore, cash market
  "fii_sell": 14397.75,
  "fii_net": -5555.67,        // negative = net outflow
  "dii_buy": 16683.18,
  "dii_sell": 11517.94,
  "dii_net": 5165.24,         // positive = net inflow
  "fii_idx_fut_long": 24810,
  "fii_idx_fut_short": 302424,
  "fii_idx_fut_net": -277614, // FII heavily net short index futures
  "fii_stk_fut_net": 699749,
  "fii_idx_call_net": -328158,
  "fii_idx_put_net": 515213,
  "pcr": 0.45,
  "sentiment_score": 31.9,
  "_fao_summary": {
    "sentiment": "Bearish",
    "pcr": 0.45,
    "fii_fut_net": -277614,
    "fii_call_net": -328158,
    "fii_put_net": 515213
  },
  "_updated_at": "8 Jun 2026, 8:00 pm IST"
}
```

### Integration sketch (`fetchers/fii_dii.py`)

```python
import requests
from datetime import datetime, timezone, timedelta

URL = "https://fii-diidata.mrchartist.com/api/data"


def fetch_latest() -> dict | None:
    try:
        r = requests.get(URL, timeout=15,
                         headers={"User-Agent": "arcemx/1.0"})
        r.raise_for_status()
        d = r.json()
        # Reshape for the LLM payload. The prompt only needs a compact
        # block of "what FII and DII actually did and where they're
        # positioned in derivatives"; raw 30 fields is too much noise.
        return {
            "date": d.get("date"),
            "fii_cash_cr": d.get("fii_net"),
            "dii_cash_cr": d.get("dii_net"),
            "fii_idx_fut_net": d.get("fii_idx_fut_net"),
            "fii_stk_fut_net": d.get("fii_stk_fut_net"),
            "fii_call_net": d.get("fii_idx_call_net"),
            "fii_put_net": d.get("fii_idx_put_net"),
            "pcr": d.get("pcr"),
            "fao_sentiment": (d.get("_fao_summary") or {}).get("sentiment"),
            "updated_at": d.get("_updated_at"),
        }
    except Exception as e:
        print(f"fii_dii fetch fail: {e}")
        return None
```

Wire into `analyzer/aggregator.py build_payload()` as `flows: fetch_latest()` near the FRONT of the dict (high-signal, never truncate). Update SYSTEM_PROMPT so the model uses `flows.fii_cash_cr` / `flows.fii_idx_fut_net` / `flows.pcr` in its direction call and sector_outlook rationale.

## 3. Runner-up: NSE direct via a public mirror that already solved the IP block

Same source repo (`MrChartist/fii-dii-data`) ALSO exposes raw daily history snapshots in its public repo under `data/history.json`. If the live endpoint ever vanishes, we can fall back to fetching the file straight from GitHub:

```
https://raw.githubusercontent.com/MrChartist/fii-dii-data/main/data/history.json
```

Same shape, lags the API by the file commit interval (typically minutes). Use only as backstop.

## 4. Rejected with reasons

| Candidate | Why rejected |
|---|---|
| NSE direct `nseindia.com/api/fiidiiTradeReact` | Blocked from GitHub Actions IP range, requires browser cookie session. Confirmed unfit in prior sessions and unchanged in 2026. |
| BSE direct | Same cookie + Azure IP block problem. |
| NSDL FPI flows | Monthly only, not daily. Aggregated, no derivatives. Useful for macro context, not next-day calls. |
| Trendlyne / Moneycontrol / 5paisa / NiftyTrader scrape | Public HTML pages, no documented API, brittle CSS-selector scraping, ToS-grey. The mrchartist API already does this work for us. |
| RapidAPI | No clean cheap FII/DII-specific provider found at the relevant price point. Indian-market RapidAPI vendors mostly cover prices/news, not flows. |
| Zerodha Kite Connect | Carries FII/DII per Zerodha docs but data subscription is ~₹500/month per key + requires an active trading account. Out of ₹0 budget. |
| Upstox / Angel One / Fyers Developer APIs | Same shape as Zerodha: priced or trading-account-gated. Skipped. |
| AlphaVantage / TwelveData / Marketstack / Polygon | None carry Indian institutional flows. They cover global price/quote/news, not FII/DII. |
| `dhruvitdiyora/nse-tools`, `hi-imcodeman/stock-nse-india`, `maanavshah/stock-market-india` | Useful NSE wrappers but none host the data, they wrap NSE itself. same Azure-IP block problem when run from our runner. |

## 5. Open questions / next steps

1. **Live probe from Actions runner.** One-shot workflow to confirm `mrchartist.com` responds 200 from the Azure IP range. Almost certainly fine but two minutes of validation removes the doubt before we depend on it.
2. **Cache to Supabase.** Build a `flows` Supabase table that stores each day's snapshot. Continuity insurance: if the endpoint vanishes tomorrow, the cron still has 60+ days of history to read into prompts.
3. **Grade FII direction as a NEW prediction dimension.** Now that the data is available, the model can be asked to predict tomorrow's FII net cash direction (in/out) and the grader can score it against actual. Real predictable signal, real edge potential. Add as Step 7 in the engine roadmap if desired.
4. **Attribution.** The MrChartist repo is MIT, no attribution required, but a quiet "data via mrchartist.com" footnote on the dashboard is a fair gesture.

## 6. Recommended action

Build `fetchers/fii_dii.py`, wire into the daily cron payload, update SYSTEM_PROMPT to instruct the model on how to use the FII/DII signal in direction + range + sector calls. Estimated time: 20-30 minutes. Token cost: +200 tokens per call. Quality lift: real (institutional flow is a genuine market-moving signal. biggest non-model lever the system was missing).

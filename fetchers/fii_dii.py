"""FII / DII daily flow fetcher.

Reads from a public, no-auth, MIT-licensed third-party mirror of NSE's
provisional daily FII/DII data. We do not scrape NSE directly because
the official endpoint requires a browser cookie session and blocks
cloud-runner IP ranges (verified in prior sessions). The mirror is
hosted on an independent domain so the Azure-IP block does not apply.

Source: github.com/MrChartist/fii-dii-data (MIT). Live endpoints:
  https://fii-diidata.mrchartist.com/api/data       latest snapshot
  https://fii-diidata.mrchartist.com/api/history    last ~60 days
  https://raw.githubusercontent.com/MrChartist/fii-dii-data/main/data/history.json
                                                    GitHub backstop

Returns a compact dict shaped for direct embedding in the analyzer
payload: bare flow numbers, not the raw 30+ fields the upstream
emits. The LLM only needs the high-signal subset.
"""
import requests

PRIMARY_URL = "https://fii-diidata.mrchartist.com/api/data"
BACKSTOP_URL = (
    "https://raw.githubusercontent.com/MrChartist/fii-dii-data/main/"
    "data/history.json"
)
_HEADERS = {"User-Agent": "arcemx/1.0 (https://arcemx.arcarmor.co.in)"}
_TIMEOUT = 15


def _shape(d: dict) -> dict:
    """Compact reshape: bare net flows + sentiment context, no raw legs."""
    fao = d.get("_fao_summary") or {}
    return {
        "date": d.get("date"),
        "fii_cash_cr": d.get("fii_net"),
        "dii_cash_cr": d.get("dii_net"),
        "fii_cash_buy_cr": d.get("fii_buy"),
        "fii_cash_sell_cr": d.get("fii_sell"),
        "dii_cash_buy_cr": d.get("dii_buy"),
        "dii_cash_sell_cr": d.get("dii_sell"),
        "fii_idx_fut_net_contracts": d.get("fii_idx_fut_net"),
        "fii_stk_fut_net_contracts": d.get("fii_stk_fut_net"),
        "fii_idx_call_net_contracts": d.get("fii_idx_call_net"),
        "fii_idx_put_net_contracts": d.get("fii_idx_put_net"),
        "pcr": d.get("pcr"),
        "fao_sentiment": fao.get("sentiment"),
        "updated_at": d.get("_updated_at"),
        "_source": "mrchartist.com",
        "_note": (
            "Positive cash net = net inflow (buying), negative = outflow. "
            "FII derivatives net (contracts): positive futures-net = net "
            "long bias, negative = net short. Call/put nets indicate "
            "directional options positioning."
        ),
    }


def fetch_latest() -> dict | None:
    """Try the primary endpoint, fall back to the GitHub raw backstop."""
    try:
        r = requests.get(PRIMARY_URL, headers=_HEADERS, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and data.get("date"):
            return _shape(data)
    except Exception as e:
        print(f"fii_dii primary fail: {e}")

    # Backstop: pull latest record from the raw history file.
    try:
        r = requests.get(BACKSTOP_URL, headers=_HEADERS, timeout=_TIMEOUT)
        r.raise_for_status()
        hist = r.json()
        if isinstance(hist, list) and hist:
            return _shape(hist[0])
    except Exception as e:
        print(f"fii_dii backstop fail: {e}")
    return None


if __name__ == "__main__":
    import json
    print(json.dumps(fetch_latest(), indent=2, default=str))

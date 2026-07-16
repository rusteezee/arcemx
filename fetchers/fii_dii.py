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
HISTORY_URL = "https://fii-diidata.mrchartist.com/api/history-full"
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


def _row_net(row: dict) -> tuple[float | None, float | None]:
    """Tolerant (fii_net, dii_net) extraction across two schemas seen in
    the wild: /api/history-full's short keys (d/fn/dn - verified live
    2026-07-16; grader.py's fii_flow_1d dim hit this exact schema and a
    long-key lookup silently returned None for weeks, see grader.py's
    own comment on that fix) and the GitHub raw backstop's long keys
    (date/fii_net/dii_net, same data, verified same day)."""
    fn = row.get("fn")
    if fn is None:
        fn = row.get("fii_net")
    dn = row.get("dn")
    if dn is None:
        dn = row.get("dii_net")
    fn = float(fn) if isinstance(fn, (int, float)) else None
    dn = float(dn) if isinstance(dn, (int, float)) else None
    return fn, dn


def fetch_history(days: int = 20) -> dict | None:
    """5d/20d cumulative FII/DII net flows plus a signed FII streak, so
    the morning payload's FII/DII block carries trend context instead
    of only yesterday's single number. Tries the mirror's /api/history-
    full first (rows newest-first), falls back to the GitHub raw
    backstop on failure - same two-tier pattern as fetch_latest().
    Computed strictly from TRADING days present in the data, no
    calendar padding. Returns None on any failure or with fewer than 5
    usable trading-day rows, so the payload just omits the key rather
    than embedding a stale or partial trend."""
    rows = None
    try:
        r = requests.get(HISTORY_URL, headers=_HEADERS, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list) and data:
            rows = data
    except Exception as e:
        print(f"fii_dii history primary fail: {e}")

    if rows is None:
        try:
            r = requests.get(BACKSTOP_URL, headers=_HEADERS, timeout=_TIMEOUT)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list) and data:
                rows = data
        except Exception as e:
            print(f"fii_dii history backstop fail: {e}")
            return None

    if not rows:
        return None

    fii_nets: list[float] = []
    dii_nets: list[float] = []
    for row in rows:
        fn, dn = _row_net(row)
        if fn is None or dn is None:
            continue
        fii_nets.append(fn)
        dii_nets.append(dn)

    if len(fii_nets) < 5:
        return None

    fii_net_5d = sum(fii_nets[:5])
    dii_net_5d = sum(dii_nets[:5])
    n20 = min(days, len(fii_nets))
    fii_net_20d = sum(fii_nets[:n20])
    dii_net_20d = sum(dii_nets[:n20])

    # Signed consecutive-day streak of same-sign FII net, walking back
    # from the most recent trading day (e.g. -4 = 4 straight selling
    # days). A flat (zero-net) day breaks the streak at 0.
    streak = 0
    sign = 0
    for net in fii_nets:
        cur_sign = 1 if net > 0 else (-1 if net < 0 else 0)
        if cur_sign == 0 or (sign and cur_sign != sign):
            break
        sign = cur_sign
        streak += 1
    fii_streak = streak * sign

    # ASSUMPTION: "read" is the fixed-rule classifier tag itself
    # ("notable"/"mixed"), not a generated natural-language sentence -
    # the numeric fields already give the LLM everything it needs to
    # compose its own sentence (per the GOAL section's example).
    read = "notable" if (abs(fii_streak) >= 3 or abs(fii_net_5d) > 5000) else "mixed"

    return {
        "fii_net_5d": round(fii_net_5d, 2),
        "fii_net_20d": round(fii_net_20d, 2),
        "dii_net_5d": round(dii_net_5d, 2),
        "dii_net_20d": round(dii_net_20d, 2),
        "fii_streak": fii_streak,
        "read": read,
    }


if __name__ == "__main__":
    import json
    print(json.dumps(fetch_latest(), indent=2, default=str))
    print(json.dumps(fetch_history(), indent=2, default=str))

"""FIRMS satellite thermal-anomaly backtest (research only, NOT wired into
production - see KNOWLEDGE_BASE.md's God's Eye View research entry).

Tests a real, falsifiable hypothesis: does NASA FIRMS satellite-detected
thermal activity at a company's flagship industrial site correlate with
that company's forward stock returns? This is a genuine institutional
alt-data technique (satellite thermal signatures as a capacity-utilization
proxy), but every candidate here is a LARGE MULTI-SITE CONGLOMERATE - the
flagship plant is a PARTIAL proxy for the whole company's activity, not
a clean 1:1 read. Expect a real ceiling on correlation strength; report
whatever the data actually says, do not round up.

Known limitation, verified before writing a line of fetch code: Adani
Power's Mundra plant (22.8235, 69.5535) and Tata Power's Mundra plant
(22.8158, 69.5281) sit ~3.5km apart in the same industrial zone. VIIRS
resolution (375m-1km/pixel) can plausibly conflate the two - treat any
signal at either coordinate as "Mundra industrial zone activity" until
proven otherwise, not as cleanly separated per-company data.

Requires a free NASA FIRMS MAP_KEY (self-serve signup:
https://firms.modaps.eosdis.nasa.gov/api/map_key/) in FIRMS_MAP_KEY env
var. Uses the archive-capable area/csv endpoint:
  https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA}/{DAY_RANGE}/{DATE}
DATE is the END date of the DAY_RANGE-day window (max 366/call per FIRMS
docs) - omitting DATE defaults to "ending today". Multiple calls chain
year-by-year for multi-year history.
"""
from __future__ import annotations

import os
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests
import yfinance as yf
from dotenv import load_dotenv

load_dotenv()

FIRMS_MAP_KEY = os.getenv("FIRMS_MAP_KEY")
FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
# VIIRS_SNPP_SP = Suomi NPP, science-quality reprocessed - longest clean
# archive. Swap to VIIRS_NOAA20_NRT for the last ~2 months of near-real-time
# if SP's archive does not reach far enough back for a given date.
FIRMS_SOURCE = "VIIRS_SNPP_SP"

# Half-width of the bounding box around each plant, in degrees (~0.06 deg
# is roughly 6.5km at these latitudes) - tight enough to stay plant-local,
# wide enough to not miss the sensor's own pixel footprint.
_BOX_HALF_DEG = 0.06


class Plant:
    __slots__ = ("ticker", "name", "lat", "lon", "capacity_mw", "note")

    def __init__(self, ticker, name, lat, lon, capacity_mw, note=""):
        self.ticker = ticker
        self.name = name
        self.lat = lat
        self.lon = lon
        self.capacity_mw = capacity_mw
        self.note = note


# Coordinates verified live 2026-09-06 against Global Energy Monitor,
# Wikipedia, and Global Energy Observatory - not guessed. capacity_mw is
# the PLANT's nameplate capacity, used only to gauge what fraction of the
# PARENT COMPANY's total capacity this single site actually represents.
PLANTS = [
    Plant("VEDL.NS", "Jharsuguda aluminium smelter plus captive power",
          21.8089, 84.04103, capacity_mw=None,
          note="Odisha, geographically isolated from the other candidates, "
               "no conflation risk. Smelter plus onsite captive power "
               "plant, so thermal signature should be relatively strong. "
               "Still a PARTIAL proxy - Vedanta also runs oil and gas, "
               "iron ore, and a Hindustan Zinc stake, none captured here."),
    Plant("ADANIPOWER.NS", "Mundra Thermal Power Station",
          22.8234904, 69.5534831, capacity_mw=4620,
          note="Flagship largest single Adani Power plant. About 3.5km "
               "from Tata Power Mundra plant, see module docstring on "
               "conflation risk."),
    Plant("TATAPOWER.NS", "Mundra Ultra Mega Power Project (CGPL)",
          22.8158, 69.5281, capacity_mw=4000,
          note="About 3.5km from Adani Power Mundra plant, same "
               "conflation risk, flagged both directions."),
    Plant("NTPC.NS", "Vindhyachal Super Thermal Power Station",
          24.09722, 82.67361, capacity_mw=4783,
          note="NTPC largest single plant, but NTPC total installed "
               "capacity is 70+ GW across dozens of sites nationwide, "
               "this plant is under 7 percent of the parent total "
               "capacity. Expect this candidate signal, if any, to be "
               "the weakest of the four purely from dilution, "
               "independent of whether the underlying hypothesis has "
               "any merit at all."),
]


def _bbox(lat: float, lon: float) -> str:
    """FIRMS area format: west,south,east,north."""
    return (f"{lon - _BOX_HALF_DEG},{lat - _BOX_HALF_DEG},"
            f"{lon + _BOX_HALF_DEG},{lat + _BOX_HALF_DEG}")


def fetch_firms_window(lat: float, lon: float, end_date: date,
                       day_range: int = 366) -> "pd.DataFrame | None":
    """One FIRMS archive call: day_range days of VIIRS detections ending
    on end_date, inside the plant bounding box. Returns raw hotspot rows
    (lat/lon/brightness/frp/acq_date/acq_time/confidence) or None on any
    failure - callers must not treat None as zero activity."""
    if not FIRMS_MAP_KEY:
        print("firms_thermal_backtest: FIRMS_MAP_KEY not set, skipping fetch")
        return None
    url = (f"{FIRMS_BASE}/{FIRMS_MAP_KEY}/{FIRMS_SOURCE}/"
           f"{_bbox(lat, lon)}/{day_range}/{end_date.isoformat()}")
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        if not r.text.strip() or r.text.startswith("Invalid"):
            print(f"firms_thermal_backtest: bad response for {lat},{lon} "
                  f"ending {end_date}: {r.text[:200]}")
            return None
        df = pd.read_csv(pd.io.common.StringIO(r.text))
        return df if not df.empty else pd.DataFrame()
    except Exception as e:
        print(f"firms_thermal_backtest: fetch fail for {lat},{lon}: {e}")
        return None


def fetch_full_history(plant: Plant, start: date, end: date) -> pd.DataFrame:
    """Chains fetch_firms_window in <=366-day chunks to cover [start, end].
    Sleeps briefly between calls - this is a one-shot research script, not
    a production job, no need to be fast, only need to not hammer FIRMS."""
    chunks: list[pd.DataFrame] = []
    window_end = end
    while window_end >= start:
        days_this_chunk = min(366, (window_end - start).days + 1)
        df = fetch_firms_window(plant.lat, plant.lon, window_end, days_this_chunk)
        if df is not None and not df.empty:
            chunks.append(df)
        window_end = window_end - timedelta(days=days_this_chunk)
        time.sleep(1)
    if not chunks:
        return pd.DataFrame()
    out = pd.concat(chunks, ignore_index=True)
    out = out.drop_duplicates(subset=[c for c in
                                      ("latitude", "longitude", "acq_date", "acq_time")
                                      if c in out.columns])
    return out


def daily_thermal_series(hotspots: pd.DataFrame) -> pd.Series:
    """Collapse raw hotspot detections to one row per calendar day: total
    FRP (fire radiative power, MW - the actual intensity proxy, not just a
    hotspot count) summed across all detections and passes that day.
    Missing days (no detection at all) are real zeros, not gaps - VIIRS
    makes about 2 passes/day over any given point regardless of ground
    activity."""
    if hotspots.empty:
        return pd.Series(dtype=float)
    df = hotspots.copy()
    df["acq_date"] = pd.to_datetime(df["acq_date"])
    daily = df.groupby("acq_date")["frp"].sum()
    full_range = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    return daily.reindex(full_range, fill_value=0.0)


def forward_returns(ticker: str, dates: pd.DatetimeIndex, horizon_days: int) -> pd.Series:
    """Forward percent-return from each date close to the close
    horizon_days trading sessions later, for ticker. Pulls one bulk
    yfinance history covering the full span rather than one call per
    date."""
    start = dates.min() - timedelta(days=10)
    end = dates.max() + timedelta(days=horizon_days * 3 + 10)
    hist = yf.download(ticker, start=start, end=end, interval="1d",
                       progress=False, auto_adjust=True)
    if isinstance(hist.columns, pd.MultiIndex):
        hist.columns = hist.columns.get_level_values(0)
    if hist.empty:
        return pd.Series(dtype=float, index=dates)
    close = hist["Close"]
    close.index = close.index.tz_localize(None)

    out = {}
    idx_list = list(close.index)
    for d in dates:
        # Closest trading session on or after d.
        pos = close.index.searchsorted(d)
        if pos >= len(idx_list) or pos + horizon_days >= len(idx_list):
            continue
        base = close.iloc[pos]
        fwd = close.iloc[pos + horizon_days]
        if base and base > 0:
            out[d] = float((fwd - base) / base * 100.0)
    return pd.Series(out)


def _pearson_r(x: pd.Series, y: pd.Series) -> tuple[float, int]:
    aligned = pd.concat([x, y], axis=1).dropna()
    n = len(aligned)
    if n < 10:
        return float("nan"), n
    r = aligned.iloc[:, 0].corr(aligned.iloc[:, 1])
    return (r if r == r else 0.0), n


def _t_stat(r: float, n: int) -> float:
    """Standard t-test for Pearson correlation significance:
    t = r * sqrt(n-2) / sqrt(1-r^2). Matches this project own convention
    of reporting a t-stat (see KNOWLEDGE_BASE.md section 26) rather than a
    raw p-value - abs(t) greater than about 2 is the informal significance
    bar used throughout this codebase own audits."""
    if r != r or n < 3 or abs(r) >= 1.0:
        return 0.0
    return r * ((n - 2) ** 0.5) / ((1 - r ** 2) ** 0.5)


def run_backtest(plant: Plant, start: date, end: date,
                 horizons: "list[int]" = (1, 5, 10, 20)) -> dict:
    print(f"\n=== {plant.ticker}: {plant.name} ===")
    if plant.note:
        print(f"  NOTE: {plant.note}")
    hotspots = fetch_full_history(plant, start, end)
    if hotspots.empty:
        print("  no FIRMS data returned (check FIRMS_MAP_KEY and date range)")
        return {"ticker": plant.ticker, "error": "no_data"}

    thermal = daily_thermal_series(hotspots)
    print(f"  {len(hotspots)} raw detections -> {len(thermal)} daily rows, "
          f"{(thermal > 0).sum()} days with any detection, "
          f"mean FRP {thermal.mean():.2f}")

    # 7-day rolling FRP as the capacity-utilization proxy - smooths day-to-
    # day satellite-pass noise (cloud cover, orbital gaps) without erasing
    # a real multi-day shift in plant activity.
    thermal_smoothed = thermal.rolling(7, min_periods=3).mean().dropna()

    results = {"ticker": plant.ticker, "n_days_with_data": len(thermal),
              "horizons": {}}
    for h in horizons:
        fwd = forward_returns(plant.ticker, thermal_smoothed.index, h)
        r, n = _pearson_r(thermal_smoothed, fwd)
        t = _t_stat(r, n)
        results["horizons"][h] = {"r": round(r, 4) if r == r else None,
                                  "n": n, "t_stat": round(t, 3)}
        flag = "SIGNIFICANT" if abs(t) > 2 else ""
        print(f"  {h}d forward return vs 7d-smoothed FRP: "
              f"r={r:.4f} n={n} t={t:.3f} {flag}")
    return results


if __name__ == "__main__":
    import json

    end = date.today()
    start = end - timedelta(days=730)  # 2 years

    if not FIRMS_MAP_KEY:
        print("FIRMS_MAP_KEY not set - printing plant registry only, no live fetch.")
        for p in PLANTS:
            print(f"{p.ticker}: {p.name} @ ({p.lat}, {p.lon}) bbox={_bbox(p.lat, p.lon)}")
        raise SystemExit(0)

    all_results = [run_backtest(p, start, end) for p in PLANTS]
    print("\n=== SUMMARY ===")
    print(json.dumps(all_results, indent=2, default=str))

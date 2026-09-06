"""NSE India corporate announcements fetcher.

Live-verified 2026-09-06 from the Oracle box's actual production IP
(92.4.84.48): NSE's own internal JSON API (the same one nseindia.com's
own frontend calls) is reachable via a homepage cookie warmup + plain
`requests` - no scraping library, no headless browser needed.
`fetchers/fii_dii.py`'s docstring says NSE "blocks cloud-runner IP
ranges (verified in prior sessions)" - that finding does not currently
apply to THIS box; verified live, not assumed. If it starts failing
later (NSE's Akamai WAF can change its blocklist any time), that's a
new, separate finding, not a contradiction of this one.

The feed is extremely noisy: a real live pull covering ~3800
announcements across 6 days market-wide showed the top categories are
routine SEBI-mandated filings (newspaper publication copies,
shareholder meeting notices, generic "Updates") that carry no real
trading signal. `_is_material()` is an explicit allow-list of NSE's own
`desc` category field, built from categories actually observed live in
that pull - not guessed - for filings that plausibly move price or
reflect real fundamental change (board meeting outcomes, results,
credit rating actions, management changes, M&A, insider disclosures).

This mirrors the exact "crammed prompt -> undifferentiated negative
alpha" trap already found in this project's own history
(top_performer_1d, KB section 26): feeding the LLM every routine filing
would just add noise on top of noise. Filtering to material categories
only is the point, not an afterthought.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta

import requests

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Referer": "https://www.nseindia.com/",
    "Connection": "keep-alive",
}
# Homepage itself can 403 even on a session that goes on to work fine -
# verified live 2026-09-06. Do not treat that as fatal; only the final
# API call's own status matters.
_WARM_URLS = (
    "https://www.nseindia.com",
    "https://www.nseindia.com/market-data/live-equity-market",
)
_API_URL = "https://www.nseindia.com/api/corporate-announcements"
_TIMEOUT = 15

# Allow-list: substrings of NSE's `desc` field (lowercased) that plausibly
# carry real trading signal. Built from real categories seen live.
_MATERIAL_CATEGORIES = (
    "outcome of board meeting",
    "financial results",
    "credit rating",
    "change in management",
    "resignation of director",
    "appointment",
    "price movement",
    "acquisition",
    "merger", "amalgamation", "demerger",
    "preferential issue", "allotment",
    "buyback",
    "insider trading", "sast", "disclosure under regulation",
    "order", "contract",
    "delisting",
    "insolvency", "resolution plan",
    "credit facility", "default",
    "investor presentation",
)
# Explicit deny-list, checked FIRST, so a routine category never
# false-positives on a substring above (e.g. "Analysts/Institutional
# Investor Meet/Con. Call Updates" would otherwise match "investor
# presentation"'s "investor" fragment).
_ROUTINE_CATEGORIES = (
    "copy of newspaper publication",
    "shareholders meeting",
    "general updates",
    "record date",
    "esop", "esos", "esps",
    "analysts/institutional investor meet",
    "press release",
)


def _is_material(desc: str) -> bool:
    d = (desc or "").strip().lower()
    if not d:
        return False
    if any(r in d for r in _ROUTINE_CATEGORIES):
        return False
    return any(m in d for m in _MATERIAL_CATEGORIES)


def _create_session(retries: int = 3, delay: float = 1.0) -> "requests.Session | None":
    session = requests.Session()
    session.headers.update(_HEADERS)
    for attempt in range(retries):
        try:
            for url in _WARM_URLS:
                try:
                    session.get(url, timeout=10)
                except requests.RequestException:
                    pass
                time.sleep(delay)
            return session
        except Exception as e:
            print(f"nse_announcements: session attempt {attempt + 1} failed: {e}")
            time.sleep(delay * (attempt + 1))
    return None


def fetch_recent(days: int = 1) -> list[dict]:
    """All market-wide announcements from the last `days` days, newest
    first, unfiltered (not yet sliced by ticker or materiality)."""
    session = _create_session()
    if session is None:
        print("nse_announcements: could not establish session")
        return []
    today = datetime.now()
    from_date = (today - timedelta(days=days)).strftime("%d-%m-%Y")
    to_date = today.strftime("%d-%m-%Y")
    try:
        r = session.get(_API_URL, params={
            "index": "equities", "from_date": from_date, "to_date": to_date,
        }, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"nse_announcements: fetch fail: {e}")
        return []


def material_for_tickers(tickers: "set[str] | list[str]", days: int = 1) -> dict[str, list[dict]]:
    """Fetch once market-wide, filter to `tickers` (any mix of bare NSE
    symbols or .NS-suffixed) and material categories only. Returns
    {original_ticker_string: [rows]}, each row shaped
    {desc, summary, pdf_url, an_dt} - compact enough to embed directly
    in the LLM payload. Preserves whatever ticker string format the
    caller passed in (bare or .NS) as the output key, so callers don't
    need a second remap step."""
    bare_to_original: dict[str, str] = {}
    for t in tickers:
        bare = t[:-3] if t.upper().endswith(".NS") else t
        bare_to_original[bare.strip().upper()] = t

    rows = fetch_recent(days=days)
    out: dict[str, list[dict]] = {}
    for row in rows:
        sym = (row.get("symbol") or "").strip().upper()
        original = bare_to_original.get(sym)
        if original is None:
            continue
        desc = row.get("desc") or ""
        if not _is_material(desc):
            continue
        out.setdefault(original, []).append({
            "desc": desc,
            "summary": (row.get("attchmntText") or "")[:300],
            "pdf_url": row.get("attchmntFile"),
            "an_dt": row.get("an_dt"),
        })
    if out:
        print(f"nse_announcements: material filings for {sorted(out.keys())}")
    return out


if __name__ == "__main__":
    import json
    from fetchers.prices import load_universe
    uni = load_universe()
    result = material_for_tickers(set(uni), days=3)
    print(json.dumps(result, indent=2, default=str))
    print(f"\n{len(result)}/{len(uni)} universe tickers had material filings in the last 3 days")

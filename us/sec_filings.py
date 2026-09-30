"""SEC EDGAR filings for the user's US holdings (blueprint 25, Phase 2).

The US analogue of fetchers/nse_announcements.py: official, structured,
free. Same discipline: ingest everything for the tracked tickers, but only
surface (alert) what plausibly matters, so signal is not buried in noise.

Built from what EDGAR actually returns for the current holdings, both of
which are FOREIGN private issuers (TSMC, SK hynix):
  - they file 6-K, not 8-K, and the `items` field is empty on every 6-K, so
    filing metadata alone never says what a 6-K is about. 6-K and 8-K text
    is classified by reading the document for material keywords.
  - periodic reports (20-F, 10-K, 10-Q, 40-F) are material by form alone.
  - 8-K items are honoured when present (domestic issuers added later).
  - Form 3/4 is deliberately not parsed: for a foreign issuer the Form 4s
    under its CIK are filings where it is a SHAREHOLDER of other companies,
    not insider trades in it. Add insider parsing when a domestic issuer
    enters the book.

SEC fair-access policy: a descriptive User-Agent with a contact address is
mandatory and <=10 requests/second. The contact comes from the
SEC_CONTACT_EMAIL env var and is never committed to the repo.

Run: python -m us.sec_filings [--dry] [--days N]
  --dry  print what would be stored, write nothing, send no alerts.
"""
from __future__ import annotations

import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

_TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
_DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}"
_TIMEOUT = 20
_MIN_INTERVAL_S = 0.2  # 5 req/s, half of SEC's stated ceiling
_DOC_READ_BYTES = 400_000
_TEXT_SCAN_CHARS = 8000
_ALERT_MAX_AGE_DAYS = 3

TRACKED_FORMS = {"8-K", "8-K/A", "6-K", "6-K/A", "10-K", "10-Q", "20-F", "40-F"}
_PERIODIC_FORMS = {"10-K", "10-Q", "20-F", "40-F"}
_TEXT_CLASSIFIED_FORMS = {"8-K", "8-K/A", "6-K", "6-K/A"}

# 8-K item numbers that can move a stock (results, agreements, distress,
# auditor/restatement, control and officer changes). 9.01 (exhibits), 5.03
# and 5.07 (bylaws, routine votes) are deliberately absent.
_MATERIAL_8K_ITEMS = {
    "1.01", "1.02", "1.03", "2.01", "2.02", "2.04", "2.05", "2.06",
    "3.01", "4.01", "4.02", "5.01", "5.02",
}
_KEYWORDS = (
    "dividend", "revenue", "net income", "financial results",
    "share repurchase", "treasury shares", "buyback",
    "merger agreement", "to acquire", "tender offer",
    "public offering", "capital increase",
    "resign", "restatement", "impairment", "bankruptcy", "delist", "guidance",
)
# First cut, audited 2026-09-30 against 13 real TSM and SKHY 6-Ks. Generic
# words were dropped because they only matched boilerplate: "acquisition"
# hit TSMC's month-end 6-K every month (its standing list "...the acquisition
# and disposition of assets...") and table headers in SK hynix filings;
# "earnings" hit an investor-relations schedule line. Phase 3's LLM brief
# reads every stored event anyway, so this list only decides what alerts.

_last_call = 0.0
_ticker_to_cik: dict[str, int] | None = None


def _headers() -> dict:
    email = os.getenv("SEC_CONTACT_EMAIL")
    if not email:
        raise RuntimeError(
            "SEC_CONTACT_EMAIL not set. SEC requires a contact address in the "
            "User-Agent; set it in /etc/arcemx.env (never commit it).")
    return {"User-Agent": f"ArcEmX personal-research {email}",
            "Accept-Encoding": "gzip, deflate"}


def _get(url: str) -> requests.Response:
    global _last_call
    wait = _MIN_INTERVAL_S - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    resp = requests.get(url, headers=_headers(), timeout=_TIMEOUT)
    _last_call = time.monotonic()
    resp.raise_for_status()
    return resp


def _cik_for(ticker: str) -> int | None:
    """SEC's own ticker to CIK map. Class-share tickers use '-' on EDGAR, so
    a '.' style symbol is retried with '-'."""
    global _ticker_to_cik
    if _ticker_to_cik is None:
        raw = _get(_TICKER_MAP_URL).json()
        _ticker_to_cik = {v["ticker"].upper(): int(v["cik_str"]) for v in raw.values()}
    t = ticker.upper()
    return _ticker_to_cik.get(t) or _ticker_to_cik.get(t.replace(".", "-"))


def recent_filings(ticker: str, since: date) -> list[dict]:
    """Tracked-form filings for `ticker` filed on or after `since`, newest
    first. Empty list when the ticker has no SEC CIK."""
    cik = _cik_for(ticker)
    if cik is None:
        print(f"  {ticker}: no SEC CIK found (not SEC-registered), skipping")
        return []
    recent = _get(_SUBMISSIONS_URL.format(cik=cik)).json()["filings"]["recent"]
    items_col = recent.get("items") or [""] * len(recent["form"])
    out = []
    for i, form in enumerate(recent["form"]):
        if form not in TRACKED_FORMS:
            continue
        filed = date.fromisoformat(recent["filingDate"][i])
        if filed < since:
            continue
        acc = recent["accessionNumber"][i]
        out.append({
            "accession": acc,
            "ticker": ticker.upper(),
            "form": form,
            "items": items_col[i] or "",
            "filed_date": filed.isoformat(),
            "accepted_at": recent["acceptanceDateTime"][i],
            "url": _DOC_URL.format(cik=cik, acc=acc.replace("-", ""),
                                   doc=recent["primaryDocument"][i]),
        })
    return out


def _document_text(url: str) -> str:
    resp = requests.get(url, headers=_headers(), timeout=_TIMEOUT, stream=True)
    try:
        resp.raise_for_status()
        html = resp.raw.read(_DOC_READ_BYTES, decode_content=True)
    finally:
        resp.close()
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    return re.sub(r"\s+", " ", text)


def classify(filing: dict) -> dict:
    """Adds material, material_reason and snippet. Only reads the document
    (one extra request) for 6-K/8-K filings that item codes cannot decide."""
    form, items = filing["form"], filing["items"]
    filing = {**filing, "material": False, "material_reason": None, "snippet": None}
    if form in _PERIODIC_FORMS:
        return {**filing, "material": True, "material_reason": f"periodic report ({form})"}
    hit_items = sorted(set(i.strip() for i in items.split(",")) & _MATERIAL_8K_ITEMS)
    if hit_items:
        return {**filing, "material": True, "material_reason": f"8-K item {', '.join(hit_items)}"}
    if form not in _TEXT_CLASSIFIED_FORMS:
        return filing
    time.sleep(_MIN_INTERVAL_S)
    text = _document_text(filing["url"])[:_TEXT_SCAN_CHARS]
    lower = text.lower()
    for kw in _KEYWORDS:
        pos = lower.find(kw)
        if pos >= 0:
            snippet = text[max(0, pos - 120): pos + 180].strip()
            return {**filing, "material": True, "material_reason": f"keyword: {kw}",
                    "snippet": snippet}
    return filing


def _notify(text: str) -> None:
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return
    try:
        requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      json={"chat_id": chat, "text": text,
                            "disable_web_page_preview": True}, timeout=10)
    except requests.RequestException as e:
        print(f"  telegram notify failed: {e}")


def _alert_text(f: dict) -> str:
    lines = [f"SEC filing: {f['ticker']} {f['form']} filed {f['filed_date']}",
             f"Why flagged: {f['material_reason']}"]
    if f.get("snippet"):
        lines.append(f["snippet"][:280])
    lines.append(f["url"])
    return "\n".join(lines)


def run(days: int = 30, dry: bool = False) -> int:
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])
    tickers = sorted({r["ticker"] for r in
                      sb.table("us_holdings").select("ticker").execute().data or []})
    if not tickers:
        print("no US holdings synced yet, nothing to check")
        return 0
    known: set[str] = set()
    if not dry:
        known = {r["accession"] for r in
                 sb.table("us_events").select("accession").execute().data or []}

    today = datetime.now(timezone.utc).date()
    since = today - timedelta(days=days)
    alert_cutoff = (today - timedelta(days=_ALERT_MAX_AGE_DAYS)).isoformat()
    new_count = 0
    for ticker in tickers:
        for filing in recent_filings(ticker, since):
            if filing["accession"] in known:
                continue
            f = classify(filing)
            new_count += 1
            flag = f"MATERIAL ({f['material_reason']})" if f["material"] else "routine"
            print(f"  {f['ticker']} {f['form']} {f['filed_date']} {flag}")
            if dry:
                continue
            f["alerted"] = bool(f["material"] and f["filed_date"] >= alert_cutoff)
            sb.table("us_events").upsert(f, on_conflict="accession").execute()
            if f["alerted"]:
                _notify(_alert_text(f))
    print(f"us_filings: {new_count} new filings across {len(tickers)} tickers"
          f"{' (dry run, nothing stored)' if dry else ''}")
    return new_count


if __name__ == "__main__":
    args = sys.argv[1:]
    n_days = int(args[args.index("--days") + 1]) if "--days" in args else 30
    run(days=n_days, dry="--dry" in args)

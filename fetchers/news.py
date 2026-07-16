"""Fetch news from RSS + optional GNews. Store in Supabase."""
import csv
import os
import re
from pathlib import Path

import feedparser
import requests
from datetime import datetime, timezone
from dateutil import parser as dateparser
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

_UNIVERSE_CSV = Path(__file__).resolve().parent.parent / "data" / "universe.csv"
_NAME_SUFFIXES = {"ltd", "ltd.", "limited", "(india)", "india"}
_FIRSTWORD_BLOCK = {"indian", "national", "central", "united", "oriental",
                    "general", "bank", "india", "power", "state", "new"}
_SYMBOL_BLOCK = {"IDEA", "POWER", "BANK", "INDIA", "TATA", "GOLD", "NIFTY", "CARE"}


def _strip_suffixes(tokens: list[str]) -> list[str]:
    while tokens and tokens[-1] in _NAME_SUFFIXES:
        tokens = tokens[:-1]
    return tokens


def _load_alias_map() -> dict[str, dict]:
    """Build {ticker: {"names": [...], "symbol": root_or_None}} from
    data/universe.csv - company-name aliases (full name, first-two-words,
    a long-enough first word) plus the bare ticker symbol root, each
    filtered against a blocklist of common English words that would
    otherwise false-positive (e.g. "IDEA" the ticker vs "idea" the word).
    One compiled name regex per ticker, cached under "_pattern" so
    link_tickers() never recompiles. Indices (^-prefixed or sector=INDEX)
    are skipped entirely - they're not linkable news subjects here."""
    alias_map: dict[str, dict] = {}
    if not _UNIVERSE_CSV.exists():
        return alias_map
    with open(_UNIVERSE_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            ticker = (row.get("ticker") or "").strip()
            sector = (row.get("sector") or "").strip()
            name = (row.get("name") or "").strip()
            if not ticker or ticker.startswith("^") or sector == "INDEX":
                continue

            tokens = _strip_suffixes(name.lower().split())
            aliases: list[str] = []
            if tokens:
                full_alias = " ".join(tokens)
                if len(full_alias) >= 5:
                    aliases.append(full_alias)
                if len(tokens) >= 3:
                    two_word = " ".join(tokens[:2])
                    if len(two_word) >= 5:
                        aliases.append(two_word)
                first = tokens[0]
                if len(first) >= 6 and first not in _FIRSTWORD_BLOCK:
                    aliases.append(first)
            names = list(dict.fromkeys(aliases))

            root = ticker.split(".")[0]
            symbol = (root if len(root) >= 4 and root.isalpha()
                     and root not in _SYMBOL_BLOCK else None)

            if not names and not symbol:
                continue

            pattern = None
            if names:
                pattern = re.compile(r"\b(" + "|".join(map(re.escape, names)) + r")\b")

            alias_map[ticker] = {"names": names, "symbol": symbol, "_pattern": pattern}
    return alias_map


_ALIAS_CACHE: dict[str, dict] | None = None


def _get_alias_map() -> dict[str, dict]:
    global _ALIAS_CACHE
    if _ALIAS_CACHE is None:
        _ALIAS_CACHE = _load_alias_map()
    return _ALIAS_CACHE


def link_tickers(title: str, summary: str) -> list[str]:
    """Deterministic ticker linking, zero LLM calls. Two independent
    match paths, either one links the story: (1) a company-name alias
    regex against the lowercased title+summary, (2) an all-uppercase
    token in the ORIGINAL (case-preserved) text exactly equal to a
    ticker's symbol root - catches headlines that use the raw symbol
    ("IDEA rallies 5%") rather than the company name. Sorted, deduped,
    capped at 10 so a generic multi-name roundup story doesn't tag
    half the universe."""
    alias_map = _get_alias_map()
    original = f"{title} {summary}"
    lowered = original.lower()
    symbol_tokens = {t for t in re.split(r"[^A-Za-z0-9]+", original) if t and t.isupper()}

    matched: set[str] = set()
    for ticker, entry in alias_map.items():
        pattern = entry.get("_pattern")
        if pattern is not None and pattern.search(lowered):
            matched.add(ticker)
            continue
        symbol = entry.get("symbol")
        if symbol and symbol in symbol_tokens:
            matched.add(ticker)

    return sorted(matched)[:10]


RSS_FEEDS = {
    "moneycontrol_markets": "https://www.moneycontrol.com/rss/marketreports.xml",
    "moneycontrol_business": "https://www.moneycontrol.com/rss/business.xml",
    "et_markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    "et_stocks": "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms",
    "livemint_markets": "https://www.livemint.com/rss/markets",
    "business_standard": "https://www.business-standard.com/rss/markets-106.rss",
    "reuters_business": "https://feeds.reuters.com/reuters/businessNews",
    "cnbc_world": "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    "bloomberg_markets": "https://feeds.bloomberg.com/markets/news.rss",
}


def fetch_rss() -> list[dict]:
    items = []
    for source, url in RSS_FEEDS.items():
        try:
            feed = feedparser.parse(url)
            for entry in feed.entries[:30]:
                published = entry.get("published") or entry.get("updated")
                try:
                    pub_dt = dateparser.parse(published) if published else datetime.now(timezone.utc)
                except Exception:
                    pub_dt = datetime.now(timezone.utc)
                items.append({
                    "source": source,
                    "title": entry.get("title", "").strip(),
                    "url": entry.get("link", ""),
                    "summary": (entry.get("summary") or "")[:1000],
                    "published_at": pub_dt.isoformat(),
                })
        except Exception as e:
            print(f"RSS fail {source}: {e}")
    return items


def fetch_gnews(query: str = "stock market india", max_n: int = 50) -> list[dict]:
    key = os.getenv("GNEWS_API_KEY")
    if not key:
        return []
    url = "https://gnews.io/api/v4/search"
    params = {"q": query, "lang": "en", "country": "in", "max": max_n, "apikey": key}
    try:
        r = requests.get(url, params=params, timeout=15)
        r.raise_for_status()
        out = []
        for a in r.json().get("articles", []):
            out.append({
                "source": f"gnews:{a.get('source', {}).get('name', '')}",
                "title": a.get("title", ""),
                "url": a.get("url", ""),
                "summary": a.get("description", ""),
                "published_at": a.get("publishedAt"),
            })
        return out
    except Exception as e:
        print(f"GNews fail: {e}")
        return []


def push(items: list[dict]) -> int:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        print("Supabase not configured; printing first 5")
        for it in items[:5]:
            print(it["source"], "|", it["title"])
        return 0
    sb = create_client(url, key)
    inserted = 0
    for it in items:
        if not it.get("url"):
            continue
        try:
            sb.table("news").upsert(it, on_conflict="url").execute()
            inserted += 1
        except Exception as e:
            print(f"upsert fail: {e}")
    return inserted


if __name__ == "__main__":
    items = fetch_rss() + fetch_gnews()
    for it in items:
        it["tickers"] = link_tickers(it["title"], it.get("summary") or "")
    print(f"Fetched {len(items)} news items")
    n = push(items)
    print(f"Stored {n}")

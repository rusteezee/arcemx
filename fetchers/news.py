"""Fetch news from RSS + optional GNews. Store in Supabase."""
import os
import feedparser
import requests
from datetime import datetime, timezone
from dateutil import parser as dateparser
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

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
    print(f"Fetched {len(items)} news items")
    n = push(items)
    print(f"Stored {n}")

"""Cron-callable script. Pushes a Telegram alert within the hour whenever
material news hits a stock the user holds or watches. Mirrors
alerts_checker.py's standalone shape - no import of telegram_bot.py's
Application/handler machinery, just Bot.send_message.

Dispatched hourly alongside fetchers.news (see
.github/workflows/hourly_news.yml). Reuses news_digest.build_news_digest
for clustering/materiality/portfolio-hit tagging - zero new LLM/API
calls, everything deterministic. No quiet hours: the user wants alerts
as soon as possible, 24/7.
"""
import os
import asyncio
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from telegram import Bot
from supabase import create_client

from analyzer.news_digest import build_news_digest

load_dotenv()

_MATERIALITY_MIN = 1.0
_MAX_ALERTS_PER_RUN = 3
_LOOKBACK_HOURS = 2


async def check() -> dict:
    sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    held = {r["ticker"] for r in (sb.table("portfolio").select("ticker").execute().data or [])}
    watched = {r["ticker"] for r in (sb.table("wishlist").select("ticker").execute().data or [])}
    if not held and not watched:
        print("news_alerts: no holdings or watchlist, nothing to do")
        return {"candidates": 0, "sent": 0, "skipped_dupe": 0}

    # fetched_at, not published_at - a story fetched late (feed lag, a
    # slow source) still alerts once instead of aging out silently.
    since = (datetime.now(timezone.utc) - timedelta(hours=_LOOKBACK_HOURS)).isoformat()
    rows = sb.table("news").select(
        "source,title,url,summary,published_at,tickers"
    ).gte("fetched_at", since).limit(500).execute().data or []

    digest = build_news_digest(rows, top_n=50, held=held, watched=watched)
    stories = digest.get("top_stories") or []

    candidates = sorted(
        (s for s in stories
         if (s.get("portfolio_hit") or s.get("watchlist_hit"))
         and s.get("materiality", 0) >= _MATERIALITY_MIN),
        key=lambda s: s["materiality"], reverse=True,
    )[:_MAX_ALERTS_PER_RUN]

    bot = Bot(token) if token else None
    sent = 0
    skipped_dupe = 0
    for s in candidates:
        cluster_key = s["cluster_key"]
        existing = sb.table("news_alerts_sent").select("id").eq(
            "cluster_key", cluster_key
        ).execute()
        if existing.data:
            skipped_dupe += 1
            continue

        matched = [t for t in s["tickers"] if t in held or t in watched]
        if not matched or bot is None:
            continue

        first_source = (s["sources"][0] if s["sources"] else "").replace("_", " ")
        msg = (
            f"*News Alert: {', '.join(t.split('.')[0] for t in matched)}*\n"
            f"{s['title']}\n"
            f"Sources: {s['source_count']} · {first_source}\n"
            f"Sentiment: {s['sentiment']}"
        )
        try:
            await bot.send_message(chat_id=chat_id, text=msg, parse_mode="Markdown")
        except Exception as e:
            print(f"  news alert push failed (cluster={cluster_key}): {str(e)[:150]}")
            continue

        sb.table("news_alerts_sent").insert({
            "cluster_key": cluster_key,
            "ticker": matched[0],
            "title": s["title"][:200],
        }).execute()
        sent += 1

    result = {"candidates": len(candidates), "sent": sent, "skipped_dupe": skipped_dupe}
    print(f"news_alerts: candidates={len(candidates)} sent={sent} skipped_dupe={skipped_dupe}")
    return result


if __name__ == "__main__":
    asyncio.run(check())

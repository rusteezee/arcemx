"""Consumer-app review sentiment fetcher (side signal, KB section 42).

Uses Google Play star ratings as the sentiment signal DIRECTLY - not a
separate NLP text classifier - since a 1-5 star rating already IS a
calibrated sentiment number, more reliable than inferring polarity from
free text, and it avoids adding a whole new NLP dependency for a signal
this simple.

Deliberately a SLOW signal, not a next-day trigger: review sentiment
drifts over weeks, not days - there's no "event" the way a same-day
NSE filing is one. Feeds `portfolio_verdicts` reasoning (hold/add/trim/
exit on an EXISTING holding) only. Explicitly NOT wired into
holding_outlooks_1d / wishlist_outlooks_1d, which are next-day
directional calls - see llm_router.py's prompt guidance for this field
and the "is this going to add real value" discussion this addition
came out of.

Windows are REVIEW-COUNT-based (newest N vs the N before that), not
calendar-day-based. Root-caused live 2026-09-06: Nykaa's app gets ~100
reviews/day - a 900-review pull (paginated, ~5 requests) never even
reached a 30-day-old review, let alone the 90-day baseline behind it.
A fixed day-window design either wildly overfetches for a high-volume
app or starves for a low-volume one; a fixed review-COUNT window costs
the same regardless of app size and is comparing like-for-like sample
sizes either way. The actual calendar span each window covers is
reported alongside the averages so the reader knows whether "recent"
means the last 2 days or the last 2 months for this specific app.

TICKER_TO_PLAY_STORE_ID is a small, manually-maintained map - one entry
per company with a real consumer app. No auto-discovery/fuzzy matching:
guessing the wrong package ID would silently attribute a different
company's reviews to this ticker, which is worse than having no data.
Add entries here as new app-based companies enter holdings/wishlist.
"""
from __future__ import annotations

from datetime import datetime, timezone

from google_play_scraper import Sort, reviews

# ticker -> Google Play package ID. Verified live 2026-09-06.
TICKER_TO_PLAY_STORE_ID = {
    "NYKAA.NS": "com.fsn.nykaa",  # FSN E-Commerce Ventures Limited
}


def _as_aware(dt) -> "datetime | None":
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def fetch_recent_reviews(ticker: str, total: int = 600) -> "list[dict] | None":
    """Newest `total` reviews (with text) for `ticker`'s mapped app,
    paginated via google_play_scraper's continuation_token (each page
    caps at 200 server-side). None if the ticker has no known app or
    the fetch fails entirely - callers must treat that as "no data",
    never as neutral or bad sentiment."""
    app_id = TICKER_TO_PLAY_STORE_ID.get(ticker.upper())
    if not app_id:
        return None
    all_rows: list[dict] = []
    token = None
    try:
        while len(all_rows) < total:
            batch, token = reviews(
                app_id, lang="en", country="in",
                sort=Sort.NEWEST, count=200, continuation_token=token,
            )
            if not batch:
                break
            all_rows.extend(batch)
            if token is None:
                break
        return all_rows
    except Exception as e:
        print(f"app_reviews: fetch fail for {ticker} ({app_id}): {e}")
        return all_rows or None


def sentiment_summary(ticker: str, window: int = 200) -> "dict | None":
    """Compares the average star rating of the newest `window` reviews
    against the `window` reviews immediately before those, using real
    Play Store ratings as the sentiment signal - not a generated score.
    Returns None if the ticker has no mapped app, the fetch fails, or
    there are fewer than 20 reviews in the recent window (too thin a
    sample to mean anything). `baseline_avg_rating`/`delta` are None
    (not 0) when there aren't enough older reviews for a second window -
    a missing comparison is not the same claim as "no change"."""
    rows = fetch_recent_reviews(ticker, total=window * 2)
    if not rows:
        return None

    recent = rows[:window]
    baseline = rows[window:window * 2]
    if len(recent) < 20:
        return None

    def _span_days(chunk: list[dict]) -> "int | None":
        if not chunk:
            return None
        newest, oldest = _as_aware(chunk[0].get("at")), _as_aware(chunk[-1].get("at"))
        if newest is None or oldest is None:
            return None
        return (newest - oldest).days

    recent_avg = sum(r["score"] for r in recent) / len(recent)
    baseline_avg = (sum(r["score"] for r in baseline) / len(baseline)
                    if len(baseline) >= 20 else None)
    worst = sorted(recent, key=lambda r: r["score"])[:3]

    return {
        "app_id": TICKER_TO_PLAY_STORE_ID.get(ticker.upper()),
        "recent_avg_rating": round(recent_avg, 2),
        "recent_n": len(recent),
        "recent_span_days": _span_days(recent),
        "baseline_avg_rating": round(baseline_avg, 2) if baseline_avg is not None else None,
        "baseline_n": len(baseline),
        "baseline_span_days": _span_days(baseline),
        "delta": round(recent_avg - baseline_avg, 2) if baseline_avg is not None else None,
        "worst_recent_reviews": [
            {"score": r["score"], "content": (r.get("content") or "")[:200]}
            for r in worst if r.get("content")
        ],
    }


if __name__ == "__main__":
    import json
    for tk in TICKER_TO_PLAY_STORE_ID:
        print(f"--- {tk} ---")
        print(json.dumps(sentiment_summary(tk), indent=2, default=str))

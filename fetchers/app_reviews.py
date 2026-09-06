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

TICKER_TO_PLAY_STORE_ID is a small, manually-maintained map - one entry
per company with a real consumer app. No auto-discovery/fuzzy matching:
guessing the wrong package ID would silently attribute a different
company's reviews to this ticker, which is worse than having no data.
Add entries here as new app-based companies enter holdings/wishlist.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from google_play_scraper import Sort, reviews

# ticker -> Google Play package ID. Verified live 2026-09-06.
TICKER_TO_PLAY_STORE_ID = {
    "NYKAA.NS": "com.fsn.nykaa",  # FSN E-Commerce Ventures Limited
}


def fetch_recent_reviews(ticker: str, min_days_coverage: int = 120,
                         max_total: int = 900) -> "list[dict] | None":
    """Reviews for `ticker`'s mapped app, newest first, paginated via
    google_play_scraper's continuation_token until either the oldest
    review fetched is >= `min_days_coverage` days old or `max_total` is
    hit. A single 200-review page for a high-volume app like Nykaa
    (~5/day) only reaches back ~40 days - not enough to cover both a
    30-day recent window AND a 90-day baseline window behind it
    (verified live 2026-09-06: a 150-review pull returned 0 baseline
    rows, all 150 fell inside the last 30 days). None if the ticker has
    no known app or the fetch fails entirely - callers must treat that
    as "no data", never as neutral or bad sentiment."""
    app_id = TICKER_TO_PLAY_STORE_ID.get(ticker.upper())
    if not app_id:
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(days=min_days_coverage)
    all_rows: list[dict] = []
    token = None
    try:
        while len(all_rows) < max_total:
            batch, token = reviews(
                app_id, lang="en", country="in",
                sort=Sort.NEWEST, count=200, continuation_token=token,
            )
            if not batch:
                break
            all_rows.extend(batch)
            oldest = _as_aware(batch[-1].get("at"))
            if oldest is not None and oldest <= cutoff:
                break
            if token is None:
                break
        return all_rows
    except Exception as e:
        print(f"app_reviews: fetch fail for {ticker} ({app_id}): {e}")
        return all_rows or None


def _as_aware(dt) -> "datetime | None":
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def sentiment_summary(ticker: str, recent_days: int = 30, baseline_days: int = 90) -> "dict | None":
    """Compares average star rating over the last `recent_days` against
    the `baseline_days` immediately before that window, using real Play
    Store ratings as the sentiment signal - not a generated score.
    Returns None if the ticker has no mapped app, the fetch fails, or
    there are fewer than 5 reviews in the recent window (too thin a
    sample to mean anything). `delta` is None (not 0) when the baseline
    window itself is too thin - a missing comparison is not the same
    claim as "no change"."""
    rows = fetch_recent_reviews(ticker, min_days_coverage=recent_days + baseline_days)
    if not rows:
        return None
    now = datetime.now(timezone.utc)
    recent_cut = now - timedelta(days=recent_days)
    baseline_cut = now - timedelta(days=recent_days + baseline_days)

    recent, baseline = [], []
    for r in rows:
        at = _as_aware(r.get("at"))
        if at is None:
            continue
        if at >= recent_cut:
            recent.append(r)
        elif at >= baseline_cut:
            baseline.append(r)

    if len(recent) < 5:
        return None

    recent_avg = sum(r["score"] for r in recent) / len(recent)
    baseline_avg = (sum(r["score"] for r in baseline) / len(baseline)
                    if len(baseline) >= 5 else None)
    worst = sorted(recent, key=lambda r: r["score"])[:3]

    return {
        "app_id": TICKER_TO_PLAY_STORE_ID.get(ticker.upper()),
        "recent_avg_rating": round(recent_avg, 2),
        "recent_n": len(recent),
        "baseline_avg_rating": round(baseline_avg, 2) if baseline_avg is not None else None,
        "baseline_n": len(baseline),
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

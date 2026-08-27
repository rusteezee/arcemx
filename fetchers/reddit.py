"""Reddit hot posts from Indian investing subs.

Primary path is Apify's trudax/reddit-scraper-lite actor, not Reddit's own
OAuth API: Reddit closed self-serve app registration in Nov 2025 under its
Responsible Builder Policy (confirmed live 2026-08-28 - reddit.com/prefs/apps
now blocks "create app" outright with a link to the policy, and small/
personal projects are the most-rejected category in the manual approval
queue that replaced it). PRAW is kept as a fallback ONLY: if
REDDIT_CLIENT_ID/SECRET ever get filled in (approval granted, or Reddit
loosens the gate), it activates automatically with no code change needed.

Apify pricing is PAY_PER_EVENT, $0.004/result (verified live via the Apify
API 2026-08-28, not blog estimates - a same-family rental-priced actor,
trudax/reddit-scraper at $45/month flat, was checked and rejected for this
reason). limit=10 keeps 4 subs x 10 posts x ~30 days/month = ~1200
results/month x $0.004 = ~$4.80, inside Apify's $5/month free platform
credit. Raising limit raises real cost - see KNOWLEDGE_BASE.md before
changing the call site's default.
"""
import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()

SUBS = ["IndianStockMarket", "IndiaInvestments", "StockMarketIndia", "DalalStreetTalks"]

_APIFY_ACTOR = "trudax~reddit-scraper-lite"
_APIFY_BASE = f"https://api.apify.com/v2/acts/{_APIFY_ACTOR}"

_APIFY_RUN_TIMEOUT_S = 600  # actor-side timeoutSecs. Measured live 2026-08-28
                            # across several runs: single-subreddit duration
                            # ranges 184s-534s+ (headless-browser scroll,
                            # inherently variable, not tuned away by input
                            # params). 600s absorbs the observed worst case
                            # with margin. Treat whatever comes back (even
                            # short of `limit`) as a valid best-effort
                            # result, not a failure - this is a sentiment
                            # signal, not core trade data, same tolerance as
                            # other soft-fail fetchers in this codebase.
_POLL_INTERVAL_S = 5

# Async start-then-poll, NOT the synchronous run-sync-get-dataset-items
# endpoint. Root-caused live 2026-08-28: running 4 subreddits concurrently
# via urllib holding 4 long-lived (200-600s) HTTP connections open at once
# caused every single one to report a client-side read timeout, even though
# Apify's own run records showed 3 of 4 actually SUCCEEDED server-side well
# inside the window (255s/319s/341s vs a 630s client timeout). Short-lived
# poll requests every 5s avoid whatever the long-held-connection problem was.


def _fetch_one_sub(sub: str, limit: int, token: str) -> list[dict]:
    body = {
        "startUrls": [{"url": f"https://www.reddit.com/r/{sub}/hot/"}],
        "maxItems": limit,
        "maxPostCount": limit,
        "maxComments": 0,
        "skipComments": True,
        "skipCommunity": True,
        "skipUserPosts": True,
        "includeMediaLinks": True,
    }
    headers = {"Authorization": f"Bearer {token}"}
    try:
        start = requests.post(
            f"{_APIFY_BASE}/runs",
            params={"timeout": _APIFY_RUN_TIMEOUT_S},
            json=body, headers=headers, timeout=30,
        )
        start.raise_for_status()
        run_id = start.json()["data"]["id"]

        deadline = time.monotonic() + _APIFY_RUN_TIMEOUT_S + 30
        status = None
        while time.monotonic() < deadline:
            time.sleep(_POLL_INTERVAL_S)
            r = requests.get(f"https://api.apify.com/v2/actor-runs/{run_id}",
                              headers=headers, timeout=30)
            r.raise_for_status()
            status = r.json()["data"]["status"]
            if status in ("SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"):
                break

        if status != "SUCCEEDED":
            print(f"reddit (apify) {sub}: run ended with status={status}")
        if status is None:
            return []  # never reached a terminal state within the deadline

        # Fetch the dataset even on FAILED/TIMED-OUT/ABORTED - a run that
        # scraped some posts before dying still has usable partial results
        # sitting in its dataset (best-effort tolerance, see module docstring).
        items_r = requests.get(
            f"https://api.apify.com/v2/actor-runs/{run_id}/dataset/items",
            headers=headers, timeout=60)
        items_r.raise_for_status()
        items = items_r.json()
    except requests.RequestException as e:
        print(f"reddit (apify) fail {sub}: {e}")
        return []

    out = []
    for it in items:
        if it.get("dataType") != "post":
            continue
        out.append({
            "sub": sub,
            "title": it.get("title") or "",
            "score": it.get("upVotes") or 0,
            "comments": it.get("numberOfComments") or 0,
            "url": it.get("url") or "",
            "text": (it.get("body") or "")[:500],
        })
    return out


def _fetch_hot_apify(limit: int) -> list[dict]:
    token = os.getenv("APIFY_API_TOKEN")
    if not token:
        return []
    # Each subreddit is a separate ~200s Apify run (headless-browser scroll
    # per sub) - sequential would add ~13 min to the daily pipeline for 4
    # subs. Fetched concurrently instead: wall-clock is bounded by the
    # slowest single sub, not the sum of all 4. Measured live 2026-08-28.
    from concurrent.futures import ThreadPoolExecutor
    out = []
    with ThreadPoolExecutor(max_workers=len(SUBS)) as ex:
        for result in ex.map(lambda sub: _fetch_one_sub(sub, limit, token), SUBS):
            out.extend(result)
    return out


def _fetch_hot_praw(limit: int) -> list[dict]:
    import praw
    cid = os.getenv("REDDIT_CLIENT_ID")
    cs = os.getenv("REDDIT_CLIENT_SECRET")
    ua = os.getenv("REDDIT_USER_AGENT", "arcemx/0.1")
    reddit = praw.Reddit(client_id=cid, client_secret=cs, user_agent=ua)
    out = []
    for sub in SUBS:
        try:
            for post in reddit.subreddit(sub).hot(limit=limit):
                if post.stickied:
                    continue
                out.append({
                    "sub": sub,
                    "title": post.title,
                    "score": post.score,
                    "comments": post.num_comments,
                    "url": f"https://reddit.com{post.permalink}",
                    "text": (post.selftext or "")[:500],
                })
        except Exception as e:
            print(f"reddit (praw) fail {sub}: {e}")
    return out


def fetch_hot(limit: int = 25) -> list[dict]:
    if os.getenv("REDDIT_CLIENT_ID") and os.getenv("REDDIT_CLIENT_SECRET"):
        return _fetch_hot_praw(limit)
    if os.getenv("APIFY_API_TOKEN"):
        return _fetch_hot_apify(limit)
    print("Reddit not configured (no APIFY_API_TOKEN, no REDDIT_CLIENT_ID/SECRET)")
    return []


if __name__ == "__main__":
    posts = fetch_hot()
    print(f"Reddit posts: {len(posts)}")
    for p in posts[:5]:
        print(p["sub"], p["score"], p["title"])

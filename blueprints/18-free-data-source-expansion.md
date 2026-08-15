# BLUEPRINT 18: Free News Source Expansion (dead-feed fix + verified new feeds)

BUILDER: Claude Haiku, working alone, cold start, cannot ask questions.
(Haiku because this is a mechanical two-file change with every URL, weight and function
shape given verbatim below; zero design decisions remain.)

GOAL
The hourly news fetch pulls from a wider, fully verified set of free sources: two dead
feeds removed, three live ones added (NDTV Profit, Hindu BusinessLine, Google News India
market query), plus a second GNews query. Every source was probe-verified live on
2026-07-13; nothing here is guessed.

CONTEXT THE BUILDER NEEDS (it has no memory of the planning chat)
- Repo: `C:\Users\rahul\Downloads\stock-ai`, branch `master`. Python 3.11 via
  `.venv\Scripts\python.exe` (system python is 3.14, never use bare `python`).
- Files to read first:
  1. `fetchers/news.py`: `RSS_FEEDS` dict at top, `fetch_rss()`, `fetch_gnews()`,
     `push()` upserting to Supabase `news` table on conflict `url`.
  2. `analyzer/news_digest.py` lines 20-30: `SOURCE_WEIGHTS` dict; unlisted sources
     default to 0.5; matching is substring (`if key in source_lowercased`).
- Probe results (2026-07-13, all live-verified, do not re-litigate):
  - DEAD `https://feeds.reuters.com/reuters/businessNews` (connection fails; Reuters
    retired public RSS in 2022). Remove.
  - DEAD `https://www.business-standard.com/rss/markets-106.rss` (403 bot-block). Remove.
  - LIVE `https://feeds.feedburner.com/ndtvprofit-latest` (NDTV Profit latest).
  - LIVE `https://www.thehindubusinessline.com/markets/feeder/default.rss` (BusinessLine
    markets; feed title confirms Sensex/Nifty focus).
  - LIVE `https://news.google.com/rss/search?q=nifty+OR+sensex+OR+%22indian+stock+market%22&hl=en-IN&gl=IN&ceid=IN:en`
    (Google News query feed; returns market stories from many outlets; item titles end
    with " - PublisherName").
  - REJECTED after probing: GDELT DOC API (rate-limit refusals even at the documented
    1-req-per-5s spacing; shared-IP risk on GitHub runners), 5paisa RSS (feed effectively
    empty), Business Today RSS (generic "LATEST" noise, not markets), Financial Express
    (feed URL redirects to an HTML page), pytrends/Google Trends (unofficial library,
    429s from datacenter IPs). Do not add any of these.
- GNews free tier: 100 requests/day. The hourly cron currently spends 24/day (one query
  per run). Adding a second query makes it 48/day, still safely under cap.
- Gotcha: Blueprint 17 also edits `fetchers/news.py` (adds ticker linking). Build this
  AFTER 17 is merged. If 17 turns out not to be merged yet, these edits are still safe
  (different regions of the file); tag `ASSUMPTION: built before blueprint 17` and go on.
- Gotcha: Google News item URLs are news.google.com redirect links, so the same story
  fetched from both a direct feed and Google News stores as two `news` rows (different
  `url`). That is fine: `analyzer/news_digest.py` clusters near-duplicate titles, so the
  story counts once downstream. Do not build URL-level dedup.

CONSTRAINTS
- Must stay inside: `fetchers/news.py`, `analyzer/news_digest.py` (SOURCE_WEIGHTS dict
  only).
- Must not change: the `news` table schema, the upsert conflict key, `push()`,
  `build_news_digest` logic, any workflow file, any other module.
- Stack to respect: feedparser, requests, dateutil (already in requirements.txt). No new
  dependencies.
- Non-negotiables: zero spend, no new API keys, no em dashes (U+2014) anywhere, no emojis.

STEP-BY-STEP PLAN (in build order)

1. `fetchers/news.py`, `RSS_FEEDS` dict: delete the `"reuters_business"` and
   `"business_standard"` entries; add exactly:
   ```python
   "ndtv_profit": "https://feeds.feedburner.com/ndtvprofit-latest",
   "businessline_markets": "https://www.thehindubusinessline.com/markets/feeder/default.rss",
   ```

2. `fetchers/news.py`: add a new function after `fetch_rss()`:
   ```python
   GOOGLE_NEWS_RSS = ("https://news.google.com/rss/search"
                      "?q=nifty+OR+sensex+OR+%22indian+stock+market%22"
                      "&hl=en-IN&gl=IN&ceid=IN:en")

   def fetch_google_news(max_n: int = 40) -> list[dict]:
       """Google News query feed. Item titles end with ' - Publisher'; split
       that off so clustering sees the clean headline and the digest can
       weight the real outlet (source becomes 'gnn:<publisher lowercase>')."""
       items = []
       try:
           feed = feedparser.parse(GOOGLE_NEWS_RSS)
       except Exception as e:
           print(f"Google News fail: {e}")
           return items
       for entry in feed.entries[:max_n]:
           raw_title = (entry.get("title") or "").strip()
           if not raw_title:
               continue
           title, publisher = raw_title, ""
           if " - " in raw_title:
               title, publisher = raw_title.rsplit(" - ", 1)
           published = entry.get("published") or entry.get("updated")
           try:
               pub_dt = dateparser.parse(published) if published else datetime.now(timezone.utc)
           except Exception:
               pub_dt = datetime.now(timezone.utc)
           items.append({
               "source": f"gnn:{publisher.strip().lower()}" if publisher else "gnn:unknown",
               "title": title.strip(),
               "url": entry.get("link", ""),
               "summary": "",
               "published_at": pub_dt.isoformat(),
           })
       return items
   ```

3. `fetchers/news.py`, `fetch_gnews()`: no signature change. In `__main__`, change the
   collection line to run both feeds and a second GNews query:
   ```python
   items = (fetch_rss() + fetch_google_news()
            + fetch_gnews() + fetch_gnews(query="nifty sensex earnings results"))
   ```
   (If Blueprint 17 already added a ticker-linking loop in `__main__`, keep that loop
   AFTER this line so the new items get linked too.)

4. `analyzer/news_digest.py`, `SOURCE_WEIGHTS` dict: add exactly these entries (matching
   is substring, so `"gnn:the economic times"` hits `"economic times"`):
   ```python
   "ndtv_profit": 0.8, "ndtv profit": 0.8,
   "businessline": 0.85,
   "economic times": 0.85,
   "business standard": 0.8,
   ```
   Leave everything else in the dict untouched; unknown Google News publishers correctly
   fall to the 0.5 default.

5. Run `python scripts/strip_emdash.py` from repo root, then
   `.venv\Scripts\python.exe -m py_compile fetchers/news.py analyzer/news_digest.py`.

EXACT INPUTS TO USE
- Files to open, by name: `fetchers/news.py`, `analyzer/news_digest.py`.
- The one prompt to hand the builder: "Open blueprints/18-free-data-source-expansion.md
  in C:\Users\rahul\Downloads\stock-ai and build it exactly as written, steps 1-5 in
  order. Only the two files named in CONSTRAINTS may change."
- Values to use verbatim: every URL, dict key and weight above; the
  `fetch_google_news` function body as printed.

DEFINITION OF DONE (checklist, every box pass or fail)
[ ] `.venv\Scripts\python.exe -m py_compile` passes on both files.
[ ] `.venv\Scripts\python.exe -m fetchers.news` prints a fetched count noticeably above
    the old baseline and stores rows with sources `ndtv_profit`, `businessline_markets`,
    and at least one `gnn:` source (verify via the printed output or a supabase select).
[ ] No stored `gnn:` row's title still carries a trailing " - Publisher" suffix.
[ ] `RSS_FEEDS` no longer contains `reuters_business` or `business_standard`.
[ ] GNews spend stays at 2 requests per hourly run (only the two calls in step 3).
[ ] No em dash, no emoji in the diff; nothing outside the two named files changed.

IF SOMETHING IS UNCLEAR (anti-stall)
Make the smallest safe assumption, write it at the top of the output as "ASSUMPTION: ...",
and keep going. Never stall, never ask, never invent big new scope.

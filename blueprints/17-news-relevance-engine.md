# BLUEPRINT 17: News Relevance Engine (ticker linking + portfolio-aware intraday alerts)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(Sonnet because this touches 5 files across fetcher, analyzer, bot, workflow and schema, and
adds one new standalone script; too cross-cutting for Haiku.)

GOAL
Every fetched news story is linked to the specific universe tickers it mentions, the morning
LLM digest boosts stories touching the user's holdings/watchlist, and a new hourly job pushes
a Telegram alert within the hour whenever material news hits a stock the user holds or
watches. Zero LLM calls added; everything deterministic.

CONTEXT THE BUILDER NEEDS (it has no memory of the planning chat)
- Repo: `C:\Users\rahul\Downloads\stock-ai`, branch `master`. Python 3.11 via
  `.venv\Scripts\python.exe` (system python is 3.14, never use bare `python`).
- Files to read first, in this order:
  1. `fetchers/news.py` (whole file, ~97 lines): fetch_rss + fetch_gnews + push(upsert on url).
  2. `analyzer/news_digest.py` (whole file, ~231 lines): dedup clustering, materiality
     ranking, lexicon sentiment. You will extend it, not rewrite it.
  3. `bot/alerts_checker.py`: the standalone-push pattern to mirror (Bot.send_message,
     no telegram_bot.py import).
  4. `analyzer/aggregator.py` lines 340-395: how news rows are selected and
     `build_news_digest(merged, top_n=20)` is called (line ~380; select at line ~359).
  5. `db/schema.sql` lines 12-23: the `news` table. It ALREADY has `tickers text[]` and
     `sentiment numeric` columns; the fetcher never populates them. `tickers` is the gap
     this blueprint fills. Do not add a new column for it.
  6. `.github/workflows/hourly_news.yml`: hourly cron (`0 * * * *` UTC) running
     `python -m fetchers.news`.
- `data/universe.csv`: 505 rows + header `ticker,name,cap,sector`. Tickers like
  `RELIANCE.NS`; indices start with `^` and have `sector=INDEX` (e.g. `^NSEI`). Example
  row: `360ONE.NS,360 ONE WAM Ltd.,mid,Financial Services`.
- `portfolio` and `wishlist` tables: columns include `user_id text` (value `'default'`)
  and `ticker text` (same `.NS` form as universe).
- Env vars available in GH Actions secrets and `.env`: `SUPABASE_URL`, `SUPABASE_KEY`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Gotchas found while grounding:
  - Supabase Python client CANNOT run DDL. New tables go in `db/schema.sql` AND the final
    report must tell the user to paste the new DDL block into Supabase SQL Editor.
  - PostgREST caps every response at 1000 rows regardless of `.limit()`.
  - Telegram messages use legacy Markdown: no literal underscores in display text. Source
    names like `et_markets` contain underscores; replace `_` with a space before display.
  - AGENTS.md bans emojis in user-facing text and em dashes (U+2014) everywhere. The
    existing bell emoji in alerts_checker.py is legacy; do NOT copy it into new code.
  - The news digest is embedded in the LLM payload (120k char cap). Cap the `tickers`
    list at 5 per story in digest output to keep growth negligible.
  - hourly_news.yml installs only `requirements.txt` (no torch). Do not import
    `analyzer/embed.py` or anything from `requirements-embed.txt` in this pipeline.

CONSTRAINTS
- Must stay inside: `fetchers/news.py`, `analyzer/news_digest.py`, `analyzer/aggregator.py`
  (only the two lines named below), `bot/news_alerts.py` (new), `db/schema.sql` (append
  only), `.github/workflows/hourly_news.yml` (append one step).
- Must not change: `bot/alerts_checker.py`, `bot/daily_push.py`, `bot/telegram_bot.py`,
  any existing table's columns, the news upsert conflict key (`url`), the existing digest
  fields (only ADD fields), gate/trading code.
- Stack to respect: feedparser, requests, supabase-py, python-telegram-bot (all already in
  requirements.txt). No new dependencies.
- Non-negotiables: zero new LLM/API calls; zero new spend; no emojis; no em dashes
  (run `python scripts/strip_emdash.py` from repo root when done); deterministic logic only.

STEP-BY-STEP PLAN (in build order)

1. `db/schema.sql`. Append at the end, before the RLS section if one exists at the
   bottom, otherwise at end of file:
   ```sql
   -- Blueprint 17: one row per news story alerted to Telegram, so the hourly
   -- news-alert job never re-sends the same story.
   create table if not exists news_alerts_sent (
       id bigserial primary key,
       cluster_key text not null unique,
       ticker text,
       title text,
       sent_at timestamptz default now()
   );
   alter table news_alerts_sent enable row level security;
   ```
   No anon policy (matches the news/mcp_tokens pattern; the service key bypasses RLS).

2. `fetchers/news.py`. Add ticker linking:
   - Module-level:
     ```python
     from pathlib import Path
     import csv, re
     _UNIVERSE_CSV = Path(__file__).resolve().parent.parent / "data" / "universe.csv"
     _NAME_SUFFIXES = {"ltd", "ltd.", "limited", "(india)", "india"}
     _FIRSTWORD_BLOCK = {"indian", "national", "central", "united", "oriental",
                         "general", "bank", "india", "power", "state", "new"}
     _SYMBOL_BLOCK = {"IDEA", "POWER", "BANK", "INDIA", "TATA", "GOLD", "NIFTY", "CARE"}
     ```
   - `def _load_alias_map() -> dict[str, list[str]]`: read universe.csv; skip rows where
     ticker starts with `^` or sector == `INDEX`. For each row build lowercase name
     aliases: (a) full name lowercased with trailing `_NAME_SUFFIXES` tokens stripped;
     (b) first two words of (a) if (a) has 3+ words; (c) first word of (a) alone only if
     it is 6+ chars and not in `_FIRSTWORD_BLOCK`. Drop any alias under 5 chars. Also
     store the symbol root `ticker.split(".")[0]` separately when it is 4+ chars,
     alphabetic only, and not in `_SYMBOL_BLOCK`. Return
     `{ticker: {"names": [...], "symbol": root_or_None}}` (adjust the type hint to match).
     Compile one regex per ticker for names: `re.compile(r"\b(" + "|".join(map(re.escape,
     names)) + r")\b")`. Cache the whole map in a module-level `_ALIAS_CACHE` built once.
   - `def link_tickers(title: str, summary: str) -> list[str]`: lowercase
     `title + " " + summary` and run each ticker's name regex against it; additionally
     split the ORIGINAL (not lowercased) text on non-alphanumerics and match tokens that
     are all-uppercase and equal to a symbol root. Return sorted unique tickers, max 10.
   - In `__main__` (and so the workflow path), after `items = fetch_rss() + fetch_gnews()`
     add: `for it in items: it["tickers"] = link_tickers(it["title"], it.get("summary") or "")`.
     `push()` needs no change; the upsert dict now carries `tickers` and the column exists.

3. `analyzer/news_digest.py`. Extend (do not restructure):
   - Signature: `def build_news_digest(items, top_n=20, held=None, watched=None)`.
     First lines: `held = set(held or ()); watched = set(watched or ())`.
   - In the `norm.append({...})` dict add `"tickers": list(it.get("tickers") or [])`.
   - Per cluster, compute `cluster_tickers = sorted({t for m in c["members"] for t in
     m["tickers"]})[:5]`, `portfolio_hit = bool(set(cluster_tickers) & held)`,
     `watchlist_hit = bool(set(cluster_tickers) & watched)`.
   - Relevance override: if `portfolio_hit`, relevance = 1.3; elif `watchlist_hit`,
     relevance = 1.15; else keep the existing `max(_relevance(m["title"]) ...)` value.
   - `cluster_key = hashlib.md5(",".join(sorted(c["seed"])).encode()).hexdigest()[:16]`
     (import hashlib at top).
   - Add to each digest story dict: `"tickers": cluster_tickers`,
     `"portfolio_hit": portfolio_hit`, `"watchlist_hit": watchlist_hit`,
     `"cluster_key": cluster_key`, and also `"sent_score": score` (the signed int from
     `_sentiment`, needed by the alert job).
   - Append one sentence to the `note` string: `" Stories tagged portfolio_hit touch the
     user's holdings and are relevance-boosted."`
   - In `__main__`, change the select to `"source,title,published_at,tickers"`.

4. `analyzer/aggregator.py`. Exactly two changes:
   - Line ~359: change the select string from `"source,title,url,published_at"` to
     `"source,title,url,published_at,tickers"`.
   - Immediately before the `build_news_digest(merged, top_n=20)` call (line ~380), add:
     ```python
     _held = {r["ticker"] for r in (sb.table("portfolio").select("ticker").execute().data or [])}
     _watched = {r["ticker"] for r in (sb.table("wishlist").select("ticker").execute().data or [])}
     ```
     and change the call to
     `build_news_digest(merged, top_n=20, held=_held, watched=_watched)`.
     Reuse whatever the supabase client variable is actually named in that scope (read
     the surrounding code; it may not be `sb`).

5. `bot/news_alerts.py` (NEW). Standalone cron script mirroring `bot/alerts_checker.py`
   (module docstring, load_dotenv, async `check()`, `asyncio.run` in `__main__`). Logic:
   1. Build supabase client; read `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
   2. `held` from `portfolio`, `watched` from `wishlist` (select ticker, same as step 4).
      If both empty: print `"news_alerts: no holdings or watchlist, nothing to do"`, return.
   3. Select news rows where `fetched_at >= now-2h` (UTC, `.gte("fetched_at", iso)`),
      columns `"source,title,url,summary,published_at,tickers"`, `.limit(500)`.
      `fetched_at` not `published_at`, so a late-fetched older story still alerts once.
   4. `digest = build_news_digest(rows, top_n=50, held=held, watched=watched)`.
   5. Candidates: stories where `(portfolio_hit or watchlist_hit) and materiality >= 1.0`.
      Sort by materiality desc, keep at most 3 per run.
   6. For each candidate, dedupe: `sb.table("news_alerts_sent").select("id")
      .eq("cluster_key", s["cluster_key"]).execute()`; skip if any row returned.
   7. Send via `telegram.Bot(token).send_message(chat_id=TELEGRAM_CHAT_ID,
      parse_mode="Markdown")` with EXACTLY this message shape (legacy Markdown, no
      emoji, underscores in source names replaced with spaces):
      ```
      *News Alert: {", ".join(t.split(".")[0] for t in matched)}*
      {title}
      Sources: {source_count} · {first source, underscores to spaces}
      Sentiment: {sentiment}
      ```
      where `matched = [t for t in s["tickers"] if t in held or t in watched]`.
   8. After a successful send, insert into `news_alerts_sent`:
      `{"cluster_key": ..., "ticker": matched[0], "title": title[:200]}`.
   9. Print `f"news_alerts: candidates={n} sent={m} skipped_dupe={k}"`.
   No quiet hours: the user wants alerts as soon as possible, 24/7.

6. `.github/workflows/hourly_news.yml`. Append one step after the existing
   "Fetch news" step:
   ```yaml
       - name: News alerts
         env:
           SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
           SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
           TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
           TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
         run: python -m bot.news_alerts
   ```

7. Run `python scripts/strip_emdash.py` from repo root (idempotent), then
   `.venv\Scripts\python.exe -m py_compile fetchers/news.py analyzer/news_digest.py
   bot/news_alerts.py analyzer/aggregator.py`.

EXACT INPUTS TO USE
- Files to open or create, by name: `fetchers/news.py`, `analyzer/news_digest.py`,
  `analyzer/aggregator.py`, `bot/news_alerts.py` (create), `db/schema.sql`,
  `.github/workflows/hourly_news.yml`, `data/universe.csv` (read only),
  `bot/alerts_checker.py` (read only, pattern reference).
- The one prompt to hand the builder: "Open blueprints/17-news-relevance-engine.md in
  C:\Users\rahul\Downloads\stock-ai and build it exactly as written, steps 1-7 in order.
  Read the files listed under CONTEXT first. Do not touch files outside CONSTRAINTS."
- Values to use verbatim: the DDL block in step 1, the blocklist sets in step 2, the
  relevance boosts 1.3 / 1.15, materiality threshold 1.0, max 3 alerts per run, 2-hour
  fetched_at window, 16-char md5 cluster_key, the Telegram message shape in step 5.7.

DEFINITION OF DONE (checklist, every box pass or fail)
[ ] `.venv\Scripts\python.exe -m py_compile` passes on all four touched Python files.
[ ] `.venv\Scripts\python.exe -m fetchers.news` runs clean and at least one stored row
    whose title names a universe company has a non-empty `tickers` array (verify with a
    supabase select on the newest 50 rows).
[ ] `.venv\Scripts\python.exe -m analyzer.news_digest` prints stories carrying `tickers`,
    `portfolio_hit`, `cluster_key`, `sent_score` keys.
[ ] `.venv\Scripts\python.exe -m bot.news_alerts` runs end to end; a second immediate run
    sends 0 duplicates (prints skipped_dupe >= sent of first run when candidates existed).
[ ] A story titled "Reliance Industries profit jumps 12%" links to `RELIANCE.NS`; a story
    titled "New idea for weekend getaways" links to nothing (IDEA is blocklisted).
[ ] `db/schema.sql` contains the `news_alerts_sent` block and the final report tells the
    user to paste it into Supabase SQL Editor before the next hourly run.
[ ] hourly_news.yml has the new step with all four env vars.
[ ] No emoji and no em dash anywhere in the diff; `python scripts/strip_emdash.py` reports
    nothing to fix.
[ ] Nothing outside the CONSTRAINTS file list was modified.

IF SOMETHING IS UNCLEAR (anti-stall)
Make the smallest safe assumption, write it at the top of the output as "ASSUMPTION: ...",
and keep going. Never stall, never ask, never invent big new scope.

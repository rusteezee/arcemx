"""Pre-process the raw news feed into a structured, deduped digest.

The aggregator was dumping ~120 raw headlines into the prompt. That feed is
heavily duplicated (the same story from many outlets) and noisy (generic
recaps), so the model wasted attention and got a weak signal. This module
turns the feed into signal:

- Clusters near-duplicate headlines so one story counts once.
- Ranks stories by materiality: how many credible sources carry it, source
  credibility, and recency. Many credible outlets on one story = it matters.
- Tags a deterministic finance-lexicon sentiment per story as a HINT (the
  LLM still judges nuance), plus an aggregate net sentiment and the dominant
  themes across the feed.

Everything here is deterministic and explainable, no extra API or model call.
"""
import re
from collections import Counter
from datetime import datetime, timezone

# Higher = more trusted/market-moving. Unlisted sources default to 0.5.
SOURCE_WEIGHTS = {
    "reuters": 1.0, "bloomberg": 1.0, "cnbc": 0.9,
    "et_markets": 0.85, "et_stocks": 0.85, "economictimes": 0.85,
    "moneycontrol_markets": 0.8, "moneycontrol_business": 0.8, "moneycontrol": 0.8,
    "livemint_markets": 0.8, "livemint": 0.8, "mint": 0.8,
    "business_standard": 0.8,
}

POS_WORDS = {
    "surge", "surges", "jump", "jumps", "rally", "rallies", "gain", "gains",
    "rise", "rises", "soar", "soars", "profit", "profits", "beat", "beats",
    "upgrade", "upgraded", "bullish", "record", "high", "boost", "boosts",
    "strong", "growth", "outperform", "buy", "expansion", "recovery", "optimism",
    "inflow", "inflows", "wins", "win", "approval", "approved", "deal", "rebound",
    "rebounds", "tops", "upbeat", "robust", "accelerate", "accelerates",
}
NEG_WORDS = {
    "fall", "falls", "drop", "drops", "plunge", "plunges", "crash", "crashes",
    "slump", "slumps", "decline", "declines", "loss", "losses", "miss", "misses",
    "downgrade", "downgraded", "bearish", "weak", "cut", "cuts", "fear", "fears",
    "selloff", "sell-off", "outflow", "outflows", "recession", "slowdown", "warn",
    "warns", "warning", "probe", "fraud", "ban", "default", "crisis", "tumble",
    "tumbles", "sinks", "slips", "woes", "layoff", "layoffs", "lawsuit", "scam",
    "downturn", "pressure", "risk", "risks", "drag", "drags", "sluggish",
}
STOPWORDS = {
    "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "as", "at",
    "by", "is", "are", "be", "with", "from", "this", "that", "it", "its", "after",
    "amid", "over", "up", "down", "new", "vs", "how", "why", "what", "will",
    "may", "can", "could", "should", "than", "into", "out", "but", "not", "you",
    "your", "his", "her", "their", "stock", "stocks", "market", "markets", "share",
    "shares", "today", "day", "week", "india", "indian", "sensex", "nifty",
}

_WORD_RE = re.compile(r"[a-z0-9]+")

# Stories touching these are relevant to an Indian equity investor. Anything
# with none of them (a luxury-yacht fire, a foreign election) is global noise
# and gets heavily down-weighted so it cannot top the digest.
INDIA_TERMS = {
    "india", "indian", "nifty", "sensex", "rbi", "sebi", "rupee", "inr", "fii",
    "dii", "modi", "budget", "gst", "adani", "reliance", "tata", "hdfc", "icici",
    "infosys", "tcs", "ambani", "dalal", "bse", "nse", "mumbai", "bankex",
}
MACRO_TERMS = {
    "fed", "fomc", "rate", "rates", "inflation", "cpi", "yield", "yields",
    "crude", "oil", "brent", "dollar", "dxy", "treasury", "recession", "gdp",
    "powell", "ecb", "boj", "tariff", "tariffs", "opec", "gold", "bond", "bonds",
}


def _tokens(title: str) -> set[str]:
    return {w for w in _WORD_RE.findall((title or "").lower()) if w not in STOPWORDS and len(w) > 2}


def _source_weight(source: str) -> float:
    s = (source or "").lower()
    for key, w in SOURCE_WEIGHTS.items():
        if key in s:
            return w
    return 0.5


def _sentiment(title: str) -> tuple[str, int]:
    toks = _WORD_RE.findall((title or "").lower())
    pos = sum(1 for t in toks if t in POS_WORDS)
    neg = sum(1 for t in toks if t in NEG_WORDS)
    net = pos - neg
    if net > 0:
        return "positive", net
    if net < 0:
        return "negative", net
    return "neutral", 0


def _relevance(title: str) -> float:
    low = (title or "").lower()
    toks = set(_WORD_RE.findall(low))
    if toks & INDIA_TERMS:
        return 1.0
    if toks & MACRO_TERMS:
        return 0.6
    return 0.15


def _recency_weight(pub: str | None) -> float:
    if not pub:
        return 0.5
    try:
        dt = datetime.fromisoformat(str(pub).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
        if hours <= 6:
            return 1.0
        if hours <= 24:
            return 0.8
        if hours <= 48:
            return 0.6
        return 0.4
    except Exception:
        return 0.5


def build_news_digest(items: list[dict], top_n: int = 20) -> dict:
    """items: list of dicts with title, source/src, published_at/pub."""
    norm = []
    for it in items:
        title = (it.get("title") or "").strip()
        if not title:
            continue
        norm.append({
            "title": title,
            "source": it.get("source") or it.get("src") or "",
            "pub": it.get("published_at") or it.get("pub"),
            "tokens": _tokens(title),
        })
    if not norm:
        return {"n_raw": 0, "clusters": [], "note": "no news"}

    # Greedy clustering using the overlap coefficient (intersection / smaller
    # token set). Jaccard punished differently-phrased headlines about the same
    # story; overlap merges them when the key nouns match. Compare against each
    # cluster's seed tokens (not the union, which drifts as members are added).
    clusters: list[dict] = []
    for n in norm:
        placed = False
        for c in clusters:
            inter = len(n["tokens"] & c["seed"])
            smaller = min(len(n["tokens"]), len(c["seed"])) or 1
            if inter / smaller >= 0.6:
                c["members"].append(n)
                placed = True
                break
        if not placed:
            clusters.append({"seed": set(n["tokens"]), "members": [n]})

    digest = []
    pos_n = neg_n = neu_n = 0
    weighted_sent = 0.0
    weight_total = 0.0
    for c in clusters:
        members = c["members"]
        # Representative = most credible source's headline.
        rep = max(members, key=lambda m: _source_weight(m["source"]))
        sources = sorted({m["source"] for m in members})
        src_cred = max(_source_weight(m["source"]) for m in members)
        recency = max(_recency_weight(m["pub"]) for m in members)
        relevance = max(_relevance(m["title"]) for m in members)
        label, score = _sentiment(rep["title"])
        materiality = round(len(sources) * src_cred * recency * relevance, 3)

        if label == "positive":
            pos_n += 1
        elif label == "negative":
            neg_n += 1
        else:
            neu_n += 1
        weighted_sent += score * materiality
        weight_total += materiality

        digest.append({
            "title": rep["title"],
            "sources": sources,
            "source_count": len(sources),
            "sentiment": label,
            "materiality": materiality,
            "pub": rep["pub"],
        })

    digest.sort(key=lambda d: d["materiality"], reverse=True)

    # Dominant themes across the whole feed.
    theme_counter: Counter = Counter()
    for n in norm:
        theme_counter.update(n["tokens"])
    themes = [{"term": t, "count": cnt} for t, cnt in theme_counter.most_common(10)]

    net = round(weighted_sent / weight_total, 3) if weight_total else 0.0

    return {
        "n_raw": len(norm),
        "n_stories": len(clusters),
        "net_sentiment": net,  # >0 net positive, <0 net negative (materiality-weighted)
        "positive_stories": pos_n,
        "negative_stories": neg_n,
        "neutral_stories": neu_n,
        "top_stories": digest[:top_n],
        "dominant_themes": themes,
        "note": (
            "Stories are deduped and ranked by materiality (credible-source count "
            "x source credibility x recency). sentiment/net_sentiment is a "
            "deterministic lexicon HINT, not gospel; judge nuance yourself. Weigh "
            "high-materiality stories far more than one-off headlines."
        ),
    }


if __name__ == "__main__":
    import os, json
    from supabase import create_client
    from dotenv import load_dotenv
    load_dotenv()
    sb = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
    from datetime import timedelta
    since = (datetime.now(timezone.utc) - timedelta(hours=72)).isoformat()
    rows = sb.table("news").select("source,title,published_at").gte(
        "published_at", since).order("published_at", desc=True).limit(200).execute().data or []
    print(json.dumps(build_news_digest(rows), indent=2, default=str)[:3000])

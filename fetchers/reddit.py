"""Reddit hot posts from Indian investing subs."""
import os
import praw
from dotenv import load_dotenv

load_dotenv()

SUBS = ["IndianStockMarket", "IndiaInvestments", "StockMarketIndia", "DalalStreetTalks"]


def fetch_hot(limit: int = 25) -> list[dict]:
    cid = os.getenv("REDDIT_CLIENT_ID")
    cs = os.getenv("REDDIT_CLIENT_SECRET")
    ua = os.getenv("REDDIT_USER_AGENT", "arcemx/0.1")
    if not cid or not cs:
        print("Reddit not configured")
        return []
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
            print(f"reddit fail {sub}: {e}")
    return out


if __name__ == "__main__":
    posts = fetch_hot()
    print(f"Reddit posts: {len(posts)}")
    for p in posts[:5]:
        print(p["sub"], p["score"], p["title"])

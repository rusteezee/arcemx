"""Google Trends signal via pytrends."""
import os
from pytrends.request import TrendReq
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

KEYWORDS = [
    "nifty", "sensex", "stock market crash", "bull market",
    "bear market", "buy stocks", "sell stocks", "intraday",
    "IPO", "mutual funds",
]


def fetch_trends(geo: str = "IN") -> list[dict]:
    pt = TrendReq(hl="en-IN", tz=330)
    rows = []
    for i in range(0, len(KEYWORDS), 5):
        batch = KEYWORDS[i:i + 5]
        try:
            pt.build_payload(batch, timeframe="now 7-d", geo=geo)
            df = pt.interest_over_time()
            if df.empty:
                continue
            latest = df.iloc[-1]
            for kw in batch:
                rows.append({"keyword": kw, "interest": int(latest.get(kw, 0))})
        except Exception as e:
            print(f"trends fail {batch}: {e}")
    return rows


def push(rows: list[dict]) -> int:
    url, key = os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY")
    if not url or not key:
        for r in rows:
            print(r)
        return 0
    sb = create_client(url, key)
    sb.table("trends").insert(rows).execute()
    return len(rows)


if __name__ == "__main__":
    rows = fetch_trends()
    print(f"Trends: {len(rows)}")
    push(rows)

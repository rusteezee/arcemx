// Quote / history proxy with Yahoo primary + Stooq fallback.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const RANGE_SECONDS: Record<string, number> = {
  "1d": 86400,
  "5d": 86400 * 5,
  "1mo": 86400 * 31,
  "3mo": 86400 * 93,
  "6mo": 86400 * 186,
  "1y": 86400 * 366,
  "2y": 86400 * 366 * 2,
  "5y": 86400 * 366 * 5,
  "10y": 86400 * 366 * 10,
  "max": 86400 * 366 * 30,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchYahoo(ticker: string, range: string, interval: string) {
  const now = Math.floor(Date.now() / 1000);
  const span = RANGE_SECONDS[range] ?? RANGE_SECONDS["6mo"];
  const period1 = now - span;
  const period2 = now;

  // Use period1/period2 explicitly — Yahoo sometimes throttles range=...
  // requests but honours explicit timestamps reliably.
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://finance.yahoo.com/",
      Origin: "https://finance.yahoo.com",
    },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`yahoo_${r.status}`);
  const data = await r.json();
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
  const realCount = closes.filter((c: number | null) => c != null).length;
  if (realCount < 2) throw new Error("yahoo_thin_data");
  return data;
}

// Stooq CSV → Yahoo-shaped JSON. Stooq is a free public source that works
// when Yahoo throttles or returns thin data.
async function fetchStooq(ticker: string, range: string, interval: string) {
  // Map Yahoo-style tickers to Stooq symbols.
  // Indices: ^NSEI → ^nse, ^BSESN → ^bse, ^NSEBANK → ^nsei is wrong; Stooq uses ^nse only.
  // Stocks: RELIANCE.NS → reliance.in, TCS.NS → tcs.in, NVDA → nvda.us
  let sym: string;
  const t = ticker.toUpperCase();
  if (t === "^NSEI") sym = "^nse";
  else if (t === "^BSESN") sym = "^bse";
  else if (t === "^NSEBANK") sym = "^nsei";
  else if (t.endsWith(".NS")) sym = t.replace(/\.NS$/i, "").toLowerCase() + ".in";
  else if (t.endsWith(".BO")) sym = t.replace(/\.BO$/i, "").toLowerCase() + ".in";
  else sym = t.toLowerCase() + ".us"; // assume US stock fallback

  const intervalCode = interval === "1wk" ? "w" : interval === "1mo" ? "m" : "d";
  const now = new Date();
  const span = RANGE_SECONDS[range] ?? RANGE_SECONDS["6mo"];
  const start = new Date(now.getTime() - span * 1000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=${intervalCode}&d1=${fmt(start)}&d2=${fmt(now)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`stooq_${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("stooq_empty");
  // header: Date,Open,High,Low,Close,Volume
  const rows = lines.slice(1).map((l) => l.split(","));
  const timestamp: number[] = [];
  const close: (number | null)[] = [];
  const open: (number | null)[] = [];
  const high: (number | null)[] = [];
  const low: (number | null)[] = [];
  const volume: (number | null)[] = [];
  for (const r of rows) {
    const [date, o, h, lo, c, v] = r;
    if (!date) continue;
    const ts = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
    if (isNaN(ts)) continue;
    timestamp.push(ts);
    open.push(o ? parseFloat(o) : null);
    high.push(h ? parseFloat(h) : null);
    low.push(lo ? parseFloat(lo) : null);
    close.push(c ? parseFloat(c) : null);
    volume.push(v ? parseFloat(v) : null);
  }
  if (timestamp.length < 2) throw new Error("stooq_thin");
  const last = close[close.length - 1] as number;
  const prev = close[close.length - 2] as number;
  // Mimic Yahoo response shape so the client code stays the same.
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: last,
            previousClose: prev,
            regularMarketDayHigh: high[high.length - 1],
            regularMarketDayLow: low[low.length - 1],
          },
          timestamp,
          indicators: { quote: [{ open, high, low, close, volume }] },
        },
      ],
      error: null,
    },
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const range = req.nextUrl.searchParams.get("range") || "6mo";
  const interval = req.nextUrl.searchParams.get("interval") || "1d";

  let data: any = null;
  const errors: string[] = [];
  try {
    data = await fetchYahoo(ticker, range, interval);
  } catch (e: any) {
    errors.push(`yahoo:${e?.message || e}`);
  }

  if (!data) {
    try {
      data = await fetchStooq(ticker, range, interval);
    } catch (e: any) {
      errors.push(`stooq:${e?.message || e}`);
    }
  }

  if (!data) {
    return NextResponse.json(
      { error: "all_sources_failed", detail: errors.join("; ") },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(data, {
    headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}

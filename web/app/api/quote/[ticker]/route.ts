// Quote / history proxy. Runs in Node (not edge) because Yahoo throttles
// the shared edge / Deno Deploy IP pool and returns thin data. Node /
// Netlify Functions use AWS Lambda IPs that Yahoo treats normally.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const RANGE_SECONDS: Record<string, number> = {
  "1d": 86400,
  // 1W spans 7 calendar days so the window always covers a full 5
  // trading-day week regardless of when the user opens the chart.
  "5d": 86400 * 7,
  "1mo": 86400 * 31,
  "3mo": 86400 * 93,
  "6mo": 86400 * 186,
  "1y": 86400 * 366,
  "2y": 86400 * 366 * 2,
  "3y": 86400 * 366 * 3,
  "5y": 86400 * 366 * 5,
  "10y": 86400 * 366 * 10,
  "max": 86400 * 366 * 30,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchYahoo(ticker: string, range: string, interval: string) {
  const now = Math.floor(Date.now() / 1000);
  const span = RANGE_SECONDS[range] ?? RANGE_SECONDS["6mo"];
  // For "max" we ask Yahoo for the absolute earliest data it has by
  // pinning period1 to the Unix epoch. Yahoo returns whatever it stores
  // for that ticker (e.g. RELIANCE.NS from ~1996, ^NSEI from ~Sep 2007 —
  // the index simply doesn't exist before that on Yahoo's side).
  const period1 = range === "max" ? 0 : now - span;
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  // Read both nextUrl and a parsed URL fallback in case one fails silently
  // on the deployed runtime.
  const url = new URL(req.url);
  const range =
    req.nextUrl.searchParams.get("range") ??
    url.searchParams.get("range") ??
    "6mo";
  const interval =
    req.nextUrl.searchParams.get("interval") ??
    url.searchParams.get("interval") ??
    "1d";

  try {
    const data = await fetchYahoo(ticker, range, interval);
    // Stamp debug info so the client can confirm what the server actually saw.
    const span = RANGE_SECONDS[range] ?? RANGE_SECONDS["6mo"];
    const now = Math.floor(Date.now() / 1000);
    (data as any)._arcemx = {
      received_range: range,
      received_interval: interval,
      period1: range === "max" ? 0 : now - span,
      period2: now,
    };
    return NextResponse.json(data, {
      headers: {
        // Netlify's CDN was collapsing different range= variants to one
        // cached response because the query string isn't part of its
        // default cache key. Disable caching outright so every range
        // button hits the upstream.
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        "cdn-cache-control": "no-store",
        "netlify-cdn-cache-control": "no-store",
        Vary: "*",
        "x-arcemx-range": range,
        "x-arcemx-interval": interval,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "yahoo_failed", detail: String(e?.message || e), received_range: range },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

// Quote / history proxy. Runs in Node (not edge) because Yahoo throttles
// the shared edge / Deno Deploy IP pool and returns thin data. Node /
// Netlify Functions use AWS Lambda IPs that Yahoo treats normally.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const range = req.nextUrl.searchParams.get("range") || "6mo";
  const interval = req.nextUrl.searchParams.get("interval") || "1d";

  try {
    const data = await fetchYahoo(ticker, range, interval);
    return NextResponse.json(data, {
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "yahoo_failed", detail: String(e?.message || e) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

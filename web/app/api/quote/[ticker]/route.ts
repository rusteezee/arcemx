// Yahoo Finance proxy. Works in dev + Netlify.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const range = req.nextUrl.searchParams.get("range") || "6mo";
  const interval = req.nextUrl.searchParams.get("interval") || "1d";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=${interval}&includePrePost=false`;

  try {
    const r = await fetch(url, {
      headers: {
        // Yahoo blocks generic UAs and 'python' libs; mimic a real browser
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "yahoo_failed", status: r.status },
        {
          status: r.status,
          headers: { "cache-control": "no-store" },
        }
      );
    }
    const data = await r.json();
    return NextResponse.json(data, {
      // Short cache so consecutive button clicks for the same range are fast,
      // but data stays fresh enough for live indices.
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

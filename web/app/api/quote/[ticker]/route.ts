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
      headers: { "User-Agent": "Mozilla/5.0 arcemx-web" },
      next: { revalidate: 60 },
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "yahoo_failed", status: r.status },
        { status: r.status }
      );
    }
    const data = await r.json();
    return NextResponse.json(data, {
      headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=120" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

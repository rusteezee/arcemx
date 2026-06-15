// Proxy to bot's /trigger/stock-analyst. Bot token never reaches browser.
// The bot looks up the (ticker, horizon, today_UTC) cache and either
// returns the existing run_id (cache hit, no LLM burn) or inserts a
// fresh pending row + kicks the LLM in background and returns the new
// run_id. The browser then polls stock_analyses by id directly via
// Supabase until status != 'pending'.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const botUrl = process.env.ARCEMX_BOT_URL;
  const secret = process.env.ARCEMX_TRIGGER_SECRET;

  if (!botUrl || !secret) {
    return NextResponse.json(
      { error: "bot_not_configured" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));

  try {
    const r = await fetch(`${botUrl.replace(/\/$/, "")}/trigger/stock-analyst`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trigger-Token": secret,
      },
      body: JSON.stringify(body),
      // Cold Render dyno + analyst spawn handshake; bot returns
      // 202 immediately after inserting the pending row so this
      // window only needs to absorb the cold-start.
      signal: AbortSignal.timeout(45_000),
    });
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: "bot_unreachable", detail: String(e?.message || e) },
      { status: 502 }
    );
  }
}

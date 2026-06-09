// Proxy to bot's /trigger/sensei. Bot token never reaches browser.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const botUrl = process.env.ARCEMX_BOT_URL;
  const secret = process.env.ARCEMX_TRIGGER_SECRET;

  if (!botUrl || !secret) {
    return NextResponse.json({ error: "bot_not_configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  try {
    const r = await fetch(`${botUrl.replace(/\/$/, "")}/trigger/sensei`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Trigger-Token": secret,
      },
      body: JSON.stringify(body),
      // Sensei is queued in the bot's background; the HTTP response
      // returns within a second or two of bot wake. Match the sync
      // route's 180s allowance so Render cold-start does not 502 here.
      signal: AbortSignal.timeout(180_000),
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

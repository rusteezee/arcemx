// Dispatches the "Backtest v2 Replay" GitHub Actions workflow directly
// from Netlify - no Render, no LLM cost (pure yfinance + Supabase reads).
// Inserts a pending backtest_runs row itself (service-role SUPABASE_KEY,
// never exposed to the browser), fires workflow_dispatch via the GitHub
// REST API using GH_TOKEN. The browser polls backtest_runs by id
// directly via Supabase. Same pattern as calc-explain/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

const REPO = "rusteezee/arcemx";
const WORKFLOW = "backtest.yml";
const REF = "master";

export async function POST(_req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const ghToken = process.env.GH_TOKEN;

  if (!supabaseUrl || !supabaseKey || !ghToken) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  try {
    // Self-cleaning sweep: a replay normally finishes well under a
    // minute (no LLM call), but network-heavy yfinance pulls across a
    // growing ticker universe could stall. 15min is above the job's own
    // 15min GH Actions timeout, so this only ever catches genuinely-dead
    // rows from a runner that vanished without updating status.
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await sb.from("backtest_runs").update({
      status: "failed",
      error: "Timed out waiting for the job to complete (stale pending >15min).",
    }).eq("status", "pending").lt("run_at", staleCutoff);

    const { data: inserted, error: insErr } = await sb
      .from("backtest_runs")
      .insert({ status: "pending" })
      .select("id")
      .limit(1);
    if (insErr || !inserted?.length) {
      throw new Error(insErr?.message || "insert returned no row");
    }
    const runId = inserted[0].id;

    const dispatch = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: REF, inputs: { run_id: String(runId) } }),
      }
    );
    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      await sb.from("backtest_runs").update({
        status: "failed",
        error: `workflow_dispatch ${dispatch.status}: ${detail.slice(0, 300)}`,
      }).eq("id", runId);
      throw new Error(`workflow_dispatch failed: ${dispatch.status} ${detail.slice(0, 200)}`);
    }

    return NextResponse.json({ ok: true, job: "backtest", status: "queued", run_id: runId }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "dispatch_failed", detail: String(e?.message || e) },
      { status: 502 }
    );
  }
}

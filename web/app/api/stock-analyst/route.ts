// Dispatches the "Stock Analyst" GitHub Actions workflow directly from
// Netlify. no Render involved. Cache-checks and inserts the pending
// stock_analyses row itself (using the service-role SUPABASE_KEY, never
// exposed to the browser), then fires workflow_dispatch via the GitHub
// REST API using GH_TOKEN (fine-grained PAT, Actions: Read and write on
// rusteezee/arcemx only). The browser polls stock_analyses by id directly
// via Supabase exactly as before; this route only decides who does the
// work and returns the same {ok, status, run_id} shape the frontend
// already expects.
//
// Replaces the old proxy-to-Render-bot path. That path put the entire
// feature behind Render's uptime AND its deploy pipeline. the 26 Jun -
// 11 Jul silent pipeline-minutes blackout would have taken this down with
// zero warning. GitHub Actions has been the reliable half of this stack
// all along; this feature belongs there like daily_analysis.yml does.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

const REPO = "rusteezee/arcemx";
const WORKFLOW = "stock_analyst.yml";
const REF = "master";

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const ghToken = process.env.GH_TOKEN;

  if (!supabaseUrl || !supabaseKey || !ghToken) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));

  let ticker = String(body?.ticker || "").trim().toUpperCase();
  if (ticker && !ticker.endsWith(".NS") && !ticker.endsWith(".BO") && !ticker.startsWith("^") && !ticker.includes(".")) {
    ticker += ".NS";
  }
  if (!ticker) {
    return NextResponse.json({ ok: false, error: "ticker required" }, { status: 400 });
  }
  let horizon = parseInt(body?.horizon_days, 10);
  if (![30, 90, 180].includes(horizon)) horizon = 30;

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  try {
    // Self-cleaning sweep: a row can get stuck in 'pending' forever if the
    // GH Actions run itself dies before analyzer.stock_analyst_llm's own
    // except-block ever runs (OOM, runner timeout, network partition mid-
    // run). 30min is safely above both the client's own poll cap (10min,
    // see StockAnalyst.tsx) and the worst observed real latency (~15min),
    // so this only ever catches genuinely-dead rows, never a slow-but-
    // live one. Best-effort; a sweep failure must not block a new request.
    const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await sb.from("stock_analyses").update({
      status: "failed",
      error: "Timed out waiting for the job to complete (stale pending >30min).",
    }).eq("status", "pending").lt("requested_at", staleCutoff);

    // Cache hit: same ticker + horizon + today (UTC, matches the DB's
    // cache_day default) already resolved ok. Reuse it, burn no LLM call.
    const today = new Date().toISOString().slice(0, 10);
    const { data: cacheHit } = await sb
      .from("stock_analyses")
      .select("id,status")
      .eq("ticker", ticker)
      .eq("horizon_days", horizon)
      .eq("cache_day", today)
      .eq("status", "ok")
      .order("requested_at", { ascending: false })
      .limit(1);

    if (cacheHit && cacheHit.length > 0) {
      return NextResponse.json({
        ok: true, job: "stock-analyst", status: "cached",
        run_id: cacheHit[0].id, ticker, horizon_days: horizon, via: "cache",
      });
    }

    const { data: inserted, error: insErr } = await sb
      .from("stock_analyses")
      .insert({ ticker, horizon_days: horizon, status: "pending" })
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
      // The row already exists as 'pending'. mark it failed so the
      // frontend's poll resolves to a real error instead of spinning
      // forever on a run nothing will ever fill in.
      await sb.from("stock_analyses").update({
        status: "failed",
        error: `workflow_dispatch ${dispatch.status}: ${detail.slice(0, 300)}`,
      }).eq("id", runId);
      throw new Error(`workflow_dispatch failed: ${dispatch.status} ${detail.slice(0, 200)}`);
    }

    return NextResponse.json({
      ok: true, job: "stock-analyst", status: "queued",
      run_id: runId, ticker, horizon_days: horizon, via: "gh_actions",
    }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "dispatch_failed", detail: String(e?.message || e) },
      { status: 502 }
    );
  }
}

// Dispatches the "Calculator LLM Enrichment" GitHub Actions workflow
// directly from Netlify — no Render involved. Inserts the pending
// calculator_runs row itself (service-role SUPABASE_KEY, never exposed
// to the browser), then fires workflow_dispatch via the GitHub REST API
// using GH_TOKEN. The browser polls calculator_runs by id directly via
// Supabase exactly as before. See web/app/api/stock-analyst/route.ts for
// the first migration of this pattern off Render.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

const REPO = "rusteezee/arcemx";
const WORKFLOW = "calculator.yml";
const REF = "master";

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const ghToken = process.env.GH_TOKEN;

  if (!supabaseUrl || !supabaseKey || !ghToken) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const inputJson = body?.input || {};
  const detJson = body?.deterministic || {};
  if (!detJson || Object.keys(detJson).length === 0) {
    return NextResponse.json({ ok: false, error: "missing deterministic payload" }, { status: 400 });
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  try {
    const { data: inserted, error: insErr } = await sb
      .from("calculator_runs")
      .insert({ input_json: inputJson, deterministic_json: detJson, status: "pending" })
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
      await sb.from("calculator_runs").update({
        status: "failed",
        error: `workflow_dispatch ${dispatch.status}: ${detail.slice(0, 300)}`,
      }).eq("id", runId);
      throw new Error(`workflow_dispatch failed: ${dispatch.status} ${detail.slice(0, 200)}`);
    }

    return NextResponse.json({ ok: true, job: "calc-explain", status: "queued", run_id: runId }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "dispatch_failed", detail: String(e?.message || e) },
      { status: 502 }
    );
  }
}

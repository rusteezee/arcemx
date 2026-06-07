import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
// Disable Next.js route-handler caching. Without this the latest
// timestamp can read several minutes stale because Next.js may serve a
// prior response from its full-route cache.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const uid = process.env.NEXT_PUBLIC_DEFAULT_USER_ID || "default";
  if (!url || !key) return NextResponse.json({ ts: null });

  const sb = createClient(url, key, { auth: { persistSession: false } });
  // Two sources of "last refresh": the bot /sync ledger (sync_log) and
  // the analyzer's daily AI call (analysis.run_at). Either one updating
  // means data the user sees on the page is fresh, so the nav indicator
  // should show whichever happened later. Otherwise running the
  // analyzer at 5:17 PM and seeing "35m ago" in the nav (because that
  // was the last bot sync) reads as a bug.
  const [syncRes, analysisRes] = await Promise.all([
    sb
      .from("sync_log")
      .select("ts")
      .eq("user_id", uid)
      .eq("ok", true)
      .order("ts", { ascending: false })
      .limit(1),
    sb
      .from("analysis")
      .select("run_at")
      .order("run_at", { ascending: false })
      .limit(1),
  ]);
  const syncTs = syncRes.data?.[0]?.ts || null;
  const analysisTs = analysisRes.data?.[0]?.run_at || null;
  let ts: string | null = null;
  if (syncTs && analysisTs) {
    ts = new Date(syncTs) > new Date(analysisTs) ? syncTs : analysisTs;
  } else {
    ts = syncTs ?? analysisTs ?? null;
  }
  return NextResponse.json({ ts });
}

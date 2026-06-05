import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const uid = process.env.NEXT_PUBLIC_DEFAULT_USER_ID || "default";
  if (!url || !key) return NextResponse.json({ ts: null });

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data } = await sb
    .from("sync_log")
    .select("ts")
    .eq("user_id", uid)
    .eq("ok", true)
    .order("ts", { ascending: false })
    .limit(1);

  return NextResponse.json({ ts: data?.[0]?.ts || null });
}

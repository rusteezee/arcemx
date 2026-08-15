import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";

// Google OAuth lands here with a ?code=... to exchange for a session.
// proxy.ts's owner-email allowlist check runs on every request after this,
// so a non-owner Google account still gets rejected even though the
// exchange itself succeeds for any Google user.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createServerSupabase();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL("/", req.url));
}

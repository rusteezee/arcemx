import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Server Component / Route Handler client. Call fresh per request - it
// reads the current cookie store each time, it isn't a singleton like
// the browser client in lib/supabase.ts.
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component, which can't write cookies.
          // proxy.ts already refreshes the session on every request, so
          // this is safe to ignore here.
        }
      },
    },
  });
}

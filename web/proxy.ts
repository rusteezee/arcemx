import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Public paths: no session required. /login and the OAuth callback obviously
// can't require a session to reach. The PWA assets must stay fetchable
// pre-login too, or the install prompt breaks for a signed-out browser.
const PUBLIC_PATHS = ["/login", "/auth/callback", "/manifest.webmanifest", "/sw.js"];

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/icons/")) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims(), never getSession() - getSession() reads straight from the
  // cookie without re-verifying the JWT signature, so it isn't safe to use
  // for an authorization decision (Supabase's own SSR guidance).
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  const allowedEmail = process.env.ALLOWED_OWNER_EMAIL?.toLowerCase();
  const isOwner =
    !!claims &&
    !!allowedEmail &&
    typeof claims.email === "string" &&
    claims.email.toLowerCase() === allowedEmail;

  const path = request.nextUrl.pathname;

  if (isPublicPath(path)) {
    // Already signed in as the owner and sitting on /login - bounce home
    // instead of showing the form again.
    if (path === "/login" && isOwner) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return response;
  }

  if (!isOwner) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

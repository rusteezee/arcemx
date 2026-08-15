import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// No nonces here on purpose - a nonce-based CSP forces every page to
// dynamic rendering (see next/dist/docs/.../content-security-policy.md),
// which would break static optimization across most of this app's routes.
// 'unsafe-inline' is weaker but keeps the existing rendering strategy
// intact; still a real improvement over having zero CSP at all.
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self' data:;
  connect-src 'self' https://*.supabase.co https://query2.finance.yahoo.com;
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  ${isDev ? "" : "upgrade-insecure-requests;"}
`.replace(/\n/g, "");

// upgrade-insecure-requests forces every fetch to https:// - correct on
// the real deploy (Netlify, always TLS), but it kills the plain-http dev
// server outright (net::ERR_SSL_PROTOCOL_ERROR on localhost). Same reason
// HSTS is skipped in dev: the header is a no-op over http anyway (browsers
// only honor it on a real https response), no reason to send it there.
const securityHeaders = [
  { key: "Content-Security-Policy", value: cspHeader },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(isDev
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

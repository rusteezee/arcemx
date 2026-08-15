"use client";

import { useState } from "react";
import { sb } from "@/lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    window.location.href = "/";
  }

  async function handleGoogleLogin() {
    setError(null);
    setGoogleLoading(true);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
    // On success the browser navigates away to Google - nothing left to do here.
  }

  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <div className="card p-10 w-full max-w-sm text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.svg"
          alt=""
          aria-hidden
          className="h-10 w-auto mx-auto mb-6 select-none pointer-events-none"
          draggable={false}
        />
        <h1 className="text-lg font-semibold mb-1">Arc&apos;emX!</h1>
        <p className="text-xs text-[var(--muted)] mb-8">Owner-only access.</p>

        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={googleLoading}
          className="btn-ghost w-full justify-center mb-6"
        >
          {googleLoading ? "Redirecting..." : "Continue with Google"}
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 divider-thin" />
          <span className="text-[0.7rem] text-[var(--muted)]">or</span>
          <div className="flex-1 divider-thin" />
        </div>

        <form onSubmit={handlePasswordLogin} className="flex flex-col gap-3 text-left">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--foreground)]"
          />
          <input
            type="password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm outline-none focus:border-[var(--foreground)]"
          />
          {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full justify-center mt-1">
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

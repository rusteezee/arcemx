"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState, useLayoutEffect } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getMarketState, marketStateLabel, isMarketOpen, type MarketState } from "@/lib/marketState";

const items = [
  { href: "/", label: "Today" },
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/wishlist", label: "Wishlist" },
  { href: "/trade", label: "Trade" },
  { href: "/sensei", label: "Sensei" },
  { href: "/accuracy", label: "Accuracy" },
];

// Route-aware sync icon. Each mode picks its own glyph + idle/loading
// animation so the same nav pill visibly reframes itself by section.
//   indmoney: rotating arrow, spin on syncing  (existing default)
//   sensei:   sensei figure SVG, soft blink on syncing
//   grader:   crosshair / target SVG, rotate on syncing
function SyncModeIcon({
  mode,
  syncing,
}: {
  mode: "indmoney" | "sensei" | "grader";
  syncing: boolean;
}) {
  if (mode === "indmoney") {
    return (
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round"
        className={cn(
          "shrink-0 transition-colors duration-300",
          syncing && "animate-spin",
        )}
      >
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </svg>
    );
  }
  // Custom-SVG modes use CSS mask-image with bg-current so the icon
  // inherits the parent button's text color. External <img> tags would
  // not pick up currentColor; mask-image does.
  if (mode === "sensei") {
    return (
      <span
        aria-hidden
        className={cn(
          "shrink-0 inline-block bg-current",
          // Shuriken spins while syncing (throwing-star motion). Was a
          // soft pulse for the old figure icon; the star reads as motion
          // far better with rotation.
          syncing && "animate-spin",
        )}
        style={{
          width: 13,
          height: 13,
          WebkitMaskImage: "url(/icons/sensei.svg)",
          maskImage: "url(/icons/sensei.svg)",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
    );
  }
  // grader: target crosshair, rotates while syncing
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 inline-block bg-current",
        syncing && "animate-spin",
      )}
      style={{
        width: 16,
        height: 16,
        WebkitMaskImage: "url(/icons/accuracy.svg)",
        maskImage: "url(/icons/accuracy.svg)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Nav() {
  const path = usePathname();
  const navItemsRef = useRef<HTMLDivElement | null>(null);
  const [pill, setPill] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0, width: 0, ready: false,
  });
  const [mkt, setMkt] = useState<MarketState>("closed");
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncState, setSyncState] = useState<"idle" | "ok" | "error">("idle");
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => { setMobileOpen(false); }, [path]);

  // Measure active item position relative to nav buttons container
  useLayoutEffect(() => {
    const container = navItemsRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
    if (!activeEl) return;
    const cRect = container.getBoundingClientRect();
    const aRect = activeEl.getBoundingClientRect();
    setPill({ left: aRect.left - cRect.left, width: aRect.width, ready: true });
  }, [path]);

  useEffect(() => {
    const onResize = () => {
      const container = navItemsRef.current;
      if (!container) return;
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
      if (!activeEl) return;
      const cRect = container.getBoundingClientRect();
      const aRect = activeEl.getBoundingClientRect();
      setPill({ left: aRect.left - cRect.left, width: aRect.width, ready: true });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const update = () => setMkt(getMarketState());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  const fetchLastSync = async () => {
    try {
      const r = await fetch("/api/last-sync", { cache: "no-store" });
      const j = await r.json();
      setLastSync(j.ts || null);
    } catch {}
  };
  useEffect(() => {
    fetchLastSync();
    const t = setInterval(fetchLastSync, 60_000);
    return () => clearInterval(t);
  }, []);

  // Resolve which sync mode the nav button runs based on the current route.
  // /sensei  -> trigger Sensei retrospective       (icon: sensei figure, soft blink)
  // /accuracy-> trigger Grader scoring pass         (icon: target crosshair, rotate)
  // any other-> INDmoney positions sync             (icon: rotating arrow, rotate)
  //
  // Keeping the mode resolution in one place means the rest of the button
  // (loading state, border color on result, animated text swap) is shared.
  type SyncMode = "indmoney" | "sensei" | "grader";
  const mode: SyncMode =
    path === "/sensei" ? "sensei" : path === "/accuracy" ? "grader" : "indmoney";

  const modeConfig: Record<SyncMode, { endpoint: string; idleLabel: (ts: string | null) => string }> = {
    indmoney: { endpoint: "/api/sync",            idleLabel: (ts) => timeAgo(ts) },
    sensei:   { endpoint: "/api/trigger-sensei",  idleLabel: () => "Sensei" },
    grader:   { endpoint: "/api/trigger-grader",  idleLabel: () => "Grader" },
  };
  const cfg = modeConfig[mode];

  // One sync attempt. Classifies the outcome into three buckets so the
  // caller can decide whether a retry is worthwhile:
  //   ok    -> bot synced successfully
  //   cold  -> transport-level miss (network throw, 5xx, or an empty {}
  //            body from the proxy when Render returned a non-JSON cold
  //            start page). A retry after the bot wakes usually succeeds.
  //   error -> bot was reached but the sync failed (e.g. INDmoney 512 or
  //            an expired token). The bot already retries those itself,
  //            so a client retry will not help; surface it.
  const attemptSync = async (endpoint: string): Promise<{ ok: boolean; cold: boolean; err?: string }> => {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      let j: any = {};
      try {
        j = await r.json();
      } catch {
        j = {};
      }
      if (r.ok && j?.ok) return { ok: true, cold: false };
      if (j && j.ok === false) return { ok: false, cold: false, err: j.error || "Sync failed" };
      // Empty {} or a 5xx with no usable body => treat as a cold start.
      return { ok: false, cold: true };
    } catch {
      return { ok: false, cold: true };
    }
  };

  const onSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncState("idle");
    setSyncMsg(null);
    try {
      let res = await attemptSync(cfg.endpoint);
      // Cold Render bot: show a waking state, give it ~6s to spin up,
      // then retry once silently before surfacing any error.
      if (!res.ok && res.cold) {
        setSyncMsg("Waking");
        await new Promise((r) => setTimeout(r, 6000));
        res = await attemptSync(cfg.endpoint);
      }
      if (res.ok) {
        setSyncState("ok");
        // The Sensei + Grader triggers return 202 Queued; the INDmoney
        // sync returns fully synced. Use different success copy so the
        // nav reflects what the user is actually waiting for.
        setSyncMsg(mode === "indmoney" ? "Synced" : "Queued");
        if (mode === "indmoney") fetchLastSync();
        // Tell the page underneath that a background job was queued so
        // it can poll its own table and refresh content when the new
        // row lands (Sensei page listens for mode "sensei").
        window.dispatchEvent(
          new CustomEvent("arcemx:sync-queued", { detail: { mode } })
        );
      } else if (res.cold) {
        // Still cold after a retry: not a real failure, just a slow wake.
        setSyncState("error");
        setSyncMsg("Retry");
      } else {
        setSyncState("error");
        setSyncMsg("Error");
      }
    } finally {
      setSyncing(false);
      setTimeout(() => {
        setSyncMsg(null);
        setSyncState("idle");
      }, 3500);
    }
  };

  const syncText = syncing ? "Syncing" : syncMsg ?? cfg.idleLabel(lastSync);
  const open = isMarketOpen(mkt);

  return (
    <div className="sticky top-0 z-40 pointer-events-none">
      {/* Top cover strip: solid background then short gradient over the
       * slot between viewport top and the nav pill. A 16px strip was
       * not enough; section prose still bled through the lower half of
       * a pure gradient. Solid for the first 16px then a 12px fade
       * gives a hard cover with a soft handoff into transparency where
       * the pill begins, without putting any opaque layer BEHIND the
       * pill (which would kill the pill's translucent backdrop-blur). */}
      <div
        aria-hidden
        className="h-4 bg-[var(--background)]"
      />
      <div
        aria-hidden
        className="h-3 bg-gradient-to-b from-[var(--background)] to-transparent"
      />
      <div className="px-3 sm:px-4 pb-3 md:max-w-fit md:mx-auto pointer-events-auto">
        <motion.nav
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "flex md:grid items-center w-full",
            "pl-4 pr-2 md:pl-9 md:pr-4 py-[9px] md:py-[11px] gap-2 md:gap-20",
            "rounded-full border border-border",
            "bg-[var(--card)]/65 backdrop-blur-md",
            "shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
          )}
          style={{ gridTemplateColumns: "1fr auto 1fr" }}
        >
          <Link
            href="/"
            aria-label="Arc'emX! home"
            className="flex items-center md:justify-self-start text-foreground shrink-0"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-banner.svg"
              alt="Arc'emX!"
              className="h-7 md:h-8 w-auto select-none pointer-events-none"
              draggable={false}
            />
          </Link>

          {/* Desktop items */}
          <div
            ref={navItemsRef}
            className="hidden md:flex relative items-center gap-1 justify-self-center"
          >
            {pill.ready && (
              <motion.span
                aria-hidden
                className="absolute top-0 bottom-0 rounded-full bg-foreground pointer-events-none"
                animate={{ left: pill.left, width: pill.width }}
                transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
              />
            )}
            {items.map((item) => {
              const active = path === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-active={active}
                  className={cn(
                    "relative z-10 px-5 py-[7px] rounded-full text-sm font-medium transition-colors whitespace-nowrap",
                    active
                      ? "text-background"
                      : "text-[var(--muted)] hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>

          {/* Right side controls */}
          <div className="flex items-center gap-1.5 md:gap-2.5 md:justify-self-end ml-auto md:ml-0">
            {/* Market state dot */}
            <div
              className="hidden sm:flex items-center gap-1.5 px-3 py-[5px] rounded-full border border-border w-[100px] justify-center whitespace-nowrap"
              title={`Market ${marketStateLabel(mkt)}`}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                {open && (
                  <span className="absolute inset-0 rounded-full bg-[var(--gain)] animate-ping opacity-60" />
                )}
                <span
                  className={cn(
                    "relative inline-flex h-2 w-2 rounded-full",
                    open ? "bg-[var(--gain)]" : "bg-[var(--muted)]"
                  )}
                />
              </span>
              <span className="text-[0.72rem] font-medium tracking-wide text-[var(--muted)] whitespace-nowrap">
                {marketStateLabel(mkt)}
              </span>
            </div>

            {/* Sync button - compact on mobile (icon only) */}
            <button
              onClick={onSync}
              disabled={syncing}
              className={cn(
                "flex items-center gap-1.5 rounded-full border transition-all duration-300 overflow-hidden",
                "text-[0.72rem] font-medium",
                "size-9 justify-center sm:size-auto sm:px-2.5 sm:py-[5px]",
                // Fixed width across every route so the whole nav bar
                // never resizes between modes. Labels are all short now
                // ("Sensei", "Grader", "Just now", "Syncing"), so 96px
                // fits the widest without the dead space the old 124px
                // (sized for "Sync Sensei") left around them.
                "sm:w-[96px]",
                syncing ? "opacity-80 border-border" : "hover:bg-[var(--muted-bg)]",
                "disabled:cursor-not-allowed",
                syncState === "ok" &&
                  "border-[color-mix(in_srgb,var(--gain)_60%,transparent)] bg-[color-mix(in_srgb,var(--gain)_14%,transparent)] text-[var(--gain)]",
                syncState === "error" &&
                  "border-[color-mix(in_srgb,var(--loss)_60%,transparent)] bg-[color-mix(in_srgb,var(--loss)_14%,transparent)] text-[var(--loss)]",
                syncState === "idle" && !syncing && "border-border"
              )}
              title={
                syncMsg ||
                (mode === "sensei"
                  ? "Run Sensei EOD retrospective"
                  : mode === "grader"
                  ? "Run Grader scoring pass"
                  : "Sync from INDmoney")
              }
            >
              <SyncModeIcon mode={mode} syncing={syncing} />
              <div className="hidden sm:block relative h-4 flex-1 overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={syncText}
                    initial={{ y: 10, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -10, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className={cn(
                      "absolute inset-0 flex items-center justify-center tracking-wide truncate",
                      syncState === "error"
                        ? "text-[var(--loss)]"
                        : syncState === "ok"
                        ? "text-[var(--gain)]"
                        : "text-[var(--muted)]"
                    )}
                  >
                    {syncText}
                  </motion.span>
                </AnimatePresence>
              </div>
            </button>

            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen((v) => !v)}
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              className="md:hidden flex items-center justify-center size-9 rounded-full border border-border text-foreground hover:bg-[var(--muted-bg)] transition-colors"
            >
              {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </motion.nav>

        {/* Mobile dropdown */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="md:hidden mt-2 rounded-2xl border border-border bg-[var(--card)]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.2)] p-2"
            >
              {items.map((item) => {
                const active = path === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "block px-4 py-2.5 rounded-xl text-sm font-medium transition-colors",
                      active
                        ? "bg-foreground text-background"
                        : "text-[var(--muted)] hover:text-foreground hover:bg-[var(--muted-bg)]"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
              {/* Market state shown in mobile menu since hidden in nav */}
              <div className="sm:hidden mt-2 px-4 py-2.5 flex items-center justify-between text-xs text-[var(--muted)]">
                <span className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", open ? "bg-[var(--gain)]" : "bg-[var(--muted)]")} />
                  Market {marketStateLabel(mkt)}
                </span>
                <span>{timeAgo(lastSync)}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

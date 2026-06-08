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
  { href: "/accuracy", label: "Accuracy" },
  { href: "/history", label: "History" },
];

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
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

  const onSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncState("idle");
    setSyncMsg(null);
    try {
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        setSyncState("ok");
        setSyncMsg("Synced");
        fetchLastSync();
      } else {
        setSyncState("error");
        setSyncMsg("Error");
      }
    } catch {
      setSyncState("error");
      setSyncMsg("Error");
    } finally {
      setSyncing(false);
      setTimeout(() => {
        setSyncMsg(null);
        setSyncState("idle");
      }, 3500);
    }
  };

  const syncText = syncing ? "Syncing" : syncMsg ?? timeAgo(lastSync);
  const open = isMarketOpen(mkt);

  return (
    <div className="sticky top-4 z-40 px-3 sm:px-4 pointer-events-none">
      <div className="md:max-w-fit md:mx-auto pointer-events-auto">
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
                "size-9 justify-center sm:size-auto sm:w-[96px] sm:px-2.5 sm:py-[5px]",
                syncing ? "opacity-80 border-border" : "hover:bg-[var(--muted-bg)]",
                "disabled:cursor-not-allowed",
                syncState === "ok" &&
                  "border-[color-mix(in_srgb,var(--gain)_60%,transparent)] bg-[color-mix(in_srgb,var(--gain)_14%,transparent)] text-[var(--gain)]",
                syncState === "error" &&
                  "border-[color-mix(in_srgb,var(--loss)_60%,transparent)] bg-[color-mix(in_srgb,var(--loss)_14%,transparent)] text-[var(--loss)]",
                syncState === "idle" && !syncing && "border-border"
              )}
              title={syncMsg || "Sync from INDmoney"}
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"
                className={cn("shrink-0 transition-colors duration-300", syncing && "animate-spin")}
              >
                <path d="M21 12a9 9 0 1 1-3-6.7" />
                <path d="M21 3v6h-6" />
              </svg>
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

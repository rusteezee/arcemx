"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { ArrowLeft, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const homeItems = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How It Works" },
  { href: "#demo", label: "Demo" },
  { href: "#docs", label: "Docs" },
  { href: "#waitlist", label: "Waitlist" },
];

const demoItems = [
  { href: "#today", label: "Today" },
  { href: "#markets", label: "Markets" },
  { href: "#portfolio", label: "Portfolio" },
  { href: "#wishlist", label: "Wishlist" },
  { href: "#accuracy", label: "Accuracy" },
  { href: "#history", label: "History" },
];

const DASHBOARD_URL = "/demo";

export function Nav() {
  const pathname = usePathname();
  const isDemoPage = pathname === "/demo";
  const items = useMemo(() => (isDemoPage ? demoItems : homeItems), [isDemoPage]);

  const itemsRef = useRef<HTMLDivElement | null>(null);
  const lockUntilRef = useRef<number>(0);
  const [active, setActive] = useState<string>(items[0].href);
  const [pill, setPill] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0, width: 0, ready: false,
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Reset active when route (and items) change
  useEffect(() => {
    if (isDemoPage) {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      const valid = demoItems.find((i) => i.href === hash);
      setActive(valid ? valid.href : demoItems[0].href);
    } else {
      setActive(homeItems[0].href);
    }
  }, [isDemoPage]);

  // Scroll-spy for homepage only
  useEffect(() => {
    if (isDemoPage) return;
    const onScroll = () => {
      if (Date.now() < lockUntilRef.current) return;
      const ids = homeItems.map((i) => i.href.slice(1));
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 200) current = id;
      }
      setActive(`#${current}`);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isDemoPage]);

  // Hash listener for demo page
  useEffect(() => {
    if (!isDemoPage) return;
    const onHash = () => {
      const valid = demoItems.find((i) => i.href === window.location.hash);
      if (valid) setActive(valid.href);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [isDemoPage]);

  // Measure active pill
  useLayoutEffect(() => {
    const container = itemsRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
    if (!activeEl) return;
    const cRect = container.getBoundingClientRect();
    const aRect = activeEl.getBoundingClientRect();
    setPill({ left: aRect.left - cRect.left, width: aRect.width, ready: true });
  }, [active, items]);

  useEffect(() => {
    const onResize = () => {
      const container = itemsRef.current;
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

  const handleItemClick = (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    lockUntilRef.current = Date.now() + 1000;
    setActive(href);
    setMobileOpen(false);
    if (isDemoPage) {
      e.preventDefault();
      if (typeof window !== "undefined") {
        history.replaceState(null, "", href);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    }
  };

  return (
    <div className="sticky top-4 z-40 px-3 sm:px-4 pointer-events-none">
      <div className="md:max-w-fit md:mx-auto pointer-events-auto">
        <motion.nav
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "flex md:grid items-center w-full",
            "pl-4 pr-2 md:pl-7 md:pr-3 py-[9px] md:py-[11px]",
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
          <div ref={itemsRef} className="hidden md:flex relative items-center gap-1 justify-self-center md:mx-24">
            {pill.ready && (
              <motion.span
                aria-hidden
                className="absolute top-0 bottom-0 rounded-full bg-foreground pointer-events-none"
                animate={{ left: pill.left, width: pill.width }}
                transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
              />
            )}
            {items.map((item) => {
              const isActive = active === item.href;
              const activeTextClass = pill.ready ? "text-background" : "text-foreground";
              return (
                <a
                  key={item.href}
                  href={item.href}
                  data-active={isActive}
                  onClick={handleItemClick(item.href)}
                  className={cn(
                    "relative z-10 px-5 py-[7px] rounded-full text-sm font-medium transition-colors whitespace-nowrap",
                    isActive ? activeTextClass : "text-[var(--muted)] hover:text-foreground"
                  )}
                >
                  {item.label}
                </a>
              );
            })}
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-1.5 md:gap-2 md:justify-self-end ml-auto md:ml-0">
            {isDemoPage ? (
              <Link
                href="/"
                className="btn-primary text-xs !py-[7px] !px-3 md:!px-4"
              >
                <ArrowLeft className="size-3.5" />
                <span className="hidden sm:inline">Back</span>
              </Link>
            ) : (
              <a
                href={DASHBOARD_URL}
                className="btn-primary text-xs !py-[7px] !px-3 md:!px-4 whitespace-nowrap"
              >
                <span className="hidden sm:inline">Try </span>Dashboard
              </a>
            )}
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
              className="md:hidden mt-2 rounded-[22px] border border-border bg-[var(--card)]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.2)] p-2"
            >
              {items.map((item) => {
                const isActive = active === item.href;
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    onClick={handleItemClick(item.href)}
                    className={cn(
                      "block px-4 py-2.5 rounded-[14px] text-sm font-medium transition-colors",
                      isActive
                        ? "bg-foreground text-background"
                        : "text-[var(--muted)] hover:text-foreground hover:bg-[var(--muted-bg)]"
                    )}
                  >
                    {item.label}
                  </a>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

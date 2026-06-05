"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

const homeItems = [
  { href: "#features", label: "Features" },
  { href: "#how", label: "How It Works" },
  { href: "#demo", label: "Demo" },
  { href: "#docs", label: "Docs" },
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

  // Hash listener for demo page (external hash changes)
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
    if (isDemoPage) {
      e.preventDefault();
      // Update hash without scrolling; dispatch hashchange so demo page reacts
      if (typeof window !== "undefined") {
        history.replaceState(null, "", href);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
    }
  };

  return (
    <div className="sticky top-4 z-40 px-4 pointer-events-none">
      <div className="max-w-fit mx-auto pointer-events-auto">
        <motion.nav
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "grid items-center pl-7 pr-3 py-[11px] gap-24",
            "rounded-full border border-border",
            "bg-[var(--card)]/55 backdrop-blur-md",
            "shadow-[0_8px_30px_rgba(0,0,0,0.08)]"
          )}
          style={{ gridTemplateColumns: "1fr auto 1fr" }}
        >
          <Link
            href="/"
            aria-label="Arc'emX! home"
            className="flex items-center justify-self-start text-foreground"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-banner.svg"
              alt="Arc'emX!"
              className="h-8 w-auto select-none pointer-events-none"
              draggable={false}
            />
          </Link>

          <div ref={itemsRef} className="relative flex items-center gap-1 justify-self-center">
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
                    "relative z-10 px-5 py-[7px] rounded-full text-sm font-medium transition-colors",
                    isActive ? activeTextClass : "text-[var(--muted)] hover:text-foreground"
                  )}
                >
                  {item.label}
                </a>
              );
            })}
          </div>

          <div className="flex items-center gap-2 justify-self-end">
            {isDemoPage ? (
              <Link
                href="/"
                className="btn-primary text-xs !py-[7px] !px-4"
              >
                <ArrowLeft className="size-3.5" />
                Back
              </Link>
            ) : (
              <a
                href={DASHBOARD_URL}
                className="btn-primary text-xs !py-[7px] !px-4"
              >
                Try Dashboard
              </a>
            )}
          </div>
        </motion.nav>
      </div>
    </div>
  );
}

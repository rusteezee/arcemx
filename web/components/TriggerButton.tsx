"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface TriggerButtonProps {
  endpoint: string;        // e.g. "/api/trigger-sensei"
  label: string;           // resting label
  queuedLabel?: string;    // shown after job queued (default "Queued")
  body?: Record<string, unknown>;
  className?: string;
  title?: string;
}

type State = "idle" | "loading" | "ok" | "error";

// Render free dyno cold-starts in ~50s. The sync button uses the same
// "first attempt, brief wait, retry" pattern; we mirror it here so the
// caller sees a single button state, not a spurious error on cold-start.
async function attempt(
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; cold: boolean; msg?: string }> {
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let j: any = {};
    try {
      j = await r.json();
    } catch {
      j = {};
    }
    if (r.ok && j?.ok) return { ok: true, cold: false };
    if (j && j.ok === false) return { ok: false, cold: false, msg: j.error || "Failed" };
    return { ok: false, cold: true };
  } catch {
    return { ok: false, cold: true };
  }
}

export function TriggerButton({
  endpoint,
  label,
  queuedLabel = "Queued",
  body = {},
  className,
  title,
}: TriggerButtonProps) {
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    if (state === "loading") return;
    setState("loading");
    setMsg("Sending");
    let res = await attempt(endpoint, body);
    if (!res.ok && res.cold) {
      setMsg("Waking");
      await new Promise((r) => setTimeout(r, 6000));
      res = await attempt(endpoint, body);
    }
    if (res.ok) {
      setState("ok");
      setMsg(queuedLabel);
    } else if (res.cold) {
      setState("error");
      setMsg("Retry");
    } else {
      setState("error");
      setMsg(res.msg || "Error");
    }
    setTimeout(() => {
      setState("idle");
      setMsg(null);
    }, 5000);
  };

  const text = msg ?? label;

  return (
    <button
      onClick={run}
      disabled={state === "loading"}
      title={title || label}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border transition-all duration-300",
        "px-4 py-[7px] text-sm font-medium whitespace-nowrap",
        state === "loading" && "opacity-80 border-border",
        state === "idle" && "border-border hover:bg-[var(--muted-bg)]",
        state === "ok" &&
          "border-[color-mix(in_srgb,var(--gain)_60%,transparent)] bg-[color-mix(in_srgb,var(--gain)_14%,transparent)] text-[var(--gain)]",
        state === "error" &&
          "border-[color-mix(in_srgb,var(--loss)_60%,transparent)] bg-[color-mix(in_srgb,var(--loss)_14%,transparent)] text-[var(--loss)]",
        "disabled:cursor-not-allowed",
        className
      )}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("shrink-0", state === "loading" && "animate-spin")}
      >
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </svg>
      <div className="relative h-4 min-w-[64px] overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={text}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex items-center justify-center tracking-wide"
          >
            {text}
          </motion.span>
        </AnimatePresence>
      </div>
    </button>
  );
}

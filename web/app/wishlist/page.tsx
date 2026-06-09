"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { EmptyState } from "@/components/EmptyState";
import { sb } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";

interface WishlistOutlook {
  ticker: string;
  direction?: string;
  range?: string;
  confidence?: number;
  key_driver?: string;
}

export default function WishlistPage() {
  const [rows, setRows] = useState<WishlistOutlook[]>([]);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("analysis")
        .select("run_at, raw_json")
        .order("run_at", { ascending: false })
        .limit(1);
      const raw = data?.[0]?.raw_json || {};
      setRows((raw.wishlist_outlooks_1d || []) as WishlistOutlook[]);
      setRunAt(data?.[0]?.run_at || null);
      setLoading(false);
    })();
  }, []);

  if (!loading && !rows.length) {
    return (
      <EmptyState
        title="No wishlist outlooks yet."
        hint="Populates once tomorrow's cron runs and the model emits wishlist_outlooks_1d."
      />
    );
  }

  return (
    <>
      <div className="mb-8">
        <div className="section-num mb-2">000 · Wishlist</div>
        <h1 className="headline mb-3">
          Stocks you are <span className="italic">Watching.</span>
        </h1>
        <p className="sub-headline max-w-2xl">
          The model's next-day direction call and ATR-anchored range for every
          stock on your wishlist. Key driver cites 2+ concrete numbers (RSI,
          MACD, DMA distance, support, resistance, sector cue).
        </p>
      </div>

      {runAt && (
        <div className="card p-4 mb-8 inline-flex items-center gap-3 text-sm">
          <span className="glyph text-base">◈</span>
          <span className="text-[var(--muted)]">
            From analysis run at{" "}
            <span className="text-foreground font-medium num">
              {new Date(runAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "numeric", minute: "2-digit", hour12: true,
              })}
            </span>
            .
          </span>
        </div>
      )}

      <div className="mb-14">
        <div className="mb-5">
          <div className="section-num mb-2">001 · 1-Day Outlook</div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
            <span className="glyph text-lg">✦</span>
            Wishlist Calls
          </h2>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
          className="card overflow-hidden"
        >
          <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
            <colgroup>
              <col style={{ width: "16%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "12%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Direction</th>
                <th>Range</th>
                <th>Confidence</th>
                <th>Key Driver</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ticker}-${i}`} className="align-middle">
                  <td className="font-medium whitespace-nowrap">
                    {(r.ticker || "").replace(/\.NS$/, "")}
                  </td>
                  <td className="whitespace-nowrap">
                    <DirPill direction={r.direction} />
                  </td>
                  <td className="num whitespace-nowrap">
                    {r.range ? formatINR(r.range) : "·"}
                  </td>
                  <td className="num whitespace-nowrap">{r.confidence ?? "·"}</td>
                  <td
                    className="text-[var(--muted)] text-sm whitespace-nowrap overflow-hidden text-ellipsis"
                    title={r.key_driver}
                  >
                    {r.key_driver || "·"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>
      </div>
    </>
  );
}

function DirPill({ direction }: { direction?: string }) {
  const d = (direction || "").toLowerCase();
  const cls = d === "up" ? "pill-gain" : d === "down" ? "pill-loss" : "pill-warn";
  const glyph = d === "up" ? "↑" : d === "down" ? "↓" : "→";
  return (
    <span className={`pill ${cls}`} style={{ minWidth: 96, justifyContent: "center" }}>
      {glyph} {d ? d.toUpperCase() : "?"}
    </span>
  );
}

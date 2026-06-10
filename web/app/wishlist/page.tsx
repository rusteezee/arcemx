"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { EmptyState } from "@/components/EmptyState";
import { sb, DEFAULT_UID } from "@/lib/supabase";
import { formatINR, polishMarketText } from "@/lib/utils";

interface WishlistOutlook {
  ticker: string;
  direction?: string;
  range?: string;
  confidence?: number;
  key_driver?: string;
}

interface Row {
  ticker: string;
  outlook?: WishlistOutlook;
}

function normTicker(t: string): string {
  return (t || "").toUpperCase().replace(/\.NS$/, "");
}

export default function WishlistPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [runAt, setRunAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Primary source: the wishlist table synced from INDmoney. Reading
      // this guarantees the page shows what the user actually has on the
      // watchlist right now, regardless of whether the daily analysis has
      // emitted an outlook row for every ticker yet.
      const wlRes = await sb
        .from("wishlist")
        .select("ticker")
        .eq("user_id", DEFAULT_UID);
      const tickers = (wlRes.data || [])
        .map((r: any) => r.ticker)
        .filter((t): t is string => typeof t === "string" && t.length > 0);

      // Secondary source: per-stock 1-day outlook from the latest analysis
      // row. Merge into the wishlist set by ticker so the user sees
      // direction / range / driver wherever the model emitted one, and a
      // bare "Awaiting next analysis" cell where it did not.
      const aRes = await sb
        .from("analysis")
        .select("run_at, raw_json")
        .order("run_at", { ascending: false })
        .limit(1);
      const raw = aRes.data?.[0]?.raw_json || {};
      setRunAt(aRes.data?.[0]?.run_at || null);
      const outlooks: WishlistOutlook[] = raw.wishlist_outlooks_1d || [];
      const outlookByTicker: Record<string, WishlistOutlook> = {};
      for (const o of outlooks) {
        if (o.ticker) outlookByTicker[normTicker(o.ticker)] = o;
      }

      setRows(
        tickers
          .map((t) => ({
            ticker: t,
            outlook: outlookByTicker[normTicker(t)],
          }))
          .sort((a, b) => a.ticker.localeCompare(b.ticker))
      );
      setLoading(false);
    })();
  }, []);

  const outlookCount = useMemo(
    () => rows.filter((r) => r.outlook).length,
    [rows]
  );

  if (!loading && !rows.length) {
    return (
      <EmptyState
        title="Wishlist empty."
        hint="Send /sync to the bot to pull your INDmoney watchlist, or /add_wish TICKER to add manually."
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
          Your live INDmoney watchlist. Where the morning analysis has emitted
          a per-stock 1-day outlook (direction, ATR range, key driver), it
          merges in here. Tickers without an outlook yet show "Awaiting next
          analysis".
        </p>
      </div>

      <div className="card p-4 mb-8 inline-flex items-center gap-3 text-sm flex-wrap">
        <span className="glyph text-base">◈</span>
        <span className="text-[var(--muted)]">
          {rows.length} stocks on watchlist · {outlookCount} with current outlook
          {runAt && (
            <>
              {" · outlook from "}
              <span className="text-foreground font-medium num">
                {new Date(runAt).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "2-digit", month: "2-digit", year: "numeric",
                  hour: "numeric", minute: "2-digit", hour12: true,
                })}
              </span>
            </>
          )}
        </span>
      </div>

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
              {rows.map(({ ticker, outlook }) => (
                <tr key={ticker} className="align-middle">
                  <td className="font-medium whitespace-nowrap">
                    {normTicker(ticker)}
                  </td>
                  {outlook ? (
                    <>
                      <td className="whitespace-nowrap">
                        <DirPill direction={outlook.direction} />
                      </td>
                      <td className="num whitespace-nowrap">
                        {outlook.range ? formatINR(outlook.range) : "·"}
                      </td>
                      <td className="num whitespace-nowrap">
                        {outlook.confidence ?? "·"}
                      </td>
                      <td
                        className="text-[var(--muted)] text-sm align-top leading-snug"
                        style={{ whiteSpace: "normal" }}
                      >
                        {outlook.key_driver ? polishMarketText(outlook.key_driver) : "·"}
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className="text-[var(--muted)] text-sm italic">
                      Awaiting next analysis.
                    </td>
                  )}
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

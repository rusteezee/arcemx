"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { EmptyState } from "@/components/EmptyState";
import { TickerRow } from "@/components/TickerRow";
import { sb, DEFAULT_UID } from "@/lib/supabase";
import { fetchQuote } from "@/lib/quotes";
import { isIndian } from "@/lib/utils";

interface WL {
  ticker: string;
  last?: number;
  pct?: number;
  yHigh?: number;
  yLow?: number;
}

export default function WishlistPage() {
  const [rows, setRows] = useState<WL[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("wishlist")
        .select("ticker")
        .eq("user_id", DEFAULT_UID);
      const out: WL[] = [];
      await Promise.all(
        (data || []).map(async (w: any) => {
          const q = await fetchQuote(w.ticker);
          out.push({
            ticker: w.ticker,
            last: q?.last,
            pct: q?.pct,
            yHigh: q?.yHigh,
            yLow: q?.yLow,
          });
        })
      );
      setRows(out);
      setLoading(false);
    })();
  }, []);

  if (!loading && !rows.length) {
    return <EmptyState title="Wishlist empty." hint="Send /sync to the bot or /add_wish TICKER." />;
  }

  const ind = rows.filter((r) => isIndian(r.ticker));
  const us = rows.filter((r) => !isIndian(r.ticker));

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Wishlist</div>
        <h1 className="headline mb-3">
          Stocks you are <span className="italic">Watching.</span>
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-14">
        {ind.length > 0 && (
          <WishlistBlock num="001" title="Indian Stocks" glyph="✦" rows={ind} delay={0.05} />
        )}
        {us.length > 0 && (
          <WishlistBlock num="002" title="US Stocks" glyph="◈" rows={us} delay={0.15} />
        )}
      </div>
    </>
  );
}

function WishlistBlock({
  num,
  title,
  glyph,
  rows,
  delay,
}: {
  num: string;
  title: string;
  glyph: string;
  rows: WL[];
  delay: number;
}) {
  return (
    <div>
      <div className="mb-5">
        <div className="section-num mb-2">{num}</div>
        <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
          <span className="glyph text-lg">{glyph}</span>
          {title}
        </h2>
      </div>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay }}
        className="card overflow-hidden"
      >
        <table className="data" style={{ tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "19%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Last</th>
              <th>Day %</th>
              <th>52W high</th>
              <th>52W low</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <TickerRow key={r.ticker} {...r} price={r.last} />)}
          </tbody>
        </table>
      </motion.div>
    </div>
  );
}

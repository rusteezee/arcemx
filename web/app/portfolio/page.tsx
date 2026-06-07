"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { sb, DEFAULT_UID } from "@/lib/supabase";
import { fetchQuote } from "@/lib/quotes";
import { currencySymbol, formatPct, isIndian, stripTicker } from "@/lib/utils";

interface PortfolioRow {
  ticker: string;
  qty: number;
  avg_buy: number;
  last: number;
  invested: number;
  current: number;
  pnl: number;
  pnl_pct: number;
  currency: string;
}

const TIMELINE_RANGES: { label: string; days: number }[] = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
  { label: "3Y", days: 365 * 3 },
  { label: "5Y", days: 365 * 5 },
  { label: "MAX", days: 0 },
];

export default function PortfolioPage() {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [timeline, setTimeline] = useState<Array<{ date: string; value: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [timelineRange, setTimelineRange] = useState("6M");
  const [timelineLoading, setTimelineLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("portfolio")
        .select("*")
        .eq("user_id", DEFAULT_UID);
      const out: PortfolioRow[] = [];
      await Promise.all(
        (data || []).map(async (h: any) => {
          const q = await fetchQuote(h.ticker);
          if (!q?.last) return;
          const inv = h.avg_buy_price * h.qty;
          const cur = q.last * h.qty;
          out.push({
            ticker: h.ticker,
            qty: h.qty,
            avg_buy: h.avg_buy_price,
            last: q.last,
            invested: inv,
            current: cur,
            pnl: cur - inv,
            pnl_pct: ((cur - inv) / inv) * 100,
            currency: currencySymbol(h.ticker),
          });
        })
      );
      setRows(out);
      setLoading(false);
    })();
  }, []);

  // Refetch timeline whenever portfolio rows or selected range changes.
  useEffect(() => {
    if (!rows.length) {
      setTimeline([]);
      return;
    }
    const indRows = rows.filter((r) => r.currency === "₹");
    if (!indRows.length) {
      setTimeline([]);
      return;
    }
    const tickers = indRows.map((r) => r.ticker);
    const qtyMap: Record<string, number> = Object.fromEntries(
      indRows.map((r) => [r.ticker, r.qty])
    );
    const rangeCfg = TIMELINE_RANGES.find((r) => r.label === timelineRange) ?? TIMELINE_RANGES[3];

    let cancelled = false;
    setTimelineLoading(true);
    (async () => {
      let query = sb
        .from("prices")
        .select("ticker,ts,close")
        .in("ticker", tickers)
        .order("ts", { ascending: true });
      if (rangeCfg.days > 0) {
        const since = new Date(Date.now() - rangeCfg.days * 24 * 3600 * 1000).toISOString();
        query = query.gte("ts", since);
      }
      const { data: pdata } = await query;
      if (cancelled) return;
      const byDate: Record<string, number> = {};
      (pdata || []).forEach((p: any) => {
        const d = p.ts.slice(0, 10);
        byDate[d] = (byDate[d] || 0) + p.close * (qtyMap[p.ticker] || 0);
      });
      const series = Object.keys(byDate)
        .sort()
        .map((d) => ({ date: d, value: byDate[d] }));
      setTimeline(series);
      setTimelineLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, timelineRange]);

  if (!loading && !rows.length) {
    return (
      <EmptyState
        title="Portfolio empty."
        hint="Send /sync to the Telegram bot to pull from INDmoney."
      />
    );
  }

  const ind = rows.filter((r) => r.currency === "₹");
  const us = rows.filter((r) => r.currency === "$");

  const indInv = ind.reduce((s, r) => s + r.invested, 0);
  const indCur = ind.reduce((s, r) => s + r.current, 0);
  const indPnl = indCur - indInv;
  const indPct = (indPnl / indInv) * 100;

  const usInv = us.reduce((s, r) => s + r.invested, 0);
  const usCur = us.reduce((s, r) => s + r.current, 0);
  const usPnl = usCur - usInv;

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Portfolio</div>
        <h1 className="headline mb-3">
          Your <span className="italic">Live Positions.</span>
        </h1>
      </div>

      <Section num="001 / 003" title="Summary" glyph="✦">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Invested" value={`₹${indInv.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
          <Stat label="Current" value={`₹${indCur.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} />
          <Stat
            label="P&L"
            value={`₹${indPnl >= 0 ? "+" : ""}${indPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
            delta={formatPct(indPct)}
            deltaPositive={indPnl >= 0}
          />
          <Stat label="Holdings" value={ind.length.toString()} />
        </div>
        {us.length > 0 && (
          <div className="grid grid-cols-3 gap-4 mt-4">
            <Stat label="US Invested" value={`$${usInv.toFixed(2)}`} />
            <Stat label="US Current" value={`$${usCur.toFixed(2)}`} />
            <Stat label="US P&L" value={`${usPnl >= 0 ? "+" : ""}$${usPnl.toFixed(2)}`} deltaPositive={usPnl >= 0} />
          </div>
        )}
      </Section>

      <Section num="002 / 003" title="Holdings" glyph="◈">
        <div className="card overflow-hidden">
          <table className="data">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Qty</th>
                <th>Avg buy</th>
                <th>Last</th>
                <th>Invested</th>
                <th>Current</th>
                <th>P&L</th>
                <th>P&L %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker}>
                  <td className="font-medium">{stripTicker(r.ticker)}</td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{r.currency}{r.avg_buy.toFixed(2)}</td>
                  <td className="num">{r.currency}{r.last.toFixed(2)}</td>
                  <td className="num text-[var(--muted)]">{r.currency}{r.invested.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className="num">{r.currency}{r.current.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className={`num font-medium whitespace-nowrap ${r.pnl >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                    {r.pnl >= 0 ? "+" : ""}{r.currency}{r.pnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                  </td>
                  <td className={`num font-medium whitespace-nowrap ${r.pnl_pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                    {formatPct(r.pnl_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        num="003 / 003"
        title="Value Timeline"
        glyph="⬡"
        description="Indian holdings. Daily close × held qty."
        action={
          <div className="flex gap-1.5 flex-wrap">
            {TIMELINE_RANGES.map((p) => (
              <button
                key={p.label}
                onClick={() => setTimelineRange(p.label)}
                className={`px-3 py-1.5 text-xs rounded-md border border-border transition-colors ${
                  timelineRange === p.label
                    ? "bg-foreground text-background"
                    : "hover:bg-[var(--muted-bg)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      >
        {timelineLoading ? (
          <div className="card p-6">
            <div
              style={{ height: 320 }}
              className="flex items-center justify-center text-sm text-[var(--muted)]"
            >
              <span className="flex items-center gap-2">
                <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
                Loading
              </span>
            </div>
          </div>
        ) : timeline.length >= 2 ? (
          <div className="card p-6">
            <LineChart
              key={`pf-timeline-${timelineRange}`}
              data={timeline}
              height={320}
              color="var(--foreground)"
            />
          </div>
        ) : timeline.length === 1 ? (
          <EmptyState
            title="Only one data point in this range"
            hint="Pick a wider range or wait for more daily prices to land."
          />
        ) : (
          <EmptyState title="No historical data in this range" hint="Try a wider range or run the prices fetcher." />
        )}
      </Section>
    </>
  );
}

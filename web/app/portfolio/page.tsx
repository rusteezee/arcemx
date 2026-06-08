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

interface TxRow {
  ticker: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  execution_date: string;
}

interface PriceRow {
  ticker: string;
  ts: string;
  close: number;
}

export default function PortfolioPage() {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [timeline, setTimeline] = useState<Array<{ date: string; value: number; invested: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [timelineRange, setTimelineRange] = useState("6M");
  const [timelineLoading, setTimelineLoading] = useState(false);
  // Raw ledger + price tape are pulled once and replayed locally for each
  // range selection so switching ranges doesn't refetch from Supabase.
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [firstTxDate, setFirstTxDate] = useState<string | null>(null);

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

  // Pull the full historical ledger + every close we have for every
  // ticker the user has ever traded. Done once on mount; range slicing
  // happens locally.
  useEffect(() => {
    (async () => {
      setTimelineLoading(true);
      const txRes = await sb
        .from("transactions")
        .select("ticker,side,qty,price,execution_date")
        .eq("user_id", DEFAULT_UID)
        .order("execution_date", { ascending: true });
      const txData = (txRes.data || []) as TxRow[];
      if (!txData.length) {
        setTxs([]);
        setPrices([]);
        setFirstTxDate(null);
        setTimelineLoading(false);
        return;
      }
      const tickers = Array.from(new Set(txData.map((t) => t.ticker)));
      const firstDateIso = txData[0].execution_date.slice(0, 10);
      // Supabase / PostgREST caps a single response at 1000 rows by
      // default. With ~19 tickers × ~600 trading days we have ~7.5k
      // closes to walk, so a single fetch would silently truncate to
      // the earliest 1000 rows and every "recent" range button would
      // render empty. Paginate explicitly with .range() until the
      // server returns a short page.
      const PAGE = 1000;
      const allPrices: PriceRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const pr = await sb
          .from("prices")
          .select("ticker,ts,close")
          .in("ticker", tickers)
          .gte("ts", firstDateIso)
          .order("ts", { ascending: true })
          .range(from, from + PAGE - 1);
        const page = (pr.data || []) as PriceRow[];
        allPrices.push(...page);
        if (page.length < PAGE) break;
      }
      setTxs(txData);
      setPrices(allPrices);
      setFirstTxDate(firstDateIso);
      setTimelineLoading(false);
    })();
  }, []);

  // Replay daily portfolio value from the ledger whenever range or
  // underlying data changes. All compute is local and cheap (~900 days
  // × ~20 tickers worst case).
  useEffect(() => {
    if (!txs.length || !prices.length) {
      setTimeline([]);
      return;
    }
    const rangeCfg = TIMELINE_RANGES.find((r) => r.label === timelineRange) ?? TIMELINE_RANGES[3];
    const firstIso = firstTxDate ?? txs[0].execution_date.slice(0, 10);
    // Anchor the lookback to the most recent calendar day we actually
    // have closes for (the last trading day in `prices`), not to today.
    // Otherwise picking "1M" on a Sunday after a Friday close counts
    // back from Sunday and the window starts ~2 days earlier than the
    // user expects ("30 days from last market day").
    const lastPriceIso = prices[prices.length - 1].ts.slice(0, 10);
    const anchorMs = new Date(lastPriceIso + "T00:00:00Z").getTime();
    const rangeStartIso =
      rangeCfg.days > 0
        ? new Date(anchorMs - rangeCfg.days * 86400_000)
            .toISOString()
            .slice(0, 10)
        : firstIso;
    // The effective start is whichever is later: the window the user
    // picked, or the first day they ever owned a share. Picking a
    // 5Y range when the user only has 7 months of history naturally
    // collapses to "since first buy".
    const effectiveStartIso = rangeStartIso < firstIso ? firstIso : rangeStartIso;

    // Group prices by date so each calendar day can look up every
    // ticker's close in O(1).
    const pricesByDate = new Map<string, Map<string, number>>();
    for (const p of prices) {
      const d = p.ts.slice(0, 10);
      let inner = pricesByDate.get(d);
      if (!inner) {
        inner = new Map<string, number>();
        pricesByDate.set(d, inner);
      }
      inner.set(p.ticker, p.close);
    }
    const sortedDates = Array.from(pricesByDate.keys()).sort();
    if (!sortedDates.length) {
      setTimeline([]);
      return;
    }

    const qty: Record<string, number> = {};
    // Weighted-average cost basis tracked per ticker. BUY adds the full
    // qty*price to the pool; SELL removes a proportional slice based on
    // the current average so realized gains/losses don't pollute the
    // "invested in currently-held positions" line.
    const cost: Record<string, number> = {};
    // Carry forward the most recent close per ticker so weekends /
    // holidays (no row in `prices` that day) still use the last
    // available price instead of dropping the position to zero.
    const lastPrice: Record<string, number> = {};
    let txIdx = 0;
    const series: Array<{ date: string; value: number; invested: number }> = [];
    const EPSILON = 1e-6;

    for (const d of sortedDates) {
      // Apply every transaction up to and including end-of-day d before
      // valuing the portfolio at d's close.
      while (txIdx < txs.length && txs[txIdx].execution_date.slice(0, 10) <= d) {
        const t = txs[txIdx];
        const tQty = Number(t.qty);
        const tPrice = Number(t.price);
        if (t.side === "BUY") {
          qty[t.ticker] = (qty[t.ticker] || 0) + tQty;
          cost[t.ticker] = (cost[t.ticker] || 0) + tQty * tPrice;
        } else {
          const heldBefore = qty[t.ticker] || 0;
          const avg = heldBefore > EPSILON ? (cost[t.ticker] || 0) / heldBefore : tPrice;
          qty[t.ticker] = heldBefore - tQty;
          cost[t.ticker] = (cost[t.ticker] || 0) - tQty * avg;
          // Clamp to zero on full exit so float drift doesn't leak a
          // tiny residual cost basis into the next BUY cycle.
          if (Math.abs(qty[t.ticker]) < EPSILON) {
            qty[t.ticker] = 0;
            cost[t.ticker] = 0;
          }
        }
        txIdx++;
      }
      const dayPrices = pricesByDate.get(d)!;
      for (const [tkr, c] of dayPrices) lastPrice[tkr] = c;

      if (d < effectiveStartIso) continue;

      let total = 0;
      let invested = 0;
      for (const tkr in qty) {
        const q = qty[tkr];
        if (!q) continue;
        const p = lastPrice[tkr];
        if (p) total += q * p;
        invested += cost[tkr] || 0;
      }
      // Push every day in the window, including ones where total is
      // zero. The user had ~14 months between fully exiting their
      // earlier positions and re-entering in March 2026; that gap is
      // part of the truth of the portfolio's value over time. Skipping
      // it made 3M / 6M / 1Y look identical because they all rendered
      // only the post-re-entry portion.
      series.push({ date: d, value: total, invested });
    }

    setTimeline(series);
  }, [txs, prices, firstTxDate, timelineRange]);

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
        description="Full investing history. Replays every buy and sell against daily close to value the entire portfolio at each point in time."
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
              valueLabel="Current Value"
              investedLabel="Invested"
              investedColor="var(--muted)"
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

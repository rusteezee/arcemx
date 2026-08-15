"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { PortfolioScorecard } from "@/components/PortfolioScorecard";
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

interface RealizedRow {
  fy: string;
  gain_type: "STCG" | "LTCG";
  asset_category: string;
  scrip_name: string;
  sell_date: string | null;
  buy_date: string | null;
  units_sold: number | null;
  taxable_gain_loss: number;
}

// Rates as stated in INDmoney's own tax report notes (Sec 111A / 112A,
// listed equity only). Non-equity assets are taxed differently (slab
// rate for non-equity STCG, no ₹1.25L exemption for non-equity LTCG)
// but the imported data is 100% "Indian Stocks" so far - this estimate
// is scoped to listed-equity rates and says so in the UI, not a general
// tax calculator.
const STCG_EQUITY_RATE = 0.20;
const LTCG_EQUITY_RATE = 0.125;
const LTCG_EXEMPTION_PER_FY = 125000;

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
  const [realized, setRealized] = useState<RealizedRow[]>([]);
  const [realizedLoading, setRealizedLoading] = useState(true);

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

  // Realized P&L from imported tax-report rows (see
  // fetchers/import_realized_pnl.py). Small table (dozens to low
  // hundreds of rows even after years of trading), so all aggregation
  // (per-FY, STCG/LTCG split, tax estimate) happens client-side, same
  // as the Value Timeline replay above.
  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("realized_pnl")
        .select("fy,gain_type,asset_category,scrip_name,sell_date,buy_date,units_sold,taxable_gain_loss")
        .eq("user_id", DEFAULT_UID)
        .order("sell_date", { ascending: false });
      setRealized((data || []) as RealizedRow[]);
      setRealizedLoading(false);
    })();
  }, []);

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

  const realizedTotal = realized.reduce((s, r) => s + r.taxable_gain_loss, 0);
  const realizedStcg = realized.filter((r) => r.gain_type === "STCG").reduce((s, r) => s + r.taxable_gain_loss, 0);
  const realizedLtcg = realized.filter((r) => r.gain_type === "LTCG").reduce((s, r) => s + r.taxable_gain_loss, 0);

  const fyRows = Array.from(new Set(realized.map((r) => r.fy)))
    .sort()
    .reverse()
    .map((fy) => {
      const rowsForFy = realized.filter((r) => r.fy === fy);
      const stcg = rowsForFy.filter((r) => r.gain_type === "STCG").reduce((s, r) => s + r.taxable_gain_loss, 0);
      const ltcg = rowsForFy.filter((r) => r.gain_type === "LTCG").reduce((s, r) => s + r.taxable_gain_loss, 0);
      // Sec 111A (equity STCG): flat 20%, no exemption. Sec 112A (equity
      // LTCG): 12.5% only on the amount above the ₹1.25L per-FY
      // exemption. Net losses owe nothing (they're a carry-forward, not
      // a payable) - clamp each side at 0 before applying the rate.
      const stcgTax = Math.max(0, stcg) * STCG_EQUITY_RATE;
      const ltcgTax = Math.max(0, Math.max(0, ltcg) - LTCG_EXEMPTION_PER_FY) * LTCG_EQUITY_RATE;
      return { fy, stcg, ltcg, total: stcg + ltcg, estTax: stcgTax + ltcgTax };
    });
  const totalEstTax = fyRows.reduce((s, r) => s + r.estTax, 0);

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Portfolio</div>
        <h1 className="headline mb-3">
          Your <span className="italic">Live Positions.</span>
        </h1>
      </div>

      <Section num="001 / 005" title="Summary" glyph="✦">
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

      <Section
        num="002 / 005"
        title="Portfolio Scorecard"
        glyph="◉"
        description="Live score on your actual holdings. Sector spread, single-name risk, momentum vs NIFTY, drawdown, edge over the index. Red flags and tips to lift the score below."
      >
        <PortfolioScorecard />
      </Section>

      <Section num="003 / 005" title="Holdings" glyph="◈">
        <div className="card overflow-hidden">
          <div className="table-scroll">
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
                    <td className="font-medium whitespace-nowrap">{stripTicker(r.ticker)}</td>
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
        </div>
      </Section>

      <Section
        num="004 / 005"
        title="Value Timeline"
        glyph="⬡"
        description="Full investing history. Replays every buy and sell against daily close to value the entire portfolio at each point in time."
        action={
          <div className="h-scroll flex gap-1.5 -mx-1 px-1">
            {TIMELINE_RANGES.map((p) => (
              <button
                key={p.label}
                onClick={() => setTimelineRange(p.label)}
                className={`shrink-0 px-3 py-1.5 text-xs rounded-md border border-border transition-colors ${
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

      <Section
        num="005 / 005"
        title="Realized P&L"
        glyph="◐"
        description="Booked gains and losses from INDmoney's consolidated tax report. Import a fresh report with `python -m fetchers.import_realized_pnl <file.xlsx>` after each download."
      >
        {realizedLoading ? (
          <div className="card p-5">
            <p className="text-sm text-[var(--muted)]">Loading realized P&L.</p>
          </div>
        ) : realized.length === 0 ? (
          <EmptyState
            title="No realized P&L imported yet."
            hint="Download the Consolidated Tax Report from INDmoney (Profile → Tax Reports & Documents) and import it."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <Stat
                label="Total Realized P&L"
                value={`₹${realizedTotal >= 0 ? "+" : ""}${realizedTotal.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
                deltaPositive={realizedTotal >= 0}
              />
              <Stat
                label="STCG"
                value={`₹${realizedStcg >= 0 ? "+" : ""}${realizedStcg.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
                deltaPositive={realizedStcg >= 0}
              />
              <Stat
                label="LTCG"
                value={`₹${realizedLtcg >= 0 ? "+" : ""}${realizedLtcg.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
                deltaPositive={realizedLtcg >= 0}
              />
              <Stat
                label="Est. Tax Owed"
                value={`₹${totalEstTax.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
              />
            </div>
            <p className="text-xs text-[var(--muted)] mb-4">
              Tax estimate covers listed equity only (Sec 111A STCG at 20%, Sec 112A LTCG at 12.5%
              above the ₹1,25,000 per-FY exemption). not a full tax calculator, and not investment
              or tax advice. Verify against the actual report before filing.
            </p>
            <div className="card overflow-hidden mb-4">
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>FY</th>
                      <th>STCG</th>
                      <th>LTCG</th>
                      <th>Total</th>
                      <th>Est. Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fyRows.map((r) => (
                      <tr key={r.fy}>
                        <td className="font-medium whitespace-nowrap">{r.fy}</td>
                        <td className={`num ${r.stcg >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {r.stcg >= 0 ? "+" : ""}₹{r.stcg.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`num ${r.ltcg >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {r.ltcg >= 0 ? "+" : ""}₹{r.ltcg.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`num font-medium ${r.total >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {r.total >= 0 ? "+" : ""}₹{r.total.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                        <td className="num text-[var(--muted)]">
                          ₹{r.estTax.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Type</th>
                      <th>Buy Date</th>
                      <th>Sell Date</th>
                      <th>Units</th>
                      <th>Gain/Loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {realized.map((r, i) => (
                      <tr key={i}>
                        <td className="font-medium whitespace-nowrap">{r.scrip_name}</td>
                        <td className="whitespace-nowrap">{r.gain_type}</td>
                        <td className="num whitespace-nowrap">{r.buy_date ?? "·"}</td>
                        <td className="num whitespace-nowrap">{r.sell_date ?? "·"}</td>
                        <td className="num">{r.units_sold ?? "·"}</td>
                        <td className={`num font-medium whitespace-nowrap ${r.taxable_gain_loss >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {r.taxable_gain_loss >= 0 ? "+" : ""}₹{r.taxable_gain_loss.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </Section>
    </>
  );
}

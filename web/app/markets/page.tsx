"use client";

import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { LineChart } from "@/components/LineChart";
import { Heatmap } from "@/components/Heatmap";
import { sb, DEFAULT_UID } from "@/lib/supabase";
import { fetchQuote, fetchHistory } from "@/lib/quotes";
import { formatPct, stripTicker } from "@/lib/utils";

const NIFTY50 = [
  "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
  "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
  "LT.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS", "HCLTECH.NS",
  "SUNPHARMA.NS", "TITAN.NS", "BAJFINANCE.NS", "WIPRO.NS", "NTPC.NS",
  "POWERGRID.NS", "M&M.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ONGC.NS",
];

const INDICES = [
  { sym: "^NSEI", name: "Nifty 50" },
  { sym: "^BSESN", name: "Sensex" },
  { sym: "^NSEBANK", name: "Bank Nifty" },
];

const PRESETS = ["^NSEI", "^BSESN", "^NSEBANK", "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS"];
const PERIODS: { label: string; range: string }[] = [
  { label: "1W", range: "5d" },
  { label: "1M", range: "1mo" },
  { label: "3M", range: "3mo" },
  { label: "6M", range: "6mo" },
  { label: "1Y", range: "1y" },
  { label: "3Y", range: "3y" },
  { label: "5Y", range: "5y" },
  { label: "MAX", range: "max" },
];

export default function MarketsPage() {
  const [idxQuotes, setIdxQuotes] = useState<Record<string, any>>({});
  const [sel, setSel] = useState("^NSEI");
  const [period, setPeriod] = useState("6mo");
  const [chart, setChart] = useState<Array<{ date: string; value: number }>>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [serverRange, setServerRange] = useState<string | null>(null);
  const [heat, setHeat] = useState<Array<{ ticker: string; pct: number; weight: number }>>([]);
  const [custom, setCustom] = useState("");
  const [customTickers, setCustomTickers] = useState<string[]>([]);

  useEffect(() => {
    INDICES.forEach(async ({ sym }) => {
      const q = await fetchQuote(sym);
      if (q) setIdxQuotes((p) => ({ ...p, [sym]: q }));
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    setChartError(null);
    setServerRange(null);
    (async () => {
      try {
        const q = await fetchHistory(sel, period);
        if (cancelled) return;
        if (q?.history && q.history.length > 0) {
          setChart(q.history.map((h) => ({ date: h.date, value: h.close })));
          setServerRange(q.debugRange || null);
        } else {
          setChart([]);
          setChartError("No data for this ticker / range. Yahoo may be rate-limiting. Try another range or wait.");
        }
      } catch (e) {
        if (!cancelled) {
          setChart([]);
          setChartError("Chart fetch failed. Retry.");
        }
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sel, period]);

  useEffect(() => {
    (async () => {
      const wl = await sb.from("wishlist").select("ticker").eq("user_id", DEFAULT_UID);
      const pf = await sb.from("portfolio").select("ticker").eq("user_id", DEFAULT_UID);
      const extra = [
        ...(wl.data?.map((r: any) => r.ticker) || []),
        ...(pf.data?.map((r: any) => r.ticker) || []),
      ];
      const all = Array.from(new Set([...NIFTY50, ...extra]));
      const rows: Array<{ ticker: string; pct: number; weight: number }> = [];
      await Promise.all(
        all.map(async (t) => {
          const q = await fetchQuote(t);
          if (q?.last != null) {
            rows.push({ ticker: t, pct: q.pct ?? 0, weight: Math.abs(q.last) + 1 });
          }
        })
      );
      setHeat(rows);
    })();
  }, []);

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Markets</div>
        <h1 className="headline mb-3">
          Live Indices, Charts, <span className="italic">Heatmap.</span>
        </h1>
      </div>

      <Section num="001 / 003" title="Indices" glyph="✦">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {INDICES.map(({ sym, name }) => {
            const q = idxQuotes[sym];
            return (
              <Stat
                key={sym}
                label={name}
                value={q?.last != null ? q.last.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "·"}
                delta={q?.pct != null ? formatPct(q.pct) : undefined}
                deltaPositive={q?.pct >= 0}
              />
            );
          })}
        </div>
      </Section>

      <Section
        num="002 / 003"
        title="Chart"
        glyph="◈"
        action={
          <div className="flex gap-1.5 flex-wrap">
            {PERIODS.map((p) => (
              <button
                key={p.range}
                onClick={() => setPeriod(p.range)}
                className={`px-3 py-1.5 text-xs rounded-md border border-border transition-colors ${
                  period === p.range
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
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
            <div className="flex gap-1.5 flex-wrap">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setSel(p)}
                  className={`px-2.5 py-1 text-xs rounded-md border border-border transition-colors ${
                    sel === p ? "bg-foreground text-background" : "hover:bg-[var(--muted-bg)]"
                  }`}
                >
                  {stripTicker(p)}
                </button>
              ))}
              {customTickers.map((t) => {
                const active = sel === t;
                return (
                  <div
                    key={t}
                    className={`flex items-center text-xs rounded-md border border-border overflow-hidden transition-colors ${
                      active ? "bg-foreground text-background" : "hover:bg-[var(--muted-bg)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSel(t)}
                      className="pl-2.5 py-1 cursor-pointer"
                    >
                      {stripTicker(t)}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomTickers((prev) => prev.filter((x) => x !== t));
                        if (sel === t) setSel(PRESETS[0]);
                      }}
                      aria-label={`Remove ${stripTicker(t)}`}
                      className={`px-1.5 py-1 ml-1 cursor-pointer ${
                        active ? "hover:bg-background/20" : "hover:bg-[var(--muted-bg)]"
                      }`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const raw = custom.trim().toUpperCase();
                  if (!raw) return;
                  // Auto-qualify NSE tickers. Indices keep their ^ prefix,
                  // anything already carrying a dot suffix (.NS, .BO, US
                  // tickers like AAPL using "." would be rare) is left
                  // alone, bare names like "SUZLON" default to "SUZLON.NS"
                  // since this dashboard is India-first.
                  const normalized =
                    raw.startsWith("^") || raw.includes(".") ? raw : `${raw}.NS`;
                  // Only push into the custom-ticker pills if it isn't
                  // already a preset or another custom entry. PRESETS
                  // stay fixed; the user can only add or remove their own.
                  if (!PRESETS.includes(normalized)) {
                    setCustomTickers((prev) =>
                      prev.includes(normalized) ? prev : [...prev, normalized]
                    );
                  }
                  setSel(normalized);
                  setCustom("");
                }}
                className="flex items-center gap-1"
              >
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Add ticker"
                  className="px-2.5 py-1 text-xs rounded-md border border-border bg-transparent w-28 focus:outline-none focus:border-foreground"
                />
              </form>
            </div>
            <div className="text-sm text-[var(--muted)] flex items-center gap-3">
              {chartLoading ? (
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
                  Loading
                </span>
              ) : chart.length > 0 ? (
                <span className="text-xs num">{chart.length} pts</span>
              ) : null}
              <span>
                {stripTicker(sel)} · {period.toUpperCase()}
                {serverRange && serverRange !== period && (
                  <span className="ml-2 text-[var(--loss)] text-xs">
                    (server saw: {serverRange})
                  </span>
                )}
              </span>
            </div>
          </div>
          {chartError ? (
            <div
              style={{ height: 380 }}
              className="flex items-center justify-center text-center text-sm text-[var(--muted)] px-6"
            >
              {chartError}
            </div>
          ) : (
            <LineChart
              key={`${sel}-${period}`}
              data={chart}
              height={380}
              color="var(--foreground)"
            />
          )}
        </div>
      </Section>

      <Section
        num="003 / 003"
        title="Heatmap"
        glyph="⬡"
        description="NIFTY 50 plus your portfolio and wishlist. Tone by day percent change."
      >
        <Heatmap items={heat} />
      </Section>
    </>
  );
}

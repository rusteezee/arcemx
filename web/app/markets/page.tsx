"use client";

import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { LineChart } from "@/components/LineChart";
import { MultiLineChart, type Series } from "@/components/MultiLineChart";
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

// Compare-chart universe: indices + 10 NSE sectors + Midcap 150. Matches the
// payload's market_context.sectors set so the chart visually mirrors what
// the analyzer reasons over. Colors are stable per-symbol so toggling a
// series doesn't shuffle the rest of the palette.
const COMPARE_SYMBOLS: { sym: string; label: string; color: string }[] = [
  { sym: "^NSEI",              label: "NIFTY",      color: "#3b82f6" },
  { sym: "^BSESN",             label: "Sensex",     color: "#8b5cf6" },
  { sym: "^NSEBANK",           label: "BankNifty",  color: "#ec4899" },
  { sym: "NIFTYMIDCAP150.NS",  label: "Midcap 150", color: "#06b6d4" },
  { sym: "^CNXIT",             label: "IT",         color: "#10b981" },
  { sym: "^CNXAUTO",           label: "Auto",       color: "#f59e0b" },
  { sym: "^CNXPHARMA",         label: "Pharma",     color: "#ef4444" },
  { sym: "^CNXFMCG",           label: "FMCG",       color: "#84cc16" },
  { sym: "^CNXENERGY",         label: "Energy",     color: "#a855f7" },
  { sym: "^CNXMETAL",          label: "Metal",      color: "#64748b" },
  { sym: "^CNXREALTY",         label: "Realty",     color: "#f97316" },
  { sym: "^CNXMEDIA",          label: "Media",      color: "#14b8a6" },
];

const COMPARE_DEFAULT_VISIBLE = new Set([
  "^NSEI",
  "^BSESN",
  "NIFTYMIDCAP150.NS",
  "^NSEBANK",
  "^CNXIT",
  "^CNXAUTO",
]);
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

  // Compare-chart state. Separate period from the single-ticker chart's
  // period so toggling the compare section doesn't disturb the main chart.
  const [cmpPeriod, setCmpPeriod] = useState("1mo");
  const [cmpNormalize, setCmpNormalize] = useState(true);
  const [cmpSeries, setCmpSeries] = useState<Series[]>([]);
  const [cmpVisible, setCmpVisible] = useState<Set<string>>(COMPARE_DEFAULT_VISIBLE);
  const [cmpLoading, setCmpLoading] = useState(false);

  // Hydrate the custom-ticker pill row from localStorage on mount so the
  // user doesn't lose their additions after a refresh. Skipped on the
  // server (no window) and on first render to keep SSR markup stable.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("arcemx.markets.customTickers");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .filter((x) => !PRESETS.includes(x));
        if (cleaned.length) setCustomTickers(cleaned);
      }
    } catch {
      // Bad JSON or storage disabled. ignore, fall back to empty.
    }
  }, []);

  // Persist whenever the custom-ticker row changes so refresh keeps them.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "arcemx.markets.customTickers",
        JSON.stringify(customTickers)
      );
    } catch {
      // Storage disabled. ignore.
    }
  }, [customTickers]);

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

  // Compare chart data fetcher. Fires whenever the period changes; series
  // for hidden symbols are still fetched so toggling them on doesn't trigger
  // a second round trip. yfinance via /api/quote is the same proxy the
  // single-ticker chart uses.
  useEffect(() => {
    let cancelled = false;
    setCmpLoading(true);
    (async () => {
      const results = await Promise.all(
        COMPARE_SYMBOLS.map(async ({ sym, label, color }) => {
          try {
            const q = await fetchHistory(sym, cmpPeriod);
            const points = (q?.history || []).map((h) => ({ date: h.date, value: h.close }));
            return { key: sym, label, color, points } as Series;
          } catch {
            return { key: sym, label, color, points: [] } as Series;
          }
        })
      );
      if (cancelled) return;
      setCmpSeries(results);
      setCmpLoading(false);
    })();
    return () => { cancelled = true; };
  }, [cmpPeriod]);

  const toggleCmp = (sym: string) => {
    setCmpVisible((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      return next;
    });
  };

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

      <Section num="001 / 004" title="Indices" glyph="✦">
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
        num="002 / 004"
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
        num="003 / 004"
        title="Indices and Sector Compare"
        glyph="◉"
        description="NIFTY, Sensex, BankNifty, Midcap 150, and the 10 NSE sector indices on one chart. Normalized to 100 at range start so different absolute levels compare directly. Toggle any series in the legend."
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setCmpNormalize((v) => !v)}
              className={`px-3 py-1.5 text-xs rounded-md border border-border transition-colors ${
                cmpNormalize ? "bg-foreground text-background" : "hover:bg-[var(--muted-bg)]"
              }`}
              title="Rebase each line to 100 at the start of the range so they share a common scale."
            >
              Normalize %
            </button>
            <div className="flex gap-1.5 flex-wrap">
              {PERIODS.filter((p) => p.range !== "max").map((p) => (
                <button
                  key={p.range}
                  onClick={() => setCmpPeriod(p.range)}
                  className={`px-3 py-1.5 text-xs rounded-md border border-border transition-colors ${
                    cmpPeriod === p.range
                      ? "bg-foreground text-background"
                      : "hover:bg-[var(--muted-bg)]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="card p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {COMPARE_SYMBOLS.map(({ sym, label, color }) => {
              const active = cmpVisible.has(sym);
              return (
                <button
                  key={sym}
                  onClick={() => toggleCmp(sym)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
                    active
                      ? "border-foreground/40 bg-[var(--muted-bg)]"
                      : "border-border opacity-50 hover:opacity-100"
                  }`}
                  title={active ? `Hide ${label}` : `Show ${label}`}
                >
                  <span
                    aria-hidden
                    className="inline-block size-2 rounded-full"
                    style={{ background: color }}
                  />
                  <span className="font-medium">{label}</span>
                </button>
              );
            })}
            <span className="ml-auto text-xs text-[var(--muted)]">
              {cmpLoading ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
                  Fetching
                </span>
              ) : (
                <span>{cmpPeriod.toUpperCase()} · {cmpVisible.size} of {COMPARE_SYMBOLS.length} visible</span>
              )}
            </span>
          </div>
          <MultiLineChart
            key={`${cmpPeriod}-${cmpNormalize}`}
            series={cmpSeries}
            visibleKeys={cmpVisible}
            normalize={cmpNormalize}
            height={400}
          />
        </div>
      </Section>

      <Section
        num="004 / 004"
        title="Heatmap"
        glyph="⬡"
        description="NIFTY 50 plus your portfolio and wishlist. Tone by day percent change."
      >
        <Heatmap items={heat} />
      </Section>
    </>
  );
}

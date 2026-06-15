"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { EmptyState } from "@/components/EmptyState";
import { DirPill } from "@/components/DirPill";
import { fetchQuote, fetchHistory } from "@/lib/quotes";
import { formatNumber, polishMarketText } from "@/lib/utils";

const LEADERBOARD_SYMBOLS: { sym: string; name: string }[] = [
  { sym: "^NSEI",              name: "NIFTY" },
  { sym: "^BSESN",             name: "Sensex" },
  { sym: "^NSEBANK",           name: "BankNifty" },
  { sym: "NIFTYMIDCAP150.NS",  name: "Midcap 150" },
  { sym: "^CNXIT",             name: "IT" },
  { sym: "^CNXAUTO",           name: "Auto" },
  { sym: "^CNXPHARMA",         name: "Pharma" },
  { sym: "^CNXFMCG",           name: "FMCG" },
  { sym: "^CNXENERGY",         name: "Energy" },
  { sym: "^CNXMETAL",          name: "Metal" },
  { sym: "^CNXREALTY",         name: "Realty" },
  { sym: "^CNXMEDIA",          name: "Media" },
  { sym: "NIFTY_FIN_SERVICE.NS", name: "FinServ" },
];

interface PlaygroundItem {
  name: string;
  direction: string;
  confidence: number;
  range?: string;
  driver?: string;
  score: number;
}

function compositeScore(direction: string | undefined, confidence: number | undefined): number {
  const d = (direction || "").toLowerCase();
  const c = typeof confidence === "number" ? confidence : 50;
  if (d === "up") return c;
  if (d === "down") return -c;
  return 0;
}

function buildPlaygroundList(
  sectors: any[],
  nifty: any,
  sensex: any,
  topConf: number | undefined,
): PlaygroundItem[] {
  const items: PlaygroundItem[] = [];
  if (nifty) {
    items.push({
      name: "NIFTY",
      direction: nifty.direction || "sideways",
      confidence: typeof topConf === "number" ? topConf : 50,
      range: nifty.range,
      driver: Array.isArray(nifty.drivers) ? nifty.drivers.join("; ") : undefined,
      score: compositeScore(nifty.direction, topConf),
    });
  }
  if (sensex) {
    items.push({
      name: "Sensex",
      direction: sensex.direction || "sideways",
      confidence: typeof topConf === "number" ? topConf : 50,
      range: sensex.range,
      driver: Array.isArray(sensex.drivers) ? sensex.drivers.join("; ") : undefined,
      score: compositeScore(sensex.direction, topConf),
    });
  }
  for (const s of sectors) {
    items.push({
      name: s.sector,
      direction: s.direction || "sideways",
      confidence: typeof s.confidence === "number" ? s.confidence : 50,
      range: s.range,
      driver: s.key_driver,
      score: compositeScore(s.direction, s.confidence),
    });
  }
  items.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return items;
}

export function Playground({
  sectors,
  nifty,
  sensex,
  confidence,
  pair,
  capPair,
}: {
  sectors: any[];
  nifty?: any;
  sensex?: any;
  confidence?: number;
  pair?: any;
  capPair?: any;
}) {
  if (!sectors.length && !nifty && !sensex && !pair && !capPair) {
    return <EmptyState title="No leaderboard data" hint="Populates from tomorrow's cron." />;
  }
  const items = buildPlaygroundList(sectors, nifty, sensex, confidence);
  const max = Math.max(1, ...items.map((it) => Math.abs(it.score)));
  return (
    <div className="space-y-4">
      <SectorBarChart symbols={LEADERBOARD_SYMBOLS} />

      {items.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-5 pb-2">
            <div className="section-num mb-1 tracking-widest">FORECAST</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Model&apos;s ranked board for the next session. Direction sign times
              confidence, with the key driver behind every row.
            </p>
          </div>
          <div className="table-scroll">
          <table className="data" style={{ width: "100%" }}>
            <colgroup>
              <col style={{ width: "5%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "10%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Instrument</th>
                <th>Direction</th>
                <th>Range</th>
                <th>Confidence</th>
                <th>Key Driver</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const accent =
                  it.score > 0
                    ? "var(--gain)"
                    : it.score < 0
                    ? "var(--loss)"
                    : "var(--muted)";
                const barPct = Math.min(100, (Math.abs(it.score) / max) * 100);
                return (
                  <tr key={`${it.name}-${i}`}>
                    <td className="num text-[var(--muted)] font-medium">{i + 1}</td>
                    <td className="font-medium whitespace-nowrap">{it.name}</td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <DirPill direction={it.direction} />
                        <span
                          aria-hidden
                          className="inline-block rounded-full"
                          style={{
                            width: `${barPct * 0.6}px`,
                            maxWidth: 60,
                            height: 4,
                            background: accent,
                            opacity: 0.55,
                          }}
                        />
                      </div>
                    </td>
                    <td className="num whitespace-nowrap">
                      {it.range ? formatNumber(it.range) : "·"}
                    </td>
                    <td className="num whitespace-nowrap">{it.confidence ?? "·"}</td>
                    <td className="clamp-3 text-[var(--muted)] text-sm leading-snug">
                      {it.driver ? polishMarketText(it.driver) : "·"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {(pair || capPair) && (
        <div>
          <div className="mb-2 mt-2">
            <div className="section-num mb-1 tracking-widest">PAIR CALLS FORECAST</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              The model&apos;s relative-pair predictions for tomorrow. Read as
              context behind the ranked boards above.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pair && <PairBadge label="NIFTY vs BankNifty" data={pair} />}
            {capPair && <PairBadge label="NIFTY vs Midcap 150" data={capPair} />}
          </div>
        </div>
      )}
    </div>
  );
}

type ChartPeriod = "LIVE" | "1W" | "1M" | "3M" | "6M" | "1Y" | "2Y" | "5Y" | "MAX";
const CHART_PERIODS: ChartPeriod[] = ["LIVE", "1W", "1M", "3M", "6M", "1Y", "2Y", "5Y", "MAX"];
const PERIOD_RANGE: Record<ChartPeriod, string> = {
  LIVE: "5d",
  "1W": "5d",
  "1M": "1mo",
  "3M": "3mo",
  "6M": "6mo",
  "1Y": "1y",
  "2Y": "2y",
  "5Y": "5y",
  MAX: "max",
};

function niceAxisCeiling(v: number): number {
  if (v <= 0.5) return 0.5;
  if (v <= 1) return 1;
  if (v <= 2) return 2;
  if (v <= 5) return Math.ceil(v);
  if (v <= 20) return Math.ceil(v / 2) * 2;
  if (v <= 50) return Math.ceil(v / 5) * 5;
  if (v <= 200) return Math.ceil(v / 10) * 10;
  return Math.ceil(v / 25) * 25;
}

interface BarRow {
  name: string;
  pct: number;
}

function SectorBarChart({ symbols }: { symbols: { sym: string; name: string }[] }) {
  const [period, setPeriod] = useState<ChartPeriod>("LIVE");
  const [rows, setRows] = useState<BarRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setStale(true);
    (async () => {
      const range = PERIOD_RANGE[period];
      // LIVE = today vs prior close (fetchQuote returns pct directly and
      // handles Yahoo's prev===last quirk). Every other period needs a
      // candle history to compute first-close vs last-close, which only
      // fetchHistory returns.
      const results = await Promise.all(
        symbols.map(async ({ sym, name }) => {
          let pct: number | null = null;
          if (period === "LIVE") {
            const q = await fetchQuote(sym, range);
            if (q && Number.isFinite(q.pct)) pct = q.pct;
          } else {
            const q = await fetchHistory(sym, range);
            const h = q?.history || [];
            if (h.length >= 2) {
              const first = h[0].close;
              const last = h[h.length - 1].close;
              if (first > 0) pct = ((last - first) / first) * 100;
            }
          }
          if (pct == null || !Number.isFinite(pct)) return null;
          return { name, pct } as BarRow;
        }),
      );
      if (cancelled) return;
      const filtered = results
        .filter((r): r is BarRow => r !== null)
        .sort((a, b) => b.pct - a.pct);
      setRows(filtered);
      setBusy(false);
      setStale(false);
    })();
    return () => { cancelled = true; };
  }, [period, symbols]);

  const positionByName = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.name, i));
    return m;
  }, [rows]);

  const maxAbs = Math.max(0.5, ...rows.map((r) => Math.abs(r.pct)));
  const yMax = niceAxisCeiling(maxAbs);
  const yMin = -yMax;

  const W = 920;
  const H = 340;
  const padL = 56;
  const padR = 24;
  const padT = 24;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const yZero = padT + innerH / 2;
  const yPerPct = innerH / (yMax - yMin);
  const n = Math.max(symbols.length, 1);
  const slot = innerW / n;
  const barW = slot * 0.72;

  const ticks = [-1, -0.5, 0, 0.5, 1].map((t) => ({
    yPct: t * yMax,
    y: yZero - t * yMax * yPerPct,
  }));

  return (
    <div className="card overflow-hidden">
      <div className="p-5 pb-3 flex flex-col gap-3">
        <div>
          <div className="section-num mb-1 tracking-widest">SECTOR PERFORMANCE</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Percent change across the same universe the model forecasts on,
            for the selected window. LIVE is today vs prior close; every
            other period is first close vs last close over that range.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {CHART_PERIODS.map((p) => {
            const active = period === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                disabled={busy && p !== period}
                className="text-xs font-medium tracking-wide rounded-full px-3 py-1 border transition-colors disabled:cursor-not-allowed"
                style={{
                  borderColor: active ? "var(--foreground)" : "var(--border)",
                  background: active ? "var(--foreground)" : "transparent",
                  color: active ? "var(--background)" : "var(--muted)",
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-3 sm:px-5 pb-5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          role="img"
          aria-label={`Sector performance bar chart, period ${period}`}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={t.y}
                y2={t.y}
                stroke={t.yPct === 0 ? "var(--border)" : "color-mix(in srgb, var(--border) 55%, transparent)"}
                strokeWidth={t.yPct === 0 ? 1.2 : 1}
                strokeDasharray={t.yPct === 0 ? "" : "3 3"}
              />
              <text
                x={padL - 8}
                y={t.y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                fill="var(--muted)"
              >
                {`${t.yPct > 0 ? "+" : ""}${t.yPct.toFixed(t.yPct === 0 ? 0 : yMax >= 5 ? 0 : 1)}%`}
              </text>
            </g>
          ))}

          <text
            x={14}
            y={padT + innerH / 2}
            textAnchor="middle"
            fontSize={11}
            fill="var(--muted)"
            transform={`rotate(-90 14 ${padT + innerH / 2})`}
          >
            % change
          </text>

          {/* Bars: each remounts on period change (key includes period) and
              slides up from the zero baseline. Initial state pins the rect to
              y=yZero with height=0 so the bar literally grows out of the
              x-axis; final state lands at its real value. Same for value
              labels: they ride up with the bar top. */}
          {rows.map((r) => {
            const i = positionByName.get(r.name) ?? 0;
            const cx = padL + (i + 0.5) * slot;
            const barH = Math.abs(r.pct) * yPerPct;
            const y = r.pct >= 0 ? yZero - barH : yZero;
            const fill = r.pct >= 0 ? "var(--gain)" : "var(--loss)";
            return (
              <motion.g key={`${period}-${r.name}`}>
                <motion.rect
                  initial={{ x: cx - barW / 2, y: yZero, width: barW, height: 0, opacity: 0 }}
                  animate={{ x: cx - barW / 2, y, width: barW, height: Math.max(barH, 1), opacity: stale ? 0.55 : 0.9 }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: i * 0.025 }}
                  fill={fill}
                  rx={3}
                />
                <motion.text
                  initial={{ x: cx, y: yZero, opacity: 0 }}
                  animate={{
                    x: cx,
                    y: r.pct >= 0 ? y - 6 : y + barH + 13,
                    opacity: 1,
                  }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: i * 0.025 + 0.1 }}
                  textAnchor="middle"
                  fontSize={10}
                  fill={fill}
                  className="num"
                >
                  {`${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`}
                </motion.text>
              </motion.g>
            );
          })}

          {rows.map((r) => {
            const i = positionByName.get(r.name) ?? 0;
            const cx = padL + (i + 0.5) * slot;
            const ly = H - padB + 14;
            return (
              <motion.text
                key={`xlabel-${period}-${r.name}`}
                initial={{ x: cx, y: ly, opacity: 0 }}
                animate={{ x: cx, y: ly, opacity: 1 }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: i * 0.025 + 0.15 }}
                fontSize={11}
                fill="var(--muted)"
                textAnchor="middle"
                transform={`rotate(-32 ${cx} ${ly})`}
              >
                {r.name}
              </motion.text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function PairBadge({ label, data }: { label: string; data: any }) {
  const outperformer = (data.outperformer || "").toUpperCase();
  const spread = data.spread_pct;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="section-num mb-1">{label}</div>
          <div className="text-sm font-semibold">
            {outperformer ? `${outperformer} leads` : "Even"}
          </div>
        </div>
        {spread !== undefined && (
          <span className="pill num">spread {spread}%</span>
        )}
      </div>
      {data.rationale && (
        <p className="text-xs text-[var(--muted)] leading-relaxed mt-2 line-clamp-2" title={data.rationale}>
          {data.rationale}
        </p>
      )}
    </div>
  );
}

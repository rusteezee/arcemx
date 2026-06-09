"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { MultiLineChart, type Series } from "@/components/MultiLineChart";
import {
  buildPortfolioReport,
  type PortfolioReport,
} from "@/lib/portfolioScore";
import { formatMoney, formatPct } from "@/lib/utils";

const BENCH_COLORS = {
  portfolio: "var(--foreground)",
  nifty:     "#3b82f6",
  sensex:    "#8b5cf6",
};

export function PortfolioScorecard() {
  const [report, setReport] = useState<PortfolioReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await buildPortfolioReport();
        setReport(r);
      } catch (e: any) {
        setErr(e?.message || "score build failed");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const series: Series[] = useMemo(() => {
    if (!report) return [];
    return [
      { key: "portfolio", label: "Portfolio",    color: BENCH_COLORS.portfolio, points: report.series.portfolio },
      { key: "nifty",     label: "NIFTY 50",     color: BENCH_COLORS.nifty,     points: report.series.nifty },
      { key: "sensex",    label: "Sensex",       color: BENCH_COLORS.sensex,    points: report.series.sensex },
    ];
  }, [report]);

  const visible = useMemo(
    () => new Set(["portfolio", "nifty", "sensex"]),
    [],
  );

  if (loading) {
    return (
      <div className="card p-8 text-center text-sm text-[var(--muted)]">
        <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse mr-2 align-middle" />
        Building portfolio score
      </div>
    );
  }

  if (err) {
    return (
      <div className="card p-5 text-sm text-[var(--loss)]">
        {err}
      </div>
    );
  }

  if (!report) {
    return (
      <EmptyState
        title="No holdings yet."
        hint="Sync your INDmoney portfolio via /sync first. The score uses live quantities and the cached prices table."
      />
    );
  }

  const { holdings, totalValue, sectorWeights, capWeights, score, metrics, redFlags, tips, edgeVerdict, hasHistory } = report;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-5"
    >
      {/* Score header */}
      <div className="card p-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div>
            <div className="section-num mb-1">Portfolio Score</div>
            <div className="text-5xl font-semibold num leading-none">{score.total}</div>
            <div className="text-xs text-[var(--muted)] mt-2">
              {hasHistory ? "Composite of 5 components" : "Structural only (history thin)"}
            </div>
          </div>
          <Stat label="NAV" value={formatMoney(totalValue, "RELIANCE.NS")} glyph="◈" />
          <Stat
            label="30d alpha vs NIFTY"
            value={metrics.alpha30dPct == null ? "·" : `${metrics.alpha30dPct >= 0 ? "+" : ""}${metrics.alpha30dPct.toFixed(2)} pp`}
            glyph="⬡"
          />
          <Stat
            label="Max drawdown"
            value={metrics.maxDrawdownPct == null ? "·" : `${metrics.maxDrawdownPct.toFixed(1)}%`}
            glyph="◉"
          />
        </div>
      </div>

      {/* Component scores */}
      <div className="card p-5">
        <div className="section-num mb-3">Score Breakdown</div>
        <div className="space-y-2.5">
          {(
            [
              { key: "diversification", label: "Diversification", gloss: "Sector HHI. Lower concentration scores higher." },
              { key: "singleNameRisk", label: "Single-Name Risk",  gloss: "Largest weight. <=15% is full credit." },
              { key: "momentum30d",    label: "Momentum (30d)",    gloss: "Alpha vs NIFTY over last 30 sessions." },
              { key: "drawdown",       label: "Drawdown",          gloss: "Trailing max drawdown of simulated NAV." },
              { key: "edge",           label: "Edge",              gloss: "60d return vs realized vol (Sharpe-style)." },
            ] as const
          ).map(({ key, label, gloss }) => {
            const v = score.components[key];
            return (
              <div key={key} className="flex items-center gap-4">
                <div className="w-40 text-sm font-medium">{label}</div>
                <div className="flex-1">
                  <div
                    aria-hidden
                    className="rounded-r-full bg-[var(--foreground)] opacity-65"
                    style={{ width: `${Math.min(100, v)}%`, height: 10, transition: "width 0.6s ease-out" }}
                  />
                </div>
                <div className="w-12 text-right num font-medium">{v}</div>
                <div className="hidden md:block w-72 text-xs text-[var(--muted)]">{gloss}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Performance chart vs benchmarks */}
      <div className="card p-6">
        <div className="section-num mb-1">Portfolio vs Benchmarks</div>
        <p className="text-sm text-[var(--muted)] leading-relaxed mb-4">
          Trailing NAV normalized to 100 alongside NIFTY 50 and Sensex on the
          same axis. Simulated buy-and-hold at current quantities, NOT realized
          P&L. Comparable on shape, not on absolute return.
        </p>
        <MultiLineChart
          series={series}
          visibleKeys={visible}
          normalize={true}
          height={360}
        />
      </div>

      {/* Sector + cap mix */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="section-num mb-3">Sector Spread</div>
          <WeightBars weights={sectorWeights} />
        </div>
        <div className="card p-5">
          <div className="section-num mb-3">Cap Mix</div>
          <WeightBars weights={capWeights} capitalizeLabels />
        </div>
      </div>

      {/* Holdings table */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-2">
          <div className="section-num mb-1 tracking-widest">HOLDINGS</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Live quantities, market value, weight in NAV.
          </p>
        </div>
        <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "14%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Qty</th>
              <th>Last close</th>
              <th>Market value</th>
              <th>Weight</th>
              <th>Sector / Cap</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.ticker} className="align-middle">
                <td className="font-medium whitespace-nowrap">{h.ticker.replace(/\.NS$/, "")}</td>
                <td className="num whitespace-nowrap">{h.qty.toLocaleString("en-IN")}</td>
                <td className="num whitespace-nowrap">{formatMoney(h.lastClose, h.ticker)}</td>
                <td className="num whitespace-nowrap">{formatMoney(h.marketValue, h.ticker)}</td>
                <td className="num whitespace-nowrap">{(h.weightPct || 0).toFixed(1)}%</td>
                <td className="text-[var(--muted)] text-sm whitespace-nowrap">
                  {h.sector} · <span className="capitalize">{h.cap}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edge verdict */}
      <div className="card p-5">
        <div className="section-num mb-2">Edge vs Market</div>
        <p className="text-base leading-relaxed">{edgeVerdict}</p>
      </div>

      {/* Red flags */}
      {redFlags.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Red Flags</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {redFlags.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Tips to raise score */}
      {tips.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Tips to Raise the Score</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {tips.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}


function WeightBars({
  weights,
  capitalizeLabels = false,
}: {
  weights: Record<string, number>;
  capitalizeLabels?: boolean;
}) {
  const entries = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <div className="text-sm text-[var(--muted)]">No weights to show.</div>;
  }
  return (
    <div className="space-y-1.5">
      {entries.map(([label, w]) => (
        <div key={label} className="flex items-center gap-3 text-sm">
          <div className={`w-24 font-medium ${capitalizeLabels ? "capitalize" : ""}`}>
            {label}
          </div>
          <div className="flex-1">
            <div
              aria-hidden
              className="rounded-r-full bg-[var(--muted)] opacity-60"
              style={{ width: `${Math.min(100, w)}%`, height: 8 }}
            />
          </div>
          <div className="num w-14 text-right">{w.toFixed(1)}%</div>
        </div>
      ))}
    </div>
  );
}

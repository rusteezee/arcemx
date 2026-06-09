"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { MultiLineChart, type Series } from "@/components/MultiLineChart";
import {
  buildPortfolioReport,
  type PortfolioReport,
} from "@/lib/portfolioScore";
import { formatMoney, formatPct } from "@/lib/utils";
import { sb } from "@/lib/supabase";

interface PortfolioLlm {
  thesis?: string;
  holding_takes?: Array<{ ticker: string; verdict: string; why: string }>;
  hedging_ideas?: string[];
  rebalance_actions?: string[];
  watchlist_additions?: Array<{ ticker: string; why: string }>;
  edge_verdict?: string;
}

type LlmStatus = "idle" | "queued" | "polling" | "ok" | "failed";

const BENCH_COLORS = {
  portfolio: "var(--foreground)",
  nifty:     "#3b82f6",
  sensex:    "#8b5cf6",
};

export function PortfolioScorecard() {
  const [report, setReport] = useState<PortfolioReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [llmStatus, setLlmStatus] = useState<LlmStatus>("idle");
  const [llmEnrichment, setLlmEnrichment] = useState<PortfolioLlm | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmRunId, setLlmRunId] = useState<number | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const askSensei = async () => {
    if (!report || llmStatus === "queued" || llmStatus === "polling") return;
    if (pollRef.current) clearInterval(pollRef.current);
    setLlmStatus("queued");
    setLlmError(null);
    setLlmEnrichment(null);
    try {
      const r = await fetch("/api/portfolio-score-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deterministic: report }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok || typeof data.run_id !== "number") {
        setLlmStatus("failed");
        setLlmError(data?.error || `bot returned ${r.status}`);
        return;
      }
      setLlmRunId(data.run_id);
      setLlmStatus("polling");
      pollEnrichment(data.run_id);
    } catch (e: any) {
      setLlmStatus("failed");
      setLlmError(e?.message || "network error");
    }
  };

  const pollEnrichment = (runId: number) => {
    const start = Date.now();
    const MAX_MS = 25 * 60_000;
    const fetchOnce = async () => {
      try {
        const { data, error } = await sb
          .from("portfolio_score_runs")
          .select("status,llm_json,error")
          .eq("id", runId)
          .limit(1);
        if (error) throw error;
        const row = (data || [])[0];
        if (!row) return;
        if (row.status === "ok") {
          setLlmEnrichment((row.llm_json || {}) as PortfolioLlm);
          setLlmStatus("ok");
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (row.status === "failed") {
          setLlmStatus("failed");
          setLlmError(row.error || "LLM call failed");
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (Date.now() - start > MAX_MS) {
          setLlmStatus("failed");
          setLlmError("LLM call timed out after 25 minutes");
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (e: any) {
        console.warn("Portfolio poll error:", e?.message || e);
      }
    };
    fetchOnce();
    pollRef.current = setInterval(fetchOnce, 4000);
  };

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

  const takeByTicker: Record<string, { verdict: string; why: string }> = {};
  for (const t of llmEnrichment?.holding_takes || []) {
    if (t.ticker) takeByTicker[t.ticker] = { verdict: t.verdict, why: t.why };
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-5"
    >
      {/* Ask Sensei: triggers LLM enrichment over the deterministic report. */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[16rem]">
            <div className="section-num mb-1">Sensei's Layer</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Ask Sensei for per-holding verdicts (hold / add / trim / exit),
              hedging ideas, concrete rebalance actions, and watchlist
              additions to plug gaps in the sector / cap mix. Free-tier LLM
              calls land in 3-12 minutes.
            </p>
          </div>
          <button
            type="button"
            onClick={askSensei}
            disabled={llmStatus === "queued" || llmStatus === "polling"}
            className="px-5 py-2 text-sm font-medium rounded-full border border-foreground bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {llmStatus === "queued" && "Queueing"}
            {llmStatus === "polling" && "Sensei thinking"}
            {llmStatus === "ok" && "Re-run Sensei"}
            {llmStatus === "failed" && "Retry"}
            {llmStatus === "idle" && "Ask Sensei"}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {(llmStatus === "polling" || llmStatus === "queued") && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <span>
                Polling portfolio_score_runs id {llmRunId ?? "·"}. The row
                updates when the LLM returns.
              </span>
            </motion.div>
          )}
          {llmStatus === "failed" && llmError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 text-sm text-[var(--loss)]"
            >
              {llmError}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {llmEnrichment?.thesis && (
        <div className="card p-5">
          <div className="section-num mb-2">Sensei's Thesis</div>
          <p className="text-base leading-relaxed">{llmEnrichment.thesis}</p>
        </div>
      )}

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
            <col style={{ width: "12%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "10%" }} />
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
              <th>Verdict</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const take = takeByTicker[h.ticker];
              return (
                <tr key={h.ticker} className="align-top">
                  <td className="font-medium whitespace-nowrap align-top">{h.ticker.replace(/\.NS$/, "")}</td>
                  <td className="num whitespace-nowrap align-top">{h.qty.toLocaleString("en-IN")}</td>
                  <td className="num whitespace-nowrap align-top">{formatMoney(h.lastClose, h.ticker)}</td>
                  <td className="num whitespace-nowrap align-top">{formatMoney(h.marketValue, h.ticker)}</td>
                  <td className="num whitespace-nowrap align-top">{(h.weightPct || 0).toFixed(1)}%</td>
                  <td className="text-[var(--muted)] text-sm whitespace-nowrap align-top">
                    {h.sector} · <span className="capitalize">{h.cap}</span>
                  </td>
                  <td className="whitespace-nowrap align-top">
                    {take ? <VerdictPill v={take.verdict} /> : <span className="text-[var(--muted)]">·</span>}
                  </td>
                  <td
                    className="text-[var(--muted)] text-sm align-top"
                    style={{ whiteSpace: "normal", wordBreak: "break-word" }}
                  >
                    {take?.why || "·"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Edge verdict */}
      <div className="card p-5">
        <div className="section-num mb-2">Edge vs Market</div>
        <p className="text-base leading-relaxed">{edgeVerdict}</p>
        {llmEnrichment?.edge_verdict && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="text-[var(--muted)] text-[0.7rem] uppercase tracking-wider mb-1">
              Sensei
            </div>
            <p className="text-sm leading-relaxed">{llmEnrichment.edge_verdict}</p>
          </div>
        )}
      </div>

      {llmEnrichment?.rebalance_actions && llmEnrichment.rebalance_actions.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Rebalance Actions</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {llmEnrichment.rebalance_actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {llmEnrichment?.hedging_ideas && llmEnrichment.hedging_ideas.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Hedging Ideas</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {llmEnrichment.hedging_ideas.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      )}

      {llmEnrichment?.watchlist_additions && llmEnrichment.watchlist_additions.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Add to Watchlist</div>
          <ul className="space-y-2 text-sm">
            {llmEnrichment.watchlist_additions.map((w, i) => (
              <li key={i} className="flex items-baseline gap-3 flex-wrap">
                <span className="font-medium">{(w.ticker || "").replace(/\.NS$/, "")}</span>
                <span className="text-[var(--muted)]">{w.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

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


function VerdictPill({ v }: { v: string }) {
  const u = (v || "").toLowerCase();
  const map: Record<string, string> = {
    hold: "pill-warn",
    add: "pill-gain",
    trim: "pill-warn",
    exit: "pill-loss",
  };
  return (
    <span className={`pill ${map[u] || ""}`} style={{ minWidth: 56, justifyContent: "center" }}>
      {u ? u.toUpperCase() : "·"}
    </span>
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

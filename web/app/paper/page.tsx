"use client";

import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { sb } from "@/lib/supabase";
import { formatINR, formatPct, stripTicker } from "@/lib/utils";
import {
  computePaperMetrics,
  perDimSkillByWindow,
  skillCellStyle,
  type PaperMetrics,
  type DimSkillByWindow,
  type PredictionScoreRow,
} from "@/lib/metrics";

interface PaperTrade {
  id: number;
  source_kind: string;
  source_run_id: number | null;
  ticker: string;
  side: string;
  entered_at: string;
  intent_px: number | null;
  fill_px: number | null;
  qty: number | null;
  target_px: number | null;
  stop_px: number | null;
  horizon_days: number | null;
  exit_at: string | null;
  exit_px: number | null;
  exit_reason: string | null;
  gross_pnl: number | null;
  slippage_cost: number | null;
  brokerage: number | null;
  stt: number | null;
  net_pnl: number | null;
  confidence: number | null;
  expected_edge_pct: number | null;
  status: string;
  meta: any;
}

interface PaperSignal {
  id: number;
  evaluated_at: string;
  ticker: string;
  source_kind: string;
  source_run_id: number | null;
  action: string;
  skip_reason: string | null;
  paper_trade_id: number | null;
  confidence: number | null;
  expected_edge_pct: number | null;
  meta: any;
}

const SKIP_LABEL: Record<string, string> = {
  not_buy: "Not buy",
  low_conf: "Low confidence",
  low_edge: "Low expected edge",
  already_open: "Already open",
  no_intent_px: "Missing entry price",
  no_target_stop: "Missing target / stop",
  bad_risk: "Bad risk geometry",
  no_liquidity_data: "No liquidity data",
  liquidity: "Below liquidity floor",
  sector_cap: "Sector cap hit",
  insert_failed: "Insert failed",
};

const EXIT_LABEL: Record<string, string> = {
  target: "Target hit",
  stop: "Stop hit",
  horizon: "Horizon",
};

function humaniseSkip(s: string | null): string {
  if (!s) return "·";
  return SKIP_LABEL[s] || s.replace(/_/g, " ");
}

function humaniseExit(s: string | null): string {
  if (!s) return "·";
  return EXIT_LABEL[s] || s.replace(/_/g, " ");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "·";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "2-digit",
  });
}

export default function PaperPage() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [signals, setSignals] = useState<PaperSignal[]>([]);
  const [predScores, setPredScores] = useState<PredictionScoreRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const since14 = new Date(Date.now() - 14 * 86400_000).toISOString();
      const since90 = new Date(Date.now() - 90 * 86400_000).toISOString();
      const [tRes, sRes, pRes] = await Promise.all([
        sb.from("paper_trades").select("*").order("entered_at", { ascending: false }).limit(500),
        sb.from("paper_signals").select("*").gte("evaluated_at", since14).order("evaluated_at", { ascending: false }).limit(500),
        sb.from("prediction_scores").select("dimension,score,scored_at").gte("scored_at", since90).limit(5000),
      ]);
      setTrades((tRes.data || []) as PaperTrade[]);
      setSignals((sRes.data || []) as PaperSignal[]);
      setPredScores((pRes.data || []) as PredictionScoreRow[]);
      setLoading(false);
    })();
  }, []);

  const open = useMemo(() => trades.filter((t) => t.status === "open"), [trades]);
  const closed = useMemo(() => trades.filter((t) => t.status !== "open"), [trades]);
  const metrics: PaperMetrics = useMemo(
    () => computePaperMetrics(closed.map((t) => ({ exit_at: t.exit_at, net_pnl: t.net_pnl }))),
    [closed],
  );
  const dimHeatmap: DimSkillByWindow[] = useMemo(
    () => perDimSkillByWindow(predScores, [7, 30, 90]),
    [predScores],
  );

  const totalNetPnl = closed.reduce((s, t) => s + (t.net_pnl || 0), 0);
  const totalGrossPnl = closed.reduce((s, t) => s + (t.gross_pnl || 0), 0);
  const totalFriction = closed.reduce(
    (s, t) => s + (t.brokerage || 0) + (t.stt || 0) + (t.slippage_cost || 0),
    0,
  );
  const wins = closed.filter((t) => (t.net_pnl || 0) > 0).length;
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;
  const avgNet = closed.length ? totalNetPnl / closed.length : 0;

  const skipCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of signals) {
      if (s.action === "skip" && s.skip_reason) {
        m.set(s.skip_reason, (m.get(s.skip_reason) || 0) + 1);
      }
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [signals]);
  const enteredCount = signals.filter((s) => s.action === "enter").length;
  const totalEvaluated = signals.length;

  if (loading) {
    return (
      <div className="card p-10 text-center text-sm text-[var(--muted)]">
        Loading paper trader state.
      </div>
    );
  }

  if (!trades.length && !signals.length) {
    return (
      <>
        <div className="mb-12">
          <div className="section-num mb-2">000 · Paper Trader</div>
          <h1 className="headline mb-3">
            Phase A <span className="italic">Friction-Modeled Simulation.</span>
          </h1>
        </div>
        <EmptyState
          title="No paper trader activity yet."
          hint="Trigger a Stock Analyst pass with expected_edge_pct populated, then wait for the next 17:00 IST grader. Paper trader runs after grading."
        />
      </>
    );
  }

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Paper Trader</div>
        <h1 className="headline mb-3">
          Phase A <span className="italic">Friction-Modeled Simulation.</span>
        </h1>
        <p className="sub-headline max-w-2xl">
          Live simulation of every Stock Analyst buy signal that clears the gate
          stack. Entries at next-session open with modeled slippage. Exits at
          target / stop / horizon with full INDstocks friction. No real money.
        </p>
      </div>

      <Section num="001 / 006" title="Realised P&L" glyph="✦">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Open Positions" value={open.length.toString()} />
          <Stat label="Closed Trades" value={closed.length.toString()} />
          <Stat
            label="Net P&L"
            value={
              closed.length
                ? `${totalNetPnl >= 0 ? "+" : ""}${formatINR(totalNetPnl, true)}`
                : "·"
            }
            deltaPositive={totalNetPnl >= 0}
          />
          <Stat
            label="Win Rate"
            value={closed.length ? formatPct(winRate, false) : "·"}
          />
        </div>
        {closed.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            <Stat
              label="Gross P&L"
              value={`${totalGrossPnl >= 0 ? "+" : ""}${formatINR(totalGrossPnl, true)}`}
              deltaPositive={totalGrossPnl >= 0}
            />
            <Stat
              label="Friction Paid"
              value={formatINR(totalFriction, true)}
            />
            <Stat
              label="Avg Net per Trade"
              value={`${avgNet >= 0 ? "+" : ""}${formatINR(avgNet, true)}`}
              deltaPositive={avgNet >= 0}
            />
          </div>
        )}
      </Section>

      <Section
        num="002 / 006"
        title="Edge Metrics"
        glyph="◇"
        description="Sharpe, max drawdown, and Probabilistic Sharpe (Bailey-Lopez de Prado, skew + kurt adjusted). PSR is the probability the true Sharpe exceeds zero given the sample. Risk-free leg = 6.5% RBI repo proxy."
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat
            label="Sharpe (ann.)"
            value={metrics.tradeCount ? metrics.sharpe.toFixed(2) : "·"}
            deltaPositive={metrics.sharpe >= 1.0}
          />
          <Stat
            label="Max Drawdown"
            value={metrics.tradeCount ? formatPct(metrics.maxDd.maxDdPct, false) : "·"}
            deltaPositive={metrics.maxDd.maxDdPct <= 15.0}
          />
          <Stat
            label="PSR"
            value={metrics.tradeCount >= 4 ? metrics.psr.toFixed(3) : "·"}
            deltaPositive={metrics.psr >= 0.95}
          />
          <Stat
            label="Calmar"
            value={metrics.tradeCount ? metrics.calmar.toFixed(2) : "·"}
          />
        </div>
        <div className="card overflow-hidden mt-5">
          <div className="px-5 py-4 border-b border-border">
            <div className="text-sm font-medium">Tier Ladder</div>
            <div className="text-xs text-[var(--muted)] mt-1">
              Cleared tier: {metrics.tierEval.clearedTier}. Next: T{metrics.tierEval.nextTier} ({metrics.tierEval.nextLabel}).
              Every gate must pass simultaneously. A failed gate diagnoses + iterates, never kills.
            </div>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Label</th>
                  <th>Sharpe ≥</th>
                  <th>Max DD ≤</th>
                  <th>PSR ≥</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { tier: 1, sharpe: 1.0, maxDdPct: 15.0, psr: 0.95, label: "Phase B unlock" },
                  { tier: 2, sharpe: 1.3, maxDdPct: 12.0, psr: 0.97, label: "Phase C unlock" },
                  { tier: 3, sharpe: 1.6, maxDdPct: 10.0, psr: 0.99, label: "Hardening" },
                  { tier: 4, sharpe: 2.0, maxDdPct: 8.0,  psr: 0.995, label: "Peak (2028)" },
                ].map((g) => {
                  const cleared = metrics.tierEval.clearedTier >= g.tier;
                  const isNext = metrics.tierEval.nextTier === g.tier && !cleared;
                  return (
                    <tr key={g.tier}>
                      <td className="num font-medium">T{g.tier}</td>
                      <td className="whitespace-nowrap">{g.label}</td>
                      <td className="num">{g.sharpe.toFixed(1)}</td>
                      <td className="num">{g.maxDdPct.toFixed(0)}%</td>
                      <td className="num">{g.psr.toFixed(3)}</td>
                      <td className={`whitespace-nowrap ${cleared ? "text-[var(--gain)]" : isNext ? "text-[var(--warn)]" : "text-[var(--muted)]"}`}>
                        {cleared ? "CLEARED" : isNext ? "ACTIVE" : "LOCKED"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section num="003 / 006" title="Open Positions" glyph="◈">
        {open.length === 0 ? (
          <EmptyState
            title="No open paper positions"
            hint="Next 17:00 IST grader run will evaluate fresh signals."
          />
        ) : (
          <div className="card overflow-hidden">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Entered</th>
                    <th>Qty</th>
                    <th>Fill</th>
                    <th>Target</th>
                    <th>Stop</th>
                    <th>Horizon</th>
                    <th>Conf</th>
                    <th>Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((t) => (
                    <tr key={t.id}>
                      <td className="font-medium whitespace-nowrap">{stripTicker(t.ticker)}</td>
                      <td className="whitespace-nowrap">{fmtDate(t.entered_at)}</td>
                      <td className="num">{t.qty ?? "·"}</td>
                      <td className="num whitespace-nowrap">{t.fill_px != null ? formatINR(t.fill_px) : "·"}</td>
                      <td className="num whitespace-nowrap text-[var(--gain)]">{t.target_px != null ? formatINR(t.target_px) : "·"}</td>
                      <td className="num whitespace-nowrap text-[var(--loss)]">{t.stop_px != null ? formatINR(t.stop_px) : "·"}</td>
                      <td className="num">{t.horizon_days ?? "·"}d</td>
                      <td className="num">{t.confidence ?? "·"}</td>
                      <td className="num whitespace-nowrap">{t.expected_edge_pct != null ? formatPct(t.expected_edge_pct) : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section num="004 / 006" title="Closed Trades" glyph="⬡">
        {closed.length === 0 ? (
          <EmptyState
            title="No closed trades yet"
            hint="Trades close when price hits target, stop, or horizon expiry."
          />
        ) : (
          <div className="card overflow-hidden">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Entered</th>
                    <th>Exited</th>
                    <th>Reason</th>
                    <th>Qty</th>
                    <th>Fill</th>
                    <th>Exit</th>
                    <th>Gross P&L</th>
                    <th>Friction</th>
                    <th>Net P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((t) => {
                    const friction = (t.brokerage || 0) + (t.stt || 0) + (t.slippage_cost || 0);
                    const net = t.net_pnl || 0;
                    return (
                      <tr key={t.id}>
                        <td className="font-medium whitespace-nowrap">{stripTicker(t.ticker)}</td>
                        <td className="whitespace-nowrap">{fmtDate(t.entered_at)}</td>
                        <td className="whitespace-nowrap">{fmtDate(t.exit_at)}</td>
                        <td className="whitespace-nowrap">{humaniseExit(t.exit_reason)}</td>
                        <td className="num">{t.qty ?? "·"}</td>
                        <td className="num whitespace-nowrap">{t.fill_px != null ? formatINR(t.fill_px) : "·"}</td>
                        <td className="num whitespace-nowrap">{t.exit_px != null ? formatINR(t.exit_px) : "·"}</td>
                        <td className={`num whitespace-nowrap ${(t.gross_pnl || 0) >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {(t.gross_pnl || 0) >= 0 ? "+" : ""}{formatINR(t.gross_pnl)}
                        </td>
                        <td className="num whitespace-nowrap text-[var(--muted)]">{formatINR(friction)}</td>
                        <td className={`num font-medium whitespace-nowrap ${net >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
                          {net >= 0 ? "+" : ""}{formatINR(net)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section
        num="005 / 006"
        title="Per-Dim Skill Heatmap"
        glyph="◉"
        description="Skill ratio = (mean accuracy - 50) / stdev. Above 1.0 = dim's accuracy distribution sits comfortably above coin-flip noise. Below 0 = worse than guessing. Cells colored by skill: green = positive, red = negative, intensity tracks magnitude. Reading across rows shows whether a dim's skill is improving or decaying. Low-sample cells (<5) shown as dim text."
      >
        {dimHeatmap.length === 0 ? (
          <EmptyState
            title="No graded predictions in window"
            hint="Grader has not produced scores in the last 90 days."
          />
        ) : (
          <div className="card overflow-hidden">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Dimension</th>
                    <th>7d skill (n)</th>
                    <th>30d skill (n)</th>
                    <th>90d skill (n)</th>
                  </tr>
                </thead>
                <tbody>
                  {dimHeatmap.map((d) => (
                    <tr key={d.dimension}>
                      <td className="whitespace-nowrap font-medium">{d.dimension}</td>
                      {[7, 30, 90].map((w) => {
                        const cell = d.byWindow[w];
                        const skill = cell?.skillRatio ?? null;
                        const style = skillCellStyle(skill);
                        return (
                          <td
                            key={w}
                            className="num whitespace-nowrap"
                            style={style}
                          >
                            {cell && cell.sampleSize > 0 ? (
                              <span className={cell.lowSample ? "text-[var(--muted)]" : ""}>
                                {cell.skillRatio.toFixed(2)} <span className="text-xs text-[var(--muted)]">({cell.sampleSize})</span>
                              </span>
                            ) : (
                              <span className="text-[var(--muted)]">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section
        num="006 / 006"
        title="Signal Activity"
        glyph="◐"
        description="Last 14 days. Every Stock Analyst buy is logged here even when skipped, so gate stack attribution stays computable."
      >
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
          <Stat label="Signals Evaluated" value={totalEvaluated.toString()} />
          <Stat label="Entered" value={enteredCount.toString()} />
          <Stat
            label="Entry Rate"
            value={totalEvaluated ? formatPct((enteredCount / totalEvaluated) * 100, false) : "·"}
          />
        </div>
        {skipCounts.length > 0 && (
          <div className="card overflow-hidden mb-5">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Skip Reason</th>
                    <th>Count</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {skipCounts.map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{humaniseSkip(reason)}</td>
                      <td className="num">{count}</td>
                      <td className="num">{formatPct((count / totalEvaluated) * 100, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {signals.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Ticker</th>
                    <th>Action</th>
                    <th>Reason</th>
                    <th>Conf</th>
                    <th>Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.slice(0, 50).map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">{fmtDate(s.evaluated_at)}</td>
                      <td className="font-medium whitespace-nowrap">{stripTicker(s.ticker)}</td>
                      <td className={`whitespace-nowrap ${s.action === "enter" ? "text-[var(--gain)]" : "text-[var(--muted)]"}`}>
                        {s.action.toUpperCase()}
                      </td>
                      <td className="whitespace-nowrap">{s.action === "enter" ? "·" : humaniseSkip(s.skip_reason)}</td>
                      <td className="num">{s.confidence ?? "·"}</td>
                      <td className="num whitespace-nowrap">{s.expected_edge_pct != null ? formatPct(s.expected_edge_pct) : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title="No signals yet"
            hint="Paper trader logs every Stock Analyst run here."
          />
        )}
      </Section>
    </>
  );
}

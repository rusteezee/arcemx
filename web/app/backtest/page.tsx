"use client";

import { useEffect, useRef, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { MultiLineChart, type Series } from "@/components/MultiLineChart";
import { sb } from "@/lib/supabase";
import { formatINR, formatPct, stripTicker } from "@/lib/utils";

interface BacktestTrade {
  ticker: string;
  source_kind: string;
  entered_at: string;
  exit_at: string | null;
  exit_reason: string | null;
  qty: number;
  fill_px: number;
  exit_px: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
}

interface DsrBundle {
  dsr: number;
  sr_star_annual: number;
  n_trials: number;
  degenerate: boolean;
}

interface PboBundle {
  pbo: number;
  combos: number;
  grid: number[];
}

interface BacktestResults {
  portfolio_base: number;
  compounding?: boolean;
  replay_window: { from: string; to: string };
  counts: { evaluated: number; entered: number };
  skips: Record<string, number>;
  still_open: number;
  trade_count: number;
  win_rate_pct: number;
  span_days: number;
  total_net_pnl: number;
  annual_return_pct: number;
  sharpe: number;
  max_drawdown: { max_dd_pct: number; peak_at: string | null; trough_at: string | null };
  calmar: number;
  psr: number;
  // dsr/pbo/compounded fields are absent on backtest_runs rows saved
  // before blueprint 10 - always optional-chain these, never assume
  // they exist just because trade_count > 0.
  dsr?: DsrBundle;
  pbo?: PboBundle | null;
  compounded_final_equity?: number;
  simple_total_net_pnl?: number;
  tier_eval: { cleared_tier: number; next_tier: number; next_label: string };
  equity_curve: [string, number][];
  trades: BacktestTrade[];
}

interface BacktestRun {
  id: number;
  run_at: string;
  status: "pending" | "ok" | "failed";
  error: string | null;
  trade_count: number;
  win_rate_pct: number | null;
  sharpe: number | null;
  max_dd_pct: number | null;
  calmar: number | null;
  psr: number | null;
  total_net_pnl: number | null;
  annual_return_pct: number | null;
  results: BacktestResults | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "·";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

export default function BacktestPage() {
  const [run, setRun] = useState<BacktestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLatest = async () => {
    const { data } = await sb.from("backtest_runs").select("*").order("id", { ascending: false }).limit(1);
    setRun((data?.[0] as BacktestRun) || null);
    setLoading(false);
  };

  useEffect(() => {
    loadLatest();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const pollUntilDone = (runId: number) => {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const { data } = await sb.from("backtest_runs").select("*").eq("id", runId).limit(1);
      const row = (data?.[0] as BacktestRun) || null;
      if (row) setRun(row);
      if (row && row.status !== "pending") {
        setTriggering(false);
        setTriggerMsg(row.status === "failed" ? row.error || "Replay failed" : null);
        return;
      }
      // No LLM call in this pipeline - a stalled runner is the only way
      // this drags past a couple minutes. 150 * 2.5s = ~6.25min cap.
      if (attempts >= 150) {
        setTriggering(false);
        setTriggerMsg("Timed out waiting for the replay");
        return;
      }
      pollTimer.current = setTimeout(tick, 2500);
    };
    tick();
  };

  const triggerRun = async () => {
    setTriggering(true);
    setTriggerMsg("Dispatching replay");
    try {
      const r = await fetch("/api/backtest", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setTriggering(false);
        setTriggerMsg(j?.error || j?.detail || `dispatch returned ${r.status}`);
        return;
      }
      setTriggerMsg("Replaying full analysis history");
      pollUntilDone(j.run_id);
    } catch (e: any) {
      setTriggering(false);
      setTriggerMsg(String(e?.message || e));
    }
  };

  const runButton = (
    <button className="btn-ghost" onClick={triggerRun} disabled={triggering}>
      {triggering ? "Running..." : "Run New Backtest"}
    </button>
  );

  if (loading) {
    return <div className="card p-10 text-center text-sm text-[var(--muted)]">Loading backtest state.</div>;
  }

  const results = run?.status === "ok" ? run.results : null;

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Backtest</div>
        <h1 className="headline mb-3">
          Full History <span className="italic">Replay.</span>
        </h1>
        <p className="sub-headline max-w-2xl">
          Replays every analysis this project has ever produced through the
          live paper trader&apos;s exact gate stack, as if it had been running
          since day one. Same thresholds, same friction model, no LLM cost -
          pure historical yfinance data walked chronologically. Answers: would
          following every signal have made money?
        </p>
      </div>

      <Section num="001 / 003" title="Run" glyph="✦" action={runButton}>
        {!run ? (
          <EmptyState title="No backtest run yet" hint="Click Run New Backtest to replay the full analysis history." />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Status" value={run.status.toUpperCase()} deltaPositive={run.status === "ok"} />
            <Stat label="Last Run" value={fmtDate(run.run_at)} />
            <Stat label="Trades" value={run.trade_count?.toString() ?? "·"} />
            <Stat
              label="Win Rate"
              value={run.win_rate_pct != null ? formatPct(run.win_rate_pct, false) : "·"}
            />
          </div>
        )}
        {triggerMsg && (
          <div className="text-xs text-[var(--muted)] mt-3">{triggerMsg}</div>
        )}
        {run?.status === "failed" && run.error && (
          <div className="text-xs text-[var(--loss)] mt-3">{run.error}</div>
        )}
      </Section>

      {!results ? (
        <Section num="002 / 003" title="Results" glyph="⬡">
          <EmptyState
            title={run?.status === "pending" ? "Replay in progress" : "No results yet"}
            hint={run?.status === "pending" ? "Usually finishes in under a minute." : "Run a backtest to see results here."}
          />
        </Section>
      ) : (
        <>
          <Section
            num="002 / 003"
            title="Edge Metrics"
            glyph="◇"
            description={`Replay window: ${fmtDate(results.replay_window.from)} to ${fmtDate(results.replay_window.to)}. ${results.counts.evaluated} signals evaluated across the full history, ${results.counts.entered} entered, ${results.still_open} still open (horizon not yet reached).`}
          >
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Stat
                label="Sharpe (ann.)"
                value={results.trade_count ? results.sharpe.toFixed(2) : "·"}
                deltaPositive={results.sharpe >= 1.0}
              />
              <Stat
                label="Max Drawdown"
                value={results.trade_count ? formatPct(results.max_drawdown.max_dd_pct, false) : "·"}
                deltaPositive={results.max_drawdown.max_dd_pct <= 15.0}
              />
              <Stat
                label="PSR"
                value={results.trade_count >= 4 ? results.psr.toFixed(3) : "·"}
                deltaPositive={results.psr >= 0.95}
              />
              <Stat label="Calmar" value={results.trade_count ? results.calmar.toFixed(2) : "·"} />
              <Stat
                label="DSR"
                value={results.dsr ? results.dsr.dsr.toFixed(3) : "n/a"}
                deltaPositive={results.dsr ? results.dsr.dsr >= 0.90 : undefined}
              />
              <Stat
                label="PBO"
                value={results.pbo ? results.pbo.pbo.toFixed(3) : "n/a"}
                deltaPositive={results.pbo ? results.pbo.pbo <= 0.30 : undefined}
              />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
              <Stat
                label="Net P&L"
                value={`${results.total_net_pnl >= 0 ? "+" : ""}${formatINR(results.total_net_pnl, true)}`}
                deltaPositive={results.total_net_pnl >= 0}
              />
              <Stat
                label="Annual Return"
                value={formatPct(results.annual_return_pct, false)}
                deltaPositive={results.annual_return_pct >= 0}
              />
              <Stat label="Win Rate" value={formatPct(results.win_rate_pct, false)} />
              <Stat label="Cleared Tier" value={`T${results.tier_eval.cleared_tier}`} deltaPositive={results.tier_eval.cleared_tier >= 1} />
            </div>
          </Section>

          <Section
            num="002b / 003"
            title="Equity Curve"
            glyph="⬡"
            description="Cumulative net P&L across every closed shadow trade in the replay, in exit-date order."
          >
            {results.equity_curve.length === 0 ? (
              <EmptyState title="No closed trades in this replay" />
            ) : (
              <div className="card p-6">
                <MultiLineChart
                  series={[{
                    key: "backtest",
                    label: "Backtest Equity",
                    color: "var(--foreground)",
                    points: results.equity_curve.map(([date, cum]) => ({
                      date, value: results.portfolio_base + cum,
                    })),
                  }] as Series[]}
                  visibleKeys={new Set(["backtest"])}
                  normalize
                  height={300}
                />
              </div>
            )}
          </Section>

          <Section num="003 / 003" title="Trades" glyph="◈">
            {results.trades.length === 0 ? (
              <EmptyState title="No trades entered in this replay" />
            ) : (
              <div className="card overflow-hidden">
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th>Source</th>
                        <th>Entered</th>
                        <th>Exited</th>
                        <th>Reason</th>
                        <th>Qty</th>
                        <th>Fill</th>
                        <th>Exit</th>
                        <th>Net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.trades.map((t, i) => {
                        const net = t.net_pnl || 0;
                        return (
                          <tr key={i}>
                            <td className="font-medium whitespace-nowrap">{stripTicker(t.ticker)}</td>
                            <td className="whitespace-nowrap text-[var(--muted)]">{t.source_kind}</td>
                            <td className="whitespace-nowrap">{fmtDate(t.entered_at)}</td>
                            <td className="whitespace-nowrap">{fmtDate(t.exit_at)}</td>
                            <td className="whitespace-nowrap">{t.exit_reason || "·"}</td>
                            <td className="num">{t.qty}</td>
                            <td className="num whitespace-nowrap">{formatINR(t.fill_px)}</td>
                            <td className="num whitespace-nowrap">{t.exit_px != null ? formatINR(t.exit_px) : "·"}</td>
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
        </>
      )}
    </>
  );
}

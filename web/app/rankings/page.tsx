"use client";

import { useEffect, useMemo, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { sb } from "@/lib/supabase";

interface EnsembleAttempt {
  id: number;
  analysis_id: number | null;
  model_slug: string;
  status: string;
  latency_ms: number | null;
  error_snippet: string | null;
  attempted_at: string;
}

interface AnalysisRow {
  id: number;
  run_at: string;
  raw_json: any;
}

interface PredictionScoreRow {
  id: number;
  analysis_id: number | null;
  dimension: string;
  horizon_days: number;
  score: number;
  scored_at: string;
}

interface ModelRow {
  slug: string;
  short: string;
  lab: string;
  attempts: number;
  ok: number;
  http_400: number;
  http_429: number;
  empty: number;
  timeout: number;
  other: number;
  usable_pct: number;
  avg_latency_ms: number | null;
  consensus_agreement_pct: number | null;
  solo_correct: number;
  solo_wrong: number;
  appearances: number;
}

const LAB_FROM_SLUG = (slug: string): { lab: string; short: string } => {
  const s = slug.toLowerCase();
  if (s.startsWith("nvidia/")) return { lab: "NVIDIA", short: slug.replace("nvidia/", "").replace(":free", "") };
  if (s.startsWith("openai/")) return { lab: "OpenAI", short: slug.replace("openai/", "").replace(":free", "") };
  if (s.startsWith("google/")) return { lab: "Google", short: slug.replace("google/", "").replace(":free", "") };
  if (s.startsWith("qwen/")) return { lab: "Alibaba", short: slug.replace("qwen/", "").replace(":free", "") };
  if (s.startsWith("meta-llama/")) return { lab: "Meta", short: slug.replace("meta-llama/", "").replace(":free", "") };
  if (s.startsWith("nousresearch/")) return { lab: "Nous", short: slug.replace("nousresearch/", "").replace(":free", "") };
  const slash = slug.indexOf("/");
  const lab = slash > 0 ? slug.slice(0, slash) : "?";
  const short = slug.replace(":free", "");
  return { lab, short };
};

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  http_400: "400 Bad Req",
  http_429: "429 Rate Lim",
  empty: "Empty body",
  timeout: "Timeout",
  other: "Other",
};

function pctBar(pct: number, tone: "good" | "bad" = "good") {
  const color =
    tone === "good"
      ? "var(--gain)"
      : "var(--loss)";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--muted-bg)] overflow-hidden">
        <div
          className="h-full"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
        />
      </div>
      <span className="num text-xs w-10 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function RankingsPage() {
  const [attempts, setAttempts] = useState<EnsembleAttempt[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisRow[]>([]);
  const [scores, setScores] = useState<PredictionScoreRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [att, an, ps] = await Promise.all([
        sb
          .from("ensemble_attempts")
          .select("id,analysis_id,model_slug,status,latency_ms,error_snippet,attempted_at")
          .order("attempted_at", { ascending: false })
          .limit(2000),
        sb
          .from("analysis")
          .select("id,run_at,raw_json")
          .order("run_at", { ascending: false })
          .limit(60),
        sb
          .from("prediction_scores")
          .select("id,analysis_id,dimension,horizon_days,score,scored_at")
          .order("scored_at", { ascending: false })
          .limit(2000),
      ]);
      if (cancelled) return;
      setAttempts((att.data as EnsembleAttempt[]) || []);
      setAnalyses((an.data as AnalysisRow[]) || []);
      setScores((ps.data as PredictionScoreRow[]) || []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build per-model row from attempts + per_model_votes consensus diff
  const modelRows = useMemo<ModelRow[]>(() => {
    const byModel = new Map<string, ModelRow>();
    const ensureRow = (slug: string): ModelRow => {
      let r = byModel.get(slug);
      if (!r) {
        const { lab, short } = LAB_FROM_SLUG(slug);
        r = {
          slug,
          short,
          lab,
          attempts: 0,
          ok: 0,
          http_400: 0,
          http_429: 0,
          empty: 0,
          timeout: 0,
          other: 0,
          usable_pct: 0,
          avg_latency_ms: null,
          consensus_agreement_pct: null,
          solo_correct: 0,
          solo_wrong: 0,
          appearances: 0,
        };
        byModel.set(slug, r);
      }
      return r;
    };

    const latencySum = new Map<string, { sum: number; n: number }>();

    for (const a of attempts) {
      const r = ensureRow(a.model_slug);
      r.attempts += 1;
      const bucket = (r as any)[a.status];
      if (typeof bucket === "number") (r as any)[a.status] = bucket + 1;
      if (a.status === "ok" && a.latency_ms != null) {
        const cur = latencySum.get(a.model_slug) || { sum: 0, n: 0 };
        cur.sum += a.latency_ms;
        cur.n += 1;
        latencySum.set(a.model_slug, cur);
      }
    }

    // Consensus agreement: for each analysis with per_model_votes, compare
    // each model's nifty_dir + sensex_dir + market_mood vs the merged
    // consensus call. Agreement = matched / votable.
    const agreeStats = new Map<string, { match: number; total: number }>();
    for (const an of analyses) {
      const raw = an.raw_json || {};
      const votes = raw.per_model_votes;
      if (!votes || typeof votes !== "object") continue;
      const consensus = {
        market_mood: raw.market_mood,
        nifty_dir: raw?.nifty_outlook?.direction,
        sensex_dir: raw?.sensex_outlook?.direction,
      };
      for (const [slug, v] of Object.entries(votes)) {
        if (slug === "unknown") continue;
        const vv: any = v;
        ensureRow(slug).appearances += 1;
        const s = agreeStats.get(slug) || { match: 0, total: 0 };
        for (const k of ["market_mood", "nifty_dir", "sensex_dir"] as const) {
          if (vv[k] && (consensus as any)[k]) {
            s.total += 1;
            if (
              String(vv[k]).toLowerCase() === String((consensus as any)[k]).toLowerCase()
            )
              s.match += 1;
          }
        }
        agreeStats.set(slug, s);
      }
    }

    // Finalize derived fields
    for (const r of byModel.values()) {
      r.usable_pct = r.attempts > 0 ? (r.ok / r.attempts) * 100 : 0;
      const lat = latencySum.get(r.slug);
      r.avg_latency_ms = lat && lat.n > 0 ? Math.round(lat.sum / lat.n) : null;
      const ag = agreeStats.get(r.slug);
      r.consensus_agreement_pct = ag && ag.total > 0 ? (ag.match / ag.total) * 100 : null;
    }

    return Array.from(byModel.values()).sort((a, b) => {
      const ascore = a.usable_pct * (a.consensus_agreement_pct ?? 50) / 100;
      const bscore = b.usable_pct * (b.consensus_agreement_pct ?? 50) / 100;
      return bscore - ascore;
    });
  }, [attempts, analyses]);

  // Per-dim improvement: rolling skill (mean score) 7d vs 30d vs 90d
  const dimTrends = useMemo(() => {
    const now = Date.now();
    const buckets: Record<string, { d7: number[]; d30: number[]; d90: number[] }> = {};
    for (const s of scores) {
      const ageDays = (now - new Date(s.scored_at).getTime()) / 86400000;
      const b = (buckets[s.dimension] ||= { d7: [], d30: [], d90: [] });
      if (ageDays <= 7) b.d7.push(s.score);
      if (ageDays <= 30) b.d30.push(s.score);
      if (ageDays <= 90) b.d90.push(s.score);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return Object.entries(buckets)
      .map(([dim, b]) => {
        const m7 = mean(b.d7);
        const m30 = mean(b.d30);
        const m90 = mean(b.d90);
        const trend =
          m7 != null && m30 != null ? m7 - m30 : null;
        return {
          dim,
          n7: b.d7.length,
          n30: b.d30.length,
          n90: b.d90.length,
          m7,
          m30,
          m90,
          trend,
        };
      })
      .filter((x) => x.n90 >= 5)
      .sort((a, b) => (b.trend ?? -999) - (a.trend ?? -999));
  }, [scores]);

  // Bear pass effectiveness: count how often top_performers_bear_pass_applied > 0
  const bearStats = useMemo(() => {
    let runs = 0;
    let applied = 0;
    let totalFlips = 0;
    for (const an of analyses) {
      const raw = an.raw_json || {};
      runs += 1;
      const n = raw.top_performers_bear_pass_applied;
      if (typeof n === "number" && n > 0) {
        applied += 1;
        totalFlips += n;
      }
    }
    return { runs, applied, totalFlips };
  }, [analyses]);

  // Overall pool stats
  const poolStats = useMemo(() => {
    const total = attempts.length;
    const ok = attempts.filter((a) => a.status === "ok").length;
    const ensembleRuns = analyses.filter(
      (a) => typeof a.raw_json?.ensemble_models_used === "number"
    ).length;
    const meanModelsPerRun =
      ensembleRuns > 0
        ? analyses
            .filter((a) => typeof a.raw_json?.ensemble_models_used === "number")
            .reduce((s, a) => s + (a.raw_json?.ensemble_models_used || 0), 0) /
          ensembleRuns
        : 0;
    return {
      total,
      ok,
      pct: total > 0 ? (ok / total) * 100 : 0,
      ensembleRuns,
      meanModelsPerRun,
    };
  }, [attempts, analyses]);

  if (loading) {
    return (
      <main className="container py-12">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Rankings</h1>
        <p className="text-[var(--muted)] mb-10">Loading model performance data...</p>
      </main>
    );
  }

  return (
    <main className="container py-12">
      <header className="mb-12">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Rankings</h1>
        <p className="text-[var(--muted)] mt-2 max-w-2xl">
          Per-model and per-agent scoreboard. Tracks which ensemble members
          carry signal, which fail silently, and how each dimension's accuracy
          is trending over time.
        </p>
      </header>

      <Section
        num="001"
        title="Ensemble Pool Snapshot"
        description="Overall fan-out health across all logged calls."
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Total Calls" value={poolStats.total} />
          <Stat
            label="Usable Rate"
            value={`${poolStats.pct.toFixed(1)}%`}
            delta={`${poolStats.ok} / ${poolStats.total}`}
            deltaPositive={poolStats.pct >= 50}
          />
          <Stat label="Ensemble Runs" value={poolStats.ensembleRuns} />
          <Stat
            label="Avg Models / Run"
            value={poolStats.meanModelsPerRun.toFixed(1)}
            delta={poolStats.meanModelsPerRun >= 4 ? "Healthy" : "Degraded"}
            deltaPositive={poolStats.meanModelsPerRun >= 4}
          />
        </div>
      </Section>

      <Section
        num="002"
        title="Model Leaderboard"
        description="Sorted by usable rate weighted by consensus agreement. Calibration check: high agreement + low usable rate means a fragile endpoint with otherwise sound calls."
      >
        {modelRows.length === 0 ? (
          <EmptyState
            title="No ensemble attempts logged yet"
            hint="First ensemble run after schema migration will populate this."
          />
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="data">
              <thead>
                <tr className="text-left text-[var(--muted)] section-num border-b border-border">
                  <th className="px-4 py-3">Lab / Model</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3">Usable</th>
                  <th className="px-4 py-3">Consensus Agreement</th>
                  <th className="px-4 py-3 text-right">Avg Latency</th>
                  <th className="px-4 py-3 text-right">429</th>
                  <th className="px-4 py-3 text-right">400</th>
                  <th className="px-4 py-3 text-right">Empty</th>
                </tr>
              </thead>
              <tbody>
                {modelRows.map((m) => (
                  <tr key={m.slug} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{m.lab}</div>
                      <div className="text-xs text-[var(--muted)] num">{m.short}</div>
                    </td>
                    <td className="px-4 py-3 text-right num">{m.attempts}</td>
                    <td className="px-4 py-3 min-w-[140px]">
                      {pctBar(m.usable_pct, m.usable_pct >= 50 ? "good" : "bad")}
                    </td>
                    <td className="px-4 py-3 min-w-[140px]">
                      {m.consensus_agreement_pct != null
                        ? pctBar(
                            m.consensus_agreement_pct,
                            m.consensus_agreement_pct >= 50 ? "good" : "bad"
                          )
                        : <span className="text-xs text-[var(--muted)]">No data</span>}
                    </td>
                    <td className="px-4 py-3 text-right num text-xs">
                      {m.avg_latency_ms != null
                        ? `${(m.avg_latency_ms / 1000).toFixed(1)}s`
                        : "·"}
                    </td>
                    <td className="px-4 py-3 text-right num text-xs">
                      {m.http_429 || 0}
                    </td>
                    <td className="px-4 py-3 text-right num text-xs">
                      {m.http_400 || 0}
                    </td>
                    <td className="px-4 py-3 text-right num text-xs">
                      {m.empty || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        num="003"
        title="Per-Dimension Skill Trend"
        description="Mean prediction_scores by dimension across 7d, 30d, 90d windows. Trend = 7d mean minus 30d mean. Positive trend means the dimension is improving."
      >
        {dimTrends.length === 0 ? (
          <EmptyState
            title="Not enough scored predictions"
            hint="Need >= 5 graded rows per dimension over 90 days."
          />
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="data">
              <thead>
                <tr className="text-left text-[var(--muted)] section-num border-b border-border">
                  <th className="px-4 py-3">Dimension</th>
                  <th className="px-4 py-3 text-right">7d Mean</th>
                  <th className="px-4 py-3 text-right">30d Mean</th>
                  <th className="px-4 py-3 text-right">90d Mean</th>
                  <th className="px-4 py-3 text-right">Trend</th>
                  <th className="px-4 py-3 text-right">n (90d)</th>
                </tr>
              </thead>
              <tbody>
                {dimTrends.slice(0, 30).map((d) => (
                  <tr key={d.dim} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-medium">{d.dim}</td>
                    <td className="px-4 py-3 text-right num">{d.m7?.toFixed(1) ?? "·"}</td>
                    <td className="px-4 py-3 text-right num">{d.m30?.toFixed(1) ?? "·"}</td>
                    <td className="px-4 py-3 text-right num">{d.m90?.toFixed(1) ?? "·"}</td>
                    <td
                      className={`px-4 py-3 text-right num font-medium ${
                        d.trend == null
                          ? "text-[var(--muted)]"
                          : d.trend > 0
                          ? "text-[var(--gain)]"
                          : d.trend < 0
                          ? "text-[var(--loss)]"
                          : ""
                      }`}
                    >
                      {d.trend != null ? `${d.trend > 0 ? "+" : ""}${d.trend.toFixed(1)}` : "·"}
                    </td>
                    <td className="px-4 py-3 text-right num text-xs text-[var(--muted)]">
                      {d.n90}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        num="004"
        title="Bear Pass Effectiveness"
        description="Counts how often the adversarial bear pass injected new failure modes into top_performers. Effective bear = lots of flips that later turn out to have avoided a loss."
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Stat label="Total Runs" value={bearStats.runs} />
          <Stat
            label="Runs With Flips"
            value={bearStats.applied}
            delta={
              bearStats.runs > 0
                ? `${((bearStats.applied / bearStats.runs) * 100).toFixed(0)}% of runs`
                : "no data"
            }
          />
          <Stat label="Total Picks Flipped" value={bearStats.totalFlips} />
        </div>
      </Section>

      <Section
        num="005"
        title="Recent Failure Detail"
        description="Last 30 non-OK attempts. Use this to spot a specific model slug going bad before it kills the daily run."
      >
        {(() => {
          const fails = attempts.filter((a) => a.status !== "ok").slice(0, 30);
          if (fails.length === 0) {
            return (
              <EmptyState
                title="No recent failures"
                hint="Pool is healthy across the last 2000 calls."
              />
            );
          }
          return (
            <div className="card p-0 overflow-x-auto">
              <table className="data">
                <thead>
                  <tr className="text-left text-[var(--muted)] section-num border-b border-border">
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {fails.map((a) => {
                    const { short } = LAB_FROM_SLUG(a.model_slug);
                    return (
                      <tr key={a.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-xs num text-[var(--muted)]">
                          {new Date(a.attempted_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs num">{short}</td>
                        <td className="px-4 py-3 text-xs">
                          {STATUS_LABEL[a.status] || a.status}
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--muted)] max-w-md truncate">
                          {a.error_snippet || "·"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()}
      </Section>
    </main>
  );
}

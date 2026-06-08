"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { sb } from "@/lib/supabase";

const DIMENSION_LABELS: Record<string, string> = {
  direction_1d: "Next Day Direction",
  range_1d: "Next Day Range",
  short_pick_7d: "Short Picks (7d)",
  short_pick_14d: "Short Picks (14d)",
  short_pick_30d: "Short Picks (30d)",
  long_pick_180d: "Long Picks (180d)",
  avoid_7d: "Avoid List (7d)",
};

const WINDOWS = [7, 30, 90];

// A single dot renders as a meaningless vertical line. Require a handful
// of scored sessions before the trend chart is worth showing.
const TREND_MIN_POINTS = 7;

// Below this many scored samples, a binary hit rate has a wide confidence
// interval (~+/-20 pts at n=23), so the numbers are directional, not
// conclusions. Show a caveat until enough history accumulates.
const CONFIDENCE_MIN_SAMPLES = 100;

export default function AccuracyPage() {
  const [summary, setSummary] = useState<any[]>([]);
  const [trend, setTrend] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Latest summary per (window, dimension)
      const { data: sumData } = await sb
        .from("accuracy_summary")
        .select("*")
        .order("computed_at", { ascending: false })
        .limit(200);
      const seen = new Set<string>();
      const latest = (sumData || []).filter((r) => {
        const k = `${r.window_days}-${r.dimension}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setSummary(latest);

      // Score trend over time (direction_1d)
      const { data: trendData } = await sb
        .from("prediction_scores")
        .select("scored_at,dimension,score")
        .eq("dimension", "direction_1d")
        .order("scored_at", { ascending: true })
        .limit(120);
      const points = (trendData || []).map((r: any) => ({
        date: r.scored_at.slice(0, 10),
        value: r.score,
      }));
      setTrend(points);
      setLoading(false);
    })();
  }, []);

  if (!loading && summary.length === 0) {
    return (
      <EmptyState
        title="No scores yet."
        hint="Predictions need at least 1 trading day to grade. Comes online after first cron grading run."
      />
    );
  }

  // Headline metrics. Direction is the real KPI: averaging it with Range
  // into a single "accuracy" number flatters the weak dimension and hides
  // that direction calls carry no edge yet. Show each naked instead.
  const last30 = summary.filter((s) => s.window_days === 30);
  const dirRow = last30.find((s) => s.dimension === "direction_1d");
  const rngRow = last30.find((s) => s.dimension === "range_1d");

  const dirAcc = dirRow?.accuracy_pct ?? null;
  const rngAcc = rngRow?.accuracy_pct ?? null;
  const dirN = dirRow?.sample_size ?? 0;
  const rngN = rngRow?.sample_size ?? 0;

  // Edge over a coin flip. Within ±5 pts of 50 = no demonstrable edge
  // (neutral), so we don't paint a near-random result green or red.
  const dirEdge = dirAcc == null ? null : dirAcc - 50;
  const dirEdgePositive =
    dirEdge == null || Math.abs(dirEdge) < 5 ? undefined : dirEdge > 0;
  const dirEdgeLabel =
    dirEdge == null
      ? "no data"
      : `${dirEdge >= 0 ? "+" : ""}${dirEdge.toFixed(1)} pts vs 50% coin flip`;

  // Largest single-dimension sample drives the confidence caveat.
  const maxSamples = summary.reduce((m, s) => Math.max(m, s.sample_size || 0), 0);
  const lowConfidence = maxSamples < CONFIDENCE_MIN_SAMPLES;

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Accuracy</div>
        <h1 className="headline mb-3">
          How well I have <span className="italic">Predicted.</span>
        </h1>
        <p className="sub-headline max-w-2xl">
          Every past prediction is scored against actual outcomes. The system reads these scores before every new call, calibrating itself over time.
        </p>
      </div>

      {lowConfidence && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8 flex items-start gap-3 rounded-2xl border px-4 py-3"
          style={{
            borderColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
            background: "color-mix(in srgb, var(--warn) 8%, transparent)",
          }}
        >
          <span className="mt-0.5 text-[var(--warn)] shrink-0">◆</span>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            <span className="text-foreground font-medium">Low confidence.</span>{" "}
            Only {maxSamples} sessions scored so far. At this sample size a hit
            rate carries roughly ±20 points of uncertainty, so treat these as
            directional signals, not conclusions. Reliability grows past{" "}
            {CONFIDENCE_MIN_SAMPLES} scored sessions.
          </p>
        </motion.div>
      )}

      <Section num="001 / 003" title="Overall Last 30 Days" glyph="✦">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat
            label="Direction accuracy"
            value={dirAcc == null ? "—" : `${dirAcc.toFixed(1)}%`}
            delta={dirEdgeLabel}
            deltaPositive={dirEdgePositive}
            glyph="◎"
          />
          <Stat
            label="Range hit rate"
            value={rngAcc == null ? "—" : `${rngAcc.toFixed(1)}%`}
            delta={`${rngN} scored`}
            glyph="◈"
          />
          <Stat label="Sessions scored" value={dirN.toString()} glyph="⬡" />
          <Stat label="Window" value="30 days" glyph="◉" />
        </div>
      </Section>

      <Section num="002 / 003" title="By Dimension" glyph="◈" description="How each prediction type performs across windows.">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
          className="card overflow-hidden"
        >
          <table className="data" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "30%" }} />
              <col style={{ width: "23%" }} />
              <col style={{ width: "23%" }} />
              <col style={{ width: "24%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Dimension</th>
                <th>7d</th>
                <th>30d</th>
                <th>90d</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(DIMENSION_LABELS).map((dim) => {
                const byWindow: Record<number, any> = {};
                summary.filter((s) => s.dimension === dim).forEach((s) => {
                  byWindow[s.window_days] = s;
                });
                if (WINDOWS.every((w) => !byWindow[w])) return null;
                return (
                  <tr key={dim}>
                    <td className="font-medium">{DIMENSION_LABELS[dim]}</td>
                    {WINDOWS.map((w) => {
                      const s = byWindow[w];
                      if (!s) {
                        return <td key={w} className="text-[var(--muted)]">·</td>;
                      }
                      const acc = s.accuracy_pct || 0;
                      const color =
                        acc >= 65 ? "var(--gain)" : acc >= 50 ? "var(--warn)" : "var(--loss)";
                      return (
                        <td key={w} className="num font-medium" style={{ color }}>
                          {acc.toFixed(1)}%{" "}
                          <span className="text-[var(--muted)] font-normal text-xs">
                            ({s.sample_size})
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </motion.div>
      </Section>

      <Section num="003 / 003" title="Score Trend" glyph="⬡" description="Direction accuracy over time. Self-learning visible.">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.16 }}
          className="card p-6"
        >
          {trend.length >= TREND_MIN_POINTS ? (
            <LineChart
              data={trend}
              height={320}
              color="var(--foreground)"
              valueLabel="Direction Score"
              yTickFormatter={(v) => `${Math.round(v)}%`}
              valueFormatter={(v) => `${Math.round(v)}%`}
            />
          ) : (
            <div
              style={{ height: 320 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Collecting data. The trend appears once at least {TREND_MIN_POINTS} sessions are scored.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {trend.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>
    </>
  );
}

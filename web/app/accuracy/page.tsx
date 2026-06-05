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

  // Calculate overall accuracy for headline stat
  const last30 = summary.filter((s) => s.window_days === 30);
  const overallAcc = last30.length
    ? last30.reduce((a, s) => a + (s.accuracy_pct || 0), 0) / last30.length
    : 0;
  const totalSamples = last30.reduce((a, s) => a + (s.sample_size || 0), 0);

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

      <Section num="001 / 003" title="Overall Last 30 Days" glyph="✦">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Avg accuracy" value={`${overallAcc.toFixed(1)}%`} glyph="◎" />
          <Stat label="Predictions scored" value={totalSamples.toString()} glyph="◈" />
          <Stat label="Dimensions tracked" value={last30.length.toString()} glyph="⬡" />
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
          <LineChart data={trend} height={320} color="var(--foreground)" />
        </motion.div>
      </Section>
    </>
  );
}

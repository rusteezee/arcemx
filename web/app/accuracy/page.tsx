"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { sb } from "@/lib/supabase";

const DIMENSION_LABELS: Record<string, string> = {
  direction_1d: "NIFTY Next Day Direction",
  range_1d: "NIFTY Next Day Range",
  direction_5d: "NIFTY 5-Day Trend",
  direction_20d: "NIFTY 20-Day Trend",
  vol_regime_5d: "Volatility Regime (5d)",
  sensex_direction_1d: "Sensex Next Day Direction",
  sensex_range_1d: "Sensex Next Day Range",
  pick_tp_sl: "Short Pick Target/SL Hit (10d)",
  short_pick_7d: "Short Picks (7d)",
  short_pick_14d: "Short Picks (14d)",
  short_pick_30d: "Short Picks (30d)",
  long_pick_180d: "Long Picks (180d)",
  long_pick_tp_sl: "Long Pick Target/SL Hit (60d)",
  avoid_7d: "Avoid List (7d)",
  verdict_7d: "Portfolio Verdicts (7d)",
  verdict_tp_sl: "Holding Target/SL Hit (20d)",
  wishlist_7d: "Wishlist Signals (7d)",
};

const WINDOWS = [7, 30, 90];

// A single dot renders as a meaningless vertical line. Require a handful
// of scored sessions before the trend chart is worth showing.
const TREND_MIN_POINTS = 7;

// Below this many scored samples, a binary hit rate has a wide confidence
// interval (~+/-20 pts at n=23), so the numbers are directional, not
// conclusions. Show a caveat until enough history accumulates.
const CONFIDENCE_MIN_SAMPLES = 100;

interface Calibration {
  stated: number;
  realized: number;
  gap: number;
  n: number;
}

export default function AccuracyPage() {
  const [summary, setSummary] = useState<any[]>([]);
  const [trend, setTrend] = useState<any[]>([]);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
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

      // Score trend over time. Plot each prediction by the date it was MADE
      // (analysis.run_at), not the date it was graded (scored_at). The grader
      // stamps every score with the single moment it ran, so ordering by
      // scored_at collapses the whole history onto one X coordinate and the
      // chart degenerates into a vertical line. Join scores to their analysis
      // run_at with two queries instead of a PostgREST embed, since these
      // tables were created out of band and a FK relationship is not
      // guaranteed to exist for the embed to resolve.
      const { data: scoreRows } = await sb
        .from("prediction_scores")
        .select("score,analysis_id")
        .eq("dimension", "direction_1d")
        .limit(400);

      const ids = Array.from(
        new Set((scoreRows || []).map((r: any) => r.analysis_id).filter((x: any) => x != null))
      );
      const runAtById = new Map<number, string>();
      const confById = new Map<number, number>();
      if (ids.length) {
        const { data: aRows } = await sb
          .from("analysis")
          .select("id,run_at,raw_json")
          .in("id", ids);
        for (const a of (aRows || []) as any[]) {
          if (a?.id != null && a?.run_at) runAtById.set(a.id, a.run_at);
          const c = a?.raw_json?.confidence;
          if (a?.id != null && typeof c === "number") confById.set(a.id, c);
        }
      }

      // Confidence calibration: does the model's stated confidence match the
      // direction accuracy it actually delivers? Pair each scored direction
      // call with the confidence stated when it was made.
      const calPairs = (scoreRows || []).filter(
        (r: any) => typeof r.score === "number" && confById.has(r.analysis_id)
      );
      if (calPairs.length >= 5) {
        const stated =
          calPairs.reduce((a: number, r: any) => a + confById.get(r.analysis_id)!, 0) /
          calPairs.length;
        const realized =
          calPairs.reduce((a: number, r: any) => a + r.score, 0) / calPairs.length;
        setCalibration({
          stated: Math.round(stated * 10) / 10,
          realized: Math.round(realized * 10) / 10,
          gap: Math.round((stated - realized) * 10) / 10,
          n: calPairs.length,
        });
      }

      // Collapse to one score per prediction date (average if a day has more
      // than one), then walk forward applying a trailing rolling mean so the
      // line reads as "accuracy over time" instead of a 0/50/100 sawtooth.
      const byDate = new Map<string, number[]>();
      for (const r of (scoreRows || []) as any[]) {
        const runAt = runAtById.get(r.analysis_id);
        if (!runAt || typeof r.score !== "number") continue;
        const d = String(runAt).slice(0, 10);
        const arr = byDate.get(d) ?? [];
        arr.push(r.score);
        byDate.set(d, arr);
      }
      const daily = Array.from(byDate.entries())
        .map(([date, arr]) => ({ date, score: arr.reduce((a, b) => a + b, 0) / arr.length }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));

      const K = 10; // trailing window of predictions
      const points = daily.map((d, i) => {
        const slice = daily.slice(Math.max(0, i - K + 1), i + 1);
        const mean = slice.reduce((a, b) => a + b.score, 0) / slice.length;
        return { date: d.date, value: Math.round(mean * 10) / 10 };
      });
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

  // A high range hit rate only means skill if the band is tight. Surface
  // the average predicted band width so 97% on a wide band reads honestly.
  const rngBandWidth: number | null = rngRow?.bias?.avg_band_width_pct ?? null;
  const rngBandLabel =
    rngBandWidth != null
      ? `±${(rngBandWidth / 2).toFixed(2)}% band · ${rngN} scored`
      : `${rngN} scored`;

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

      <Section num={calibration ? "001 / 004" : "001 / 003"} title="Overall Last 30 Days" glyph="✦">
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
            delta={rngBandLabel}
            glyph="◈"
          />
          <Stat label="Sessions scored" value={dirN.toString()} glyph="⬡" />
          <Stat label="Window" value="30 days" glyph="◉" />
        </div>
      </Section>

      {calibration && (
        <Section
          num="002 / 004"
          title="Confidence Calibration"
          glyph="◉"
          description="Does the stated confidence match the direction accuracy actually delivered? An honest model's gap sits near zero."
        >
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <Stat label="Stated confidence" value={`${calibration.stated.toFixed(1)}%`} glyph="◎" />
            <Stat label="Realized accuracy" value={`${calibration.realized.toFixed(1)}%`} glyph="◈" />
            <Stat
              label={calibration.gap > 0 ? "Overconfident by" : calibration.gap < 0 ? "Underconfident by" : "Calibration gap"}
              value={`${Math.abs(calibration.gap).toFixed(1)} pts`}
              delta={
                Math.abs(calibration.gap) <= 8
                  ? "well calibrated"
                  : calibration.gap > 0
                  ? "stated > delivered"
                  : "stated < delivered"
              }
              deltaPositive={Math.abs(calibration.gap) <= 8 ? true : calibration.gap > 0 ? false : undefined}
              glyph="⬡"
            />
          </div>
        </Section>
      )}

      <Section num={calibration ? "003 / 004" : "002 / 003"} title="By Dimension" glyph="◈" description="How each prediction type performs across windows.">
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

      <Section num={calibration ? "004 / 004" : "003 / 003"} title="Score Trend" glyph="⬡" description="Trailing 10-prediction rolling direction accuracy, by prediction date. Self-learning visible as the line climbs.">
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
              valueLabel="Rolling Accuracy"
              yTickFormatter={(v) => `${Math.round(v)}%`}
              valueFormatter={(v) => `${v.toFixed(1)}%`}
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

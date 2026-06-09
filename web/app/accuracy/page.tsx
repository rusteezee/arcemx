"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { TriggerButton } from "@/components/TriggerButton";
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
  holding_outlook_dir_1d: "Holdings Direction (1d)",
  holding_outlook_range_1d: "Holdings Range (1d)",
  wishlist_outlook_dir_1d: "Wishlist Direction (1d)",
  wishlist_outlook_range_1d: "Wishlist Range (1d)",
  sector_dir_1d: "Sectors Direction (1d)",
  sector_range_1d: "Sectors Range (1d)",
  index_pair_1d: "NIFTY vs BankNifty (1d)",
  cap_pair_1d: "NIFTY vs Midcap 150 (1d)",
  fii_flow_1d: "FII Cash Flow Direction (1d)",
  short_pick_A_7d: "Short Picks · Tier A (7d)",
  short_pick_B_7d: "Short Picks · Tier B (7d)",
  short_pick_C_7d: "Short Picks · Tier C (7d)",
  insight_quality: "Reasoning Quality",
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

interface ScatterPoint {
  width: number;   // band width % of midpoint
  score: number;   // 0-100 hit rate (binary for interval)
  date: string;
}

export default function AccuracyPage() {
  const [summary, setSummary] = useState<any[]>([]);
  const [trend, setTrend] = useState<any[]>([]);
  const [iqTrend, setIqTrend] = useState<{ date: string; value: number }[]>([]);
  const [rangeScatter, setRangeScatter] = useState<ScatterPoint[]>([]);
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

      // ----- Insight quality trend (per analysis date, rolling-5 mean) -----
      // insight_quality is scored age=0 (same day), so the line shows up the
      // fastest of any dim. Smaller K than direction trend (5 vs 10) because
      // text quality moves more slowly than direction noise.
      const { data: iqRows } = await sb
        .from("prediction_scores")
        .select("score,analysis_id")
        .eq("dimension", "insight_quality")
        .limit(400);
      const iqByDate = new Map<string, number[]>();
      for (const r of (iqRows || []) as any[]) {
        const runAt = runAtById.get(r.analysis_id);
        if (!runAt || typeof r.score !== "number") continue;
        const d = String(runAt).slice(0, 10);
        const arr = iqByDate.get(d) ?? [];
        arr.push(r.score);
        iqByDate.set(d, arr);
      }
      const iqDaily = Array.from(iqByDate.entries())
        .map(([date, arr]) => ({ date, score: arr.reduce((a, b) => a + b, 0) / arr.length }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const IQ_K = 5;
      const iqPoints = iqDaily.map((d, i) => {
        const slice = iqDaily.slice(Math.max(0, i - IQ_K + 1), i + 1);
        const mean = slice.reduce((a, b) => a + b.score, 0) / slice.length;
        return { date: d.date, value: Math.round(mean * 10) / 10 };
      });
      setIqTrend(iqPoints);

      // ----- Range tightness vs hit rate scatter -----
      // Each scored range_1d row carries the predicted [lo, hi] band. Plot
      // band width % vs the binary hit score (100 = close inside, 0 = miss).
      // A useful range engine clusters into the top-left quadrant (tight
      // bands that still hit). A wide right column shows the model buying
      // hit rate with width — surfaces overconfidence/range inflation.
      const { data: rngRows } = await sb
        .from("prediction_scores")
        .select("score,predicted,analysis_id")
        .eq("dimension", "range_1d")
        .limit(400);
      const sPts: ScatterPoint[] = [];
      for (const r of (rngRows || []) as any[]) {
        const pred = r.predicted || {};
        const rng = pred.range;
        if (!Array.isArray(rng) || rng.length < 2) continue;
        const lo = Number(rng[0]);
        const hi = Number(rng[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) continue;
        const mid = (lo + hi) / 2;
        if (mid <= 0) continue;
        const width = ((hi - lo) / mid) * 100;
        const runAt = runAtById.get(r.analysis_id);
        if (typeof r.score !== "number") continue;
        sPts.push({ width: Math.round(width * 100) / 100, score: r.score, date: runAt ? String(runAt).slice(0, 10) : "" });
      }
      setRangeScatter(sPts);

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
      <div className="mb-12 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="section-num mb-2">000 · Accuracy</div>
          <h1 className="headline mb-3">
            How well I have <span className="italic">Predicted.</span>
          </h1>
          <p className="sub-headline max-w-2xl">
            Every past prediction is scored against actual outcomes. The system reads these scores before every new call, calibrating itself over time.
          </p>
        </div>
        <TriggerButton
          endpoint="/api/trigger-grader"
          label="Run Grader"
          queuedLabel="Queued"
          title="Score every analysis row whose horizon has elapsed and refresh the accuracy summary."
        />
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

      <Section num={calibration ? "001 / 008" : "001 / 007"} title="Overall Last 30 Days" glyph="✦">
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
          num="002 / 008"
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

      <Section
        num={calibration ? "003 / 008" : "002 / 007"}
        title="New Dimensions"
        glyph="◉"
        description="Headline accuracy on the recently-added graded dims. Empty cells populate once the next grader pass scores them."
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {(["insight_quality", "cap_pair_1d", "fii_flow_1d", "index_pair_1d"] as const).map((dim) => {
            const row = summary.find((s) => s.window_days === 30 && s.dimension === dim);
            const acc = row?.accuracy_pct ?? null;
            const n = row?.sample_size ?? 0;
            return (
              <Stat
                key={dim}
                label={DIMENSION_LABELS[dim]}
                value={acc == null ? "—" : `${acc.toFixed(1)}%`}
                delta={acc == null ? "awaiting first grade" : `${n} scored · 30d`}
                glyph="◎"
              />
            );
          })}
        </div>
      </Section>

      <Section num={calibration ? "004 / 008" : "003 / 007"} title="By Dimension" glyph="◈" description="How each prediction type performs across windows.">
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

      <Section num={calibration ? "005 / 008" : "004 / 007"} title="Score Trend" glyph="⬡" description="Trailing 10-prediction rolling direction accuracy, by prediction date. Self-learning visible as the line climbs.">
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

      <Section
        num={calibration ? "006 / 008" : "005 / 007"}
        title="Insight Quality Trend"
        glyph="⬡"
        description="Rolling 5-prediction average of the reasoning_breakdown auditor score. Number-density + payload citations - banned hedges. Climbs as the model anchors more in data and stops hedging."
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="card p-6"
        >
          {iqTrend.length >= 3 ? (
            <LineChart
              data={iqTrend}
              height={260}
              color="var(--foreground)"
              valueLabel="Insight Quality"
              yTickFormatter={(v) => `${Math.round(v)}`}
              valueFormatter={(v) => `${v.toFixed(1)}`}
            />
          ) : (
            <div
              style={{ height: 260 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Collecting data. Trend appears once at least 3 sessions are scored.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {iqTrend.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "007 / 008" : "006 / 007"}
        title="Range Tightness vs Hit Rate"
        glyph="◈"
        description="X-axis: predicted band width as percent of midpoint. Y-axis: hit (100) or miss (0) for that day. The useful cluster is top-left: tight bands that still hit. A wide right column means the engine bought hit rate with width — that's range inflation, not skill."
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.24 }}
          className="card p-6"
        >
          {rangeScatter.length >= 3 ? (
            <RangeScatter points={rangeScatter} />
          ) : (
            <div
              style={{ height: 280 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Collecting data. Scatter appears once at least 3 range predictions are scored.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {rangeScatter.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "008 / 008" : "007 / 007"}
        title="Conviction Tier Performance"
        glyph="◉"
        description="Stratified pick alpha by conviction label. A-tier alpha should exceed B; B should exceed C. Flat results across tiers means the labels carry no signal and the prompt needs tightening."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {([
            { tier: "A", dim: "short_pick_A_7d" as const, gloss: "Highest conviction. All three pillars aligned (technicals + news + sector). Capped at 0-2 per day.", pill: "pill-gain" },
            { tier: "B", dim: "short_pick_B_7d" as const, gloss: "Solid setup. Two of three pillars aligned. Bulk of picks.", pill: "" },
            { tier: "C", dim: "short_pick_C_7d" as const, gloss: "Speculative / asymmetric. One pillar strong, signal incomplete. Sparingly.", pill: "pill-warn" },
          ]).map(({ tier, dim, gloss, pill }) => {
            const row = summary.find((s) => s.window_days === 30 && s.dimension === dim);
            const acc = row?.accuracy_pct ?? null;
            const n = row?.sample_size ?? 0;
            // Card accent border + tier badge color use the conviction-tier
            // palette (A=gain, B=neutral, C=warn) so the tier identity is
            // legible at a glance. The big accuracy number stays
            // performance-colored (acc>=65 gain, >=50 warn, <50 loss) so a
            // green A-tier with a red number visibly flags "we labeled
            // these high conviction but they did not deliver".
            const accColor =
              acc == null ? "var(--muted)" : acc >= 65 ? "var(--gain)" : acc >= 50 ? "var(--warn)" : "var(--loss)";
            const accent =
              tier === "A" ? "var(--gain)" : tier === "C" ? "var(--warn)" : "var(--border)";
            return (
              <div
                key={tier}
                className="card p-5"
                style={{ borderTop: `2px solid ${accent}` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className={`pill ${pill}`} style={{ minWidth: 50, justifyContent: "center" }}>
                    Tier {tier}
                  </span>
                  <span className="num text-xs text-[var(--muted)]">
                    {n} scored
                  </span>
                </div>
                <div className="section-num mb-1">7d alpha</div>
                <div className="text-3xl font-semibold" style={{ color: accColor }}>
                  {acc == null ? "—" : `${acc.toFixed(1)}%`}
                </div>
                <p className="text-sm text-[var(--muted)] leading-relaxed mt-3">{gloss}</p>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}

function RangeScatter({ points }: { points: ScatterPoint[] }) {
  // Inline SVG scatter so we do not pull a second chart library. X = band
  // width %, Y = score (0 or 100 for interval grader). Quadrant guides at
  // x=1% (tight/wide split) and y=50 (hit/miss split) frame the useful
  // top-left quadrant.
  const H = 280;
  const W = 720;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxX = Math.max(2, ...points.map((p) => p.width));
  const xScale = (x: number) => padL + (Math.min(x, maxX) / maxX) * innerW;
  // y range 0-100; invert because SVG y grows downward
  const yScale = (y: number) => padT + innerH - (y / 100) * innerH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet">
      {/* axis lines */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="var(--border)" />
      <line x1={padL} y1={padT + innerH} x2={padL + innerW} y2={padT + innerH} stroke="var(--border)" />
      {/* quadrant guides */}
      <line
        x1={xScale(Math.min(1.0, maxX))}
        y1={padT}
        x2={xScale(Math.min(1.0, maxX))}
        y2={padT + innerH}
        stroke="var(--muted)"
        strokeDasharray="3 4"
        opacity="0.45"
      />
      <line
        x1={padL}
        y1={yScale(50)}
        x2={padL + innerW}
        y2={yScale(50)}
        stroke="var(--muted)"
        strokeDasharray="3 4"
        opacity="0.45"
      />
      {/* y ticks 0/50/100 */}
      {[0, 50, 100].map((t) => (
        <g key={t}>
          <text x={padL - 8} y={yScale(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
            {t}
          </text>
        </g>
      ))}
      {/* x ticks */}
      {[0, Math.round(maxX * 0.5 * 10) / 10, Math.round(maxX * 10) / 10].map((t, i) => (
        <text
          key={i}
          x={xScale(t)}
          y={padT + innerH + 18}
          textAnchor="middle"
          fontSize="11"
          fill="var(--muted)"
        >
          {t}%
        </text>
      ))}
      <text x={padL + innerW / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="var(--muted)">
        Band width (% of midpoint)
      </text>
      <text
        x={-padT - innerH / 2}
        y={14}
        textAnchor="middle"
        fontSize="11"
        fill="var(--muted)"
        transform="rotate(-90)"
      >
        Score
      </text>
      {/* points */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={xScale(p.width)}
          cy={yScale(p.score)}
          r="4"
          fill={p.score >= 50 ? "var(--gain)" : "var(--loss)"}
          opacity="0.75"
        >
          <title>{`${p.date}: width ${p.width}%, score ${p.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}

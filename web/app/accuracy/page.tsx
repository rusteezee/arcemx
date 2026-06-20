"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { sb } from "@/lib/supabase";

// "(1d)" suffix dropped from every next-day dimension: it was wrapping
// the Stat card headers to two lines on mobile and added no
// information (none of these dims have a non-1d sibling on this page).
// Non-1d horizons keep the parenthetical (5d/7d/10d/14d/20d/60d/180d)
// because those genuinely distinguish from a 1d version. "FII Cash
// Flow Direction" shortened to "FII Cash Flow" so the card title fits
// on a single line in the New Dimensions grid.
const DIMENSION_LABELS: Record<string, string> = {
  market_mood_1d: "Market Mood",
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
  holding_outlook_dir_1d: "Holdings Direction",
  holding_outlook_range_1d: "Holdings Range",
  wishlist_outlook_dir_1d: "Wishlist Direction",
  wishlist_outlook_range_1d: "Wishlist Range",
  sector_dir_1d: "Sectors Direction",
  sector_range_1d: "Sectors Range",
  stock_range_1d: "Stock Range",
  index_pair_1d: "NIFTY vs BankNifty",
  cap_pair_1d: "NIFTY vs Midcap 150",
  fii_flow_1d: "FII Cash Flow",
  short_pick_A_7d: "Short Picks · Tier A (7d)",
  short_pick_B_7d: "Short Picks · Tier B (7d)",
  short_pick_C_7d: "Short Picks · Tier C (7d)",
  insight_quality: "Insight Quality",
};

const WINDOWS = [7, 30, 90];

// Global window picker options. accuracy_summary rows are written
// by the grader at these explicit window_days values, so the buttons
// map 1:1 to a DB row (no client-side recompute). 99999 is the
// grader's encoding for MAX (all-time).
const WINDOW_OPTS = [
  { label: "7D", days: 7, fullLabel: "7 days" },
  { label: "30D", days: 30, fullLabel: "30 days" },
  { label: "90D", days: 90, fullLabel: "90 days" },
  { label: "180D", days: 180, fullLabel: "180 days" },
  { label: "1Y", days: 365, fullLabel: "1 year" },
  { label: "MAX", days: 99999, fullLabel: "All time" },
] as const;

// "YYYY-MM-DD" cutoff for a window of `days` days ago. For the MAX
// window (99999) returns an epoch sentinel so every date passes the
// `point.date >= cutoff` filter.
function windowCutoffYMD(days: number): string {
  if (days >= 99999) return "0000-00-00";
  const t = Date.now() - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

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

// OLS slope + Pearson r + r-squared for the range cloud. Shared
// between the RangeScatter SVG and the HTML header strip above the
// card so both surfaces show identical numbers.
function rangeStats(points: ScatterPoint[]): { slope: number; r: number; r2: number; n: number } | null {
  if (points.length < 4) return null;
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.width, 0);
  const sumY = points.reduce((a, p) => a + p.score, 0);
  const sumXY = points.reduce((a, p) => a + p.width * p.score, 0);
  const sumXX = points.reduce((a, p) => a + p.width * p.width, 0);
  const sumYY = points.reduce((a, p) => a + p.score * p.score, 0);
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-6) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const rDen = Math.sqrt(denom * (n * sumYY - sumY * sumY));
  const r = rDen > 1e-6 ? (n * sumXY - sumX * sumY) / rDen : 0;
  return { slope, r, r2: r * r, n };
}

interface CalibPoint {
  stated: number;    // stated confidence at call time, 0-100
  realized: number;  // graded direction score for that call, 0-100
  date: string;
}

// Monday "YYYY-MM-DD" of the ISO week containing d. Used by the Cohort
// Learning Curve to bucket graded direction calls by the week they were
// issued. Emits a real date string (not a "YYYY-Www" label) so LineChart's
// parseDate accepts it; passing a "W"-style label produces an empty
// numericData array and crashes the chart on numericData[0].ts.
function isoWeekMonday(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() - (day - 1));
  return dt.toISOString().slice(0, 10);
}

// OLS slope over indexed (i, y) pairs. Returns y-units per +1 index step,
// or null when n<3 or variance collapses. Used for Cohort Learning Curve
// week-over-week slope and Accuracy WoW Trend snapshot slope.
function linearSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += values[i]; sumXY += i * values[i]; sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-6) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

// Latest accuracy_pct vs the snapshot closest to ~7 days prior. Returns
// {latest, prior, delta, n} or null if there are not at least 2 snapshots
// at least 3 days apart. Used by the Accuracy WoW Trend card.
function wowDelta(
  rows: { ts: string; value: number }[],
): { latest: number; prior: number; delta: number; n: number } | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  const latestT = new Date(latest.ts).getTime();
  // Walk backwards looking for the first snapshot >= 3 days older. Falls
  // back to the earliest row if no row is that old (still readable as a
  // "since first measurement" delta).
  let prior = sorted[0];
  for (let i = sorted.length - 2; i >= 0; i--) {
    const ageDays = (latestT - new Date(sorted[i].ts).getTime()) / 86_400_000;
    if (ageDays >= 3) { prior = sorted[i]; break; }
  }
  if (prior.ts === latest.ts) return null;
  return {
    latest: latest.value,
    prior: prior.value,
    delta: latest.value - prior.value,
    n: sorted.length,
  };
}

interface AccTrendPoint {
  date: string;        // computed_at YYYY-MM-DD
  value: number;       // accuracy_pct snapshot for that grader run
  window_days?: number; // present in the raw mixed-window history
}

interface CohortPoint {
  date: string;        // Monday "YYYY-MM-DD" of the ISO week the calls were MADE
  value: number;       // mean direction score for predictions MADE that week
}

// Pearson r over a (stated, realized) cloud. Shared between the
// CalibScatter SVG geometry and the HTML header strip rendered above
// the card, so both surfaces always agree on the numbers shown.
function calibPearson(points: CalibPoint[]): { r: number; r2: number; n: number } | null {
  if (points.length < 4) return null;
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.stated, 0);
  const sumY = points.reduce((a, p) => a + p.realized, 0);
  const sumXY = points.reduce((a, p) => a + p.stated * p.realized, 0);
  const sumXX = points.reduce((a, p) => a + p.stated * p.stated, 0);
  const sumYY = points.reduce((a, p) => a + p.realized * p.realized, 0);
  const denom = n * sumXX - sumX * sumX;
  const rDen = Math.sqrt(denom * (n * sumYY - sumY * sumY));
  if (!Number.isFinite(rDen) || rDen < 1e-6) return null;
  const r = (n * sumXY - sumX * sumY) / rDen;
  return { r, r2: r * r, n };
}

export default function AccuracyPage() {
  const [summary, setSummary] = useState<any[]>([]);
  const [trend, setTrend] = useState<any[]>([]);
  const [accTrend, setAccTrend] = useState<AccTrendPoint[]>([]);
  const [cohortCurve, setCohortCurve] = useState<CohortPoint[]>([]);
  const [rangeScatter, setRangeScatter] = useState<ScatterPoint[]>([]);
  const [calibScatter, setCalibScatter] = useState<CalibPoint[]>([]);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [perDimCalib, setPerDimCalib] = useState<Map<string, CalibPoint[]>>(new Map());
  const [perDimCalibPick, setPerDimCalibPick] = useState<string>("direction_1d");
  const [loading, setLoading] = useState(true);
  // Per-dimension status grid window. Backed by accuracy_summary's
  // window_days column; the grader computes 7 / 30 / 90 / 180 / 365 /
  // 1095 / 1825 / 99999 (max). Each button maps to one of those.
  const [perDimWindow, setPerDimWindow] = useState<number>(30);
  // Page-level window. Drives Section 001 (Overall Accuracy stats),
  // Section 003 (New Dimensions), Section 010 (Conviction Tier),
  // and date-filters the trend / cohort / scatter / WoW data so the
  // charts redraw to match the picked window.
  const [globalWindow, setGlobalWindow] = useState<number>(30);

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

      // Confidence calibration scatter. Each scored direction call
      // pairs the confidence stated when the call was made with the
      // grader score it landed. Both axes are 0-100 so a y=x diagonal
      // = perfect calibration; dots above the diagonal read as
      // underconfident, dots below as overconfident.
      const cPts: CalibPoint[] = [];
      for (const r of calPairs as any[]) {
        const stated = confById.get(r.analysis_id);
        if (typeof stated !== "number") continue;
        const runAt = runAtById.get(r.analysis_id);
        cPts.push({
          stated,
          realized: r.score,
          date: runAt ? String(runAt).slice(0, 10) : "",
        });
      }
      setCalibScatter(cPts);

      // Per-dim calibration_log scatter. Different spine from the
      // top-level CalibScatter above: this one reads the explicit
      // (stated_confidence, realized_score) pairs the grader writes
      // for each scored prediction per dimension. Confidence comes
      // from the dim's own outlook (nifty_outlook.confidence, etc),
      // not from analysis.confidence (which is mood-level), so the
      // scatter resolves overconfidence per-dim instead of averaging
      // every dim into one cloud.
      const { data: calRows } = await sb
        .from("calibration_log")
        .select("dimension,stated_confidence,realized_score,prediction_date")
        .limit(5000);
      const byDim = new Map<string, CalibPoint[]>();
      for (const r of (calRows || []) as any[]) {
        const dim = r.dimension;
        const s = Number(r.stated_confidence);
        const real = Number(r.realized_score);
        if (!dim || !isFinite(s) || !isFinite(real)) continue;
        const arr = byDim.get(dim) || [];
        arr.push({ stated: s, realized: real, date: String(r.prediction_date || "").slice(0, 10) });
        byDim.set(dim, arr);
      }
      setPerDimCalib(byDim);
      // Default to the dim with the most samples so the chart opens
      // populated instead of empty even when direction_1d has no rows.
      if (byDim.size) {
        let best = "direction_1d";
        let bestN = byDim.get("direction_1d")?.length || 0;
        for (const [d, pts] of byDim) {
          if (pts.length > bestN) { bestN = pts.length; best = d; }
        }
        setPerDimCalibPick(best);
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

      // ----- Cohort Learning Curve -----
      // Bucket the same direction_1d scores by the ISO week the call was
      // MADE (analysis.run_at). Each cohort point is the mean grader
      // score for predictions issued that week. An upward slope across
      // cohorts reflects later-issued predictions outperforming earlier
      // ones, which IS the engine-improvement signal (unlike Score
      // Trend, whose date-keyed curve is fixed by historical market
      // path and would climb identically for a static model).
      const byWeek = new Map<string, number[]>();
      for (const r of (scoreRows || []) as any[]) {
        const runAt = runAtById.get(r.analysis_id);
        if (!runAt || typeof r.score !== "number") continue;
        const wk = isoWeekMonday(new Date(runAt));
        const arr = byWeek.get(wk) ?? [];
        arr.push(r.score);
        byWeek.set(wk, arr);
      }
      const cohort: CohortPoint[] = Array.from(byWeek.entries())
        .map(([wk, arr]) => ({
          date: wk,
          value: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
        }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      setCohortCurve(cohort);

      // ----- Accuracy WoW Trend -----
      // Pull the FULL accuracy_summary history for direction_1d
      // across EVERY window (the earlier summary query dedupes to
      // one snapshot per (window, dim) and throws away history; we
      // need the time series). The page-level window picker then
      // filters by window_days client-side so the chart redraws
      // without re-querying. Each grader pass appends a new snapshot
      // with computed_at=now() so this is a record of how the
      // measured accuracy at each window has moved across runs.
      const { data: histRows } = await sb
        .from("accuracy_summary")
        .select("computed_at,accuracy_pct,sample_size,window_days")
        .eq("dimension", "direction_1d")
        .order("computed_at", { ascending: true })
        .limit(8000);
      // Keep the raw mixed-window history; the per-day dedupe + sort
      // happens inside a useMemo keyed on globalWindow so the chart
      // can redraw when the window picker changes without a re-query.
      // Multiple grader runs in the same day (the 17:00 cron + 17:05
      // bot scheduler + any manual triggers) each append a row, so the
      // raw history is ~3-6 points per (window, date); the memo keeps
      // the LAST write per (window, date) which is ordered ascending
      // so the last value wins via map set.
      const histAll: AccTrendPoint[] = ((histRows || []) as any[])
        .filter((r) => typeof r.accuracy_pct === "number" && r.computed_at)
        .map((r) => ({
          date: String(r.computed_at).slice(0, 10),
          value: Math.round(r.accuracy_pct * 10) / 10,
          window_days: r.window_days,
        }));
      setAccTrend(histAll);

      // ----- Range tightness vs hit rate scatter -----
      // Each scored range_1d row carries the predicted [lo, hi] band. Plot
      // band width % vs the binary hit score (100 = close inside, 0 = miss).
      // A useful range engine clusters into the top-left quadrant (tight
      // bands that still hit). A wide right column shows the model buying
      // hit rate with width. surfaces overconfidence/range inflation.
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
  // Window is the page-level picker; the same global window drives the
  // New Dimensions, Conviction Tier, and WoW chart below.
  const windowRows = summary.filter((s) => s.window_days === globalWindow);
  const dirRow = windowRows.find((s) => s.dimension === "direction_1d");
  const rngRow = windowRows.find((s) => s.dimension === "range_1d");
  const windowOpt = WINDOW_OPTS.find((o) => o.days === globalWindow) || WINDOW_OPTS[1];

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

  // Date-filtered views for sections that hang off the per-prediction
  // history (Score Trend, Cohort, scatters, top-level calibration). MAX
  // window short-circuits to "no filter". Cutoff is a YYYY-MM-DD string
  // so it compares lexicographically against each point's .date.
  const cutoff = useMemo(() => windowCutoffYMD(globalWindow), [globalWindow]);
  const filterByDate = <T extends { date: string }>(arr: T[]) =>
    globalWindow >= 99999 ? arr : arr.filter((p) => p.date >= cutoff);
  const trendW = useMemo(() => filterByDate(trend), [trend, cutoff, globalWindow]);
  const cohortW = useMemo(() => filterByDate(cohortCurve), [cohortCurve, cutoff, globalWindow]);
  const rangeScatterW = useMemo(() => filterByDate(rangeScatter), [rangeScatter, cutoff, globalWindow]);
  const calibScatterW = useMemo(() => filterByDate(calibScatter), [calibScatter, cutoff, globalWindow]);

  // Per-dim calibration cohorts also filter to the global window so
  // the picked dim's scatter matches the headline.
  const perDimCalibW = useMemo(() => {
    const out = new Map<string, CalibPoint[]>();
    for (const [d, pts] of perDimCalib) out.set(d, filterByDate(pts));
    return out;
  }, [perDimCalib, cutoff, globalWindow]);

  // Confidence-over-time series for the chart under the calibration
  // boxes. Unlike the three headline boxes (which stay fixed on the
  // standing all-time calibration, window-independent by design), this
  // trend IS windowed: it groups the date-filtered calibration cloud
  // by prediction date and plots the mean stated confidence per day so
  // the line redraws as the window swiper changes.
  const confidenceTrendW = useMemo(() => {
    const byDate = new Map<string, number[]>();
    for (const p of calibScatterW) {
      if (!p.date) continue;
      const arr = byDate.get(p.date) ?? [];
      arr.push(p.stated);
      byDate.set(p.date, arr);
    }
    return Array.from(byDate.entries())
      .map(([date, arr]) => ({
        date,
        value: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [calibScatterW]);

  // WoW chart: pick out the rows for the chosen window from the raw
  // mixed-window history, then dedupe to the last snapshot per UTC day
  // (multiple grader runs the same day would otherwise spike the line).
  const accTrendW = useMemo<AccTrendPoint[]>(() => {
    const dayMap = new Map<string, AccTrendPoint>();
    for (const r of accTrend) {
      if (r.window_days !== globalWindow) continue;
      dayMap.set(r.date, { date: r.date, value: r.value, window_days: r.window_days });
    }
    return Array.from(dayMap.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [accTrend, globalWindow]);

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Accuracy</div>
        <h1 className="headline mb-3">
          How well I have <span className="italic">Predicted.</span>
        </h1>
        <p className="sub-headline max-w-2xl">
          Every past prediction is scored against actual outcomes. The system reads these scores
          before every new call, calibrating itself over time. Trigger a fresh grading pass from
          the nav sync button at the top right.
        </p>
      </div>

      <Section num={calibration ? "001 / 011" : "001 / 010"} title="Overall Accuracy" glyph="✦">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat
            label="Direction accuracy"
            value={dirAcc == null ? "·" : `${dirAcc.toFixed(1)}%`}
            delta={dirEdgeLabel}
            glyph="◎"
          />
          <Stat
            label="Range hit rate"
            value={rngAcc == null ? "·" : `${rngAcc.toFixed(1)}%`}
            delta={rngBandLabel}
            glyph="◈"
          />
          <Stat
            label="Sessions scored"
            value={dirN.toString()}
            delta={windowOpt.fullLabel}
            glyph="⬡"
          />
          <WindowSwiper value={globalWindow} onChange={setGlobalWindow} />
        </div>
      </Section>

      {calibration && (
        <Section
          num="002 / 011"
          title="Confidence Calibration"
          glyph="◉"
          description="Does the stated confidence match the direction accuracy actually delivered? An honest model's gap sits near zero. The three boxes show the standing calibration and do not move with the window; the chart below tracks stated confidence over time and redraws to the picked window."
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
              glyph="⬡"
            />
          </div>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.14 }}
            className="card p-6 mt-4"
          >
            <div className="section-num mb-3">Stated Confidence Over Time · {windowOpt.label}</div>
            {confidenceTrendW.length >= TREND_MIN_POINTS ? (
              <LineChart
                data={confidenceTrendW}
                height={300}
                color="var(--foreground)"
                valueLabel="Stated Confidence"
                yTickFormatter={(v) => `${Math.round(v)}%`}
                valueFormatter={(v) => `${v.toFixed(1)}%`}
              />
            ) : (
              <div
                style={{ height: 300 }}
                className="flex flex-col items-center justify-center text-center gap-2"
              >
                <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
                <p className="text-sm text-[var(--muted)]">
                  Confidence trend appears once at least {TREND_MIN_POINTS} calls with stated confidence are scored in the {windowOpt.fullLabel} window.
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {confidenceTrendW.length} day{confidenceTrendW.length === 1 ? "" : "s"} so far.
                </p>
              </div>
            )}
          </motion.div>
        </Section>
      )}

      <Section
        num={calibration ? "003 / 011" : "002 / 010"}
        title="New Dimensions"
        glyph="◉"
        description="Headline accuracy on the recently-added graded dims. Empty cells populate once the next grader pass scores them."
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {(["market_mood_1d", "insight_quality", "cap_pair_1d", "fii_flow_1d", "index_pair_1d"] as const).map((dim) => {
            const row = summary.find((s) => s.window_days === globalWindow && s.dimension === dim);
            const acc = row?.accuracy_pct ?? null;
            const n = row?.sample_size ?? 0;
            return (
              <Stat
                key={dim}
                label={DIMENSION_LABELS[dim]}
                value={acc == null ? "·" : `${acc.toFixed(1)}%`}
                delta={acc == null ? "awaiting first grade" : `${n} scored · ${windowOpt.label}`}
                glyph="◎"
              />
            );
          })}
        </div>
      </Section>

      <Section num={calibration ? "004 / 011" : "003 / 010"} title="Score Trend" glyph="⬡" description="Trailing 10-prediction rolling direction score, indexed by the date each call was MADE. This is a record of outcomes on a date-by-date basis, not a learning signal: the grader re-scores the whole 90d lookback every run so each point is fixed by how the market actually moved that day. A static engine that never adapted would produce the same shape. For the real engine-improvement signal see Cohort Learning Curve below.">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.16 }}
          className="card p-6"
        >
          {trendW.length >= TREND_MIN_POINTS ? (
            <LineChart
              data={trendW}
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
                Collecting data. The trend appears once at least {TREND_MIN_POINTS} sessions are scored in the {windowOpt.fullLabel} window.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {trendW.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "005 / 011" : "004 / 010"}
        title="Cohort Learning Curve"
        glyph="◈"
        description="Bucket each direction_1d call by the ISO week it was MADE, plot the mean grader score per week. An upward slope across cohorts means later-issued predictions outperform earlier ones, which IS engine improvement (corrective_rules + sensei feedback actually moving the needle). A flat or downward slope means in-context feedback is not yet translating into better calls."
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.18 }}
          className="card p-6"
        >
          {cohortW.length >= 3 ? (
            <>
              {(() => {
                const slope = linearSlope(cohortW.map((p) => p.value));
                const first = cohortW[0].value;
                const last = cohortW[cohortW.length - 1].value;
                const delta = last - first;
                const verdict =
                  slope == null
                    ? "n too small"
                    : slope > 0.5
                    ? "improving"
                    : slope < -0.5
                    ? "regressing"
                    : "flat";
                return (
                  <div className="mb-4">
                    <div className="text-sm font-medium text-foreground">
                      Slope: {slope == null ? "·" : `${slope >= 0 ? "+" : ""}${slope.toFixed(2)} pts per week`}
                      <span className="ml-2 text-[var(--muted)]">· {verdict}</span>
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-1 num">
                      First cohort {first.toFixed(1)} → latest {last.toFixed(1)}
                      {" · "}Δ {delta >= 0 ? "+" : ""}{delta.toFixed(1)} pts over {cohortW.length} cohort weeks
                    </div>
                  </div>
                );
              })()}
              <LineChart
                data={cohortW}
                height={320}
                color="var(--foreground)"
                valueLabel="Cohort Mean"
                yTickFormatter={(v) => `${Math.round(v)}%`}
                valueFormatter={(v) => `${v.toFixed(1)}%`}
              />
            </>
          ) : (
            <div
              style={{ height: 280 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Cohort curve appears once at least 3 distinct prediction-weeks are scored in the {windowOpt.fullLabel} window.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {cohortW.length} cohort weeks so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "006 / 011" : "005 / 010"}
        title="Accuracy Week Over Week"
        glyph="⬡"
        description={`Each grader run appends a new accuracy_summary snapshot. This chart trends the ${windowOpt.fullLabel} direction accuracy across those snapshots over time. Unlike Score Trend (per-prediction date) and Cohort Learning Curve (per prediction-week), this plots how the rolling-${windowOpt.label} measurement itself has moved run over run, the literal answer to 'is my ${windowOpt.label} accuracy higher this week than last week'.`}
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="card p-6"
        >
          {accTrendW.length >= 2 ? (
            <>
              {(() => {
                const wow = wowDelta(
                  accTrendW.map((p) => ({ ts: p.date, value: p.value })),
                );
                const slope = linearSlope(accTrendW.map((p) => p.value));
                return (
                  <div className="mb-4">
                    <div className="text-sm font-medium text-foreground">
                      {wow == null
                        ? "Awaiting a second snapshot"
                        : `WoW: ${wow.prior.toFixed(1)} → ${wow.latest.toFixed(1)} (${wow.delta >= 0 ? "+" : ""}${wow.delta.toFixed(1)} pts)`}
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-1 num">
                      Slope: {slope == null ? "·" : `${slope >= 0 ? "+" : ""}${slope.toFixed(2)} pts per snapshot`}
                      {" · "}n = {accTrendW.length} snapshots
                    </div>
                  </div>
                );
              })()}
              <LineChart
                data={accTrendW}
                height={320}
                color="var(--foreground)"
                valueLabel={`${windowOpt.label} Accuracy`}
                yTickFormatter={(v) => `${Math.round(v)}%`}
                valueFormatter={(v) => `${v.toFixed(1)}%`}
              />
            </>
          ) : (
            <div
              style={{ height: 280 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                WoW trend appears once at least 2 grader runs have written {windowOpt.label} snapshots.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {accTrendW.length} snapshot{accTrendW.length === 1 ? "" : "s"} so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "007 / 011" : "006 / 010"}
        title="Range Tightness vs Hit Rate"
        glyph="◈"
        description="X-axis: predicted band width as percent of midpoint. Y-axis: grader score 0-100 (tight hit nears 100, miss collapses below 40). Useful cluster sits top-left: tight bands that still hit. The trend line falling left-to-right means width is buying score; a flat or rising line means the engine is calibrated."
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.24 }}
          className="card p-6"
        >
          {rangeScatterW.length >= 3 ? (
            <>
              {(() => {
                const s = rangeStats(rangeScatterW);
                if (!s) return null;
                return (
                  <div className="mb-4">
                    <div className="text-sm font-medium text-foreground">
                      Trend: {s.slope >= 0 ? "+" : ""}
                      {s.slope.toFixed(1)} score per +1% width
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-1 num">
                      R² = {s.r2.toFixed(3)} · r = {s.r >= 0 ? "+" : ""}
                      {s.r.toFixed(3)} · n = {s.n}
                    </div>
                  </div>
                );
              })()}
              <RangeScatter points={rangeScatterW} />
            </>
          ) : (
            <div
              style={{ height: 280 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Collecting data. Scatter appears once at least 3 range predictions are scored in the {windowOpt.fullLabel} window.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {rangeScatterW.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "008 / 011" : "007 / 010"}
        title="Confidence vs Realized Accuracy"
        glyph="◎"
        description="Each dot is one direction call. X-axis: confidence stated when the call was made. Y-axis: graded score for that day. Both axes 0-100, so the diagonal line is perfect calibration (stated equals delivered). Dots above the line read as underconfident; dots below as overconfident. R is the Pearson correlation; tight to 1 = stated confidence reliably tracks realized hit rate."
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.26 }}
          className="card p-6"
        >
          {calibScatterW.length >= 4 ? (
            <>
              {(() => {
                const stat = calibPearson(calibScatterW);
                if (!stat) return null;
                return (
                  <div className="mb-4">
                    <div className="text-sm italic font-medium text-foreground">
                      R = {stat.r >= 0 ? "+" : ""}
                      {stat.r.toFixed(3)}, R² = {stat.r2.toFixed(3)}, n = {stat.n}
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-1">
                      R: -1 to +1, sign shows direction · R²: 0 to 1, strength of fit
                    </div>
                  </div>
                );
              })()}
              <CalibScatter points={calibScatterW} />
            </>
          ) : (
            <div
              style={{ height: 280 }}
              className="flex flex-col items-center justify-center text-center gap-2"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <p className="text-sm text-[var(--muted)]">
                Collecting data. Scatter appears once at least 4 direction calls with stated
                confidence are scored in the {windowOpt.fullLabel} window.
              </p>
              <p className="text-xs text-[var(--muted)]">
                {calibScatterW.length} scored so far.
              </p>
            </div>
          )}
        </motion.div>
      </Section>

      <Section
        num={calibration ? "009 / 011" : "008 / 010"}
        title="Per-Dim Confidence Calibration"
        glyph="◐"
        description="Same diagonal-is-perfect read as the section above, but each dimension on its own axis. Confidence here is the per-dim outlook confidence the grader pairs with the dim's own realized score (calibration_log), not the analysis-level mood confidence. A dim that overclaims confidence shows dots below the diagonal; an underconfident dim sits above."
      >
        {(() => {
          const dims = Array.from(perDimCalibW.keys()).sort(
            (a, b) => (perDimCalibW.get(b)?.length || 0) - (perDimCalibW.get(a)?.length || 0),
          );
          if (dims.length === 0 || dims.every((d) => (perDimCalibW.get(d)?.length || 0) === 0)) {
            return (
              <EmptyState
                title="No per-dim calibration data in this window"
                hint="Switch to a longer window above, or wait for the next grader pair (08:30 IST analysis + 17:00 IST grader) to land more rows in the current window."
              />
            );
          }
          const pickedPts = perDimCalibW.get(perDimCalibPick) || [];
          const stat = calibPearson(pickedPts);
          return (
            <>
              <div className="h-scroll flex gap-1.5 -mx-1 px-1 mb-4">
                {dims.map((d) => (
                  <button
                    key={d}
                    onClick={() => setPerDimCalibPick(d)}
                    className={`shrink-0 px-3 py-1.5 text-xs rounded-md border border-border transition-colors whitespace-nowrap ${
                      perDimCalibPick === d
                        ? "bg-foreground text-background"
                        : "hover:bg-[var(--muted-bg)]"
                    }`}
                  >
                    {DIMENSION_LABELS[d] || d} ({perDimCalibW.get(d)?.length || 0})
                  </button>
                ))}
              </div>
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="card p-6"
              >
                {pickedPts.length >= 4 && stat ? (
                  <>
                    <div className="mb-4">
                      <div className="text-sm italic font-medium text-foreground">
                        R = {stat.r >= 0 ? "+" : ""}
                        {stat.r.toFixed(3)}, R² = {stat.r2.toFixed(3)}, n = {stat.n}
                      </div>
                      <div className="text-xs text-[var(--muted)] mt-1">
                        Dimension: {DIMENSION_LABELS[perDimCalibPick] || perDimCalibPick}
                      </div>
                    </div>
                    <CalibScatter points={pickedPts} />
                  </>
                ) : (
                  <div
                    style={{ height: 280 }}
                    className="flex flex-col items-center justify-center text-center gap-2"
                  >
                    <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
                    <p className="text-sm text-[var(--muted)]">
                      Scatter renders once at least 4 graded predictions land in this dim.
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      {pickedPts.length} scored so far.
                    </p>
                  </div>
                )}
              </motion.div>
            </>
          );
        })()}
      </Section>

      <Section
        num={calibration ? "010 / 011" : "009 / 010"}
        title="Conviction Tier Performance"
        glyph="◉"
        description="Stratified pick alpha by conviction label. A-tier alpha should exceed B; B should exceed C. Flat results across tiers means the labels carry no signal and the prompt needs tightening."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {([
            { tier: "A", dim: "short_pick_A_7d" as const, gloss: "Highest conviction. All three pillars aligned (technicals + news + sector). Capped at 0-2 per day.", pill: "pill-gain" },
            { tier: "B", dim: "short_pick_B_7d" as const, gloss: "Solid setup. Two of three pillars aligned. Bulk of picks.", pill: "pill-mid" },
            { tier: "C", dim: "short_pick_C_7d" as const, gloss: "Speculative / asymmetric. One pillar strong, signal incomplete. Sparingly.", pill: "pill-warn" },
          ]).map(({ tier, dim, gloss, pill }) => {
            const row = summary.find((s) => s.window_days === globalWindow && s.dimension === dim);
            const acc = row?.accuracy_pct ?? null;
            const n = row?.sample_size ?? 0;
            // Card accent border + tier badge color use the conviction-tier
            // palette (A=gain, B=neutral, C=warn) so the tier identity is
            // legible at a glance. The big accuracy number stays
            // performance-colored (acc>=65 gain, >=50 warn, <50 loss) so a
            // green A-tier with a red number visibly flags "we labeled
            // these high conviction but they did not deliver".
            return (
              <div key={tier} className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className={`pill ${pill}`} style={{ minWidth: 50, justifyContent: "center" }}>
                    Tier {tier}
                  </span>
                  <span className="num text-xs text-[var(--muted)]">
                    {n} scored
                  </span>
                </div>
                <div className="section-num mb-1">{windowOpt.label} alpha</div>
                <div className="text-3xl font-semibold">
                  {acc == null ? "·" : `${acc.toFixed(1)}%`}
                </div>
                <p className="text-sm text-[var(--muted)] leading-relaxed mt-3">{gloss}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        num={calibration ? "011 / 011" : "010 / 010"}
        title="Reading These Numbers Honestly"
        glyph="◆"
        description="Where the data is now, what the percentages can and cannot tell you yet, and the milestones each dimension has to clear before a reading becomes a conclusion instead of a directional signal."
      >
        <div className="space-y-4">
          {/* 1. Where we stand right now */}
          <div className="card p-5">
            <div className="section-num mb-2">Current Sample Size</div>
            <div className="text-2xl font-semibold mb-2 flex items-center gap-3 flex-wrap">
              <span>{maxSamples} scored sessions</span>
              <span className="pill">
                {lowConfidence ? "Low confidence" : "Sufficient confidence"}
              </span>
            </div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Reliability threshold sits at {CONFIDENCE_MIN_SAMPLES} scored
              sessions. Below that, a hit rate carries roughly ±20 points of
              binomial uncertainty (95% Wilson interval), so a number like 55%
              and a number like 70% are statistically indistinguishable. Above
              that, the confidence band tightens to about ±5-10 points and the
              numbers start to mean something.
            </p>
          </div>

          {/* 2. Why the uncertainty math is what it is */}
          <div className="card p-5">
            <div className="section-num mb-2">Why ±20 Points</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Every dimension is a coin-flip-style trial: hit or miss against a
              deterministic grader. At n=23 the 95% confidence interval on a
              60% hit rate covers roughly 40-78%. At n=100 the same point
              estimate carries an interval of 50-69%. At n=300 it tightens to
              55-65%. The percentages on this page do not change their math
              when you stare at them harder; only more samples narrow the band.
            </p>
          </div>

          {/* 3. Maturity milestones */}
          <div className="card overflow-hidden">
            <div className="p-5 pb-2">
              <div className="section-num mb-1">Maturity Milestones</div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">
                What each sample-size threshold unlocks. Headline accuracy on
                the cards above sits at one column of this table.
              </p>
            </div>
            <div className="table-scroll">
            <table className="data" style={{ width: "100%" }}>
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "22%" }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>Sessions</th>
                  <th>Status</th>
                  <th>What's honest to claim</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num font-medium">&lt; 10</td>
                  <td><span className="pill pill-warn">Cold start</span></td>
                  <td className="text-[var(--muted)]">
                    No signal yet. Hit rates here are noise. direction
                    accuracy can read 80% one day and 30% the next on the same
                    underlying engine. Watch the trend chart, not the headline.
                  </td>
                </tr>
                <tr>
                  <td className="num font-medium">10 - 29</td>
                  <td><span className="pill pill-warn">Building</span></td>
                  <td className="text-[var(--muted)]">
                    First sense of bias direction: is the engine consistently
                    above or below 50% on direction calls? Confidence interval
                    still ±20 pts. Useful for calibration drift detection (does
                    stated confidence track realized?), NOT for ranking dims.
                  </td>
                </tr>
                <tr>
                  <td className="num font-medium">30 - 99</td>
                  <td><span className="pill pill-mid">Settling</span></td>
                  <td className="text-[var(--muted)]">
                    CI narrows to about ±12 pts. Cross-dimensional ranking
                    becomes meaningful (direction vs range vs sectors).
                    Conviction tier stratification first becomes testable
                    here. Still cautious on absolute claims.
                  </td>
                </tr>
                <tr>
                  <td className="num font-medium">100 - 299</td>
                  <td><span className="pill pill-gain">Stable</span></td>
                  <td className="text-[var(--muted)]">
                    CI ±8 pts. Headline accuracy means what it says. Per-dim
                    comparisons are reliable. Calibration gap is trustworthy.
                    Self-feedback rules derived from misses at this size
                    actually correct future calls instead of overfitting.
                  </td>
                </tr>
                <tr>
                  <td className="num font-medium">&gt;= 300</td>
                  <td><span className="pill pill-gain">Regime-aware</span></td>
                  <td className="text-[var(--muted)]">
                    CI ±5 pts. Conditional accuracy starts to mean something:
                    "direction hit rate when VIX &gt; 18" or "range hit rate
                    in expiry weeks" become real claims. This is where the
                    engine moves from "is it any good" to "where is it good".
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>

          {/* 4. Per-dim status. one box per dimension instead of a
              dense table row so each card reads as a discrete data
              point and the maturity ladder is visible at a glance. */}
          <div className="card p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <div className="section-num mb-1">Per-Dimension Status</div>
                <p className="text-sm text-[var(--muted)] leading-relaxed">
                  Sample size per dimension within the selected window,
                  plus where each sits on the maturity ladder. A dimension
                  with 4 scored sessions cannot be compared to one with
                  50. the smaller-n hit rate is a guess, not a measurement.
                </p>
              </div>
              <div className="h-scroll flex gap-1 -mx-1 px-1">
                {([
                  { label: "1W", days: 7 },
                  { label: "1M", days: 30 },
                  { label: "3M", days: 90 },
                  { label: "6M", days: 180 },
                  { label: "1Y", days: 365 },
                  { label: "3Y", days: 1095 },
                  { label: "5Y", days: 1825 },
                  { label: "MAX", days: 99999 },
                ] as const).map(({ label, days }) => {
                  const active = perDimWindow === days;
                  return (
                    <button
                      key={days}
                      type="button"
                      onClick={() => setPerDimWindow(days)}
                      className="shrink-0 text-xs font-medium tracking-wide rounded-full px-3 py-1 border transition-colors"
                      style={{
                        borderColor: active ? "var(--foreground)" : "var(--border)",
                        background: active ? "var(--foreground)" : "transparent",
                        color: active ? "var(--background)" : "var(--muted)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {Object.keys(DIMENSION_LABELS).map((dim) => {
                const r = summary.find((s) => s.window_days === perDimWindow && s.dimension === dim);
                const n = r?.sample_size ?? 0;
                if (n === 0) return null;
                const acc = r?.accuracy_pct;
                const status =
                  n < 10
                    ? { label: "Cold start", cls: "pill-warn", accent: "var(--warn)" }
                    : n < 30
                    ? { label: "Building", cls: "pill-warn", accent: "var(--warn)" }
                    : n < 100
                    ? { label: "Settling", cls: "pill-mid", accent: "var(--mid)" }
                    : n < 300
                    ? { label: "Stable", cls: "pill-gain", accent: "var(--gain)" }
                    : { label: "Regime-aware", cls: "pill-gain", accent: "var(--gain)" };
                return (
                  <div
                    key={dim}
                    className="rounded-2xl border border-border p-4 flex flex-col gap-2 transition-colors hover:bg-[var(--muted-bg)]"
                    style={{
                      borderColor: `color-mix(in srgb, ${status.accent} 35%, var(--border))`,
                    }}
                  >
                    <div className="text-xs text-[var(--muted)] tracking-wide uppercase leading-tight">
                      {DIMENSION_LABELS[dim]}
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-2xl font-semibold num">{n}</span>
                      <span className="text-[10px] text-[var(--muted)] tracking-wider uppercase">
                        scored {
                          perDimWindow === 7 ? "1W" :
                          perDimWindow === 30 ? "1M" :
                          perDimWindow === 90 ? "3M" :
                          perDimWindow === 180 ? "6M" :
                          perDimWindow === 365 ? "1Y" :
                          perDimWindow === 1095 ? "3Y" :
                          perDimWindow === 1825 ? "5Y" : "MAX"
                        }
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`pill ${status.cls}`} style={{ fontSize: 11 }}>
                        {status.label}
                      </span>
                      {typeof acc === "number" && (
                        <span className="text-xs num text-[var(--muted)]">
                          {acc.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 5. Decision rules. when to act, when to wait */}
          <div className="card p-5">
            <div className="section-num mb-2">When To Act, When To Wait</div>
            <ul className="list-disc pl-5 space-y-2 text-sm text-[var(--muted)] leading-relaxed">
              <li>
                <span className="text-foreground font-medium">Cold start / Building (n &lt; 30).</span>{" "}
                Read the calibration gap, not the headline. If stated confidence
                matches realized accuracy within ±10 pts, the engine is being
                honest about its own uncertainty. that is the signal that
                matters most at this size, even when the percentage itself is
                noisy.
              </li>
              <li>
                <span className="text-foreground font-medium">Settling (n 30-99).</span>{" "}
                Begin comparing dimensions against each other (range usually
                beats direction; direction usually beats picks; multi-day usually
                beats 1-day). Watch the Cohort Learning Curve slope, not the
                Score Trend: an upward cohort slope means later weeks of
                predictions are outperforming earlier ones, which is the actual
                self-feedback signal. Score Trend is fixed by historical market
                path and will climb identically for a static engine.
              </li>
              <li>
                <span className="text-foreground font-medium">Stable (n &gt;= 100).</span>{" "}
                Treat the headline number as the engine's true edge. A direction
                accuracy that has held above 58% for 100+ sessions is real edge
                over a coin flip; the same number on 20 sessions is not yet.
              </li>
              <li>
                <span className="text-foreground font-medium">Always.</span>{" "}
                Conviction tier A picks should beat B should beat C. If tiers
                flatten, the labels carry no signal. that is a prompt problem,
                not a data problem.
              </li>
            </ul>
          </div>

          {/* 6. Source of truth. what the grader actually does */}
          <div className="card p-5">
            <div className="section-num mb-2">Where The Scores Come From</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Every prediction_scores row is written by a deterministic
              grader that walks actual yfinance closes for the prediction's
              tickers. No LLM scores itself; the grader is plain Python
              comparing the call against the actual market move with a
              horizon-scaled flat band (0.4% at 1d, 1.2% at 5d, 2.5% at 20d).
              insight_quality is the one auditor that reads text, and it
              scores number-density + payload-citation - banned-hedges with
              no model in the loop. Same code grades every call, so the
              comparison across sessions is apples-to-apples.
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}

// Window picker styled as one of the Overall Accuracy stat boxes. The
// box itself is a single-slide swipe carousel: only ONE window shows at
// a time, and a horizontal swipe (touch) or drag (mouse) snaps to the
// next/previous window, which becomes the selection. Dots below double
// as an affordance and as tap targets to jump to any window. Matches
// the Stat card layout (label row + big value) so it reads as the 4th
// box in the grid, not a separate full-width strip.
function WindowSwiper({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Fires the commit only after scrolling has fully STOPPED (idle).
  // Reading the resting position instead of mid-flight positions is
  // what fixes the desync where the track snapped to one slide but the
  // committed value lagged on another: a per-event rAF could read an
  // intermediate momentum position and then miss the final settle.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeIdx = Math.max(0, WINDOW_OPTS.findIndex((o) => o.days === value));

  // Index of the slide currently nearest the track centre, regardless of
  // committed value. Read by helpers below.
  const nearestIdx = (track: HTMLDivElement): number => {
    const center = track.scrollLeft + track.clientWidth / 2;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < WINDOW_OPTS.length; i++) {
      const slide = track.children[i] as HTMLElement | undefined;
      if (!slide) continue;
      const slideCenter = slide.offsetLeft + slide.clientWidth / 2;
      const d = Math.abs(slideCenter - center);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  // Keep the active slide aligned with the committed value. Only scrolls
  // when the track is NOT already on that slide, so a swipe-driven value
  // change (where the track is already there) does not trigger a second
  // redundant scroll that fights the native snap. Mount + dot taps DO
  // scroll because the track starts elsewhere.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const slide = track.children[activeIdx] as HTMLElement | undefined;
    if (!slide) return;
    if (Math.abs(track.scrollLeft - slide.offsetLeft) < 2) return;
    track.scrollTo({ left: slide.offsetLeft, behavior: "smooth" });
  }, [activeIdx]);

  // On every scroll event, reset an idle timer. When scrolling has been
  // quiet for 110ms the track has settled on a snap point; read the
  // resting slide and commit it. A programmatic scroll-to-value settles
  // on value's own slide, so nearest === value and this no-ops, meaning
  // there is no echo loop to suppress.
  const onScroll = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      const track = trackRef.current;
      if (!track) return;
      const next = WINDOW_OPTS[nearestIdx(track)].days;
      if (next !== value) onChange(next);
    }, 110);
  };

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  return (
    <div className="card p-5 overflow-hidden">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="section-num whitespace-nowrap">Window · swipe</div>
        <span className="glyph text-sm shrink-0">◉</span>
      </div>
      {/* One slide visible at a time. Each slide is min-width 100% of
          the track so a swipe moves exactly one window. scroll-snap
          keeps it from resting between slides; touch-action pan-x lets
          a horizontal drag swipe the carousel while a vertical drag
          still scrolls the page. */}
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="h-scroll flex"
        style={{ scrollSnapType: "x mandatory", touchAction: "pan-x" }}
      >
        {WINDOW_OPTS.map(({ label, days, fullLabel }, i) => {
          const active = i === activeIdx;
          return (
            <div
              key={days}
              style={{ minWidth: "100%", flexShrink: 0, scrollSnapAlign: "center" }}
            >
              {/* Fade + slight lift the active slide so the swipe has a
                  perceptible state change beyond the scroll itself. */}
              <div
                className="transition-opacity duration-300"
                style={{ opacity: active ? 1 : 0.45 }}
              >
                <div className="text-xl sm:text-2xl font-semibold tracking-tight num">
                  {fullLabel}
                </div>
                <div className="text-xs mt-1 num font-medium text-[var(--muted)]">
                  {label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Position dots. Active dot stretches into a pill; tapping any
          dot jumps to that window. */}
      <div className="flex gap-1.5 mt-3">
        {WINDOW_OPTS.map((o, i) => (
          <button
            key={o.days}
            type="button"
            aria-label={o.fullLabel}
            onClick={() => onChange(o.days)}
            className="h-1.5 rounded-full transition-all duration-300 ease-out"
            style={{
              width: i === activeIdx ? 18 : 6,
              background: i === activeIdx ? "var(--foreground)" : "var(--border)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function RangeScatter({ points }: { points: ScatterPoint[] }) {
  // Inline SVG scatter so we do not pull a second chart library.
  // X = band width % of midpoint, Y = grader score 0-100 (continuous:
  // grade_range returns 100 - width_penalty on a hit and 0-30 on a
  // miss). Horizontal gridlines at 0/25/50/75/100, vertical gridlines
  // at each x tick, and a least-squares regression line carry the read
  // the way the user's example chart does.
  // Fill the card. SVG scales width 100% on render so what controls the
  // visible size is the viewBox aspect ratio plus the explicit height.
  // Old 760x360 left ~40% empty space inside the surrounding card; this
  // sizing brings the plot area up to where the example chart sits.
  const H = 520;
  const W = 980;
  const padL = 78;
  const padR = 32;
  const padT = 28;
  const padB = 78;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Round the upper x bound up to a clean number so ticks read as 0%
  // / 0.5% / 1% / ... instead of an awkward "2.36%".
  const rawMax = Math.max(2, ...points.map((p) => p.width));
  const niceMaxX = (() => {
    if (rawMax <= 1) return 1;
    if (rawMax <= 2) return 2;
    if (rawMax <= 3) return 3;
    if (rawMax <= 5) return Math.ceil(rawMax);
    return Math.ceil(rawMax / 2) * 2;
  })();
  const xScale = (x: number) =>
    padL + (Math.min(Math.max(x, 0), niceMaxX) / niceMaxX) * innerW;
  // y range 0-100; invert because SVG y grows downward
  const yScale = (y: number) => padT + innerH - (y / 100) * innerH;

  const yTicks = [0, 25, 50, 75, 100];
  // Five x ticks evenly across the range: 0, 25%, 50%, 75%, 100% of niceMaxX
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    Math.round(f * niceMaxX * 100) / 100,
  );

  // Linear least-squares regression line + Pearson correlation. Slope
  // reads as "score moved per +1% width"; r and r-squared measure how
  // tightly the cloud hugs the line. r-squared is bounded 0..1 (the
  // "correlation can't be greater than one" the user asked for); r is
  // signed -1..+1 so the sign agrees with the slope.
  let regression: {
    x1: number; y1: number; x2: number; y2: number;
    slope: number; r: number; r2: number;
  } | null = null;
  if (points.length >= 4) {
    const n = points.length;
    const sumX = points.reduce((a, p) => a + p.width, 0);
    const sumY = points.reduce((a, p) => a + p.score, 0);
    const sumXY = points.reduce((a, p) => a + p.width * p.score, 0);
    const sumXX = points.reduce((a, p) => a + p.width * p.width, 0);
    const sumYY = points.reduce((a, p) => a + p.score * p.score, 0);
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) > 1e-6) {
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      // Pearson r. Guarded against a zero-variance y (every score
      // identical, would mean the cloud is a flat line and r is
      // undefined; fall back to 0 then).
      const rDenom = Math.sqrt(denom * (n * sumYY - sumY * sumY));
      const r = rDenom > 1e-6 ? (n * sumXY - sumX * sumY) / rDenom : 0;
      const r2 = r * r;
      const yAtZero = intercept;
      const yAtMax = intercept + slope * niceMaxX;
      // Clamp inside the [0, 100] window so the line never sails off
      // the plot area when the slope is steep.
      const clamp = (v: number) => Math.max(0, Math.min(100, v));
      regression = {
        x1: xScale(0),
        y1: yScale(clamp(yAtZero)),
        x2: xScale(niceMaxX),
        y2: yScale(clamp(yAtMax)),
        slope,
        r,
        r2,
      };
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="h-auto block"
    >
      {/* Horizontal gridlines at every y tick. Lighter than the axis
          line so the eye still picks the axis out. */}
      {yTicks.map((t) => (
        <line
          key={`gh-${t}`}
          x1={padL}
          x2={padL + innerW}
          y1={yScale(t)}
          y2={yScale(t)}
          stroke="var(--border)"
          strokeOpacity={t === 0 ? 1 : 0.35}
          strokeDasharray={t === 0 ? "" : "2 4"}
        />
      ))}
      {/* Vertical gridlines at every x tick. Skip the leftmost so it
          does not double-paint the y-axis line. */}
      {xTicks.map((t, i) =>
        i === 0 ? null : (
          <line
            key={`gv-${i}`}
            x1={xScale(t)}
            x2={xScale(t)}
            y1={padT}
            y2={padT + innerH}
            stroke="var(--border)"
            strokeOpacity={0.35}
            strokeDasharray="2 4"
          />
        ),
      )}
      {/* y axis */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="var(--border)" />
      {/* x axis sits at y=0 already covered by the y=0 gridline above */}

      {/* Hit/miss split at y=50, drawn brighter than the regression so
          the useful "top half" still reads at a glance. */}
      <line
        x1={padL}
        y1={yScale(50)}
        x2={padL + innerW}
        y2={yScale(50)}
        stroke="var(--muted)"
        strokeDasharray="4 4"
        opacity="0.55"
      />

      {/* y tick labels */}
      {yTicks.map((t) => (
        <text
          key={`yl-${t}`}
          x={padL - 12}
          y={yScale(t) + 4}
          textAnchor="end"
          fontSize="11"
          fill="var(--muted)"
        >
          {t}
        </text>
      ))}
      {/* x tick labels */}
      {xTicks.map((t, i) => (
        <text
          key={`xl-${i}`}
          x={xScale(t)}
          y={padT + innerH + 22}
          textAnchor="middle"
          fontSize="11"
          fill="var(--muted)"
        >
          {t}%
        </text>
      ))}
      {/* axis captions */}
      <text x={padL + innerW / 2} y={H - 14} textAnchor="middle" fontSize="11" fill="var(--muted)">
        Band width (% of midpoint)
      </text>
      <text
        x={18}
        y={padT + innerH / 2}
        textAnchor="middle"
        fontSize="11"
        fill="var(--muted)"
        transform={`rotate(-90 18 ${padT + innerH / 2})`}
      >
        Score
      </text>

      {/* Regression line + statistics. Solid foreground stroke so it
          reads as the headline trend. R-squared is the "correlation
          can't be greater than one" stat (bounded 0..1); r carries the
          sign so the direction of the relationship is explicit. */}
      {regression && (
        <line
          x1={regression.x1}
          y1={regression.y1}
          x2={regression.x2}
          y2={regression.y2}
          stroke="var(--foreground)"
          strokeWidth={2}
          opacity={0.7}
        />
      )}

      {/* Points. Larger and fully opaque to match the example's clean
          dot density. */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={xScale(p.width)}
          cy={yScale(p.score)}
          r="6"
          fill={p.score >= 50 ? "var(--gain)" : "var(--loss)"}
        >
          <title>{`${p.date}: width ${p.width}%, score ${p.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function CalibScatter({ points }: { points: CalibPoint[] }) {
  // Confidence calibration scatter. Both axes are 0-100, so the y=x
  // diagonal is the perfect-calibration reference: a dot lands ON the
  // line when stated confidence exactly matches realized score. Above
  // the line = underconfident, below = overconfident. The blue stroke
  // is that reference line; the foreground stroke is the actual
  // least-squares regression through the cloud. R-squared and Pearson
  // r read as "how reliably stated confidence tracks realized accuracy"
  // and live top-left like the example image.
  // Wide canvas + no maxWidth cap so the SVG fills the card. The old
  // 600x560 box with a 720px maxWidth letterboxed everything inside a
  // ~1200px card. Both axes still cover 0..100 so a square plot area
  // is preserved by the inner padding ratio (inner ~820x440).
  const H = 540;
  const W = 960;
  const padL = 78;
  const padR = 32;
  const padT = 28;
  const padB = 72;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xScale = (x: number) => padL + (Math.max(0, Math.min(100, x)) / 100) * innerW;
  const yScale = (y: number) => padT + innerH - (Math.max(0, Math.min(100, y)) / 100) * innerH;

  const ticks = [0, 20, 40, 60, 80, 100];

  // R / R-squared / n now live in an HTML strip above this chart
  // (rendered by the parent section) so the numbers stay crisp at any
  // zoom and the SVG carries only geometry.

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="h-auto block"
    >
      {/* Gridlines */}
      {ticks.map((t) => (
        <g key={`grid-${t}`}>
          <line
            x1={padL}
            x2={padL + innerW}
            y1={yScale(t)}
            y2={yScale(t)}
            stroke="var(--border)"
            strokeOpacity={t === 0 ? 1 : 0.32}
            strokeDasharray={t === 0 ? "" : "2 4"}
          />
          {t !== 0 && (
            <line
              x1={xScale(t)}
              x2={xScale(t)}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--border)"
              strokeOpacity={0.32}
              strokeDasharray="2 4"
            />
          )}
        </g>
      ))}
      {/* y axis spine */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + innerH} stroke="var(--border)" />

      {/* y = x perfect-calibration diagonal. Drawn under the dots so
          the dots read on top of it, like the example image. */}
      <line
        x1={xScale(0)}
        y1={yScale(0)}
        x2={xScale(100)}
        y2={yScale(100)}
        stroke="#3b82f6"
        strokeWidth={2}
        opacity={0.85}
      />

      {/* Axis tick labels */}
      {ticks.map((t) => (
        <text
          key={`yl-${t}`}
          x={padL - 12}
          y={yScale(t) + 4}
          textAnchor="end"
          fontSize={12}
          fill="var(--muted)"
        >
          {t}
        </text>
      ))}
      {ticks.map((t) => (
        <text
          key={`xl-${t}`}
          x={xScale(t)}
          y={padT + innerH + 22}
          textAnchor="middle"
          fontSize={12}
          fill="var(--muted)"
        >
          {t}
        </text>
      ))}
      {/* Axis captions */}
      <text
        x={padL + innerW / 2}
        y={H - 14}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted)"
      >
        Stated confidence
      </text>
      <text
        x={18}
        y={padT + innerH / 2}
        textAnchor="middle"
        fontSize={12}
        fill="var(--muted)"
        transform={`rotate(-90 18 ${padT + innerH / 2})`}
      >
        Realized score
      </text>

      {/* R / R-squared / n block, top-left, matching the example
          image's "R = 0.99, p < 2.2e-16" placement. The OLS regression
          LINE itself is intentionally NOT drawn: direction scores are
          binary (0 / 50 / 100), so a least-squares line through them
          slopes hard against the calibration diagonal in a way that
          reads as a contradiction even when the stats are weak. The R
          number does the same job honestly: weak R = stated confidence
          doesn't track delivered hit rate; strong R = it does. */}
      {/* R / R-squared / n now live in an HTML strip above the SVG so
          the legend renders crisply at any zoom and matches the rest
          of the page typography. The diagonal calibration line +
          dots are the only thing inside the SVG now. */}

      {/* Dots */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={xScale(p.stated)}
          cy={yScale(p.realized)}
          r={5}
          fill="var(--foreground)"
          opacity={0.75}
        >
          <title>{`${p.date}: stated ${p.stated}, realized ${p.realized}`}</title>
        </circle>
      ))}
    </svg>
  );
}

import type { ActivitySummary, Profile } from '../types';
import { linreg } from '../stats';
import { bestEffortsAgg, fitCriticalSpeed, bestMeanMaxHR, estimateFTP, powerCurve, type BestEntry } from './efforts';
import { BEST_LABELS } from './process';
import { clamp } from '../units';

// ───────────────────────── Daniels / Gilbert VDOT ────────────────────────
/** Oxygen cost of running at v (m/min). */
export const vo2OfSpeed = (v: number) => -4.6 + 0.182258 * v + 0.000104 * v * v;
/** Fraction of VO₂max sustainable for t minutes. */
export const pctVO2max = (tMin: number) => 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);

export function vdotFrom(distM: number, timeSec: number): number {
  const t = timeSec / 60;
  return vo2OfSpeed(distM / t) / pctVO2max(t);
}

/** Time (s) a runner of this VDOT needs for a distance (monotone solve by bisection). */
export function timeFromVdot(vdot: number, distM: number): number {
  let lo = distM / 8.5, // 8.5 m/s ≈ world-record sprint pace upper bound
    hi = distM / 1.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFrom(distM, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Speed (m/s) at a given %VO₂max of a VDOT. */
export function speedAtPct(vdot: number, pct: number): number {
  const vo2 = vdot * pct;
  const a = 0.000104,
    b = 0.182258,
    c = -(4.6 + vo2);
  const vMin = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return vMin / 60;
}

export interface TrainingPaces {
  easy: [number, number]; // m/s, [slow, fast]
  marathon: number;
  threshold: number;
  interval: number;
  repetition: number;
}
export function trainingPaces(vdot: number): TrainingPaces {
  return {
    easy: [speedAtPct(vdot, 0.62), speedAtPct(vdot, 0.74)],
    marathon: speedAtPct(vdot, 0.815),
    threshold: speedAtPct(vdot, 0.88),
    interval: speedAtPct(vdot, 0.98),
    repetition: speedAtPct(vdot, 1.07),
  };
}

// ───────────────────────── Riegel ────────────────────────────────────────
export const riegel = (t1: number, d1: number, d2: number, b = 1.06) => t1 * Math.pow(d2 / d1, b);

/** Personal Riegel exponent from the athlete's own bests (log-log slope), clamped to physiological range. */
export function personalExponent(best: Map<number, BestEntry>): { b: number; n: number; personal: boolean } {
  const pts = [...best.values()].filter((e) => e.dist >= 1000 && e.dist <= 21100 && e.time > 150);
  if (pts.length < 3) return { b: 1.06, n: pts.length, personal: false };
  const span = Math.max(...pts.map((p) => p.dist)) / Math.min(...pts.map((p) => p.dist));
  if (span < 3) return { b: 1.06, n: pts.length, personal: false };
  const fit = linreg(
    pts.map((p) => Math.log(p.dist)),
    pts.map((p) => Math.log(p.time)),
  );
  return { b: clamp(fit.slope, 1.02, 1.12), n: pts.length, personal: true };
}

// ───────────────────────── Race predictions ──────────────────────────────
export interface RacePrediction {
  label: string;
  distM: number;
  vdotTime: number;
  riegelTime: number;
  personalTime: number;
  low: number;
  high: number;
  mid: number;
}
export interface PredictionSet {
  vdot: number;
  basis: { distM: number; time: number; label: string; activityId: string; start: number };
  exponent: { b: number; n: number; personal: boolean };
  races: RacePrediction[];
  paces: TrainingPaces;
  confidence: 'low' | 'medium' | 'high';
}

export const RACES = [
  { label: '5K', distM: 5000 },
  { label: '10K', distM: 10000 },
  { label: 'Half marathon', distM: 21097.5 },
  { label: 'Marathon', distM: 42195 },
];

/**
 * Predict race times from recent hard efforts. The "basis" is the run effort (1.5‥21 km) with the highest
 * VDOT in the window — a best-effort proxy for fitness that doesn't need an official race.
 */
export function predictRaces(acts: ActivitySummary[], now: number, windowDays = 120): PredictionSet | undefined {
  const from = now - windowDays * 86400000;
  const best = bestEffortsAgg(acts, { sports: ['run'], from, to: now });
  let basis: BestEntry | undefined;
  let bestV = 0;
  for (const e of best.values()) {
    if (e.dist < 1500 || e.dist > 21200) continue;
    const v = vdotFrom(e.dist, e.time);
    if (v > bestV) {
      bestV = v;
      basis = e;
    }
  }
  if (!basis) return undefined;
  const exponent = personalExponent(best);
  const races: RacePrediction[] = RACES.map((r) => {
    const vt = timeFromVdot(bestV, r.distM);
    const rt = riegel(basis!.time, basis!.dist, r.distM, 1.06);
    const pt = riegel(basis!.time, basis!.dist, r.distM, exponent.b);
    const all = [vt, rt, pt];
    // marathon predictions from short efforts overstate fitness; widen the range with distance ratio
    const ratio = r.distM / basis!.dist;
    const widen = ratio > 6 ? 1.04 : ratio > 3 ? 1.02 : 1.0;
    const low = Math.min(...all);
    const high = Math.max(...all) * widen;
    return { label: r.label, distM: r.distM, vdotTime: vt, riegelTime: rt, personalTime: pt, low, high, mid: vt };
  });
  const efforts = [...best.values()].filter((e) => e.dist >= 1500 && e.dist <= 21200).length;
  const recent = now - basis.start < 45 * 86400000;
  const confidence = efforts >= 4 && recent ? 'high' : efforts >= 2 ? 'medium' : 'low';
  return {
    vdot: bestV,
    basis: { distM: basis.dist, time: basis.time, label: BEST_LABELS[basis.dist] ?? `${basis.dist} m`, activityId: basis.activityId, start: basis.start },
    exponent,
    races,
    paces: trainingPaces(bestV),
    confidence,
  };
}

/** VDOT trend: best VDOT per calendar month from run best-efforts. */
export function vdotTrend(acts: ActivitySummary[]): { month: string; vdot: number }[] {
  const byMonth = new Map<string, number>();
  for (const a of acts) {
    if (a.sport !== 'run' || !a.bests) continue;
    let v = 0;
    for (const [d, [t]] of Object.entries(a.bests)) {
      const D = +d;
      if (D < 1500 || D > 21200) continue;
      v = Math.max(v, vdotFrom(D, t));
    }
    if (!v) continue;
    const key = new Date(a.start + a.tz * 60000).toISOString().slice(0, 7);
    byMonth.set(key, Math.max(byMonth.get(key) ?? 0, v));
  }
  return [...byMonth.entries()].sort().map(([month, vdot]) => ({ month, vdot }));
}

// ───────────────────────── Threshold auto-detection ──────────────────────
export interface ThresholdSuggestion {
  key: 'maxHR' | 'lthr' | 'ftp' | 'thresholdSpeed';
  label: string;
  current: number;
  estimate: number;
  /** raise: new best detected · ok: consistent · below: no hard effort in the window (never auto-lowered) */
  status: 'raise' | 'ok' | 'below';
  basis: string;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Thresholds are only ever *raised* automatically: training data that doesn't contain a hard effort says
 * nothing about your ceiling, so a lower estimate is reported as "below" (needs a test) and never applied.
 */
export function suggestThresholds(acts: ActivitySummary[], profile: Profile, now: number): ThresholdSuggestion[] {
  const out: ThresholdSuggestion[] = [];
  const y = now - 365 * 86400000;
  const d120 = now - 120 * 86400000;
  const d90 = now - 90 * 86400000;
  const status = (est: number, cur: number, tol: number): ThresholdSuggestion['status'] => (est > cur + tol ? 'raise' : est < cur - tol * 3 ? 'below' : 'ok');

  const maxes = acts.filter((a) => a.maxHR && a.start >= y).map((a) => a.maxHR!);
  if (maxes.length >= 5) {
    const sorted = [...maxes].sort((a, b) => a - b);
    const m = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
    out.push({ key: 'maxHR', label: 'Max heart rate', current: profile.maxHR, estimate: Math.round(m), status: status(m, profile.maxHR, 1), basis: `98th percentile of ${maxes.length} activity maxima (12 mo)`, confidence: maxes.length >= 20 ? 'high' : 'medium' });
  }

  const mm = bestMeanMaxHR(acts, d120).find((x) => x.dur === 1200);
  if (mm && mm.hr > 0.8 * profile.maxHR) {
    out.push({ key: 'lthr', label: 'Lactate-threshold HR', current: profile.lthr, estimate: Math.round(mm.hr), status: status(mm.hr, profile.lthr, 2), basis: `Best 20-min average HR in 120 d (${Math.round(mm.hr)} bpm) — a lower bound; a 30-min time trial is tighter`, confidence: mm.hr > 0.93 * profile.maxHR ? 'medium' : 'low' });
  }

  const curve = powerCurve(acts, d90, now);
  const ftp = estimateFTP(curve);
  if (ftp) out.push({ key: 'ftp', label: 'Functional threshold power', current: profile.ftp, estimate: Math.round(ftp), status: status(ftp, profile.ftp, 3), basis: `95 % × best 20-min power (${Math.round(ftp / 0.95)} W, last 90 d)`, confidence: 'medium' });

  const cs = fitCriticalSpeed(bestEffortsAgg(acts, { sports: ['run'], from: d120, to: now }));
  if (cs && cs.r2 > 0.97) {
    const rel = profile.thresholdSpeed * 0.02;
    out.push({ key: 'thresholdSpeed', label: 'Threshold pace', current: profile.thresholdSpeed, estimate: cs.cs, status: status(cs.cs, profile.thresholdSpeed, rel), basis: `Critical-speed fit over ${cs.n} efforts of 3‥30 min (R² ${cs.r2.toFixed(3)})`, confidence: cs.n >= 3 ? 'medium' : 'low' });
  }
  return out;
}

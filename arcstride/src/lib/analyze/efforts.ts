import type { ActivitySummary, Bests, Sport } from '../types';
import { linreg } from '../stats';
import { BEST_DISTANCES, MMHR_DURATIONS, MMP_DURATIONS } from './process';

export interface CurvePoint {
  dur: number; // seconds
  w: number; // watts
  activityId: string;
  start: number;
}

/** Best mean-max power per duration across activities in [from, to]. */
export function powerCurve(acts: ActivitySummary[], from = -Infinity, to = Infinity): CurvePoint[] {
  const best: (CurvePoint | undefined)[] = MMP_DURATIONS.map(() => undefined);
  for (const a of acts) {
    if (!a.mmp || a.start < from || a.start > to) continue;
    a.mmp.forEach((w, i) => {
      if (w === w && w > 0 && (!best[i] || w > best[i]!.w)) best[i] = { dur: MMP_DURATIONS[i], w, activityId: a.id, start: a.start };
    });
  }
  return best.filter((x): x is CurvePoint => !!x);
}

export interface CPFit {
  cp: number;
  wPrime: number; // joules
  r2: number;
  n: number;
}
/** 2-parameter critical power: work = CP·t + W′ over 3‥20 min efforts. */
export function fitCP(curve: CurvePoint[], lo = 180, hi = 1200): CPFit | undefined {
  const pts = curve.filter((c) => c.dur >= lo && c.dur <= hi);
  if (pts.length < 3) return undefined;
  const fit = linreg(
    pts.map((p) => p.dur),
    pts.map((p) => p.w * p.dur),
  );
  if (!(fit.slope > 0) || !(fit.intercept > 0)) return undefined;
  return { cp: fit.slope, wPrime: fit.intercept, r2: fit.r2, n: pts.length };
}

/** eFTP = 95 % of the best 20-min power. */
export function estimateFTP(curve: CurvePoint[]): number | undefined {
  const p20 = curve.find((c) => c.dur === 1200);
  return p20 ? p20.w * 0.95 : undefined;
}

/** W′ balance (Skiba 2015 differential model). Returns joules remaining at each second. */
export function wPrimeBalance(power: ArrayLike<number>, cp: number, wPrime: number): Float32Array {
  const n = power.length;
  const out = new Float32Array(n);
  let bal = wPrime;
  for (let i = 0; i < n; i++) {
    const p = power[i] === power[i] ? power[i] : 0;
    if (p > cp) bal -= p - cp;
    else bal += (cp - p) * ((wPrime - bal) / wPrime);
    bal = Math.max(-wPrime * 0.3, Math.min(wPrime, bal));
    out[i] = bal;
  }
  return out;
}

export interface BestEntry {
  dist: number;
  time: number;
  activityId: string;
  start: number; // epoch ms of the effort start
  startSec: number;
}

/** Best effort per target distance over activities (optionally filtered by sport/time). */
export function bestEffortsAgg(
  acts: ActivitySummary[],
  opts: { sports?: Sport[]; from?: number; to?: number } = {},
): Map<number, BestEntry> {
  const out = new Map<number, BestEntry>();
  for (const a of acts) {
    if (!a.bests) continue;
    if (opts.sports && !opts.sports.includes(a.sport)) continue;
    if (opts.from != null && a.start < opts.from) continue;
    if (opts.to != null && a.start > opts.to) continue;
    for (const D of BEST_DISTANCES) {
      const b = (a.bests as Bests)[D];
      if (!b) continue;
      const cur = out.get(D);
      if (!cur || b[0] < cur.time) out.set(D, { dist: D, time: b[0], activityId: a.id, start: a.start + b[1] * 1000, startSec: b[1] });
    }
  }
  return out;
}

export interface CSFit {
  cs: number; // m/s critical speed
  dPrime: number; // metres
  r2: number;
  n: number;
}
/** Critical speed: distance = CS·t + D′ over efforts lasting 3‥30 min. */
export function fitCriticalSpeed(best: Map<number, BestEntry>): CSFit | undefined {
  const pts = [...best.values()].filter((b) => b.time >= 180 && b.time <= 1800);
  if (pts.length < 2) return undefined;
  const fit = linreg(
    pts.map((p) => p.time),
    pts.map((p) => p.dist),
  );
  if (!(fit.slope > 0.5)) return undefined;
  return { cs: fit.slope, dPrime: Math.max(0, fit.intercept), r2: fit.r2, n: pts.length };
}

/** Best mean-max HR at each duration (for LTHR estimation). */
export function bestMeanMaxHR(acts: ActivitySummary[], from = -Infinity): { dur: number; hr: number; activityId: string }[] {
  const best: ({ dur: number; hr: number; activityId: string } | undefined)[] = MMHR_DURATIONS.map(() => undefined);
  for (const a of acts) {
    if (!a.mmhr || a.start < from) continue;
    a.mmhr.forEach((h, i) => {
      if (h === h && (!best[i] || h > best[i]!.hr)) best[i] = { dur: MMHR_DURATIONS[i], hr: h, activityId: a.id };
    });
  }
  return best.filter((x): x is { dur: number; hr: number; activityId: string } => !!x);
}

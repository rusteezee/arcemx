import { gapFactor } from './gap';
import { KM, MI } from '../units';
import type { Units } from '../types';

export interface CourseProfile {
  d: ArrayLike<number>; // cumulative metres
  alt: ArrayLike<number>; // metres (may contain NaN)
}

export interface PacingSplit {
  idx: number;
  from: number; // m
  to: number;
  length: number;
  gain: number;
  loss: number;
  grade: number; // average, fraction
  factor: number; // GAP cost factor (>1 = harder than flat)
  time: number; // planned seconds
  secPerUnit: number; // actual pace, s per km/mi
  flatSecPerUnit: number; // equivalent flat pace (effort-matched)
  cumTime: number;
  note: string;
}

export interface PacingPlan {
  splits: PacingSplit[];
  totalSec: number;
  flatSpeed: number; // m/s flat-equivalent effort at average
  totalGain: number;
  totalLoss: number;
  evenPaceSec: number; // naive even-pace time per unit
  profile: { d: number[]; elev: number[]; paceSec: number[] }; // for charts at ~100 m spacing
}

/**
 * Effort-matched pacing: allocate time in proportion to *cost-weighted* distance (Σ length × GAP factor),
 * so climbs get slower pace and descents faster for the same physiological effort, then apply an optional
 * negative-split gradient and renormalise to the target time.
 */
export function planPacing(course: CourseProfile, targetSec: number, opts: { units: Units; negativeSplit?: number; downhillCredit?: number } ): PacingPlan | undefined {
  const n = course.d.length;
  if (n < 3) return undefined;
  const total = course.d[n - 1];
  if (total < 500) return undefined;
  const unit = opts.units === 'metric' ? KM : MI;
  const ns = opts.negativeSplit ?? 0.02;
  const credit = opts.downhillCredit ?? 0.5;

  // elevation at fixed 20 m steps, smoothed
  const step = 20;
  const m = Math.floor(total / step) + 1;
  const elev: number[] = new Array(m);
  let k = 0;
  let last = NaN;
  for (let i = 0; i < m; i++) {
    const target = i * step;
    while (k < n - 2 && course.d[k + 1] < target) k++;
    const span = course.d[k + 1] - course.d[k];
    const u = span > 0 ? Math.min(1, Math.max(0, (target - course.d[k]) / span)) : 0;
    const a = course.alt[k],
      b = course.alt[k + 1];
    const v = a === a && b === b ? a + (b - a) * u : a === a ? a : b;
    elev[i] = v === v ? v : last === last ? last : 0;
    last = elev[i];
  }
  const sm = elev.map((_, i) => {
    let s = 0,
      c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(m - 1, i + 2); j++) {
      s += elev[j];
      c++;
    }
    return s / c;
  });

  // split boundaries
  const nSplits = Math.ceil(total / unit - 1e-6);
  const raw: { from: number; to: number; gain: number; loss: number; grade: number; factor: number; w: number }[] = [];
  for (let s = 0; s < nSplits; s++) {
    const from = s * unit,
      to = Math.min(total, (s + 1) * unit);
    const i0 = Math.round(from / step),
      i1 = Math.min(m - 1, Math.round(to / step));
    let gain = 0,
      loss = 0,
      wsum = 0;
    for (let i = i0; i < i1; i++) {
      const dz = sm[i + 1] - sm[i];
      if (dz > 0) gain += dz;
      else loss -= dz;
      const g = dz / step;
      wsum += step * gapFactor(Math.max(-0.4, Math.min(0.4, g)), credit);
    }
    const len = to - from;
    const covered = Math.max(1, (i1 - i0) * step);
    const w = (wsum / covered) * len; // cost-weighted length
    const grade = len > 0 ? (sm[i1] - sm[i0]) / Math.max(1, covered) : 0;
    raw.push({ from, to, gain, loss, grade, factor: w / Math.max(1, len), w });
  }
  const E = raw.reduce((a, r) => a + r.w, 0);
  const flatSpeed = E / targetSec;

  // time = w / flatSpeed × negative-split gradient, then renormalise
  const mult = raw.map((r) => 1 + ns * (0.5 - (r.from + r.to) / 2 / total));
  const rawTimes = raw.map((r, i) => (r.w / flatSpeed) * mult[i]);
  const scale = targetSec / rawTimes.reduce((a, b) => a + b, 0);
  let cum = 0;
  const splits: PacingSplit[] = raw.map((r, i) => {
    const time = rawTimes[i] * scale;
    cum += time;
    const len = r.to - r.from;
    const secPerUnit = (time / len) * unit;
    const flatSec = (time / r.w) * unit; // effort-matched flat pace for this split
    const note = r.grade > 0.03 ? 'Climb — hold effort, let pace slip' : r.grade < -0.03 ? 'Descent — stay relaxed, bank free time' : i === 0 ? 'Start controlled' : i === raw.length - 1 ? 'Empty the tank' : '';
    return { idx: i + 1, from: r.from, to: r.to, length: len, gain: r.gain, loss: r.loss, grade: r.grade, factor: r.factor, time, secPerUnit, flatSecPerUnit: flatSec, cumTime: cum, note };
  });

  // chart profile at ~100 m
  const pd: number[] = [],
    pe: number[] = [],
    pp: number[] = [];
  const splitAt = (x: number) => Math.min(splits.length - 1, Math.floor(x / unit));
  for (let x = 0; x <= total; x += 100) {
    pd.push(x);
    pe.push(sm[Math.min(m - 1, Math.round(x / step))]);
    pp.push(splits[splitAt(x)].secPerUnit);
  }
  const totalGain = raw.reduce((a, r) => a + r.gain, 0),
    totalLoss = raw.reduce((a, r) => a + r.loss, 0);
  return { splits, totalSec: targetSec, flatSpeed, totalGain, totalLoss, evenPaceSec: (targetSec / total) * unit, profile: { d: pd, elev: pe, paceSec: pp } };
}

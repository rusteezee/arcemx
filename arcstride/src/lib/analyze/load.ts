import type { ActivitySummary, LoadMethod, Loads, Profile } from '../types';
import { clamp, dayNumOf, dowOfDayNum } from '../units';
import { mean, stdev } from '../stats';
import { hrEdges, paceEdges, pwrEdges, TRI, zoneOf } from './zones';

// ───────────────────────── Per-activity load ─────────────────────────────
/** Banister TRIMP weight per minute at a given HR (exponential in HR-reserve fraction). */
export function trimpPerMinute(hr: number, p: Pick<Profile, 'restHR' | 'maxHR' | 'sex'>): number {
  const hrr = clamp((hr - p.restHR) / Math.max(1, p.maxHR - p.restHR), 0, 1);
  const [a, b] = p.sex === 'f' ? [0.86, 1.67] : [0.64, 1.92];
  return hrr * a * Math.exp(b * hrr);
}

const FALLBACK_IF: Record<string, number> = { walk: 0.45, hike: 0.6, run: 0.7, ride: 0.65, other: 0.65 };

export function computeLoads(s: ActivitySummary, p: Profile): Loads {
  const hours = s.timer / 3600;
  const paceSport = s.sport === 'run' || s.sport === 'walk' || s.sport === 'hike';

  // power → TSS
  let tss: number | undefined;
  if (s.sport === 'ride' && s.np && p.ftp > 0) {
    const ifx = s.np / p.ftp;
    tss = hours * ifx * ifx * 100;
  }

  // HR → TRIMP → hrTSS (1 h at LTHR = 100)
  let trimp: number | undefined;
  let hrTss: number | undefined;
  let hrZoneSecs: number[] | undefined;
  const hrTri: [number, number, number] = [0, 0, 0];
  if (s.hrHist) {
    const e = hrEdges(p);
    hrZoneSecs = [0, 0, 0, 0, 0];
    let tot = 0,
      acc = 0;
    for (let b = 30; b < s.hrHist.length; b++) {
      const secs = s.hrHist[b];
      if (!secs) continue;
      tot += secs;
      acc += (secs / 60) * trimpPerMinute(b, p);
      hrZoneSecs[zoneOf(b, e)] += secs;
      if (b < TRI.hr[0] * p.lthr) hrTri[0] += secs;
      else if (b < TRI.hr[1] * p.lthr) hrTri[1] += secs;
      else hrTri[2] += secs;
    }
    if (tot >= 0.5 * s.timer && tot > 0) {
      const cover = s.timer / tot; // extrapolate over missing HR samples
      trimp = acc * cover;
      const oneHourAtLthr = 60 * trimpPerMinute(p.lthr, p);
      hrTss = oneHourAtLthr > 0 ? (trimp / oneHourAtLthr) * 100 : undefined;
      for (let i = 0; i < 3; i++) hrTri[i] *= cover;
    }
  }

  // pace → rTSS
  let rTss: number | undefined;
  let paceZoneSecs: number[] | undefined;
  const paceTri: [number, number, number] = [0, 0, 0];
  if (paceSport && s.ngs && p.thresholdSpeed > 0) {
    const ifx = s.ngs / p.thresholdSpeed;
    rTss = hours * ifx * ifx * 100;
  }
  if (paceSport && s.gapHist && p.thresholdSpeed > 0) {
    const e = paceEdges(p);
    paceZoneSecs = [0, 0, 0, 0, 0];
    for (let b = 0; b < s.gapHist.length; b++) {
      const secs = s.gapHist[b];
      if (!secs) continue;
      const v = b * 0.1 + 0.05;
      paceZoneSecs[zoneOf(v, e)] += secs;
      const rel = v / p.thresholdSpeed;
      if (rel < TRI.pace[0]) paceTri[0] += secs;
      else if (rel < TRI.pace[1]) paceTri[1] += secs;
      else paceTri[2] += secs;
    }
  }

  // power zones (7) + tri
  let pwrZoneSecs: number[] | undefined;
  const pwrTri: [number, number, number] = [0, 0, 0];
  if (s.pwrHist && p.ftp > 0) {
    const e = pwrEdges(p);
    pwrZoneSecs = [0, 0, 0, 0, 0, 0, 0];
    for (let b = 0; b < s.pwrHist.length; b++) {
      const secs = s.pwrHist[b];
      if (!secs) continue;
      const w = b * 10 + 5;
      pwrZoneSecs[zoneOf(w, e)] += secs;
      const rel = w / p.ftp;
      if (rel < TRI.pwr[0]) pwrTri[0] += secs;
      else if (rel < TRI.pwr[1]) pwrTri[1] += secs;
      else pwrTri[2] += secs;
    }
  }

  // choose the best available load method
  let method: LoadMethod;
  let load: number;
  let ifactor: number | undefined;
  if (tss != null) {
    method = 'power';
    load = tss;
    ifactor = s.np! / p.ftp;
  } else if (s.sport === 'run' && p.runLoadSource === 'pace' && rTss != null) {
    method = 'pace';
    load = rTss;
    ifactor = s.ngs! / p.thresholdSpeed;
  } else if (hrTss != null) {
    method = 'hr';
    load = hrTss;
    ifactor = Math.sqrt(hrTss / Math.max(1e-9, hours * 100));
  } else if (rTss != null) {
    method = 'pace';
    load = rTss;
    ifactor = s.ngs! / p.thresholdSpeed;
  } else {
    method = 'time';
    ifactor = FALLBACK_IF[s.sport] ?? 0.65;
    load = hours * ifactor * ifactor * 100;
  }

  const tri: [number, number, number] =
    method === 'power' ? pwrTri : method === 'hr' ? hrTri : method === 'pace' ? paceTri : [s.timer, 0, 0];

  return { load, method, tss, hrTss, rTss, trimp, ifactor, hrZoneSecs, pwrZoneSecs, paceZoneSecs, tri };
}

export function computeAllLoads(acts: ActivitySummary[], p: Profile): Map<string, Loads> {
  const m = new Map<string, Loads>();
  for (const a of acts) m.set(a.id, computeLoads(a, p));
  return m;
}

// ───────────────────────── Performance-management chart ──────────────────
export interface PMCPoint {
  day: number; // day number (days since epoch, local)
  load: number;
  ctl: number; // fitness (42 d EWMA)
  atl: number; // fatigue (7 d EWMA)
  tsb: number; // form = CTL(yesterday) − ATL(yesterday)
  acwr: number; // EWMA acute:chronic (7:28)
  future?: boolean;
}

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

export function dailyLoads(acts: ActivitySummary[], loads: Map<string, Loads>): Map<number, number> {
  const m = new Map<number, number>();
  for (const a of acts) {
    const day = dayNumOf(a.start, a.tz);
    m.set(day, (m.get(day) ?? 0) + (loads.get(a.id)?.load ?? 0));
  }
  return m;
}

export function buildPMC(daily: Map<number, number>, startDay: number, endDay: number, opts: { seed?: number } = {}): PMCPoint[] {
  const out: PMCPoint[] = [];
  if (endDay < startDay) return out;
  const kC = 1 - Math.exp(-1 / CTL_DAYS);
  const kA = 1 - Math.exp(-1 / ATL_DAYS);
  const lamA = 2 / (7 + 1),
    lamC = 2 / (28 + 1);
  // seed from the mean of the first 28 days so a mid-training import isn't read as "starting from zero"
  let seedSum = 0;
  for (let d = startDay; d < startDay + 28 && d <= endDay; d++) seedSum += daily.get(d) ?? 0;
  const seed = opts.seed ?? seedSum / Math.min(28, endDay - startDay + 1);
  let ctl = seed,
    atl = seed,
    eA = seed,
    eC = seed;
  for (let d = startDay; d <= endDay; d++) {
    const L = daily.get(d) ?? 0;
    const tsb = ctl - atl; // yesterday's end-of-day values
    ctl += (L - ctl) * kC;
    atl += (L - atl) * kA;
    eA = L * lamA + (1 - lamA) * eA;
    eC = L * lamC + (1 - lamC) * eC;
    out.push({ day: d, load: L, ctl, atl, tsb, acwr: eC > 1 ? eA / eC : 1 });
  }
  return out;
}

/** Project the PMC forward with planned daily loads (what-if). */
export function forecastPMC(last: PMCPoint, planned: number[]): PMCPoint[] {
  const kC = 1 - Math.exp(-1 / CTL_DAYS),
    kA = 1 - Math.exp(-1 / ATL_DAYS);
  const lamA = 2 / 8,
    lamC = 2 / 29;
  let ctl = last.ctl,
    atl = last.atl;
  // recover EWMAs from ratio is impossible; approximate with ATL/CTL-derived values
  let eA = last.acwr * (ctl > 1 ? ctl : 1),
    eC = ctl > 1 ? ctl : 1;
  const out: PMCPoint[] = [];
  planned.forEach((L, i) => {
    const tsb = ctl - atl;
    ctl += (L - ctl) * kC;
    atl += (L - atl) * kA;
    eA = L * lamA + (1 - lamA) * eA;
    eC = L * lamC + (1 - lamC) * eC;
    out.push({ day: last.day + 1 + i, load: L, ctl, atl, tsb, acwr: eC > 1 ? eA / eC : 1, future: true });
  });
  return out;
}

// ───────────────────────── Risk & rhythm metrics ─────────────────────────
export interface Rhythm {
  monotony: number;
  strain: number;
  weekLoad: number;
}
/** Foster monotony & strain over the last 7 days (inclusive of rest days). */
export function monotonyStrain(daily: Map<number, number>, endDay: number): Rhythm {
  const xs: number[] = [];
  for (let d = endDay - 6; d <= endDay; d++) xs.push(daily.get(d) ?? 0);
  const m = mean(xs),
    sd = stdev(xs);
  const weekLoad = xs.reduce((a, b) => a + b, 0);
  const monotony = sd > 0.01 ? m / sd : m > 0 ? 9.9 : 0;
  return { monotony: Math.min(9.9, monotony), strain: weekLoad * Math.min(9.9, monotony), weekLoad };
}

export type AcwrZone = 'under' | 'sweet' | 'caution' | 'danger';
export function acwrZone(v: number): AcwrZone {
  return v < 0.8 ? 'under' : v <= 1.3 ? 'sweet' : v <= 1.5 ? 'caution' : 'danger';
}

/**
 * Single-session spike check (Nielsen et al. 2014): ratio of the latest session's distance to the
 * longest comparable session in the previous 30 days.
 */
export function spikeCheck(acts: ActivitySummary[], today: number): { ratio: number; latest: ActivitySummary; prevMax: number } | undefined {
  const runs = acts.filter((a) => a.sport === 'run' && a.distance > 1000).sort((a, b) => b.start - a.start);
  const latest = runs.find((a) => dayNumOf(a.start, a.tz) >= today - 7);
  if (!latest) return undefined;
  const ld = dayNumOf(latest.start, latest.tz);
  let prevMax = 0;
  for (const a of runs) {
    const d = dayNumOf(a.start, a.tz);
    if (a.id !== latest.id && d < ld && d >= ld - 30) prevMax = Math.max(prevMax, a.distance);
  }
  if (!prevMax) return undefined;
  return { ratio: latest.distance / prevMax, latest, prevMax };
}

// ───────────────────────── Intensity distribution ────────────────────────
export interface TriDist {
  low: number;
  mid: number;
  high: number;
  total: number;
  model: 'polarized' | 'pyramidal' | 'threshold' | 'base' | 'high-intensity' | 'none';
}
export function triDistribution(acts: ActivitySummary[], loads: Map<string, Loads>, fromDay: number, toDay: number): TriDist {
  let low = 0,
    mid = 0,
    high = 0;
  for (const a of acts) {
    const d = dayNumOf(a.start, a.tz);
    if (d < fromDay || d > toDay) continue;
    const t = loads.get(a.id)?.tri;
    if (!t) continue;
    low += t[0];
    mid += t[1];
    high += t[2];
  }
  const total = low + mid + high;
  let model: TriDist['model'] = 'none';
  if (total > 0) {
    const fl = low / total,
      fm = mid / total,
      fh = high / total;
    if (fl >= 0.75 && fh > fm) model = 'polarized';
    else if (fl >= 0.7 && fl > fm && fm >= fh) model = 'pyramidal';
    else if (fl >= 0.85) model = 'base';
    else if (fm >= fl * 0.8 || fm > 0.35) model = 'threshold';
    else if (fh > 0.3) model = 'high-intensity';
    else model = 'pyramidal';
  }
  return { low, mid, high, total, model };
}

// ───────────────────────── Week helpers ──────────────────────────────────
/** Day number of the start of the week containing `day`. weekStart: 0 = Sunday, 1 = Monday. */
export function weekStartOf(day: number, weekStart: 0 | 1): number {
  const dow = dowOfDayNum(day);
  const back = (dow - weekStart + 7) % 7;
  return day - back;
}

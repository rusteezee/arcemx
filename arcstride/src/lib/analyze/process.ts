import type { ActivitySummary, Bests, Derived, ParsedActivity, Profile, RawPoint, Sport, Streams, Track } from '../types';
import { bboxOf, fastDist, haversine, simplifyFlat } from '../geo';
import { lowerBound, smooth, smooth64 } from '../stats';
import { gapFactor } from './gap';

export const MMP_DURATIONS = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 900, 1200, 1500, 1800, 2400, 3000, 3600, 4500, 5400, 7200, 10800, 14400, 18000];
export const MMHR_DURATIONS = [300, 600, 1200, 1800, 3600];
export const BEST_DISTANCES = [400, 805, 1000, 1609, 3000, 5000, 10000, 15000, 16093, 20000, 21098, 30000, 42195];
export const BEST_LABELS: Record<number, string> = {
  400: '400 m',
  805: '½ mile',
  1000: '1 km',
  1609: '1 mile',
  3000: '3 km',
  5000: '5 km',
  10000: '10 km',
  15000: '15 km',
  16093: '10 mile',
  20000: '20 km',
  21098: 'Half marathon',
  30000: '30 km',
  42195: 'Marathon',
};

/** Recording gaps longer than this are treated as paused timer (not filled). */
const PAUSE_GAP_S = 30;

// ── Stage 1: irregular raw points → 1 Hz timer-time streams ────────────────
export interface BuiltStreams {
  streams: Streams;
  start: number; // epoch ms
  elapsed: number; // wall-clock seconds
}

export function buildStreams(input: RawPoint[]): BuiltStreams | null {
  const pts = input.filter((p) => isFinite(p.t)).sort((a, b) => a.t - b.t);
  // drop duplicate timestamps (keep the last)
  const raw: RawPoint[] = [];
  for (const p of pts) {
    if (raw.length && raw[raw.length - 1].t === p.t) raw[raw.length - 1] = p;
    else raw.push(p);
  }
  const m = raw.length;
  if (m < 2) return null;

  const tt = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    const dt = (raw[i].t - raw[i - 1].t) / 1000;
    tt[i] = tt[i - 1] + (dt <= PAUSE_GAP_S ? dt : 0);
  }
  const total = tt[m - 1];
  const n = Math.floor(total) + 1;
  if (n < 5) return null;

  const clean = (v: number | undefined, lo: number, hi: number) => (v != null && isFinite(v) && v >= lo && v <= hi ? v : NaN);
  const lat = new Float64Array(n).fill(NaN),
    lon = new Float64Array(n).fill(NaN);
  const alt = new Float32Array(n).fill(NaN),
    hr = new Float32Array(n).fill(NaN),
    cad = new Float32Array(n).fill(NaN),
    pwr = new Float32Array(n).fill(NaN);
  const dFile = new Float64Array(n).fill(NaN);

  const lerp = (a: number, b: number, f: number) => (a === a && b === b ? a + (b - a) * f : a === a ? a : b);

  let j = 0;
  for (let s = 0; s < n; s++) {
    while (j < m - 2 && tt[j + 1] <= s) j++;
    const a = raw[j],
      b = raw[j + 1];
    const t0 = tt[j],
      t1 = tt[j + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (s - t0) / (t1 - t0))) : 0;
    const la = clean(a.lat, -90, 90),
      lb = clean(b.lat, -90, 90);
    const oa = clean(a.lon, -180, 180),
      ob = clean(b.lon, -180, 180);
    if (la === la && oa === oa) {
      lat[s] = lerp(la, lb, f);
      lon[s] = lerp(oa, ob, f);
      // treat (0,0) fixes as invalid
      if (Math.abs(lat[s]) < 1e-6 && Math.abs(lon[s]) < 1e-6) lat[s] = lon[s] = NaN;
    }
    alt[s] = lerp(clean(a.alt, -500, 9000), clean(b.alt, -500, 9000), f);
    hr[s] = lerp(clean(a.hr, 30, 230), clean(b.hr, 30, 230), f);
    const ca = clean(a.cad, 0, 250),
      cb = clean(b.cad, 0, 250);
    cad[s] = f < 0.5 ? (ca === ca ? ca : cb) : cb === cb ? cb : ca;
    pwr[s] = lerp(clean(a.pwr, 0, 2500), clean(b.pwr, 0, 2500), f);
    dFile[s] = lerp(clean(a.dist, 0, 1e7), clean(b.dist, 0, 1e7), f);
  }

  // ── distance ──
  const hasGps = (() => {
    let c = 0;
    for (let i = 0; i < n; i++) if (lat[i] === lat[i]) c++;
    return c > n * 0.5;
  })();
  const d = new Float32Array(n);
  const gpsD = hasGps ? gpsDistance(lat, lon) : null;
  const fileOk = (() => {
    let valid = 0;
    let mono = true;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const v = dFile[i];
      if (v === v) {
        valid++;
        if (v < prev - 1) mono = false;
        prev = v;
      }
    }
    return valid > n * 0.8 && mono && prev > 0;
  })();
  let useFile = fileOk;
  if (fileOk && gpsD) {
    const fileTotal = lastValid(dFile);
    const gpsTotal = gpsD[n - 1];
    if (gpsTotal > 100 && (fileTotal / gpsTotal < 0.85 || fileTotal / gpsTotal > 1.15)) useFile = false;
  }
  if (useFile) {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const v = dFile[i];
      if (v === v) last = Math.max(last, v);
      d[i] = last - firstValid(dFile);
    }
  } else if (gpsD) {
    for (let i = 0; i < n; i++) d[i] = gpsD[i];
  }

  return {
    streams: { n, lat, lon, alt, hr, cad, pwr, d, hasGps },
    start: raw[0].t,
    elapsed: (raw[m - 1].t - raw[0].t) / 1000,
  };
}

function firstValid(a: Float64Array) {
  for (let i = 0; i < a.length; i++) if (a[i] === a[i]) return a[i];
  return 0;
}
function lastValid(a: Float64Array) {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return a[i];
  return 0;
}

/** Cumulative distance from 1 Hz GPS with light smoothing and a stationary-jitter dead-zone. */
export function gpsDistance(lat: Float64Array, lon: Float64Array): Float64Array {
  const n = lat.length;
  // fill NaN gaps by holding the last good fix so smoothing is stable
  const la = new Float64Array(n),
    lo = new Float64Array(n);
  let lastLa = NaN,
    lastLo = NaN;
  for (let i = 0; i < n; i++) {
    if (lat[i] === lat[i]) {
      lastLa = lat[i];
      lastLo = lon[i];
    }
    la[i] = lastLa;
    lo[i] = lastLo;
  }
  // back-fill leading NaNs
  let k = 0;
  while (k < n && la[k] !== la[k]) k++;
  for (let i = 0; i < k && k < n; i++) {
    la[i] = la[k];
    lo[i] = lo[k];
  }
  const sl = smooth64(la, 1),
    so = smooth64(lo, 1);
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    let step = haversine(sl[i - 1], so[i - 1], sl[i], so[i]);
    if (!(step === step)) step = 0;
    if (i >= 5) {
      const net = fastDist(sl[i - 5], so[i - 5], sl[i], so[i]);
      if (net < 2.0) step = 0; // GPS wobble while standing still
    }
    if (step > 80) step = 0; // teleport / bad fix (80 m in 1 s ≈ 290 km/h)
    acc += step;
    out[i] = acc;
  }
  return out;
}

// ── Stage 2: derived streams (speed, grade, GAP, moving) ───────────────────
export function movingThreshold(sport: Sport): number {
  return sport === 'ride' ? 1.0 : sport === 'run' ? 0.8 : sport === 'walk' ? 0.5 : sport === 'hike' ? 0.4 : 0.5;
}

export function deriveStreams(s: Streams, sport: Sport, profile: Pick<Profile, 'gapDownhillCredit'>): Derived {
  const n = s.n;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 2),
      hi = Math.min(n - 1, i + 2);
    v[i] = hi > lo ? (s.d[hi] - s.d[lo]) / (hi - lo) : 0;
  }
  // altitude: fill NaNs then smooth
  const altFilled = new Float32Array(n);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (s.alt[i] === s.alt[i]) last = s.alt[i];
    altFilled[i] = last;
  }
  let first = NaN;
  for (let i = 0; i < n; i++)
    if (s.alt[i] === s.alt[i]) {
      first = s.alt[i];
      break;
    }
  for (let i = 0; i < n && altFilled[i] !== altFilled[i]; i++) altFilled[i] = first;
  const altS = smooth(altFilled, 4);

  // grade over ±~15 m of travelled distance
  const grade = new Float32Array(n);
  const W = 15;
  let lo = 0,
    hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && s.d[i] - s.d[lo] > W) lo++;
    if (hi < i) hi = i;
    while (hi < n - 1 && s.d[hi] - s.d[i] < W) hi++;
    const dd = s.d[hi] - s.d[lo];
    grade[i] = dd > 8 && altS[hi] === altS[hi] && altS[lo] === altS[lo] ? Math.max(-0.4, Math.min(0.4, (altS[hi] - altS[lo]) / dd)) : 0;
  }

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = v[i] * gapFactor(grade[i], profile.gapDownhillCredit);
  const gapv = smooth(raw, 2);

  const thr = movingThreshold(sport);
  const mv = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const pedalling = !s.hasGps && s.d[n - 1] === 0 && (s.pwr[i] > 0 || s.cad[i] > 0);
    mv[i] = v[i] > thr || pedalling ? 1 : 0;
  }
  // remove blips shorter than 3 s
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && mv[j] === mv[i]) j++;
    if (j - i < 3 && i > 0 && j < n) mv.fill(mv[i - 1], i, j);
    i = j;
  }
  return { v, altS, grade, gapv, moving: mv };
}

// ── Stage 3: summary metrics ───────────────────────────────────────────────
/** Elevation gain/loss with hysteresis to ignore GPS altitude noise. */
export function elevGainLoss(alt: ArrayLike<number>, thr = 2.5): { gain: number; loss: number } {
  let up = 0,
    down = 0;
  let ref = NaN;
  for (let i = 0; i < alt.length; i++) {
    const a = alt[i];
    if (a !== a) continue;
    if (ref !== ref) {
      ref = a;
      continue;
    }
    if (a - ref >= thr) {
      up += a - ref;
      ref = a;
    } else if (ref - a >= thr) {
      down += ref - a;
      ref = a;
    }
  }
  return { gain: up, loss: down };
}

/** Normalised mean: 30 s rolling average, 4th-power mean, 4th root (Coggan NP; also used for NGS). */
export function normalizedMean(x: ArrayLike<number>): number {
  const n = x.length;
  if (n < 30) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[i] || 0;
    return n ? s / n : 0;
  }
  let win = 0;
  for (let i = 0; i < 30; i++) win += x[i] || 0;
  let acc = 0,
    cnt = 0;
  for (let i = 29; i < n; i++) {
    if (i > 29) win += (x[i] || 0) - (x[i - 30] || 0);
    const r = win / 30;
    acc += r ** 4;
    cnt++;
  }
  return Math.pow(acc / cnt, 0.25);
}

export function meanMax(x: ArrayLike<number>, durations: number[]): number[] {
  const n = x.length;
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + (x[i] === x[i] ? x[i] : 0);
  return durations.map((D) => {
    if (D > n) return NaN;
    let best = 0;
    for (let i = 0; i + D <= n; i++) {
      const v = ps[i + D] - ps[i];
      if (v > best) best = v;
    }
    return best / D;
  });
}

/** Best time over each target distance using a two-pointer scan with interpolation. */
export function bestEfforts(d: ArrayLike<number>, targets: number[] = BEST_DISTANCES): Bests {
  const n = d.length;
  const out: Bests = {};
  if (!n) return out;
  const total = d[n - 1];
  for (const D of targets) {
    if (total < D * 1.001) continue;
    let i = 0;
    let best = Infinity,
      bestStart = 0;
    for (let j = 1; j < n; j++) {
      const need = d[j] - D;
      if (need < 0) continue;
      while (i + 1 < j && d[i + 1] <= need) i++;
      // now d[i] ≤ need < d[i+1]
      const span = d[i + 1] - d[i];
      const ts = span > 0 ? i + (need - d[i]) / span : i;
      const dt = j - ts;
      if (dt < best) {
        best = dt;
        bestStart = ts;
      }
    }
    if (isFinite(best) && best > 0) out[D] = [+best.toFixed(2), +bestStart.toFixed(1)];
  }
  return out;
}

/** Aerobic decoupling: drop in output-per-heartbeat from first to second half (%). Positive = drift. */
export function decoupling(out: ArrayLike<number>, hr: ArrayLike<number>): number | undefined {
  const n = out.length;
  if (n < 1800) return undefined;
  const skip = Math.min(600, Math.floor(n * 0.1));
  const mid = skip + Math.floor((n - skip) / 2);
  const half = (a: number, b: number) => {
    let so = 0,
      sh = 0,
      c = 0;
    for (let i = a; i < b; i++) {
      if (hr[i] === hr[i] && out[i] === out[i]) {
        so += out[i];
        sh += hr[i];
        c++;
      }
    }
    return c > 300 ? so / c / (sh / c) : NaN;
  };
  const e1 = half(skip, mid),
    e2 = half(mid, n);
  if (!(e1 > 0) || !(e2 > 0)) return undefined;
  return ((e1 - e2) / e1) * 100;
}

export function guessSport(avgSpeed: number, elevPerKm: number): Sport {
  if (avgSpeed < 1.9) return elevPerKm > 40 ? 'hike' : 'walk';
  if (avgSpeed < 5.2) return 'run';
  return 'ride';
}

export function makeId(start: number, distance: number, source: string) {
  return `a${Math.floor(start / 1000)}_${Math.round(distance)}${source === 'demo' ? 'd' : ''}`;
}

export interface Analysis {
  summary: ActivitySummary;
  streams: Streams;
  track: Track | null;
}

export interface SummaryMeta {
  name?: string;
  sport?: Sport;
  source: ParsedActivity['source'];
  notes?: string;
  trainer?: boolean;
  id?: string;
}

export function analyze(parsed: ParsedActivity, profile: Profile, opts: { tz?: number; name?: string } = {}): Analysis | null {
  const built = buildStreams(parsed.points);
  if (!built) return null;
  return summarize(built, { name: parsed.name, sport: parsed.sport, source: parsed.source, notes: parsed.notes, trainer: parsed.trainer }, profile, opts);
}

/** Re-derive a summary from stored streams (used when profile-baked settings such as the GAP model change). */
export function reanalyze(old: ActivitySummary, streams: Streams, profile: Profile): Analysis {
  const built: BuiltStreams = { streams, start: old.start, elapsed: old.elapsed };
  const res = summarize(built, { name: old.name, sport: old.sport, source: old.source, notes: old.notes, trainer: old.trainer, id: old.id }, profile, { tz: old.tz })!;
  res.summary.gearId = old.gearId;
  res.summary.edited = old.edited;
  return res;
}

export function summarize(built: BuiltStreams, parsed: SummaryMeta, profile: Profile, opts: { tz?: number; name?: string } = {}): Analysis {
  const { streams: s, start, elapsed } = built;
  const n = s.n;

  // provisional sport guess for derivation thresholds
  const totalD = s.d[n - 1];
  const prelimSpeed = totalD / Math.max(1, n);
  let sport: Sport = parsed.sport ?? guessSport(prelimSpeed, 0);
  let dv = deriveStreams(s, sport, profile);
  let movingSecs = 0;
  for (let i = 0; i < n; i++) movingSecs += dv.moving[i];
  const gl = elevGainLoss(dv.altS);
  let hasElev = false;
  for (let i = 0; i < n; i++)
    if (s.alt[i] === s.alt[i]) {
      hasElev = true;
      break;
    }
  if (!parsed.sport) {
    const avgSp = totalD / Math.max(1, movingSecs);
    const g = guessSport(avgSp, hasElev ? gl.gain / Math.max(1, totalD / 1000) : 0);
    if (g !== sport) {
      sport = g;
      dv = deriveStreams(s, sport, profile);
      movingSecs = 0;
      for (let i = 0; i < n; i++) movingSecs += dv.moving[i];
    }
  }

  // HR / cadence / power basics
  let hrSum = 0,
    hrN = 0,
    hrMax = 0,
    cadSum = 0,
    cadN = 0,
    pSum = 0,
    pN = 0,
    pMax = 0;
  for (let i = 0; i < n; i++) {
    const h = s.hr[i];
    if (h === h) {
      hrSum += h;
      hrN++;
      if (h > hrMax) hrMax = h;
    }
    const c = s.cad[i];
    if (c === c && c > 0) {
      cadSum += c;
      cadN++;
    }
    const p = s.pwr[i];
    if (p === p) {
      pSum += p;
      pN++;
      if (p > pMax) pMax = p;
    }
  }
  const hasHR = hrN > n * 0.3;
  const hasPower = pN > n * 0.3;

  const pwrFilled = new Float32Array(n);
  if (hasPower) for (let i = 0; i < n; i++) pwrFilled[i] = s.pwr[i] === s.pwr[i] ? s.pwr[i] : 0;
  const np = hasPower ? normalizedMean(pwrFilled) : undefined;
  const avgPower = hasPower ? pSum / n : undefined;

  const paceSport = sport === 'run' || sport === 'walk' || sport === 'hike';
  const ngs = s.hasGps && totalD > 200 ? normalizedMean(dv.gapv) : undefined;

  // histograms
  const hrHist = hasHR ? new Array<number>(250).fill(0) : undefined;
  const pwrHist = hasPower ? new Array<number>(150).fill(0) : undefined;
  const gapHist = s.hasGps && totalD > 200 ? new Array<number>(120).fill(0) : undefined;
  let maxSpeed = 0;
  for (let i = 0; i < n; i++) {
    if (hrHist && s.hr[i] === s.hr[i]) hrHist[Math.min(249, Math.round(s.hr[i]))]++;
    if (pwrHist) pwrHist[Math.min(149, Math.floor(pwrFilled[i] / 10))]++;
    if (gapHist && dv.moving[i]) gapHist[Math.min(119, Math.max(0, Math.floor(dv.gapv[i] * 10)))]++;
    if (dv.v[i] > maxSpeed) maxSpeed = dv.v[i];
  }

  // efficiency + decoupling
  let ef: number | undefined;
  let dc: number | undefined;
  const avgHR = hasHR ? hrSum / hrN : undefined;
  if (avgHR) {
    if (sport === 'ride' && np) {
      ef = np / avgHR;
      dc = decoupling(pwrFilled, s.hr);
    } else if (paceSport && ngs) {
      ef = (ngs * 60) / avgHR;
      dc = decoupling(dv.gapv, s.hr);
    }
  }

  const bests = s.hasGps && totalD > 380 ? bestEfforts(s.d) : undefined;
  const mmp = hasPower ? meanMax(pwrFilled, MMP_DURATIONS) : undefined;
  const mmhr = hasHR ? meanMax(s.hr, MMHR_DURATIONS) : undefined;

  const bbox = s.hasGps ? bboxOf(s.lat, s.lon) : undefined;
  const track = s.hasGps ? buildTrack(s) : null;
  const poly = track && track.n > 1 ? simplifyFlat(track.lat, track.lon, 150) : undefined;

  const tz = opts.tz ?? -new Date(start).getTimezoneOffset();
  const id = parsed.id ?? makeId(start, totalD, parsed.source);
  const dateName = new Date(start + tz * 60000);
  const hour = dateName.getUTCHours();
  const part = hour < 5 ? 'Night' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 21 ? 'Evening' : 'Night';
  const sportName = { run: 'Run', ride: 'Ride', walk: 'Walk', hike: 'Hike', other: 'Workout' }[sport];

  const summary: ActivitySummary = {
    id,
    name: opts.name ?? parsed.name ?? `${part} ${sportName}`,
    sport,
    source: parsed.source,
    start,
    tz,
    elapsed,
    timer: n,
    moving: movingSecs,
    distance: totalD,
    elevGain: hasElev ? gl.gain : 0,
    elevLoss: hasElev ? gl.loss : 0,
    minAlt: hasElev ? minOf(dv.altS) : undefined,
    maxAlt: hasElev ? maxOf(dv.altS) : undefined,
    avgSpeed: movingSecs > 0 ? totalD / movingSecs : 0,
    maxSpeed,
    avgHR,
    maxHR: hasHR ? hrMax : undefined,
    avgCad: cadN > n * 0.2 ? cadSum / cadN : undefined,
    avgPower,
    maxPower: hasPower ? pMax : undefined,
    np,
    ngs,
    vi: np && avgPower ? np / avgPower : undefined,
    ef,
    decoupling: dc,
    hrHist,
    pwrHist,
    gapHist,
    bests,
    mmp,
    mmhr,
    bbox,
    poly,
    hasGps: s.hasGps,
    hasHR,
    hasPower,
    hasElev,
    notes: parsed.notes,
    trainer: parsed.trainer ?? (!s.hasGps ? true : undefined),
  };
  return { summary, streams: s, track };
}

const minOf = (a: ArrayLike<number>) => {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] === a[i] && a[i] < m) m = a[i];
  return isFinite(m) ? m : undefined;
};
const maxOf = (a: ArrayLike<number>) => {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] === a[i] && a[i] > m) m = a[i];
  return isFinite(m) ? m : undefined;
};

/** Thin 1 Hz streams to ≈15 m spacing (always keeps first/last, and one point per 20 s while stationary). */
export function buildTrack(s: Streams, spacing = 15): Track {
  const idx: number[] = [];
  let lastD = -Infinity;
  let lastI = -1000;
  for (let i = 0; i < s.n; i++) {
    if (s.lat[i] !== s.lat[i]) continue;
    if (s.d[i] - lastD >= spacing || i - lastI >= 20 || idx.length === 0) {
      idx.push(i);
      lastD = s.d[i];
      lastI = i;
    }
  }
  // ensure the final valid fix is included
  for (let i = s.n - 1; i >= 0; i--)
    if (s.lat[i] === s.lat[i]) {
      if (idx[idx.length - 1] !== i) idx.push(i);
      break;
    }
  const m = idx.length;
  const tr: Track = {
    n: m,
    lat: new Float64Array(m),
    lon: new Float64Array(m),
    t: new Float32Array(m),
    d: new Float32Array(m),
    alt: new Float32Array(m),
    hr: new Float32Array(m),
    pwr: new Float32Array(m),
  };
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    tr.lat[k] = s.lat[i];
    tr.lon[k] = s.lon[i];
    tr.t[k] = i;
    tr.d[k] = s.d[i];
    tr.alt[k] = s.alt[i];
    tr.hr[k] = s.hr[i];
    tr.pwr[k] = s.pwr[i];
  }
  return tr;
}

/** Interpolated time (timer s) at which cumulative distance `dist` is reached. */
export function timeAtDistance(d: ArrayLike<number>, dist: number): number {
  const n = d.length;
  if (dist <= d[0]) return 0;
  if (dist >= d[n - 1]) return n - 1;
  const i = Math.max(0, lowerBound(d, dist) - 1);
  const span = d[i + 1] - d[i];
  return span > 0 ? i + (dist - d[i]) / span : i;
}

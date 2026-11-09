// ───────────────────────────────────────────────────────────────────────────
// Demo athlete generator — SYNTHETIC data, clearly flagged source: 'demo'.
// A small road network (shared edges!) lets repeated routes, segments and heatmap overlap emerge naturally.
// Rides use a physics model (power → speed with gravity/drag/rolling); runs use Minetti-based GAP;
// HR follows effort with lag, cardiac drift and a seasonal fitness improvement.
// ───────────────────────────────────────────────────────────────────────────
import type { CheckIn, Gear, Goal, ParsedActivity, Profile, RawPoint, Sport } from '../types';
import { fromXY } from '../geo';
import { rng } from '../stats';
import { gapFactor } from '../analyze/gap';
import { DEFAULT_PROFILE } from '../profile';

const LAT0 = 12.9716,
  LON0 = 77.5946;
type Pt = [number, number];

// ── road network ────────────────────────────────────────────────────────────
function catmull(ctrl: Pt[], step = 6): Pt[] {
  const out: Pt[] = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)],
      p1 = ctrl[i],
      p2 = ctrl[i + 1],
      p3 = ctrl[Math.min(n - 1, i + 2)];
    const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(2, Math.ceil(chord / step));
    for (let k = 0; k < m; k++) {
      const t = k / m,
        t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[n - 1]);
  return out;
}

function loopCtrl(P: Pt, R: number, seed: number): Pt[] {
  const r = rng(seed);
  const w1 = r.range(0.1, 0.2),
    w2 = r.range(0.04, 0.09),
    p1 = r.range(0, 6.28),
    p2 = r.range(0, 6.28);
  const rad = (th: number) => R * (1 + w1 * Math.sin(2 * th + p1) + w2 * Math.sin(3 * th + p2));
  const c: Pt = [P[0] + rad(Math.PI), P[1]];
  const pts: Pt[] = [];
  const N = 28;
  for (let k = 0; k <= N; k++) {
    const th = Math.PI + (2 * Math.PI * k) / N;
    pts.push([c[0] + rad(th) * Math.cos(th), c[1] + rad(th) * Math.sin(th) * 0.8]);
  }
  pts[N] = P;
  return pts;
}

interface Edge {
  id: string;
  x: Float64Array;
  y: Float64Array;
  e: Float64Array; // elevation
  cum: Float64Array;
  len: number;
}

function makeEdge(id: string, ctrl: Pt[], e0: number, e1: number, wobble: number, waves: number, seed: number): Edge {
  const pts = catmull(ctrl);
  const n = pts.length;
  const x = new Float64Array(n),
    y = new Float64Array(n),
    e = new Float64Array(n),
    cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i][0];
    y[i] = pts[i][1];
    if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  const len = cum[n - 1];
  const ph = seed * 1.7;
  for (let i = 0; i < n; i++) {
    const f = len ? cum[i] / len : 0;
    const ss = f * f * (3 - 2 * f);
    e[i] = e0 + (e1 - e0) * ss + wobble * Math.sin(2 * Math.PI * waves * f + ph) * Math.sin(Math.PI * f);
  }
  return { id, x, y, e, cum, len };
}

let NET: Record<string, Edge> | null = null;
function network(): Record<string, Edge> {
  if (NET) return NET;
  const H: Pt = [0, 0],
    P: Pt = [600, 350];
  NET = {
    HP: makeEdge('HP', [H, [250, 100], [450, 250], P], 905, 912, 1.5, 1, 1),
    PARK: makeEdge('PARK', loopCtrl(P, 560, 11), 912, 912, 7, 3, 2),
    PL: makeEdge('PL', [P, [1000, 200], [1500, 350], [2000, 700], [2200, 900]], 912, 908, 3, 2, 3),
    LAKE: makeEdge('LAKE', [[2200, 900], [2600, 1300], [3000, 1250], [3300, 900], [3700, 950], [4000, 1400], [4200, 1900], [4600, 2000]], 908, 903, 4, 3, 4),
    HB: makeEdge('HB', [H, [-400, 300], [-800, 500], [-1200, 800]], 905, 910, 1.5, 1, 5),
    HILL: makeEdge('HILL', [[-1200, 800], [-1500, 1200], [-1900, 1500], [-2100, 2000], [-2300, 2300]], 910, 996, 3, 2, 6),
    RN: makeEdge('RN', [H, [700, 1800], [900, 4000], [400, 7000], [-300, 10000], [-1500, 14000]], 905, 1012, 6, 5, 7),
    RL1: makeEdge('RL1', [[-1500, 14000], [1000, 15500], [3500, 15000], [5500, 12500]], 1012, 962, 8, 4, 8),
    RL2: makeEdge('RL2', [[5500, 12500], [5200, 9000], [4200, 5500], [2400, 2600], [900, 700], [0, 0]], 962, 905, 5, 4, 9),
  };
  return NET;
}

interface Path {
  x: Float64Array;
  y: Float64Array;
  e: Float64Array;
  cum: Float64Array;
  grade: Float64Array;
  len: number;
}
type Part = [id: string, dir: 1 | -1];

function buildPath(parts: Part[], maxLen?: number): Path {
  const net = network();
  const xs: number[] = [],
    ys: number[] = [],
    es: number[] = [];
  for (const [id, dir] of parts) {
    const ed = net[id];
    const idx = Array.from({ length: ed.x.length }, (_, i) => (dir === 1 ? i : ed.x.length - 1 - i));
    idx.forEach((i, k) => {
      if (xs.length && k === 0) return; // shared join point
      xs.push(ed.x[i]);
      ys.push(ed.y[i]);
      es.push(ed.e[i]);
    });
  }
  let n = xs.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  if (maxLen && cum[n - 1] > maxLen) {
    let k = 1;
    while (k < n && cum[k] < maxLen) k++;
    n = k + 1 > xs.length ? xs.length : k + 1;
  }
  const x = Float64Array.from(xs.slice(0, n)),
    y = Float64Array.from(ys.slice(0, n)),
    e = Float64Array.from(es.slice(0, n));
  const c2 = cum.slice(0, n);
  const grade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 3),
      b = Math.min(n - 1, i + 3);
    const dd = c2[b] - c2[a];
    grade[i] = dd > 5 ? (e[b] - e[a]) / dd : 0;
  }
  return { x, y, e, cum: c2, grade, len: c2[n - 1] };
}

const rev = (parts: Part[]): Part[] => [...parts].reverse().map(([id, d]) => [id, (d * -1) as 1 | -1]);
const R = (id: string, d: 1 | -1 = 1): Part => [id, d];

// ── route templates ─────────────────────────────────────────────────────────
const ROUTES = {
  park5k: () => [R('HP'), R('PARK'), R('HP', -1)],
  park10k: () => [R('HP'), R('PARK'), R('PARK'), R('HP', -1)],
  lakeOut: () => [R('HP'), R('PL'), R('LAKE')],
  lakeOutBack: () => {
    const o = [R('HP'), R('PL'), R('LAKE')];
    return [...o, ...rev(o)];
  },
  hills: () => [R('HB'), R('HILL'), R('HILL', -1), R('HILL'), R('HILL', -1), R('HB', -1)],
  long: () => {
    const o = [R('HP'), R('PL'), R('LAKE')];
    return [...o, ...rev(o).slice(0, 3), R('PARK'), R('HP', -1)];
  },
  ride36: () => [R('RN'), R('RL1'), R('RL2')],
  ride58: () => [R('RN'), R('RL1'), R('RL2'), R('RL1'), R('RL2')],
  ride80: () => [R('RN'), R('RL1'), R('RL2'), R('RL1'), R('RL2'), R('RL1'), R('RL2')],
  spin: () => {
    const o = [R('HP'), R('PL'), R('LAKE')];
    return [...o, ...rev(o)];
  },
};

// ── physiology helpers ─────────────────────────────────────────────────────
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rideSpeed(P: number, grade: number, mass: number, cda = 0.32, crr = 0.0045): number {
  // solve P = v (m g (sinθ + crr cosθ) + 0.5 ρ CdA v²)·(1/0.975)
  const th = Math.atan(grade),
    g = 9.81,
    rho = 1.0; // ~900 m altitude
  const F0 = mass * g * (Math.sin(th) + crr * Math.cos(th));
  let v = 6;
  for (let i = 0; i < 30; i++) {
    const f = v * (F0 + 0.5 * rho * cda * v * v) - P * 0.975;
    const df = F0 + 1.5 * rho * cda * v * v;
    v = Math.max(0.5, v - f / df);
  }
  return Math.min(v, 17.5);
}

type RunKind = 'easy' | 'long' | 'tempo' | 'intervals' | 'recovery' | 'race' | 'hills';
type RideKind = 'endurance' | 'tempo' | 'long' | 'spin' | 'sweetspot';

interface RunCfg {
  kind: RunKind;
  thr: number; // m/s threshold (flat)
  fit: number; // 0‥1 fitness for HR shift
  lthr: number;
  rest: number;
  maxHR: number;
}

/** relative flat-equivalent effort (× threshold speed) at time t for a structured run */
function runEffort(kind: RunKind, t: number, total: number, r: () => number): number {
  switch (kind) {
    case 'easy':
      return 0.8 + 0.02 * Math.sin(t / 240);
    case 'recovery':
      return 0.74;
    case 'long':
      return 0.79 - 0.045 * (t / Math.max(1, total)) + 0.01 * Math.sin(t / 400);
    case 'tempo':
      if (t < 600) return 0.76 + 0.1 * (t / 600);
      if (t < 600 + 1500) return 0.985;
      return 0.74;
    case 'intervals': {
      if (t < 720) return 0.76 + 0.06 * (t / 720);
      const k = t - 720;
      const rep = Math.floor(k / 300);
      if (rep < 6) return k % 300 < 180 ? 1.075 : 0.7;
      return 0.72;
    }
    case 'hills':
      return 0.86;
    case 'race':
      return t < 60 ? 1.04 : 1.0 + 0.03 * smoothstep(0.85, 1, t / Math.max(1, total)) - 0.005 * r();
  }
}

function pushPoint(out: RawPoint[], t: number, p: Path, s: number, jx: number, jy: number, ejit: number, hr: number, cad: number, pwr: number | undefined) {
  // locate s on path
  let lo = 0,
    hi = p.cum.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (p.cum[m] <= s) lo = m;
    else hi = m;
  }
  const span = p.cum[hi] - p.cum[lo];
  const u = span > 0 ? Math.min(1, Math.max(0, (s - p.cum[lo]) / span)) : 0;
  const x = p.x[lo] + (p.x[hi] - p.x[lo]) * u + jx,
    y = p.y[lo] + (p.y[hi] - p.y[lo]) * u + jy;
  const [la, lo2] = fromXY(x, y, LAT0, LON0);
  out.push({ t, lat: +la.toFixed(7), lon: +lo2.toFixed(7), alt: +(p.e[lo] + (p.e[hi] - p.e[lo]) * u + ejit).toFixed(1), hr: Math.round(hr), cad: Math.round(cad), pwr: pwr != null ? Math.round(pwr) : undefined });
}

function simulateRun(p: Path, cfg: RunCfg, start: number, rr: ReturnType<typeof rng>): RawPoint[] {
  const out: RawPoint[] = [];
  let s = 0,
    t = 0,
    hr = cfg.rest + 25;
  let jx = 0,
    jy = 0,
    ej = 0,
    pace = 0;
  const estTotal = p.len / (cfg.thr * 0.8);
  const hrShift = (1 - cfg.fit) * 4;
  while (s < p.len && t < 4 * 3600) {
    const eff = runEffort(cfg.kind, t, estTotal, rr.next) * (1 + pace);
    pace = pace * 0.97 + rr.gauss() * 0.006;
    // grade at s
    let lo = 0,
      hi = p.cum.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (p.cum[m] <= s) lo = m;
      else hi = m;
    }
    const g = p.grade[lo];
    const vflat = eff * cfg.thr;
    const v = Math.max(1.4, Math.min(6.2, vflat / gapFactor(g, 0.55)));
    // HR responds to flat-equivalent effort (+ cardiac drift after 20 min)
    const rel = vflat / cfg.thr;
    const drift = 1 + 0.0004 * Math.max(0, t / 60 - 20);
    const tgt = Math.min(cfg.maxHR - 1, cfg.lthr * (0.5 + 0.5 * Math.pow(Math.max(0.3, rel), 1.25)) * drift + hrShift * 0 - hrShift);
    const tau = tgt > hr ? 18 : 30;
    hr += (tgt - hr) / tau + rr.gauss() * 0.6;
    const cad = 160 + 22 * (rel - 0.7) + rr.gauss() * 1.6;
    jx = jx * 0.97 + rr.gauss() * 0.62;
    jy = jy * 0.97 + rr.gauss() * 0.62;
    ej = ej * 0.9 + rr.gauss() * 0.35;
    pushPoint(out, start + t * 1000, p, s, jx, jy, ej, hr, cad, undefined);
    s += v;
    t++;
  }
  return out;
}

interface RideCfg {
  kind: RideKind;
  ftp: number;
  fit: number;
  lthr: number;
  rest: number;
  maxHR: number;
  mass: number;
}
function simulateRide(p: Path, cfg: RideCfg, start: number, rr: ReturnType<typeof rng>): RawPoint[] {
  const out: RawPoint[] = [];
  let s = 0,
    t = 0,
    hr = cfg.rest + 25,
    jx = 0,
    jy = 0,
    ej = 0,
    pw = 0,
    pn = 0;
  const lights: number[] = [];
  for (let d = 2500 + rr.range(0, 1500); d < p.len; d += 3000 + rr.range(0, 3500)) lights.push(d);
  let li = 0,
    stopLeft = 0;
  const hrShift = (1 - cfg.fit) * 4;
  const base = { endurance: 0.66, tempo: 0.82, long: 0.62, spin: 0.55, sweetspot: 0.9 }[cfg.kind];
  while (s < p.len && t < 8 * 3600) {
    let lo = 0,
      hi = p.cum.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (p.cum[m] <= s) lo = m;
      else hi = m;
    }
    const g = p.grade[lo];
    let v: number;
    let P: number;
    if (stopLeft > 0) {
      stopLeft--;
      v = 0;
      P = 0;
    } else {
      pn = pn * 0.96 + rr.gauss() * 0.045;
      let rel = base * (1 + pn);
      if (cfg.kind === 'tempo' && t > 600 && t < 600 + 2400) rel = 0.95 + pn * 0.5;
      if (cfg.kind === 'sweetspot' && t > 600 && t < 600 + 2700) rel = 0.92 + pn * 0.5;
      if (g > 0.025) rel *= 1.07;
      else if (g < -0.02) rel *= 0.25;
      if (cfg.kind === 'long') rel *= 1 - 0.07 * (t / 14400);
      P = Math.max(0, cfg.ftp * rel);
      pw = pw * 0.7 + P * 0.3;
      v = rideSpeed(pw, g, cfg.mass);
      if (li < lights.length && s >= lights[li]) {
        stopLeft = Math.round(rr.range(6, 28));
        li++;
      }
    }
    const relP = (pw || 0) / cfg.ftp;
    const drift = 1 + 0.0003 * Math.max(0, t / 60 - 30);
    const tgt = stopLeft > 0 ? cfg.rest + 28 : Math.min(cfg.maxHR - 1, cfg.lthr * (0.5 + 0.5 * Math.pow(Math.max(0.3, relP), 1.15)) * 0.96 * drift - hrShift);
    hr += (tgt - hr) / (tgt > hr ? 22 : 34) + rr.gauss() * 0.5;
    const cad = P > 15 ? 88 + rr.gauss() * 5 + (g > 0.03 ? -8 : 0) : 0;
    jx = jx * 0.97 + rr.gauss() * 0.62;
    jy = jy * 0.97 + rr.gauss() * 0.62;
    ej = ej * 0.9 + rr.gauss() * 0.35;
    pushPoint(out, start + t * 1000, p, s, jx, jy, ej, hr, cad, P > 0 ? P + rr.gauss() * 6 : 0);
    s += v;
    t++;
  }
  return out;
}

// ── schedule ────────────────────────────────────────────────────────────────
export interface DemoOpts {
  now: number; // epoch ms ("today")
  weeks?: number;
  seed?: number;
  tz?: number;
}

export const DEMO_TZ = 330;

export const DEMO_PROFILE: Profile = {
  ...DEFAULT_PROFILE,
  name: 'Riya (demo)',
  weightKg: 58,
  sex: 'f',
  maxHR: 189,
  restHR: 49,
  lthr: 167,
  ftp: 232,
  thresholdSpeed: 3.85,
};

export const DEMO_GEAR: Gear[] = [
  { id: 'g_trainer', name: 'Daily trainers', kind: 'shoes', retireAtKm: 700, startKm: 180 },
  { id: 'g_racer', name: 'Race flats', kind: 'shoes', retireAtKm: 450, startKm: 20 },
  { id: 'g_road', name: 'Road bike', kind: 'bike', retireAtKm: 20000, startKm: 2400 },
];
export const DEMO_GEAR_NAMES: Record<string, string> = { 'Daily trainers': 'g_trainer', 'Race flats': 'g_racer', 'Road bike': 'g_road' };

export const DEMO_GOALS: Goal[] = [
  { id: 'goal_week_run', metric: 'distance', period: 'week', target: 40_000, sport: 'run' },
  { id: 'goal_month_all', metric: 'time', period: 'month', target: 30 * 3600, sport: 'all' },
  { id: 'goal_year_run', metric: 'distance', period: 'year', target: 1500_000, sport: 'run' },
];

export interface DemoActivity extends ParsedActivity {
  gearName: string;
}

export function* generateDemo(opts: DemoOpts): Generator<DemoActivity> {
  const tz = opts.tz ?? DEMO_TZ;
  const W = opts.weeks ?? 52;
  const rr = rng(opts.seed ?? 20260809);
  const todayLocal = Math.floor((opts.now + tz * 60000) / 86400000);
  const lastDay = todayLocal - 1; // up to yesterday
  const firstDay = lastDay - W * 7 + 1;
  // align to Monday
  const dow0 = (((firstDay + 4) % 7) + 7) % 7; // 0 = Sun
  const monday0 = firstDay - ((dow0 + 6) % 7);

  const vol = (w: number): number => {
    const fromEnd = W - 1 - w;
    let v = 0.62 + 0.42 * smoothstep(0, 36, w);
    if (w % 4 === 3) v *= 0.78;
    if (w === 20 || w === 21) v = 0; // travel
    if (w === 33) v *= 0.35; // illness
    if (w === 37) v *= 0.7; // taper
    if (w === 38) v *= 0.6; // post-race
    if (fromEnd <= 1) v = Math.max(v, 0.82) * 1.28; // recent ramp
    return v;
  };

  const raceWeek = 37,
    ttWeek = 24;
  for (let w = 0; w < W; w++) {
    const v = vol(w);
    if (v <= 0) continue;
    const fit = smoothstep(-2, W - 8, w - (w > 33 ? 3 : 0));
    const thr = 3.5 + 0.38 * fit; // m/s
    const ftp = 205 + 32 * fit;
    for (let dow = 0; dow < 7; dow++) {
      const day = monday0 + w * 7 + dow;
      if (day < firstDay || day > lastDay) continue;
      const skip = rr.next();
      let plan: { sport: Sport; kind: string } | undefined;
      switch (dow) {
        case 0:
          if (W - 1 - w <= 1 && skip < 0.9) plan = { sport: 'run', kind: 'easy' }; // recent ramp: extra day
          break; // Monday rest otherwise
        case 1:
          if (skip < 0.9 * Math.min(1, v + 0.3)) plan = { sport: 'run', kind: 'easy' };
          break;
        case 2:
          if (skip < 0.92) plan = { sport: 'run', kind: w % 2 ? 'tempo' : 'intervals' };
          break;
        case 3:
          if (skip < 0.85) plan = { sport: 'run', kind: rr.next() < 0.35 ? 'hills' : 'recovery' };
          break;
        case 4:
          if (W - 1 - w <= 1) plan = { sport: 'run', kind: 'easy' };
          else if (skip < 0.4) plan = { sport: 'ride', kind: 'spin' };
          break;
        case 5:
          if (w === raceWeek) plan = { sport: 'run', kind: 'race' };
          else if (w === ttWeek) plan = { sport: 'run', kind: 'race5' };
          else if (skip < 0.82) plan = { sport: 'ride', kind: rr.next() < 0.5 ? 'long' : rr.next() < 0.5 ? 'tempo' : 'sweetspot' };
          break;
        case 6:
          if (skip < 0.93) plan = { sport: 'run', kind: 'long' };
          break;
      }
      if (!plan) continue;
      if (plan.kind === 'long' && plan.sport === 'run' && v < 0.4) plan.kind = 'easy';

      const hour = dow >= 5 ? 6 + rr.range(0, 1.2) : rr.next() < 0.7 ? 6 + rr.range(0, 1) : 17.5 + rr.range(0, 1.5);
      const startMs = day * 86400000 + Math.round(hour * 3600000) - tz * 60000;
      const sim = rng(Math.floor(rr.next() * 1e9));
      let points: RawPoint[];
      let name: string;
      let gearName = '';
      let notes: string | undefined;

      if (plan.sport === 'run') {
        const cfg: RunCfg = { kind: 'easy', thr, fit, lthr: DEMO_PROFILE.lthr, rest: DEMO_PROFILE.restHR, maxHR: DEMO_PROFILE.maxHR };
        let parts: Part[];
        let maxLen: number | undefined;
        const pickShort = () => (sim.next() < 0.55 ? ROUTES.park5k() : (maxLen = 4500 + sim.range(0, 3500), ROUTES.lakeOutBack()));
        switch (plan.kind) {
          case 'easy':
            cfg.kind = 'easy';
            parts = pickShort();
            name = 'Easy run';
            gearName = 'Daily trainers';
            break;
          case 'recovery':
            cfg.kind = 'recovery';
            parts = ROUTES.park5k();
            name = 'Recovery jog';
            gearName = 'Daily trainers';
            break;
          case 'hills':
            cfg.kind = 'hills';
            parts = ROUTES.hills();
            name = 'Hill repeats';
            gearName = 'Daily trainers';
            break;
          case 'tempo':
            cfg.kind = 'tempo';
            parts = ROUTES.park10k();
            name = 'Tempo — 25 min @ threshold';
            gearName = 'Race flats';
            break;
          case 'intervals':
            cfg.kind = 'intervals';
            parts = ROUTES.park10k();
            name = 'Intervals 6 × 3 min';
            gearName = 'Race flats';
            break;
          case 'race':
            cfg.kind = 'race';
            parts = ROUTES.lakeOutBack();
            maxLen = 10000;
            name = '10K race — season opener';
            gearName = 'Race flats';
            notes = 'Demo race: negative split, felt controlled.';
            break;
          case 'race5':
            cfg.kind = 'race';
            parts = ROUTES.park5k();
            maxLen = 5000;
            name = '5K time trial';
            gearName = 'Race flats';
            break;
          case 'long':
          default: {
            cfg.kind = 'long';
            const base = ROUTES.long();
            parts = sim.next() < 0.5 ? base : [...base.slice(0, -2), R('PARK'), R('PARK'), R('HP', -1)];
            maxLen = Math.max(9000, Math.min(24000, 15000 * v * (0.9 + sim.next() * 0.2)));
            name = 'Long run';
            gearName = 'Daily trainers';
          }
        }
        const path = buildPath(parts, maxLen);
        points = simulateRun(path, cfg, startMs, sim);
      } else {
        const cfg: RideCfg = { kind: 'endurance', ftp, fit, lthr: DEMO_PROFILE.lthr, rest: DEMO_PROFILE.restHR, maxHR: DEMO_PROFILE.maxHR, mass: DEMO_PROFILE.weightKg + 9 };
        let parts: Part[];
        let maxLen: number | undefined;
        gearName = 'Road bike';
        switch (plan.kind) {
          case 'spin':
            cfg.kind = 'spin';
            parts = ROUTES.spin();
            maxLen = 14000 + sim.range(0, 6000);
            name = 'Recovery spin';
            break;
          case 'tempo':
            cfg.kind = 'tempo';
            parts = ROUTES.ride36();
            name = 'Tempo ride';
            break;
          case 'sweetspot':
            cfg.kind = 'sweetspot';
            parts = ROUTES.ride36();
            name = 'Sweet-spot ride';
            break;
          default:
            cfg.kind = 'long';
            parts = v > 0.9 ? ROUTES.ride80() : ROUTES.ride58();
            maxLen = (v > 0.9 ? 80000 : 58000) * (0.92 + sim.next() * 0.1);
            name = 'Long ride';
        }
        const path = buildPath(parts, maxLen);
        points = simulateRide(path, cfg, startMs, sim);
      }
      yield { name, sport: plan.sport, points, source: 'demo', gearName, notes };
    }
  }
}

/** A few weeks of daily check-ins (resting HR / HRV / sleep / soreness) ending yesterday. */
export function demoCheckIns(now: number, tz = DEMO_TZ): CheckIn[] {
  const rr = rng(77);
  const today = Math.floor((now + tz * 60000) / 86400000);
  const out: CheckIn[] = [];
  for (let k = 21; k >= 1; k--) {
    const d = today - k;
    const recent = k <= 2 ? 1 : 0;
    out.push({
      date: new Date(d * 86400000).toISOString().slice(0, 10),
      restHR: Math.round(49 + rr.gauss() * 1.2 + recent * 3),
      hrv: Math.round(68 + rr.gauss() * 5 - recent * 7),
      sleepH: +(7.4 + rr.gauss() * 0.5 - recent * 0.6).toFixed(1),
      soreness: Math.max(1, Math.min(5, Math.round(2 + rr.gauss() * 0.6 + recent))),
      mood: Math.max(1, Math.min(5, Math.round(4 + rr.gauss() * 0.5 - recent * 0.5))),
    });
  }
  return out;
}

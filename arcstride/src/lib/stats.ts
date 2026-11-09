export const sum = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};
export const mean = (a: ArrayLike<number>) => (a.length ? sum(a) / a.length : NaN);

export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
export function stdev(a: ArrayLike<number>): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / a.length);
}

export interface LinFit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}
export function linreg(xs: number[], ys: number[]): LinFit {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, n };
  const mx = mean(xs),
    my = mean(ys);
  let sxx = 0,
    sxy = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0, n };
}

/** Centered moving average with edge shrinking. NaN-aware (ignores NaNs). */
export function smooth(a: ArrayLike<number>, halfWin: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  // prefix sums over valid values
  const ps = new Float64Array(n + 1);
  const pc = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = a[i];
    const ok = v === v; // not NaN
    ps[i + 1] = ps[i] + (ok ? v : 0);
    pc[i + 1] = pc[i] + (ok ? 1 : 0);
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin),
      hi = Math.min(n, i + halfWin + 1);
    const c = pc[hi] - pc[lo];
    out[i] = c ? (ps[hi] - ps[lo]) / c : NaN;
  }
  return out;
}

/** Trailing rolling mean (window w); first w-1 entries use the partial window. */
export function rollingMean(a: ArrayLike<number>, w: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += a[i] || 0;
    if (i >= w) s -= a[i - w] || 0;
    out[i] = s / Math.min(i + 1, w);
  }
  return out;
}

/** Largest-Triangle-Three-Buckets downsample → indices to keep. */
export function lttbIndices(xs: ArrayLike<number>, ys: ArrayLike<number>, threshold: number): number[] {
  const n = xs.length;
  if (threshold >= n || threshold < 3) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let ax = 0,
      ay = 0,
      cnt = 0;
    for (let j = avgStart; j < avgEnd; j++) {
      if (ys[j] === ys[j]) {
        ax += xs[j];
        ay += ys[j];
        cnt++;
      }
    }
    if (cnt) {
      ax /= cnt;
      ay /= cnt;
    } else {
      ax = xs[Math.min(avgStart, n - 1)];
      ay = 0;
    }
    const rs = Math.floor(i * every) + 1;
    const re = Math.floor((i + 1) * every) + 1;
    let maxArea = -1,
      next = rs;
    const pax = xs[a],
      pay = ys[a] === ys[a] ? ys[a] : 0;
    for (let j = rs; j < re; j++) {
      const yj = ys[j] === ys[j] ? ys[j] : 0;
      const area = Math.abs((pax - ax) * (yj - pay) - (pax - xs[j]) * (ay - pay));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(next);
    a = next;
  }
  out.push(n - 1);
  return out;
}

/** First index i in sorted ascending `a` with a[i] >= v (or a.length). */
export function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0,
      v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, gauss, range: (a: number, b: number) => a + (b - a) * next(), pick: <T>(arr: T[]) => arr[Math.floor(next() * arr.length)] };
}

/** Nice axis ticks. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Float64 variant of `smooth` (needed for lat/lon precision). */
export function smooth64(a: ArrayLike<number>, halfWin: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  const ps = new Float64Array(n + 1);
  const pc = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = a[i];
    const ok = v === v;
    ps[i + 1] = ps[i] + (ok ? v : 0);
    pc[i + 1] = pc[i] + (ok ? 1 : 0);
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin),
      hi = Math.min(n, i + halfWin + 1);
    const c = pc[hi] - pc[lo];
    out[i] = c ? (ps[hi] - ps[lo]) / c : NaN;
  }
  return out;
}

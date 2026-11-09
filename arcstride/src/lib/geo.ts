const R = 6371008.8;
const D2R = Math.PI / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Fast equirectangular distance (fine below ~50 km). */
export function fastDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * D2R * Math.cos(((lat1 + lat2) / 2) * D2R);
  const y = (lat2 - lat1) * D2R;
  return R * Math.sqrt(x * x + y * y);
}

export const M_PER_DEG_LAT = (Math.PI * R) / 180; // ≈ 111 195 m

export function toXY(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  return [(lon - lon0) * M_PER_DEG_LAT * Math.cos(lat0 * D2R), (lat - lat0) * M_PER_DEG_LAT];
}
export function fromXY(x: number, y: number, lat0: number, lon0: number): [number, number] {
  return [lat0 + y / M_PER_DEG_LAT, lon0 + x / (M_PER_DEG_LAT * Math.cos(lat0 * D2R))];
}

export type BBox = [minLat: number, minLon: number, maxLat: number, maxLon: number];

export function bboxOf(lat: ArrayLike<number>, lon: ArrayLike<number>): BBox | undefined {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i],
      lo = lon[i];
    if (!isFinite(la) || !isFinite(lo)) continue;
    if (la < a) a = la;
    if (la > c) c = la;
    if (lo < b) b = lo;
    if (lo > d) d = lo;
  }
  return isFinite(a) ? [a, b, c, d] : undefined;
}

export function bboxIntersects(a: BBox, b: BBox, padM = 0): boolean {
  const pLat = padM / M_PER_DEG_LAT;
  const pLon = padM / (M_PER_DEG_LAT * Math.cos(((a[0] + a[2]) / 2) * D2R));
  return !(a[2] + pLat < b[0] || b[2] + pLat < a[0] || a[3] + pLon < b[1] || b[3] + pLon < a[1]);
}

/** Ramer–Douglas–Peucker on lat/lon (metres tolerance). Returns kept indices. */
export function rdpIndices(lat: ArrayLike<number>, lon: ArrayLike<number>, epsM: number): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const lat0 = lat[Math.floor(n / 2)],
    lon0 = lon[Math.floor(n / 2)];
  const xs = new Float64Array(n),
    ys = new Float64Array(n);
  for (let i = 0; i < n; i++) [xs[i], ys[i]] = toXY(lat[i], lon[i], lat0, lon0);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0,
      idx = -1;
    const dx = xs[e] - xs[s],
      dy = ys[e] - ys[s];
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      let d: number;
      if (len2 === 0) d = Math.hypot(xs[i] - xs[s], ys[i] - ys[s]);
      else {
        const t = Math.max(0, Math.min(1, ((xs[i] - xs[s]) * dx + (ys[i] - ys[s]) * dy) / len2));
        d = Math.hypot(xs[i] - (xs[s] + t * dx), ys[i] - (ys[s] + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsM && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Simplify to at most `maxPts` points by growing RDP tolerance. Returns flat [lat,lon,…]. */
export function simplifyFlat(lat: ArrayLike<number>, lon: ArrayLike<number>, maxPts: number): number[] {
  let eps = 2;
  let idx = rdpIndices(lat, lon, eps);
  while (idx.length > maxPts && eps < 5000) {
    eps *= 1.6;
    idx = rdpIndices(lat, lon, eps);
  }
  const out: number[] = [];
  for (const i of idx) out.push(+lat[i].toFixed(6), +lon[i].toFixed(6));
  return out;
}

/** Spatial hash for nearest-point queries in metres. */
export class PointGrid {
  private cells = new Map<number, number[]>();
  private cellDegLat: number;
  private cellDegLon: number;
  constructor(
    private lat: ArrayLike<number>,
    private lon: ArrayLike<number>,
    cellM: number,
    refLat?: number,
  ) {
    const rl = refLat ?? lat[Math.floor(lat.length / 2)] ?? 0;
    this.cellDegLat = cellM / M_PER_DEG_LAT;
    this.cellDegLon = cellM / (M_PER_DEG_LAT * Math.cos(rl * D2R));
    for (let i = 0; i < lat.length; i++) {
      const k = this.key(this.cy(lat[i]), this.cx(lon[i]));
      const arr = this.cells.get(k);
      if (arr) arr.push(i);
      else this.cells.set(k, [i]);
    }
  }
  private cy(la: number) {
    return Math.floor(la / this.cellDegLat);
  }
  private cx(lo: number) {
    return Math.floor(lo / this.cellDegLon);
  }
  private key(y: number, x: number) {
    return y * 4194304 + x; // y,x are < 2^22 in magnitude for these cell sizes
  }
  /** indices of points within radiusM (searches the 3×3 block; radius must be ≤ cell size). */
  near(la: number, lo: number, radiusM: number): number[] {
    const cy = this.cy(la),
      cx = this.cx(lo);
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.cells.get(this.key(cy + dy, cx + dx));
        if (!arr) continue;
        for (const i of arr) if (fastDist(la, lo, this.lat[i], this.lon[i]) <= radiusM) out.push(i);
      }
    return out;
  }
  nearest(la: number, lo: number, radiusM: number): { i: number; d: number } | undefined {
    let best: { i: number; d: number } | undefined;
    const cy = this.cy(la),
      cx = this.cx(lo);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.cells.get(this.key(cy + dy, cx + dx));
        if (!arr) continue;
        for (const i of arr) {
          const d = fastDist(la, lo, this.lat[i], this.lon[i]);
          if (d <= radiusM && (!best || d < best.d)) best = { i, d };
        }
      }
    return best;
  }
}

// ── Web-Mercator helpers (for map rendering and tile statistics) ────────────
export function mercX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 256 * 2 ** z;
}
export function mercY(lat: number, z: number): number {
  const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
}
export function unmercX(x: number, z: number): number {
  return (x / (256 * 2 ** z)) * 360 - 180;
}
export function unmercY(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Area-preserving check: polyline length in metres. */
export function pathLength(lat: ArrayLike<number>, lon: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < lat.length; i++) s += fastDist(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  return s;
}

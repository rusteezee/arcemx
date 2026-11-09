import type { ActivitySummary, Sport, Track } from '../types';
import { fastDist, mercX, mercY } from '../geo';
import type { TrackEntry } from './segments';

// ───────────────────────── Route matching ("Matched runs") ───────────────
const SIG_N = 48;

export interface RouteSig {
  lat: Float64Array;
  lon: Float64Array;
  length: number;
}

export function routeSignature(t: Track): RouteSig {
  const lat = new Float64Array(SIG_N),
    lon = new Float64Array(SIG_N);
  const total = t.d[t.n - 1] - t.d[0];
  let k = 0;
  for (let s = 0; s < SIG_N; s++) {
    const target = t.d[0] + (total * s) / (SIG_N - 1);
    while (k < t.n - 2 && t.d[k + 1] < target) k++;
    const span = t.d[k + 1] - t.d[k];
    const u = span > 0 ? Math.min(1, Math.max(0, (target - t.d[k]) / span)) : 0;
    lat[s] = t.lat[k] + (t.lat[k + 1] - t.lat[k]) * u;
    lon[s] = t.lon[k] + (t.lon[k + 1] - t.lon[k]) * u;
  }
  return { lat, lon, length: total };
}

/** Ordered mean / max point distance between two signatures (metres). */
export function sigDistance(a: RouteSig, b: RouteSig): { mean: number; max: number } {
  let sum = 0,
    max = 0;
  for (let i = 0; i < SIG_N; i++) {
    const d = fastDist(a.lat[i], a.lon[i], b.lat[i], b.lon[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / SIG_N, max };
}

export interface RouteGroup {
  id: string;
  sport: Sport;
  members: ActivitySummary[]; // newest first
  rep: ActivitySummary;
  length: number;
}

/** Cluster activities that follow the same route (same sport, ±8 % length, ordered shape within tolerance). */
export function groupRoutes(entries: TrackEntry[], minMembers = 3): RouteGroup[] {
  const sigs = new Map<string, RouteSig>();
  const groups: { sig: RouteSig; sport: Sport; members: ActivitySummary[] }[] = [];
  const sorted = [...entries].filter((e) => e.track.n > 5 && e.summary.distance > 800).sort((a, b) => b.summary.start - a.summary.start);
  for (const e of sorted) {
    const sig = routeSignature(e.track);
    sigs.set(e.summary.id, sig);
    let placed = false;
    for (const g of groups) {
      if (g.sport !== e.summary.sport) continue;
      if (Math.abs(sig.length - g.sig.length) / g.sig.length > 0.08) continue;
      const { mean, max } = sigDistance(sig, g.sig);
      if (mean < 45 && max < 160) {
        g.members.push(e.summary);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ sig, sport: e.summary.sport, members: [e.summary] });
  }
  return groups
    .filter((g) => g.members.length >= minMembers)
    .map((g) => ({ id: `r_${g.members[g.members.length - 1].id}`, sport: g.sport, members: g.members, rep: g.members[0], length: g.sig.length }))
    .sort((a, b) => b.members.length - a.members.length);
}

// ───────────────────────── Explorer tiles ────────────────────────────────
export const TILE_Z = 14;

export interface TileStats {
  tiles: Map<string, { x: number; y: number; first: number }>;
  count: number;
  maxSquare: number;
  newLast30: number;
}

export function tileStats(entries: TrackEntry[], now: number, z = TILE_Z): TileStats {
  const tiles = new Map<string, { x: number; y: number; first: number }>();
  for (const e of entries) {
    const { track, summary } = e;
    let lastKey = '';
    for (let i = 0; i < track.n; i++) {
      const x = Math.floor(mercX(track.lon[i], z) / 256);
      const y = Math.floor(mercY(track.lat[i], z) / 256);
      const key = `${x}:${y}`;
      if (key === lastKey) continue;
      lastKey = key;
      const cur = tiles.get(key);
      if (!cur) tiles.set(key, { x, y, first: summary.start });
      else if (summary.start < cur.first) cur.first = summary.start;
    }
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const t of tiles.values()) {
    minX = Math.min(minX, t.x);
    maxX = Math.max(maxX, t.x);
    minY = Math.min(minY, t.y);
    maxY = Math.max(maxY, t.y);
  }
  let maxSquare = 0;
  if (tiles.size) {
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    const dp: Int32Array[] = Array.from({ length: h }, () => new Int32Array(w));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!tiles.has(`${x + minX}:${y + minY}`)) continue;
        dp[y][x] = 1 + (x > 0 && y > 0 ? Math.min(dp[y - 1][x], dp[y][x - 1], dp[y - 1][x - 1]) : 0);
        if (dp[y][x] > maxSquare) maxSquare = dp[y][x];
      }
  }
  const cutoff = now - 30 * 86400000;
  let newLast30 = 0;
  for (const t of tiles.values()) if (t.first >= cutoff) newLast30++;
  return { tiles, count: tiles.size, maxSquare, newLast30 };
}

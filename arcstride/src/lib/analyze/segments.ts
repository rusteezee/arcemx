import type { ActivitySummary, Segment, SegmentEffort, Sport, Track } from '../types';
import { PointGrid, fastDist, M_PER_DEG_LAT } from '../geo';
import { elevGainLoss } from './process';

export interface TrackEntry {
  summary: ActivitySummary;
  track: Track;
}

const START_R = 30; // m: radius within which a track "touches" a segment start/end
const SHAPE_TOL = 35; // m: max deviation between segment path and effort path
const GRID_CELL = 40;

const gridCache = new WeakMap<Track, PointGrid>();
function gridFor(t: Track): PointGrid {
  let g = gridCache.get(t);
  if (!g) {
    g = new PointGrid(t.lat, t.lon, GRID_CELL);
    gridCache.set(t, g);
  }
  return g;
}

export function unpackPath(flat: number[]): { lat: Float64Array; lon: Float64Array } {
  const n = flat.length >> 1;
  const lat = new Float64Array(n),
    lon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = flat[2 * i];
    lon[i] = flat[2 * i + 1];
  }
  return { lat, lon };
}

/** Resample a track slice [i0..i1] to ≈ `step` m spacing along its length. */
function resample(track: Track, i0: number, i1: number, step = 10): number[] {
  const out: number[] = [];
  const d0 = track.d[i0];
  const total = track.d[i1] - d0;
  const n = Math.max(2, Math.round(total / step) + 1);
  let k = i0;
  for (let s = 0; s < n; s++) {
    const target = d0 + (total * s) / (n - 1);
    while (k < i1 - 1 && track.d[k + 1] < target) k++;
    const span = track.d[k + 1] - track.d[k];
    const u = span > 0 ? Math.min(1, Math.max(0, (target - track.d[k]) / span)) : 0;
    out.push(+(track.lat[k] + (track.lat[k + 1] - track.lat[k]) * u).toFixed(6), +(track.lon[k] + (track.lon[k + 1] - track.lon[k]) * u).toFixed(6));
  }
  return out;
}

/** Create a segment from a stretch of an activity track (indices into the Track arrays). */
export function segmentFromTrack(track: Track, i0: number, i1: number, name: string, sport: Sport, auto = false): Segment {
  const path = resample(track, i0, i1);
  const length = track.d[i1] - track.d[i0];
  const alt = Array.from(track.alt.subarray(i0, i1 + 1));
  const gain = elevGainLoss(alt, 2.5).gain;
  const id = `s${auto ? 'a' : 'u'}_${Math.round(path[0] * 1e4)}_${Math.round(path[1] * 1e4)}_${Math.round(length)}`;
  return { id, name, sport, createdAt: Date.now(), path, length, elevGain: gain, auto };
}

/** Fractional index into `track` of the point on the polyline nearest to (lat,lon) within [lo,hi]. */
function projectFrac(track: Track, lo: number, hi: number, lat: number, lon: number): number {
  let best = Infinity,
    bestK = lo;
  const cosL = Math.cos((lat * Math.PI) / 180);
  for (let k = Math.max(0, lo); k < Math.min(track.n - 1, hi); k++) {
    const ax = (track.lon[k] - lon) * cosL,
      ay = track.lat[k] - lat;
    const bx = (track.lon[k + 1] - lon) * cosL,
      by = track.lat[k + 1] - lat;
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + u * dx,
      py = ay + u * dy;
    const dd = px * px + py * py;
    if (dd < best) {
      best = dd;
      bestK = k + u;
    }
  }
  return bestK;
}

function interp(arr: ArrayLike<number>, f: number) {
  const k = Math.floor(f);
  const u = f - k;
  const a = arr[k],
    b = arr[Math.min(arr.length - 1, k + 1)];
  return a + (b - a) * u;
}

/** All efforts of `seg` within one activity (a segment can be repeated within a workout). */
export function matchSegment(seg: Segment, e: TrackEntry): SegmentEffort[] {
  const { track, summary } = e;
  if (track.n < 4 || summary.sport !== seg.sport) return [];
  const sp = unpackPath(seg.path);
  const m = sp.lat.length;
  if (m < 2) return [];
  // cheap bbox reject
  const bb = summary.bbox;
  if (bb) {
    const pad = 80 / M_PER_DEG_LAT;
    if (sp.lat[0] < bb[0] - pad || sp.lat[0] > bb[2] + pad || sp.lon[0] < bb[1] - pad * 1.5 || sp.lon[0] > bb[3] + pad * 1.5) return [];
  }
  const grid = gridFor(track);
  const near = grid.near(sp.lat[0], sp.lon[0], START_R).sort((a, b) => a - b);
  if (!near.length) return [];
  // cluster consecutive candidate indices, keep the closest of each cluster
  const reps: number[] = [];
  let cluster: number[] = [near[0]];
  const flush = () => {
    let bi = cluster[0],
      bd = Infinity;
    for (const i of cluster) {
      const d = fastDist(sp.lat[0], sp.lon[0], track.lat[i], track.lon[i]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    reps.push(bi);
  };
  for (let q = 1; q < near.length; q++) {
    if (near[q] - near[q - 1] <= 4) cluster.push(near[q]);
    else {
      flush();
      cluster = [near[q]];
    }
  }
  flush();

  const out: SegmentEffort[] = [];
  let minIdx = 0;
  const eLat = sp.lat[m - 1],
    eLon = sp.lon[m - 1];
  for (const i of reps) {
    if (i < minIdx) continue;
    const d0 = track.d[i];
    let j = -1,
      bestEnd = Infinity;
    for (let k = i + 1; k < track.n; k++) {
      const dd = track.d[k] - d0;
      if (dd > seg.length * 1.3 + 60) break;
      if (dd >= seg.length * 0.8) {
        const de = fastDist(eLat, eLon, track.lat[k], track.lon[k]);
        if (de <= START_R) {
          if (de < bestEnd) {
            bestEnd = de;
            j = k;
          }
        } else if (j >= 0) break;
      }
    }
    if (j < 0) continue;
    if (!shapeMatches(sp.lat, sp.lon, track, i, j)) continue;
    const fs = projectFrac(track, i - 2, i + 2, sp.lat[0], sp.lon[0]);
    const fe = projectFrac(track, j - 2, j + 2, eLat, eLon);
    const time = interp(track.t, fe) - interp(track.t, fs);
    if (!(time > 3)) continue;
    // time-weighted HR / power
    let hs = 0,
      hn = 0,
      ps = 0,
      pn = 0;
    for (let k = i; k < j; k++) {
      const w = track.t[k + 1] - track.t[k];
      if (track.hr[k] === track.hr[k]) {
        hs += track.hr[k] * w;
        hn += w;
      }
      if (track.pwr[k] === track.pwr[k]) {
        ps += track.pwr[k] * w;
        pn += w;
      }
    }
    out.push({
      segmentId: seg.id,
      activityId: summary.id,
      start: summary.start + interp(track.t, fs) * 1000,
      time,
      speed: seg.length / time,
      avgHR: hn > 0 ? hs / hn : undefined,
      avgPower: pn > 0 ? ps / pn : undefined,
    });
    minIdx = j;
  }
  return out;
}

/** Two-way shape check: sampled seg points near the effort path AND effort points near the seg path. */
function shapeMatches(sLat: Float64Array, sLon: Float64Array, tr: Track, i: number, j: number): boolean {
  const SAMPLES = 24;
  const m = sLat.length;
  const tn = j - i + 1;
  let ok = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const idx = Math.round((s * (m - 1)) / (SAMPLES - 1));
    let best = Infinity;
    for (let k = i; k <= j; k++) {
      const d = fastDist(sLat[idx], sLon[idx], tr.lat[k], tr.lon[k]);
      if (d < best) best = d;
    }
    if (best <= SHAPE_TOL) ok++;
  }
  if (ok < SAMPLES * 0.9) return false;
  ok = 0;
  const RS = Math.min(SAMPLES, tn);
  for (let s = 0; s < RS; s++) {
    const k = i + Math.round((s * (tn - 1)) / Math.max(1, RS - 1));
    let best = Infinity;
    for (let q = 0; q < m; q++) {
      const d = fastDist(tr.lat[k], tr.lon[k], sLat[q], sLon[q]);
      if (d < best) best = d;
    }
    if (best <= SHAPE_TOL) ok++;
  }
  return ok >= RS * 0.9;
}

/** Efforts for many segments across many activities. */
export function computeEfforts(segments: Segment[], entries: TrackEntry[]): Map<string, SegmentEffort[]> {
  const out = new Map<string, SegmentEffort[]>();
  for (const s of segments) out.set(s.id, []);
  for (const e of entries) {
    for (const s of segments) {
      if (e.summary.sport !== s.sport) continue;
      const f = matchSegment(s, e);
      if (f.length) out.get(s.id)!.push(...f);
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.start - b.start);
  return out;
}

// ───────────────────────── Auto-discovery ────────────────────────────────
export interface DiscoverOpts {
  sport: Sport;
  minCount?: number;
  max?: number;
  minLen?: number;
  maxLen?: number;
}

/**
 * Find stretches you repeat. Counts how many distinct activities touch each ≈25 m cell, then
 * cuts maximal "popular" runs out of your tracks and chunks them to segment-sized pieces.
 */
export function discoverSegments(all: TrackEntry[], opts: DiscoverOpts): Segment[] {
  const entries = all.filter((e) => e.summary.sport === opts.sport && e.track.n > 10);
  const N = entries.length;
  const minCount = opts.minCount ?? Math.max(4, Math.ceil(N * 0.06));
  if (N < minCount) return [];
  const isRide = opts.sport === 'ride';
  const minLen = opts.minLen ?? (isRide ? 2000 : 800);
  const maxLen = opts.maxLen ?? (isRide ? 8000 : 3000);
  const maxOut = opts.max ?? 16;

  let latMin = Infinity,
    lonMin = Infinity,
    latSum = 0,
    latN = 0;
  for (const e of entries) {
    const b = e.summary.bbox;
    if (!b) continue;
    latMin = Math.min(latMin, b[0]);
    lonMin = Math.min(lonMin, b[1]);
    latSum += (b[0] + b[2]) / 2;
    latN++;
  }
  if (!latN) return [];
  const lat0 = latSum / latN;
  const dLat = 25 / M_PER_DEG_LAT;
  const dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
  const W = 1 << 16;
  const keyOf = (la: number, lo: number) => Math.floor((la - latMin) / dLat) * W + Math.floor((lo - lonMin) / dLon);

  // distinct-activity counts per cell
  const counts = new Map<number, number>();
  const entryCells: Int32Array[] = [];
  for (const e of entries) {
    const seen = new Set<number>();
    const cells = new Int32Array(e.track.n);
    for (let i = 0; i < e.track.n; i++) {
      const k = keyOf(e.track.lat[i], e.track.lon[i]);
      cells[i] = k;
      seen.add(k);
    }
    entryCells.push(cells);
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const popMemo = new Map<number, number>();
  const pop = (k: number) => {
    let v = popMemo.get(k);
    if (v === undefined) {
      v = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v = Math.max(v, counts.get(k + dy * W + dx) ?? 0);
      popMemo.set(k, v);
    }
    return v;
  };

  const covered = new Set<number>();
  const candidates: { seg: Segment; support: number }[] = [];
  const order = entries.map((_, i) => i).sort((a, b) => entries[b].summary.start - entries[a].summary.start);

  for (const ei of order) {
    const { track } = entries[ei];
    const cells = entryCells[ei];
    let i = 0;
    while (i < track.n) {
      if (pop(cells[i]) < minCount) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < track.n && pop(cells[j + 1]) >= minCount && track.d[j + 1] - track.d[j] < 200) j++;
      const len = track.d[j] - track.d[i];
      if (len >= minLen) {
        const pieces = Math.max(1, Math.ceil(len / maxLen));
        const target = len / pieces;
        let a = i;
        for (let p = 0; p < pieces; p++) {
          let b = a;
          const goal = track.d[a] + target;
          while (b < j && track.d[b] < goal) b++;
          if (p === pieces - 1) b = j;
          if (track.d[b] - track.d[a] >= minLen * 0.9) {
            // overlap with segments we already accepted?
            let hit = 0;
            const idxs: number[] = [];
            for (let k = a; k <= b; k++) idxs.push(cells[k]);
            for (const c of idxs) if (covered.has(c)) hit++;
            if (hit / idxs.length < 0.6) {
              const seg = segmentFromTrack(track, a, b, '', opts.sport, true);
              const sup = idxs.map(pop).sort((x, y) => x - y)[idxs.length >> 1];
              candidates.push({ seg, support: sup });
              for (const c of idxs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) covered.add(c + dy * W + dx);
            }
          }
          a = b;
        }
      }
      i = j + 1;
    }
  }
  candidates.sort((x, y) => y.support * Math.sqrt(y.seg.length) - x.support * Math.sqrt(x.seg.length));
  return candidates.slice(0, maxOut).map((c, k) => ({
    ...c.seg,
    name: `${opts.sport === 'ride' ? 'Ride' : 'Run'} repeat ${String(k + 1).padStart(2, '0')}`,
  }));
}

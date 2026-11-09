import type { ParsedActivity, RawPoint } from '../src/lib/types';

export const T0 = Date.UTC(2026, 0, 5, 7, 0, 0);

/** A straight-line run heading east at constant speed with optional HR/power/grade. */
export function straightLine(opts: {
  seconds: number;
  speed: number; // m/s
  lat?: number;
  lon?: number;
  hr?: number | ((i: number) => number);
  pwr?: number | ((i: number) => number);
  grade?: number; // fraction
  t0?: number;
  gaps?: [from: number, to: number][]; // recording gaps in seconds (no points inside)
  dist?: boolean;
}): RawPoint[] {
  const lat = opts.lat ?? 12.97;
  const lon0 = opts.lon ?? 77.59;
  const mPerDegLon = 111195 * Math.cos((lat * Math.PI) / 180);
  const pts: RawPoint[] = [];
  for (let i = 0; i <= opts.seconds; i++) {
    if (opts.gaps?.some(([a, b]) => i > a && i < b)) continue;
    const d = i * opts.speed;
    pts.push({
      t: (opts.t0 ?? T0) + i * 1000,
      lat,
      lon: lon0 + d / mPerDegLon,
      alt: 900 + d * (opts.grade ?? 0),
      hr: typeof opts.hr === 'function' ? opts.hr(i) : opts.hr,
      pwr: typeof opts.pwr === 'function' ? opts.pwr(i) : opts.pwr,
      dist: opts.dist ? d : undefined,
    });
  }
  return pts;
}

export const parsed = (points: RawPoint[], sport?: ParsedActivity['sport']): ParsedActivity => ({ points, sport, source: 'file' });

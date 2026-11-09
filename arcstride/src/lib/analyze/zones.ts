import type { Profile } from '../types';

export interface ZoneDef {
  n: number;
  name: string;
  lo: number;
  hi: number; // Infinity for the top zone
}

export const HR_ZONE_NAMES = ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO₂max'];
export const PWR_ZONE_NAMES = ['Recovery', 'Endurance', 'Tempo', 'Threshold', 'VO₂max', 'Anaerobic', 'Neuromuscular'];
export const PACE_ZONE_NAMES = ['Recovery', 'Easy', 'Tempo', 'Threshold', 'Interval'];

/** Zone colours: calm → hard. Tokens stay inside the playbook's signal family. */
export const ZONE_COLORS = ['#71717A', '#4ADE80', '#A3E635', '#FACC15', '#FB923C', '#F87171', '#E879F9'];

/** Upper edges of HR zones 1‥4 (bpm). Zone 5 is everything above the last edge. */
export function hrEdges(p: Profile): number[] {
  switch (p.hrZoneModel) {
    case 'lthr':
      // Friel running zones as % of lactate-threshold HR (Coggan's cycling zones sit ~10 % lower and
      // would label most easy running as "tempo").
      return [0.85, 0.89, 0.94, 1.0].map((f) => f * p.lthr);
    case 'hrr':
      return [0.6, 0.7, 0.8, 0.9].map((f) => p.restHR + f * (p.maxHR - p.restHR));
    case 'maxhr':
    default:
      return [0.6, 0.7, 0.8, 0.9].map((f) => f * p.maxHR);
  }
}

export function hrZones(p: Profile): ZoneDef[] {
  const e = hrEdges(p);
  return HR_ZONE_NAMES.map((name, i) => ({ n: i + 1, name, lo: i === 0 ? 0 : e[i - 1], hi: i < 4 ? e[i] : Infinity }));
}

/** Upper edges of the 7 Coggan power zones (watts), 6 edges. */
export function pwrEdges(p: Profile): number[] {
  return [0.55, 0.75, 0.9, 1.05, 1.2, 1.5].map((f) => f * p.ftp);
}
export function pwrZones(p: Profile): ZoneDef[] {
  const e = pwrEdges(p);
  return PWR_ZONE_NAMES.map((name, i) => ({ n: i + 1, name, lo: i === 0 ? 0 : e[i - 1], hi: i < 6 ? e[i] : Infinity }));
}

/** Upper edges of 5 run pace zones expressed as speeds (m/s) from threshold speed. */
export function paceEdges(p: Profile): number[] {
  return [0.775, 0.885, 0.952, 1.03].map((f) => f * p.thresholdSpeed);
}
export function paceZones(p: Profile): ZoneDef[] {
  const e = paceEdges(p);
  return PACE_ZONE_NAMES.map((name, i) => ({ n: i + 1, name, lo: i === 0 ? 0 : e[i - 1], hi: i < 4 ? e[i] : Infinity }));
}

export function zoneOf(value: number, edges: number[]): number {
  let z = 0;
  while (z < edges.length && value >= edges[z]) z++;
  return z; // 0-based
}

/**
 * Seiler-style 3-zone split (low / moderate / high) as fractions of the relevant threshold:
 * low < LT1, high ≥ LT2 (= threshold). LT1 sits at the top of Friel Z2 for HR (≈ 90 % LTHR),
 * ≈ 88.5 % of threshold speed for pace and ≈ 76 % FTP for power.
 */
export const TRI = { hr: [0.9, 1.0], pace: [0.885, 1.0], pwr: [0.76, 1.0] } as const;

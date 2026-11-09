import type { ParsedActivity, RawPoint } from '../types';
import { numOf, sportFromText, textOf } from './gpx';

export function parseTCX(xml: string): ParsedActivity | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const act = doc.getElementsByTagNameNS('*', 'Activity')[0];
  const tps = Array.from(doc.getElementsByTagNameNS('*', 'Trackpoint'));
  if (tps.length < 2) return null;
  const points: RawPoint[] = [];
  for (const el of tps) {
    const time = textOf(el, 'Time');
    const t = time ? Date.parse(time) : NaN;
    if (!isFinite(t)) continue;
    const pos = el.getElementsByTagNameNS('*', 'Position')[0];
    const hrEl = el.getElementsByTagNameNS('*', 'HeartRateBpm')[0];
    points.push({
      t,
      lat: pos ? numOf(pos, 'LatitudeDegrees') : undefined,
      lon: pos ? numOf(pos, 'LongitudeDegrees') : undefined,
      alt: numOf(el, 'AltitudeMeters'),
      dist: numOf(el, 'DistanceMeters'),
      hr: hrEl ? numOf(hrEl, 'Value') : undefined,
      cad: numOf(el, 'Cadence') ?? numOf(el, 'RunCadence'),
      pwr: numOf(el, 'Watts'),
    });
  }
  if (points.length < 2) return null;
  const sport = sportFromText(act?.getAttribute('Sport'));
  const notes = act ? textOf(act, 'Notes') : undefined;
  const hasGps = points.some((p) => p.lat != null);
  return { sport, points, source: 'file', notes, trainer: !hasGps ? true : undefined };
}

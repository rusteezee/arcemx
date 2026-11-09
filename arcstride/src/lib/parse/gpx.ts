import type { ParsedActivity, RawPoint, Sport } from '../types';

export function sportFromText(t?: string | null): Sport | undefined {
  if (!t) return undefined;
  const s = t.toLowerCase();
  if (/(trail|run|jog)/.test(s)) return 'run';
  if (/(cycl|bik|ride|ebike|gravel|mtb)/.test(s)) return 'ride';
  if (/hik/.test(s)) return 'hike';
  if (/walk/.test(s)) return 'walk';
  return undefined;
}

/** First descendant text by local name (namespace-agnostic). */
export function textOf(el: Element, name: string): string | undefined {
  const found = el.getElementsByTagNameNS('*', name)[0];
  return found?.textContent?.trim() || undefined;
}
export function numOf(el: Element, name: string): number | undefined {
  const t = textOf(el, name);
  if (t == null) return undefined;
  const v = parseFloat(t);
  return isFinite(v) ? v : undefined;
}

export function parseGPX(xml: string): ParsedActivity | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const trk = doc.getElementsByTagNameNS('*', 'trk')[0];
  const pts = Array.from(doc.getElementsByTagNameNS('*', 'trkpt'));
  if (pts.length < 2) return null;
  const points: RawPoint[] = [];
  for (const el of pts) {
    const time = textOf(el, 'time');
    const t = time ? Date.parse(time) : NaN;
    if (!isFinite(t)) continue;
    const lat = parseFloat(el.getAttribute('lat') ?? '');
    const lon = parseFloat(el.getAttribute('lon') ?? '');
    points.push({
      t,
      lat: isFinite(lat) ? lat : undefined,
      lon: isFinite(lon) ? lon : undefined,
      alt: numOf(el, 'ele'),
      hr: numOf(el, 'hr') ?? numOf(el, 'heartrate'),
      cad: numOf(el, 'cad') ?? numOf(el, 'cadence') ?? numOf(el, 'runcadence'),
      pwr: numOf(el, 'power') ?? numOf(el, 'watts') ?? numOf(el, 'PowerInWatts'),
    });
  }
  if (points.length < 2) return null;
  const name = (trk && Array.from(trk.children).find((c) => c.localName === 'name')?.textContent?.trim()) || undefined;
  const type = trk && Array.from(trk.children).find((c) => c.localName === 'type')?.textContent?.trim();
  const desc = trk && Array.from(trk.children).find((c) => c.localName === 'desc')?.textContent?.trim();
  return { name, sport: sportFromText(type), points, source: 'file', notes: desc };
}

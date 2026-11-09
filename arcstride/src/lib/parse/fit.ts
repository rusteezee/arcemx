import type { ParsedActivity, RawPoint, Sport } from '../types';

const SEMI = 180 / 2147483648;
const toDeg = (v: number | undefined) => (v == null || !isFinite(v) ? undefined : Math.abs(v) > 180 ? v * SEMI : v);

function sportFromFit(sport?: string, sub?: string): Sport | undefined {
  const s = `${sport ?? ''} ${sub ?? ''}`.toLowerCase();
  if (/(running|trail|treadmill)/.test(s)) return 'run';
  if (/(cycling|biking|e_bike|ebike|mountain|gravel|road|spin|indoor_cycling)/.test(s)) return 'ride';
  if (/hiking/.test(s)) return 'hike';
  if (/walking/.test(s)) return 'walk';
  return undefined;
}

/** Decode a .fit file using Garmin's official SDK (loaded on demand). */
export async function parseFIT(buf: ArrayBuffer | Uint8Array): Promise<ParsedActivity | null> {
  const { Decoder, Stream } = await import('@garmin/fitsdk');
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const stream = Stream.fromBuffer(bytes);
  if (!Decoder.isFIT(stream)) return null;
  const decoder = new Decoder(stream);
  let result;
  try {
    result = decoder.read({ applyScaleAndOffset: true, convertTypesToStrings: true, convertDateTimesToDates: true, mergeHeartRates: true });
  } catch {
    return null;
  }
  const msgs = result.messages as unknown as Record<string, any[] | undefined>;
  const records = msgs.recordMesgs ?? [];
  const points: RawPoint[] = [];
  for (const r of records) {
    const ts: Date | number | undefined = r.timestamp;
    const t = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : NaN;
    if (!isFinite(t)) continue;
    points.push({
      t,
      lat: toDeg(r.positionLat),
      lon: toDeg(r.positionLong),
      alt: r.enhancedAltitude ?? r.altitude,
      hr: r.heartRate,
      cad: r.cadence,
      pwr: r.power,
      dist: r.distance,
    });
  }
  if (points.length < 2) return null;
  const session = (msgs.sessionMesgs ?? [])[0];
  const sport = sportFromFit(session?.sport, session?.subSport);
  const indoor = /(indoor|treadmill|virtual)/i.test(String(session?.subSport ?? ''));
  const hasGps = points.some((p) => p.lat != null);
  return { sport, points, source: 'file', trainer: indoor || !hasGps ? true : undefined };
}

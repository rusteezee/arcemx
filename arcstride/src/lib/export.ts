import { zipSync, strToU8 } from 'fflate';
import type { ActivitySummary, Loads, PrivacyZone, Streams } from './types';
import { fastDist } from './geo';
import { fmtTime } from './units';

/** True if (lat,lon) lies inside any privacy zone. */
export function inPrivacyZone(lat: number, lon: number, zones: PrivacyZone[]): boolean {
  for (const z of zones) if (fastDist(lat, lon, z.lat, z.lon) <= z.radius) return true;
  return false;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Standard GPX 1.1 with Garmin TrackPointExtension (hr, cad) and power. Privacy zones are applied if given. */
export function toGPX(a: ActivitySummary, s: Streams, zones: PrivacyZone[] = []): string {
  const pts: string[] = [];
  for (let i = 0; i < s.n; i++) {
    const hasPos = s.lat[i] === s.lat[i];
    if (hasPos && inPrivacyZone(s.lat[i], s.lon[i], zones)) continue;
    if (!hasPos && s.hasGps) continue;
    const t = new Date(a.start + i * 1000).toISOString();
    const ext: string[] = [];
    if (s.hr[i] === s.hr[i]) ext.push(`<gpxtpx:hr>${Math.round(s.hr[i])}</gpxtpx:hr>`);
    if (s.cad[i] === s.cad[i]) ext.push(`<gpxtpx:cad>${Math.round(s.cad[i])}</gpxtpx:cad>`);
    const power = s.pwr[i] === s.pwr[i] ? `<power>${Math.round(s.pwr[i])}</power>` : '';
    const ele = s.alt[i] === s.alt[i] ? `<ele>${s.alt[i].toFixed(1)}</ele>` : '';
    pts.push(`<trkpt lat="${s.lat[i].toFixed(6)}" lon="${s.lon[i].toFixed(6)}">${ele}<time>${t}</time><extensions>${power}${ext.length ? `<gpxtpx:TrackPointExtension>${ext.join('')}</gpxtpx:TrackPointExtension>` : ''}</extensions></trkpt>`);
  }
  const type = { run: 'running', ride: 'cycling', walk: 'walking', hike: 'hiking', other: 'other' }[a.sport];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ArcStride" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><metadata><time>${new Date(a.start).toISOString()}</time></metadata><trk><name>${esc(a.name)}</name><type>${type}</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

export function toCSV(acts: ActivitySummary[], loads: Map<string, Loads>): string {
  const head = ['id', 'date', 'name', 'sport', 'distance_km', 'moving_time', 'elapsed_time', 'elev_gain_m', 'avg_speed_kmh', 'avg_hr', 'max_hr', 'avg_power', 'np', 'load', 'load_method', 'intensity_factor', 'efficiency_factor', 'decoupling_pct', 'source'];
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = acts.map((a) => {
    const l = loads.get(a.id);
    return [a.id, new Date(a.start + a.tz * 60000).toISOString().slice(0, 16).replace('T', ' '), a.name, a.sport, (a.distance / 1000).toFixed(3), fmtTime(a.moving), fmtTime(a.elapsed), Math.round(a.elevGain), (a.avgSpeed * 3.6).toFixed(2), a.avgHR?.toFixed(0), a.maxHR?.toFixed(0), a.avgPower?.toFixed(0), a.np?.toFixed(0), l?.load.toFixed(1), l?.method, l?.ifactor?.toFixed(3), a.ef?.toFixed(3), a.decoupling?.toFixed(2), a.source].map(q).join(',');
  });
  return [head.join(','), ...rows].join('\n');
}

/** Extensions the hosted-sandbox `downloads` capability accepts (gpx is not one of them). */
const SANDBOX_OK = /\.(gif|png|jpg|jpeg|webp|mp4|webm|mov|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip|fig)$/i;

interface DownloadsCap {
  save: (r: { filename: string; data: string | Blob }) => Promise<unknown>;
}

/**
 * Save a file. When the page runs inside a hosted sandbox that exposes `window.claude`, downloads must go
 * through the platform's `downloads` capability (the sandbox blocks anchor downloads). Everywhere else —
 * local dev, the standalone build — a normal anchor download is used.
 */
export async function download(name: string, data: Blob | string, type = 'application/octet-stream'): Promise<void> {
  const claude = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (claude?.use) {
    try {
      const cap = (await claude.use('downloads')) as DownloadsCap | null;
      if (cap) {
        const filename = SANDBOX_OK.test(name) ? name : `${name}.txt`;
        await cap.save({ filename, data });
        return;
      }
    } catch (e) {
      if ((e as { code?: string })?.code === 'declined') return;
      // any other failure: fall through to the anchor download
    }
  }
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = name;
  document.body.appendChild(el);
  el.click();
  el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function zipFiles(files: Record<string, string>): Uint8Array {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = strToU8(v);
  return zipSync(out, { level: 6 });
}

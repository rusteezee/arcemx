import { gunzipSync, unzipSync, strFromU8 } from 'fflate';
import type { ParsedActivity, Sport } from '../types';
import { parseGPX, sportFromText } from './gpx';
import { parseTCX } from './tcx';
import { parseFIT } from './fit';

export interface InputEntry {
  name: string; // full path inside archive or file name
  data: Uint8Array;
}

/** Strava `activities.csv` metadata keyed by the activity file's path. */
export interface CsvMeta {
  name?: string;
  sport?: Sport;
  notes?: string;
  gear?: string;
  commute?: boolean;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function stravaSport(t?: string): Sport | undefined {
  if (!t) return undefined;
  const s = t.toLowerCase();
  if (s.includes('run')) return 'run';
  if (s.includes('ride') || s.includes('bike') || s.includes('cycl')) return 'ride';
  if (s.includes('hike')) return 'hike';
  if (s.includes('walk')) return 'walk';
  return sportFromText(t) ?? 'other';
}

export function parseStravaCsv(text: string): Map<string, CsvMeta> {
  const rows = parseCSV(text);
  const out = new Map<string, CsvMeta>();
  if (rows.length < 2) return out;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const iFile = col('filename'),
    iName = col('activity name'),
    iType = col('activity type'),
    iDesc = col('activity description'),
    iGear = col('activity gear'),
    iNote = col('activity private note'),
    iComm = col('commute');
  if (iFile < 0) return out;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const file = row[iFile]?.trim();
    if (!file) continue;
    out.set(file, {
      name: iName >= 0 ? row[iName]?.trim() || undefined : undefined,
      sport: iType >= 0 ? stravaSport(row[iType]) : undefined,
      notes: [iDesc >= 0 ? row[iDesc] : '', iNote >= 0 ? row[iNote] : ''].filter(Boolean).join('\n') || undefined,
      gear: iGear >= 0 ? row[iGear]?.trim() || undefined : undefined,
      commute: iComm >= 0 ? /true|yes|1/i.test(row[iComm] ?? '') : undefined,
    });
  }
  return out;
}

const WANTED = /\.(gpx|tcx|fit)(\.gz)?$/i;

async function readFile(f: File): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === 'function') return new Uint8Array(await f.arrayBuffer());
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(f);
  });
}

/** Expand dropped files (zip archives are unpacked; `.gz` is handled at parse time). */
export async function readInputs(files: File[]): Promise<{ entries: InputEntry[]; csv: Map<string, CsvMeta> }> {
  const entries: InputEntry[] = [];
  let csv = new Map<string, CsvMeta>();
  for (const f of files) {
    const lower = f.name.toLowerCase();
    const buf = await readFile(f);
    if (lower.endsWith('.zip')) {
      const unz = unzipSync(buf, { filter: (e) => WANTED.test(e.name) || /(^|\/)activities\.csv$/i.test(e.name) });
      for (const [path, data] of Object.entries(unz)) {
        if (/activities\.csv$/i.test(path)) csv = parseStravaCsv(strFromU8(data));
        else if (WANTED.test(path)) entries.push({ name: path, data });
      }
    } else if (lower.endsWith('.csv')) {
      csv = parseStravaCsv(new TextDecoder().decode(buf));
    } else if (WANTED.test(lower)) {
      entries.push({ name: f.name, data: buf });
    }
  }
  return { entries, csv };
}

/** Parse one entry into a ParsedActivity (gunzips if needed). */
export async function parseEntry(e: InputEntry): Promise<ParsedActivity | null> {
  let name = e.name.toLowerCase();
  let data = e.data;
  if (name.endsWith('.gz')) {
    try {
      data = gunzipSync(data);
    } catch {
      return null;
    }
    name = name.slice(0, -3);
  }
  try {
    if (name.endsWith('.gpx')) return parseGPX(new TextDecoder().decode(data));
    if (name.endsWith('.tcx')) return parseTCX(new TextDecoder().decode(data));
    if (name.endsWith('.fit')) return await parseFIT(data);
  } catch {
    return null;
  }
  return null;
}

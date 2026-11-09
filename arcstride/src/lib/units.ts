import type { Sport, Units } from './types';

export const KM = 1000;
export const MI = 1609.344;
export const FT = 0.3048;

export const isPaceSport = (s: Sport) => s === 'run' || s === 'walk' || s === 'hike';

const pad = (n: number) => String(n).padStart(2, '0');

/** 3723 → "1:02:03" · 723 → "12:03" */
export function fmtTime(sec: number | undefined, showSub = false): string {
  if (sec == null || !isFinite(sec)) return '—';
  const s = Math.max(0, sec);
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const base = h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  if (showSub && s < 600) return `${base}.${Math.floor((s % 1) * 10)}`;
  return base;
}

/** 3723 → "1h 02m" · 723 → "12m" */
export function fmtDur(sec: number | undefined): string {
  if (sec == null || !isFinite(sec)) return '—';
  const total = Math.round(sec / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}

export function distUnit(u: Units) {
  return u === 'metric' ? 'km' : 'mi';
}
export function elevUnit(u: Units) {
  return u === 'metric' ? 'm' : 'ft';
}

export function toDist(m: number, u: Units) {
  return u === 'metric' ? m / KM : m / MI;
}
export function fromDist(v: number, u: Units) {
  return u === 'metric' ? v * KM : v * MI;
}
export function toElev(m: number, u: Units) {
  return u === 'metric' ? m : m / FT;
}

export function fmtDist(m: number | undefined, u: Units, digits = 2): string {
  if (m == null || !isFinite(m)) return '—';
  return toDist(m, u).toFixed(digits);
}
export function fmtDistU(m: number | undefined, u: Units, digits = 2): string {
  if (m == null || !isFinite(m)) return '—';
  return `${toDist(m, u).toFixed(digits)} ${distUnit(u)}`;
}
export function fmtElev(m: number | undefined, u: Units): string {
  if (m == null || !isFinite(m)) return '—';
  return `${Math.round(toElev(m, u)).toLocaleString()} ${elevUnit(u)}`;
}

/** m/s → "5:12" per km/mi */
export function fmtPace(v: number | undefined, u: Units): string {
  if (v == null || !isFinite(v) || v < 0.2) return '—';
  const secPer = (u === 'metric' ? KM : MI) / v;
  if (secPer > 3600) return '—';
  const m = Math.floor(secPer / 60);
  let s = Math.round(secPer % 60);
  let mm = m;
  if (s === 60) {
    s = 0;
    mm += 1;
  }
  return `${mm}:${pad(s)}`;
}
export function paceUnit(u: Units) {
  return u === 'metric' ? '/km' : '/mi';
}
export function fmtSpeed(v: number | undefined, u: Units): string {
  if (v == null || !isFinite(v)) return '—';
  const k = (v * 3600) / (u === 'metric' ? KM : MI);
  return k.toFixed(1);
}
export function speedUnit(u: Units) {
  return u === 'metric' ? 'km/h' : 'mph';
}

/** Sport-aware speed/pace (value, unit). */
export function fmtSpeedFor(sport: Sport, v: number | undefined, u: Units): { value: string; unit: string } {
  return isPaceSport(sport)
    ? { value: fmtPace(v, u), unit: paceUnit(u) }
    : { value: fmtSpeed(v, u), unit: speedUnit(u) };
}

export function paceToSpeed(minPerUnit: number, secPerUnit: number, u: Units) {
  const sec = minPerUnit * 60 + secPerUnit;
  return (u === 'metric' ? KM : MI) / sec;
}

export function fmtSigned(v: number, digits = 0): string {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export function dayKeyOf(startMs: number, tzMin: number): string {
  return new Date(startMs + tzMin * 60000).toISOString().slice(0, 10);
}
export function dayNumOf(startMs: number, tzMin: number): number {
  return Math.floor((startMs + tzMin * 60000) / 86400000);
}
export function dayNumToKey(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
export function keyToDayNum(key: string): number {
  return Math.floor(Date.parse(key + 'T00:00:00Z') / 86400000);
}
/** Day of week 0=Sun for a day number. */
export function dowOfDayNum(n: number): number {
  return (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)
}

export function fmtDate(ms: number, tz: number, opts?: { weekday?: boolean; year?: boolean }): string {
  const d = new Date(ms + tz * 60000);
  return d.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: opts?.weekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: opts?.year === false ? undefined : 'numeric',
  });
}
export function fmtClock(ms: number, tz: number): string {
  const d = new Date(ms + tz * 60000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function fmtDayKey(key: string, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(key + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...opts });
}

export function sportLabel(s: Sport): string {
  return { run: 'Run', ride: 'Ride', walk: 'Walk', hike: 'Hike', other: 'Workout' }[s];
}
export const SPORT_GLYPH: Record<Sport, string> = { run: '◈', ride: '⬡', walk: '◯', hike: '▲', other: '✦' };

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "1:32:10" | "32:10" | "95" → seconds */
export function parseHMS(s: string): number | undefined {
  const p = s.trim().split(':').map(Number);
  if (!p.length || p.some((x) => !isFinite(x) || x < 0)) return undefined;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
}

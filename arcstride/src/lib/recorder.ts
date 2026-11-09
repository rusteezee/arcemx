import { useSyncExternalStore } from 'react';
import type { ParsedActivity, RawPoint, Sport } from './types';
import { fastDist } from './geo';
import { analyze } from './analyze/process';
import { db } from './store/db';
import { addAnalysis, getState, toast } from './store/store';

export type RecStatus = 'idle' | 'recording' | 'paused' | 'review';

export interface RecState {
  status: RecStatus;
  sport: Sport;
  n: number; // points accepted (re-render trigger)
  elapsed: number; // timer seconds (excludes pauses)
  distance: number; // m, live estimate
  accuracy?: number;
  autoPaused: boolean;
  speed: number; // m/s over the last ~12 fixes
  error?: string;
  hasDraft: boolean;
}

let st: RecState = { status: 'idle', sport: 'run', n: 0, elapsed: 0, distance: 0, autoPaused: false, speed: 0, hasDraft: false };
let points: RawPoint[] = [];
let watchId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let draftTimer: ReturnType<typeof setInterval> | null = null;
let wake: { release: () => Promise<void> } | null = null;
const listeners = new Set<() => void>();
const emit = (p: Partial<RecState>) => {
  st = { ...st, ...p };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useRecorder<T>(sel: (s: RecState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(st), () => sel(st));
}
export const getPoints = () => points;

const DRAFT = 'recording-draft';
async function saveDraft() {
  if (points.length < 3) return;
  await db.put('kv', DRAFT, { sport: st.sport, points, elapsed: st.elapsed, distance: st.distance, savedAt: Date.now() });
}

export async function checkDraft() {
  const d = await db.get<{ points: RawPoint[] }>('kv', DRAFT);
  emit({ hasDraft: !!d && d.points.length >= 5 && st.status === 'idle' });
}
export async function restoreDraft() {
  const d = await db.get<{ sport: Sport; points: RawPoint[]; elapsed: number; distance: number }>('kv', DRAFT);
  if (!d) return;
  points = d.points;
  emit({ status: 'review', sport: d.sport, n: points.length, elapsed: d.elapsed, distance: d.distance, hasDraft: false });
}

function stopSensors() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (timer) clearInterval(timer);
  if (draftTimer) clearInterval(draftTimer);
  timer = draftTimer = null;
  void wake?.release().catch(() => undefined);
  wake = null;
}

function onPos(pos: GeolocationPosition) {
  if (st.status !== 'recording') return;
  const { latitude: lat, longitude: lon, altitude, accuracy } = pos.coords;
  emit({ accuracy, error: undefined });
  if (accuracy > 60) return; // too poor to trust
  const last = points[points.length - 1];
  const t = pos.timestamp;
  if (last && t - last.t < 500) return;
  let dist = st.distance;
  let autoPaused = st.autoPaused;
  if (last) {
    const d = fastDist(last.lat!, last.lon!, lat, lon);
    const dt = (t - last.t) / 1000;
    const v = d / Math.max(0.5, dt);
    const moving = v > 0.6 && d > 1.2;
    autoPaused = !moving && dt >= 1 ? recentStationary() : false;
    if (!moving) {
      // stationary jitter: don't extend the track, but remember we're still alive
      if (!autoPaused) return;
      return emit({ autoPaused: true });
    }
    dist += d;
  }
  points.push({ t, lat, lon, alt: altitude ?? undefined });
  // live speed from last ~12 fixes
  const k = Math.max(0, points.length - 12);
  let dd = 0;
  for (let i = k + 1; i < points.length; i++) dd += fastDist(points[i - 1].lat!, points[i - 1].lon!, points[i].lat!, points[i].lon!);
  const span = (points[points.length - 1].t - points[k].t) / 1000;
  emit({ n: points.length, distance: dist, autoPaused: false, speed: span > 0 ? dd / span : 0 });
  void autoPaused;
}

let stationarySince = 0;
function recentStationary(): boolean {
  const now = Date.now();
  if (!stationarySince) stationarySince = now;
  const paused = now - stationarySince > 8000;
  return paused;
}

export async function startRecording(sport: Sport) {
  if (!('geolocation' in navigator)) return emit({ error: 'This browser has no geolocation support.' });
  points = [];
  stationarySince = 0;
  emit({ status: 'recording', sport, n: 0, elapsed: 0, distance: 0, autoPaused: false, speed: 0, error: undefined, accuracy: undefined, hasDraft: false });
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      stationarySince = 0;
      onPos(p);
    },
    (e) => {
      emit({ error: e.code === 1 ? 'Location permission denied. Allow location for this site and try again. (Hosted previews inside a sandbox block GPS — run ArcStride locally or from your own HTTPS host to record.)' : e.code === 2 ? 'Position unavailable — check GPS signal.' : 'Timed out waiting for a GPS fix.' });
      if (e.code === 1) stopSensors();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  timer = setInterval(() => {
    if (st.status === 'recording' && !st.autoPaused) emit({ elapsed: st.elapsed + 1 });
  }, 1000);
  draftTimer = setInterval(() => void saveDraft(), 15000);
  try {
    wake = await (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null;
  } catch {
    wake = null; // not available or denied — recording still works
  }
}

export function pauseRecording() {
  if (st.status === 'recording') emit({ status: 'paused' });
}
export function resumeRecording() {
  if (st.status === 'paused') emit({ status: 'recording' });
}
export async function finishRecording() {
  stopSensors();
  await saveDraft();
  emit({ status: 'review' });
}
export async function discardRecording() {
  stopSensors();
  points = [];
  await db.del('kv', DRAFT);
  emit({ status: 'idle', n: 0, elapsed: 0, distance: 0, autoPaused: false, speed: 0, hasDraft: false });
}

/** Analyse and store the recording. Returns the new activity id (or undefined if too short). */
export async function saveRecording(name: string): Promise<string | undefined> {
  const parsed: ParsedActivity = { points: points.map((p) => ({ ...p })), sport: st.sport, source: 'recorded', name: name.trim() || undefined };
  const a = analyze(parsed, getState().profile);
  if (!a || a.summary.distance < 30) {
    toast('That recording is too short to save (under 30 m).', 'warn');
    return undefined;
  }
  await addAnalysis(a);
  await db.del('kv', DRAFT);
  points = [];
  emit({ status: 'idle', n: 0, elapsed: 0, distance: 0, hasDraft: false });
  toast('Activity saved to your library.');
  return a.summary.id;
}

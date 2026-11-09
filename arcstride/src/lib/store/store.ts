import { useSyncExternalStore } from 'react';
import type { ActivitySummary, CheckIn, Gear, Goal, Plan, PrivacyZone, Profile, Segment, Streams, Track } from '../types';
import { DEFAULT_PROFILE } from '../profile';
import { analyze, reanalyze, type Analysis } from '../analyze/process';
import { parseEntry, readInputs } from '../parse/archive';
import { DEMO_GEAR, DEMO_GEAR_NAMES, DEMO_GOALS, DEMO_PROFILE, DEMO_TZ, demoCheckIns, generateDemo } from '../demo/generate';
import { db } from './db';

export interface Busy {
  label: string;
  done: number;
  total: number;
}
export interface Toast {
  id: number;
  msg: string;
  kind: 'ok' | 'warn' | 'err';
}
export interface Prefs {
  dismissedSegments: string[];
  welcomed?: boolean;
}

export interface State {
  ready: boolean;
  activities: ActivitySummary[]; // newest first
  tracks: Map<string, Track>;
  profile: Profile;
  goals: Goal[];
  gear: Gear[];
  segments: Segment[];
  plan: Plan | null;
  checkins: CheckIn[];
  privacy: PrivacyZone[];
  prefs: Prefs;
  busy: Busy | null;
  toasts: Toast[];
  /** bumps when downhill-credit etc. changed since the last full recompute */
  staleModel: boolean;
}

let state: State = {
  ready: false,
  activities: [],
  tracks: new Map(),
  profile: DEFAULT_PROFILE,
  goals: [],
  gear: [],
  segments: [],
  plan: null,
  checkins: [],
  privacy: [],
  prefs: { dismissedSegments: [] },
  busy: null,
  toasts: [],
  staleModel: false,
};
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getState = () => state;
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sortActs = (a: ActivitySummary[]) => [...a].sort((x, y) => y.start - x.start);
const kv = <T,>(key: string) => db.get<T>('kv', key);
const save = (key: string, v: unknown) => db.put('kv', key, v);

let toastSeq = 1;
export function toast(msg: string, kind: Toast['kind'] = 'ok') {
  const id = toastSeq++;
  set({ toasts: [...state.toasts, { id, msg, kind }] });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), kind === 'err' ? 7000 : 4200);
}

// ── init ──────────────────────────────────────────────────────────────────
export async function init() {
  const [profile, goals, gear, segments, plan, checkins, privacy, prefs] = await Promise.all([
    kv<Profile>('profile'),
    kv<Goal[]>('goals'),
    kv<Gear[]>('gear'),
    kv<Segment[]>('segments'),
    kv<Plan | null>('plan'),
    kv<CheckIn[]>('checkins'),
    kv<PrivacyZone[]>('privacy'),
    kv<Prefs>('prefs'),
  ]);
  const acts = await db.all<ActivitySummary>('activities');
  const trs = await db.all<Track>('tracks');
  set({
    ready: true,
    profile: { ...DEFAULT_PROFILE, ...(profile ?? {}) },
    goals: goals ?? [],
    gear: gear ?? [],
    segments: segments ?? [],
    plan: plan ?? null,
    checkins: checkins ?? [],
    privacy: privacy ?? [],
    prefs: { dismissedSegments: [], ...(prefs ?? {}) },
    activities: sortActs(acts.map((a) => a.value)),
    tracks: new Map(trs.map((t) => [t.key, t.value])),
  });
}

// ── activities ────────────────────────────────────────────────────────────
function ensureGear(name: string | undefined, sport: ActivitySummary['sport'], gear: Gear[]): { id?: string; gear: Gear[] } {
  if (!name) return { gear };
  const found = DEMO_GEAR_NAMES[name] ?? gear.find((g) => g.name === name)?.id;
  if (found && gear.some((g) => g.id === found)) return { id: found, gear };
  const id = found ?? `g_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}_${gear.length}`;
  const g: Gear = { id, name, kind: sport === 'ride' ? 'bike' : 'shoes', retireAtKm: sport === 'ride' ? 20000 : 800, startKm: 0 };
  return { id, gear: [...gear, g] };
}

async function persistAnalysis(a: Analysis) {
  await db.put('activities', a.summary.id, a.summary);
  if (a.track) await db.put('tracks', a.summary.id, a.track);
  await db.put('streams', a.summary.id, a.streams);
}

export async function importFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  set({ busy: { label: 'Reading files…', done: 0, total: 0 } });
  try {
    const { entries, csv } = await readInputs(files);
    if (!entries.length) {
      toast('No .gpx, .tcx, .fit or Strava export (.zip) files found in that selection.', 'warn');
      return;
    }
    const existing = new Set(state.activities.map((a) => a.id));
    let ok = 0,
      dup = 0,
      fail = 0;
    let acts = [...state.activities];
    const tracks = new Map(state.tracks);
    let gear = state.gear;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      set({ busy: { label: `Analysing ${i + 1} of ${entries.length}`, done: i, total: entries.length } });
      const parsed = await parseEntry(e);
      if (!parsed) {
        fail++;
        continue;
      }
      const meta = csv.get(e.name) ?? csv.get(e.name.replace(/^.*[\\/]/, '')) ?? csv.get('activities/' + e.name.replace(/^.*[\\/]/, ''));
      if (meta) {
        parsed.source = 'strava-archive';
        if (meta.name) parsed.name = meta.name;
        if (meta.sport) parsed.sport = meta.sport;
        if (meta.notes) parsed.notes = meta.notes;
      }
      const a = analyze(parsed, state.profile);
      if (!a) {
        fail++;
        continue;
      }
      if (existing.has(a.summary.id)) {
        dup++;
        continue;
      }
      const g = ensureGear(meta?.gear, a.summary.sport, gear);
      gear = g.gear;
      if (g.id) a.summary.gearId = g.id;
      await persistAnalysis(a);
      existing.add(a.summary.id);
      acts.push(a.summary);
      if (a.track) tracks.set(a.summary.id, a.track);
      ok++;
      if (i % 4 === 3) await tick();
    }
    acts = sortActs(acts);
    set({ activities: acts, tracks, gear });
    await save('gear', gear);
    const parts = [`${ok} imported`];
    if (dup) parts.push(`${dup} already in your library`);
    if (fail) parts.push(`${fail} couldn't be read`);
    toast(parts.join(' · '), ok ? 'ok' : 'warn');
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`, 'err');
  } finally {
    set({ busy: null });
  }
}

/** Add a freshly recorded (or otherwise built) analysis. */
export async function addAnalysis(a: Analysis): Promise<boolean> {
  if (state.activities.some((x) => x.id === a.summary.id)) return false;
  await persistAnalysis(a);
  const tracks = new Map(state.tracks);
  if (a.track) tracks.set(a.summary.id, a.track);
  set({ activities: sortActs([...state.activities, a.summary]), tracks });
  return true;
}

/** Replace an existing activity with a re-derived analysis (e.g. after changing its sport). */
export async function replaceAnalysis(a: Analysis) {
  await db.put('activities', a.summary.id, a.summary);
  if (a.track) await db.put('tracks', a.summary.id, a.track);
  const tracks = new Map(state.tracks);
  if (a.track) tracks.set(a.summary.id, a.track);
  set({ activities: sortActs(state.activities.map((x) => (x.id === a.summary.id ? a.summary : x))), tracks });
}

export async function loadDemo(): Promise<void> {
  const hadReal = state.activities.some((a) => a.source !== 'demo');
  set({ busy: { label: 'Building demo athlete…', done: 0, total: 0 } });
  try {
    const now = Date.now();
    const profile = hadReal ? state.profile : DEMO_PROFILE;
    const acts = [...state.activities];
    const tracks = new Map(state.tracks);
    const have = new Set(acts.map((a) => a.id));
    let n = 0;
    let gear = hadReal ? state.gear : DEMO_GEAR;
    for (const g of generateDemo({ now })) {
      const a = analyze(g, profile, { tz: DEMO_TZ });
      if (!a || have.has(a.summary.id)) continue;
      const ge = ensureGear(g.gearName, a.summary.sport, gear);
      gear = ge.gear;
      if (ge.id) a.summary.gearId = ge.id;
      await persistAnalysis(a);
      acts.push(a.summary);
      if (a.track) tracks.set(a.summary.id, a.track);
      have.add(a.summary.id);
      n++;
      if (n % 6 === 0) {
        set({ busy: { label: `Building demo athlete… ${n} activities`, done: n, total: 0 } });
        await tick();
      }
    }
    const patch: Partial<State> = { activities: sortActs(acts), tracks, gear };
    if (!hadReal) {
      patch.profile = DEMO_PROFILE;
      patch.goals = DEMO_GOALS;
      patch.checkins = demoCheckIns(now);
      await Promise.all([save('profile', DEMO_PROFILE), save('goals', DEMO_GOALS), save('checkins', patch.checkins)]);
    }
    await save('gear', gear);
    set(patch);
    toast(`Demo athlete loaded — ${n} synthetic activities. Remove them any time in Settings.`);
  } finally {
    set({ busy: null });
  }
}

export async function removeDemo(): Promise<void> {
  const demo = state.activities.filter((a) => a.source === 'demo');
  for (const a of demo) {
    await db.del('activities', a.id);
    await db.del('tracks', a.id);
    await db.del('streams', a.id);
  }
  const keep = state.activities.filter((a) => a.source !== 'demo');
  const tracks = new Map(state.tracks);
  demo.forEach((a) => tracks.delete(a.id));
  set({ activities: keep, tracks, segments: [], plan: null });
  await Promise.all([save('segments', []), save('plan', null)]);
  toast(`Removed ${demo.length} demo activities.`);
}

export async function deleteActivity(id: string) {
  await db.del('activities', id);
  await db.del('tracks', id);
  await db.del('streams', id);
  const tracks = new Map(state.tracks);
  tracks.delete(id);
  set({ activities: state.activities.filter((a) => a.id !== id), tracks });
  toast('Activity deleted.');
}

export async function updateActivity(id: string, patch: Partial<ActivitySummary>) {
  const cur = state.activities.find((a) => a.id === id);
  if (!cur) return;
  const next = { ...cur, ...patch, edited: true };
  await db.put('activities', id, next);
  set({ activities: state.activities.map((a) => (a.id === id ? next : a)) });
}

const streamCache = new Map<string, Streams>();
export async function getStreams(id: string): Promise<Streams | undefined> {
  const hit = streamCache.get(id);
  if (hit) return hit;
  const s = await db.get<Streams>('streams', id);
  if (s) {
    streamCache.set(id, s);
    if (streamCache.size > 6) streamCache.delete(streamCache.keys().next().value!);
  }
  return s;
}

/** Re-derive every activity from its stored streams (after changing profile-baked settings such as the GAP model). */
export async function recomputeAll() {
  const acts = state.activities;
  set({ busy: { label: 'Recomputing history…', done: 0, total: acts.length } });
  try {
    const next: ActivitySummary[] = [];
    const tracks = new Map(state.tracks);
    for (let i = 0; i < acts.length; i++) {
      const s = await db.get<Streams>('streams', acts[i].id);
      if (!s) {
        next.push(acts[i]);
        continue;
      }
      const a = reanalyze(acts[i], s, state.profile);
      await db.put('activities', a.summary.id, a.summary);
      if (a.track) {
        await db.put('tracks', a.summary.id, a.track);
        tracks.set(a.summary.id, a.track);
      }
      next.push(a.summary);
      if (i % 10 === 9) {
        set({ busy: { label: 'Recomputing history…', done: i + 1, total: acts.length } });
        await tick();
      }
    }
    set({ activities: sortActs(next), tracks, staleModel: false });
    toast('History recomputed with your current model settings.');
  } finally {
    set({ busy: null });
  }
}

// ── small slices ──────────────────────────────────────────────────────────
export function setProfile(patch: Partial<Profile>) {
  const profile = { ...state.profile, ...patch };
  const stale = state.staleModel || (patch.gapDownhillCredit != null && patch.gapDownhillCredit !== state.profile.gapDownhillCredit);
  set({ profile, staleModel: stale });
  void save('profile', profile);
}
export function setGoals(goals: Goal[]) {
  set({ goals });
  void save('goals', goals);
}
export function setGear(gear: Gear[]) {
  set({ gear });
  void save('gear', gear);
}
export function setSegments(segments: Segment[]) {
  set({ segments });
  void save('segments', segments);
}
export function setPlan(plan: Plan | null) {
  set({ plan });
  void save('plan', plan);
}
export function upsertCheckIn(c: CheckIn) {
  const checkins = [...state.checkins.filter((x) => x.date !== c.date), c].sort((a, b) => (a.date < b.date ? -1 : 1));
  set({ checkins });
  void save('checkins', checkins);
}
export function setPrivacy(privacy: PrivacyZone[]) {
  set({ privacy });
  void save('privacy', privacy);
}
export function setPrefs(patch: Partial<Prefs>) {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  void save('prefs', prefs);
}

export async function resetAll() {
  await Promise.all((['kv', 'activities', 'tracks', 'streams'] as const).map((s) => db.clear(s)));
  streamCache.clear();
  set({ activities: [], tracks: new Map(), profile: DEFAULT_PROFILE, goals: [], gear: [], segments: [], plan: null, checkins: [], privacy: [], prefs: { dismissedSegments: [] }, staleModel: false });
  toast('All local data deleted.');
}

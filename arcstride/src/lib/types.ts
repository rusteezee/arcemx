// ───────────────────────────────────────────────────────────────────────────
// ArcStride data model
// Profile-INDEPENDENT facts live in ActivitySummary (computed once on import).
// Profile-DEPENDENT numbers (load, zone time) are derived at runtime from the
// histograms stored on the summary, so changing your thresholds recomputes
// your whole history instantly, with no re-import.
// ───────────────────────────────────────────────────────────────────────────

export type Sport = 'run' | 'ride' | 'walk' | 'hike' | 'other';
export type Source = 'file' | 'recorded' | 'demo' | 'strava-archive';
export type Units = 'metric' | 'imperial';

/** One GPS/sensor sample as read from a file (irregular timing). */
export interface RawPoint {
  t: number; // epoch ms
  lat?: number;
  lon?: number;
  alt?: number;
  hr?: number;
  cad?: number;
  pwr?: number;
  dist?: number; // cumulative metres as reported by the device
}

export interface ParsedActivity {
  name?: string;
  sport?: Sport;
  points: RawPoint[];
  source: Source;
  notes?: string;
  gearName?: string;
  trainer?: boolean;
}

/** 1 Hz timer-time streams. Index i = i seconds of *timer* time. */
export interface Streams {
  n: number;
  lat: Float64Array; // NaN when no GPS
  lon: Float64Array;
  alt: Float32Array; // NaN when missing
  hr: Float32Array; // NaN when missing
  cad: Float32Array;
  pwr: Float32Array;
  d: Float32Array; // cumulative distance, metres
  hasGps: boolean;
}

/** Streams derived from Streams + sport + profile. Not persisted. */
export interface Derived {
  v: Float32Array; // smoothed speed m/s
  altS: Float32Array; // smoothed altitude
  grade: Float32Array; // fraction (0.05 = 5 %)
  gapv: Float32Array; // grade-adjusted speed m/s
  moving: Uint8Array;
}

/** Distance-thinned track (≈15 m spacing) used for maps, matching, segments. */
export interface Track {
  n: number;
  lat: Float64Array;
  lon: Float64Array;
  t: Float32Array; // timer seconds
  d: Float32Array; // metres
  alt: Float32Array;
  hr: Float32Array;
  pwr: Float32Array;
}

export type Bests = Record<string, [time: number, startSec: number]>;

export interface ActivitySummary {
  id: string;
  name: string;
  sport: Sport;
  source: Source;
  start: number; // epoch ms
  tz: number; // minutes east of UTC at the time of the activity
  elapsed: number; // wall-clock seconds start→end
  timer: number; // seconds of recorded timer time (n)
  moving: number; // seconds actually moving
  distance: number; // m
  elevGain: number;
  elevLoss: number;
  minAlt?: number;
  maxAlt?: number;
  avgSpeed: number; // m/s over moving time
  maxSpeed: number;
  avgHR?: number;
  maxHR?: number;
  avgCad?: number;
  avgPower?: number;
  maxPower?: number;
  np?: number; // normalised power
  ngs?: number; // normalised graded speed m/s (flat-equivalent)
  vi?: number; // variability index
  ef?: number; // efficiency factor
  decoupling?: number; // % aerobic decoupling (first vs second half)
  hrHist?: number[]; // seconds at each bpm (0‥249)
  pwrHist?: number[]; // seconds per 10 W bin (0‥1499 W)
  gapHist?: number[]; // seconds (moving) per 0.1 m/s bin of grade-adjusted speed (0‥11.9)
  bests?: Bests; // best efforts by distance (m) → [seconds, startSec]
  mmp?: number[]; // mean-max power at MMP_DURATIONS
  mmhr?: number[]; // mean-max HR at MMHR_DURATIONS
  bbox?: [number, number, number, number]; // minLat,minLon,maxLat,maxLon
  poly?: number[]; // flat [lat,lon,…] ≤150 points for thumbnails
  hasGps: boolean;
  hasHR: boolean;
  hasPower: boolean;
  hasElev: boolean;
  gearId?: string;
  notes?: string;
  trainer?: boolean;
  /** Set when a user has manually chosen a sport/name so re-imports don't override. */
  edited?: boolean;
}

export type LoadMethod = 'power' | 'hr' | 'pace' | 'time';

export interface Loads {
  load: number; // TSS-equivalent used for PMC
  method: LoadMethod;
  tss?: number;
  hrTss?: number;
  rTss?: number;
  trimp?: number;
  ifactor?: number;
  hrZoneSecs?: number[]; // 5 zones
  pwrZoneSecs?: number[]; // 7 zones
  paceZoneSecs?: number[]; // 5 zones
  /** Seiler 3-zone split (low / moderate / high) in seconds, source depends on method */
  tri: [number, number, number];
}

export type HrZoneModel = 'lthr' | 'hrr' | 'maxhr';
export type RunLoadSource = 'auto' | 'hr' | 'pace';

export interface Profile {
  name: string;
  units: Units;
  weightKg: number;
  sex: 'm' | 'f';
  maxHR: number;
  restHR: number;
  lthr: number;
  ftp: number;
  thresholdSpeed: number; // m/s flat-equivalent run threshold (≈ critical speed)
  hrZoneModel: HrZoneModel;
  runLoadSource: RunLoadSource;
  gapDownhillCredit: number; // 0‥1, share of Minetti's downhill benefit applied
  mapTiles: 'off' | 'carto';
  weekStart: 0 | 1; // 0 = Sunday, 1 = Monday
}

export interface PrivacyZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number; // metres
}

export interface Gear {
  id: string;
  name: string;
  kind: 'shoes' | 'bike' | 'other';
  retireAtKm: number;
  startKm: number; // km already on it before ArcStride
  retired?: boolean;
}

export type GoalMetric = 'distance' | 'time' | 'elevation' | 'count';
export type GoalPeriod = 'week' | 'month' | 'year';

export interface Goal {
  id: string;
  metric: GoalMetric;
  period: GoalPeriod;
  target: number; // metres | seconds | metres | count
  sport: Sport | 'all';
}

export interface CheckIn {
  date: string; // YYYY-MM-DD
  restHR?: number;
  hrv?: number; // rMSSD ms
  sleepH?: number;
  soreness?: number; // 1‥5 (5 = very sore)
  mood?: number; // 1‥5 (5 = great)
  note?: string;
}

export interface Segment {
  id: string;
  name: string;
  sport: Sport;
  createdAt: number;
  path: number[]; // flat [lat,lon,…], ≈10 m spacing
  length: number;
  elevGain: number;
  auto?: boolean;
}

export interface SegmentEffort {
  segmentId: string;
  activityId: string;
  start: number; // epoch ms of effort start
  time: number; // seconds
  speed: number; // m/s
  avgHR?: number;
  avgPower?: number;
}

export type WorkoutKind = 'rest' | 'easy' | 'long' | 'tempo' | 'intervals' | 'recovery' | 'race' | 'strength' | 'cross';

export interface PlannedWorkout {
  id: string;
  date: string; // YYYY-MM-DD
  kind: WorkoutKind;
  title: string;
  detail: string;
  distance?: number; // m
  duration?: number; // s
  paceLo?: number; // m/s range
  paceHi?: number;
  load: number; // planned TSS-equivalent
}

export interface PlanWeek {
  index: number;
  start: string; // YYYY-MM-DD (Monday)
  phase: 'base' | 'build' | 'peak' | 'taper' | 'race';
  targetKm: number;
  deload: boolean;
}

export interface Plan {
  id: string;
  createdAt: number;
  goal: { distanceM: number; label: string; date: string; targetSec: number };
  daysPerWeek: number;
  longRunDay: number; // 0 = Sunday … 6 = Saturday
  vdot: number;
  weeks: PlanWeek[];
  workouts: PlannedWorkout[];
  notes: string[];
}

export interface LatLon {
  lat: number;
  lon: number;
}

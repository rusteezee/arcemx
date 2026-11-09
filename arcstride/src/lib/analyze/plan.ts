import type { Plan, PlanWeek, PlannedWorkout, WorkoutKind } from '../types';
import { dayNumToKey, dowOfDayNum, keyToDayNum } from '../units';
import { speedAtPct, trainingPaces, vdotFrom, type TrainingPaces } from './predict';

export interface PlanInput {
  today: number; // day number
  goalDistM: number;
  goalLabel: string;
  goalDate: string; // YYYY-MM-DD
  targetSec: number;
  daysPerWeek: number; // 3‥6
  longRunDay: number; // 0 = Sunday … 6 = Saturday
  currentWeeklyM: number; // recent average weekly run metres
  currentVdot: number;
}

const PEAK_KM: Record<string, number> = { '5000': 40, '10000': 52, '21097.5': 64, '42195': 82 };
const LONG_CAP_KM: Record<string, number> = { '5000': 14, '10000': 20, '21097.5': 26, '42195': 34 };
const TAPER: Record<number, number[]> = { 1: [0.7], 2: [0.75, 0.55], 3: [0.8, 0.65, 0.5] };
const KIND_IF: Record<WorkoutKind, number> = { rest: 0, easy: 0.7, long: 0.72, tempo: 0.88, intervals: 0.85, recovery: 0.6, race: 1.0, strength: 0.5, cross: 0.6 };

const gapKey = (m: number) => (m <= 5000 ? '5000' : m <= 10000 ? '10000' : m <= 21098 ? '21097.5' : '42195');

function paceFor(kind: WorkoutKind, p: TrainingPaces, goalSpeed: number): [number, number] {
  switch (kind) {
    case 'easy':
    case 'long':
      return [p.easy[0], p.easy[1]];
    case 'recovery':
      return [p.easy[0] * 0.95, p.easy[0] * 1.05];
    case 'tempo':
      return [p.threshold * 0.985, p.threshold * 1.015];
    case 'intervals':
      return [p.interval * 0.98, p.interval * 1.02];
    case 'race':
      return [goalSpeed * 0.99, goalSpeed * 1.01];
    default:
      return [p.easy[0], p.easy[1]];
  }
}

let seq = 0;
const wid = () => `w${Date.now().toString(36)}${(seq++).toString(36)}`;

export function generatePlan(inp: PlanInput): Plan {
  const raceDay = keyToDayNum(inp.goalDate);
  const startDay = inp.today + 1;
  const dow = dowOfDayNum(startDay);
  const startMonday = startDay - ((dow + 6) % 7);
  const raceMonday = raceDay - ((dowOfDayNum(raceDay) + 6) % 7);
  const nWeeks = Math.max(1, Math.round((raceMonday - startMonday) / 7) + 1);
  const gk = gapKey(inp.goalDistM);
  const notes: string[] = [];

  const goalVdot = vdotFrom(inp.goalDistM, inp.targetSec);
  const vdot = inp.currentVdot || goalVdot;
  const paces = trainingPaces(vdot);
  const goalSpeed = inp.goalDistM / inp.targetSec;
  if (goalVdot > vdot * 1.06) notes.push(`Goal needs VDOT ${goalVdot.toFixed(1)} vs your current ${vdot.toFixed(1)} (+${((goalVdot / vdot - 1) * 100).toFixed(0)} %). That's ambitious for ${nWeeks} weeks; the plan trains at current fitness and re-checks every week.`);
  else if (goalVdot < vdot * 0.97) notes.push(`Goal pace is comfortably inside current fitness (VDOT ${vdot.toFixed(1)} → ${goalVdot.toFixed(1)}). Consider a faster target.`);

  const base = Math.max(15_000, inp.currentWeeklyM);
  const taperWeeks = inp.goalDistM >= 42000 ? 3 : inp.goalDistM >= 21000 ? 2 : 1;
  const buildable = Math.max(0, nWeeks - taperWeeks - 1);
  const reachable = base * Math.pow(1.08, buildable);
  const peak = Math.min(PEAK_KM[gk] * 1000, Math.max(base, reachable));
  notes.push(`Starting volume ${(base / 1000).toFixed(0)} km/wk (your last 4-week average); peak ${(peak / 1000).toFixed(0)} km/wk. Weekly build ≤ 8 %, every 4th week deloaded ~22 %.`);

  // phases
  const weeks: PlanWeek[] = [];
  const peakWeeks = nWeeks >= 10 ? 2 : nWeeks >= 7 ? 1 : 0;
  const buildEnd = nWeeks - 1 - taperWeeks - peakWeeks; // last build index
  for (let i = 0; i < nWeeks; i++) {
    const isRace = i === nWeeks - 1;
    let phase: PlanWeek['phase'];
    if (isRace) phase = 'race';
    else if (i >= nWeeks - 1 - taperWeeks) phase = 'taper';
    else if (i > buildEnd) phase = 'peak';
    else if (i < Math.floor((buildEnd + 1) * 0.4) && nWeeks >= 8) phase = 'base';
    else phase = 'build';
    let km: number;
    const taperIdx = i - (nWeeks - 1 - taperWeeks);
    if (phase === 'taper') km = peak * (TAPER[taperWeeks][Math.min(taperWeeks - 1, Math.max(0, taperIdx))] ?? 0.6);
    else if (phase === 'race') km = peak * 0.4;
    else if (phase === 'peak') km = peak;
    else {
      const f = buildEnd <= 0 ? 1 : i / buildEnd;
      km = base + (peak - base) * f;
    }
    const deload = (phase === 'base' || phase === 'build') && i > 0 && i % 4 === 3 && i < buildEnd;
    if (deload) km *= 0.78;
    weeks.push({ index: i, start: dayNumToKey(startMonday + i * 7), phase, targetKm: Math.round(km / 100) / 10, deload });
  }

  const d = Math.max(3, Math.min(6, inp.daysPerWeek));
  const L = inp.longRunDay;
  const layout: [number, 'long' | 'q1' | 'q2' | 'easy' | 'rec'][] =
    d === 3 ? [[0, 'long'], [2, 'q1'], [4, 'easy']]
    : d === 4 ? [[0, 'long'], [2, 'q1'], [4, 'easy'], [6, 'easy']]
    : d === 5 ? [[0, 'long'], [1, 'rec'], [2, 'q1'], [4, 'q2'], [6, 'easy']]
    : [[0, 'long'], [1, 'rec'], [2, 'q1'], [3, 'easy'], [4, 'q2'], [6, 'easy']];

  const workouts: PlannedWorkout[] = [];
  const push = (date: number, kind: WorkoutKind, title: string, detail: string, distM: number) => {
    const [lo, hi] = paceFor(kind, paces, goalSpeed);
    const avg = kind === 'race' ? goalSpeed : (lo + hi) / 2;
    const effKind = kind === 'tempo' || kind === 'intervals' ? 0.82 : 1; // warm-up/cool-down at easy pace
    const dur = distM / (avg * effKind + (1 - effKind) * paces.easy[1]);
    const load = (dur / 3600) * KIND_IF[kind] ** 2 * 100;
    workouts.push({ id: wid(), date: dayNumToKey(date), kind, title, detail, distance: Math.round(distM / 100) * 100, duration: Math.round(dur), paceLo: lo, paceHi: hi, load: Math.round(load) });
  };

  for (const wk of weeks) {
    const monday = keyToDayNum(wk.start);
    const kmWeek = wk.targetKm * 1000;
    const raceWeek = wk.phase === 'race';
    const longCap = LONG_CAP_KM[gk] * 1000;
    const longShare = d <= 3 ? 0.4 : d === 4 ? 0.35 : 0.3;
    let longM = Math.min(longCap, kmWeek * longShare);
    if (wk.deload) longM *= 0.85;
    if (wk.phase === 'taper') longM *= 0.85;
    const quality = kmWeek * (d <= 3 ? 0.25 : 0.17);
    const easyCount = layout.filter(([, t]) => t === 'easy' || t === 'rec').length;
    const rest = Math.max(0, kmWeek - longM - quality * layout.filter(([, t]) => t === 'q1' || t === 'q2').length);
    const easyM = Math.max(3000, rest / Math.max(1, easyCount));

    if (raceWeek) {
      // race week: two short shakeouts + race
      const rDate = raceDay;
      push(rDate, 'race', `${inp.goalLabel} — race day`, `Goal ${Math.round(inp.targetSec / 60)} min. Start ~2 % slower than goal pace for the first km, then settle.`, inp.goalDistM);
      const shake = [rDate - 2, rDate - 4].filter((x) => x >= startDay && x >= monday);
      shake.forEach((x, i) => push(x, 'easy', i === 0 ? 'Shakeout + 4 strides' : 'Easy run', 'Easy effort, keep legs loose.', Math.min(6000, easyM)));
      continue;
    }

    for (const [off, role] of layout) {
      const day = monday + ((((L + off) % 7) + 6) % 7); // weekday (0 = Sun) → offset from Monday
      if (day < startDay) continue;
      let kind: WorkoutKind = 'easy';
      let title = 'Easy run';
      let detail = 'Conversational effort. If you can\'t talk in full sentences, slow down.';
      let m = easyM;
      if (role === 'long') {
        kind = 'long';
        title = 'Long run';
        detail = wk.phase === 'peak' && gk !== '5000' ? `Last ${Math.round(longM * 0.3 / 1000)} km at goal pace; rest easy.` : 'Steady easy pace. Practise fuelling every 30–40 min beyond 75 min.';
        m = longM;
      } else if (role === 'rec') {
        kind = 'recovery';
        title = 'Recovery jog';
        detail = 'Very easy, short. Purpose: blood flow, not fitness.';
        m = Math.min(easyM * 0.7, 6000);
      } else if (role === 'q1') {
        m = Math.max(5000, quality);
        if (wk.phase === 'base') {
          kind = 'easy';
          title = 'Hills + strides';
          detail = '6–8 × 45 s uphill (hard, controlled) with jog-down recovery, then 4 × 20 s strides.';
        } else if (wk.phase === 'taper') {
          kind = 'tempo';
          title = 'Sharpener — 3 × 5 min @ threshold';
          detail = '10 min warm-up, 3 × 5 min at threshold with 2 min jog, 10 min cool-down.';
        } else {
          kind = 'tempo';
          const mins = Math.min(40, 16 + wk.index * 1.5);
          title = wk.phase === 'peak' && gk !== '5000' ? `Race-pace: ${Math.round(mins * 0.8)} min @ goal pace` : `Tempo — ${Math.round(mins)} min @ threshold`;
          detail = `10 min warm-up, ${Math.round(mins)} min steady at threshold effort (comfortably hard), 10 min cool-down.`;
        }
      } else if (role === 'q2') {
        m = Math.max(5000, quality);
        if (wk.phase === 'base') {
          kind = 'easy';
          title = 'Easy + 6 strides';
          detail = 'Easy run finishing with 6 × 20 s relaxed strides.';
        } else if (wk.phase === 'taper') {
          kind = 'easy';
          title = 'Easy + 4 strides';
          detail = 'Keep it short and snappy.';
        } else {
          kind = 'intervals';
          const reps = Math.min(8, 4 + Math.floor(wk.index / 2));
          const rep = inp.goalDistM >= 21000 ? 1000 : 800;
          title = `Intervals ${reps} × ${rep} m`;
          detail = `15 min warm-up, ${reps} × ${rep} m at interval pace with ${rep === 1000 ? '3' : '2'} min jog recoveries, 10 min cool-down.`;
        }
      } else {
        m = easyM;
      }
      if (wk.deload && (kind === 'tempo' || kind === 'intervals')) {
        detail = `Deload week: ${detail} Do about 70 % of the volume.`;
      }
      push(day, kind, title, detail, m);
    }
  }
  workouts.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    id: wid(),
    createdAt: Date.now(),
    goal: { distanceM: inp.goalDistM, label: inp.goalLabel, date: inp.goalDate, targetSec: inp.targetSec },
    daysPerWeek: d,
    longRunDay: L,
    vdot,
    weeks,
    workouts,
    notes,
  };
}

// ───────────────────────── Adaptive re-planning ──────────────────────────
export interface AdaptInput {
  plan: Plan;
  today: number;
  /** actual run metres per day-number (from the athlete's data) */
  actualRunM: Map<number, number>;
  acwr: number;
  tsb: number;
}
export interface AdaptResult {
  plan: Plan;
  changes: string[];
  scale: number;
  compliance: number | undefined;
}

/** Adjust *upcoming* workouts using measured load and compliance. */
export function adaptPlan(a: AdaptInput): AdaptResult {
  const changes: string[] = [];
  // compliance over the last 14 days
  let planned = 0,
    actual = 0;
  for (const w of a.plan.workouts) {
    const d = keyToDayNum(w.date);
    if (d >= a.today - 14 && d < a.today && w.kind !== 'rest') {
      planned += w.distance ?? 0;
    }
  }
  for (let d = a.today - 14; d < a.today; d++) actual += a.actualRunM.get(d) ?? 0;
  const compliance = planned > 8000 ? actual / planned : undefined;

  let scale = 1;
  let softenQuality = false;
  if (a.acwr > 1.35 || a.tsb < -30) {
    scale = 0.85;
    softenQuality = true;
    changes.push(`Load is high (ACWR ${a.acwr.toFixed(2)}, Form ${a.tsb.toFixed(0)}): next 7 days reduced 15 % and the next hard session softened.`);
  } else if (compliance != null && compliance < 0.7) {
    scale = Math.max(0.8, compliance + 0.15);
    changes.push(`You completed ${(compliance * 100).toFixed(0)} % of planned distance recently: next 7 days scaled to ${(scale * 100).toFixed(0)} % so the build is realistic.`);
  } else if (compliance != null && compliance > 1.1 && a.acwr < 0.95 && a.tsb > -10) {
    scale = 1.05;
    changes.push(`You're running ahead of plan with load under control (ACWR ${a.acwr.toFixed(2)}): next 7 days nudged +5 %.`);
  }
  if (!changes.length) changes.push('No change needed — load and compliance are on track.');

  const workouts = a.plan.workouts.map((w) => ({ ...w }));
  if (scale !== 1) {
    let softened = false;
    for (const w of workouts) {
      const d = keyToDayNum(w.date);
      if (d >= a.today + 1 && d <= a.today + 7 && w.kind !== 'race') {
        w.distance = w.distance ? Math.round((w.distance * scale) / 100) * 100 : w.distance;
        w.duration = w.duration ? Math.round(w.duration * scale) : w.duration;
        w.load = Math.round(w.load * scale * scale);
        if (softenQuality && !softened && (w.kind === 'tempo' || w.kind === 'intervals')) {
          softened = true;
          const [lo, hi] = [speedAtPct(a.plan.vdot, 0.62), speedAtPct(a.plan.vdot, 0.74)];
          w.kind = 'easy';
          w.title = `Easy run (was: ${w.title})`;
          w.detail = 'Swapped for an easy run because load is high. Hard sessions resume when Form recovers.';
          w.paceLo = lo;
          w.paceHi = hi;
          w.load = Math.round(w.load * 0.55);
        }
      }
    }
  }
  const next: Plan = { ...a.plan, workouts, notes: [...a.plan.notes.filter((n) => !n.startsWith('Adapted ')), `Adapted ${dayNumToKey(a.today)}: ${changes.join(' ')}`] };
  return { plan: next, changes, scale, compliance };
}

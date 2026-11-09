import { describe, expect, it } from 'vitest';
import { generatePlan, adaptPlan } from '../src/lib/analyze/plan';
import { planPacing } from '../src/lib/analyze/pacing';
import { readiness, goalProgress, buildInsights } from '../src/lib/analyze/coach';
import { buildPMC, computeAllLoads, dailyLoads, type PMCPoint } from '../src/lib/analyze/load';
import { predictRaces } from '../src/lib/analyze/predict';
import { DEMO_PROFILE, DEMO_GOALS, demoCheckIns, generateDemo } from '../src/lib/demo/generate';
import { analyze } from '../src/lib/analyze/process';
import { dayNumOf, dayNumToKey, dowOfDayNum, keyToDayNum } from '../src/lib/units';
import { recentWeeklyRunMeters } from '../src/lib/analyze/coach';

const TODAY = keyToDayNum('2026-11-09'); // a Monday
const basePlan = (over: Partial<Parameters<typeof generatePlan>[0]> = {}) =>
  generatePlan({ today: TODAY, goalDistM: 21097.5, goalLabel: 'Half marathon', goalDate: '2027-01-17', targetSec: 5700, daysPerWeek: 5, longRunDay: 0, currentWeeklyM: 38000, currentVdot: 46.4, ...over });

describe('plan generator', () => {
  const plan = basePlan();
  it('spans from next Monday-aligned week to race week with a race workout on race day', () => {
    expect(plan.weeks.length).toBeGreaterThanOrEqual(9);
    expect(plan.weeks[plan.weeks.length - 1].phase).toBe('race');
    const race = plan.workouts.filter((w) => w.kind === 'race');
    expect(race).toHaveLength(1);
    expect(race[0].date).toBe('2027-01-17');
    expect(plan.workouts.every((w) => keyToDayNum(w.date) > TODAY)).toBe(true);
  });
  it('builds ≤ ~10 % per week outside deloads/taper, deloads every 4th week, tapers into the race', () => {
    const ws = plan.weeks;
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].phase === 'base' || ws[i].phase === 'build') {
        if (!ws[i].deload && !ws[i - 1].deload) expect(ws[i].targetKm / ws[i - 1].targetKm).toBeLessThan(1.16);
      }
    }
    expect(ws.some((w) => w.deload)).toBe(true);
    const peak = Math.max(...ws.map((w) => w.targetKm));
    expect(peak).toBeLessThanOrEqual(64);
    const taper = ws.filter((w) => w.phase === 'taper' || w.phase === 'race');
    expect(taper.every((w) => w.targetKm < peak * 0.85)).toBe(true);
  });
  it('places the long run on the chosen day, never next to the race, and caps its distance', () => {
    const longs = plan.workouts.filter((w) => w.kind === 'long');
    expect(longs.length).toBeGreaterThan(5);
    for (const l of longs) {
      expect(dowOfDayNum(keyToDayNum(l.date))).toBe(0);
      expect(l.distance!).toBeLessThanOrEqual(26000);
    }
  });
  it('has the right number of run days per full mid-plan week and valid paces/loads', () => {
    const mid = plan.weeks[3];
    const days = plan.workouts.filter((w) => w.date >= mid.start && keyToDayNum(w.date) < keyToDayNum(mid.start) + 7);
    expect(days).toHaveLength(5);
    expect(new Set(days.map((d) => d.date)).size).toBe(5);
    for (const w of plan.workouts) {
      expect(w.paceLo!).toBeGreaterThan(1.5);
      expect(w.paceHi!).toBeGreaterThanOrEqual(w.paceLo! * 0.95);
      expect(w.load).toBeGreaterThan(0);
    }
  });
  it('warns about an ambitious goal', () => {
    const p = basePlan({ targetSec: 4800 });
    expect(p.notes.join(' ')).toMatch(/ambitious/);
  });
  it('adapts: high ACWR reduces next week and swaps the next hard session', () => {
    const t = keyToDayNum(plan.weeks[3].start) - 1;
    const before = plan.workouts.filter((w) => keyToDayNum(w.date) > t && keyToDayNum(w.date) <= t + 7);
    const res = adaptPlan({ plan, today: t, actualRunM: new Map(), acwr: 1.5, tsb: -20 });
    const after = res.plan.workouts.filter((w) => keyToDayNum(w.date) > t && keyToDayNum(w.date) <= t + 7);
    const sum = (a: typeof before) => a.reduce((s, w) => s + (w.distance ?? 0), 0);
    expect(sum(after)).toBeLessThan(sum(before) * 0.9);
    expect(after.filter((w) => w.kind === 'tempo' || w.kind === 'intervals').length).toBe(before.filter((w) => w.kind === 'tempo' || w.kind === 'intervals').length - 1);
    expect(res.changes[0]).toMatch(/Load is high/);
    // original untouched
    expect(plan.workouts.filter((w) => keyToDayNum(w.date) > t && keyToDayNum(w.date) <= t + 7)[0].distance).toBe(before[0].distance);
  });
});

describe('pacing planner', () => {
  const N = 2000;
  const d = Array.from({ length: N }, (_, i) => (i * 10000) / (N - 1));
  const flat = { d, alt: d.map(() => 900) };
  const hilly = { d, alt: d.map((x) => 900 + (x < 5000 ? x * 0.02 : 100 - (x - 5000) * 0.02)) }; // up 2 % then down 2 %
  it('flat course: ≈ even splits that sum to the target', () => {
    const p = planPacing(flat, 3000, { units: 'metric', negativeSplit: 0 })!;
    expect(p.splits).toHaveLength(10);
    expect(p.splits.reduce((a, s) => a + s.time, 0)).toBeCloseTo(3000, 3);
    expect(Math.abs(p.splits[0].secPerUnit - p.splits[9].secPerUnit)).toBeLessThan(0.5);
  });
  it('hilly course: slower uphill, faster downhill, same total', () => {
    const p = planPacing(hilly, 3000, { units: 'metric', negativeSplit: 0 })!;
    expect(p.splits[2].secPerUnit).toBeGreaterThan(p.splits[7].secPerUnit);
    expect(p.splits.reduce((a, s) => a + s.time, 0)).toBeCloseTo(3000, 3);
    expect(p.totalGain).toBeGreaterThan(90);
  });
  it('negative split makes the second half faster', () => {
    const p = planPacing(flat, 3000, { units: 'metric', negativeSplit: 0.03 })!;
    expect(p.splits[0].secPerUnit).toBeGreaterThan(p.splits[9].secPerUnit);
    expect(p.splits.reduce((a, s) => a + s.time, 0)).toBeCloseTo(3000, 3);
  });
});

describe('readiness / goals / insights on the demo athlete', () => {
  const NOW = Date.UTC(2026, 10, 9, 5, 0, 0);
  const acts = [...generateDemo({ now: NOW })].map((g) => analyze(g, DEMO_PROFILE, { tz: 330 })!.summary);
  const loads = computeAllLoads(acts, DEMO_PROFILE);
  const daily = dailyLoads(acts, loads);
  const today = dayNumOf(NOW, 330);
  const pmc = buildPMC(daily, Math.min(...daily.keys()), today);
  const last = pmc[pmc.length - 1];

  it('readiness: fatigue lowers the score and a bad check-in lowers it further', () => {
    const none = readiness(last, [], dayNumToKey(today));
    const checks = demoCheckIns(NOW);
    const withC = readiness(last, checks, dayNumToKey(today));
    expect(withC.hasCheckIn).toBe(true);
    expect(withC.score).toBeLessThanOrEqual(none.score);
    const fresh: PMCPoint = { ...last, tsb: 12, acwr: 1.0 };
    expect(readiness(fresh, [], dayNumToKey(today)).score).toBeGreaterThan(75);
    const tired: PMCPoint = { ...last, tsb: -32, acwr: 1.6 };
    expect(readiness(tired, [], dayNumToKey(today)).label).toBe('Recover');
    expect(withC.parts.length).toBeGreaterThan(0);
  });
  it('goal progress projects and classifies', () => {
    const g = DEMO_GOALS.map((x) => goalProgress(x, acts, today, 1));
    for (const x of g) {
      expect(x.projected).toBeGreaterThanOrEqual(0);
      expect(['done', 'ahead', 'on-track', 'behind']).toContain(x.status);
      expect(x.elapsed).toBeGreaterThan(0);
    }
    const tiny = goalProgress({ id: 't', metric: 'count', period: 'year', target: 1, sport: 'all' }, acts, today, 1);
    expect(tiny.status).toBe('done');
  });
  it('insights are evidence-backed, ranked, and include the formula', () => {
    const pred = predictRaces(acts, NOW);
    const ins = buildInsights({ acts, loads, pmc, daily, profile: DEMO_PROFILE, goals: DEMO_GOALS.map((x) => goalProgress(x, acts, today, 1)), pred, readiness: readiness(last, demoCheckIns(NOW), dayNumToKey(today)), now: NOW, today, tz: 330 });
    console.log(ins.map((i) => `${i.kind.padEnd(6)} ${i.title}`).join('\n'));
    expect(ins.length).toBeGreaterThan(3);
    for (const i of ins) {
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(i.formula.length).toBeGreaterThan(10);
    }
    for (let k = 1; k < ins.length; k++) expect(ins[k - 1].priority).toBeGreaterThanOrEqual(ins[k].priority);
    expect(recentWeeklyRunMeters(acts, today)).toBeGreaterThan(10000);
  });
});

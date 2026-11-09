import type { ActivitySummary, CheckIn, Goal, Loads, Profile } from '../types';
import { clamp, dayNumOf, dowOfDayNum, fmtDistU, fmtPace, fmtTime, keyToDayNum } from '../units';
import { median } from '../stats';
import { acwrZone, monotonyStrain, spikeCheck, triDistribution, type PMCPoint } from './load';
import { bestEffortsAgg } from './efforts';
import { BEST_LABELS } from './process';
import type { PredictionSet } from './predict';

// ───────────────────────── Readiness ─────────────────────────────────────
export interface ReadinessPart {
  label: string;
  delta: number;
  note: string;
}
export interface Readiness {
  score: number;
  label: 'Go' | 'Steady' | 'Easy day' | 'Recover';
  advice: string;
  parts: ReadinessPart[];
  hasCheckIn: boolean;
}

/**
 * Transparent heuristic, not a medical model. Base = Form (CTL−ATL); then adjustments for load ramp and,
 * if you logged one, today's/yesterday's check-in against your own 28-day baseline.
 */
export function readiness(last: PMCPoint | undefined, checkins: CheckIn[], todayKey: string): Readiness {
  const parts: ReadinessPart[] = [];
  if (!last) return { score: 70, label: 'Steady', advice: 'Import or record a few activities to get a personalised score.', parts, hasCheckIn: false };
  const base = clamp(68 + 1.4 * last.tsb, 10, 95);
  parts.push({ label: 'Form', delta: base - 68, note: `Form ${last.tsb >= 0 ? '+' : ''}${last.tsb.toFixed(0)} (CTL ${last.ctl.toFixed(0)} − ATL ${last.atl.toFixed(0)})` });
  let score = base;
  if (last.acwr > 1.3) {
    const pen = Math.min(25, (last.acwr - 1.3) * 50);
    score -= pen;
    parts.push({ label: 'Load ramp', delta: -pen, note: `ACWR ${last.acwr.toFixed(2)} is above 1.3` });
  }
  const today = keyToDayNum(todayKey);
  const sorted = [...checkins].sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = [...sorted].reverse().find((c) => keyToDayNum(c.date) >= today - 1 && keyToDayNum(c.date) <= today);
  if (latest) {
    const prior = sorted.filter((c) => c.date !== latest.date && keyToDayNum(c.date) >= today - 30);
    const med = (f: (c: CheckIn) => number | undefined) => median(prior.map(f).filter((x): x is number => x != null));
    if (latest.restHR != null) {
      const b = med((c) => c.restHR);
      if (b === b) {
        const d = latest.restHR - b;
        const delta = d >= 3 ? -Math.min(12, d * 2) : d <= -2 ? 3 : 0;
        if (delta) parts.push({ label: 'Resting HR', delta, note: `${latest.restHR} bpm vs ${b.toFixed(0)} baseline` });
        score += delta;
      }
    }
    if (latest.hrv != null) {
      const b = med((c) => c.hrv);
      if (b === b && b > 0) {
        const pct = (latest.hrv - b) / b;
        const delta = pct <= -0.08 ? -Math.min(14, -pct * 70) : pct >= 0.08 ? 3 : 0;
        if (delta) parts.push({ label: 'HRV', delta, note: `${latest.hrv} ms vs ${b.toFixed(0)} baseline (${(pct * 100).toFixed(0)} %)` });
        score += delta;
      }
    }
    if (latest.sleepH != null) {
      const delta = latest.sleepH < 6 ? -10 : latest.sleepH < 7 ? -4 : latest.sleepH >= 8 ? 3 : 0;
      if (delta) parts.push({ label: 'Sleep', delta, note: `${latest.sleepH.toFixed(1)} h` });
      score += delta;
    }
    if (latest.soreness != null) {
      const delta = latest.soreness >= 5 ? -14 : latest.soreness === 4 ? -8 : latest.soreness <= 1 ? 2 : 0;
      if (delta) parts.push({ label: 'Soreness', delta, note: `${latest.soreness} / 5` });
      score += delta;
    }
    if (latest.mood != null) {
      const delta = latest.mood <= 2 ? -5 : latest.mood >= 5 ? 2 : 0;
      if (delta) parts.push({ label: 'Mood', delta, note: `${latest.mood} / 5` });
      score += delta;
    }
  }
  score = clamp(Math.round(score), 5, 98);
  const label: Readiness['label'] = score >= 75 ? 'Go' : score >= 50 ? 'Steady' : score >= 30 ? 'Easy day' : 'Recover';
  const advice = {
    Go: 'Fresh enough for a quality session — intervals, tempo or a hard group ride.',
    Steady: 'Normal day. Stick to the plan; keep easy days easy.',
    'Easy day': 'Fatigue is carrying. Aerobic only, or take a rest day.',
    Recover: 'Back off: full rest or a short walk. Recovery is training too.',
  }[label];
  return { score, label, advice, parts, hasCheckIn: !!latest };
}

// ───────────────────────── Goals ─────────────────────────────────────────
export interface GoalProgress {
  goal: Goal;
  current: number;
  target: number;
  frac: number; // 0‥1+
  elapsed: number; // fraction of period elapsed
  projected: number;
  status: 'done' | 'ahead' | 'on-track' | 'behind';
  perDayNeeded: number;
  daysLeft: number;
  periodStart: number;
  periodEnd: number;
}

export function periodBounds(period: Goal['period'], today: number, weekStart: 0 | 1): [number, number] {
  if (period === 'week') {
    const dow = dowOfDayNum(today);
    const s = today - ((dow - weekStart + 7) % 7);
    return [s, s + 6];
  }
  const d = new Date(today * 86400000);
  if (period === 'month') {
    const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000;
    const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / 86400000;
    return [s, e];
  }
  return [Date.UTC(d.getUTCFullYear(), 0, 1) / 86400000, Date.UTC(d.getUTCFullYear(), 11, 31) / 86400000];
}

export function metricOf(a: ActivitySummary, m: Goal['metric']): number {
  return m === 'distance' ? a.distance : m === 'time' ? a.moving : m === 'elevation' ? a.elevGain : 1;
}

export function goalProgress(goal: Goal, acts: ActivitySummary[], today: number, weekStart: 0 | 1): GoalProgress {
  const [s, e] = periodBounds(goal.period, today, weekStart);
  let cur = 0;
  for (const a of acts) {
    const d = dayNumOf(a.start, a.tz);
    if (d < s || d > e) continue;
    if (goal.sport !== 'all' && a.sport !== goal.sport) continue;
    cur += metricOf(a, goal.metric);
  }
  const total = e - s + 1;
  const done = Math.min(total, today - s + 1);
  const elapsed = done / total;
  const projected = elapsed > 0 ? cur / elapsed : 0;
  const daysLeft = Math.max(0, e - today);
  const frac = cur / goal.target;
  let status: GoalProgress['status'];
  if (cur >= goal.target) status = 'done';
  else if (projected >= goal.target * 1.05) status = 'ahead';
  else if (projected >= goal.target * 0.9) status = 'on-track';
  else status = 'behind';
  return { goal, current: cur, target: goal.target, frac, elapsed, projected, status, perDayNeeded: daysLeft ? Math.max(0, goal.target - cur) / daysLeft : 0, daysLeft, periodStart: s, periodEnd: e };
}

// ───────────────────────── Insights ──────────────────────────────────────
export type InsightKind = 'risk' | 'action' | 'win' | 'info';
export interface Insight {
  id: string;
  kind: InsightKind;
  title: string;
  body: string;
  evidence: { label: string; value: string }[];
  formula: string;
  priority: number;
}

export interface InsightCtx {
  acts: ActivitySummary[];
  loads: Map<string, Loads>;
  pmc: PMCPoint[];
  daily: Map<number, number>;
  profile: Profile;
  goals: GoalProgress[];
  pred?: PredictionSet;
  readiness: Readiness;
  now: number;
  today: number;
  tz: number;
}

const KIND_PRI: Record<InsightKind, number> = { risk: 100, action: 70, win: 50, info: 20 };

export function buildInsights(c: InsightCtx): Insight[] {
  const out: Insight[] = [];
  const last = c.pmc[c.pmc.length - 1];
  const u = c.profile.units;
  const add = (i: Omit<Insight, 'priority'> & { priority?: number }) => out.push({ ...i, priority: (i.priority ?? 0) + KIND_PRI[i.kind] });
  if (!last || c.acts.length < 3) return out;

  // 1 ── ACWR
  const z = acwrZone(last.acwr);
  const ramp = last.ctl - (c.pmc[c.pmc.length - 8]?.ctl ?? last.ctl);
  if (z === 'caution' || z === 'danger') {
    add({
      id: 'acwr-high',
      kind: 'risk',
      priority: z === 'danger' ? 10 : 0,
      title: z === 'danger' ? 'Load is spiking' : 'Load is climbing fast',
      body: `Your acute:chronic workload ratio is ${last.acwr.toFixed(2)}. Above 1.3 the last week is outpacing what your body has adapted to; hold volume flat or add an easy day before building further.`,
      evidence: [
        { label: 'ACWR (7:28 EWMA)', value: last.acwr.toFixed(2) },
        { label: 'Fitness ramp, 7 d', value: `${ramp >= 0 ? '+' : ''}${ramp.toFixed(1)} CTL` },
        { label: 'Fatigue vs fitness', value: `${last.atl.toFixed(0)} vs ${last.ctl.toFixed(0)}` },
      ],
      formula: 'ACWR = EWMA₇(daily load) ÷ EWMA₂₈(daily load), λ = 2/(N+1). Zones: <0.8 under · 0.8–1.3 sweet spot · 1.3–1.5 caution · >1.5 danger.',
    });
  } else if (z === 'under' && last.ctl > 20) {
    add({
      id: 'acwr-low',
      kind: 'info',
      title: 'Training has dipped below your base',
      body: `ACWR is ${last.acwr.toFixed(2)}: the last week was lighter than your 4-week norm. Fine for a recovery block; if it wasn't planned, ease back in over 3–4 days.`,
      evidence: [{ label: 'ACWR', value: last.acwr.toFixed(2) }, { label: 'Fitness (CTL)', value: last.ctl.toFixed(0) }],
      formula: 'ACWR = EWMA₇ ÷ EWMA₂₈ of daily load.',
    });
  }

  // 2 ── Form
  if (last.tsb <= -25) {
    add({
      id: 'form-deep',
      kind: 'risk',
      title: 'Deep fatigue',
      body: `Form is ${last.tsb.toFixed(0)}. Productive blocks usually sit between −10 and −30, but beyond −25 for several days stacks up risk. Schedule a down day.`,
      evidence: [{ label: 'Form (TSB)', value: last.tsb.toFixed(1) }, { label: 'ATL', value: last.atl.toFixed(0) }, { label: 'CTL', value: last.ctl.toFixed(0) }],
      formula: 'Form = CTL(yesterday) − ATL(yesterday); CTL = 42-day EWMA, ATL = 7-day EWMA of daily load.',
    });
  } else if (last.tsb >= 5 && last.tsb <= 22 && z === 'sweet') {
    add({
      id: 'form-fresh',
      kind: 'win',
      title: 'You are fresh',
      body: `Form is +${last.tsb.toFixed(0)} with a healthy load ratio — a good window for a hard session, time trial or race.`,
      evidence: [{ label: 'Form (TSB)', value: `+${last.tsb.toFixed(1)}` }, { label: 'ACWR', value: last.acwr.toFixed(2) }],
      formula: 'Form = CTL(yesterday) − ATL(yesterday).',
    });
  } else if (last.tsb > 25) {
    add({
      id: 'form-very-fresh',
      kind: 'info',
      title: 'Very fresh — fitness may be fading',
      body: `Form +${last.tsb.toFixed(0)} usually means several light days. Fine before a race; otherwise add load.`,
      evidence: [{ label: 'Form (TSB)', value: `+${last.tsb.toFixed(1)}` }],
      formula: 'Form = CTL(yesterday) − ATL(yesterday).',
    });
  }

  // 3 ── fitness ramp
  if (ramp >= 7) {
    add({ id: 'ramp', kind: 'risk', title: 'Fitness ramp is steep', body: `CTL rose ${ramp.toFixed(1)} points in 7 days. Sustained ramps above ~6/wk are hard to absorb; plan a lighter week soon.`, evidence: [{ label: 'CTL now', value: last.ctl.toFixed(1) }, { label: 'Δ 7 d', value: `+${ramp.toFixed(1)}` }], formula: 'Ramp = CTL(today) − CTL(7 days ago).' });
  } else if (ramp >= 2.5) {
    add({ id: 'ramp-good', kind: 'win', title: 'Productive build', body: `Fitness is up ${ramp.toFixed(1)} points this week — a ramp in the 2.5–6 range is the sustainable zone.`, evidence: [{ label: 'CTL now', value: last.ctl.toFixed(1) }, { label: 'Δ 7 d', value: `+${ramp.toFixed(1)}` }], formula: 'Ramp = CTL(today) − CTL(7 days ago).' });
  }

  // 4 ── spike check
  const sp = spikeCheck(c.acts, c.today);
  if (sp && sp.ratio > 1.1 && sp.latest.distance > 5000) {
    add({
      id: 'spike',
      kind: sp.ratio > 1.3 ? 'risk' : 'action',
      title: `Longest-run jump: +${Math.round((sp.ratio - 1) * 100)} %`,
      body: `${sp.latest.name} (${fmtDistU(sp.latest.distance, u, 1)}) exceeded your longest run of the previous 30 days (${fmtDistU(sp.prevMax, u, 1)}). A single-session jump above ~10 % is linked to more running injuries (Nielsen 2014).`,
      evidence: [{ label: 'Latest', value: fmtDistU(sp.latest.distance, u, 1) }, { label: 'Prior 30-day max', value: fmtDistU(sp.prevMax, u, 1) }, { label: 'Ratio', value: sp.ratio.toFixed(2) }],
      formula: 'ratio = distance(latest run) ÷ max distance of runs in the prior 30 days. Flag > 1.10, high > 1.30.',
    });
  }

  // 5 ── intensity distribution (28 d)
  const dist = triDistribution(c.acts, c.loads, c.today - 27, c.today);
  if (dist.total > 4 * 3600) {
    const fl = dist.low / dist.total,
      fm = dist.mid / dist.total,
      fh = dist.high / dist.total;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const ev = [{ label: 'Low (below LT1)', value: pct(fl) }, { label: 'Moderate (LT1–LT2)', value: pct(fm) }, { label: 'High (≥ threshold)', value: pct(fh) }, { label: 'Model', value: dist.model }];
    const formula = 'Time in each Seiler 3-zone band over 28 days: low < ~90 % LTHR (88.5 % threshold speed, 76 % FTP) · high ≥ threshold. Best available signal per activity (power → HR → pace).';
    if (fm > 0.3) add({ id: 'grey', kind: 'action', title: 'Too much time in the grey zone', body: `${pct(fm)} of your training sits between easy and threshold. It's hard enough to tire you and easy enough to under-stimulate. Make easy days truly easy (below ${Math.round(0.9 * c.profile.lthr)} bpm) and keep hard days genuinely hard.`, evidence: ev, formula });
    else if (fl >= 0.75 && fh < 0.05) add({ id: 'base-heavy', kind: 'info', title: 'Base-heavy block', body: `${pct(fl)} easy and almost no high-intensity work. Great for aerobic base — add one interval session per week when you want to sharpen.`, evidence: ev, formula });
    else if (fl >= 0.7 && fh >= 0.05) add({ id: 'balanced', kind: 'win', title: 'Healthy intensity mix', body: `${pct(fl)} easy / ${pct(fm)} moderate / ${pct(fh)} hard looks like an ${dist.model} distribution — the pattern endurance research favours.`, evidence: ev, formula });
  }

  // 6 ── decoupling on long sessions
  const longs = c.acts.filter((a) => a.decoupling != null && a.timer >= 4500 && (a.vi == null || a.vi < 1.12)).sort((a, b) => b.start - a.start).slice(0, 4);
  if (longs.length >= 2) {
    const avg = longs.reduce((s, a) => s + a.decoupling!, 0) / longs.length;
    const ev = [{ label: 'Sessions averaged', value: String(longs.length) }, { label: 'Mean decoupling', value: `${avg.toFixed(1)} %` }, { label: 'Latest', value: `${longs[0].decoupling!.toFixed(1)} %` }];
    const formula = 'Decoupling = (EF₁ − EF₂) ÷ EF₁ × 100, EF = output ÷ HR for first vs second half (first 10 min dropped). Output = grade-adjusted speed (runs) or power (rides).';
    if (avg > 5) add({ id: 'decouple-high', kind: 'action', title: 'Aerobic drift on long sessions', body: `Heart rate drifts ${avg.toFixed(1)} % against output in your long efforts. Under ~5 % indicates a solid aerobic base — more steady Zone 2 volume and fuelling/hydration practice will help.`, evidence: ev, formula });
    else if (avg < 3) add({ id: 'decouple-low', kind: 'win', title: 'Strong aerobic durability', body: `Only ${avg.toFixed(1)} % decoupling across recent long sessions: heart rate barely drifts at steady output.`, evidence: ev, formula });
  }

  // 7 ── efficiency trend (easy runs with HR)
  const runs = c.acts.filter((a) => a.sport === 'run' && a.ef && a.avgHR && a.avgHR < 0.92 * c.profile.lthr && a.timer > 1500);
  const recent = runs.filter((a) => a.start > c.now - 42 * 86400000);
  const prior = runs.filter((a) => a.start <= c.now - 42 * 86400000 && a.start > c.now - 84 * 86400000);
  if (recent.length >= 4 && prior.length >= 4) {
    const r = recent.reduce((s, a) => s + a.ef!, 0) / recent.length;
    const p = prior.reduce((s, a) => s + a.ef!, 0) / prior.length;
    const chg = (r / p - 1) * 100;
    const ev = [{ label: 'Last 6 wk', value: r.toFixed(2) }, { label: 'Prior 6 wk', value: p.toFixed(2) }, { label: 'Change', value: `${chg >= 0 ? '+' : ''}${chg.toFixed(1)} %` }];
    const formula = 'EF = (grade-adjusted speed in m/min) ÷ average HR, for easy runs only (avg HR < 92 % LTHR, > 25 min). Higher = more speed per heartbeat.';
    if (chg >= 3) add({ id: 'ef-up', kind: 'win', title: 'Aerobic efficiency is improving', body: `At comparable easy effort you're covering ${chg.toFixed(1)} % more ground per heartbeat than six weeks ago.`, evidence: ev, formula });
    else if (chg <= -4) add({ id: 'ef-down', kind: 'risk', title: 'Efficiency has slipped', body: `Speed per heartbeat is down ${Math.abs(chg).toFixed(1)} % on easy runs. Heat, fatigue, illness or under-recovery are the usual causes.`, evidence: ev, formula });
  }

  // 8 ── PRs in the last 14 days (best efforts)
  const since = c.now - 14 * 86400000;
  const allBest = bestEffortsAgg(c.acts.filter((a) => a.sport === 'run'));
  const prevBest = bestEffortsAgg(c.acts.filter((a) => a.sport === 'run' && a.start < since));
  for (const [D, e] of allBest) {
    if (D < 1000 || e.start < since) continue;
    const pb = prevBest.get(D);
    if (!pb || e.time < pb.time - 0.5) {
      add({
        id: `pr-${D}`,
        kind: 'win',
        priority: D === 5000 || D === 10000 ? 8 : 0,
        title: `New ${BEST_LABELS[D] ?? D + ' m'} PR`,
        body: pb ? `${fmtTime(e.time)} — ${fmtTime(pb.time - e.time)} faster than your previous best.` : `${fmtTime(e.time)} — your first recorded ${BEST_LABELS[D]} effort.`,
        evidence: [{ label: 'Time', value: fmtTime(e.time) }, { label: 'Pace', value: `${fmtPace(D / e.time, u)} ${u === 'metric' ? '/km' : '/mi'}` }],
        formula: 'Best effort = fastest sliding window of the target distance within any activity (interpolated, GPS-smoothed).',
      });
    }
  }

  // 9 ── consistency & rest
  let streak = 0;
  for (let d = c.today - 1; d >= c.today - 60; d--) {
    if (c.daily.has(d)) streak++;
    else break;
  }
  if (streak >= 8) add({ id: 'no-rest', kind: 'risk', title: `${streak} days without a rest day`, body: 'Adaptation happens in recovery. Take a full day off soon.', evidence: [{ label: 'Consecutive days', value: String(streak) }], formula: 'Count of consecutive days with at least one activity, ending yesterday.' });
  let weeks = 0;
  for (let w = 0; w < 12; w++) {
    let n = 0;
    for (let d = c.today - 7 * (w + 1) + 1; d <= c.today - 7 * w; d++) if (c.daily.has(d)) n++;
    if (n >= 3) weeks++;
    else break;
  }
  if (weeks >= 6) add({ id: 'consistent', kind: 'win', title: `${weeks}-week consistency streak`, body: `${weeks} weeks in a row with 3+ active days. Consistency is the strongest predictor of long-term progress.`, evidence: [{ label: 'Weeks', value: String(weeks) }], formula: 'Rolling 7-day windows ending today, each with ≥ 3 active days.' });
  const gap = c.today - Math.max(...c.acts.map((a) => dayNumOf(a.start, a.tz)));
  if (gap >= 7) add({ id: 'gap', kind: 'info', title: `${gap} days since your last activity`, body: 'Ease back in: the first week back should be ~50–60 % of your usual volume, all easy.', evidence: [{ label: 'Days idle', value: String(gap) }], formula: 'Today − date of latest activity.' });

  // 10 ── monotony
  const ms = monotonyStrain(c.daily, c.today);
  if (ms.monotony > 2 && ms.weekLoad > 150) add({ id: 'monotony', kind: 'action', title: 'Training is too uniform', body: `Monotony ${ms.monotony.toFixed(1)}: your days look alike. Foster's research links monotony above 2.0 with illness. Mix hard, easy and off days more.`, evidence: [{ label: 'Monotony', value: ms.monotony.toFixed(2) }, { label: 'Strain', value: ms.strain.toFixed(0) }, { label: '7-day load', value: ms.weekLoad.toFixed(0) }], formula: 'Monotony = mean(daily load, 7 d) ÷ sd(daily load, 7 d) · Strain = weekly load × monotony.' });

  // 11 ── goals
  for (const g of c.goals) {
    if (g.status === 'behind' && g.elapsed > 0.25 && g.goal.period !== 'year') {
      add({ id: `goal-${g.goal.id}`, kind: 'action', title: `Behind on your ${g.goal.period} goal`, body: `At the current rate you'll land at ${Math.round((g.projected / g.target) * 100)} % of target. You need ${describeGoal(g.goal, g.perDayNeeded, u)} per day for the remaining ${g.daysLeft} days.`, evidence: [{ label: 'Current', value: describeGoal(g.goal, g.current, u) }, { label: 'Target', value: describeGoal(g.goal, g.target, u) }, { label: 'Projected', value: describeGoal(g.goal, g.projected, u) }], formula: 'Projected = current ÷ fraction of period elapsed.' });
    } else if (g.status === 'done') {
      add({ id: `goal-done-${g.goal.id}`, kind: 'win', title: `${g.goal.period[0].toUpperCase() + g.goal.period.slice(1)} goal complete`, body: `You've hit ${describeGoal(g.goal, g.current, u)} — target was ${describeGoal(g.goal, g.target, u)}.`, evidence: [{ label: 'Done', value: describeGoal(g.goal, g.current, u) }], formula: 'Σ of the goal metric over all matching activities in the period.' });
    }
  }

  // 12 ── race outlook
  if (c.pred) {
    const r5 = c.pred.races[0],
      r10 = c.pred.races[1];
    add({ id: 'pred', kind: 'info', title: `Fitness points to a ${fmtTime(r5.mid)} 5K`, body: `VDOT ${c.pred.vdot.toFixed(1)} from your ${c.pred.basis.label} effort. 10K ≈ ${fmtTime(r10.mid)}; half marathon ≈ ${fmtTime(c.pred.races[2].low)}–${fmtTime(c.pred.races[2].high)}.`, evidence: [{ label: 'VDOT', value: c.pred.vdot.toFixed(1) }, { label: 'Confidence', value: c.pred.confidence }, { label: 'Riegel exponent', value: `${c.pred.exponent.b.toFixed(3)}${c.pred.exponent.personal ? ' (personal)' : ''}` }], formula: 'Daniels/Gilbert VDOT from your best recent 1.5–21 km effort; cross-checked with Riegel t₂ = t₁·(d₂/d₁)^b.' });
  }

  // 13 ── readiness check-in
  if (c.readiness.hasCheckIn && c.readiness.parts.some((p) => p.delta <= -6 && p.label !== 'Form')) {
    const bad = c.readiness.parts.filter((p) => p.delta <= -6 && p.label !== 'Form');
    add({ id: 'checkin', kind: 'action', title: 'Your body is flagging fatigue', body: `${bad.map((b) => b.label.toLowerCase()).join(' and ')} ${bad.length > 1 ? 'are' : 'is'} off your baseline today. ${c.readiness.advice}`, evidence: bad.map((b) => ({ label: b.label, value: b.note })), formula: 'Check-in values compared with your own 30-day median.' });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

export function describeGoal(g: Goal, v: number, u: Profile['units']): string {
  switch (g.metric) {
    case 'distance':
      return fmtDistU(v, u, 0);
    case 'time':
      return `${(v / 3600).toFixed(1)} h`;
    case 'elevation':
      return `${Math.round(u === 'metric' ? v : v / 0.3048).toLocaleString()} ${u === 'metric' ? 'm' : 'ft'}`;
    default:
      return `${Math.round(v)} activities`;
  }
}

/** Weekly run volume trend helper for plan generation: average km over the last `weeks` full weeks. */
export function recentWeeklyRunMeters(acts: ActivitySummary[], today: number, weeks = 4): number {
  let total = 0;
  const from = today - weeks * 7;
  for (const a of acts) {
    if (a.sport !== 'run') continue;
    const d = dayNumOf(a.start, a.tz);
    if (d >= from && d < today) total += a.distance;
  }
  return total / weeks;
}


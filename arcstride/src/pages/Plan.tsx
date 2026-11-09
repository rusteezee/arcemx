import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { Link, navigate } from '../lib/router';
import { setPlan, toast, useStore } from '../lib/store/store';
import { useEntries, useUnits } from '../lib/hooks';
import { KM, MI, parseHMS, dayNumOf, dayNumToKey, dowOfDayNum, fmtDayKey, fmtDistU, fmtPace, fmtTime, keyToDayNum, paceUnit } from '../lib/units';
import { adaptPlan, generatePlan } from '../lib/analyze/plan';
import { recentWeeklyRunMeters } from '../lib/analyze/coach';
import { planPacing, type PacingPlan } from '../lib/analyze/pacing';
import { vdotFrom } from '../lib/analyze/predict';
import { fastDist } from '../lib/geo';
import { download } from '../lib/export';
import type { WorkoutKind } from '../lib/types';
import { Chip, Field, Meter, PageHead, Section, Seg, Tabs, Tile, Why, GLYPH } from '../ui/kit';
import { Panel } from '../ui/charts/Panel';

const GOALS = [
  { label: '5K', m: 5000 },
  { label: '10K', m: 10000 },
  { label: 'Half marathon', m: 21097.5 },
  { label: 'Marathon', m: 42195 },
];
const KIND_TONE: Record<WorkoutKind, 'pos' | 'neg' | 'warn' | 'lime' | 'mute' | undefined> = { rest: 'mute', easy: 'pos', long: 'lime', tempo: 'warn', intervals: 'neg', recovery: 'mute', race: 'neg', strength: 'mute', cross: 'mute' };

export function PlanPage({ tab }: { tab: string }) {
  const t = tab === 'pacing' ? 'pacing' : 'plan';
  return (
    <>
      <PageHead tag="Plan" title={t === 'plan' ? 'A plan that listens.' : 'Pace the course, not the clock.'} lede={t === 'plan' ? 'Periodised from your current volume, paced from your VDOT, and re-planned from your measured load — included, not an add-on.' : 'Effort-matched splits from the actual elevation profile: slower on climbs, faster on descents, same physiological cost.'} actions={<Tabs value={t} onChange={(v) => navigate(`/plan?tab=${v}`)} options={[{ v: 'plan', label: 'Training plan', glyph: GLYPH.plan }, { v: 'pacing', label: 'Course pacing', glyph: GLYPH.routes }]} />} />
      {t === 'plan' ? <TrainingPlan /> : <Pacing />}
    </>
  );
}

// ───────────────────────── Training plan ─────────────────────────
function TrainingPlan() {
  const core = useCore();
  const units = useUnits();
  const plan = useStore((s) => s.plan);
  const { acts, pred, today, last } = core;
  const [dist, setDist] = useState(21097.5);
  const [date, setDate] = useState(() => dayNumToKey(today + 10 * 7 + ((7 - dowOfDayNum(today + 70)) % 7)));
  const [target, setTarget] = useState('');
  const [days, setDays] = useState(5);
  const [longDay, setLongDay] = useState(0);
  const [changes, setChanges] = useState<string[] | null>(null);

  const weekly = recentWeeklyRunMeters(acts, today, 4);
  const suggestedSec = useMemo(() => {
    const r = pred?.races.find((x) => Math.abs(x.distM - dist) < 50);
    if (r) return r.mid * 0.985;
    return dist / 3.0;
  }, [pred, dist]);
  const targetSec = parseHMS(target) ?? suggestedSec;
  const label = GOALS.find((g) => g.m === dist)?.label ?? 'Race';

  const actualRun = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of acts) if (a.sport === 'run') m.set(dayNumOf(a.start, a.tz), (m.get(dayNumOf(a.start, a.tz)) ?? 0) + a.distance);
    return m;
  }, [acts]);

  const create = () => {
    if (keyToDayNum(date) <= today + 6) return toast('Pick a race date at least a week away.', 'warn');
    const p = generatePlan({ today, goalDistM: dist, goalLabel: label, goalDate: date, targetSec, daysPerWeek: days, longRunDay: longDay, currentWeeklyM: weekly, currentVdot: pred?.vdot ?? vdotFrom(dist, targetSec) });
    setPlan(p);
    setChanges(null);
    toast(`Plan created: ${p.weeks.length} weeks to ${label}.`);
  };

  if (!plan)
    return (
      <Section n={1} total={1} glyph={GLYPH.plan} kicker="New plan" title="Set your goal">
        <div className="card lg">
          <div className="grid cols-3">
            <Field label="Race"><select className="select" value={dist} onChange={(e) => setDist(+e.target.value)}>{GOALS.map((g) => <option key={g.m} value={g.m}>{g.label}</option>)}</select></Field>
            <Field label="Race date"><input className="input mono" type="date" value={date} min={dayNumToKey(today + 7)} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Goal time (h:mm:ss)" hint={`Suggested ${fmtTime(suggestedSec)} from your current fitness`}><input className="input mono" placeholder={fmtTime(suggestedSec)} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
            <Field label="Run days per week"><Seg value={days} onChange={setDays} options={[3, 4, 5, 6].map((n) => ({ v: n, label: String(n) }))} /></Field>
            <Field label="Long-run day"><select className="select" value={longDay} onChange={(e) => setLongDay(+e.target.value)}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>
            <Field label="Your baseline"><div className="mono" style={{ fontSize: 13, paddingTop: 8 }}>{fmtDistU(weekly, units, 0)}/wk · VDOT {pred ? pred.vdot.toFixed(1) : '—'}</div></Field>
          </div>
          <div className="row" style={{ marginTop: 20 }}><button className="btn" onClick={create}>Generate plan</button><span className="muted" style={{ fontSize: 13 }}>Takes your last 4 weeks of running into account. You can re-plan any time.</span></div>
        </div>
        {!acts.length && <p className="muted" style={{ marginTop: 12 }}>No history yet — the plan will start from a 15 km/week base. <Link to="/">Import or load the demo first</Link> for a personalised start.</p>}
      </Section>
    );

  // existing plan
  const raceDay = keyToDayNum(plan.goal.date);
  const weeksLeft = Math.max(0, Math.ceil((raceDay - today) / 7));
  const curWeek = plan.weeks.find((w) => keyToDayNum(w.start) <= today && today < keyToDayNum(w.start) + 7) ?? plan.weeks[0];
  const doAdapt = () => {
    if (!last) return;
    const res = adaptPlan({ plan, today, actualRunM: actualRun, acwr: last.acwr, tsb: last.tsb });
    setPlan(res.plan);
    setChanges(res.changes);
    toast('Plan checked against your measured load.');
  };
  const goalPace = plan.goal.distanceM / plan.goal.targetSec;
  return (
    <>
      <Section n={1} total={3} glyph={GLYPH.plan} kicker="Your plan" title={`${plan.goal.label} · ${fmtDayKey(plan.goal.date, { day: 'numeric', month: 'long', year: 'numeric' })}`} actions={<><button className="btn" onClick={doAdapt}>Adapt to my load</button><button className="btn ghost" onClick={() => { if (confirm('Delete this plan?')) setPlan(null); }}>Delete plan</button></>}>
        <div className="grid cols-4">
          <Tile label="Goal" value={fmtTime(plan.goal.targetSec)} delta={`${fmtPace(goalPace, units)} ${paceUnit(units)}`} />
          <Tile label="Weeks to go" value={weeksLeft} delta={`Now: ${curWeek.phase}${curWeek.deload ? ' · deload' : ''}`} />
          <Tile label="Planned VDOT" value={plan.vdot.toFixed(1)} delta="paces from current fitness" />
          <Tile label="This week" value={curWeek.targetKm.toFixed(0)} unit="km target" />
        </div>
        {changes && <div className="card" style={{ marginTop: 16, borderColor: 'var(--arcx-text-muted)' }}><div className="eyebrow">Adaptation</div><ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--arcx-text-muted)', fontSize: 14 }}>{changes.map((c) => <li key={c}>{c}</li>)}</ul></div>}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="eyebrow">Why this plan looks the way it does</div>
          <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: 'var(--arcx-text-muted)', fontSize: 14, lineHeight: 1.7 }}>{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          <Why label="Show the math" formula={'Weekly volume ramps ≤ 8 %/week from your 4-week average to a distance-specific peak (5K 40 · 10K 52 · HM 64 · M 82 km), with every 4th build week cut ~22 %, then a 1–3 week taper.\nPaces use Daniels VDOT %VO₂max (easy 62–74 %, threshold 88 %, interval 98 %). "Adapt" scales the next 7 days by measured ACWR/Form and your 14-day compliance and swaps one hard session for an easy run when load is high.'} />
        </div>
      </Section>

      <Section n={2} total={3} glyph={GLYPH.training} kicker="Phases" title="The shape of the build">
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${plan.weeks.length}, minmax(0,1fr))`, gap: 4, alignItems: 'end', height: 150 }}>
            {plan.weeks.map((w) => {
              const max = Math.max(...plan.weeks.map((x) => x.targetKm));
              let actual = 0;
              for (let d = keyToDayNum(w.start); d < keyToDayNum(w.start) + 7; d++) actual += (actualRun.get(d) ?? 0) / 1000;
              return (
                <div key={w.index} title={`Week ${w.index + 1} · ${w.phase}${w.deload ? ' (deload)' : ''} · ${w.targetKm} km${actual ? ` · done ${actual.toFixed(1)} km` : ''}`} style={{ display: 'grid', alignContent: 'end', height: '100%', gap: 2 }}>
                  <div style={{ height: `${(w.targetKm / max) * 100}%`, background: w.phase === 'race' ? 'var(--c-z6)' : w.phase === 'taper' ? 'var(--c-z4)' : w.phase === 'peak' ? 'var(--c-z3)' : w.phase === 'build' ? 'var(--c-z2)' : 'var(--c-z1)', opacity: w.deload ? 0.55 : 1, borderRadius: '4px 4px 0 0', outline: w.index === curWeek.index ? '2px solid var(--arcx-text)' : undefined, outlineOffset: 2, position: 'relative' }}>
                    {actual > 0 && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.min(100, (actual / w.targetKm) * 100)}%`, background: 'rgba(10,10,10,0.55)', borderRadius: '0 0 0 0' }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="row wrap" style={{ gap: 14, marginTop: 14, fontSize: 12, color: 'var(--arcx-text-muted)' }}>
            {[['Base', 'var(--c-z1)'], ['Build', 'var(--c-z2)'], ['Peak', 'var(--c-z3)'], ['Taper', 'var(--c-z4)'], ['Race', 'var(--c-z6)']].map(([n, c]) => <span key={n} className="row" style={{ gap: 6 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: c, display: 'inline-block' }} />{n}</span>)}
            <span>Darker overlay = distance completed. Outlined = this week.</span>
          </div>
        </div>
      </Section>

      <Section n={3} total={3} glyph={GLYPH.activities} kicker="Week by week" title="Workouts">
        <div className="stack" style={{ gap: 12 }}>
          {plan.weeks.map((w) => {
            const ws = keyToDayNum(w.start);
            const items = plan.workouts.filter((x) => { const d = keyToDayNum(x.date); return d >= ws && d < ws + 7; });
            let actual = 0;
            for (let d = ws; d < ws + 7; d++) actual += actualRun.get(d) ?? 0;
            const open = w.index === curWeek.index;
            return (
              <details key={w.index} className="card" open={open} style={{ padding: 0 }}>
                <summary style={{ listStyle: 'none', cursor: 'pointer', padding: '16px 20px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 12 }}>W{String(w.index + 1).padStart(2, '0')}</span>
                  <span style={{ fontWeight: 500 }}>{fmtDayKey(w.start, { day: 'numeric', month: 'short' })}</span>
                  <Chip tone={w.phase === 'race' ? 'neg' : w.phase === 'taper' ? 'warn' : w.phase === 'peak' ? 'lime' : w.phase === 'build' ? 'pos' : 'mute'}>{w.phase}{w.deload ? ' · deload' : ''}</Chip>
                  <span className="muted mono" style={{ fontSize: 12 }}>{w.targetKm.toFixed(1)} km planned{actual ? ` · ${(actual / 1000).toFixed(1)} done` : ''}</span>
                  <span style={{ flex: 1, minWidth: 80 }}><Meter frac={actual / 1000 / Math.max(1, w.targetKm)} tone={ws + 7 <= today && actual / 1000 < w.targetKm * 0.7 ? 'warn' : 'lime'} /></span>
                </summary>
                <div className="table-wrap" style={{ borderTop: '1px solid var(--arcx-border)' }}>
                  <table className="tbl">
                    <thead><tr><th>Day</th><th>Workout</th><th className="r">Distance</th><th className="r">Pace {paceUnit(units)}</th><th className="r">Load</th><th>Status</th></tr></thead>
                    <tbody>
                      {items.map((it) => {
                        const d = keyToDayNum(it.date);
                        const done = actualRun.get(d) ?? 0;
                        const status = d === today ? (done ? 'done' : 'today') : d < today ? (done >= (it.distance ?? 0) * 0.7 ? 'done' : 'missed') : 'upcoming';
                        return (
                          <tr key={it.id} className={d === today ? 'hl' : ''}>
                            <td className="mono">{fmtDayKey(it.date, { weekday: 'short', day: 'numeric' })}</td>
                            <td style={{ whiteSpace: 'normal', minWidth: 260 }}><Chip tone={KIND_TONE[it.kind]}>{it.kind}</Chip> <b style={{ fontWeight: 500 }}>{it.title}</b><div className="muted" style={{ fontSize: 12, marginTop: 3, maxWidth: 520 }}>{it.detail}</div></td>
                            <td className="r">{fmtDistU(it.distance, units, 1)}</td>
                            <td className="r">{it.paceLo && it.paceHi ? `${fmtPace(it.paceHi, units)}–${fmtPace(it.paceLo, units)}` : '—'}</td>
                            <td className="r">{it.load}</td>
                            <td>{status === 'done' ? <Chip tone="pos">done {fmtDistU(done, units, 1)}</Chip> : status === 'missed' ? <Chip tone="warn">missed</Chip> : status === 'today' ? <Chip tone="lime">today</Chip> : <span className="muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </div>
      </Section>
    </>
  );
}

// ───────────────────────── Course pacing ─────────────────────────
interface Course {
  name: string;
  d: Float32Array;
  alt: Float32Array;
}

function parseCourseGPX(xml: string, name: string): Course | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const pts = Array.from(doc.getElementsByTagNameNS('*', 'trkpt')).concat(Array.from(doc.getElementsByTagNameNS('*', 'rtept')));
  if (pts.length < 5) return null;
  const d: number[] = [0],
    alt: number[] = [];
  let pl = NaN,
    po = NaN;
  pts.forEach((p, i) => {
    const la = parseFloat(p.getAttribute('lat') ?? ''),
      lo = parseFloat(p.getAttribute('lon') ?? '');
    const ele = parseFloat(p.getElementsByTagNameNS('*', 'ele')[0]?.textContent ?? '');
    if (i > 0) d.push(d[d.length - 1] + fastDist(pl, po, la, lo));
    pl = la;
    po = lo;
    alt.push(isFinite(ele) ? ele : NaN);
  });
  return { name, d: Float32Array.from(d), alt: Float32Array.from(alt) };
}

function Pacing() {
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const entries = useEntries();
  const unitM = units === 'metric' ? KM : MI;
  const runs = useMemo(() => entries.filter((e) => e.summary.sport === 'run' && e.summary.distance > 3000 && e.summary.hasElev).slice(0, 60), [entries]);
  const [src, setSrc] = useState<string>('');
  const [custom, setCustom] = useState<Course | null>(null);
  const [target, setTarget] = useState('');
  const [ns, setNs] = useState(2);
  const [credit, setCredit] = useState(profile.gapDownhillCredit);
  const [hover, setHover] = useState<number | null>(null);

  const course: Course | null = useMemo(() => {
    if (custom && src === 'custom') return custom;
    const e = runs.find((r) => r.summary.id === src) ?? runs[0];
    return e ? { name: e.summary.name, d: e.track.d, alt: e.track.alt } : null;
  }, [custom, src, runs]);

  const defaultSec = useMemo(() => {
    if (!course) return 0;
    const total = course.d[course.d.length - 1];
    const e = runs.find((r) => r.summary.id === (src || runs[0]?.summary.id));
    return e && src !== 'custom' ? e.summary.moving * 0.98 : total / 3.4;
  }, [course, runs, src]);
  const targetSec = parseHMS(target) ?? defaultSec;
  const plan: PacingPlan | undefined = useMemo(() => (course ? planPacing({ d: course.d, alt: course.alt }, targetSec, { units, negativeSplit: ns / 100, downhillCredit: credit }) : undefined), [course, targetSec, units, ns, credit]);

  const onFile = async (f?: File) => {
    if (!f) return;
    const c = parseCourseGPX(await f.text(), f.name.replace(/\.gpx$/i, ''));
    if (!c) return toast('That GPX has too few points.', 'warn');
    setCustom(c);
    setSrc('custom');
  };

  if (!runs.length && !custom)
    return (
      <Section n={1} total={1} glyph={GLYPH.routes} title="Choose a course">
        <div className="card lg"><p>Upload a course GPX (a race route, for instance) — or log a run with elevation data to use as the course.</p><div className="row" style={{ marginTop: 14 }}><label className="btn"><input type="file" accept=".gpx" hidden onChange={(e) => void onFile(e.target.files?.[0])} />Upload course GPX</label></div></div>
      </Section>
    );

  const xs = plan ? Float32Array.from(plan.profile.d) : new Float32Array(0);
  const unitFmt = (v: number) => (v / unitM).toFixed(1);
  const exportCsv = () => {
    if (!plan) return;
    const rows = ['split,from,to,distance_m,grade_pct,pace_per_unit,flat_equiv_pace,split_time,cum_time', ...plan.splits.map((s) => [s.idx, (s.from / unitM).toFixed(2), (s.to / unitM).toFixed(2), s.length.toFixed(0), (s.grade * 100).toFixed(1), fmtTime(s.secPerUnit), fmtTime(s.flatSecPerUnit), fmtTime(s.time), fmtTime(s.cumTime)].join(','))];
    download('pacing-plan.csv', rows.join('\n'), 'text/csv');
  };

  return (
    <Section n={1} total={1} glyph={GLYPH.routes} kicker="Pacing planner" title={course?.name ?? 'Course'} lede="Allocates your target time across the course by cost-weighted distance (Σ length × GAP factor), then applies your negative-split preference.">
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="grid cols-4">
          <Field label="Course"><select className="select" value={src || runs[0]?.summary.id || 'custom'} onChange={(e) => setSrc(e.target.value)}>{custom && <option value="custom">Uploaded: {custom.name}</option>}{runs.map((r) => <option key={r.summary.id} value={r.summary.id}>{r.summary.name} · {fmtDistU(r.summary.distance, units, 1)}</option>)}</select></Field>
          <Field label="Target time (h:mm:ss)" hint={`Default ${fmtTime(defaultSec)}`}><input className="input mono" placeholder={fmtTime(defaultSec)} value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          <Field label={`Negative split · ${ns} %`}><input type="range" min={0} max={6} step={0.5} value={ns} onChange={(e) => setNs(+e.target.value)} /></Field>
          <Field label={`Downhill credit · ${Math.round(credit * 100)} %`}><input type="range" min={0} max={1} step={0.05} value={credit} onChange={(e) => setCredit(+e.target.value)} /></Field>
        </div>
        <div className="row" style={{ marginTop: 14 }}><label className="btn ghost sm"><input type="file" accept=".gpx" hidden onChange={(e) => void onFile(e.target.files?.[0])} />Upload a course GPX</label>{plan && <button className="btn ghost sm" onClick={exportCsv}>Export CSV</button>}</div>
      </div>
      {plan && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Tile label="Target" value={fmtTime(plan.totalSec)} delta={`even pace ${fmtTime(plan.evenPaceSec)}${paceUnit(units)}`} />
            <Tile label="Course climb" value={`+${Math.round(plan.totalGain)}`} unit="m" delta={`−${Math.round(plan.totalLoss)} m down`} />
            <Tile label="Effort-equivalent flat pace" value={fmtPace(plan.flatSpeed, units)} unit={paceUnit(units)} explain="The pace you'd hold on a pancake-flat course at the same effort." />
            <Tile label="Fastest / slowest split" value={`${fmtTime(Math.min(...plan.splits.map((s) => s.secPerUnit)))}`} delta={`slowest ${fmtTime(Math.max(...plan.splits.map((s) => s.secPerUnit)))}`} />
          </div>
          <div className="card" style={{ padding: '14px 14px 10px' }}>
            <Panel x={xs} height={100} label={`Elevation · m`} hover={hover} onHover={setHover} yFmt={(v) => String(Math.round(v))} xDomain={[0, xs[xs.length - 1]]} series={[{ id: 'e', name: 'Elevation', color: '#a1a1aa', y: Float32Array.from(plan.profile.elev), area: true }]} />
            <Panel x={xs} height={150} label={`Target pace · ${paceUnit(units)}`} invertY hover={hover} onHover={setHover} showXAxis xDomain={[0, xs[xs.length - 1]]} xTickFmt={unitFmt} yFmt={(v) => fmtTime(v)} series={[{ id: 'p', name: 'Pace', color: 'var(--c-ink)', y: Float32Array.from(plan.profile.paceSec) }]} />
          </div>
          <div className="card pad0" style={{ marginTop: 16 }}>
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Split</th><th className="r">Grade</th><th className="r">Climb</th><th className="r">Target pace</th><th className="r">Flat-equiv.</th><th className="r">Split</th><th className="r">Cumulative</th><th>Note</th></tr></thead>
              <tbody>{plan.splits.map((s) => (
                <tr key={s.idx}>
                  <td className="mono">{s.idx}</td><td className="r">{(s.grade * 100).toFixed(1)} %</td><td className="r">+{Math.round(s.gain)} −{Math.round(s.loss)}</td>
                  <td className="r">{fmtTime(s.secPerUnit)}</td><td className="r muted">{fmtTime(s.flatSecPerUnit)}</td><td className="r">{fmtTime(s.time)}</td><td className="r">{fmtTime(s.cumTime)}</td><td className="muted" style={{ fontSize: 12 }}>{s.note}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
          <Why label="Show the math" formula={'time_split ∝ Σ(length × GAP factor) ÷ v_flat × (1 + ns·(0.5 − x)), renormalised so Σ time = target. GAP factor = Minetti(2002) cost ÷ 3.6 with the downhill benefit scaled by your credit setting (benefit peaks at −9 %, gone by −18 %).'} />
        </>
      )}
    </Section>
  );
}

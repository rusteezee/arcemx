import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { setGear, setGoals, useStore } from '../lib/store/store';
import { useEntries, useTiles, useUnits } from '../lib/hooks';
import { KM, dayNumOf, fmtDistU, fromDist, distUnit } from '../lib/units';
import { describeGoal, periodBounds } from '../lib/analyze/coach';
import { weekStartOf } from '../lib/analyze/load';
import type { Gear, GoalMetric, GoalPeriod, Sport } from '../lib/types';
import { Chip, Empty, Glyph, Meter, PageHead, Section, Seg, GLYPH, NumField } from '../ui/kit';

const METRIC_LABEL: Record<GoalMetric, string> = { distance: 'Distance', time: 'Time', elevation: 'Climbing', count: 'Activities' };

export function GoalsPage() {
  const core = useCore();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const goalsDef = useStore((s) => s.goals);
  const gear = useStore((s) => s.gear);
  const entries = useEntries();
  const tiles = useTiles(entries);
  const { acts, goals, today, daily } = core;

  const [metric, setMetric] = useState<GoalMetric>('distance');
  const [period, setPeriod] = useState<GoalPeriod>('month');
  const [sport, setSport] = useState<Sport | 'all'>('run');
  const [target, setTarget] = useState(100);

  const addGoal = () => {
    const t = metric === 'distance' ? fromDist(target, units) : metric === 'time' ? target * 3600 : metric === 'elevation' ? (units === 'metric' ? target : target * 0.3048) : target;
    setGoals([...goalsDef, { id: 'g' + Date.now().toString(36), metric, period, target: t, sport }]);
  };

  // challenges, computed from your data
  const challenges = useMemo(() => {
    const [ms, me] = periodBounds('month', today, profile.weekStart);
    const [ys, ye] = periodBounds('year', today, profile.weekStart);
    let runMonth = 0, climbYear = 0, climbAll = 0;
    for (const a of acts) {
      const d = dayNumOf(a.start, a.tz);
      if (a.sport === 'run' && d >= ms && d <= me) runMonth += a.distance;
      if (d >= ys && d <= ye) climbYear += a.elevGain;
      climbAll += a.elevGain;
    }
    let streak = 0;
    for (let d = daily.has(today) ? today : today - 1; d > today - 400 && daily.has(d); d--) streak++;
    let weeks = 0;
    const thisWs = weekStartOf(today, profile.weekStart);
    for (let w = 0; w < 52; w++) {
      let n = 0;
      for (let d = thisWs - 7 * (w + 1); d < thisWs - 7 * w; d++) if (daily.has(d)) n++;
      if (n >= 3) weeks++;
      else break;
    }
    return [
      { id: 'c1', title: '100 km in a month', sub: 'Run distance this calendar month', cur: runMonth / 1000, target: 100, unit: 'km', fmt: (v: number) => v.toFixed(1) },
      { id: 'c2', title: 'Everest in a year', sub: 'Climb 8,849 m this calendar year', cur: climbYear, target: 8849, unit: 'm', fmt: (v: number) => Math.round(v).toLocaleString() },
      { id: 'c3', title: '7-day streak', sub: 'Consecutive active days', cur: streak, target: 7, unit: 'days', fmt: (v: number) => String(v) },
      { id: 'c4', title: 'Consistent for 8 weeks', sub: '3+ active days, every week', cur: weeks, target: 8, unit: 'weeks', fmt: (v: number) => String(v) },
      { id: 'c5', title: 'Explorer: 5 new tiles', sub: 'New map squares in the last 30 days', cur: tiles.newLast30, target: 5, unit: 'tiles', fmt: (v: number) => String(v) },
      { id: 'c6', title: 'Climb a Kilimanjaro', sub: 'Lifetime climbing: 5,895 m', cur: climbAll, target: 5895, unit: 'm', fmt: (v: number) => Math.round(v).toLocaleString() },
    ];
  }, [acts, daily, today, profile.weekStart, tiles.newLast30]);

  // gear mileage
  const gearKm = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of acts) if (a.gearId) m.set(a.gearId, (m.get(a.gearId) ?? 0) + a.distance / 1000);
    return m;
  }, [acts]);
  const [newGear, setNewGear] = useState<{ name: string; kind: Gear['kind'] }>({ name: '', kind: 'shoes' });

  return (
    <>
      <PageHead n={1} total={3} tag="Goals" title="Targets that tell the truth." lede="Every goal shows where you are, where you're on pace to finish, and what the remaining days need — not just a progress bar." />

      <Section n={1} total={3} glyph={GLYPH.goals} kicker="Goals" title="Pace to goal">
        {goals.length === 0 ? (
          <Empty glyph="◆" title="No goals yet" body="Add a weekly, monthly or yearly target below." />
        ) : (
          <div className="grid cols-2">
            {goals.map((g) => (
              <div className="card" key={g.goal.id}>
                <div className="row spread" style={{ alignItems: 'flex-start' }}>
                  <div>
                    <div className="eyebrow">{g.goal.period} · {METRIC_LABEL[g.goal.metric]} · {g.goal.sport === 'all' ? 'all sports' : g.goal.sport}</div>
                    <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.035em', marginTop: 6 }}>{describeGoal(g.goal, g.current, units)} <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>/ {describeGoal(g.goal, g.target, units)}</span></div>
                  </div>
                  <Chip tone={g.status === 'done' ? 'pos' : g.status === 'ahead' ? 'lime' : g.status === 'on-track' ? 'mute' : 'warn'}>{g.status}</Chip>
                </div>
                <div style={{ margin: '14px 0 10px' }}><Meter frac={g.frac} tone={g.status === 'behind' ? 'warn' : g.status === 'done' ? 'pos' : 'lime'} /></div>
                <div className="grid cols-3 keep" style={{ gap: 10 }}>
                  <div><div className="eyebrow">Projected</div><div className="mono" style={{ fontSize: 13 }}>{describeGoal(g.goal, g.projected, units)}</div></div>
                  <div><div className="eyebrow">Days left</div><div className="mono" style={{ fontSize: 13 }}>{g.daysLeft}</div></div>
                  <div><div className="eyebrow">Needed / day</div><div className="mono" style={{ fontSize: 13 }}>{g.status === 'done' ? '—' : describeGoal(g.goal, g.perDayNeeded, units)}</div></div>
                </div>
                <div className="row" style={{ marginTop: 12 }}><button className="btn ghost sm" onClick={() => setGoals(goalsDef.filter((x) => x.id !== g.goal.id))}>Remove</button></div>
              </div>
            ))}
          </div>
        )}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><div><h3>Add a goal</h3></div></div>
          <div className="filters">
            <div className="field"><span className="lbl">Period</span><Seg value={period} onChange={setPeriod} options={[{ v: 'week', label: 'Week' }, { v: 'month', label: 'Month' }, { v: 'year', label: 'Year' }]} /></div>
            <div className="field"><label className="lbl">Metric</label><select className="select" value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>{(Object.keys(METRIC_LABEL) as GoalMetric[]).map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}</select></div>
            <div className="field"><label className="lbl">Sport</label><select className="select" value={sport} onChange={(e) => setSport(e.target.value as Sport | 'all')}><option value="all">All</option><option value="run">Run</option><option value="ride">Ride</option><option value="walk">Walk</option><option value="hike">Hike</option></select></div>
            <div className="field"><label className="lbl">Target {metric === 'distance' ? `(${distUnit(units)})` : metric === 'time' ? '(hours)' : metric === 'elevation' ? `(${units === 'metric' ? 'm' : 'ft'})` : ''}</label><div style={{ width: 130 }}><NumField value={target} onCommit={setTarget} min={1} /></div></div>
            <button className="btn" onClick={addGoal}>Add goal</button>
          </div>
        </div>
      </Section>

      <Section n={2} total={3} glyph={GLYPH.today} kicker="Challenges" title="Personal challenges" lede="Built-in, computed from your own data. No sign-up, no leaderboard to game.">
        <div className="grid cols-3">
          {challenges.map((c) => {
            const frac = c.cur / c.target;
            return (
              <div className="card" key={c.id}>
                <div className="row spread"><h3>{c.title}</h3>{frac >= 1 && <Chip tone="pos"><Glyph g="✦" /> done</Chip>}</div>
                <p style={{ fontSize: 13, margin: '4px 0 14px' }}>{c.sub}</p>
                <Meter frac={frac} tone={frac >= 1 ? 'pos' : 'lime'} />
                <div className="mono" style={{ fontSize: 12.5, marginTop: 8 }}>{c.fmt(c.cur)} <span className="muted">/ {c.target.toLocaleString()} {c.unit}</span></div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section n={3} total={3} glyph={GLYPH.performance} kicker="Gear" title="Shoes and bikes" lede="Mileage adds up from the activities you assign, plus any distance already on the gear. A flag appears at 80 % of the retirement distance.">
        {gear.length === 0 ? <Empty glyph="◇" title="No gear yet" body="Add shoes or a bike, then assign them from any activity's Details section." /> : (
          <div className="grid cols-3">
            {gear.map((g) => {
              const km = g.startKm + (gearKm.get(g.id) ?? 0);
              const frac = km / g.retireAtKm;
              return (
                <div className="card" key={g.id} style={{ opacity: g.retired ? 0.55 : 1 }}>
                  <div className="row spread"><h3>{g.name}</h3><Chip tone="mute">{g.kind}</Chip></div>
                  <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em', margin: '10px 0 10px' }}>{(km * (units === 'metric' ? 1 : KM / 1609.344)).toLocaleString(undefined, { maximumFractionDigits: 0 })} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>{distUnit(units)} of {fmtDistU(g.retireAtKm * 1000, units, 0)}</span></div>
                  <Meter frac={frac} tone={frac >= 1 ? 'neg' : frac >= 0.8 ? 'warn' : 'lime'} />
                  <div className="row spread" style={{ marginTop: 12 }}>
                    <span className="muted mono" style={{ fontSize: 11.5 }}>{frac >= 1 ? 'Past retirement' : frac >= 0.8 ? 'Retire soon' : `${Math.round((1 - frac) * 100)}% left`}</span>
                    <div className="row"><button className="btn ghost sm" onClick={() => setGear(gear.map((x) => (x.id === g.id ? { ...x, retired: !x.retired } : x)))}>{g.retired ? 'Reactivate' : 'Retire'}</button><button className="btn ghost sm" onClick={() => setGear(gear.filter((x) => x.id !== g.id))}>Delete</button></div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="filters">
            <div className="field" style={{ minWidth: 220 }}><label className="lbl">Name</label><input className="input" value={newGear.name} placeholder="e.g. Daily trainers" onChange={(e) => setNewGear({ ...newGear, name: e.target.value })} /></div>
            <div className="field"><label className="lbl">Kind</label><select className="select" value={newGear.kind} onChange={(e) => setNewGear({ ...newGear, kind: e.target.value as Gear['kind'] })}><option value="shoes">Shoes</option><option value="bike">Bike</option><option value="other">Other</option></select></div>
            <button className="btn" disabled={!newGear.name.trim()} onClick={() => { setGear([...gear, { id: 'g' + Date.now().toString(36), name: newGear.name.trim(), kind: newGear.kind, retireAtKm: newGear.kind === 'bike' ? 20000 : 800, startKm: 0 }]); setNewGear({ name: '', kind: 'shoes' }); }}>Add gear</button>
          </div>
        </div>
      </Section>
    </>
  );
}

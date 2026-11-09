import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { Link } from '../lib/router';
import { importFiles, loadDemo, upsertCheckIn, useStore } from '../lib/store/store';
import { useEntries, useTiles, useUnits } from '../lib/hooks';
import { dayNumOf, dayNumToKey, dowOfDayNum, fmtDayKey, fmtDistU, fmtDur, fmtTime, fmtSigned, toDist, distUnit, toElev, elevUnit } from '../lib/units';
import { acwrZone } from '../lib/analyze/load';
import { describeGoal } from '../lib/analyze/coach';
import { Chip, Dropzone, GLYPH, InsightCard, Meter, PageHead, Section, Tile, Why } from '../ui/kit';
import { BarChart, Sparkline } from '../ui/charts/charts';
import { ActivityRow, SPORT_COLOR } from '../ui/ActivityRow';
import { MapView } from '../ui/MapView';
import { NumField, Seg } from '../ui/kit';
import type { CheckIn } from '../lib/types';

function Welcome() {
  return (
    <>
      <div className="hero-glow" />
      <PageHead
        tag="Welcome"
        title={
          <>
            Your training.
            <br />
            Your data. Every number shows its math.
          </>
        }
        lede="ArcStride is a local-first training workbench: load, fitness, readiness, race predictions, segments and adaptive plans, computed on this device from your own files. Nothing is uploaded."
        actions={
          <>
            <button className="btn" onClick={() => void loadDemo()}>
              Explore with a demo athlete
            </button>
            <Link to="/record" className="btn ghost">
              Record an activity
            </Link>
          </>
        }
      />
      <Section n={1} total={3} glyph={GLYPH.activities} kicker="Bring your history" title="Import in one drop" lede="Drop .gpx, .tcx or .fit files — or your whole Strava bulk export (the .zip). Names, sport types and gear come across from activities.csv.">
        <Dropzone onFiles={(f) => void importFiles(f)} title="Drop files or a Strava export .zip" hint="GPX · TCX · FIT · .gz · .zip. Duplicates are skipped automatically." />
        <p style={{ fontSize: 13.5, marginTop: 14 }}>
          Strava export: <span className="mono">Settings → My Account → Download or Delete Your Account → Request Your Archive</span>. You'll get an email with a .zip — drop it here unopened.
        </p>
      </Section>
      <Section n={2} total={3} glyph={GLYPH.performance} kicker="What you get" title="More than a feed">
        <div className="grid cols-3">
          {[
            ['Fitness, fatigue, form', 'CTL/ATL/TSB, ACWR, monotony, spike checks and a what-if load simulator.'],
            ['Explainable insights', 'Every insight shows its evidence and formula. No black box.'],
            ['Race predictions', 'Daniels VDOT and a personal Riegel exponent, with ranges.'],
            ['Auto segments', 'ArcStride finds the stretches you repeat and tracks every effort.'],
            ['Adaptive plans', 'Periodised, paced from your VDOT and re-planned from measured load.'],
            ['Privacy by design', 'Local storage, privacy zones on shares, full export any time.'],
          ].map(([t, b]) => (
            <div className="card" key={t}>
              <h3>{t}</h3>
              <p style={{ fontSize: 14, marginTop: 6 }}>{b}</p>
            </div>
          ))}
        </div>
      </Section>
      <Section n={3} total={3} glyph={GLYPH.record} kicker="Or start fresh" title="No history yet?">
        <div className="card lg row spread wrap">
          <p style={{ maxWidth: 560 }}>Record with your phone's GPS right in the browser, or load a synthetic demo athlete (a year of runs and rides, clearly labelled as demo data) to explore every screen.</p>
          <div className="row wrap">
            <Link to="/record" className="btn ghost">Record</Link>
            <button className="btn" onClick={() => void loadDemo()}>Load demo athlete</button>
          </div>
        </div>
      </Section>
    </>
  );
}

function CheckInCard() {
  const { todayKey } = useCore();
  const existing = useStore((s) => s.checkins.find((c) => c.date === todayKey));
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<CheckIn>(() => existing ?? { date: todayKey });
  const save = () => {
    upsertCheckIn({ ...c, date: todayKey });
    setOpen(false);
  };
  if (!open)
    return (
      <div className="row spread wrap" style={{ marginTop: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>{existing ? 'Check-in logged today — it feeds the score above.' : 'Add a 20-second check-in to personalise readiness.'}</span>
        <button className="btn ghost sm" onClick={() => setOpen(true)}>{existing ? 'Edit check-in' : 'Check in'}</button>
      </div>
    );
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div className="grid cols-3 keep">
        <div className="field"><label className="lbl">Resting HR</label><NumField value={c.restHR ?? 0} onCommit={(v) => setC({ ...c, restHR: v || undefined })} suffix="bpm" /></div>
        <div className="field"><label className="lbl">HRV rMSSD</label><NumField value={c.hrv ?? 0} onCommit={(v) => setC({ ...c, hrv: v || undefined })} suffix="ms" /></div>
        <div className="field"><label className="lbl">Sleep</label><NumField value={c.sleepH ?? 0} step={0.1} onCommit={(v) => setC({ ...c, sleepH: v || undefined })} suffix="h" /></div>
      </div>
      <div className="row wrap" style={{ gap: 20 }}>
        <div className="field"><span className="lbl">Soreness (5 = very)</span><Seg value={c.soreness ?? 0} onChange={(v) => setC({ ...c, soreness: v })} options={[1, 2, 3, 4, 5].map((n) => ({ v: n, label: String(n) }))} /></div>
        <div className="field"><span className="lbl">Mood (5 = great)</span><Seg value={c.mood ?? 0} onChange={(v) => setC({ ...c, mood: v })} options={[1, 2, 3, 4, 5].map((n) => ({ v: n, label: String(n) }))} /></div>
      </div>
      <div className="row"><button className="btn sm" onClick={save}>Save check-in</button><button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

export function Dashboard() {
  const core = useCore();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const entries = useEntries();
  const tiles = useTiles(entries);
  const { acts, last, ready, pmc, today, loads, insights, goals, pred } = core;

  const wk = useMemo(() => {
    const ws = today - 6; // rolling seven days, so the chart is never empty on a Monday
    const sum = (from: number, to: number) => {
      let dist = 0, time = 0, elev = 0, load = 0, n = 0;
      for (const a of acts) {
        const d = dayNumOf(a.start, a.tz);
        if (d < from || d > to) continue;
        dist += a.distance; time += a.moving; elev += a.elevGain; load += loads.get(a.id)?.load ?? 0; n++;
      }
      return { dist, time, elev, load, n };
    };
    const names = Array.from({ length: 7 }, (_, i) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dowOfDayNum(ws + i)]);
    const sports = ['run', 'ride', 'walk', 'hike', 'other'] as const;
    const stacks = sports.map((sp) => ({
      id: sp,
      name: { run: 'Run', ride: 'Ride', walk: 'Walk', hike: 'Hike', other: 'Other' }[sp],
      color: SPORT_COLOR[sp],
      values: names.map((_, i) => acts.filter((a) => a.sport === sp && dayNumOf(a.start, a.tz) === ws + i).reduce((s, a) => s + toDist(a.distance, units), 0)),
    })).filter((s) => s.values.some((v) => v > 0));
    return { ws, cur: sum(ws, ws + 6), prev: sum(ws - 7, ws - 1), names, stacks, heads: names.map((_, i) => `${names[i]} ${fmtDayKey(dayNumToKey(ws + i))}`) };
  }, [acts, loads, today, units]);

  if (!acts.length) return <Welcome />;

  const recent = acts.slice(0, 6);
  const ctlSpark = pmc.slice(-42).map((p) => p.ctl);
  const atlSpark = pmc.slice(-42).map((p) => p.atl);
  const z = last ? acwrZone(last.acwr) : 'sweet';
  const zoneTone = { under: 'warn', sweet: 'pos', caution: 'warn', danger: 'neg' }[z] as 'warn' | 'pos' | 'neg';
  const zoneLabel = { under: 'under-training', sweet: 'sweet spot', caution: 'caution', danger: 'danger' }[z];
  const dDist = wk.cur.dist - wk.prev.dist;
  const dateLabel = new Date(core.now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const ramp = last ? last.ctl - (pmc[pmc.length - 8]?.ctl ?? last.ctl) : 0;

  return (
    <>
      <div className="hero-glow" />
      <div className="grid cols-main" style={{ alignItems: 'end', paddingTop: 24 }}>
        <PageHead
          n={1}
          total={6}
          tag={`Today · ${dateLabel}`}
          title={<>{ready.label}.</>}
          lede={ready.advice}
          actions={
            <>
              <Link to="/record" className="btn"><span className="dot" /> Record</Link>
              <Link to="/plan" className="btn ghost">Today's plan</Link>
            </>
          }
        />
        <div className="card lg" aria-label="Readiness">
          <div className="row spread" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="eyebrow">Readiness · model estimate</div>
              <div style={{ fontSize: 64, fontWeight: 600, letterSpacing: '-0.045em', lineHeight: 1, marginTop: 8 }}>
                {ready.score}
                <span className="muted" style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0, fontFamily: 'var(--font-mono)' }}> /100</span>
              </div>
            </div>
            <Chip tone={ready.score >= 75 ? 'pos' : ready.score >= 50 ? 'lime' : ready.score >= 30 ? 'warn' : 'neg'}>{ready.label}</Chip>
          </div>
          <div style={{ marginTop: 14 }}>
            <Meter frac={ready.score / 100} tone={ready.score >= 75 ? 'pos' : ready.score >= 50 ? 'lime' : ready.score >= 30 ? 'warn' : 'neg'} />
          </div>
          <Why
            label="What moved this score"
            evidence={ready.parts.map((p) => ({ label: p.label, value: `${fmtSigned(p.delta)} · ${p.note}` }))}
            formula="Base = 68 + 1.4 × Form (clamped 10–95). Penalty if ACWR > 1.3. Check-in values are compared with your own 30-day median. A transparent heuristic — not a medical device."
          />
          <CheckInCard />
        </div>
      </div>

      {last && (
        <div className="grid cols-4" style={{ marginTop: 32 }}>
          <Tile label="Fitness · CTL" value={last.ctl.toFixed(0)} delta={`${fmtSigned(ramp, 1)} in 7 days`} dir={ramp > 0 ? 'up' : ramp < 0 ? 'down' : ''} hint="42-day exponentially weighted training load">
            <Sparkline values={ctlSpark} color="var(--c-fit)" accent="var(--c-fit)" />
          </Tile>
          <Tile label="Fatigue · ATL" value={last.atl.toFixed(0)} delta="7-day weighted load" hint="7-day exponentially weighted training load">
            <Sparkline values={atlSpark} color="var(--c-hr)" accent="var(--c-hr)" />
          </Tile>
          <Tile label="Form · TSB" value={fmtSigned(last.tsb, 0)} delta={last.tsb < -25 ? 'deep fatigue' : last.tsb < -10 ? 'productive load' : last.tsb < 5 ? 'neutral' : last.tsb <= 20 ? 'fresh' : 'very fresh'} dir={last.tsb >= 5 ? 'up' : last.tsb < -25 ? 'down' : ''} explain="Fitness minus fatigue (yesterday's values)." />
          <Tile label="Load ratio · ACWR" value={last.acwr.toFixed(2)} explain="7-day vs 28-day weighted load. 0.8–1.3 is the sweet spot.">
            <div><Chip tone={zoneTone}>{zoneLabel}</Chip></div>
          </Tile>
        </div>
      )}

      <Section n={2} total={6} glyph={GLYPH.training} kicker="Rolling 7 days" title="The last seven days" actions={<Link to="/training" className="btn ghost sm">Open Training</Link>}>
        <div className="grid cols-main">
          <div className="card">
            <BarChart title="Distance by day" sub={`${distUnit(units)} per day, by sport`} cats={wk.names} heads={wk.heads} stacks={wk.stacks.length ? wk.stacks : [{ id: 'none', name: 'Distance', color: '#fafafa', values: wk.names.map(() => 0) }]} height={210} yFmt={(v) => v.toFixed(v < 10 ? 1 : 0)} valFmt={(v) => `${v.toFixed(1)} ${distUnit(units)}`} />
          </div>
          <div className="grid cols-2 keep" style={{ alignContent: 'start' }}>
            <Tile label="Distance" value={toDist(wk.cur.dist, units).toFixed(1)} unit={distUnit(units)} delta={`${fmtSigned(toDist(dDist, units), 1)} vs previous 7 days`} dir={dDist > 0 ? 'up' : dDist < 0 ? 'down' : ''} />
            <Tile label="Moving time" value={fmtDur(wk.cur.time)} delta={`${wk.cur.n} activities`} />
            <Tile label="Climbing" value={Math.round(toElev(wk.cur.elev, units)).toLocaleString()} unit={elevUnit(units)} delta={`${Math.round(toElev(wk.prev.elev, units)).toLocaleString()} previous 7 days`} />
            <Tile label="Training load" value={Math.round(wk.cur.load)} delta={`${Math.round(wk.prev.load)} previous 7 days`} dir={wk.cur.load > wk.prev.load ? 'up' : ''} />
            {goals.slice(0, 2).map((g) => (
              <div className="card" key={g.goal.id} style={{ gridColumn: '1 / -1', padding: 16 }}>
                <div className="row spread" style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 13.5 }}>{g.goal.period[0].toUpperCase() + g.goal.period.slice(1)} · {g.goal.sport === 'all' ? 'all sports' : g.goal.sport}</span>
                  <span className="mono" style={{ fontSize: 12 }}>{describeGoal(g.goal, g.current, units)} / {describeGoal(g.goal, g.target, units)}</span>
                </div>
                <Meter frac={g.frac} tone={g.status === 'behind' ? 'warn' : g.status === 'done' ? 'pos' : 'lime'} />
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section n={3} total={6} glyph={GLYPH.today} kicker="Coach insights" title="What the data says" lede="Rule-based and repeatable — each card carries its evidence and formula." actions={<Link to="/training#insights" className="btn ghost sm">All insights</Link>}>
        {insights.length ? <div className="grid cols-2">{insights.slice(0, 4).map((i) => <InsightCard key={i.id} i={i} />)}</div> : <div className="card"><p>Insights appear once there are a few weeks of data.</p></div>}
      </Section>

      <Section n={4} total={6} glyph={GLYPH.activities} kicker="Latest" title="Recent activities" actions={<Link to="/activities" className="btn ghost sm">All activities</Link>}>
        <div className="list">{recent.map((a) => <ActivityRow key={a.id} a={a} loads={loads.get(a.id)} units={units} />)}</div>
      </Section>

      <Section n={5} total={6} glyph={GLYPH.routes} kicker="Where you've been" title="Your map, private by default" lede="Every route you've logged, blended. Explorer tiles count the ~2.4 km squares you've visited." actions={<Link to="/routes" className="btn ghost sm">Open Routes</Link>}>
        <div className="grid cols-main">
          <MapView tracks={entries.map((e) => ({ id: e.summary.id, lat: e.track.lat, lon: e.track.lon }))} mode="heat" height={300} interactive={false} fitKey={String(entries.length)} basemap={profile.mapTiles} ariaLabel="Heatmap of all activities" />
          <div className="grid cols-2 keep" style={{ alignContent: 'start' }}>
            <Tile label="Explorer tiles" value={tiles.count} explain="Zoom-14 squares visited." />
            <Tile label="Largest square" value={`${tiles.maxSquare}×${tiles.maxSquare}`} explain="Biggest filled block." />
            <Tile label="New, 30 days" value={tiles.newLast30} />
            <Tile label="Tracked" value={entries.length} explain="Activities with GPS." />
          </div>
        </div>
      </Section>

      {pred && (
        <Section n={6} total={6} glyph={GLYPH.performance} kicker="Race outlook" title="If you raced today" lede={`VDOT ${pred.vdot.toFixed(1)} from your ${pred.basis.label} effort — confidence ${pred.confidence}.`} actions={<Link to="/performance" className="btn ghost sm">Open Performance</Link>}>
          <div className="grid cols-4">
            {pred.races.map((r) => (
              <Tile key={r.label} label={r.label} value={fmtTime(r.mid)} delta={`${fmtTime(r.low)} – ${fmtTime(r.high)}`} explain={`${fmtDistU(r.distM, units, 1)}`} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

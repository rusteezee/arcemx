import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { importFiles, loadDemo, useStore } from '../lib/store/store';
import { useUnits } from '../lib/hooks';
import { KM, MI, dayNumOf, fmtDur, fmtElev, toDist, distUnit } from '../lib/units';
import type { Sport } from '../lib/types';
import { Dropzone, Empty, PageHead, Section, Tile, GLYPH, Tabs } from '../ui/kit';
import { ActivityRow } from '../ui/ActivityRow';

type SortKey = 'date' | 'distance' | 'time' | 'pace' | 'load' | 'elev';
const PAGE = 40;

export function Activities() {
  const { acts, loads, today } = useCore();
  const units = useUnits();
  const gear = useStore((s) => s.gear);
  const [q, setQ] = useState('');
  const [sport, setSport] = useState<Sport | 'all'>('all');
  const [range, setRange] = useState<'30' | '90' | '365' | 'all'>('all');
  const [adv, setAdv] = useState(false);
  const [dMin, setDMin] = useState('');
  const [dMax, setDMax] = useState('');
  const [eMin, setEMin] = useState('');
  const [hrMin, setHrMin] = useState('');
  const [gearId, setGearId] = useState('');
  const [hasPower, setHasPower] = useState(false);
  const [source, setSource] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [showImport, setShowImport] = useState(false);

  const unitM = units === 'metric' ? KM : MI;
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const num = (s: string) => (s.trim() === '' ? NaN : parseFloat(s));
    const dmin = num(dMin) * unitM,
      dmax = num(dMax) * unitM,
      emin = num(eMin),
      hmin = num(hrMin);
    let out = acts.filter((a) => {
      if (sport !== 'all' && a.sport !== sport) return false;
      if (range !== 'all' && dayNumOf(a.start, a.tz) < today - parseInt(range)) return false;
      if (ql && !(a.name.toLowerCase().includes(ql) || (a.notes ?? '').toLowerCase().includes(ql))) return false;
      if (dmin === dmin && a.distance < dmin) return false;
      if (dmax === dmax && a.distance > dmax) return false;
      if (emin === emin && a.elevGain < emin) return false;
      if (hmin === hmin && !(a.avgHR && a.avgHR >= hmin)) return false;
      if (gearId && a.gearId !== gearId) return false;
      if (hasPower && !a.hasPower) return false;
      if (source && a.source !== source) return false;
      return true;
    });
    const key: Record<SortKey, (a: (typeof acts)[number]) => number> = {
      date: (a) => a.start,
      distance: (a) => a.distance,
      time: (a) => a.moving,
      pace: (a) => a.avgSpeed,
      load: (a) => loads.get(a.id)?.load ?? 0,
      elev: (a) => a.elevGain,
    };
    out = [...out].sort((a, b) => (desc ? key[sort](b) - key[sort](a) : key[sort](a) - key[sort](b)));
    return out;
  }, [acts, loads, q, sport, range, dMin, dMax, eMin, hrMin, gearId, hasPower, source, sort, desc, today, unitM]);

  const totals = useMemo(() => {
    let dist = 0, time = 0, elev = 0, load = 0;
    for (const a of list) {
      dist += a.distance;
      time += a.moving;
      elev += a.elevGain;
      load += loads.get(a.id)?.load ?? 0;
    }
    return { dist, time, elev, load };
  }, [list, loads]);

  if (!acts.length)
    return (
      <>
        <PageHead tag="Activities" title="Your library is empty." lede="Import files or a Strava export, or explore with a demo athlete." />
        <Section n={1} total={1} glyph={GLYPH.activities} title="Bring your history">
          <Dropzone onFiles={(f) => void importFiles(f)} title="Drop .gpx, .tcx, .fit or a Strava .zip" hint="Everything is processed locally." />
          <div className="row" style={{ marginTop: 16 }}><button className="btn ghost" onClick={() => void loadDemo()}>Load demo athlete</button></div>
        </Section>
      </>
    );

  const pageItems = list.slice(0, page * PAGE);
  const reset = () => {
    setQ(''); setSport('all'); setRange('all'); setDMin(''); setDMax(''); setEMin(''); setHrMin(''); setGearId(''); setHasPower(false); setSource('');
  };

  return (
    <>
      <PageHead
        n={1}
        total={2}
        tag="Activities"
        title={<>{acts.length.toLocaleString()} activities.</>}
        lede="Search and filter everything, with no paywall on advanced filters."
        actions={<button className="btn ghost" onClick={() => setShowImport((v) => !v)}>{showImport ? 'Hide import' : 'Import files'}</button>}
      />
      {showImport && (
        <div style={{ marginTop: 20 }}>
          <Dropzone onFiles={(f) => void importFiles(f)} title="Drop .gpx, .tcx, .fit or a Strava .zip" hint="Duplicates are skipped by start time + distance." />
        </div>
      )}

      <Section n={1} total={2} glyph={GLYPH.activities} kicker="Search" title="Find anything" actions={<button className="btn ghost sm" onClick={reset}>Reset filters</button>}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="filters">
            <div className="field" style={{ minWidth: 220, flex: '1 1 220px' }}><label className="lbl">Search</label><input className="input" placeholder="Name or notes…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
            <div className="field"><label className="lbl">Sport</label>
              <select className="select" value={sport} onChange={(e) => { setSport(e.target.value as Sport | 'all'); setPage(1); }}>
                <option value="all">All</option><option value="run">Run</option><option value="ride">Ride</option><option value="walk">Walk</option><option value="hike">Hike</option><option value="other">Other</option>
              </select>
            </div>
            <div className="field"><span className="lbl">Period</span>
              <Tabs value={range} onChange={(v) => { setRange(v); setPage(1); }} options={[{ v: '30', label: '30 d' }, { v: '90', label: '90 d' }, { v: '365', label: '1 y' }, { v: 'all', label: 'All' }]} />
            </div>
            <button className="btn ghost sm" onClick={() => setAdv((v) => !v)} aria-expanded={adv}>{adv ? '– Fewer filters' : '+ Advanced'}</button>
          </div>
          {adv && (
            <div className="filters card" style={{ padding: 16 }}>
              <div className="field"><label className="lbl">Distance ≥ ({distUnit(units)})</label><input className="input mono" style={{ width: 110 }} inputMode="decimal" value={dMin} onChange={(e) => setDMin(e.target.value)} /></div>
              <div className="field"><label className="lbl">Distance ≤ ({distUnit(units)})</label><input className="input mono" style={{ width: 110 }} inputMode="decimal" value={dMax} onChange={(e) => setDMax(e.target.value)} /></div>
              <div className="field"><label className="lbl">Climb ≥ (m)</label><input className="input mono" style={{ width: 110 }} inputMode="decimal" value={eMin} onChange={(e) => setEMin(e.target.value)} /></div>
              <div className="field"><label className="lbl">Avg HR ≥</label><input className="input mono" style={{ width: 100 }} inputMode="decimal" value={hrMin} onChange={(e) => setHrMin(e.target.value)} /></div>
              <div className="field"><label className="lbl">Gear</label>
                <select className="select" value={gearId} onChange={(e) => setGearId(e.target.value)}><option value="">Any</option>{gear.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              </div>
              <div className="field"><label className="lbl">Source</label>
                <select className="select" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Any</option><option value="file">File</option><option value="strava-archive">Strava export</option><option value="recorded">Recorded</option><option value="demo">Demo</option></select>
              </div>
              <label className="row muted" style={{ gap: 8, fontSize: 13, alignSelf: 'center' }}><input type="checkbox" checked={hasPower} onChange={(e) => setHasPower(e.target.checked)} /> Has power</label>
            </div>
          )}
        </div>
      </Section>

      <Section n={2} total={2} glyph={GLYPH.training} kicker={`${list.length.toLocaleString()} results`} title="Results"
        actions={
          <div className="row wrap">
            <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
              <option value="date">Date</option><option value="distance">Distance</option><option value="time">Time</option><option value="pace">Pace / speed</option><option value="load">Load</option><option value="elev">Climb</option>
            </select>
            <button className="btn ghost sm" onClick={() => setDesc((d) => !d)}>{desc ? '↓ Desc' : '↑ Asc'}</button>
          </div>
        }
      >
        <div className="grid cols-4 keep" style={{ marginBottom: 16 }}>
          <Tile label="Distance" value={toDist(totals.dist, units).toLocaleString(undefined, { maximumFractionDigits: 0 })} unit={distUnit(units)} />
          <Tile label="Moving time" value={fmtDur(totals.time)} />
          <Tile label="Climbing" value={fmtElev(totals.elev, units)} />
          <Tile label="Training load" value={Math.round(totals.load).toLocaleString()} />
        </div>
        {list.length === 0 ? (
          <Empty glyph="◌" title="Nothing matches" body="Loosen a filter or reset them all."><button className="btn" onClick={reset}>Reset filters</button></Empty>
        ) : (
          <>
            <div className="list">{pageItems.map((a) => <ActivityRow key={a.id} a={a} loads={loads.get(a.id)} units={units} />)}</div>
            {pageItems.length < list.length && (
              <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
                <button className="btn ghost" onClick={() => setPage((p) => p + 1)}>Show {Math.min(PAGE, list.length - pageItems.length)} more of {list.length - pageItems.length}</button>
              </div>
            )}
          </>
        )}
      </Section>
    </>
  );
}

import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { Link, navigate } from '../lib/router';
import { setPrefs, setSegments, toast, useStore } from '../lib/store/store';
import { useEntries, useTiles, useUnits } from '../lib/hooks';
import { dayNumOf, fmtDate, fmtDayKey, dayNumToKey, fmtDistU, fmtElev, fmtPace, fmtSpeed, fmtTime, isPaceSport, paceUnit, speedUnit } from '../lib/units';
import { computeEfforts, discoverSegments, unpackPath } from '../lib/analyze/segments';
import { groupRoutes } from '../lib/analyze/routes';
import type { Segment, SegmentEffort, Sport } from '../lib/types';
import { Chip, Empty, PageHead, Section, Seg, Tabs, Tile, GLYPH } from '../ui/kit';
import { MapView } from '../ui/MapView';
import { RouteThumb, SPORT_COLOR } from '../ui/ActivityRow';
import { LineChart } from '../ui/charts/charts';

export function RoutesPage({ tab }: { tab: string }) {
  const t = (['heatmap', 'segments', 'matched'] as const).includes(tab as never) ? (tab as 'heatmap' | 'segments' | 'matched') : 'heatmap';
  const entries = useEntries();
  return (
    <>
      <PageHead
        tag="Routes"
        title="Where you go, and how you do there."
        lede="A private heatmap, segments found automatically from your own repeats, and every run of a route side by side. All computed locally from your tracks."
        actions={<Tabs value={t} onChange={(v) => navigate(`/routes?tab=${v}`)} options={[{ v: 'heatmap', label: 'Heatmap', glyph: GLYPH.routes }, { v: 'segments', label: 'Segments', glyph: GLYPH.performance }, { v: 'matched', label: 'Matched routes', glyph: GLYPH.activities }]} />}
      />
      {!entries.length ? <div style={{ marginTop: 40 }}><Empty glyph="◷" title="No GPS tracks yet" body="Import activities with GPS (or load the demo athlete) to see your map."><Link to="/" className="btn">Go to Today</Link></Empty></div> : t === 'heatmap' ? <Heatmap /> : t === 'segments' ? <Segments /> : <Matched />}
    </>
  );
}

// ───────────────────────── Heatmap & explorer ─────────────────────────
function Heatmap() {
  const entries = useEntries();
  const profile = useStore((s) => s.profile);
  const { now } = useCore();
  const [sport, setSport] = useState<Sport | 'all'>('all');
  const [year, setYear] = useState<'all' | string>('all');
  const [tod, setTod] = useState<'all' | 'morning' | 'day' | 'evening'>('all');
  const [wk, setWk] = useState<'all' | 'weekday' | 'weekend'>('all');
  const [showTiles, setShowTiles] = useState(true);
  const years = useMemo(() => [...new Set(entries.map((e) => new Date(e.summary.start + e.summary.tz * 60000).getUTCFullYear()))].sort((a, b) => b - a), [entries]);
  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        const s = e.summary;
        if (sport !== 'all' && s.sport !== sport) return false;
        const d = new Date(s.start + s.tz * 60000);
        if (year !== 'all' && String(d.getUTCFullYear()) !== year) return false;
        const h = d.getUTCHours();
        if (tod === 'morning' && !(h >= 4 && h < 10)) return false;
        if (tod === 'day' && !(h >= 10 && h < 17)) return false;
        if (tod === 'evening' && !(h >= 17 || h < 4)) return false;
        const dow = d.getUTCDay();
        if (wk === 'weekday' && (dow === 0 || dow === 6)) return false;
        if (wk === 'weekend' && !(dow === 0 || dow === 6)) return false;
        return true;
      }),
    [entries, sport, year, tod, wk],
  );
  const tiles = useTiles(filtered);
  const cells = useMemo(() => (showTiles ? [...tiles.tiles.values()].map((t) => ({ x: t.x, y: t.y, fresh: t.first >= now - 30 * 86400000 })) : []), [tiles, showTiles, now]);
  return (
    <Section n={1} total={1} glyph={GLYPH.routes} kicker="Heatmap" title="Everywhere you've been" lede="Brighter lines are routes you repeat. Filter by sport, year, time of day or weekday — all free, and none of it leaves this device.">
      <div className="filters" style={{ marginBottom: 14 }}>
        <div className="field"><label className="lbl">Sport</label><select className="select" value={sport} onChange={(e) => setSport(e.target.value as Sport | 'all')}><option value="all">All</option><option value="run">Run</option><option value="ride">Ride</option><option value="walk">Walk</option><option value="hike">Hike</option></select></div>
        <div className="field"><label className="lbl">Year</label><select className="select" value={year} onChange={(e) => setYear(e.target.value)}><option value="all">All</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
        <div className="field"><span className="lbl">Time of day</span><Seg value={tod} onChange={setTod} options={[{ v: 'all', label: 'Any' }, { v: 'morning', label: 'Morning' }, { v: 'day', label: 'Day' }, { v: 'evening', label: 'Evening' }]} /></div>
        <div className="field"><span className="lbl">Days</span><Seg value={wk} onChange={setWk} options={[{ v: 'all', label: 'All' }, { v: 'weekday', label: 'Weekdays' }, { v: 'weekend', label: 'Weekends' }]} /></div>
        <label className="row muted" style={{ gap: 8, fontSize: 13, alignSelf: 'flex-end', paddingBottom: 8 }}><input type="checkbox" checked={showTiles} onChange={(e) => setShowTiles(e.target.checked)} /> Explorer tiles</label>
      </div>
      <div className="grid cols-main" style={{ alignItems: 'start' }}>
        <MapView tracks={filtered.map((e) => ({ id: e.summary.id, lat: e.track.lat, lon: e.track.lon }))} mode="heat" height={560} fitKey={`${sport}${year}${tod}${wk}${entries.length}`} cells={cells} basemap={profile.mapTiles} ariaLabel="Heatmap" />
        <div className="stack">
          <Tile label="Activities shown" value={filtered.length} />
          <Tile label="Explorer tiles" value={tiles.count} explain="Zoom-14 map squares (≈ 2.4 km) you've entered." />
          <Tile label="Largest square" value={`${tiles.maxSquare} × ${tiles.maxSquare}`} explain="The biggest completely filled block of tiles." />
          <Tile label="New in 30 days" value={tiles.newLast30} explain="Brighter squares on the map." />
          <div className="card"><p style={{ fontSize: 13 }}>Map tiles are {profile.mapTiles === 'off' ? <b>off</b> : <b>on (CARTO)</b>}. With tiles off, no request ever reveals where you train. Change it in Settings.</p></div>
        </div>
      </div>
    </Section>
  );
}

// ───────────────────────── Segments ─────────────────────────
function Segments() {
  const entries = useEntries();
  const segments = useStore((s) => s.segments);
  const dismissed = useStore((s) => s.prefs.dismissedSegments);
  const profile = useStore((s) => s.profile);
  const units = profile.units;
  const [selId, setSelId] = useState<string | undefined>();

  const suggestions = useMemo(() => {
    const out: Segment[] = [];
    for (const sport of ['run', 'ride'] as Sport[]) out.push(...discoverSegments(entries, { sport }));
    return out.filter((s) => !dismissed.includes(s.id) && !segments.some((m) => m.id === s.id));
  }, [entries, dismissed, segments]);
  const all = useMemo(() => [...segments, ...suggestions], [segments, suggestions]);
  const efforts = useMemo(() => computeEfforts(all, entries), [all, entries]);
  const sel = segments.find((s) => s.id === selId) ?? segments[0];

  const add = (s: Segment) => {
    setSegments([...segments, { ...s, auto: true }]);
    setSelId(s.id);
    toast(`Added “${s.name}”.`);
  };
  const rename = (id: string, name: string) => setSegments(segments.map((s) => (s.id === id ? { ...s, name } : s)));
  const remove = (id: string) => {
    if (!confirm('Remove this segment? Your activities are not affected.')) return;
    setSegments(segments.filter((s) => s.id !== id));
  };

  return (
    <>
      <Section n={1} total={2} glyph={GLYPH.performance} kicker="Suggested" title="Stretches you repeat" lede="ArcStride counts how many different activities pass through each ~25 m cell of your tracks, then cuts out the busiest stretches. You can also draw your own: on any activity, drag across a chart and press Create segment.">
        {suggestions.length === 0 ? (
          <div className="card"><p>{entries.length < 8 ? 'Auto-discovery needs at least a handful of activities on the same roads.' : 'No new repeat stretches found — you\'ve accepted or dismissed them all.'}</p></div>
        ) : (
          <div className="grid cols-3">
            {suggestions.slice(0, 9).map((s) => {
              const e = efforts.get(s.id) ?? [];
              const best = e.length ? Math.min(...e.map((x) => x.time)) : undefined;
              return (
                <div className="card" key={s.id}>
                  <div className="row spread" style={{ alignItems: 'flex-start' }}>
                    <div><h3>{s.name}</h3><div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>{s.sport} · {fmtDistU(s.length, units, 2)} · +{fmtElev(s.elevGain, units).replace(/^/, '')}</div></div>
                    <RouteThumb poly={s.path} color={SPORT_COLOR[s.sport]} w={84} h={64} />
                  </div>
                  <div className="row wrap" style={{ gap: 6, margin: '12px 0' }}>
                    <Chip tone="lime">{e.length} efforts</Chip>
                    {best != null && <Chip tone="mute">best {fmtTime(best)}</Chip>}
                  </div>
                  <div className="row"><button className="btn sm" onClick={() => add(s)}>Track it</button><button className="btn ghost sm" onClick={() => setPrefs({ dismissedSegments: [...dismissed, s.id] })}>Dismiss</button></div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section n={2} total={2} glyph={GLYPH.activities} kicker="Tracked" title="My segments" lede="Every effort across your history, ranked against yourself.">
        {segments.length === 0 ? (
          <Empty glyph="◆" title="No tracked segments yet" body="Accept a suggestion above, or create one from any activity."><Link to="/activities" className="btn ghost">Browse activities</Link></Empty>
        ) : (
          <div className="grid cols-main" style={{ alignItems: 'start' }}>
            <div className="list">
              {segments.map((s) => {
                const e = efforts.get(s.id) ?? [];
                const best = e.length ? Math.min(...e.map((x) => x.time)) : undefined;
                const lastE = e[e.length - 1];
                const active = sel?.id === s.id;
                return (
                  <button key={s.id} className="row-card" style={{ gridTemplateColumns: '84px minmax(0,1fr) auto', textAlign: 'left', borderColor: active ? 'var(--arcx-text-muted)' : undefined }} onClick={() => setSelId(s.id)} aria-pressed={active}>
                    <RouteThumb poly={s.path} color={SPORT_COLOR[s.sport]} w={84} h={64} />
                    <div style={{ minWidth: 0 }}>
                      <div className="name">{s.name}</div>
                      <div className="meta">{s.sport} · {fmtDistU(s.length, units, 2)} · {e.length} efforts</div>
                    </div>
                    <div className="stat"><div className="v">{best != null ? fmtTime(best) : '—'}</div><div className="k">best</div>{lastE && best != null && <div className="muted mono" style={{ fontSize: 10.5 }}>last {fmtTime(lastE.time)}</div>}</div>
                  </button>
                );
              })}
            </div>
            {sel && <SegmentDetail seg={sel} efforts={efforts.get(sel.id) ?? []} onRename={(n) => rename(sel.id, n)} onRemove={() => remove(sel.id)} entries={entries} />}
          </div>
        )}
      </Section>
    </>
  );
}

function SegmentDetail({ seg, efforts, onRename, onRemove, entries }: { seg: Segment; efforts: SegmentEffort[]; onRename: (n: string) => void; onRemove: () => void; entries: ReturnType<typeof useEntries> }) {
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const p = useMemo(() => unpackPath(seg.path), [seg.path]);
  const sorted = useMemo(() => [...efforts].sort((a, b) => a.time - b.time), [efforts]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.summary.id, e.summary])), [entries]);
  const pace = isPaceSport(seg.sport);
  const trendX = Float32Array.from(efforts.map((e) => dayNumOf(e.start, 330)));
  return (
    <div className="stack">
      <MapView tracks={[{ id: seg.id, lat: p.lat, lon: p.lon }]} height={260} fitKey={seg.id} basemap={profile.mapTiles} markers={[{ lat: p.lat[0], lon: p.lon[0], color: '#4ade80' }, { lat: p.lat[p.lat.length - 1], lon: p.lon[p.lon.length - 1], color: '#f87171' }]} ariaLabel={`Segment ${seg.name}`} />
      <div className="card">
        <div className="row spread wrap">
          <input className="input" style={{ maxWidth: 260, fontWeight: 500 }} defaultValue={seg.name} onBlur={(e) => e.target.value.trim() && onRename(e.target.value.trim())} aria-label="Segment name" />
          <button className="btn danger sm" onClick={onRemove}>Remove</button>
        </div>
        <div className="grid cols-3 keep" style={{ marginTop: 12 }}>
          <div><div className="eyebrow">Length</div><div className="mono">{fmtDistU(seg.length, units, 2)}</div></div>
          <div><div className="eyebrow">Climb</div><div className="mono">{fmtElev(seg.elevGain, units)}</div></div>
          <div><div className="eyebrow">Efforts</div><div className="mono">{efforts.length}</div></div>
        </div>
      </div>
      {efforts.length > 2 && (
        <div className="card">
          <LineChart title="Time over time" sub="Each effort, oldest to newest" x={trendX} height={180} legend={false} xFmt={(d) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short', year: '2-digit' })} xTickFmt={(d) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short' })} yFmt={(v) => fmtTime(v)} series={[{ id: 't', name: 'Time', color: 'var(--c-fit)', y: Float32Array.from(efforts.map((e) => e.time)), fmt: (v) => fmtTime(v) }]} />
        </div>
      )}
      <div className="card pad0" style={{ maxHeight: 360, overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>#</th><th>Date</th><th className="r">Time</th><th className="r">{pace ? 'Pace' : 'Speed'}</th><th className="r">HR</th>{seg.sport === 'ride' && <th className="r">Power</th>}</tr></thead>
          <tbody>{sorted.slice(0, 40).map((e, i) => {
            const a = byId.get(e.activityId);
            return (
              <tr key={e.activityId + e.start} className={i === 0 ? 'hl' : ''}>
                <td className="mono">{i + 1}</td>
                <td><Link to={`/activity/${e.activityId}`}>{a ? fmtDate(a.start, a.tz, { year: true }) : '—'}</Link></td>
                <td className="r">{fmtTime(e.time)}</td>
                <td className="r">{pace ? `${fmtPace(e.speed, units)}${paceUnit(units)}` : `${fmtSpeed(e.speed, units)} ${speedUnit(units)}`}</td>
                <td className="r">{e.avgHR ? Math.round(e.avgHR) : '—'}</td>
                {seg.sport === 'ride' && <td className="r">{e.avgPower ? Math.round(e.avgPower) : '—'}</td>}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────── Matched routes ─────────────────────────
function Matched() {
  const entries = useEntries();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const groups = useMemo(() => groupRoutes(entries), [entries]);
  const [sel, setSel] = useState(0);
  const g = groups[Math.min(sel, groups.length - 1)];
  const trk = useMemo(() => (g ? entries.find((e) => e.summary.id === g.rep.id)?.track : undefined), [g, entries]);
  if (!groups.length) return <Section n={1} total={1} title="Matched routes" glyph={GLYPH.activities}><Empty glyph="◯" title="No repeated routes yet" body="A route needs at least three runs or rides along the same path." /></Section>;
  const mem = [...g.members].sort((a, b) => a.start - b.start);
  const pace = isPaceSport(g.sport);
  const best = [...mem].sort((a, b) => a.timer - b.timer)[0];
  const lastM = mem[mem.length - 1];
  return (
    <Section n={1} total={1} glyph={GLYPH.activities} kicker="Matched routes" title="Same road, different days" lede="Activities are grouped when they follow the same path (±8 % length, shape within 45 m). Strava puts this behind a subscription.">
      <div className="grid cols-main" style={{ alignItems: 'start' }}>
        <div className="list">
          {groups.slice(0, 12).map((x, i) => (
            <button key={x.id} className="row-card" style={{ gridTemplateColumns: '76px minmax(0,1fr) auto', textAlign: 'left', borderColor: i === sel ? 'var(--arcx-text-muted)' : undefined }} onClick={() => setSel(i)} aria-pressed={i === sel}>
              <RouteThumb poly={x.rep.poly} color={SPORT_COLOR[x.sport]} />
              <div style={{ minWidth: 0 }}><div className="name">{x.rep.name}</div><div className="meta">{x.sport} · {fmtDistU(x.length, units, 1)}</div></div>
              <div className="stat"><div className="v">×{x.members.length}</div><div className="k">efforts</div></div>
            </button>
          ))}
        </div>
        <div className="stack">
          {trk && <MapView tracks={[{ id: g.rep.id, lat: trk.lat, lon: trk.lon }]} height={240} fitKey={g.id} basemap={profile.mapTiles} ariaLabel="Route" />}
          <div className="grid cols-3 keep">
            <Tile label="Efforts" value={mem.length} />
            <Tile label="Best" value={fmtTime(best.timer)} delta={fmtDate(best.start, best.tz, { year: false })} />
            <Tile label="Latest" value={fmtTime(lastM.timer)} delta={lastM.timer <= best.timer * 1.02 ? 'near your best' : `+${Math.round(lastM.timer - best.timer)} s vs best`} dir={lastM.timer <= best.timer * 1.02 ? 'up' : ''} />
          </div>
          <div className="card">
            <LineChart title="Time per effort" x={Float32Array.from(mem.map((m) => dayNumOf(m.start, m.tz)))} height={190} legend={false} xFmt={(d) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short', year: '2-digit' })} xTickFmt={(d) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short' })} yFmt={(v) => fmtTime(v)} series={[{ id: 't', name: 'Time', color: 'var(--c-fit)', y: Float32Array.from(mem.map((m) => m.timer)), fmt: (v) => fmtTime(v) }]} />
          </div>
          <div className="card pad0" style={{ maxHeight: 280, overflow: 'auto' }}>
            <table className="tbl"><thead><tr><th>Date</th><th className="r">Time</th><th className="r">{pace ? 'Pace' : 'Speed'}</th><th className="r">HR</th></tr></thead>
              <tbody>{[...mem].reverse().map((m) => <tr key={m.id} className={m.id === best.id ? 'hl' : ''}><td><Link to={`/activity/${m.id}`}>{fmtDate(m.start, m.tz, { year: true })}</Link></td><td className="r">{fmtTime(m.timer)}</td><td className="r">{pace ? `${fmtPace(m.avgSpeed, units)}${paceUnit(units)}` : `${fmtSpeed(m.avgSpeed, units)} ${speedUnit(units)}`}</td><td className="r">{m.avgHR ? Math.round(m.avgHR) : '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </div>
    </Section>
  );
}

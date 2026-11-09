import { useMemo } from 'react';
import { useCore } from '../lib/core';
import { Link } from '../lib/router';
import { setProfile, toast, useStore } from '../lib/store/store';
import { useUnits } from '../lib/hooks';
import { dayNumOf, dayNumToKey, fmtDate, fmtDayKey, fmtDistU, fmtPace, fmtTime, paceUnit, KM, MI } from '../lib/units';
import { bestEffortsAgg, fitCP, fitCriticalSpeed, powerCurve } from '../lib/analyze/efforts';
import { BEST_DISTANCES, BEST_LABELS } from '../lib/analyze/process';
import { suggestThresholds, vdotTrend } from '../lib/analyze/predict';
import { hrZones, paceZones, pwrZones, ZONE_COLORS } from '../lib/analyze/zones';
import { Chip, Empty, PageHead, Section, Tile, Why, GLYPH } from '../ui/kit';
import { LineChart } from '../ui/charts/charts';

const secPaceU = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function Performance() {
  const core = useCore();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const { acts, pred, now } = core;
  const unitM = units === 'metric' ? KM : MI;

  const trend = useMemo(() => vdotTrend(acts), [acts]);
  const bestAll = useMemo(() => bestEffortsAgg(acts, { sports: ['run'] }), [acts]);
  const best90 = useMemo(() => bestEffortsAgg(acts, { sports: ['run'], from: now - 90 * 86400000, to: now }), [acts, now]);
  const curveAll = useMemo(() => powerCurve(acts), [acts]);
  const curve90 = useMemo(() => powerCurve(acts, now - 90 * 86400000, now), [acts, now]);
  const curve42 = useMemo(() => powerCurve(acts, now - 42 * 86400000, now), [acts, now]);
  const cp = useMemo(() => fitCP(curve90), [curve90]);
  const cs = useMemo(() => fitCriticalSpeed(best90), [best90]);
  const sugg = useMemo(() => suggestThresholds(acts, profile, now), [acts, profile, now]);

  const efSeries = useMemo(() => {
    const runs = acts.filter((a) => a.sport === 'run' && a.ef && a.avgHR && a.avgHR < 0.92 * profile.lthr && a.timer > 1500).sort((a, b) => a.start - b.start);
    if (runs.length < 6) return null;
    const x = Float32Array.from(runs.map((r) => dayNumOf(r.start, r.tz)));
    const raw = Float32Array.from(runs.map((r) => r.ef!));
    const roll = Float32Array.from(runs.map((_, i) => {
      const w = runs.slice(Math.max(0, i - 5), i + 1);
      return w.reduce((s, r) => s + r.ef!, 0) / w.length;
    }));
    return { x, raw, roll };
  }, [acts, profile.lthr]);
  const dcSeries = useMemo(() => {
    const l = acts.filter((a) => a.decoupling != null && a.timer >= 3600 && (a.vi == null || a.vi < 1.12)).sort((a, b) => a.start - b.start);
    if (l.length < 5) return null;
    return { x: Float32Array.from(l.map((r) => dayNumOf(r.start, r.tz))), y: Float32Array.from(l.map((r) => r.decoupling!)) };
  }, [acts]);

  if (!acts.length)
    return (
      <>
        <PageHead tag="Performance" title="No data yet." />
        <Empty title="Nothing to analyse" body="Import activities or load the demo athlete on the Today screen."><Link to="/" className="btn">Go to Today</Link></Empty>
      </>
    );

  const dayFmt = (d: number) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short', year: '2-digit' });
  const dayTick = (d: number) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short' });
  const durFmt = (v: number) => (v < 60 ? `${v} s` : v < 3600 ? `${(v / 60).toFixed(v % 60 ? 1 : 0)} min` : `${(v / 3600).toFixed(1)} h`);
  const durTick = (v: number) => (v < 60 ? `${v}s` : v < 3600 ? `${v / 60}m` : `${v / 3600}h`);
  const hasPower = curveAll.length > 0;
  const total = 5;

  const apply = (s: (typeof sugg)[number]) => {
    setProfile({ [s.key]: s.key === 'thresholdSpeed' ? s.estimate : Math.round(s.estimate) } as never);
    toast(`${s.label} updated — history recomputed instantly.`);
  };

  return (
    <>
      <PageHead n={1} total={total} tag="Performance" title="What you can do today." lede="Race predictions with honest ranges, records, critical power and the physiology markers behind them." />

      <Section n={1} total={total} glyph={GLYPH.performance} kicker="Race predictions" title="If you raced today" lede={pred ? `Based on your best ${pred.basis.label} run (${fmtTime(pred.basis.time)}, ${fmtDate(pred.basis.start, core.tz)}) in the last 120 days.` : 'Run a hard 1.5–21 km effort to unlock predictions.'}>
        {pred ? (
          <>
            <div className="grid cols-4" style={{ marginBottom: 16 }}>
              {pred.races.map((r) => <Tile key={r.label} label={r.label} value={fmtTime(r.mid)} delta={`range ${fmtTime(r.low)} – ${fmtTime(r.high)}`} explain={`${fmtPace(r.distM / r.mid, units)} ${paceUnit(units)} · ${fmtDistU(r.distM, units, 1)}`} />)}
            </div>
            <div className="grid cols-2" style={{ alignItems: 'start' }}>
              <div className="card pad0">
                <div className="table-wrap"><table className="tbl">
                  <thead><tr><th>Race</th><th className="r">VDOT</th><th className="r">Riegel 1.06</th><th className="r">Personal {pred.exponent.b.toFixed(3)}</th></tr></thead>
                  <tbody>{pred.races.map((r) => <tr key={r.label}><td>{r.label}</td><td className="r">{fmtTime(r.vdotTime)}</td><td className="r">{fmtTime(r.riegelTime)}</td><td className="r">{fmtTime(r.personalTime)}</td></tr>)}</tbody>
                </table></div>
                <div style={{ padding: '4px 20px 16px' }}>
                  <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                    <Chip tone={pred.confidence === 'high' ? 'pos' : pred.confidence === 'medium' ? 'lime' : 'warn'}>confidence {pred.confidence}</Chip>
                    <Chip tone="mute">VDOT {pred.vdot.toFixed(1)}</Chip>
                    <Chip tone="mute">{pred.exponent.personal ? `personal exponent from ${pred.exponent.n} efforts` : 'default exponent 1.06'}</Chip>
                  </div>
                  <Why label="Show the math" formula={'VDOT (Daniels/Gilbert): VO₂ = −4.60 + 0.182258·v + 0.000104·v², %VO₂max = 0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t), VDOT = VO₂ ÷ %VO₂max (v in m/min, t in min).\nRiegel: t₂ = t₁·(d₂/d₁)^b. The personal b is the log-log slope of your own bests (clamped 1.02–1.12). The range spans all three models; long-distance projections from short efforts are widened.'} evidence={[{ label: 'Basis effort', value: `${pred.basis.label} · ${fmtTime(pred.basis.time)}` }, { label: 'VDOT', value: pred.vdot.toFixed(2) }, { label: 'Exponent', value: pred.exponent.b.toFixed(3) }]} />
                </div>
              </div>
              <div className="card pad0">
                <div className="table-wrap"><table className="tbl">
                  <thead><tr><th>Training pace</th><th className="r">Pace {paceUnit(units)}</th><th className="r">Effort</th></tr></thead>
                  <tbody>
                    <tr><td>Easy</td><td className="r">{fmtPace(pred.paces.easy[0], units)} – {fmtPace(pred.paces.easy[1], units)}</td><td className="r">62–74 % VO₂max</td></tr>
                    <tr><td>Marathon</td><td className="r">{fmtPace(pred.paces.marathon, units)}</td><td className="r">81.5 %</td></tr>
                    <tr><td>Threshold</td><td className="r">{fmtPace(pred.paces.threshold, units)}</td><td className="r">88 %</td></tr>
                    <tr><td>Interval</td><td className="r">{fmtPace(pred.paces.interval, units)}</td><td className="r">98 %</td></tr>
                    <tr><td>Repetition</td><td className="r">{fmtPace(pred.paces.repetition, units)}</td><td className="r">107 %</td></tr>
                  </tbody>
                </table></div>
              </div>
            </div>
            {trend.length >= 3 && (
              <div className="card" style={{ marginTop: 16 }}>
                <LineChart title="VDOT by month" sub="Best effort-based fitness estimate for each calendar month" x={Float32Array.from(trend.map((_, i) => i))} height={200} legend={false} xFmt={(i) => trend[Math.round(i)]?.month ?? ''} xTickFmt={(i) => { const m = trend[Math.round(i)]?.month; return m ? new Date(m + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) : ''; }} xTicks={trend.map((_, i) => i).filter((i) => i % Math.max(1, Math.ceil(trend.length / 8)) === 0)} yFmt={(v) => v.toFixed(0)} series={[{ id: 'v', name: 'VDOT', color: 'var(--c-fit)', y: Float32Array.from(trend.map((t) => t.vdot)), fmt: (v) => v.toFixed(1) }]} />
              </div>
            )}
          </>
        ) : <div className="card"><p>No qualifying run efforts found in the last 120 days.</p></div>}
      </Section>

      <Section n={2} total={total} glyph={GLYPH.activities} kicker="Personal records" title="Best efforts" lede="Fastest sliding window for each distance inside any run — not just race results.">
        <div className="card pad0"><div className="table-wrap"><table className="tbl">
          <thead><tr><th>Distance</th><th className="r">All-time</th><th className="r">Pace</th><th className="r">Date</th><th className="r">Last 90 d</th><th className="r">vs all-time</th></tr></thead>
          <tbody>{BEST_DISTANCES.filter((D) => bestAll.get(D)).map((D) => {
            const a = bestAll.get(D)!, b = best90.get(D);
            return (
              <tr key={D}>
                <td>{BEST_LABELS[D]}</td>
                <td className="r"><Link to={`/activity/${a.activityId}`}>{fmtTime(a.time)}</Link></td>
                <td className="r">{fmtPace(D / a.time, units)}</td>
                <td className="r muted">{fmtDate(a.start, core.tz, { year: true })}</td>
                <td className="r">{b ? fmtTime(b.time) : '—'}</td>
                <td className="r">{b ? (b.time <= a.time + 0.01 ? <Chip tone="lime">PR</Chip> : `+${(b.time - a.time).toFixed(0)} s`) : '—'}</td>
              </tr>
            );
          })}</tbody>
        </table></div></div>
        {cs && <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>Critical speed ≈ <span className="mono">{fmtPace(cs.cs, units)} {paceUnit(units)}</span>, D′ ≈ <span className="mono">{Math.round(cs.dPrime)} m</span> (R² {cs.r2.toFixed(3)}, {cs.n} efforts).</p>}
      </Section>

      {hasPower && (
        <Section n={3} total={total} glyph={GLYPH.training} kicker="Power" title="Power curve and critical power" lede="Your best average power for every duration — and the two-parameter critical-power model fitted to your 3–20 minute efforts.">
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Tile label="Critical power" value={cp ? Math.round(cp.cp) : '—'} unit="W" delta={cp ? `R² ${cp.r2.toFixed(3)}` : 'needs 3 efforts of 3–20 min'} />
            <Tile label="W′ (anaerobic)" value={cp ? (cp.wPrime / 1000).toFixed(1) : '—'} unit="kJ" />
            <Tile label="Best 20 min" value={curve90.find((c) => c.dur === 1200) ? Math.round(curve90.find((c) => c.dur === 1200)!.w) : '—'} unit="W" delta={`${profile.weightKg ? ((curve90.find((c) => c.dur === 1200)?.w ?? 0) / profile.weightKg).toFixed(2) : '—'} W/kg · 90 d`} />
            <Tile label="Best 5 min" value={curve90.find((c) => c.dur === 300) ? Math.round(curve90.find((c) => c.dur === 300)!.w) : '—'} unit="W" delta={`${((curve90.find((c) => c.dur === 300)?.w ?? 0) / profile.weightKg).toFixed(2)} W/kg · 90 d`} />
          </div>
          <div className="card">
            <LineChart
              title="Mean-maximal power"
              x={Float32Array.from(curveAll.map((c) => c.dur))}
              xScale="log"
              xDomain={[1, curveAll[curveAll.length - 1].dur]}
              xTicks={[1, 5, 15, 60, 300, 1200, 3600, 10800].filter((t) => t <= curveAll[curveAll.length - 1].dur)}
              xTickFmt={durTick}
              xFmt={durFmt}
              yFmt={(v) => `${Math.round(v)}`}
              height={280}
              series={[
                { id: 'all', name: 'All-time', color: 'var(--c-ink)', y: Float32Array.from(curveAll.map((c) => c.w)) },
                { id: 'd90', name: 'Last 90 days', color: 'var(--c-pwr)', y: Float32Array.from(curveAll.map((c) => curve90.find((x) => x.dur === c.dur)?.w ?? NaN)) },
                { id: 'd42', name: 'Last 42 days', color: 'var(--c-fit)', y: Float32Array.from(curveAll.map((c) => curve42.find((x) => x.dur === c.dur)?.w ?? NaN)) },
              ]}
            />
          </div>
        </Section>
      )}

      {(efSeries || dcSeries) && (
        <Section n={hasPower ? 4 : 3} total={total} glyph={GLYPH.today} kicker="Physiology markers" title="Is your engine improving?" lede="Efficiency factor and aerobic decoupling track base fitness better than pace alone.">
          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            {efSeries && <div className="card"><LineChart title="Efficiency factor — easy runs" sub="Grade-adjusted metres per minute per heartbeat. Up = fitter." x={efSeries.x} height={210} xFmt={dayFmt} xTickFmt={dayTick} yFmt={(v) => v.toFixed(2)} series={[{ id: 'raw', name: 'Each run', color: '#71717a', y: efSeries.raw, width: 1 }, { id: 'roll', name: '6-run average', color: 'var(--c-fit)', y: efSeries.roll }]} /></div>}
            {dcSeries && <div className="card"><LineChart title="Aerobic decoupling — long steady sessions" sub="HR drift vs output, first vs second half. Under 5 % is a solid base." x={dcSeries.x} height={210} legend={false} xFmt={dayFmt} xTickFmt={dayTick} yFmt={(v) => `${v.toFixed(0)}%`} refs={[{ y: 5, label: '5 %' }]} zero series={[{ id: 'dc', name: 'Decoupling', color: 'var(--c-hr)', y: dcSeries.y, fmt: (v) => `${v.toFixed(1)} %` }]} /></div>}
          </div>
        </Section>
      )}

      <Section n={total} total={total} glyph={GLYPH.settings} kicker="Thresholds & zones" title="Keep your zones honest" lede="ArcStride only ever suggests raising a threshold from a new best — a training file with no hard effort says nothing about your ceiling. Strava can't do LTHR zones at all.">
        <div className="card pad0" style={{ marginBottom: 16 }}>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Threshold</th><th className="r">Current</th><th className="r">Evidence</th><th>Status</th><th>Basis</th><th /></tr></thead>
            <tbody>{sugg.length ? sugg.map((s) => (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td className="r">{s.key === 'thresholdSpeed' ? `${fmtPace(s.current, units)} ${paceUnit(units)}` : Math.round(s.current)}</td>
                <td className="r">{s.key === 'thresholdSpeed' ? `${fmtPace(s.estimate, units)} ${paceUnit(units)}` : Math.round(s.estimate)}</td>
                <td>{s.status === 'raise' ? <Chip tone="lime">new best</Chip> : s.status === 'ok' ? <Chip tone="pos">consistent</Chip> : <Chip tone="warn">no hard effort</Chip>}</td>
                <td className="muted" style={{ whiteSpace: 'normal', maxWidth: 360, fontSize: 12 }}>{s.basis}</td>
                <td className="r">{s.status === 'raise' && <button className="btn sm" onClick={() => apply(s)}>Apply</button>}</td>
              </tr>
            )) : <tr><td colSpan={6} className="muted">Not enough data to estimate thresholds yet.</td></tr>}</tbody>
          </table></div>
        </div>
        <div className="grid cols-3" style={{ alignItems: 'start' }}>
          <ZoneTable title="Heart-rate zones" sub={`${profile.hrZoneModel === 'lthr' ? 'Friel · % of LTHR' : profile.hrZoneModel === 'hrr' ? 'Karvonen · % HR reserve' : '% of max HR'}`} rows={hrZones(profile).map((z, i) => ({ n: z.n, name: z.name, range: z.hi === Infinity ? `≥ ${Math.round(z.lo)} bpm` : z.lo === 0 ? `< ${Math.round(z.hi)} bpm` : `${Math.round(z.lo)}–${Math.round(z.hi)} bpm`, color: [ZONE_COLORS[0], ZONE_COLORS[1], ZONE_COLORS[2], ZONE_COLORS[3], ZONE_COLORS[5]][i] }))} />
          <ZoneTable title="Power zones" sub={`Coggan · FTP ${profile.ftp} W`} rows={pwrZones(profile).map((z, i) => ({ n: z.n, name: z.name, range: z.hi === Infinity ? `≥ ${Math.round(z.lo)} W` : z.lo === 0 ? `< ${Math.round(z.hi)} W` : `${Math.round(z.lo)}–${Math.round(z.hi)} W`, color: ZONE_COLORS[i] }))} />
          <ZoneTable title="Pace zones" sub={`Flat-equivalent · threshold ${fmtPace(profile.thresholdSpeed, units)} ${paceUnit(units)}`} rows={paceZones(profile).map((z, i) => ({ n: z.n, name: z.name, range: z.hi === Infinity ? `faster than ${secPaceU(unitM / z.lo)}` : z.lo === 0 ? `slower than ${secPaceU(unitM / z.hi)}` : `${secPaceU(unitM / z.lo)}–${secPaceU(unitM / z.hi)}`, color: [ZONE_COLORS[0], ZONE_COLORS[1], ZONE_COLORS[2], ZONE_COLORS[3], ZONE_COLORS[5]][i] }))} />
        </div>
        <div className="row" style={{ marginTop: 16 }}><Link to="/settings" className="btn ghost">Edit thresholds and zone model</Link></div>
      </Section>
    </>
  );
}

function ZoneTable({ title, sub, rows }: { title: string; sub: string; rows: { n: number; name: string; range: string; color: string }[] }) {
  return (
    <div className="card">
      <div className="card-head"><div><h3>{title}</h3><div className="sub">{sub}</div></div></div>
      <div className="stack" style={{ gap: 6 }}>
        {rows.map((r) => (
          <div key={r.n} className="row spread" style={{ fontSize: 13, borderBottom: '1px solid #1c1c1f', paddingBottom: 6 }}>
            <span className="row" style={{ gap: 8 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: r.color, display: 'inline-block' }} /><span className="mono muted" style={{ fontSize: 11 }}>Z{r.n}</span> {r.name}</span>
            <span className="mono" style={{ fontSize: 12 }}>{r.range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

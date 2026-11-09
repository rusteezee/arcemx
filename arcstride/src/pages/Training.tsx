import { useEffect, useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { Link } from '../lib/router';
import { useStore } from '../lib/store/store';
import { useUnits } from '../lib/hooks';
import { dayNumOf, dayNumToKey, fmtDayKey, fmtDur, fmtSigned, toDist, distUnit, fmtDistU } from '../lib/units';
import { ATL_DAYS, CTL_DAYS, acwrZone, forecastPMC, monotonyStrain, spikeCheck, triDistribution, weekStartOf } from '../lib/analyze/load';
import { Chip, Empty, InsightCard, PageHead, Section, Seg, Tile, Why, GLYPH } from '../ui/kit';
import { BarChart, CalHeat } from '../ui/charts/charts';
import { LineChart } from '../ui/charts/charts';
import { SPORT_COLOR } from '../ui/ActivityRow';

type Range = '42' | '90' | '180' | '365' | 'all';
type Preset = 'rest' | 'maintain' | 'build' | 'taper' | 'plan' | 'custom';

export function Training() {
  const core = useCore();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const plan = useStore((s) => s.plan);
  const { acts, pmc, last, today, loads, daily, insights } = core;
  const [range, setRange] = useState<Range>('180');
  const [preset, setPreset] = useState<Preset>('maintain');
  const [planned, setPlanned] = useState<number[]>(() => new Array(14).fill(0));

  const avg28 = useMemo(() => {
    let s = 0;
    for (let d = today - 27; d <= today; d++) s += daily.get(d) ?? 0;
    return s / 28;
  }, [daily, today]);

  // keep sliders in sync with presets
  useEffect(() => {
    if (preset === 'custom') return;
    const arr = new Array(14).fill(0).map((_, i) => {
      switch (preset) {
        case 'rest':
          return 0;
        case 'maintain':
          return Math.round(avg28);
        case 'build':
          return Math.round(avg28 * 1.25);
        case 'taper':
          return Math.round(avg28 * 0.5);
        case 'plan': {
          const key = dayNumToKey(today + 1 + i);
          return Math.round(plan?.workouts.filter((w) => w.date === key).reduce((s, w) => s + w.load, 0) ?? 0);
        }
      }
    });
    setPlanned(arr);
  }, [preset, avg28, plan, today]);

  const view = useMemo(() => {
    if (!pmc.length) return null;
    const n = range === 'all' ? pmc.length : Math.min(pmc.length, parseInt(range));
    const slice = pmc.slice(-n);
    const fc = last ? forecastPMC(last, planned) : [];
    const all = [...slice, ...fc];
    return { all, nHist: slice.length, fc };
  }, [pmc, range, last, planned]);

  // weekly intensity-hours + distance by sport
  const weekly = useMemo(() => {
    const nW = 26;
    const thisWs = weekStartOf(today, profile.weekStart);
    const starts = Array.from({ length: nW }, (_, i) => thisWs - 7 * (nW - 1 - i));
    const idx = new Map(starts.map((s, i) => [s, i]));
    const tri = [0, 1, 2].map(() => new Array(nW).fill(0));
    const bySport: Record<string, number[]> = {};
    for (const a of acts) {
      const ws = weekStartOf(dayNumOf(a.start, a.tz), profile.weekStart);
      const i = idx.get(ws);
      if (i == null) continue;
      const t = loads.get(a.id)?.tri;
      if (t) for (let k = 0; k < 3; k++) tri[k][i] += t[k] / 3600;
      (bySport[a.sport] ??= new Array(nW).fill(0))[i] += toDist(a.distance, units);
    }
    const labels = starts.map((s) => fmtDayKey(dayNumToKey(s), { day: 'numeric', month: 'short' }));
    return { labels, tri, bySport, heads: starts.map((s) => `Week of ${fmtDayKey(dayNumToKey(s), { day: 'numeric', month: 'short', year: 'numeric' })}`) };
  }, [acts, loads, today, profile.weekStart, units]);

  const dist28 = useMemo(() => triDistribution(acts, loads, today - 27, today), [acts, loads, today]);
  const dist90 = useMemo(() => triDistribution(acts, loads, today - 89, today), [acts, loads, today]);
  const rhythm = useMemo(() => monotonyStrain(daily, today), [daily, today]);
  const spike = useMemo(() => spikeCheck(acts, today), [acts, today]);

  if (!acts.length || !last || !view)
    return (
      <>
        <PageHead tag="Training" title="No training data yet." lede="Import activities to see fitness, fatigue and form." />
        <Empty title="Nothing to chart" body="Load a demo athlete from Today, or import your files."><Link to="/" className="btn">Go to Today</Link></Empty>
      </>
    );

  const { all, nHist, fc } = view;
  const x = Float32Array.from(all.map((p) => p.day));
  const dayFmt = (d: number) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short', year: '2-digit' });
  const dayTick = (d: number) => fmtDayKey(dayNumToKey(d), { day: 'numeric', month: 'short' });
  const z = acwrZone(last.acwr);
  const lastFc = fc[fc.length - 1];
  const pct = (v: number) => `${Math.round((v / Math.max(1, dist28.total)) * 100)}%`;

  return (
    <>
      <PageHead n={1} total={6} tag="Training" title="Fitness, fatigue, form." lede={`Fitness is a ${CTL_DAYS}-day weighted average of load, fatigue a ${ATL_DAYS}-day one, and form is the gap. Nothing here is hidden behind a subscription, and every formula is on the Settings page.`} />

      <Section n={1} total={6} glyph={GLYPH.training} kicker="Performance management" title="The load curve"
        actions={<Seg value={range} onChange={setRange} options={[{ v: '42', label: '6 w' }, { v: '90', label: '3 m' }, { v: '180', label: '6 m' }, { v: '365', label: '1 y' }, { v: 'all', label: 'All' }]} />}>
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Tile label="Fitness · CTL" value={last.ctl.toFixed(1)} delta={`${fmtSigned(last.ctl - (pmc[pmc.length - 8]?.ctl ?? last.ctl), 1)} vs 7 days ago`} />
          <Tile label="Fatigue · ATL" value={last.atl.toFixed(1)} />
          <Tile label="Form · TSB" value={fmtSigned(last.tsb, 1)} />
          <Tile label="ACWR" value={last.acwr.toFixed(2)}><div><Chip tone={z === 'sweet' ? 'pos' : z === 'under' ? 'warn' : z === 'caution' ? 'warn' : 'neg'}>{z === 'sweet' ? 'sweet spot' : z === 'under' ? 'under' : z}</Chip></div></Tile>
        </div>
        <div className="card">
          <LineChart
            title="Fitness and fatigue"
            sub="Daily training load, exponentially weighted. Shaded region = forecast from the what-if simulator below."
            x={x}
            height={260}
            xFmt={dayFmt}
            xTickFmt={dayTick}
            forecastFrom={all[nHist - 1].day + 0.5}
            endLabel
            yFmt={(v) => String(Math.round(v))}
            series={[
              { id: 'ctl', name: 'Fitness', color: 'var(--c-fit)', y: Float32Array.from(all.map((p) => p.ctl)), fmt: (v) => v.toFixed(1) },
              { id: 'atl', name: 'Fatigue', color: 'var(--c-hr)', y: Float32Array.from(all.map((p) => p.atl)), fmt: (v) => v.toFixed(1) },
            ]}
          />
        </div>
        <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
          <div className="card">
            <LineChart
              title="Form"
              sub="Fitness − fatigue (yesterday's values). Below −25 is deep fatigue; +5 to +20 is race-fresh."
              x={x}
              height={190}
              zero
              legend={false}
              xFmt={dayFmt}
              xTickFmt={dayTick}
              forecastFrom={all[nHist - 1].day + 0.5}
              yFmt={(v) => fmtSigned(Math.round(v))}
              series={[{ id: 'tsb', name: 'Form', color: 'var(--c-ink)', y: Float32Array.from(all.map((p) => p.tsb)), area: true, fmt: (v) => fmtSigned(v, 1) }]}
            />
          </div>
          <div className="card">
            <LineChart
              title="Acute : chronic load ratio"
              sub="EWMA(7 d) ÷ EWMA(28 d). Stay between 0.8 and 1.3."
              x={x}
              height={190}
              legend={false}
              xFmt={dayFmt}
              xTickFmt={dayTick}
              forecastFrom={all[nHist - 1].day + 0.5}
              yDomain={[0.4, Math.max(1.8, ...all.map((p) => p.acwr))]}
              yTicks={[0.5, 0.8, 1.0, 1.3, 1.5]}
              refs={[{ y: 0.8, label: '0.8' }, { y: 1.3, label: '1.3 caution' }, { y: 1.5, label: '1.5' }]}
              yFmt={(v) => v.toFixed(1)}
              series={[{ id: 'acwr', name: 'ACWR', color: 'var(--c-ink)', y: Float32Array.from(all.map((p) => p.acwr)), fmt: (v) => v.toFixed(2) }]}
            />
          </div>
        </div>
      </Section>

      <Section n={2} total={6} glyph={GLYPH.plan} kicker="What-if simulator" title="Preview the next two weeks" lede="Set a daily load for each of the next 14 days — or start from a preset or your training plan — and watch fitness, fatigue and form respond on the chart above.">
        <div className="card">
          <div className="row spread wrap" style={{ marginBottom: 16 }}>
            <Seg value={preset} onChange={setPreset} options={[{ v: 'rest', label: 'Rest' }, { v: 'taper', label: 'Taper' }, { v: 'maintain', label: 'Maintain' }, { v: 'build', label: 'Build +25 %' }, ...(plan ? [{ v: 'plan' as const, label: 'My plan' }] : [])]} />
            <span className="muted mono" style={{ fontSize: 11.5 }}>28-day average load: {avg28.toFixed(0)} / day</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(14, minmax(0,1fr))', gap: 6, alignItems: 'end' }}>
            {planned.map((v, i) => (
              <div key={i} style={{ display: 'grid', gap: 6, justifyItems: 'center', minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 11 }}>{v}</span>
                <input type="range" min={0} max={200} step={5} value={v} aria-label={`Load day +${i + 1}`} style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 110, width: 22 }} onChange={(e) => { const n = [...planned]; n[i] = +e.target.value; setPlanned(n); setPreset('custom'); }} />
                <span className="eyebrow" style={{ fontSize: 9 }}>{fmtDayKey(dayNumToKey(today + 1 + i), { weekday: 'narrow', day: 'numeric' })}</span>
              </div>
            ))}
          </div>
          {lastFc && (
            <div className="grid cols-4 keep" style={{ marginTop: 18 }}>
              <Tile label="Fitness in 14 d" value={lastFc.ctl.toFixed(1)} delta={`${fmtSigned(lastFc.ctl - last.ctl, 1)} vs today`} dir={lastFc.ctl >= last.ctl ? 'up' : 'down'} />
              <Tile label="Fatigue in 14 d" value={lastFc.atl.toFixed(1)} delta={`${fmtSigned(lastFc.atl - last.atl, 1)} vs today`} />
              <Tile label="Form in 14 d" value={fmtSigned(lastFc.tsb, 1)} delta={`${fmtSigned(lastFc.tsb - last.tsb, 1)} vs today`} dir={lastFc.tsb >= last.tsb ? 'up' : 'down'} />
              <Tile label="ACWR in 14 d" value={lastFc.acwr.toFixed(2)} delta={acwrZone(lastFc.acwr) === 'sweet' ? 'sweet spot' : acwrZone(lastFc.acwr)} />
            </div>
          )}
          <Why label="Show the math" formula={'CTL_t = CTL_{t-1} + (L_t − CTL_{t-1})·(1 − e^(−1/42)); ATL uses 7. Form_t = CTL_{t-1} − ATL_{t-1}. ACWR uses EWMA with λ = 2/(N+1) for N = 7 and 28. The forecast just continues these recursions with your planned loads (the ACWR forecast is approximate).'} />
        </div>
      </Section>

      <Section n={3} total={6} glyph={GLYPH.activities} kicker="Weekly rhythm" title="Volume and intensity, 26 weeks" lede="Low = below LT1 (easy), moderate = between LT1 and threshold, high = at or above threshold.">
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div className="card">
            <BarChart
              title="Hours by intensity"
              sub="Seiler 3-zone model, best available signal per activity"
              cats={weekly.labels}
              heads={weekly.heads}
              height={230}
              yFmt={(v) => `${v.toFixed(0)}h`}
              valFmt={(v) => `${v.toFixed(1)} h`}
              stacks={[
                { id: 'low', name: 'Low', color: 'var(--c-z2)', values: weekly.tri[0] },
                { id: 'mid', name: 'Moderate', color: 'var(--c-z4)', values: weekly.tri[1] },
                { id: 'high', name: 'High', color: 'var(--c-z6)', values: weekly.tri[2] },
              ]}
            />
          </div>
          <div className="card">
            <BarChart
              title="Distance by sport"
              sub={`${distUnit(units)} per week`}
              cats={weekly.labels}
              heads={weekly.heads}
              height={230}
              yFmt={(v) => String(Math.round(v))}
              valFmt={(v) => `${v.toFixed(1)} ${distUnit(units)}`}
              stacks={(['run', 'ride', 'walk', 'hike', 'other'] as const).filter((s) => weekly.bySport[s]?.some((v) => v > 0)).map((s) => ({ id: s, name: { run: 'Run', ride: 'Ride', walk: 'Walk', hike: 'Hike', other: 'Other' }[s], color: SPORT_COLOR[s], values: weekly.bySport[s] }))}
            />
          </div>
        </div>
      </Section>

      <Section n={4} total={6} glyph={GLYPH.performance} kicker="Intensity distribution" title="How hard do you train?" lede="Elite endurance training is usually either polarised (~80 % easy, ~10 % moderate, ~10 % hard) or pyramidal. The grey zone in the middle is the common amateur trap.">
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          {[{ t: 'Last 28 days', d: dist28 }, { t: 'Last 90 days', d: dist90 }].map(({ t, d }) => (
            <div className="card" key={t}>
              <div className="card-head"><div><h3>{t}</h3><div className="sub">{d.total ? `${fmtDur(d.total)} analysed` : 'no data'}</div></div>{d.total > 0 && <Chip tone={d.model === 'polarized' || d.model === 'pyramidal' ? 'pos' : d.model === 'threshold' ? 'warn' : 'mute'}>{d.model}</Chip>}</div>
              {d.total > 0 ? (
                <>
                  <div className="segbar" style={{ height: 14 }} role="img" aria-label="Intensity distribution">
                    <i style={{ flex: Math.max(d.low, 1), background: 'var(--c-z2)' }} />
                    <i style={{ flex: Math.max(d.mid, 1), background: 'var(--c-z4)' }} />
                    <i style={{ flex: Math.max(d.high, 1), background: 'var(--c-z6)' }} />
                  </div>
                  <div className="grid cols-3 keep" style={{ marginTop: 14 }}>
                    {[['Low', d.low, 'var(--c-z2)'], ['Moderate', d.mid, 'var(--c-z4)'], ['High', d.high, 'var(--c-z6)']].map(([k, v, c]) => (
                      <div key={String(k)}><div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: String(c), display: 'inline-block' }} />{k}</div><div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.03em' }}>{Math.round(((v as number) / d.total) * 100)}%</div><div className="muted mono" style={{ fontSize: 11 }}>{fmtDur(v as number)}</div></div>
                    ))}
                  </div>
                </>
              ) : <p>Not enough intensity data yet.</p>}
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>Target for reference: 80 / 10 / 10. Yours over 28 days: {pct(dist28.low)} / {pct(dist28.mid)} / {pct(dist28.high)}.</p>
      </Section>

      <Section n={5} total={6} glyph={GLYPH.goals} kicker="Risk & rhythm" title="Injury-risk signals" lede="Three research-backed checks that Strava doesn't surface.">
        <div className="grid cols-3">
          <Tile label="Monotony (7 d)" value={rhythm.monotony.toFixed(2)} delta={rhythm.monotony > 2 ? 'high — vary your days' : 'healthy variation'} dir={rhythm.monotony > 2 ? 'down' : 'up'} explain="mean ÷ sd of daily load (Foster). >2.0 is linked to illness." />
          <Tile label="Strain (7 d)" value={Math.round(rhythm.strain).toLocaleString()} explain={`Weekly load ${Math.round(rhythm.weekLoad)} × monotony.`} />
          <Tile label="Longest-run jump" value={spike ? `${((spike.ratio - 1) * 100 >= 0 ? '+' : '') + Math.round((spike.ratio - 1) * 100)}%` : '—'} delta={spike ? `${fmtDistU(spike.latest.distance, units, 1)} vs ${fmtDistU(spike.prevMax, units, 1)} prior 30 d` : 'no recent run'} dir={spike && spike.ratio > 1.1 ? 'down' : 'up'} explain="Latest run vs the longest of the previous 30 days; >10 % is flagged." />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><div><h3>Training calendar</h3><div className="sub">Daily load, last 26 weeks. Brighter = harder day.</div></div></div>
          <CalHeat days={daily} startDay={today - 26 * 7 + 1} weeks={27} weekStart={profile.weekStart} fmtTitle={(d, v) => `${fmtDayKey(dayNumToKey(d), { weekday: 'short', day: 'numeric', month: 'short' })}: ${v > 0 ? Math.round(v) + ' load' : 'rest'}`} />
        </div>
      </Section>

      <Section n={6} total={6} glyph={GLYPH.today} kicker="Coach insights" title="Everything the data flags" id="insights">
        {insights.length ? <div className="grid cols-2">{insights.map((i) => <InsightCard key={i.id} i={i} />)}</div> : <div className="card"><p>No flags right now — nothing unusual in your recent data.</p></div>}
      </Section>
    </>
  );
}

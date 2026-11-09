import { useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { getStreams, importFiles, loadDemo, recomputeAll, removeDemo, resetAll, setPrivacy, setProfile, toast, useStore } from '../lib/store/store';
import { isPersistent } from '../lib/store/db';
import { useEntries } from '../lib/hooks';
import { KM, MI, fmtPace, paceUnit, paceToSpeed } from '../lib/units';
import { download, toCSV, toGPX, zipFiles } from '../lib/export';
import type { HrZoneModel, RunLoadSource } from '../lib/types';
import { Chip, Dropzone, Field, NumField, PageHead, Section, Seg, GLYPH } from '../ui/kit';

export function SettingsPage() {
  const core = useCore();
  const profile = useStore((s) => s.profile);
  const stale = useStore((s) => s.staleModel);
  const privacy = useStore((s) => s.privacy);
  const state = useStore((s) => s);
  const entries = useEntries();
  const units = profile.units;
  const unitM = units === 'metric' ? KM : MI;
  const [exporting, setExporting] = useState(false);
  const [zone, setZone] = useState({ name: 'Home', lat: '', lon: '', radius: '200' });
  const hasDemo = core.acts.some((a) => a.source === 'demo');

  const pace = fmtPace(profile.thresholdSpeed, units);
  const [paceTxt, setPaceTxt] = useState(pace);
  useMemo(() => setPaceTxt(fmtPace(profile.thresholdSpeed, units)), [profile.thresholdSpeed, units]);

  const commitPace = () => {
    const m = paceTxt.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return setPaceTxt(pace);
    const v = paceToSpeed(+m[1], +m[2], units);
    if (v > 1 && v < 8) setProfile({ thresholdSpeed: v });
    else setPaceTxt(pace);
  };

  const guessHome = () => {
    const counts = new Map<string, { n: number; lat: number; lon: number }>();
    for (const e of entries) {
      const la = e.track.lat[0],
        lo = e.track.lon[0];
      const k = `${la.toFixed(3)},${lo.toFixed(3)}`;
      const c = counts.get(k) ?? { n: 0, lat: la, lon: lo };
      c.n++;
      counts.set(k, c);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (!best) return toast('No GPS activities to learn a start point from.', 'warn');
    setZone({ ...zone, lat: best.lat.toFixed(5), lon: best.lon.toFixed(5) });
  };
  const addZone = () => {
    const lat = parseFloat(zone.lat),
      lon = parseFloat(zone.lon),
      r = parseFloat(zone.radius);
    if (![lat, lon, r].every(isFinite) || r < 50) return toast('Enter a valid latitude, longitude and a radius of at least 50 m.', 'warn');
    setPrivacy([...privacy, { id: 'z' + Date.now().toString(36), name: zone.name || 'Zone', lat, lon, radius: r }]);
    setZone({ name: 'Home', lat: '', lon: '', radius: '200' });
  };

  const exportCsv = () => download('arcstride-activities.csv', toCSV(core.acts, core.loads), 'text/csv');
  const exportGpx = async () => {
    setExporting(true);
    try {
      const files: Record<string, string> = {};
      for (const a of core.acts) {
        const s = await getStreams(a.id);
        if (s?.hasGps) files[`activities/${new Date(a.start).toISOString().slice(0, 10)}_${a.id}.gpx`] = toGPX(a, s, privacy);
      }
      download('arcstride-gpx.zip', new Blob([zipFiles(files) as BlobPart], { type: 'application/zip' }));
      toast(`Exported ${Object.keys(files).length} GPX files${privacy.length ? ' (privacy zones applied)' : ''}.`);
    } finally {
      setExporting(false);
    }
  };
  const exportJson = () => {
    const { activities, profile, goals, gear, segments, plan, checkins, privacy: pz, prefs } = state;
    download('arcstride-backup.json', JSON.stringify({ app: 'ArcStride', version: 1, exportedAt: new Date().toISOString(), profile, goals, gear, segments, plan, checkins, privacy: pz, prefs, activities: activities.map((a) => ({ ...a })) }, null, 1), 'application/json');
  };

  const FORMULAS: [string, string][] = [
    ['Training load (TSS-equivalent)', 'Power: TSS = hours × (NP ÷ FTP)² × 100, NP = 4th-power mean of the 30 s rolling average.\nHeart rate: Banister TRIMP = Σ minutes × HRr × a·e^(b·HRr), HRr = (HR − rest) ÷ (max − rest), (a,b) = (0.64,1.92) male / (0.86,1.67) female; hrTSS = TRIMP ÷ TRIMP(1 h at LTHR) × 100.\nPace: rTSS = hours × (NGS ÷ threshold speed)² × 100, NGS = normalised grade-adjusted speed.\nOrder of preference: power (rides) → HR → pace → duration-only estimate (IF 0.45–0.7).'],
    ['Fitness · Fatigue · Form', 'CTL_t = CTL_{t−1} + (L_t − CTL_{t−1})·(1 − e^(−1/42)); ATL uses 7 days. Form_t = CTL_{t−1} − ATL_{t−1}. Seeded with the mean load of your first 28 days. ACWR = EWMA₇ ÷ EWMA₂₈ with λ = 2/(N+1). Monotony = mean ÷ sd of daily load over 7 days; strain = weekly load × monotony.'],
    ['Grade-adjusted pace (ArcGAP)', 'Minetti et al. 2002: C(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6 (J·kg⁻¹·m⁻¹). Flat-equivalent speed = v × C(i) ÷ 3.6. Downhill is adjusted per Strava\'s 2017 HR-based study: benefit peaks at −9 %, fades to nothing at −18 %, steeper descents are penalised; scaled by your "downhill credit". Uphill is raw Minetti.'],
    ['Elevation gain', 'GPS altitude is smoothed (±4 s) and gain/loss accumulate only when the change from the last reference exceeds 2.5 m (hysteresis). Barometric data would be better; GPS-only totals can differ from other apps by 10–25 %.'],
    ['Distance', 'Device-reported distance is used if it is monotone and within ±15 % of GPS; otherwise GPS distance from 3-sample-smoothed fixes with a stationary dead-zone (net movement < 2 m over 5 s counts as standing) and a 80 m/s teleport filter. Recording gaps > 30 s are treated as a paused timer.'],
    ['Race prediction', 'VDOT (Daniels/Gilbert) from your best 1.5–21 km effort in 120 days; Riegel t₂ = t₁(d₂/d₁)^b with b = 1.06 and a personal exponent fitted to your bests (clamped 1.02–1.12). The displayed range spans all models.'],
    ['Critical power & W′', 'Two-parameter model: work = CP·t + W′ fitted by least squares to your best 3–20 min mean-maximal power (90 days). W′ balance uses Skiba\'s differential model. eFTP = 95 % of best 20-min power.'],
    ['Readiness', 'Score = 68 + 1.4 × Form (10–95), minus up to 25 for ACWR > 1.3, then check-in adjustments versus your own 30-day median (resting HR, HRV, sleep, soreness, mood). A transparent heuristic, not a medical model.'],
    ['Segments & route matching', 'A segment is a ≈10 m-resampled path. An effort is found when your track passes within 30 m of the start, reaches within 30 m of the end after 0.8–1.3× the segment length, and at least 90 % of 24 sampled points match within 35 m in both directions. Times interpolate to the exact start/finish crossing. Routes match on same sport, ±8 % length and ordered 48-point shape within 45 mean / 160 max metres.'],
  ];

  return (
    <>
      <PageHead n={1} total={6} tag="Settings" title="Your model, your rules." lede="Change a threshold and your entire history recomputes instantly. Everything lives in this browser's storage." />

      <Section n={1} total={6} glyph={GLYPH.settings} kicker="Profile" title="You">
        <div className="card">
          <div className="grid cols-3">
            <Field label="Name"><input className="input" value={profile.name} onChange={(e) => setProfile({ name: e.target.value })} /></Field>
            <Field label="Units"><Seg value={profile.units} onChange={(v) => setProfile({ units: v })} options={[{ v: 'metric', label: 'Metric' }, { v: 'imperial', label: 'Imperial' }]} /></Field>
            <Field label="Week starts"><Seg value={profile.weekStart} onChange={(v) => setProfile({ weekStart: v })} options={[{ v: 1, label: 'Monday' }, { v: 0, label: 'Sunday' }]} /></Field>
            <Field label="Weight"><NumField value={profile.weightKg} onCommit={(v) => setProfile({ weightKg: v })} min={30} max={200} suffix="kg" /></Field>
            <Field label="Sex" hint="Only used for the TRIMP heart-rate weighting"><Seg value={profile.sex} onChange={(v) => setProfile({ sex: v })} options={[{ v: 'm', label: 'Male' }, { v: 'f', label: 'Female' }]} /></Field>
            <Field label="Map tiles" hint={profile.mapTiles === 'off' ? 'Off: nothing about where you train ever leaves this device.' : 'On: tile requests (CARTO/OpenStreetMap) reveal the map area you view.'}><Seg value={profile.mapTiles} onChange={(v) => setProfile({ mapTiles: v })} options={[{ v: 'off', label: 'Off (private)' }, { v: 'carto', label: 'CARTO dark' }]} /></Field>
          </div>
        </div>
      </Section>

      <Section n={2} total={6} glyph={GLYPH.performance} kicker="Thresholds & models" title="Physiology">
        {stale && (
          <div className="card" style={{ marginBottom: 16, borderColor: 'var(--arcx-caution-border)' }}>
            <div className="row spread wrap"><p style={{ fontSize: 14 }}>You changed the downhill credit. Grade-adjusted metrics stored with each activity need a recompute to reflect it.</p><button className="btn" onClick={() => void recomputeAll()}>Recompute history</button></div>
          </div>
        )}
        <div className="card">
          <div className="grid cols-3">
            <Field label="Max heart rate"><NumField value={profile.maxHR} onCommit={(v) => setProfile({ maxHR: v })} min={120} max={230} suffix="bpm" /></Field>
            <Field label="Resting heart rate"><NumField value={profile.restHR} onCommit={(v) => setProfile({ restHR: v })} min={30} max={100} suffix="bpm" /></Field>
            <Field label="Lactate-threshold HR" hint="Strava can't use this. We can."><NumField value={profile.lthr} onCommit={(v) => setProfile({ lthr: v })} min={100} max={220} suffix="bpm" /></Field>
            <Field label="FTP"><NumField value={profile.ftp} onCommit={(v) => setProfile({ ftp: v })} min={50} max={600} suffix="W" /></Field>
            <Field label={`Threshold pace (${paceUnit(units)})`} hint="Flat-equivalent. ≈ your 10K–half-marathon pace."><input className="input mono" value={paceTxt} onChange={(e) => setPaceTxt(e.target.value)} onBlur={commitPace} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></Field>
            <Field label="HR zone model"><select className="select" value={profile.hrZoneModel} onChange={(e) => setProfile({ hrZoneModel: e.target.value as HrZoneModel })}><option value="lthr">Friel — % of LTHR</option><option value="hrr">Karvonen — % HR reserve</option><option value="maxhr">% of max HR</option></select></Field>
            <Field label="Run load source" hint="Which signal feeds your fitness curve for runs"><select className="select" value={profile.runLoadSource} onChange={(e) => setProfile({ runLoadSource: e.target.value as RunLoadSource })}><option value="auto">Auto — HR, else pace</option><option value="hr">Heart rate</option><option value="pace">Pace (rTSS)</option></select></Field>
            <Field label={`Downhill credit · ${Math.round(profile.gapDownhillCredit * 100)} %`} hint="How much of the downhill benefit GAP applies"><input type="range" min={0} max={1} step={0.05} value={profile.gapDownhillCredit} onChange={(e) => setProfile({ gapDownhillCredit: +e.target.value })} /></Field>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>Tip: the <a href="#/performance">Performance</a> screen detects new bests and offers to raise thresholds for you. Unit: {unitM === KM ? 'per kilometre' : 'per mile'}.</p>
      </Section>

      <Section n={3} total={6} glyph={GLYPH.routes} kicker="Privacy zones" title="Hide the places that matter" lede="Share cards and GPX exports drop every point inside a zone. Nothing is ever uploaded, so there is no global heatmap leak to opt out of.">
        <div className="card">
          {privacy.length > 0 && (
            <div className="stack" style={{ marginBottom: 16 }}>
              {privacy.map((z) => (
                <div key={z.id} className="row spread" style={{ borderBottom: '1px solid #1c1c1f', paddingBottom: 8 }}>
                  <span>{z.name} <span className="muted mono" style={{ fontSize: 12 }}>{z.lat.toFixed(4)}, {z.lon.toFixed(4)} · {z.radius} m</span></span>
                  <button className="btn ghost sm" onClick={() => setPrivacy(privacy.filter((x) => x.id !== z.id))}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <div className="filters">
            <div className="field"><label className="lbl">Name</label><input className="input" style={{ width: 130 }} value={zone.name} onChange={(e) => setZone({ ...zone, name: e.target.value })} /></div>
            <div className="field"><label className="lbl">Latitude</label><input className="input mono" style={{ width: 130 }} value={zone.lat} onChange={(e) => setZone({ ...zone, lat: e.target.value })} /></div>
            <div className="field"><label className="lbl">Longitude</label><input className="input mono" style={{ width: 130 }} value={zone.lon} onChange={(e) => setZone({ ...zone, lon: e.target.value })} /></div>
            <div className="field"><label className="lbl">Radius (m)</label><input className="input mono" style={{ width: 100 }} value={zone.radius} onChange={(e) => setZone({ ...zone, radius: e.target.value })} /></div>
            <button className="btn ghost" onClick={guessHome} disabled={!entries.length}>Use my most common start</button>
            <button className="btn" onClick={addZone}>Add zone</button>
          </div>
        </div>
      </Section>

      <Section n={4} total={6} glyph={GLYPH.activities} kicker="Your data" title="Import, export, delete">
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div className="stack">
            <Dropzone onFiles={(f) => void importFiles(f)} title="Import files or a Strava export" hint=".gpx · .tcx · .fit · .gz · .zip (Strava archive with activities.csv)" />
            <div className="card">
              <div className="card-head"><div><h3>Demo athlete</h3><div className="sub">A year of synthetic runs and rides — clearly labelled "demo data".</div></div></div>
              <div className="row wrap"><button className="btn ghost" onClick={() => void loadDemo()}>Load demo athlete</button>{hasDemo && <button className="btn danger" onClick={() => void removeDemo()}>Remove demo data</button>}</div>
            </div>
          </div>
          <div className="stack">
            <div className="card">
              <div className="card-head"><div><h3>Export</h3><div className="sub">Open formats, no lock-in. {privacy.length ? 'Privacy zones are applied to GPX.' : 'Add privacy zones above to strip sensitive places.'}</div></div></div>
              <div className="row wrap">
                <button className="btn ghost" onClick={exportCsv} disabled={!core.acts.length}>Activities CSV</button>
                <button className="btn ghost" onClick={() => void exportGpx()} disabled={!core.acts.length || exporting}>{exporting ? 'Building zip…' : 'All GPX (zip)'}</button>
                <button className="btn ghost" onClick={exportJson} disabled={!core.acts.length}>Full backup JSON</button>
              </div>
            </div>
            <div className="card" style={{ borderColor: 'var(--arcx-negative-border)' }}>
              <div className="card-head"><div><h3>Delete everything</h3><div className="sub">Removes all activities, settings, segments and plans from this browser.</div></div></div>
              <button className="btn danger" onClick={() => { if (confirm('Delete ALL local ArcStride data? This cannot be undone.')) void resetAll(); }}>Delete all data</button>
            </div>
            <div className="card"><div className="row wrap" style={{ gap: 8 }}><Chip tone={isPersistent() ? 'pos' : 'warn'}>{isPersistent() ? 'IndexedDB storage active' : 'In-memory only (storage unavailable)'}</Chip><span className="muted" style={{ fontSize: 12.5 }}>{core.acts.length} activities · {entries.length} tracks</span></div>{!isPersistent() && <p style={{ fontSize: 13, marginTop: 8 }}>Your browser blocked persistent storage (private window?). Export a backup before closing this tab.</p>}</div>
          </div>
        </div>
      </Section>

      <Section n={5} total={6} glyph={GLYPH.today} kicker="Transparency" title="Every formula we use" lede="If a number on screen can't be traced to a line below, that's a bug.">
        <div className="stack">
          {FORMULAS.map(([t, f]) => (
            <details key={t} className="card" style={{ padding: '14px 20px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 500, listStyle: 'none' }}>{t}</summary>
              <pre style={{ margin: '12px 0 2px', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--arcx-text-muted)' }}>{f}</pre>
            </details>
          ))}
        </div>
      </Section>

      <Section n={6} total={6} glyph={GLYPH.goals} kicker="Honest limits" title="What ArcStride can't do (yet)">
        <div className="grid cols-2">
          <div className="card"><h3>Needs a server</h3><p style={{ fontSize: 14, marginTop: 6 }}>Global segment leaderboards, kudos/clubs/feed, and live tracking for friends. ArcStride's "leaderboards" rank you against your own history. The data layer is repository-shaped so sync can be added.</p></div>
          <div className="card"><h3>Needs native devices</h3><p style={{ fontSize: 14, marginTop: 6 }}>Live Segments on a watch, Beacon safety alerts, Bluetooth heart-rate straps and power meters. The web recorder uses phone GPS only. FIT/TCX/GPX import covers every watch and bike computer.</p></div>
          <div className="card"><h3>Needs external services</h3><p style={{ fontSize: 14, marginTop: 6 }}>Turn-by-turn route building (a routing engine), DEM-corrected elevation, weather, and sleep/HRV auto-import. Elevation here is GPS-smoothed with hysteresis and flagged accordingly.</p></div>
          <div className="card"><h3>Estimates, not diagnoses</h3><p style={{ fontSize: 14, marginTop: 6 }}>Readiness, injury-risk flags and predictions are transparent heuristics from published models. They're prompts to think, not medical advice.</p></div>
        </div>
        <p className="muted mono" style={{ marginTop: 20, fontSize: 11.5 }}>ArcStride 0.1 · built on the ArcArmor Design System (System A) · state: {state.activities.length} activities</p>
      </Section>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store/store';
import { checkDraft, discardRecording, finishRecording, getPoints, pauseRecording, restoreDraft, resumeRecording, saveRecording, startRecording, useRecorder } from '../lib/recorder';
import { navigate } from '../lib/router';
import { fmtDistU, fmtPace, fmtSpeed, fmtTime, paceUnit, speedUnit, isPaceSport, sportLabel, SPORT_GLYPH } from '../lib/units';
import type { Sport } from '../lib/types';
import { Chip, PageHead, Section, Seg, Tile, GLYPH } from '../ui/kit';
import { MapView } from '../ui/MapView';

export function RecordPage() {
  const profile = useStore((s) => s.profile);
  const units = profile.units;
  const rec = useRecorder((s) => s);
  const [sport, setSport] = useState<Sport>(rec.sport);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => void checkDraft(), []);

  const pts = getPoints();
  const track = useMemo(() => {
    const lat = Float64Array.from(pts.map((p) => p.lat!)),
      lon = Float64Array.from(pts.map((p) => p.lon!));
    return { id: 'rec', lat, lon };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.n, rec.status]);
  const here = pts.length ? { lat: pts[pts.length - 1].lat!, lon: pts[pts.length - 1].lon!, color: '#4ade80' } : null;
  const pace = isPaceSport(rec.sport);
  const avg = rec.elapsed > 0 ? rec.distance / rec.elapsed : 0;
  const gpsTone = rec.accuracy == null ? 'mute' : rec.accuracy <= 15 ? 'pos' : rec.accuracy <= 40 ? 'warn' : 'neg';

  const save = async () => {
    setSaving(true);
    const id = await saveRecording(name);
    setSaving(false);
    if (id) navigate(`/activity/${id}`);
  };

  return (
    <>
      <PageHead
        tag="Record"
        title={rec.status === 'idle' ? 'Start moving.' : rec.status === 'review' ? 'Nice work.' : rec.status === 'paused' ? 'Paused.' : rec.autoPaused ? 'Auto-paused.' : 'Recording.'}
        lede={rec.status === 'idle' ? "Records with your device's GPS right in the browser. Keep this tab open (a wake-lock keeps the screen on where supported); an unsaved draft is recovered automatically if the tab closes." : undefined}
      />

      {rec.error && <div className="card" style={{ marginTop: 20, borderColor: 'var(--arcx-negative-border)' }}><p style={{ color: 'var(--arcx-negative)', fontSize: 14 }}>{rec.error}</p></div>}

      {rec.status === 'idle' && (
        <Section n={1} total={1} glyph={GLYPH.record} kicker="Ready" title="Choose a sport">
          {rec.hasDraft && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--arcx-caution-border)' }}>
              <div className="row spread wrap"><div><h3>Unsaved recording found</h3><p style={{ fontSize: 13.5 }}>The tab was closed before you finished. Review and save it, or discard it.</p></div><div className="row"><button className="btn" onClick={() => void restoreDraft()}>Review & save</button><button className="btn ghost" onClick={() => void discardRecording()}>Discard</button></div></div>
            </div>
          )}
          <div className="card lg" style={{ display: 'grid', gap: 20, justifyItems: 'start' }}>
            <Seg value={sport} onChange={setSport} options={(['run', 'ride', 'walk', 'hike'] as Sport[]).map((s) => ({ v: s, label: `${SPORT_GLYPH[s]} ${sportLabel(s)}` }))} />
            <button className="btn" style={{ fontSize: 17, padding: '12px 34px' }} onClick={() => void startRecording(sport)}><span className="dot" /> Start recording</button>
            <p style={{ fontSize: 13 }}>Needs HTTPS (or localhost) and location permission. Your track is only saved to this device.</p>
          </div>
        </Section>
      )}

      {(rec.status === 'recording' || rec.status === 'paused') && (
        <Section n={1} total={1} glyph={GLYPH.record} kicker={`${sportLabel(rec.sport)} · live`} title={<span className="mono" style={{ letterSpacing: 0 }}>{fmtTime(rec.elapsed)}</span>}
          actions={<Chip tone={gpsTone}>GPS {rec.accuracy == null ? 'searching…' : `±${Math.round(rec.accuracy)} m`}</Chip>}>
          <div className="grid cols-3 keep" style={{ marginBottom: 16 }}>
            <Tile label="Distance" big value={fmtDistU(rec.distance, units, 2).split(' ')[0]} unit={units === 'metric' ? 'km' : 'mi'} />
            <Tile label={pace ? 'Pace now' : 'Speed now'} big value={pace ? fmtPace(rec.speed, units) : fmtSpeed(rec.speed, units)} unit={pace ? paceUnit(units) : speedUnit(units)} />
            <Tile label={pace ? 'Avg pace' : 'Avg speed'} big value={pace ? fmtPace(avg, units) : fmtSpeed(avg, units)} unit={pace ? paceUnit(units) : speedUnit(units)} />
          </div>
          <MapView tracks={[{ id: 'rec', lat: track.lat, lon: track.lon }]} height={300} fitKey={`rec${Math.floor(rec.n / 12)}`} markers={here ? [here] : []} basemap={profile.mapTiles} ariaLabel="Live track" />
          <div className="row" style={{ marginTop: 20, gap: 12 }}>
            {rec.status === 'recording' ? <button className="btn ghost" onClick={pauseRecording}>Pause</button> : <button className="btn" onClick={resumeRecording}>Resume</button>}
            <button className="btn" onClick={() => void finishRecording()}>Finish</button>
            <button className="btn danger" onClick={() => { if (confirm('Discard this recording?')) void discardRecording(); }}>Discard</button>
          </div>
        </Section>
      )}

      {rec.status === 'review' && (
        <Section n={1} total={1} glyph={GLYPH.record} kicker="Review" title="Save this activity?">
          <div className="grid cols-3 keep" style={{ marginBottom: 16 }}>
            <Tile label="Distance" value={fmtDistU(rec.distance, units, 2).split(' ')[0]} unit={units === 'metric' ? 'km' : 'mi'} />
            <Tile label="Time" value={fmtTime(rec.elapsed)} />
            <Tile label={pace ? 'Avg pace' : 'Avg speed'} value={pace ? fmtPace(avg, units) : fmtSpeed(avg, units)} unit={pace ? paceUnit(units) : speedUnit(units)} />
          </div>
          <div className="card"><div className="row wrap"><input className="input" style={{ maxWidth: 360 }} placeholder={`${sportLabel(rec.sport)} name (optional)`} value={name} onChange={(e) => setName(e.target.value)} /><button className="btn" disabled={saving} onClick={() => void save()}>{saving ? 'Analysing…' : 'Save to library'}</button><button className="btn danger" onClick={() => void discardRecording()}>Discard</button></div></div>
        </Section>
      )}
    </>
  );
}

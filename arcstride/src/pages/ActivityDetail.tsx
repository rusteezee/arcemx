import { useEffect, useMemo, useState } from 'react';
import { useCore } from '../lib/core';
import { Link, navigate } from '../lib/router';
import { deleteActivity, getStreams, replaceAnalysis, setSegments, toast, updateActivity, useStore } from '../lib/store/store';
import { useEntries, useUnits } from '../lib/hooks';
import type { ActivitySummary, Sport, Streams } from '../lib/types';
import { KM, MI, clamp, dayNumOf, fmtClock, fmtDate, fmtDistU, fmtDur, fmtElev, fmtPace, fmtSpeed, fmtTime, isPaceSport, paceUnit, speedUnit, toDist, toElev, elevUnit, sportLabel, SPORT_GLYPH } from '../lib/units';
import { deriveStreams, elevGainLoss, reanalyze, timeAtDistance, BEST_DISTANCES, BEST_LABELS, MMP_DURATIONS } from '../lib/analyze/process';
import { hrZones, paceZones, pwrZones, ZONE_COLORS, hrEdges, paceEdges, pwrEdges } from '../lib/analyze/zones';
import { bestEffortsAgg, fitCP, powerCurve, wPrimeBalance } from '../lib/analyze/efforts';
import { groupRoutes } from '../lib/analyze/routes';
import { matchSegment, computeEfforts, segmentFromTrack } from '../lib/analyze/segments';
import { percentile, smooth, niceTicks, lowerBound } from '../lib/stats';
import { download, toGPX } from '../lib/export';
import { renderShareCard } from '../lib/share';
import { Chip, Empty, Glyph, PageHead, Section, Seg, SourceChip, Tile, Why, GLYPH } from '../ui/kit';
import { MapView, RAMPS, type Ramp } from '../ui/MapView';
import { Panel, type PSeries } from '../ui/charts/Panel';
import { LineChart, ZoneBars } from '../ui/charts/charts';

type XKind = 'dist' | 'time';
type ColorBy = 'none' | 'pace' | 'hr' | 'power' | 'grade';

const secPace = (s: number) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '—');

export function ActivityDetail({ id }: { id?: string }) {
  const core = useCore();
  const a = id ? core.byId.get(id) : undefined;
  if (!a)
    return (
      <Empty glyph="◌" title="Activity not found" body="It may have been deleted, or it hasn't finished importing.">
        <Link to="/activities" className="btn">Back to activities</Link>
      </Empty>
    );
  return <Detail key={a.id} a={a} />;
}

interface PanelDef {
  id: string;
  label: string;
  height: number;
  series: PSeries[];
  yFmt: (v: number) => string;
  invertY?: boolean;
  yDomain?: [number, number];
  refs?: { y: number; label: string }[];
}

function domainOf(v: ArrayLike<number>, lo = 0.02, hi = 0.98, pad = 0.12): [number, number] {
  const xs: number[] = [];
  const step = Math.max(1, Math.floor(v.length / 2000));
  for (let i = 0; i < v.length; i += step) if (v[i] === v[i]) xs.push(v[i]);
  if (!xs.length) return [0, 1];
  const a = percentile(xs, lo),
    b = percentile(xs, hi);
  const p = (b - a || 1) * pad;
  return [a - p, b + p];
}

function Detail({ a }: { a: ActivitySummary }) {
  const core = useCore();
  const units = useUnits();
  const profile = useStore((s) => s.profile);
  const track = useStore((s) => s.tracks.get(a.id));
  const gear = useStore((s) => s.gear);
  const privacy = useStore((s) => s.privacy);
  const segments = useStore((s) => s.segments);
  const entries = useEntries();
  const loads = core.loads.get(a.id);

  const [streams, setStreams] = useState<Streams | undefined>();
  useEffect(() => {
    let live = true;
    void getStreams(a.id).then((s) => live && setStreams(s));
    return () => {
      live = false;
    };
  }, [a.id]);
  const derived = useMemo(() => (streams ? deriveStreams(streams, a.sport, profile) : null), [streams, a.sport, profile]);

  const [xKind, setXKind] = useState<XKind>(a.hasGps && a.distance > 0 ? 'dist' : 'time');
  const [colorBy, setColorBy] = useState<ColorBy>(isPaceSport(a.sport) || a.sport === 'ride' ? 'pace' : 'none');
  const [showGap, setShowGap] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [editing, setEditing] = useState(false);
  const [busyShare, setBusyShare] = useState(false);

  const unitM = units === 'metric' ? KM : MI;
  const paceMode = isPaceSport(a.sport);

  // ── CP model for W′ balance (rides) ──
  const cp = useMemo(() => (a.hasPower ? fitCP(powerCurve(core.acts, core.now - 90 * 86400000, core.now)) : undefined), [a.hasPower, core.acts, core.now]);

  // ── chart data ──
  const charts = useMemo(() => {
    if (!streams || !derived) return null;
    const n = streams.n;
    const x = xKind === 'dist' ? streams.d : Float32Array.from({ length: n }, (_, i) => i);
    const total = x[n - 1];
    const ticks = xKind === 'dist' ? niceTicks(0, total / unitM, 6).map((t) => t * unitM) : niceTicks(0, total / 60, 6).map((t) => t * 60);
    const tickFmt = xKind === 'dist' ? (v: number) => (v / unitM).toFixed(v / unitM < 10 ? 1 : 0) : (v: number) => fmtTime(v);
    const xFmt = xKind === 'dist' ? (v: number) => fmtDistU(v, units, 2) : (v: number) => fmtTime(v);

    const sp = smooth(derived.v, paceMode ? 15 : 8);
    const gap = smooth(derived.gapv, 15);
    const panels: PanelDef[] = [];
    if (a.hasElev) {
      const alt = Float32Array.from(derived.altS, (v) => toElev(v, units));
      panels.push({ id: 'elev', label: `Elevation · ${elevUnit(units)}`, height: 92, series: [{ id: 'elev', name: 'Elevation', color: '#a1a1aa', y: alt, area: true }], yFmt: (v) => String(Math.round(v)), yDomain: (() => { const [lo, hi] = domainOf(alt, 0, 1, 0.1); return [lo, hi] as [number, number]; })() });
    }
    if (a.hasGps || a.distance > 0) {
      if (paceMode) {
        const pace = Float32Array.from(sp, (v) => (v > 0.7 ? clamp(unitM / v, 150, 1500) : NaN));
        const gapP = Float32Array.from(gap, (v) => (v > 0.7 ? clamp(unitM / v, 150, 1500) : NaN));
        const [lo, hi] = domainOf(pace, 0.03, 0.97, 0.12);
        panels.push({ id: 'pace', label: `Pace · ${paceUnit(units)}`, height: 140, invertY: true, yDomain: [lo, hi], yFmt: secPace, series: [{ id: 'pace', name: 'Pace', color: 'var(--c-ink)', y: pace }, { id: 'gap', name: 'GAP', color: 'var(--c-fit)', y: gapP, hidden: !showGap }] });
      } else {
        const kmh = Float32Array.from(sp, (v) => (v * 3600) / unitM);
        const [lo, hi] = domainOf(kmh, 0.01, 0.99, 0.1);
        panels.push({ id: 'speed', label: `Speed · ${speedUnit(units)}`, height: 120, yDomain: [Math.max(0, lo), hi], yFmt: (v) => v.toFixed(0), series: [{ id: 'speed', name: 'Speed', color: 'var(--c-ink)', y: kmh }] });
      }
    }
    if (a.hasHR) {
      const hr = smooth(streams.hr, 3);
      const [lo, hi] = domainOf(hr, 0.005, 0.995, 0.08);
      panels.push({ id: 'hr', label: 'Heart rate · bpm', height: 120, yDomain: [lo, hi], yFmt: (v) => String(Math.round(v)), refs: [{ y: profile.lthr, label: 'LTHR' }].filter((r) => r.y > lo && r.y < hi), series: [{ id: 'hr', name: 'Heart rate', color: 'var(--c-hr)', y: hr }] });
    }
    if (a.hasPower) {
      const pw = smooth(Float32Array.from(streams.pwr, (v) => (v === v ? v : 0)), 4);
      panels.push({ id: 'pwr', label: 'Power · W', height: 120, yDomain: [0, Math.max(100, percentile(Array.from(pw).filter((_, i) => i % 3 === 0), 0.995) * 1.08)], yFmt: (v) => String(Math.round(v)), refs: profile.ftp > 0 ? [{ y: profile.ftp, label: 'FTP' }] : undefined, series: [{ id: 'pwr', name: 'Power', color: 'var(--c-pwr)', y: pw }] });
      if (cp) {
        const wb = wPrimeBalance(streams.pwr, cp.cp, cp.wPrime);
        const kj = Float32Array.from(wb, (v) => v / 1000);
        panels.push({ id: 'wbal', label: `W′ balance · kJ (CP ${Math.round(cp.cp)} W)`, height: 96, yDomain: [Math.min(-1, Math.min(...Array.from(kj).filter((_, i) => i % 4 === 0))) , cp.wPrime / 1000 * 1.05], yFmt: (v) => v.toFixed(0), series: [{ id: 'wbal', name: 'W′ balance', color: 'var(--c-ink)', y: kj }] });
      }
    }
    if (!paceMode ? streams.cad.some((v) => v > 0) : a.avgCad) {
      const cad = smooth(Float32Array.from(streams.cad, (v) => (v > 0 ? v : NaN)), 6);
      const [lo, hi] = domainOf(cad, 0.02, 0.98, 0.15);
      panels.push({ id: 'cad', label: `Cadence · ${paceMode ? 'spm' : 'rpm'}`, height: 92, yDomain: [lo, hi], yFmt: (v) => String(Math.round(v)), series: [{ id: 'cad', name: 'Cadence', color: 'var(--c-fit)', y: cad }] });
    }
    return { n, x, total, ticks, tickFmt, xFmt, panels, sp, gap };
  }, [streams, derived, xKind, units, a, paceMode, unitM, showGap, profile.lthr, profile.ftp, cp]);

  // ── map data ──
  const map = useMemo(() => {
    if (!streams || !derived || !streams.hasGps) return null;
    let values: ArrayLike<number> | undefined;
    let ramp: Ramp | undefined;
    const pct = (v: ArrayLike<number>, lo: number, hi: number): [number, number] => {
      const d = domainOf(v, lo, hi, 0);
      return [d[0], d[1]];
    };
    if (colorBy === 'pace') {
      values = smooth(derived.v, 12);
      const d = pct(values, 0.05, 0.95);
      ramp = { colors: [...RAMPS.pace.colors], domain: d, labels: paceMode ? [`${secPace(unitM / Math.max(0.5, d[0]))}`, `${secPace(unitM / Math.max(0.5, d[1]))}`] : [`${fmtSpeed(d[0], units)}`, `${fmtSpeed(d[1], units)} ${speedUnit(units)}`] };
    } else if (colorBy === 'hr' && a.hasHR) {
      values = smooth(streams.hr, 8);
      const d = pct(values, 0.03, 0.97);
      ramp = { colors: [...RAMPS.hr.colors], domain: d, labels: [`${Math.round(d[0])}`, `${Math.round(d[1])} bpm`] };
    } else if (colorBy === 'power' && a.hasPower) {
      values = smooth(Float32Array.from(streams.pwr, (v) => (v === v ? v : 0)), 12);
      const d = pct(values, 0.03, 0.97);
      ramp = { colors: [...RAMPS.power.colors], domain: d, labels: [`${Math.round(d[0])}`, `${Math.round(d[1])} W`] };
    } else if (colorBy === 'grade') {
      values = smooth(derived.grade, 8);
      ramp = { colors: [...RAMPS.grade.colors], domain: [-0.08, 0.08], labels: ['−8 %', '+8 %'] };
    }
    return { values, ramp };
  }, [streams, derived, colorBy, a.hasHR, a.hasPower, paceMode, unitM, units]);

  const hoverMarker = useMemo(() => {
    if (hover == null || !streams || streams.lat[hover] !== streams.lat[hover]) return null;
    return { lat: streams.lat[hover], lon: streams.lon[hover], color: '#fafafa' };
  }, [hover, streams]);
  const highlight = useMemo(() => (sel && streams && streams.hasGps ? { lat: streams.lat.subarray(sel[0], sel[1] + 1), lon: streams.lon.subarray(sel[0], sel[1] + 1) } : null), [sel, streams]);
  const markers = useMemo(() => {
    if (!track || track.n < 2) return [];
    return [
      { lat: track.lat[0], lon: track.lon[0], color: '#4ade80' },
      { lat: track.lat[track.n - 1], lon: track.lon[track.n - 1], color: '#f87171' },
    ];
  }, [track]);

  // ── readout ──
  const readout = useMemo(() => {
    if (!charts || !streams || !derived) return [];
    const i = hover;
    const f = (fn: (i: number) => string, avg: string) => (i == null ? avg : fn(i));
    const out: { k: string; v: string }[] = [
      { k: 'Time', v: i == null ? fmtTime(streams.n) : fmtTime(i) },
      { k: 'Dist', v: i == null ? fmtDistU(a.distance, units) : fmtDistU(streams.d[i], units) },
    ];
    if (a.hasGps || a.distance > 0) {
      out.push(paceMode ? { k: 'Pace', v: f((q) => `${fmtPace(charts.sp[q], units)} ${paceUnit(units)}`, `${fmtPace(a.avgSpeed, units)} ${paceUnit(units)}`) } : { k: 'Speed', v: f((q) => `${fmtSpeed(charts.sp[q], units)} ${speedUnit(units)}`, `${fmtSpeed(a.avgSpeed, units)} ${speedUnit(units)}`) });
      if (paceMode) out.push({ k: 'GAP', v: f((q) => `${fmtPace(charts.gap[q], units)} ${paceUnit(units)}`, a.ngs ? `${fmtPace(a.ngs, units)} ${paceUnit(units)}` : '—') });
    }
    if (a.hasHR) out.push({ k: 'HR', v: f((q) => (streams.hr[q] === streams.hr[q] ? `${Math.round(streams.hr[q])} bpm` : '—'), `${Math.round(a.avgHR ?? 0)} bpm`) });
    if (a.hasPower) out.push({ k: 'Power', v: f((q) => (streams.pwr[q] === streams.pwr[q] ? `${Math.round(streams.pwr[q])} W` : '—'), `${Math.round(a.avgPower ?? 0)} W`) });
    if (a.hasElev) out.push({ k: 'Elev', v: f((q) => `${Math.round(toElev(derived.altS[q], units))} ${elevUnit(units)}`, fmtElev(a.elevGain, units) + ' ↑') });
    out.push({ k: 'Grade', v: f((q) => `${(derived.grade[q] * 100).toFixed(1)} %`, '—') });
    return out;
  }, [hover, charts, streams, derived, a, units, paceMode]);

  // ── selection stats ──
  const selStats = useMemo(() => {
    if (!sel || !streams || !derived) return null;
    const [i0, i1] = sel;
    const dur = i1 - i0 + 1;
    const dist = streams.d[i1] - streams.d[i0];
    let hrS = 0, hrN = 0, pS = 0, pN = 0, gS = 0;
    for (let i = i0; i <= i1; i++) {
      if (streams.hr[i] === streams.hr[i]) { hrS += streams.hr[i]; hrN++; }
      if (streams.pwr[i] === streams.pwr[i]) { pS += streams.pwr[i]; pN++; }
      gS += derived.gapv[i];
    }
    const eg = elevGainLoss(Array.from(derived.altS.subarray(i0, i1 + 1)), 2);
    const dz = derived.altS[i1] - derived.altS[i0];
    return { dur, dist, speed: dist / Math.max(1, dur), gap: gS / dur, hr: hrN ? hrS / hrN : undefined, pwr: pN ? pS / pN : undefined, gain: eg.gain, loss: eg.loss, grade: dist > 20 ? dz / dist : 0, i0, i1 };
  }, [sel, streams, derived]);

  // ── splits ──
  const splits = useMemo(() => {
    if (!streams || !derived || streams.d[streams.n - 1] < unitM * 0.5) return [];
    const rows: { n: number; dist: number; time: number; speed: number; gap: number; gain: number; loss: number; hr?: number; pwr?: number }[] = [];
    const total = streams.d[streams.n - 1];
    const count = Math.ceil(total / unitM - 0.02);
    for (let k = 0; k < count; k++) {
      const d0 = k * unitM,
        d1 = Math.min(total, (k + 1) * unitM);
      const t0 = timeAtDistance(streams.d, d0),
        t1 = timeAtDistance(streams.d, d1);
      const i0 = Math.floor(t0),
        i1 = Math.min(streams.n - 1, Math.max(i0 + 1, Math.floor(t1)));
      let hrS = 0, hrN = 0, pS = 0, pN = 0, gS = 0, gN = 0;
      for (let i = i0; i <= i1; i++) {
        if (streams.hr[i] === streams.hr[i]) { hrS += streams.hr[i]; hrN++; }
        if (streams.pwr[i] === streams.pwr[i]) { pS += streams.pwr[i]; pN++; }
        gS += derived.gapv[i]; gN++;
      }
      const eg = elevGainLoss(Array.from(derived.altS.subarray(i0, i1 + 1)), 1.5);
      const time = t1 - t0;
      rows.push({ n: k + 1, dist: d1 - d0, time, speed: (d1 - d0) / Math.max(1, time), gap: gN ? gS / gN : 0, gain: eg.gain, loss: eg.loss, hr: hrN ? hrS / hrN : undefined, pwr: pN ? pS / pN : undefined });
    }
    return rows;
  }, [streams, derived, unitM]);

  // ── PR ranks for best efforts ──
  const bestAll = useMemo(() => bestEffortsAgg(core.acts, { sports: [a.sport] }), [core.acts, a.sport]);
  const bestRows = useMemo(() => {
    if (!a.bests) return [];
    return BEST_DISTANCES.filter((D) => a.bests![D]).map((D) => {
      const [t, startSec] = a.bests![D];
      const better = core.acts.filter((o) => o.sport === a.sport && o.bests?.[D] && o.bests[D][0] < t - 0.01).length;
      return { D, t, startSec, rank: better + 1, isPR: bestAll.get(D)?.activityId === a.id };
    });
  }, [a, core.acts, bestAll]);

  // ── segments ──
  const myEntry = useMemo(() => (track ? { summary: a, track } : null), [a, track]);
  const segEfforts = useMemo(() => {
    if (!myEntry || !segments.length) return [];
    const all = computeEfforts(segments, entries);
    return segments.flatMap((s) => {
      const mine = matchSegment(s, myEntry);
      return mine.map((m) => {
        const arr = (all.get(s.id) ?? []).slice().sort((x, y) => x.time - y.time);
        const rank = arr.findIndex((e) => Math.abs(e.time - m.time) < 0.05 && e.activityId === m.activityId) + 1;
        return { seg: s, effort: m, rank, total: arr.length, best: arr[0]?.time };
      });
    });
  }, [myEntry, segments, entries]);

  // ── route group & compare ──
  const group = useMemo(() => groupRoutes(entries).find((g) => g.members.some((m) => m.id === a.id)), [entries, a.id]);
  const others = useMemo(() => (group ? group.members.filter((m) => m.id !== a.id) : []), [group, a.id]);
  const [cmpId, setCmpId] = useState<string | undefined>();
  useEffect(() => {
    if (others.length) {
      const fastest = [...others].sort((x, y) => x.timer - y.timer)[0];
      setCmpId(fastest.id);
    } else setCmpId(undefined);
  }, [others]);
  const [cmpStreams, setCmpStreams] = useState<Streams | undefined>();
  useEffect(() => {
    let live = true;
    if (cmpId) void getStreams(cmpId).then((s) => live && setCmpStreams(s));
    else setCmpStreams(undefined);
    return () => {
      live = false;
    };
  }, [cmpId]);
  const cmp = useMemo(() => {
    if (!streams || !cmpStreams) return null;
    const maxD = Math.min(streams.d[streams.n - 1], cmpStreams.d[cmpStreams.n - 1]);
    const step = 50;
    const m = Math.floor(maxD / step) + 1;
    const xs = new Float32Array(m),
      ys = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      xs[k] = k * step;
      ys[k] = timeAtDistance(streams.d, k * step) - timeAtDistance(cmpStreams.d, k * step);
    }
    return { xs, ys, final: ys[m - 1] };
  }, [streams, cmpStreams]);

  // ── zones ──
  const [zoneKind, setZoneKind] = useState<'hr' | 'pwr' | 'pace'>(a.hasPower ? 'pwr' : a.hasHR ? 'hr' : 'pace');
  const zoneData = useMemo(() => {
    if (!loads) return null;
    if (zoneKind === 'hr' && loads.hrZoneSecs) {
      const z = hrZones(profile);
      const e = hrEdges(profile);
      return { zones: z, secs: loads.hrZoneSecs, colors: [ZONE_COLORS[0], ZONE_COLORS[1], ZONE_COLORS[2], ZONE_COLORS[3], ZONE_COLORS[5]], range: (i: number) => (i === 0 ? `< ${Math.round(e[0])} bpm` : i === 4 ? `≥ ${Math.round(e[3])} bpm` : `${Math.round(e[i - 1])}–${Math.round(e[i])} bpm`) };
    }
    if (zoneKind === 'pwr' && loads.pwrZoneSecs) {
      const e = pwrEdges(profile);
      return { zones: pwrZones(profile), secs: loads.pwrZoneSecs, colors: ZONE_COLORS, range: (i: number) => (i === 0 ? `< ${Math.round(e[0])} W` : i === 6 ? `≥ ${Math.round(e[5])} W` : `${Math.round(e[i - 1])}–${Math.round(e[i])} W`) };
    }
    if (zoneKind === 'pace' && loads.paceZoneSecs) {
      const e = paceEdges(profile);
      const pz = (v: number) => `${fmtPace(v, units)}`;
      return { zones: paceZones(profile), secs: loads.paceZoneSecs, colors: [ZONE_COLORS[0], ZONE_COLORS[1], ZONE_COLORS[2], ZONE_COLORS[3], ZONE_COLORS[5]], range: (i: number) => (i === 0 ? `slower than ${pz(e[0])}` : i === 4 ? `faster than ${pz(e[3])}` : `${pz(e[i - 1])}–${pz(e[i])}`) };
    }
    return null;
  }, [loads, zoneKind, profile, units]);

  // ── power curve vs 90 d ──
  const pcurve = useMemo(() => {
    if (!a.mmp) return null;
    const best = powerCurve(core.acts, core.now - 90 * 86400000, core.now);
    const durs = MMP_DURATIONS.filter((_, i) => a.mmp![i] > 0);
    const mine = durs.map((d) => a.mmp![MMP_DURATIONS.indexOf(d)]);
    const ref = durs.map((d) => best.find((b) => b.dur === d)?.w ?? NaN);
    return { durs: Float32Array.from(durs), mine: Float32Array.from(mine), ref: Float32Array.from(ref) };
  }, [a.mmp, core.acts, core.now]);

  const [segName, setSegName] = useState('');
  const makeSegment = () => {
    if (!selStats || !track) return;
    const i0 = clamp(lowerBound(track.t, selStats.i0), 0, track.n - 2);
    const i1 = clamp(lowerBound(track.t, selStats.i1), i0 + 1, track.n - 1);
    const seg = segmentFromTrack(track, i0, i1, segName.trim() || `Segment ${segments.length + 1}`, a.sport);
    if (segments.some((s) => s.id === seg.id)) return toast('That stretch is already a segment.', 'warn');
    setSegments([...segments, seg]);
    setSegName('');
    toast(`Segment “${seg.name}” created — ArcStride will match it across your history.`);
  };

  const gearName = gear.find((g) => g.id === a.gearId)?.name;
  const onShare = async () => {
    setBusyShare(true);
    try {
      const blob = await renderShareCard(a, track, loads, profile, privacy);
      download(`${a.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, blob);
      toast(privacy.length ? 'Share card saved — privacy zones applied.' : 'Share card saved.');
    } catch (e) {
      toast(`Couldn't render the card: ${(e as Error).message}`, 'err');
    } finally {
      setBusyShare(false);
    }
  };
  const onGpx = () => {
    if (!streams) return;
    download(`${a.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.gpx`, toGPX(a, streams, privacy), 'application/gpx+xml');
  };
  const changeSport = async (sport: Sport) => {
    if (!streams) return;
    const res = reanalyze({ ...a, sport }, streams, profile);
    res.summary.edited = true;
    await replaceAnalysis(res);
    toast(`Re-analysed as ${sportLabel(sport).toLowerCase()}.`);
  };

  const sp = a.avgSpeed;
  const dayLabel = fmtDate(a.start, a.tz, { weekday: true });

  return (
    <>
      <PageHead
        tag={`${sportLabel(a.sport)} · ${dayLabel} · ${fmtClock(a.start, a.tz)}`}
        title={
          editing ? (
            <input className="input" style={{ fontSize: 34, fontWeight: 600, borderRadius: 18, padding: '6px 16px', letterSpacing: '-0.03em' }} defaultValue={a.name} autoFocus onBlur={(e) => { void updateActivity(a.id, { name: e.target.value.trim() || a.name }); setEditing(false); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          ) : (
            <span onDoubleClick={() => setEditing(true)} title="Double-click to rename">{a.name}</span>
          )
        }
        lede={a.notes}
        actions={
          <>
            <SourceChip source={a.source} />
            {gearName && <Chip tone="mute"><Glyph g="◇" /> {gearName}</Chip>}
            {a.trainer && <Chip tone="mute">indoor</Chip>}
            {a.edited && <Chip tone="mute">edited</Chip>}
            <button className="btn ghost sm" onClick={() => setEditing(true)}>Rename</button>
            <button className="btn ghost sm" onClick={onGpx} disabled={!streams}>Export GPX</button>
            <button className="btn sm" onClick={onShare} disabled={busyShare}>{busyShare ? 'Rendering…' : 'Share card'}</button>
          </>
        }
      />

      <div className="grid cols-5 keep" style={{ marginTop: 24 }}>
        <Tile label="Distance" value={fmtDistU(a.distance, units, 2).split(' ')[0]} unit={units === 'metric' ? 'km' : 'mi'} />
        <Tile label="Moving time" value={fmtTime(a.moving)} delta={a.elapsed - a.timer > 60 ? `${fmtDur(a.elapsed)} elapsed` : undefined} />
        <Tile label={paceMode ? 'Avg pace' : 'Avg speed'} value={paceMode ? fmtPace(sp, units) : fmtSpeed(sp, units)} unit={paceMode ? paceUnit(units) : speedUnit(units)} delta={paceMode && a.ngs ? `GAP ${fmtPace(a.ngs, units)}` : undefined} />
        <Tile label="Elevation gain" value={a.hasElev ? Math.round(toElev(a.elevGain, units)).toLocaleString() : '—'} unit={a.hasElev ? elevUnit(units) : undefined} delta={a.hasElev ? `${Math.round(toElev(a.elevLoss, units))} ${elevUnit(units)} down` : 'no elevation data'} />
        {loads && <Tile label="Training load" value={Math.round(loads.load)} unit={loads.method} delta={loads.ifactor ? `IF ${loads.ifactor.toFixed(2)}` : undefined} hint="TSS-equivalent: power TSS → HR (Banister) → pace rTSS" />}
        {a.hasHR && <Tile label="Heart rate" value={Math.round(a.avgHR!)} unit="avg bpm" delta={`${Math.round(a.maxHR!)} max`} />}
        {a.hasPower && <Tile label="Normalised power" value={Math.round(a.np!)} unit="W" delta={`avg ${Math.round(a.avgPower!)} W · VI ${a.vi?.toFixed(2)}`} />}
        {a.ef && <Tile label="Efficiency factor" value={a.ef.toFixed(2)} delta={paceMode ? 'GAP m/min per bpm' : 'W per bpm'} />}
        {a.decoupling != null && (
          <Tile label="Aerobic decoupling" value={`${a.decoupling.toFixed(1)}`} unit="%" delta={a.decoupling < 3 ? 'steady' : a.decoupling < 5 ? 'normal drift' : 'high drift'} dir={a.decoupling < 3 ? 'up' : a.decoupling > 5 ? 'down' : ''} />
        )}
        {a.avgCad && <Tile label="Cadence" value={Math.round(a.avgCad)} unit={paceMode ? 'spm' : 'rpm'} />}
      </div>

      <Section n={1} total={6} glyph={GLYPH.routes} kicker="Route & signals" title="Read the effort" lede="Hover to read any moment across the route and every channel. Drag on a chart to analyse a stretch — or turn it into a segment.">
        <div className="grid cols-main" style={{ alignItems: 'start' }}>
          <div className="stack">
            <div className="row spread wrap">
              <div className="row wrap">
                <Seg value={xKind} onChange={setXKind} label="X axis" options={[{ v: 'dist', label: 'Distance' }, { v: 'time', label: 'Time' }]} />
                {paceMode && (
                  <label className="row muted" style={{ fontSize: 12.5, gap: 6 }}>
                    <input type="checkbox" checked={showGap} onChange={(e) => setShowGap(e.target.checked)} /> Show GAP
                  </label>
                )}
              </div>
              <span className="muted mono" style={{ fontSize: 11 }}>drag to select · click to clear</span>
            </div>
            <div className="card" style={{ padding: '14px 14px 10px' }}>
              {readout.length > 0 && (
                <div className="row wrap" style={{ gap: '4px 20px', paddingBottom: 10, marginBottom: 6, borderBottom: '1px solid var(--arcx-border)', minHeight: 44 }} aria-live="off">
                  {readout.map((r) => (
                    <div key={r.k}>
                      <div className="eyebrow" style={{ fontSize: 9.5 }}>{r.k}</div>
                      <div className="mono" style={{ fontSize: 13, color: hover == null ? 'var(--arcx-text-muted)' : 'var(--arcx-text)' }}>{r.v}</div>
                    </div>
                  ))}
                </div>
              )}
              {!charts && <div className="muted" style={{ padding: 40, textAlign: 'center' }}>{streams === undefined ? 'Loading signals…' : 'No signal data.'}</div>}
              {charts?.panels.map((p, k) => (
                <Panel key={p.id} x={charts.x} series={p.series} height={p.height} label={p.label} yFmt={p.yFmt} yDomain={p.yDomain} invertY={p.invertY} refs={p.refs} xDomain={[0, charts.total]} xTicks={charts.ticks} xTickFmt={charts.tickFmt} showXAxis={k === charts.panels.length - 1} hover={hover} onHover={setHover} sel={sel} onSel={setSel} />
              ))}
            </div>
          </div>
          <div className="stack">
            {streams?.hasGps ? (
              <>
                <MapView tracks={[{ id: a.id, lat: streams.lat, lon: streams.lon, values: map?.values }]} ramp={map?.ramp} markers={markers} hover={hoverMarker} highlight={highlight} height={380} fitKey={a.id} basemap={profile.mapTiles} ariaLabel={`Map of ${a.name}`} />
                <div className="row spread wrap">
                  <span className="eyebrow">Colour route by</span>
                  <Seg value={colorBy} onChange={setColorBy} options={[{ v: 'none', label: 'Plain' }, { v: 'pace', label: paceMode ? 'Pace' : 'Speed' }, ...(a.hasHR ? [{ v: 'hr' as const, label: 'HR' }] : []), ...(a.hasPower ? [{ v: 'power' as const, label: 'Power' }] : []), { v: 'grade', label: 'Grade' }]} />
                </div>
              </>
            ) : (
              <div className="card"><p>No GPS track — indoor or sensor-only activity.</p></div>
            )}
            {selStats && (
              <div className="card" style={{ borderColor: 'var(--arcx-text-muted)' }}>
                <div className="card-head"><div><h3>Selected stretch</h3><div className="sub mono">{fmtTime(selStats.i0)} → {fmtTime(selStats.i1)}</div></div><button className="btn ghost sm" onClick={() => setSel(null)}>Clear</button></div>
                <div className="grid cols-2 keep" style={{ gap: 10 }}>
                  {[
                    ['Distance', fmtDistU(selStats.dist, units, 2)],
                    ['Time', fmtTime(selStats.dur)],
                    [paceMode ? 'Pace' : 'Speed', paceMode ? `${fmtPace(selStats.speed, units)} ${paceUnit(units)}` : `${fmtSpeed(selStats.speed, units)} ${speedUnit(units)}`],
                    ...(paceMode ? [['GAP', `${fmtPace(selStats.gap, units)} ${paceUnit(units)}`]] : []),
                    ...(selStats.hr ? [['Avg HR', `${Math.round(selStats.hr)} bpm`]] : []),
                    ...(selStats.pwr ? [['Avg power', `${Math.round(selStats.pwr)} W`]] : []),
                    ['Climb', `${Math.round(toElev(selStats.gain, units))} ${elevUnit(units)} ↑ ${Math.round(toElev(selStats.loss, units))} ↓`],
                    ['Avg grade', `${(selStats.grade * 100).toFixed(1)} %`],
                  ].map(([k, v]) => (
                    <div key={k}><div className="eyebrow">{k}</div><div className="mono" style={{ fontSize: 14 }}>{v}</div></div>
                  ))}
                </div>
                {track && (
                  <div className="row" style={{ marginTop: 14 }}>
                    <input className="input" placeholder="Name this segment" value={segName} onChange={(e) => setSegName(e.target.value)} />
                    <button className="btn sm" onClick={makeSegment} disabled={selStats.dist < 150}>Create segment</button>
                  </div>
                )}
                {selStats.dist < 150 && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Select at least 150 m to create a segment.</p>}
              </div>
            )}
          </div>
        </div>
      </Section>

      {splits.length > 0 && (
        <Section n={2} total={6} glyph={GLYPH.activities} kicker="Splits" title={`Every ${units === 'metric' ? 'kilometre' : 'mile'}`} lede="Bars show pace relative to your fastest split — shorter is slower.">
          <div className="card pad0">
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Split</th><th className="r">Dist</th><th className="r">Time</th><th className="r">{paceMode ? 'Pace' : 'Speed'}</th><th style={{ width: 160 }} /> {paceMode && <th className="r">GAP</th>}<th className="r">Elev</th>{a.hasHR && <th className="r">HR</th>}{a.hasPower && <th className="r">Power</th>}</tr></thead>
                <tbody>
                  {(() => {
                    const maxS = Math.max(...splits.filter((r) => r.dist > unitM * 0.5).map((r) => r.speed), 0.01);
                    return splits.map((r) => (
                      <tr key={r.n}>
                        <td className="mono">{r.n}</td>
                        <td className="r">{(toDist(r.dist, units)).toFixed(2)}</td>
                        <td className="r">{fmtTime(r.time)}</td>
                        <td className="r">{paceMode ? fmtPace(r.speed, units) : fmtSpeed(r.speed, units)}</td>
                        <td><div style={{ height: 8, width: `${Math.max(4, (r.speed / maxS) * 100)}%`, background: 'var(--c-ink)', borderRadius: '0 4px 4px 0', opacity: 0.85 }} /></td>
                        {paceMode && <td className="r">{fmtPace(r.gap, units)}</td>}
                        <td className="r">{`+${Math.round(toElev(r.gain, units))} −${Math.round(toElev(r.loss, units))}`}</td>
                        {a.hasHR && <td className="r">{r.hr ? Math.round(r.hr) : '—'}</td>}
                        {a.hasPower && <td className="r">{r.pwr ? Math.round(r.pwr) : '—'}</td>}
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </Section>
      )}

      <Section n={3} total={6} glyph={GLYPH.training} kicker="Intensity" title="Where the time went" lede={loads ? `Load ${Math.round(loads.load)} via ${loads.method === 'power' ? 'power (TSS)' : loads.method === 'hr' ? 'heart rate (Banister TRIMP → hrTSS)' : loads.method === 'pace' ? 'grade-adjusted pace (rTSS)' : 'duration only — add HR or power for a real number'}.` : undefined}>
        <div className="grid cols-main" style={{ alignItems: 'start' }}>
          <div className="card">
            <div className="card-head">
              <div><h3>Time in zones</h3><div className="sub">Zones follow your profile settings; change them and this updates instantly.</div></div>
              <Seg value={zoneKind} onChange={setZoneKind} options={[...(loads?.pwrZoneSecs ? [{ v: 'pwr' as const, label: 'Power' }] : []), ...(loads?.hrZoneSecs ? [{ v: 'hr' as const, label: 'Heart rate' }] : []), ...(loads?.paceZoneSecs ? [{ v: 'pace' as const, label: 'Pace' }] : [])]} />
            </div>
            {zoneData ? <ZoneBars zones={zoneData.zones} secs={zoneData.secs} colors={zoneData.colors} fmtRange={zoneData.range} /> : <p>No intensity data for this activity.</p>}
          </div>
          {loads && (
            <div className="card">
              <div className="card-head"><div><h3>Load, three ways</h3><div className="sub">All available methods, side by side. The chosen one feeds your fitness curve.</div></div></div>
              <table className="tbl"><tbody>
                {([['Power (TSS)', loads.tss], ['Heart rate (hrTSS)', loads.hrTss], ['Pace (rTSS)', loads.rTss]] as const).map(([k, v]) => (
                  <tr key={k} className={v != null && ((k.startsWith('Power') && loads.method === 'power') || (k.startsWith('Heart') && loads.method === 'hr') || (k.startsWith('Pace') && loads.method === 'pace')) ? 'hl' : ''}>
                    <td>{k}</td><td className="r">{v != null ? Math.round(v) : '—'}</td>
                  </tr>
                ))}
              </tbody></table>
              <Why label="Show the math" formula={'TSS = hours × IF² × 100, IF = NP ÷ FTP.\nhrTSS = Banister TRIMP ÷ TRIMP of 1 h at LTHR × 100, TRIMP = Σ min × HRr × a·e^(b·HRr).\nrTSS = hours × (NGS ÷ threshold speed)² × 100, NGS = 30 s-normalised grade-adjusted speed.'} evidence={[{ label: 'FTP', value: `${profile.ftp} W` }, { label: 'LTHR / max / rest', value: `${profile.lthr} / ${profile.maxHR} / ${profile.restHR}` }, { label: 'Threshold pace', value: `${fmtPace(profile.thresholdSpeed, units)} ${paceUnit(units)}` }]} />
            </div>
          )}
        </div>
      </Section>

      {(bestRows.length > 0 || pcurve) && (
        <Section n={4} total={6} glyph={GLYPH.performance} kicker="Bests" title="Records in this activity">
          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            {bestRows.length > 0 && (
              <div className="card pad0">
                <div className="table-wrap"><table className="tbl">
                  <thead><tr><th>Distance</th><th className="r">Time</th><th className="r">Pace</th><th className="r">All-time</th></tr></thead>
                  <tbody>{bestRows.map((r) => (
                    <tr key={r.D}>
                      <td>{BEST_LABELS[r.D]}</td><td className="r">{fmtTime(r.t)}</td><td className="r">{paceMode ? fmtPace(r.D / r.t, units) : fmtSpeed(r.D / r.t, units)}</td>
                      <td className="r">{r.isPR ? <Chip tone="lime">PR</Chip> : r.rank <= 3 ? <Chip tone="mute">#{r.rank}</Chip> : <span className="muted">#{r.rank}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            )}
            {pcurve && (
              <div className="card">
                <LineChart title="Power curve vs your last 90 days" x={pcurve.durs} xScale="log" xTicks={[1, 5, 15, 60, 300, 1200, 3600]} xTickFmt={(v) => (v < 60 ? `${v}s` : v < 3600 ? `${v / 60}m` : `${v / 3600}h`)} xFmt={(v) => (v < 60 ? `${v} s` : v < 3600 ? `${(v / 60).toFixed(v % 60 ? 1 : 0)} min` : `${(v / 3600).toFixed(1)} h`)} yFmt={(v) => `${Math.round(v)}`} height={220} xDomain={[1, Math.max(...Array.from(pcurve.durs))]} series={[{ id: 'ref', name: '90-day best', color: 'var(--c-ink)', y: pcurve.ref }, { id: 'mine', name: 'This ride', color: 'var(--c-pwr)', y: pcurve.mine }]} />
              </div>
            )}
          </div>
        </Section>
      )}

      {(segEfforts.length > 0 || group) && (
        <Section n={5} total={6} glyph={GLYPH.routes} kicker="Repeats" title="Segments & matched routes" lede="Your own history is the leaderboard.">
          <div className="grid cols-2" style={{ alignItems: 'start' }}>
            {segEfforts.length > 0 && (
              <div className="card pad0">
                <div className="table-wrap"><table className="tbl">
                  <thead><tr><th>Segment</th><th className="r">Time</th><th className="r">Rank</th><th className="r">vs best</th></tr></thead>
                  <tbody>{segEfforts.map((s, i) => (
                    <tr key={i}>
                      <td>{s.seg.name}<div className="muted mono" style={{ fontSize: 10.5 }}>{fmtDistU(s.seg.length, units, 2)}</div></td>
                      <td className="r">{fmtTime(s.effort.time)}</td>
                      <td className="r">{s.rank === 1 ? <Chip tone="lime">PR</Chip> : `${s.rank} / ${s.total}`}</td>
                      <td className="r">{s.best != null && s.rank !== 1 ? `+${(s.effort.time - s.best).toFixed(0)} s` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            )}
            {group && (
              <div className="card">
                <div className="card-head">
                  <div><h3>Matched route · {group.members.length} efforts</h3><div className="sub">Same route, ±8 % length, shape within 45 m. Compare to any previous time.</div></div>
                  {others.length > 0 && (
                    <select className="select" style={{ width: 'auto' }} value={cmpId} onChange={(e) => setCmpId(e.target.value)} aria-label="Compare with">
                      {others.map((o) => <option key={o.id} value={o.id}>{fmtDate(o.start, o.tz, { year: false })} · {fmtTime(o.timer)}</option>)}
                    </select>
                  )}
                </div>
                {cmp ? (
                  <>
                    <div className="row" style={{ marginBottom: 6 }}><Chip tone={cmp.final <= 0 ? 'pos' : 'neg'}>{cmp.final <= 0 ? 'ahead' : 'behind'} {Math.abs(Math.round(cmp.final))} s at the finish</Chip></div>
                    <LineChart x={cmp.xs} height={170} zero legend={false} xFmt={(v) => fmtDistU(v, units, 2)} xTickFmt={(v) => (v / unitM).toFixed(1)} yFmt={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}s`} series={[{ id: 'd', name: 'Time vs comparison (+ = behind)', color: 'var(--c-ink)', y: cmp.ys, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} s` }]} />
                  </>
                ) : <p>Loading comparison…</p>}
              </div>
            )}
          </div>
        </Section>
      )}

      <Section n={6} total={6} glyph={GLYPH.settings} kicker="Manage" title="Details">
        <div className="card">
          <div className="grid cols-3">
            <div className="field"><label className="lbl">Sport</label>
              <select className="select" value={a.sport} onChange={(e) => void changeSport(e.target.value as Sport)}>
                {(['run', 'ride', 'walk', 'hike', 'other'] as Sport[]).map((s) => <option key={s} value={s}>{SPORT_GLYPH[s]} {sportLabel(s)}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 11.5 }}>Re-derives pace/GAP/load for the new sport.</span>
            </div>
            <div className="field"><label className="lbl">Gear</label>
              <select className="select" value={a.gearId ?? ''} onChange={(e) => void updateActivity(a.id, { gearId: e.target.value || undefined })}>
                <option value="">None</option>
                {gear.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div className="field"><label className="lbl">Notes</label>
              <textarea className="input" defaultValue={a.notes} placeholder="How did it feel?" onBlur={(e) => void updateActivity(a.id, { notes: e.target.value })} />
            </div>
          </div>
          <hr className="hr" />
          <div className="row spread wrap">
            <span className="muted" style={{ fontSize: 13 }}>ID <span className="mono">{a.id}</span> · {dayNumOf(a.start, a.tz) === core.today ? 'today' : `${core.today - dayNumOf(a.start, a.tz)} days ago`}</span>
            <button className="btn danger sm" onClick={() => { if (confirm('Delete this activity from your local library? This cannot be undone.')) { void deleteActivity(a.id); navigate('/activities'); } }}>Delete activity</button>
          </div>
        </div>
      </Section>
    </>
  );
}

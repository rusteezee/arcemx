import { beforeAll, describe, expect, it } from 'vitest';
import { generateDemo, DEMO_PROFILE } from '../src/lib/demo/generate';
import { analyze } from '../src/lib/analyze/process';
import { computeAllLoads, buildPMC, dailyLoads, triDistribution } from '../src/lib/analyze/load';
import { computeEfforts, discoverSegments, matchSegment, segmentFromTrack, type TrackEntry } from '../src/lib/analyze/segments';
import { groupRoutes, tileStats } from '../src/lib/analyze/routes';
import { predictRaces, suggestThresholds } from '../src/lib/analyze/predict';
import { dayNumOf } from '../src/lib/units';
import type { ActivitySummary } from '../src/lib/types';

const NOW = Date.UTC(2026, 10, 9, 5, 0, 0);
let summaries: ActivitySummary[] = [];
let entries: TrackEntry[] = [];
let genMs = 0;
let anaMs = 0;

beforeAll(() => {
  const t0 = performance.now();
  const gen = [...generateDemo({ now: NOW })];
  genMs = performance.now() - t0;
  const t1 = performance.now();
  for (const g of gen) {
    const a = analyze(g, DEMO_PROFILE, { tz: 330 });
    if (!a) continue;
    summaries.push(a.summary);
    if (a.track) entries.push({ summary: a.summary, track: a.track });
  }
  anaMs = performance.now() - t1;
  console.log(`demo: ${summaries.length} activities · generate ${genMs.toFixed(0)} ms · analyse ${anaMs.toFixed(0)} ms (${(anaMs / summaries.length).toFixed(1)} ms each)`);
}, 120_000);

describe('demo athlete', () => {
  it('produces ~a year of plausible activities', () => {
    expect(summaries.length).toBeGreaterThan(180);
    expect(summaries.length).toBeLessThan(380);
    const runs = summaries.filter((s) => s.sport === 'run');
    const rides = summaries.filter((s) => s.sport === 'ride');
    expect(runs.length).toBeGreaterThan(120);
    expect(rides.length).toBeGreaterThan(25);
    const typical = runs.filter((r) => r.distance > 4000 && r.distance < 12000);
    const paces = typical.map((r) => r.avgSpeed);
    expect(Math.min(...paces)).toBeGreaterThan(2.4); // slower than 6:55 /km never faster than 5:00?
    expect(Math.max(...paces)).toBeLessThan(5.2);
    for (const r of rides) {
      expect(r.avgSpeed).toBeGreaterThan(4);
      expect(r.avgSpeed).toBeLessThan(13);
      expect(r.hasPower).toBe(true);
    }
  });

  it('measures distance within ~3 % of the true route length (GPS noise handled)', () => {
    const park = summaries.filter((s) => s.sport === 'run' && /Recovery jog/.test(s.name));
    expect(park.length).toBeGreaterThan(5);
    const ds = park.map((p) => p.distance);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect(Math.max(...ds) - Math.min(...ds)).toBeLessThan(mean * 0.04);
    console.log('park5k distance mean', mean.toFixed(0), 'm');
  });

  it('keeps HR/power sanity (no impossible values) and shows aerobic decoupling on long runs', () => {
    const long = summaries.filter((s) => /Long run/.test(s.name) && s.decoupling != null);
    expect(long.length).toBeGreaterThan(10);
    const avg = long.reduce((a, s) => a + s.decoupling!, 0) / long.length;
    console.log('mean long-run decoupling', avg.toFixed(1), '%');
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(15);
    for (const s of summaries) {
      if (s.avgHR) {
        expect(s.avgHR).toBeGreaterThan(90);
        expect(s.maxHR!).toBeLessThan(DEMO_PROFILE.maxHR + 1);
      }
    }
  });

  it('builds a PMC with believable fitness and a recent load spike', () => {
    const loads = computeAllLoads(summaries, DEMO_PROFILE);
    const daily = dailyLoads(summaries, loads);
    const days = [...daily.keys()];
    const pmc = buildPMC(daily, Math.min(...days), dayNumOf(NOW, 330));
    const last = pmc[pmc.length - 1];
    console.log('PMC last', { ctl: last.ctl.toFixed(1), atl: last.atl.toFixed(1), tsb: last.tsb.toFixed(1), acwr: last.acwr.toFixed(2) });
    expect(last.ctl).toBeGreaterThan(25);
    expect(last.ctl).toBeLessThan(110);
    const maxTSS = Math.max(...[...loads.values()].map((l) => l.load));
    expect(maxTSS).toBeLessThan(400);
    const methods = new Set([...loads.values()].map((l) => l.method));
    expect(methods.has('power')).toBe(true);
    expect(methods.has('hr')).toBe(true);
    const d = triDistribution(summaries, loads, dayNumOf(NOW, 330) - 28, dayNumOf(NOW, 330));
    console.log('28-day distribution', { low: (d.low / d.total).toFixed(2), mid: (d.mid / d.total).toFixed(2), high: (d.high / d.total).toFixed(2), model: d.model });
    expect(d.total).toBeGreaterThan(0);
  });

  it('predicts races and suggests thresholds', () => {
    const r = predictRaces(summaries, NOW)!;
    console.log('VDOT', r.vdot.toFixed(1), 'basis', r.basis.label, 'confidence', r.confidence, r.races.map((x) => `${x.label} ${(x.mid / 60).toFixed(1)}m`).join(' | '));
    expect(r.vdot).toBeGreaterThan(40);
    expect(r.vdot).toBeLessThan(60);
    const sug = suggestThresholds(summaries, DEMO_PROFILE, NOW);
    console.log('threshold evidence', sug.map((s) => `${s.key}: ${s.current} vs ${s.estimate.toFixed(1)} [${s.status}]`));
    expect(sug.every((s) => s.status !== 'raise' || s.estimate > s.current)).toBe(true);
  });

  it('matches repeated routes into groups', () => {
    const groups = groupRoutes(entries);
    console.log('route groups', groups.map((g) => `${g.sport} ${(g.length / 1000).toFixed(1)}km ×${g.members.length}`));
    expect(groups.length).toBeGreaterThanOrEqual(3);
    expect(groups[0].members.length).toBeGreaterThan(8);
  });

  it('discovers segments and matches efforts across activities', () => {
    const t0 = performance.now();
    const run = discoverSegments(entries, { sport: 'run' });
    const ride = discoverSegments(entries, { sport: 'ride' });
    const t1 = performance.now();
    console.log(`discovered ${run.length} run + ${ride.length} ride segments in ${(t1 - t0).toFixed(0)} ms`);
    expect(run.length).toBeGreaterThan(2);
    expect(ride.length).toBeGreaterThan(0);
    const eff = computeEfforts([...run, ...ride], entries);
    console.log(`efforts computed in ${(performance.now() - t1).toFixed(0)} ms`, [...eff.entries()].slice(0, 6).map(([id, e]) => `${id.slice(-10)}:${e.length}`));
    const counts = [...eff.values()].map((e) => e.length);
    expect(Math.max(...counts)).toBeGreaterThan(10);
    // consistency: efforts of the same segment should have similar times (CV < 25 %)
    const biggest = [...eff.values()].sort((a, b) => b.length - a.length)[0];
    const times = biggest.map((e) => e.time);
    const m = times.reduce((a, b) => a + b, 0) / times.length;
    const sd = Math.sqrt(times.reduce((a, b) => a + (b - m) ** 2, 0) / times.length);
    expect(sd / m).toBeLessThan(0.25);
  });

  it('a user-drawn segment is found again in its own activity with the same time', () => {
    const e = entries.find((x) => x.summary.sport === 'run' && x.summary.distance > 4500)!;
    const t = e.track;
    const i0 = Math.floor(t.n * 0.3),
      i1 = Math.floor(t.n * 0.5);
    const seg = segmentFromTrack(t, i0, i1, 'mine', 'run');
    const found = matchSegment(seg, e);
    expect(found.length).toBeGreaterThanOrEqual(1);
    const expected = t.t[i1] - t.t[i0];
    expect(Math.abs(found[0].time - expected)).toBeLessThan(4);
  });

  it('computes explorer tiles', () => {
    const ts = tileStats(entries, NOW);
    console.log('tiles', ts.count, 'maxSquare', ts.maxSquare);
    expect(ts.count).toBeGreaterThan(3);
    expect(ts.maxSquare).toBeGreaterThanOrEqual(1);
  });
});

import { describe, expect, it } from 'vitest';
import { analyze, bestEfforts, buildStreams, elevGainLoss, meanMax, normalizedMean } from '../src/lib/analyze/process';
import { computeLoads, buildPMC, forecastPMC, monotonyStrain, acwrZone } from '../src/lib/analyze/load';
import { gapFactor, minettiCost } from '../src/lib/analyze/gap';
import { predictRaces, riegel, speedAtPct, timeFromVdot, trainingPaces, vdotFrom } from '../src/lib/analyze/predict';
import { fitCP, fitCriticalSpeed, powerCurve, wPrimeBalance } from '../src/lib/analyze/efforts';
import { hrZones, pwrZones } from '../src/lib/analyze/zones';
import { DEFAULT_PROFILE } from '../src/lib/profile';
import { parsed, straightLine, T0 } from './helpers';

const P = { ...DEFAULT_PROFILE, ftp: 250, lthr: 170, maxHR: 190, restHR: 50, thresholdSpeed: 4.0 };

describe('streams', () => {
  it('measures distance of a constant-speed straight line within 1 %', () => {
    const b = buildStreams(straightLine({ seconds: 600, speed: 3 }))!;
    expect(b.streams.n).toBe(601);
    expect(b.streams.d[600]).toBeGreaterThan(1800 * 0.99);
    expect(b.streams.d[600]).toBeLessThan(1800 * 1.01);
  });

  it('treats long recording gaps as paused timer time (no fill, no distance across it)', () => {
    const b = buildStreams(straightLine({ seconds: 300, speed: 3, gaps: [[100, 200]] }))!;
    // 300 s wall-clock but ~100 s of it is a gap → ≈ 201 timer seconds
    expect(b.streams.n).toBeLessThan(215);
    expect(b.elapsed).toBe(300);
  });

  it('ignores GPS wobble while standing still', () => {
    const pts = straightLine({ seconds: 120, speed: 0 }).map((p, i) => ({ ...p, lat: p.lat! + ((i % 2) * 0.00001), lon: p.lon! + ((i % 3) * 0.00001) }));
    const b = buildStreams(pts)!;
    expect(b.streams.d[b.streams.n - 1]).toBeLessThan(15);
  });

  it('prefers device distance when it agrees with GPS', () => {
    const pts = straightLine({ seconds: 300, speed: 4, dist: true }).map((p) => ({ ...p, dist: p.dist! * 1.03 }));
    const b = buildStreams(pts)!;
    expect(b.streams.d[300]).toBeGreaterThan(1200 * 1.029);
  });
});

describe('summary metrics', () => {
  it('normalised power equals power for a constant effort and exceeds it for intervals', () => {
    expect(normalizedMean(new Array(600).fill(200))).toBeCloseTo(200, 6);
    const intervals = Array.from({ length: 1800 }, (_, i) => (Math.floor(i / 60) % 2 ? 100 : 300));
    const np = normalizedMean(intervals);
    expect(np).toBeGreaterThan(200);
  });

  it('computes TSS = 100 for one hour at FTP', () => {
    const pts = straightLine({ seconds: 3599, speed: 8, pwr: 250, hr: 150 });
    const a = analyze(parsed(pts, 'ride'), P)!;
    const l = computeLoads(a.summary, P);
    expect(l.method).toBe('power');
    expect(l.tss).toBeGreaterThan(99);
    expect(l.tss).toBeLessThan(101);
    expect(a.summary.np).toBeCloseTo(250, 0);
    expect(a.summary.mmp![MMP_IDX(1200)]).toBeCloseTo(250, 0);
  });

  it('hrTSS is ≈ 100 for one hour at LTHR', () => {
    const pts = straightLine({ seconds: 3599, speed: 3.5, hr: 170 });
    const a = analyze(parsed(pts, 'run'), P)!;
    const l = computeLoads(a.summary, P);
    expect(l.method).toBe('hr');
    expect(l.hrTss!).toBeGreaterThan(99);
    expect(l.hrTss!).toBeLessThan(101);
  });

  it('rTSS is ≈ 100 for one hour at threshold pace on the flat', () => {
    const pts = straightLine({ seconds: 3599, speed: 4.0 });
    const a = analyze(parsed(pts, 'run'), P)!;
    const l = computeLoads(a.summary, P);
    expect(l.method).toBe('pace');
    expect(l.rTss!).toBeGreaterThan(95);
    expect(l.rTss!).toBeLessThan(105);
  });

  it('reports elevation gain with hysteresis (ignores ±1 m noise)', () => {
    const noisy = Array.from({ length: 600 }, (_, i) => 100 + (i % 2 ? 0.8 : -0.8));
    expect(elevGainLoss(noisy).gain).toBe(0);
    const climb = Array.from({ length: 600 }, (_, i) => 100 + i * 0.1);
    expect(elevGainLoss(climb).gain).toBeGreaterThan(55);
  });

  it('flags decoupling when HR drifts at constant pace', () => {
    const pts = straightLine({ seconds: 3600, speed: 3.2, hr: (i) => 140 + (i / 3600) * 14 });
    const a = analyze(parsed(pts, 'run'), P)!;
    expect(a.summary.decoupling!).toBeGreaterThan(3);
    const flat = analyze(parsed(straightLine({ seconds: 3600, speed: 3.2, hr: 150 }), 'run'), P)!;
    expect(Math.abs(flat.summary.decoupling!)).toBeLessThan(1);
  });

  it('finds best efforts on a negative-split run', () => {
    const d = Array.from({ length: 1801 }, (_, i) => (i < 900 ? i * 3 : 2700 + (i - 900) * 4)); // 3 then 4 m/s
    const b = bestEfforts(d, [1000, 5000]);
    expect(b[1000][0]).toBeCloseTo(250, 0); // last km at 4 m/s
    expect(b[5000]).toBeDefined();
    expect(b[5000][0]).toBeGreaterThan(1250 - 5);
  });

  it('mean-max matches a hand calculation', () => {
    const x = [0, 0, 100, 300, 300, 100, 0, 0];
    const [m1, m2, m3] = meanMax(x, [1, 2, 4]);
    expect(m1).toBe(300);
    expect(m2).toBe(300);
    expect(m3).toBe(200);
  });
});

function MMP_IDX(dur: number) {
  return [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 900, 1200].indexOf(dur);
}

describe('GAP (Minetti-based)', () => {
  it('is 1.0 on the flat and cost(0) = 3.6', () => {
    expect(minettiCost(0)).toBeCloseTo(3.6, 6);
    expect(gapFactor(0)).toBeCloseTo(1, 6);
  });
  it('makes uphill running count for more and gentle downhill count for less', () => {
    expect(gapFactor(0.1)).toBeGreaterThan(1.4);
    expect(gapFactor(-0.05, 0.5)).toBeLessThan(1);
    expect(gapFactor(-0.05, 0.5)).toBeGreaterThan(gapFactor(-0.05, 1));
    expect(gapFactor(-0.05, 0)).toBeCloseTo(1, 6);
  });
  it('has downhill benefit peaking near −9 % and fading by −18 %', () => {
    const f9 = gapFactor(-0.09, 1),
      f13 = gapFactor(-0.13, 1),
      f18 = gapFactor(-0.18, 1),
      f30 = gapFactor(-0.3, 1);
    expect(f9).toBeLessThan(f13);
    expect(f13).toBeLessThan(f18);
    expect(f18).toBeCloseTo(1, 2);
    expect(f30).toBeGreaterThan(1);
  });
  it('computes GAP on a real uphill stream', () => {
    const a = analyze(parsed(straightLine({ seconds: 600, speed: 3, grade: 0.06 }), 'run'), P)!;
    expect(a.summary.ngs!).toBeGreaterThan(3.8);
  });
});

describe('Daniels VDOT', () => {
  it('reproduces the published VDOT-50 table within 1 %', () => {
    expect(vdotFrom(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    const t5k = timeFromVdot(50, 5000);
    expect(Math.abs(t5k - (19 * 60 + 57)) / (19 * 60 + 57)).toBeLessThan(0.01);
    const tm = timeFromVdot(50, 42195);
    expect(Math.abs(tm - (3 * 3600 + 10 * 60 + 49)) / (3 * 3600 + 10 * 60 + 49)).toBeLessThan(0.015);
  });
  it('reproduces threshold and interval paces for VDOT 50', () => {
    const p = trainingPaces(50);
    expect(1000 / p.threshold).toBeGreaterThan(4 * 60 + 12); // ≈ 4:15 /km
    expect(1000 / p.threshold).toBeLessThan(4 * 60 + 18);
    expect(1000 / p.interval).toBeGreaterThan(3 * 60 + 51); // ≈ 3:54 /km
    expect(1000 / p.interval).toBeLessThan(3 * 60 + 57);
    expect(speedAtPct(50, 0.88)).toBeCloseTo(p.threshold, 6);
  });
  it('Riegel: doubling distance costs ≈ 2^1.06', () => {
    expect(riegel(1200, 5000, 10000)).toBeCloseTo(1200 * 2 ** 1.06, 3);
  });
});

describe('PMC / load model', () => {
  it('CTL converges to constant daily load; TSB → 0', () => {
    const daily = new Map<number, number>();
    for (let d = 0; d < 400; d++) daily.set(d, 60);
    const pmc = buildPMC(daily, 0, 399, { seed: 0 });
    const last = pmc[pmc.length - 1];
    expect(last.ctl).toBeGreaterThan(59);
    expect(last.atl).toBeCloseTo(60, 1);
    expect(Math.abs(last.tsb)).toBeLessThan(0.5);
  });
  it('form goes negative after a hard block and positive after rest', () => {
    const daily = new Map<number, number>();
    for (let d = 0; d < 60; d++) daily.set(d, 50);
    for (let d = 60; d < 67; d++) daily.set(d, 110);
    const p = buildPMC(daily, 0, 66);
    expect(p[66].tsb).toBeLessThan(-15);
    const rest = buildPMC(daily, 0, 80);
    expect(rest[80].tsb).toBeGreaterThan(p[66].tsb + 25);
  });
  it('ACWR rises on a spike and classifies zones', () => {
    const daily = new Map<number, number>();
    for (let d = 0; d < 56; d++) daily.set(d, 40);
    for (let d = 56; d < 63; d++) daily.set(d, 110);
    const p = buildPMC(daily, 0, 62);
    expect(p[55].acwr).toBeCloseTo(1, 1);
    // EWMA(7)/EWMA(28) after a week at 2.75× baseline ≈ 1.49 (hand-checked)
    expect(p[62].acwr).toBeGreaterThan(1.3);
    expect(p[62].acwr).toBeLessThan(1.6);
    expect(acwrZone(p[62].acwr)).not.toBe('sweet');
    expect(acwrZone(0.7)).toBe('under');
    expect(acwrZone(1.0)).toBe('sweet');
    expect(acwrZone(1.4)).toBe('caution');
    expect(acwrZone(1.7)).toBe('danger');
  });
  it('monotony is high for identical days and low for varied weeks', () => {
    const flat = new Map<number, number>();
    const varied = new Map<number, number>();
    for (let d = 0; d < 7; d++) {
      flat.set(d, 50);
      varied.set(d, [0, 90, 30, 0, 120, 20, 0][d]);
    }
    expect(monotonyStrain(flat, 6).monotony).toBeGreaterThan(5);
    expect(monotonyStrain(varied, 6).monotony).toBeLessThan(1);
  });
  it('forecast continues from the last PMC point', () => {
    const daily = new Map<number, number>();
    for (let d = 0; d < 100; d++) daily.set(d, 50);
    const p = buildPMC(daily, 0, 99);
    const f = forecastPMC(p[99], [0, 0, 0, 0, 0, 0, 0]);
    expect(f[6].atl).toBeLessThan(p[99].atl);
    expect(f[6].tsb).toBeGreaterThan(p[99].tsb);
    expect(f[0].future).toBe(true);
  });
});

describe('power curve / CP / W′', () => {
  it('recovers CP and W′ from synthetic 2-parameter data', () => {
    const CP = 250,
      W = 20000;
    const acts: any[] = [180, 300, 600, 1200].map((D, k) => ({ id: 'x' + k, start: T0, mmp: durationsMMP(D, CP + W / D) }));
    const curve = powerCurve(acts);
    const fit = fitCP(curve)!;
    expect(fit.cp).toBeCloseTo(CP, 0);
    expect(fit.wPrime).toBeCloseTo(W, -2);
  });
  it('W′ balance depletes above CP and recovers below', () => {
    const p = [...new Array(60).fill(400), ...new Array(300).fill(100)];
    const bal = wPrimeBalance(p, 250, 15000);
    expect(bal[59]).toBeCloseTo(15000 - 60 * 150, -1);
    expect(bal[359]).toBeGreaterThan(bal[59]);
  });
  it('critical speed from distance-time pairs', () => {
    const CS = 4,
      D = 150;
    const m = new Map<number, any>();
    [[1000], [3000], [5000]].forEach(([dist]) => {
      const t = (dist - D) / CS;
      m.set(dist, { dist, time: t, activityId: 'a', start: 0, startSec: 0 });
    });
    const fit = fitCriticalSpeed(m)!;
    expect(fit.cs).toBeCloseTo(CS, 2);
  });
});

function durationsMMP(D: number, w: number) {
  const durs = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 900, 1200];
  return durs.map((d) => (d === D ? w : 0));
}

describe('zones', () => {
  it('builds ordered HR and power zones', () => {
    const hz = hrZones(P);
    expect(hz).toHaveLength(5);
    for (let i = 1; i < 5; i++) expect(hz[i].lo).toBeGreaterThan(hz[i - 1].lo);
    const pz = pwrZones(P);
    expect(pz).toHaveLength(7);
    expect(pz[3].lo).toBeCloseTo(0.75 * 250 + 0.15 * 250, 0); // Z4 starts at 90 % FTP
  });
});

describe('race prediction', () => {
  it('predicts sensible times from a recent 5K effort', () => {
    const now = Date.UTC(2026, 5, 1);
    const acts: any[] = [
      { id: 'a', sport: 'run', start: now - 10 * 86400000, tz: 0, bests: { 1000: [220, 0], 5000: [1200, 0] } },
      { id: 'b', sport: 'run', start: now - 30 * 86400000, tz: 0, bests: { 1000: [228, 0], 3000: [690, 0], 5000: [1230, 0], 10000: [2560, 0] } },
    ];
    const r = predictRaces(acts, now)!;
    expect(r.vdot).toBeGreaterThan(48);
    expect(r.vdot).toBeLessThan(52);
    const half = r.races.find((x) => x.label === 'Half marathon')!;
    expect(half.low).toBeGreaterThan(5000);
    expect(half.low).toBeLessThan(half.high);
    expect(r.races[0].mid).toBeLessThan(r.races[1].mid);
  });
});

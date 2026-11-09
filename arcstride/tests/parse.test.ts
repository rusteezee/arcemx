// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { Encoder, Profile } from '@garmin/fitsdk';
import { parseGPX } from '../src/lib/parse/gpx';
import { parseTCX } from '../src/lib/parse/tcx';
import { parseFIT } from '../src/lib/parse/fit';
import { parseCSV, parseEntry, parseStravaCsv, readInputs } from '../src/lib/parse/archive';
import { analyze } from '../src/lib/analyze/process';
import { DEFAULT_PROFILE } from '../src/lib/profile';

function gpx(n = 120) {
  const pts = Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(2026, 2, 1, 6, 0, i)).toISOString();
    return `<trkpt lat="${12.97 + i * 0.00002}" lon="77.59"><ele>${900 + i * 0.05}</ele><time>${t}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${140 + (i % 10)}</gpxtpx:hr><gpxtpx:cad>82</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  }).join('');
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>Morning jog</name><type>running</type><trkseg>${pts}</trkseg></trk></gpx>`;
}

describe('GPX', () => {
  it('parses points, name, type and extensions', () => {
    const p = parseGPX(gpx())!;
    expect(p.name).toBe('Morning jog');
    expect(p.sport).toBe('run');
    expect(p.points).toHaveLength(120);
    expect(p.points[5].hr).toBe(145);
    expect(p.points[5].cad).toBe(82);
    expect(p.points[0].alt).toBeCloseTo(900, 3);
  });
  it('rejects malformed XML and files without timestamps', () => {
    expect(parseGPX('<gpx><trk>')).toBeNull();
    expect(parseGPX('<gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk></gpx>')).toBeNull();
  });
  it('flows through analysis into a sensible summary', () => {
    const a = analyze(parseGPX(gpx(300))!, DEFAULT_PROFILE)!;
    expect(a.summary.sport).toBe('run');
    expect(a.summary.distance).toBeGreaterThan(600);
    expect(a.summary.avgHR).toBeGreaterThan(140);
    expect(a.track!.n).toBeGreaterThan(30);
  });
});

describe('TCX', () => {
  it('parses a treadmill-style file with distance and no GPS', () => {
    const tps = Array.from({ length: 60 }, (_, i) => `<Trackpoint><Time>${new Date(Date.UTC(2026, 2, 1, 6, 0, i)).toISOString()}</Time><DistanceMeters>${i * 3}</DistanceMeters><HeartRateBpm><Value>150</Value></HeartRateBpm></Trackpoint>`).join('');
    const xml = `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Lap><Track>${tps}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const p = parseTCX(xml)!;
    expect(p.sport).toBe('run');
    expect(p.trainer).toBe(true);
    const a = analyze(p, DEFAULT_PROFILE)!;
    expect(a.summary.distance).toBeCloseTo(177, 0);
    expect(a.summary.hasGps).toBe(false);
  });
});

describe('FIT', () => {
  it('round-trips records through Garmin’s encoder and our parser', async () => {
    const enc: any = new Encoder();
    const t0 = new Date(Date.UTC(2026, 2, 1, 6, 0, 0));
    enc.onMesg(Profile.MesgNum.FILE_ID, { manufacturer: 'development', product: 1, timeCreated: t0, type: 'activity' });
    const semi = (deg: number) => Math.round(deg * (2147483648 / 180));
    for (let i = 0; i < 90; i++) {
      enc.onMesg(Profile.MesgNum.RECORD, {
        timestamp: new Date(t0.getTime() + i * 1000),
        positionLat: semi(12.97 + i * 0.00002),
        positionLong: semi(77.59),
        altitude: 900 + i * 0.05,
        heartRate: 150,
        cadence: 85,
        power: 230,
        distance: i * 2.2,
      });
    }
    enc.onMesg(Profile.MesgNum.SESSION, { timestamp: new Date(t0.getTime() + 90000), startTime: t0, sport: 'cycling', subSport: 'road', totalElapsedTime: 90, totalTimerTime: 90 });
    const bytes = enc.close();
    const p = await parseFIT(bytes);
    expect(p).not.toBeNull();
    expect(p!.points.length).toBe(90);
    expect(p!.sport).toBe('ride');
    expect(p!.points[10].lat).toBeCloseTo(12.97 + 10 * 0.00002, 4);
    expect(p!.points[10].hr).toBe(150);
    expect(p!.points[10].pwr).toBe(230);
    const a = analyze(p!, DEFAULT_PROFILE)!;
    expect(a.summary.hasPower).toBe(true);
    expect(a.summary.np).toBeGreaterThan(220);
  });
  it('returns null for garbage', async () => {
    expect(await parseFIT(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toBeNull();
  });
});

describe('Strava archive', () => {
  const csv = `Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename\n1,"Mar 1, 2026, 6:00:00 AM","Hill ""repeats""
with a newline",Run,Felt good,120,1.2,170,40,false,,Pegasus 41,activities/1.gpx.gz\n2,"Mar 2, 2026",Lunch Ride,Ride,,300,10,150,20,true,,,activities/2.gpx`;

  it('parses quoted multi-line CSV and maps Strava types', () => {
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(3);
    const m = parseStravaCsv(csv);
    expect(m.get('activities/1.gpx.gz')!.name).toBe('Hill "repeats"\nwith a newline');
    expect(m.get('activities/1.gpx.gz')!.sport).toBe('run');
    expect(m.get('activities/1.gpx.gz')!.gear).toBe('Pegasus 41');
    expect(m.get('activities/2.gpx')!.commute).toBe(true);
  });

  it('unpacks a zip with .gz activities and activities.csv', async () => {
    const zip = zipSync({
      'activities.csv': strToU8(csv),
      'activities/1.gpx.gz': gzipSync(strToU8(gpx(60))),
      'activities/2.gpx': strToU8(gpx(60)),
      'media/photo.jpg': strToU8('nope'),
    });
    const file = new File([zip as BlobPart], 'export_123.zip');
    const { entries, csv: meta } = await readInputs([file]);
    expect(entries.map((e) => e.name).sort()).toEqual(['activities/1.gpx.gz', 'activities/2.gpx']);
    expect(meta.size).toBe(2);
    const p = await parseEntry(entries.find((e) => e.name.endsWith('.gz'))!);
    expect(p!.points).toHaveLength(60);
  });
});

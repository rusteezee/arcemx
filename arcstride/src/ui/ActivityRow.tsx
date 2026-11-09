import { useMemo } from 'react';
import type { ActivitySummary, Loads, Units } from '../lib/types';
import { fmtClock, fmtDate, fmtDistU, fmtDur, fmtSpeedFor, SPORT_GLYPH, sportLabel } from '../lib/units';
import { Link } from '../lib/router';
import { Chip, Glyph, SourceChip } from './kit';

export const SPORT_COLOR: Record<ActivitySummary['sport'], string> = { run: '#fafafa', ride: '#a3e635', walk: '#71717a', hike: '#facc15', other: '#52525b' };

export function RouteThumb({ poly, color = '#fafafa', w = 76, h = 60 }: { poly?: number[]; color?: string; w?: number; h?: number }) {
  const d = useMemo(() => {
    if (!poly || poly.length < 4) return null;
    let minLa = Infinity,
      maxLa = -Infinity,
      minLo = Infinity,
      maxLo = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      minLa = Math.min(minLa, poly[i]);
      maxLa = Math.max(maxLa, poly[i]);
      minLo = Math.min(minLo, poly[i + 1]);
      maxLo = Math.max(maxLo, poly[i + 1]);
    }
    const k = Math.cos(((minLa + maxLa) / 2) * (Math.PI / 180));
    const spanX = Math.max(1e-9, (maxLo - minLo) * k),
      spanY = Math.max(1e-9, maxLa - minLa);
    const pad = 7;
    const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * s) / 2,
      oy = (h - spanY * s) / 2;
    const pts: [number, number][] = [];
    for (let i = 0; i < poly.length; i += 2) pts.push([ox + (poly[i + 1] - minLo) * k * s, h - oy - (poly[i] - minLa) * s]);
    return { path: pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(''), start: pts[0] };
  }, [poly, w, h]);
  return (
    <svg className="thumb" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ width: w, height: h }}>
      {d ? (
        <>
          <path d={d.path} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={d.start[0]} cy={d.start[1]} r={2.6} fill="#4ade80" />
        </>
      ) : (
        <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fill="#52525b" fontSize="14" fontFamily="var(--font-glyph)">
          ◌
        </text>
      )}
    </svg>
  );
}

export function ActivityRow({ a, loads, units }: { a: ActivitySummary; loads?: Loads; units: Units }) {
  const sp = fmtSpeedFor(a.sport, a.avgSpeed, units);
  return (
    <Link to={`/activity/${a.id}`} className="row-card">
      <RouteThumb poly={a.poly} color={SPORT_COLOR[a.sport]} />
      <div style={{ minWidth: 0 }}>
        <div className="name">{a.name}</div>
        <div className="meta">
          <Glyph g={SPORT_GLYPH[a.sport]} /> {sportLabel(a.sport)} · {fmtDate(a.start, a.tz, { weekday: true, year: false })} · {fmtClock(a.start, a.tz)}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          {a.source === 'demo' && <SourceChip source="demo" />}
          {loads && <Chip tone="mute" title={`Training load via ${loads.method}`}>{Math.round(loads.load)} load · {loads.method}</Chip>}
        </div>
      </div>
      <div className="stats">
        <div className="stat">
          <div className="v">{fmtDistU(a.distance, units, 2)}</div>
          <div className="k">dist</div>
        </div>
        <div className="stat">
          <div className="v">{fmtDur(a.moving)}</div>
          <div className="k">time</div>
        </div>
        <div className="stat">
          <div className="v">
            {sp.value}
            <span className="muted" style={{ fontSize: 10.5 }}> {sp.unit}</span>
          </div>
          <div className="k">{a.sport === 'ride' ? 'speed' : 'pace'}</div>
        </div>
      </div>
    </Link>
  );
}

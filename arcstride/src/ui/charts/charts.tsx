import { useMemo, useState } from 'react';
import { niceTicks } from '../../lib/stats';
import { fmtTime } from '../../lib/units';
import { Panel, type PSeries } from './Panel';
import { ChartFrame, lin, roundedTopRect, Tooltip, useWidth, type LegendItem, type TipRow } from './common';

// ───────────────────────── LineChart (standalone, with tooltip + legend + table) ─────────────────────────
export interface LineChartProps {
  title?: string;
  sub?: string;
  x: ArrayLike<number>;
  series: PSeries[];
  height?: number;
  xFmt: (v: number) => string; // for tooltip head + table
  xTickFmt?: (v: number) => string;
  xTicks?: number[];
  xScale?: 'linear' | 'log';
  xDomain?: [number, number];
  yFmt?: (v: number) => string;
  yDomain?: [number, number];
  yTicks?: number[];
  invertY?: boolean;
  zero?: boolean;
  refs?: { y: number; label: string }[];
  forecastFrom?: number;
  endLabel?: boolean;
  tableFmt?: (s: PSeries, v: number) => string;
  legend?: boolean;
}

export function LineChart(p: LineChartProps) {
  const legend: LegendItem[] | undefined = p.legend === false ? undefined : p.series.filter((s) => !s.hidden).map((s) => ({ name: s.name, color: s.color }));
  const fmtV = (s: PSeries, v: number) => (p.tableFmt ? p.tableFmt(s, v) : s.fmt ? s.fmt(v) : (p.yFmt ?? ((q: number) => q.toFixed(1)))(v));
  return (
    <ChartFrame
      title={p.title}
      sub={p.sub}
      legend={legend}
      table={() => {
        const step = Math.max(1, Math.floor(p.x.length / 120));
        const rows: (string | number)[][] = [];
        for (let i = 0; i < p.x.length; i += step) rows.push([p.xFmt(p.x[i]), ...p.series.map((s) => (s.y[i] === s.y[i] ? fmtV(s, s.y[i]) : '—'))]);
        return { cols: ['', ...p.series.map((s) => s.name)], rows };
      }}
    >
      <Panel
        x={p.x}
        series={p.series}
        height={p.height ?? 220}
        xScale={p.xScale}
        xDomain={p.xDomain}
        xTicks={p.xTicks}
        xTickFmt={p.xTickFmt ?? p.xFmt}
        showXAxis
        yFmt={p.yFmt}
        yDomain={p.yDomain}
        yTicks={p.yTicks}
        invertY={p.invertY}
        zero={p.zero}
        refs={p.refs}
        forecastFrom={p.forecastFrom}
        endLabel={p.endLabel}
        tooltip={(i) => ({
          head: p.xFmt(p.x[i]),
          rows: p.series.filter((s) => !s.hidden && s.y[i] === s.y[i]).map((s) => ({ key: s.color, label: s.name, value: fmtV(s, s.y[i]) })),
        })}
      />
    </ChartFrame>
  );
}

// ───────────────────────── Stacked columns ─────────────────────────
export interface BarStack {
  id: string;
  name: string;
  color: string;
  values: number[];
}
export interface BarChartProps {
  title?: string;
  sub?: string;
  cats: string[]; // axis labels
  heads?: string[]; // tooltip titles
  stacks: BarStack[];
  height?: number;
  yFmt?: (v: number) => string;
  valFmt?: (v: number) => string;
  refLine?: { y: number; label: string };
  yMax?: number;
  tableCols?: string;
}

export function BarChart(p: BarChartProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hov, setHov] = useState<number | null>(null);
  const H = p.height ?? 200;
  const L = 44,
    R = 8,
    T = 10,
    B = 26;
  const iw = Math.max(10, w - L - R),
    ih = H - T - B;
  const n = p.cats.length;
  const totals = useMemo(() => p.cats.map((_, i) => p.stacks.reduce((s, st) => s + (st.values[i] || 0), 0)), [p.cats, p.stacks]);
  const max = p.yMax ?? Math.max(1, ...totals, p.refLine?.y ?? 0) * 1.06;
  const Y = lin(0, max, T + ih, T);
  const ticks = niceTicks(0, max, Math.max(2, Math.round(ih / 40)));
  const slot = iw / Math.max(1, n);
  const bw = Math.min(24, Math.max(4, slot * 0.7));
  const every = Math.max(1, Math.ceil(46 / slot));
  const yFmt = p.yFmt ?? ((v: number) => String(Math.round(v)));
  const valFmt = p.valFmt ?? yFmt;
  const GAP = 2;

  return (
    <ChartFrame
      title={p.title}
      sub={p.sub}
      legend={p.stacks.length > 1 ? p.stacks.map((s) => ({ name: s.name, color: s.color, box: true })) : undefined}
      table={() => ({ cols: [p.tableCols ?? '', ...p.stacks.map((s) => s.name), ...(p.stacks.length > 1 ? ['Total'] : [])], rows: p.cats.map((c, i) => [p.heads?.[i] ?? c, ...p.stacks.map((s) => valFmt(s.values[i] || 0)), ...(p.stacks.length > 1 ? [valFmt(totals[i])] : [])]) })}
    >
      <div className="chart" ref={ref} style={{ height: H }}>
        {w > 0 && (
          <svg width={w} height={H} role="img" aria-label={p.title ?? 'bar chart'}>
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid-line" x1={L} x2={L + iw} y1={Y(t)} y2={Y(t)} />
                <text className="tick" x={L - 8} y={Y(t)} textAnchor="end" dominantBaseline="middle">
                  {yFmt(t)}
                </text>
              </g>
            ))}
            {p.refLine && (
              <g>
                <line x1={L} x2={L + iw} y1={Y(p.refLine.y)} y2={Y(p.refLine.y)} stroke="#71717a" strokeWidth={1} />
                <text className="tick" x={L + iw - 2} y={Y(p.refLine.y) - 5} textAnchor="end">
                  {p.refLine.label}
                </text>
              </g>
            )}
            <line className="axis-line" x1={L} x2={L + iw} y1={T + ih} y2={T + ih} />
            {p.cats.map((c, i) => {
              const cx = L + slot * i + slot / 2;
              let acc = 0;
              const segs = p.stacks.map((s) => {
                const v = s.values[i] || 0;
                const y1 = Y(acc),
                  y2 = Y(acc + v);
                acc += v;
                return { s, v, y1, y2 };
              });
              const topIdx = segs.map((q) => q.v > 0).lastIndexOf(true);
              return (
                <g key={i} opacity={hov == null || hov === i ? 1 : 0.55}>
                  {segs.map((q, k) => {
                    if (q.v <= 0) return null;
                    const gap = k === segs.findIndex((z) => z.v > 0) ? 0 : GAP;
                    const h = Math.max(1, q.y1 - q.y2 - gap);
                    const y = q.y2;
                    return k === topIdx ? <path key={q.s.id} d={roundedTopRect(cx - bw / 2, y, bw, h, 4)} fill={q.s.color} /> : <rect key={q.s.id} x={cx - bw / 2} y={y} width={bw} height={h} fill={q.s.color} />;
                  })}
                  {i % every === 0 && (
                    <text className="tick" x={cx} y={T + ih + 17} textAnchor="middle">
                      {c}
                    </text>
                  )}
                  <rect x={L + slot * i} y={0} width={slot} height={T + ih} fill="transparent" onPointerMove={() => setHov(i)} onPointerLeave={() => setHov(null)} />
                </g>
              );
            })}
          </svg>
        )}
        {hov != null && w > 0 && (
          <Tooltip
            left={L + slot * hov + slot / 2}
            top={4}
            width={w}
            head={p.heads?.[hov] ?? p.cats[hov]}
            rows={[...p.stacks.filter((s) => (s.values[hov] || 0) > 0).map((s) => ({ key: s.color, label: s.name, value: valFmt(s.values[hov] || 0) } as TipRow)), ...(p.stacks.length > 1 ? [{ label: 'Total', value: valFmt(totals[hov]) }] : [])]}
          />
        )}
      </div>
    </ChartFrame>
  );
}

// ───────────────────────── Horizontal zone bars ─────────────────────────
export function ZoneBars({ zones, secs, colors, fmtRange }: { zones: { name: string; n: number }[]; secs: number[]; colors: string[]; fmtRange?: (i: number) => string }) {
  const total = secs.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...secs, 1);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {zones.map((z, i) => (
        <div key={z.n} style={{ display: 'grid', gridTemplateColumns: '112px 1fr 92px', gap: 12, alignItems: 'center' }} title={`${z.name}: ${fmtTime(secs[i])} (${((secs[i] / total) * 100).toFixed(0)} %)`}>
          <div style={{ fontSize: 12.5 }}>
            <span className="mono" style={{ color: 'var(--arcx-text-muted)' }}>Z{z.n}</span> {z.name}
            {fmtRange && <div className="muted mono" style={{ fontSize: 10.5 }}>{fmtRange(i)}</div>}
          </div>
          <div style={{ height: 14, display: 'flex', alignItems: 'center' }}>
            <div style={{ height: 14, width: `${(secs[i] / max) * 100}%`, minWidth: secs[i] > 0 ? 3 : 0, background: colors[i], borderRadius: '0 4px 4px 0' }} />
          </div>
          <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
            {fmtTime(secs[i])} <span className="muted">{((secs[i] / total) * 100).toFixed(0)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── Sparkline ─────────────────────────
export function Sparkline({ values, color = 'var(--arcx-text-muted)', height = 28, accent = 'var(--arcx-text)' }: { values: number[]; color?: string; height?: number; accent?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vs = values.filter((v) => v === v);
  if (vs.length < 2) return <div ref={ref} style={{ height }} />;
  const lo = Math.min(...vs),
    hi = Math.max(...vs);
  const X = lin(0, values.length - 1, 3, Math.max(10, w) - 5),
    Y = lin(lo, hi, height - 4, 4);
  const d = values.map((v, i) => (v === v ? `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}` : '')).join('');
  const last = values.length - 1;
  return (
    <div ref={ref} style={{ height, width: '100%' }}>
      {w > 0 && (
        <svg width={w} height={height} aria-hidden="true">
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={X(last)} cy={Y(values[last])} r={3.5} fill={accent} stroke="#111111" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

// ───────────────────────── Calendar heat ─────────────────────────
export function CalHeat({ days, startDay, weeks, weekStart = 1, fmtTitle }: { days: Map<number, number>; startDay: number; weeks: number; weekStart?: 0 | 1; fmtTitle: (day: number, v: number) => string }) {
  // align so first column starts on weekStart
  const dow = (((startDay + 4) % 7) + 7) % 7;
  const back = (dow - weekStart + 7) % 7;
  const first = startDay - back;
  const total = weeks * 7;
  const vals = [...days.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] ?? 1;
  const cuts = [q(0.25), q(0.5), q(0.8)];
  const cells = [];
  for (let i = 0; i < total; i++) {
    const d = first + i;
    const v = days.get(d) ?? 0;
    const lvl = v <= 0 ? 0 : v < cuts[0] ? 1 : v < cuts[1] ? 2 : v < cuts[2] ? 3 : 4;
    const alpha = [0, 0.22, 0.42, 0.68, 0.95][lvl];
    cells.push(<i key={i} title={fmtTitle(d, v)} style={lvl ? { background: `rgba(163,230,53,${alpha})` } : undefined} />);
  }
  return (
    <div>
      <div className="cal" role="img" aria-label="Daily training load calendar">
        {cells}
      </div>
      <div className="row muted mono" style={{ fontSize: 10.5, gap: 6, marginTop: 8 }}>
        less
        {[0.22, 0.42, 0.68, 0.95].map((a) => (
          <i key={a} style={{ width: 12, height: 12, borderRadius: 3, background: `rgba(163,230,53,${a})`, display: 'inline-block' }} />
        ))}
        more
      </div>
    </div>
  );
}

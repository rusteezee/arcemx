import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { lttbIndices, niceTicks } from '../../lib/stats';
import { areaPath, linePath, lin, nearest, Tooltip, useWidth, type TipRow } from './common';

export interface PSeries {
  id: string;
  name: string;
  color: string;
  y: ArrayLike<number>;
  width?: number;
  area?: boolean;
  fmt?: (v: number) => string;
  /** draw as 2px stepped "after" line (for load bars etc.) */
  hidden?: boolean;
}

export interface PanelProps {
  x: ArrayLike<number>;
  series: PSeries[];
  height?: number;
  xDomain?: [number, number];
  xScale?: 'linear' | 'log';
  xTicks?: number[];
  xTickFmt?: (v: number) => string;
  showXAxis?: boolean;
  yDomain?: [number, number];
  yTicks?: number[];
  yFmt?: (v: number) => string;
  invertY?: boolean;
  zero?: boolean; // draw an emphasised zero line
  refs?: { y: number; label: string }[];
  forecastFrom?: number;
  label?: string;
  endLabel?: boolean;
  leftPad?: number;
  hover?: number | null;
  onHover?: (i: number | null) => void;
  sel?: [number, number] | null;
  onSel?: (s: [number, number] | null) => void;
  /** standalone tooltip (used by LineChart; the activity stack uses a shared readout instead) */
  tooltip?: (i: number) => { head: string; rows: TipRow[] };
  children?: ReactNode;
}

const SURFACE = '#111111';

/**
 * A single line/area panel. Marks follow the dataviz spec: 2 px lines with round joins, ~10 % area wash,
 * ≥ 8 px hover marker with a 2 px surface ring, hairline solid grid, crosshair that snaps to the nearest x.
 */
export function Panel(p: PanelProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const cid = 'clip' + useId().replace(/[^a-z0-9]/gi, '');
  const H = p.height ?? 140;
  const L = p.leftPad ?? 46,
    R = p.endLabel ? 64 : 12,
    T = p.label ? 22 : 10, // headroom so the panel label never sits on the data
    B = p.showXAxis ? 24 : 6;
  const iw = Math.max(10, w - L - R),
    ih = H - T - B;
  const n = p.x.length;
  const [ownHover, setOwnHover] = useState<number | null>(null);
  const hover = p.hover !== undefined ? p.hover : ownHover;
  const setHover = (i: number | null) => (p.onHover ? p.onHover(i) : setOwnHover(i));
  const drag = useRef<number | null>(null);
  const [dragNow, setDragNow] = useState<[number, number] | null>(null);

  const xd: [number, number] = p.xDomain ?? [p.x[0] ?? 0, p.x[n - 1] ?? 1];
  const X = useMemo(() => {
    if (p.xScale === 'log') {
      const a = Math.log(xd[0]),
        b = Math.log(xd[1]);
      return (v: number) => L + ((Math.log(Math.max(v, 1e-9)) - a) / (b - a || 1)) * iw;
    }
    return lin(xd[0], xd[1], L, L + iw);
  }, [xd[0], xd[1], L, iw, p.xScale]); // eslint-disable-line react-hooks/exhaustive-deps
  const invX = (px: number) => {
    const f = Math.max(0, Math.min(1, (px - L) / iw));
    return p.xScale === 'log' ? Math.exp(Math.log(xd[0]) + f * (Math.log(xd[1]) - Math.log(xd[0]))) : xd[0] + f * (xd[1] - xd[0]);
  };

  // y domain
  const [y0, y1] = useMemo(() => {
    if (p.yDomain) return p.yDomain;
    let lo = Infinity,
      hi = -Infinity;
    for (const s of p.series) {
      if (s.hidden) continue;
      for (let i = 0; i < s.y.length; i++) {
        const v = s.y[i];
        if (v === v) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!isFinite(lo)) return [0, 1] as [number, number];
    if (p.zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const pad = (hi - lo || 1) * 0.08;
    return [lo - pad, hi + pad] as [number, number];
  }, [p.series, p.yDomain, p.zero]);
  const Y = p.invertY ? lin(y0, y1, T, T + ih) : lin(y0, y1, T + ih, T);
  const yTicks = p.yTicks ?? niceTicks(y0, y1, Math.max(2, Math.round(ih / 36)));
  const yFmt = p.yFmt ?? ((v: number) => String(Math.round(v * 100) / 100));

  const idx = useMemo(() => {
    const cap = Math.round(Math.max(60, iw) * 1.4);
    const first = p.series.find((s) => !s.hidden);
    return n > cap && first ? lttbIndices(p.x, first.y, cap) : null;
  }, [p.x, p.series, iw, n]);

  const pointer = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    return nearest(p.x, invX(e.clientX - r.left));
  };
  const onMove = (e: React.PointerEvent) => {
    const i = pointer(e);
    setHover(i);
    if (drag.current != null && p.onSel) setDragNow([Math.min(drag.current, i), Math.max(drag.current, i)]);
  };
  const onDown = (e: React.PointerEvent) => {
    if (!p.onSel) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = pointer(e);
    setDragNow(null);
  };
  const onUp = (e: React.PointerEvent) => {
    if (drag.current == null || !p.onSel) return;
    const i = pointer(e);
    const a = Math.min(drag.current, i),
      b = Math.max(drag.current, i);
    drag.current = null;
    setDragNow(null);
    p.onSel(b - a >= Math.max(5, n * 0.004) ? [a, b] : null);
  };

  const sel = dragNow ?? p.sel ?? null;
  const hx = hover != null && hover < n ? X(p.x[hover]) : null;
  const baseY = p.zero && y0 < 0 && y1 > 0 ? Y(0) : p.invertY ? T : T + ih;
  const tip = hover != null && hover < n && p.tooltip ? p.tooltip(hover) : null;

  return (
    <div className="chart" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={p.label ?? 'chart'} style={{ touchAction: p.onSel ? 'pan-y' : undefined }}>
          {yTicks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={L} x2={L + iw} y1={Y(t)} y2={Y(t)} />
              <text className="tick" x={L - 8} y={Y(t)} textAnchor="end" dominantBaseline="middle">
                {yFmt(t)}
              </text>
            </g>
          ))}
          {p.zero && y0 < 0 && y1 > 0 && <line className="axis-line" x1={L} x2={L + iw} y1={Y(0)} y2={Y(0)} />}
          {p.refs?.map((r) => (
            <g key={r.label}>
              <line x1={L} x2={L + iw} y1={Y(r.y)} y2={Y(r.y)} stroke="#52525b" strokeWidth={1} />
              <text className="tick" x={L + iw - 4} y={Y(r.y) - 5} textAnchor="end">
                {r.label}
              </text>
            </g>
          ))}
          {p.showXAxis && (
            <g>
              <line className="axis-line" x1={L} x2={L + iw} y1={T + ih} y2={T + ih} />
              {(p.xTicks ?? niceTicks(xd[0], xd[1], Math.max(2, Math.round(iw / 90)))).map((t) => (
                <text key={t} className="tick" x={X(t)} y={T + ih + 16} textAnchor="middle">
                  {(p.xTickFmt ?? ((v) => String(v)))(t)}
                </text>
              ))}
            </g>
          )}
          {p.forecastFrom != null && p.forecastFrom < xd[1] && (
            <g>
              <rect x={X(Math.max(p.forecastFrom, xd[0]))} y={T} width={Math.max(0, L + iw - X(Math.max(p.forecastFrom, xd[0])))} height={ih} fill="rgba(250,250,250,0.035)" />
              <text className="tick" x={X(p.forecastFrom) + 6} y={T + 11}>
                FORECAST
              </text>
            </g>
          )}
          {sel && <rect className="sel-band" x={X(p.x[sel[0]])} y={T} width={Math.max(1, X(p.x[sel[1]]) - X(p.x[sel[0]]))} height={ih} />}
          <defs>
            <clipPath id={cid}>
              <rect x={L} y={T - 2} width={iw + 1} height={ih + 4} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${cid})`}>
            {p.series.map(
              (s) =>
                !s.hidden && (
                  <g key={s.id}>
                    {s.area && <path d={areaPath(p.x, s.y, X, Y, baseY, idx)} fill={s.color} fillOpacity={0.1} />}
                    <path d={linePath(p.x, s.y, X, Y, idx)} fill="none" stroke={s.color} strokeWidth={s.width ?? 2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                ),
            )}
          </g>
          {p.endLabel &&
            p.series.map((s) => {
              if (s.hidden) return null;
              let li = s.y.length - 1;
              while (li > 0 && s.y[li] !== s.y[li]) li--;
              const v = s.y[li];
              if (v !== v) return null;
              return (
                <g key={s.id + 'e'}>
                  <circle cx={X(p.x[li])} cy={Y(v)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />
                  <text className="endlabel" x={X(p.x[li]) + 10} y={Y(v)} dominantBaseline="middle">
                    {s.name}
                  </text>
                </g>
              );
            })}
          {hx != null && (
            <g>
              <line className="crosshair" x1={hx} x2={hx} y1={T} y2={T + ih} />
              {p.series.map((s) => {
                if (s.hidden) return null;
                const v = s.y[hover!];
                if (v !== v) return null;
                return <circle key={s.id} cx={hx} cy={Y(v)} r={4} fill={s.color} stroke={SURFACE} strokeWidth={2} />;
              })}
            </g>
          )}
          {p.label && (
            <text className="axis-title" x={L} y={10} style={{ pointerEvents: 'none' }}>
              {p.label}
            </text>
          )}
          <rect
            x={L}
            y={0}
            width={iw}
            height={T + ih}
            fill="transparent"
            style={{ cursor: p.onSel ? 'crosshair' : 'default' }}
            onPointerMove={onMove}
            onPointerLeave={() => drag.current == null && setHover(null)}
            onPointerDown={onDown}
            onPointerUp={onUp}
          />
        </svg>
      )}
      {tip && hx != null && <Tooltip left={hx} top={4} width={w} head={tip.head} rows={tip.rows} />}
      {p.children}
    </div>
  );
}

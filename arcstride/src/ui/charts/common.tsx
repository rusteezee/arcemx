import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export const lin = (d0: number, d1: number, r0: number, r1: number) => {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
};

/** SVG path for a line with gaps wherever y is NaN. */
export function linePath(xs: ArrayLike<number>, ys: ArrayLike<number>, X: (v: number) => number, Y: (v: number) => number, idx?: number[] | null): string {
  let d = '';
  let pen = false;
  const n = idx ? idx.length : xs.length;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    const y = ys[i];
    if (y !== y) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function areaPath(xs: ArrayLike<number>, ys: ArrayLike<number>, X: (v: number) => number, Y: (v: number) => number, y0: number, idx?: number[] | null): string {
  const n = idx ? idx.length : xs.length;
  let d = '';
  let start = -1;
  const close = (endI: number) => {
    if (start >= 0) d += `L${X(xs[endI]).toFixed(1)},${y0.toFixed(1)}Z`;
    start = -1;
  };
  let lastI = -1;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    if (ys[i] !== ys[i]) {
      close(lastI);
      continue;
    }
    if (start < 0) {
      d += `M${X(xs[i]).toFixed(1)},${y0.toFixed(1)}L${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`;
      start = i;
    } else d += `L${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`;
    lastI = i;
  }
  close(lastI);
  return d;
}

/** nearest index in ascending x to value v */
export function nearest(x: ArrayLike<number>, v: number): number {
  let lo = 0,
    hi = x.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (x[m] < v) lo = m + 1;
    else hi = m;
  }
  if (lo > 0 && Math.abs(x[lo - 1] - v) <= Math.abs(x[lo] - v)) lo--;
  return lo;
}

export function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface TipRow {
  key?: string; // colour for the line key
  label: string;
  value: string;
}

export function Tooltip({ left, top, width, head, rows }: { left: number; top: number; width: number; head: string; rows: TipRow[] }) {
  const flip = left > width * 0.6;
  return (
    <div className="tooltip" style={{ left: flip ? undefined : left + 14, right: flip ? width - left + 14 : undefined, top }}>
      <div className="t-head">{head}</div>
      {rows.map((r, i) => (
        <div className="t-row" key={i}>
          <span className="k">
            {r.key && <i className="key" style={{ background: r.key }} />}
            {r.label}
          </span>
          <span className="v">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface LegendItem {
  name: string;
  color: string;
  box?: boolean;
}
export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null; // a single series needs no legend; the title names it
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <span className="item" key={it.name}>
          <i className={`key${it.box ? ' box' : ''}`} style={{ background: it.color }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

/** Title row + Chart/Table toggle. The table view keeps every value reachable without hovering. */
export function ChartFrame({ title, sub, legend, table, children, actions }: { title?: ReactNode; sub?: ReactNode; legend?: LegendItem[]; table?: () => { cols: string[]; rows: (string | number)[][] }; children: ReactNode; actions?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const t = asTable && table ? table() : null;
  return (
    <div>
      {(title || table || actions) && (
        <div className="chart-frame-head">
          <div>
            {title && <h3 style={{ fontSize: 16 }}>{title}</h3>}
            {sub && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</div>}
          </div>
          <div className="row">
            {actions}
            {table && (
              <div className="seg" role="group" aria-label="View">
                <button aria-pressed={!asTable} onClick={() => setAsTable(false)}>
                  Chart
                </button>
                <button aria-pressed={asTable} onClick={() => setAsTable(true)}>
                  Table
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {legend && !t && <Legend items={legend} />}
      {t ? (
        <div className="chart-table">
          <table className="tbl">
            <thead>
              <tr>
                {t.cols.map((c, i) => (
                  <th key={c} className={i ? 'r' : ''}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={j ? 'r' : ''}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

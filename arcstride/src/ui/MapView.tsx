import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mercX, mercY, unmercX, unmercY } from '../lib/geo';

export interface MapTrack {
  id: string;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  /** per-point metric values to colour the route (activity map) */
  values?: ArrayLike<number>;
}
export interface Ramp {
  domain: [number, number];
  colors: string[];
  labels?: [string, string];
}
export interface MapMarker {
  lat: number;
  lon: number;
  color: string;
  r?: number;
}
export interface TileCell {
  x: number;
  y: number;
  fresh?: boolean;
}

export const RAMPS = {
  plain: undefined,
  pace: { colors: ['#3f3f46', '#a1a1aa', '#fafafa'] },
  hr: { colors: ['#4a2323', '#a24545', '#f87171', '#fecaca'] },
  power: { colors: ['#4a3d0a', '#a58a12', '#facc15', '#fef08a'] },
  grade: { colors: ['#a3e635', '#52525b', '#f87171'] },
} as const;

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rampColor(colors: string[], t: number): string {
  const f = Math.max(0, Math.min(1, t)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(f));
  const u = f - i;
  const a = hexToRgb(colors[i]),
    b = hexToRgb(colors[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}

interface View {
  cx: number; // world px of centre at zoom z
  cy: number;
  z: number;
}

const tileCache = new Map<string, HTMLImageElement | 'loading' | 'fail'>();

export interface MapViewProps {
  tracks: MapTrack[];
  height?: number;
  mode?: 'route' | 'heat';
  ramp?: Ramp;
  fitKey?: string;
  markers?: MapMarker[];
  hover?: MapMarker | null;
  highlight?: { lat: ArrayLike<number>; lon: ArrayLike<number> } | null;
  basemap?: 'off' | 'carto';
  cells?: TileCell[]; // explorer tiles at z14
  heatAlpha?: number;
  interactive?: boolean;
  segments?: { lat: ArrayLike<number>; lon: ArrayLike<number>; color: string }[];
  onClick?: (lat: number, lon: number) => void;
  ariaLabel?: string;
}

export function MapView(p: MapViewProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [tick, setTick] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const interactive = p.interactive !== false;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // bbox of everything we draw
  const bbox = useMemo(() => {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const t of p.tracks) {
      const step = Math.max(1, Math.floor(t.lat.length / 800));
      for (let i = 0; i < t.lat.length; i += step) {
        const la = t.lat[i],
          lo = t.lon[i];
        if (la !== la || lo !== lo) continue;
        if (la < a) a = la;
        if (la > c) c = la;
        if (lo < b) b = lo;
        if (lo > d) d = lo;
      }
    }
    return isFinite(a) ? { minLat: a, minLon: b, maxLat: c, maxLon: d } : null;
  }, [p.tracks]);

  const fit = useCallback(() => {
    if (!bbox || size.w < 10) return;
    const z0 = 0;
    const wpx = Math.max(1e-6, mercX(bbox.maxLon, z0) - mercX(bbox.minLon, z0));
    const hpx = Math.max(1e-6, mercY(bbox.minLat, z0) - mercY(bbox.maxLat, z0));
    const pad = 36;
    const z = Math.min(19, Math.log2(Math.min((size.w - pad * 2) / wpx, (size.h - pad * 2) / hpx)));
    const cLat = (bbox.minLat + bbox.maxLat) / 2,
      cLon = (bbox.minLon + bbox.maxLon) / 2;
    setView({ cx: mercX(cLon, z), cy: mercY(cLat, z), z: isFinite(z) ? z : 12 });
  }, [bbox, size.w, size.h]);

  const fitted = useRef<string>('');
  useEffect(() => {
    const key = (p.fitKey ?? '') + '|' + (size.w > 10 ? 'ok' : 'no');
    if (size.w > 10 && (fitted.current !== key || !view)) {
      fitted.current = key;
      fit();
    }
  }, [p.fitKey, size.w, fit, view]);

  // ── draw ──
  useEffect(() => {
    const canvas = cv.current;
    if (!canvas || !view || size.w < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, size.w, size.h);
    const { cx, cy, z } = view;
    const ox = size.w / 2 - cx,
      oy = size.h / 2 - cy;
    const sx = (lon: number) => mercX(lon, z) + ox;
    const sy = (lat: number) => mercY(lat, z) + oy;

    // basemap tiles (opt-in)
    if (p.basemap === 'carto') {
      const zi = Math.max(0, Math.min(18, Math.round(z)));
      const scale = 2 ** (z - zi);
      const ts = 256 * scale;
      const wx0 = cx - size.w / 2,
        wy0 = cy - size.h / 2;
      const x0 = Math.floor(wx0 / ts),
        x1 = Math.floor((wx0 + size.w) / ts);
      const y0 = Math.floor(wy0 / ts),
        y1 = Math.floor((wy0 + size.h) / ts);
      const nTiles = 2 ** zi;
      const retina = dpr > 1 ? '@2x' : '';
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) {
          if (ty < 0 || ty >= nTiles) continue;
          const wrapX = ((tx % nTiles) + nTiles) % nTiles;
          const key = `${zi}/${wrapX}/${ty}${retina}`;
          let img = tileCache.get(key);
          if (!img) {
            const im = new Image();
            im.referrerPolicy = 'no-referrer';
            im.onload = () => {
              tileCache.set(key, im);
              setTick((t) => t + 1);
            };
            im.onerror = () => tileCache.set(key, 'fail');
            im.src = `https://${'abcd'[(wrapX + ty) % 4]}.basemaps.cartocdn.com/dark_all/${zi}/${wrapX}/${ty}${retina}.png`;
            tileCache.set(key, 'loading');
            img = 'loading';
          }
          if (img instanceof HTMLImageElement) ctx.drawImage(img, tx * ts - wx0, ty * ts - wy0, ts + 0.5, ts + 0.5);
        }
    } else {
      // faint graticule gives a sense of scale with no basemap
      const mpp = (156543.03392 * Math.cos(((unmercY(cy, z)) * Math.PI) / 180)) / 2 ** z;
      const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
      const stepM = nice.find((n) => n / mpp > 70) ?? 50000;
      const stepPx = stepM / mpp;
      ctx.strokeStyle = '#161618';
      ctx.lineWidth = 1;
      const gx0 = (((size.w / 2 - cx) % stepPx) + stepPx) % stepPx;
      const gy0 = (((size.h / 2 - cy) % stepPx) + stepPx) % stepPx;
      ctx.beginPath();
      for (let x = gx0; x < size.w; x += stepPx) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, size.h);
      }
      for (let y = gy0; y < size.h; y += stepPx) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(size.w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }

    // explorer cells (z14)
    if (p.cells?.length) {
      const k = 2 ** (z - 14);
      const ts = 256 * k;
      for (const c of p.cells) {
        const x = c.x * ts + ox,
          y = c.y * ts + oy;
        if (x > size.w || y > size.h || x + ts < 0 || y + ts < 0) continue;
        ctx.fillStyle = c.fresh ? 'rgba(163,230,53,0.22)' : 'rgba(163,230,53,0.09)';
        ctx.fillRect(x, y, ts, ts);
        ctx.strokeStyle = 'rgba(163,230,53,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
      }
    }

    const path = (t: { lat: ArrayLike<number>; lon: ArrayLike<number> }, stride: number) => {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < t.lat.length; i += stride) {
        const la = t.lat[i];
        if (la !== la) {
          pen = false;
          continue;
        }
        const x = sx(t.lon[i]),
          y = sy(la);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
    };

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (p.mode === 'heat') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(163,230,53,${p.heatAlpha ?? 0.16})`;
      ctx.lineWidth = Math.max(1.4, Math.min(3, 1 + (z - 10) * 0.25));
      let total = 0;
      for (const t of p.tracks) total += t.lat.length;
      const stride = total > 600000 ? 3 : 1;
      for (const t of p.tracks) {
        path(t, stride);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else {
      const t = p.tracks[0];
      if (t) {
        const stride = Math.max(1, Math.floor(t.lat.length / 3500));
        // casing
        path(t, stride);
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 6;
        ctx.stroke();
        if (p.ramp && t.values) {
          const [d0, d1] = p.ramp.domain;
          ctx.lineWidth = 3.5;
          let prevX = NaN,
            prevY = NaN;
          for (let i = 0; i < t.lat.length; i += stride) {
            const la = t.lat[i];
            if (la !== la) {
              prevX = NaN;
              continue;
            }
            const x = sx(t.lon[i]),
              y = sy(la);
            if (prevX === prevX) {
              const v = t.values[i];
              ctx.strokeStyle = v === v ? rampColor(p.ramp.colors, (v - d0) / (d1 - d0 || 1)) : '#52525b';
              ctx.beginPath();
              ctx.moveTo(prevX, prevY);
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            prevX = x;
            prevY = y;
          }
        } else {
          path(t, stride);
          ctx.strokeStyle = '#fafafa';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      for (let k = 1; k < p.tracks.length; k++) {
        path(p.tracks[k], 1);
        ctx.strokeStyle = 'rgba(250,250,250,0.35)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    for (const s of p.segments ?? []) {
      path(s, 1);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 7;
      ctx.stroke();
      path(s, 1);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    if (p.highlight) {
      path(p.highlight, 1);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 8;
      ctx.stroke();
      path(p.highlight, 1);
      ctx.strokeStyle = '#fafafa';
      ctx.lineWidth = 4.5;
      ctx.stroke();
    }
    const dot = (m: MapMarker) => {
      const x = sx(m.lon),
        y = sy(m.lat);
      ctx.beginPath();
      ctx.arc(x, y, (m.r ?? 5) + 2, 0, Math.PI * 2);
      ctx.fillStyle = '#111111';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, m.r ?? 5, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
    };
    p.markers?.forEach(dot);
    if (p.hover) dot({ ...p.hover, r: 6 });

    // scale bar
    const lat = unmercY(cy, z);
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
    const target = nice.find((n) => n / mpp >= 60) ?? 100000;
    const wpx = target / mpp;
    const bx = size.w - 14 - wpx,
      by = size.h - 34;
    ctx.strokeStyle = '#a1a1aa';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + wpx, by);
    ctx.lineTo(bx + wpx, by - 4);
    ctx.stroke();
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '10.5px "Geist Mono Variable", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(target >= 1000 ? `${target / 1000} km` : `${target} m`, bx + wpx, by - 8);
  }, [view, size, p.tracks, p.mode, p.ramp, p.markers, p.hover, p.highlight, p.basemap, p.cells, p.heatAlpha, p.segments, tick]);

  // ── interaction ──
  const zoomAt = (px: number, py: number, factor: number) => {
    setView((v) => {
      if (!v) return v;
      const nz = Math.max(2, Math.min(19, v.z + Math.log2(factor)));
      const k = 2 ** (nz - v.z);
      const wx = v.cx + (px - size.w / 2),
        wy = v.cy + (py - size.h / 2);
      return { z: nz, cx: wx * k - (px - size.w / 2), cy: wy * k - (py - size.h / 2) };
    });
  };
  useEffect(() => {
    const el = cv.current;
    if (!el || !interactive) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [interactive, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="map" ref={wrap} style={{ height: p.height ?? 380 }} role="img" aria-label={p.ariaLabel ?? 'Map'}>
      <canvas
        ref={cv}
        style={{ cursor: interactive ? (drag.current ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={(e) => {
          if (!interactive) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => (v ? { ...v, cx: v.cx - dx, cy: v.cy - dy } : v));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved && p.onClick && view) {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const wx = view.cx + (e.clientX - r.left - size.w / 2),
              wy = view.cy + (e.clientY - r.top - size.h / 2);
            p.onClick(unmercY(wy, view.z), unmercX(wx, view.z));
          }
        }}
        onDoubleClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          zoomAt(e.clientX - r.left, e.clientY - r.top, 2);
        }}
      />
      {interactive && (
        <div className="map-ui">
          <button aria-label="Zoom in" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.6)}>
            +
          </button>
          <button aria-label="Zoom out" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.6)}>
            −
          </button>
          <button aria-label="Fit to route" onClick={fit}>
            ⌖
          </button>
        </div>
      )}
      {p.ramp && p.ramp.labels && (
        <div className="map-legend">
          <span>{p.ramp.labels[0]}</span>
          <span className="ramp">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} style={{ background: rampColor(p.ramp!.colors, i / 11) }} />
            ))}
          </span>
          <span>{p.ramp.labels[1]}</span>
        </div>
      )}
      {p.basemap === 'carto' && <div className="attrib">© OpenStreetMap contributors · © CARTO</div>}
    </div>
  );
}

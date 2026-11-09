import type { ActivitySummary, Loads, PrivacyZone, Profile, Track } from './types';
import { fmtDate, fmtDistU, fmtDur, fmtSpeedFor, sportLabel } from './units';
import { inPrivacyZone } from './export';

/**
 * Render a 1080×1350 share card in the ArcArmor look (near-black, hairline, mono eyebrow, one hero glow).
 * Privacy zones are applied: points inside a zone are dropped from the drawn route.
 */
export async function renderShareCard(a: ActivitySummary, track: Track | undefined, loads: Loads | undefined, profile: Profile, zones: PrivacyZone[]): Promise<Blob> {
  try {
    await Promise.all([document.fonts.load('600 64px "Geist Variable"'), document.fonts.load('400 24px "Geist Mono Variable"'), document.fonts.load('600 24px "Geist Variable"')]);
  } catch {
    /* fall back to system fonts */
  }
  const W = 1080,
    H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);
  // hero glow — the one gradient in the system
  const g = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, 900);
  g.addColorStop(0, 'rgba(255,255,255,0.14)');
  g.addColorStop(0.7, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 800);

  const sans = '"Geist Variable", Geist, -apple-system, "Segoe UI", sans-serif';
  const mono = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
  ctx.fillStyle = '#a1a1aa';
  ctx.font = `400 22px ${mono}`;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '3px';
  ctx.fillText(`001 / 001 · ${sportLabel(a.sport).toUpperCase()} · ${fmtDate(a.start, a.tz).toUpperCase()}`, 72, 96);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '-1.5px';
  ctx.fillStyle = '#fafafa';
  ctx.font = `600 72px ${sans}`;
  const title = a.name.length > 26 ? a.name.slice(0, 25) + '…' : a.name;
  ctx.fillText(title, 72, 190);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';

  // route
  const box = { x: 72, y: 250, w: W - 144, h: 640 };
  ctx.strokeStyle = '#27272a';
  ctx.lineWidth = 2;
  roundRect(ctx, box.x, box.y, box.w, box.h, 22);
  ctx.stroke();
  if (track && track.n > 2) {
    const pts: [number, number][] = [];
    for (let i = 0; i < track.n; i++) if (!inPrivacyZone(track.lat[i], track.lon[i], zones)) pts.push([track.lon[i], track.lat[i]]);
    if (pts.length > 2) {
      let minLo = Infinity,
        maxLo = -Infinity,
        minLa = Infinity,
        maxLa = -Infinity;
      for (const [lo, la] of pts) {
        minLo = Math.min(minLo, lo);
        maxLo = Math.max(maxLo, lo);
        minLa = Math.min(minLa, la);
        maxLa = Math.max(maxLa, la);
      }
      const k = Math.cos(((minLa + maxLa) / 2) * (Math.PI / 180));
      const spanX = Math.max(1e-9, (maxLo - minLo) * k),
        spanY = Math.max(1e-9, maxLa - minLa);
      const pad = 56;
      const s = Math.min((box.w - pad * 2) / spanX, (box.h - pad * 2) / spanY);
      const ox = box.x + (box.w - spanX * s) / 2,
        oy = box.y + (box.h - spanY * s) / 2;
      const P = (lo: number, la: number): [number, number] => [ox + (lo - minLo) * k * s, box.y + box.h - (oy - box.y) - (la - minLa) * s];
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach(([lo, la], i) => {
        const [x, y] = P(lo, la);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.strokeStyle = 'rgba(163,230,53,0.25)';
      ctx.lineWidth = 14;
      ctx.stroke();
      ctx.strokeStyle = '#fafafa';
      ctx.lineWidth = 5;
      ctx.stroke();
      const [sx, sy] = P(pts[0][0], pts[0][1]);
      const [ex, ey] = P(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      dot(ctx, sx, sy, '#4ade80');
      dot(ctx, ex, ey, '#f87171');
    }
  } else {
    ctx.fillStyle = '#52525b';
    ctx.font = `400 28px ${mono}`;
    ctx.textAlign = 'center';
    ctx.fillText('no GPS track', box.x + box.w / 2, box.y + box.h / 2);
    ctx.textAlign = 'left';
  }

  // stats
  const sp = fmtSpeedFor(a.sport, a.avgSpeed, profile.units);
  const stats: [string, string, string][] = [
    ['DISTANCE', fmtDistU(a.distance, profile.units, 2).split(' ')[0], profile.units === 'metric' ? 'km' : 'mi'],
    ['TIME', fmtDur(a.moving), ''],
    [a.sport === 'ride' ? 'SPEED' : 'PACE', sp.value, sp.unit],
  ];
  if (loads) stats.push(['LOAD', String(Math.round(loads.load)), loads.method]);
  const colW = (W - 144) / stats.length;
  stats.forEach(([k, v, u], i) => {
    const x = 72 + colW * i;
    ctx.fillStyle = '#a1a1aa';
    ctx.font = `400 20px ${mono}`;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '3px';
    ctx.fillText(k, x, 980);
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '-1px';
    ctx.fillStyle = '#fafafa';
    ctx.font = `600 64px ${sans}`;
    ctx.fillText(v, x, 1055);
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
    if (u) {
      const w = ctx.measureText(v).width;
      ctx.fillStyle = '#a1a1aa';
      ctx.font = `400 24px ${mono}`;
      ctx.fillText(u, x + w + 10, 1055);
    }
  });

  // footer
  ctx.strokeStyle = '#27272a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(72, 1200);
  ctx.lineTo(W - 72, 1200);
  ctx.stroke();
  ctx.fillStyle = '#fafafa';
  ctx.font = `600 30px ${sans}`;
  ctx.fillText('◈ ArcStride', 72, 1262);
  ctx.fillStyle = '#a1a1aa';
  ctx.font = `400 20px ${mono}`;
  ctx.textAlign = 'right';
  ctx.fillText(zones.length ? 'PRIVACY ZONES APPLIED' : 'EVERY NUMBER SHOWS ITS MATH', W - 72, 1262);
  ctx.textAlign = 'left';

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0a0a';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

"use client";

import {
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useMemo } from "react";

export interface Series {
  key: string;        // unique series id (used as data-key on x-axis-aligned object)
  label: string;      // legend display
  color: string;      // stroke color
  points: { date: string; value: number }[];
}

interface Props {
  series: Series[];                 // all series (may be empty)
  visibleKeys: Set<string>;         // subset rendered; rest hidden
  height?: number;
  normalize?: boolean;              // rebase each series to 100 at first visible point
}

function parseDate(s: string): number {
  if (s.includes("T")) return new Date(s).getTime();
  return new Date(s + "T00:00:00Z").getTime();
}

function fmtDateTick(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function MultiLineChart({
  series,
  visibleKeys,
  height = 380,
  normalize = true,
}: Props) {
  // Build a unified x-axis from the union of all visible series' dates.
  // Recharts wants one array of objects keyed by ts plus per-series fields.
  const merged = useMemo(() => {
    const visible = series.filter((s) => visibleKeys.has(s.key));
    if (visible.length === 0) return [] as Array<Record<string, number>>;

    // Optional rebase to 100 at first point of EACH series so axes share
    // a common percent scale and 25k Nifty vs 56k Sensex don't crush
    // smaller-scale lines.
    const adjusted = visible.map((s) => {
      const pts = s.points || [];
      if (!normalize || pts.length === 0) {
        return { key: s.key, pts: pts.map((p) => ({ ts: parseDate(p.date), v: p.value })) };
      }
      const base = pts[0].value;
      if (!Number.isFinite(base) || base === 0) {
        return { key: s.key, pts: pts.map((p) => ({ ts: parseDate(p.date), v: p.value })) };
      }
      return {
        key: s.key,
        pts: pts.map((p) => ({
          ts: parseDate(p.date),
          v: (p.value / base) * 100,
        })),
      };
    });

    // Build the merged table keyed by timestamp.
    const byTs = new Map<number, Record<string, number>>();
    for (const { key, pts } of adjusted) {
      for (const { ts, v } of pts) {
        let row = byTs.get(ts);
        if (!row) {
          row = { ts };
          byTs.set(ts, row);
        }
        row[key] = v;
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }, [series, visibleKeys, normalize]);

  const visible = series.filter((s) => visibleKeys.has(s.key));

  if (merged.length === 0 || visible.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-sm text-[var(--muted)]"
      >
        No series visible. Toggle a label below to render.
      </div>
    );
  }

  // Y-axis bounds. When normalized, both extremes need padding so the
  // line never hugs the frame edge.
  const yValues = merged.flatMap((row) =>
    visible.map((s) => row[s.key]).filter((v) => typeof v === "number" && Number.isFinite(v))
  );
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const pad = Math.max(0.5, (yMax - yMin) * 0.08);
  const domain: [number, number] = [yMin - pad, yMax + pad];

  return (
    <div className="h-scroll md:overflow-visible">
      {/* On mobile the card shrinks to viewport width and the chart
       * compresses to ~340px — date ticks collapse to 2 labels and lines
       * stack on top of each other. Wrap in a horizontal scroller with a
       * larger min-width so the user can swipe the chart sideways and
       * still read every tick. Desktop ignores the scroller (min-w-0,
       * overflow-visible) so the chart fills its card normally. */}
      <div className="min-w-[640px] md:min-w-0">
        <ResponsiveContainer width="100%" height={height}>
          <RLineChart data={merged} margin={{ top: 10, right: 20, bottom: 8, left: 4 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          scale="time"
          tickFormatter={fmtDateTick}
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          axisLine={{ stroke: "var(--border)" }}
          tickLine={false}
          minTickGap={50}
        />
        <YAxis
          domain={domain}
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
          width={56}
          tickFormatter={(v) =>
            normalize ? `${(v as number).toFixed(0)}` : `${(v as number).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
          }
        />
        <Tooltip
          labelFormatter={(ts) => fmtDateTick(Number(ts))}
          formatter={(value: any, name: any) => {
            const s = visible.find((x) => x.key === name);
            const label = s?.label || String(name);
            const v = typeof value === "number" ? value.toFixed(2) : value;
            return [normalize ? `${v}` : v, label];
          }}
          /* allowEscapeViewBox lets the tooltip render outside the
           * chart bounding box; without it the tooltip clips against
           * the right edge of the chart on mobile and entries read as
           * "Sensex : 10" or "BankNifty :" with values truncated.
           * wrapperStyle caps the maximum width so the tooltip stays
           * legible regardless of which point gets hovered. */
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 50, maxWidth: 240 }}
          contentStyle={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            fontSize: 12,
            maxWidth: 240,
            whiteSpace: "normal",
          }}
        />
        {visible.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.key}
            stroke={s.color}
            strokeWidth={1.6}
            dot={false}
            connectNulls
            isAnimationActive
            animationDuration={1100}
            animationBegin={i * 60}
            animationEasing="ease-out"
          />
        ))}
      </RLineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

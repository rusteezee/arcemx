"use client";

import {
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
} from "recharts";

interface Point {
  date: string;
  value: number;
}

interface LineChartProps {
  data: Point[];
  height?: number;
  color?: string;
  fill?: boolean;
  yTickFormatter?: (val: number) => string;
}

// Build N uniformly-spaced numeric ticks across [min, max].
function buildLinearTicks(min: number, max: number, n: number): number[] {
  if (n <= 1 || max <= min) return [min];
  const step = (max - min) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(min + step * i);
  return out;
}

function formatTick(ts: number): string {
  const d = new Date(ts);
  // ISO yyyy-mm-dd to match rest of dashboard
  return d.toISOString().slice(0, 10);
}

export function LineChart({
  data,
  height = 300,
  color = "var(--foreground)",
  fill = true,
  yTickFormatter,
}: LineChartProps) {
  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-sm text-[var(--muted)]"
      >
        No data
      </div>
    );
  }

  const X_TICK_COUNT = 10;
  const Y_TICK_COUNT = 5;

  // Convert ISO date strings to numeric timestamps so the X axis can be
  // treated as a continuous numeric scale. That lets us request exactly
  // N evenly-spaced ticks across the full time range, regardless of how
  // many actual data points exist.
  const numericData = data
    .map((d) => ({ ts: new Date(d.date + "T00:00:00Z").getTime(), value: d.value }))
    .filter((d) => !Number.isNaN(d.ts));

  const tsMin = numericData[0].ts;
  const tsMax = numericData[numericData.length - 1].ts;
  const xTicks = buildLinearTicks(tsMin, tsMax, X_TICK_COUNT);

  // All X-axis labels are centred on their tick. Pad the plot horizontally
  // so the first and last labels have room to render fully without being
  // clipped, which keeps the visual gap between every label uniform.
  const commonXAxis = {
    type: "number" as const,
    dataKey: "ts",
    domain: [tsMin, tsMax] as [number, number],
    scale: "time" as const,
    ticks: xTicks,
    interval: 0 as const,
    tickFormatter: formatTick,
    tick: { fontSize: 11, fill: "var(--muted)" },
    tickLine: false as const,
    tickMargin: 10,
    padding: { left: 40, right: 40 },
    allowDataOverflow: false as const,
  };

  if (fill) {
    return (
      <div className="overflow-x-auto">
        <div style={{ minWidth: 1100 }}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={numericData} margin={{ top: 12, right: 16, left: 4, bottom: 16 }}>
          <defs>
            <linearGradient id="gFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            {...commonXAxis}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={yTickFormatter}
            domain={["dataMin", "dataMax"]}
            tickCount={Y_TICK_COUNT}
            interval={0}
            width={68}
            tickMargin={6}
            padding={{ top: 0, bottom: 10 }}
          />
          <Tooltip
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              fontFamily: "var(--font-geist-mono)",
            }}
            labelStyle={{ color: "var(--muted)", fontSize: 11 }}
            labelFormatter={(label) => formatTick(label as number)}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill="url(#gFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: color }}
          />
        </AreaChart>
      </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 720 }}>
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={numericData} margin={{ top: 12, right: 16, left: 4, bottom: 16 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis {...commonXAxis} />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yTickFormatter}
          tickCount={Y_TICK_COUNT}
          interval={0}
          width={68}
          tickMargin={6}
          padding={{ top: 0, bottom: 10 }}
        />
        <Tooltip
          contentStyle={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(label) => formatTick(label as number)}
        />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </RLineChart>
    </ResponsiveContainer>
      </div>
    </div>
  );
}

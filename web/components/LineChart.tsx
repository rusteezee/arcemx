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

// Build an array of N evenly-spaced ticks from the data so every chart
// has the same number of x-axis labels regardless of point density.
function buildXTicks(data: Point[], n: number): string[] {
  if (data.length === 0) return [];
  if (data.length <= n) return data.map((d) => d.date);
  const out: string[] = [];
  const step = (data.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    out.push(data[idx].date);
  }
  return Array.from(new Set(out));
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
  const xTicks = buildXTicks(data, X_TICK_COUNT);

  if (fill) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 16 }}>
          <defs>
            <linearGradient id="gFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
            ticks={xTicks}
            interval={0}
            tickMargin={10}
            padding={{ left: 8, right: 8 }}
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
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 16 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          tickLine={false}
          ticks={xTicks}
          interval={0}
          tickMargin={10}
          padding={{ left: 8, right: 8 }}
        />
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
        />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </RLineChart>
    </ResponsiveContainer>
  );
}

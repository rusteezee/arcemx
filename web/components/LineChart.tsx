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

  if (fill) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
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
            minTickGap={40}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={{ stroke: "var(--border)" }}
            tickLine={false}
            tickFormatter={yTickFormatter}
            domain={["dataMin", "dataMax"]}
            width={56}
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
      <RLineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} minTickGap={40} />
        <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} tickFormatter={yTickFormatter} width={56} />
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

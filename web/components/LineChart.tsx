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

// Parse either a date-only string ("YYYY-MM-DD") or a full ISO timestamp
// ("YYYY-MM-DDTHH:MM:SS...Z") into a numeric epoch ms.
function parseDate(s: string): number {
  if (s.includes("T")) return new Date(s).getTime();
  return new Date(s + "T00:00:00Z").getTime();
}

const IST_TIME_FMT = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

const DAY_MS = 86400_000;

function formatTickForSpan(ts: number, spanMs: number): string {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  // 1D-ish span: time of day in IST only (NSE intraday window).
  if (spanMs <= 1.5 * DAY_MS) {
    const parts = IST_TIME_FMT.formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${h}:${mi}`;
  }
  // ~1W intraday: combined date + IST time so multi-day intraday is readable.
  if (spanMs <= 10 * DAY_MS) {
    const parts = IST_TIME_FMT.formatToParts(d);
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${dd}/${mm} ${h}:${mi}`;
  }
  // 1M-3M-ish: short date.
  if (spanMs <= 120 * DAY_MS) return `${dd}/${mm}`;
  // Long spans: full dd/mm/yyyy.
  return `${dd}/${mm}/${yyyy}`;
}

// Backwards-compatible default formatter (used by tooltip when caller has
// no span context). Always full dd/mm/yyyy in UTC.
function formatTick(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatValue(v: unknown): string {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// Default Y-axis tick formatter when a chart doesn't pass its own:
// Indian commas, max 0 decimals for >=1000, 2 decimals otherwise.
function defaultYTick(v: number): string {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return v >= 1000
    ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 })
    : v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
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

  // Convert date strings (either "YYYY-MM-DD" or full ISO) to numeric
  // timestamps so the X axis can be treated as a continuous numeric scale.
  // That lets us request exactly N evenly-spaced ticks across the full time
  // range, regardless of how many actual data points exist.
  const numericData = data
    .map((d) => ({ ts: parseDate(d.date), value: d.value }))
    .filter((d) => !Number.isNaN(d.ts));

  const tsMin = numericData[0].ts;
  const tsMax = numericData[numericData.length - 1].ts;
  const spanMs = Math.max(1, tsMax - tsMin);
  const xTicks = buildLinearTicks(tsMin, tsMax, X_TICK_COUNT);
  const xTickFormatter = (ts: number) => formatTickForSpan(ts, spanMs);
  const tooltipLabelFormatter = (label: number) => {
    if (spanMs <= 10 * DAY_MS) {
      // Include IST time for intraday tooltips.
      const d = new Date(label);
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = d.getUTCFullYear();
      const parts = IST_TIME_FMT.formatToParts(d);
      const h = parts.find((p) => p.type === "hour")?.value ?? "00";
      const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
      return `${dd}/${mm}/${yyyy} ${h}:${mi} IST`;
    }
    return formatTick(label);
  };

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
    tickFormatter: xTickFormatter,
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
            tickFormatter={yTickFormatter ?? defaultYTick}
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
            labelFormatter={(label) => tooltipLabelFormatter(label as number)}
            formatter={(val) => [formatValue(val), "value"]}
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
          formatter={(val) => [formatValue(val), "value"]}
        />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
      </RLineChart>
    </ResponsiveContainer>
      </div>
    </div>
  );
}

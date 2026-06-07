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

// 24-hour IST formatter — we read the parts and convert to 12-hour
// AM/PM uppercase ourselves to guarantee the brand format regardless of
// locale defaults ("am"/"pm" lowercase vs "AM"/"PM" uppercase).
const IST_HOUR24_FMT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Kolkata",
});

function formatISTTime12(d: Date): string {
  const parts = IST_HOUR24_FMT.formatToParts(d);
  const h24 = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mi = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = h24 >= 12 ? "PM" : "AM";
  const h12raw = h24 % 12 === 0 ? 12 : h24 % 12;
  const h12 = String(h12raw).padStart(2, "0");
  return `${h12}:${mi} ${dayPeriod}`;
}

const DAY_MS = 86400_000;

function formatTickForSpan(ts: number, spanMs: number, isIntraday: boolean): string {
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  if (isIntraday) {
    // Sub-day span: time of day only (NSE intraday window).
    if (spanMs <= 1.5 * DAY_MS) return formatISTTime12(d);
    // Multi-day intraday: date + IST time.
    return `${dd}/${mm} ${formatISTTime12(d)}`;
  }
  // Daily / weekly / monthly candles: always dd/mm/yyyy so the year is
  // never ambiguous across the full chart, including 1M and 3M ranges
  // that previously dropped the year and confused the reader.
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

  // Detect intraday data by checking whether any date string carries a
  // time component. Daily / weekly / monthly candles are date-only
  // ("YYYY-MM-DD"); intraday candles are full ISO with a "T" separator.
  const isIntraday = data.some((d) => typeof d.date === "string" && d.date.includes("T"));

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
  const xTickFormatter = (ts: number) => formatTickForSpan(ts, spanMs, isIntraday);
  const tooltipLabelFormatter = (label: number) => {
    if (isIntraday) {
      const d = new Date(label);
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = d.getUTCFullYear();
      return `${dd}/${mm}/${yyyy} ${formatISTTime12(d)} IST`;
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

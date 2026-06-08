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
  // Optional second series (e.g. invested cost basis) plotted alongside
  // the primary value line. When present, the chart renders a second
  // line, expands the Y domain to cover both, and updates the tooltip
  // and legend to show both values.
  invested?: number;
}

interface LineChartProps {
  data: Point[];
  height?: number;
  color?: string;
  fill?: boolean;
  yTickFormatter?: (val: number) => string;
  // Display label for the primary `value` series in tooltip + legend.
  // Defaults to "Value".
  valueLabel?: string;
  // Display label for the secondary `invested` series. Defaults to
  // "Invested". Only used when at least one data point carries an
  // `invested` field.
  investedLabel?: string;
  // Stroke for the secondary series. Defaults to muted gray.
  investedColor?: string;
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
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

// Default Y-axis tick formatter when a chart doesn't pass its own:
// ₹ prefix + Indian commas, 0 decimals for >=1000, 2 decimals otherwise.
function defaultYTick(v: number): string {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return v >= 1000
    ? `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
    : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function LineChart({
  data,
  height = 300,
  color = "var(--foreground)",
  fill = true,
  yTickFormatter,
  valueLabel = "Value",
  investedLabel = "Invested",
  investedColor = "var(--muted)",
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

  const hasInvested = data.some((d) => typeof d.invested === "number");

  // Convert date strings (either "YYYY-MM-DD" or full ISO) to numeric
  // timestamps so the X axis can be treated as a continuous numeric scale.
  // That lets us request exactly N evenly-spaced ticks across the full time
  // range, regardless of how many actual data points exist.
  const numericData = data
    .map((d) => ({
      ts: parseDate(d.date),
      value: d.value,
      invested: typeof d.invested === "number" ? d.invested : undefined,
    }))
    .filter((d) => !Number.isNaN(d.ts));

  const tsMin = numericData[0].ts;
  const tsMax = numericData[numericData.length - 1].ts;
  const spanMs = Math.max(1, tsMax - tsMin);
  const xTicks = buildLinearTicks(tsMin, tsMax, X_TICK_COUNT);

  // Compute explicit Y-axis ticks linearly across [yMin, yMax]. Recharts'
  // built-in "nice rounding" picks tick values that don't space evenly
  // against the actual data range, which produced uneven gaps and an
  // overlapping top label (e.g. 85,707 crammed against 77,811). Using
  // our own buildLinearTicks gives 5 perfectly uniform Y gridlines.
  const yValues: number[] = [];
  for (const d of numericData) {
    yValues.push(d.value);
    if (typeof d.invested === "number") yValues.push(d.invested);
  }
  const yMinRaw = Math.min(...yValues);
  const yMaxRaw = Math.max(...yValues);
  const yTicks = buildLinearTicks(yMinRaw, yMaxRaw, Y_TICK_COUNT);
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
      {hasInvested && (
        <div className="flex items-center gap-4 mb-3 text-xs text-[var(--muted)]">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-[2px] w-5 rounded" style={{ background: color }} />
            {valueLabel}
          </span>
          <span className="inline-flex items-center gap-2">
            <span
              className="inline-block h-[2px] w-5 rounded"
              style={{
                background: `repeating-linear-gradient(to right, ${investedColor} 0 4px, transparent 4px 8px)`,
              }}
            />
            {investedLabel}
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={numericData} margin={{ top: 12, right: 16, left: 4, bottom: 16 }}>
          <defs>
            <linearGradient id="gFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--border)"
            strokeDasharray="2 4"
            vertical={false}
            syncWithTicks
          />
          <XAxis
            {...commonXAxis}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={yTickFormatter ?? defaultYTick}
            domain={[yMinRaw, yMaxRaw]}
            ticks={yTicks}
            interval={0}
            width={84}
            tickMargin={6}
            padding={{ top: 14, bottom: 14 }}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload || !payload.length) return null;
              const point = payload[0]?.payload ?? {};
              const cur: number | undefined = point.value;
              const inv: number | undefined = point.invested;
              const hasInv = typeof inv === "number";
              const pnl = hasInv && typeof cur === "number" ? cur - (inv as number) : null;
              const pct =
                hasInv && (inv as number) > 0 && pnl !== null
                  ? (pnl / (inv as number)) * 100
                  : null;
              const positive = (pnl ?? 0) >= 0;
              const pnlColor = positive ? "var(--gain)" : "var(--loss)";
              return (
                <div
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 12,
                    fontFamily: "var(--font-geist-mono)",
                    color: "var(--foreground)",
                    minWidth: 180,
                  }}
                >
                  <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 6 }}>
                    {tooltipLabelFormatter(label as number)}
                  </div>
                  {hasInv && (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "var(--muted)" }}>{investedLabel}</span>
                      <span>{formatValue(inv)}</span>
                    </div>
                  )}
                  {typeof cur === "number" && (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span style={{ color: "var(--muted)" }}>{valueLabel}</span>
                      <span style={{ fontWeight: 600 }}>{formatValue(cur)}</span>
                    </div>
                  )}
                  {pct !== null && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        marginTop: 4,
                        paddingTop: 4,
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ color: "var(--muted)" }}>P&amp;L</span>
                      <span style={{ color: pnlColor, fontWeight: 600 }}>
                        {positive ? "+" : ""}
                        {pct.toFixed(2)}%
                      </span>
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill="url(#gFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0, fill: color }}
            isAnimationActive={false}
          />
          {hasInvested && (
            <Area
              type="monotone"
              dataKey="invested"
              stroke={investedColor}
              strokeWidth={1.6}
              strokeDasharray="4 4"
              fill="transparent"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: investedColor }}
              isAnimationActive={false}
            />
          )}
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
        <CartesianGrid
            stroke="var(--border)"
            strokeDasharray="2 4"
            vertical={false}
            syncWithTicks
          />
        <XAxis {...commonXAxis} />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yTickFormatter ?? defaultYTick}
          domain={[yMinRaw, yMaxRaw]}
          ticks={yTicks}
          interval={0}
          width={84}
          tickMargin={6}
          padding={{ top: 14, bottom: 14 }}
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

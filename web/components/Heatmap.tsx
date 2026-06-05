"use client";

import { cn, stripTicker } from "@/lib/utils";

interface HeatItem {
  ticker: string;
  pct: number;
  weight: number;
}

interface HeatmapProps {
  items: HeatItem[];
}

function color(pct: number): string {
  const clamped = Math.max(-5, Math.min(5, pct));
  if (clamped >= 0) {
    const alpha = 0.08 + (clamped / 5) * 0.42;
    return `color-mix(in srgb, var(--gain) ${alpha * 100}%, var(--card))`;
  }
  const alpha = 0.08 + (Math.abs(clamped) / 5) * 0.42;
  return `color-mix(in srgb, var(--loss) ${alpha * 100}%, var(--card))`;
}

export function Heatmap({ items }: HeatmapProps) {
  if (!items.length) {
    return (
      <div className="card p-8 text-center text-sm text-[var(--muted)]">
        No data
      </div>
    );
  }
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  return (
    <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
      {sorted.map((it) => {
        const positive = it.pct >= 0;
        return (
          <div
            key={it.ticker}
            className={cn(
              "rounded-lg border border-border p-3 transition-transform hover:scale-[1.03]",
              "flex flex-col justify-between min-h-[78px]"
            )}
            style={{ background: color(it.pct) }}
          >
            <div className="text-xs font-medium truncate">{stripTicker(it.ticker)}</div>
            <div
              className={cn(
                "text-sm font-semibold num mt-1",
                positive ? "text-[var(--gain)]" : "text-[var(--loss)]"
              )}
            >
              {positive ? "+" : ""}
              {it.pct.toFixed(2)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

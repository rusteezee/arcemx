import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface StatProps {
  label: string;
  value: ReactNode;
  delta?: string;
  deltaPositive?: boolean;
  glyph?: string;
}

export function Stat({ label, value, delta, deltaPositive, glyph }: StatProps) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="section-num">{label}</div>
        {glyph && <span className="glyph text-sm">{glyph}</span>}
      </div>
      <div className="text-xl sm:text-2xl font-semibold tracking-tight num break-words">{value}</div>
      {delta && (
        <div
          className={cn(
            "text-xs mt-1 num font-medium",
            deltaPositive == null
              ? "text-[var(--muted)]"
              : deltaPositive
              ? "text-[var(--gain)]"
              : "text-[var(--loss)]"
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}

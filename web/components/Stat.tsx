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
      <div className="flex items-center justify-between mb-2 gap-2">
        {/* whitespace-nowrap keeps long Stat labels (e.g.
         * "NIFTY VS MIDCAP 150", "FII CASH FLOW") on a single line in
         * the Accuracy New Dimensions grid. Combined with min-w-0 the
         * label truncates with ellipsis if a card is narrower than the
         * text, rather than wrapping to a second line that throws off
         * the row of cards' vertical alignment. */}
        <div className="section-num whitespace-nowrap overflow-hidden text-ellipsis min-w-0">{label}</div>
        {glyph && <span className="glyph text-sm shrink-0">{glyph}</span>}
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

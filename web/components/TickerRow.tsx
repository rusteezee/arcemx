import { cn, currencySymbol, formatPct, stripTicker } from "@/lib/utils";

interface TickerRowProps {
  ticker: string;
  price?: number;
  pct?: number;
  yHigh?: number;
  yLow?: number;
}

export function TickerRow({ ticker, price, pct, yHigh, yLow }: TickerRowProps) {
  const c = currencySymbol(ticker);
  const positive = (pct ?? 0) >= 0;
  return (
    <tr>
      <td className="font-medium">{stripTicker(ticker)}</td>
      <td className="num">{price != null ? `${c}${price.toFixed(2)}` : ""}</td>
      <td
        className={cn(
          "num font-medium",
          pct == null
            ? "text-[var(--muted)]"
            : positive
            ? "text-[var(--gain)]"
            : "text-[var(--loss)]"
        )}
      >
        {formatPct(pct)}
      </td>
      <td className="num text-[var(--muted)]">{yHigh ? `${c}${yHigh.toFixed(2)}` : ""}</td>
      <td className="num text-[var(--muted)]">{yLow ? `${c}${yLow.toFixed(2)}` : ""}</td>
    </tr>
  );
}

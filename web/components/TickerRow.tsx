import { cn, currencySymbol, formatPct, isIndian, stripTicker } from "@/lib/utils";

interface TickerRowProps {
  ticker: string;
  price?: number;
  pct?: number;
  yHigh?: number;
  yLow?: number;
}

export function TickerRow({ ticker, price, pct, yHigh, yLow }: TickerRowProps) {
  const c = currencySymbol(ticker);
  const locale = isIndian(ticker) ? "en-IN" : "en-US";
  const fmt = (val: number) =>
    val.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const positive = (pct ?? 0) >= 0;
  return (
    <tr>
      <td className="font-medium">{stripTicker(ticker)}</td>
      <td className="num">{price != null ? `${c}${fmt(price)}` : ""}</td>
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
      <td className="num text-[var(--muted)]">{yHigh ? `${c}${fmt(yHigh)}` : ""}</td>
      <td className="num text-[var(--muted)]">{yLow ? `${c}${fmt(yLow)}` : ""}</td>
    </tr>
  );
}

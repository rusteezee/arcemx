import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isIndian(ticker: string): boolean {
  return (
    ticker.endsWith(".NS") ||
    ticker.endsWith(".BO") ||
    ticker.startsWith("^NSE") ||
    ticker.startsWith("^BSE")
  );
}

export function currencySymbol(ticker: string): string {
  return isIndian(ticker) ? "₹" : "$";
}

export function formatMoney(val: number | null | undefined, ticker = ""): string {
  if (val == null || isNaN(val)) return "—".replace("—", "");
  const c = ticker ? currencySymbol(ticker) : "₹";
  const sign = val < 0 ? "-" : "";
  return `${sign}${c}${Math.abs(val).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}`;
}

export function formatPct(val: number | null | undefined, signed = true): string {
  if (val == null || isNaN(val)) return "";
  const s = signed && val >= 0 ? "+" : "";
  return `${s}${val.toFixed(2)}%`;
}

export function stripTicker(ticker: string): string {
  return ticker.replace(".NS", "").replace(".BO", "").replace("^", "");
}

/**
 * Format any numeric value or range string with ₹ + Indian commas.
 * Handles: "2980", "3150-3200", "Around 3040-3050", "₹3040", "3040 to 3050",
 *          numbers, undefined.
 */
export function formatINR(input: any, withSymbol = true): string {
  if (input == null || input === "") return "";
  // Strip any rupee symbol the upstream payload may already include so we
  // don't double-prefix ("₹₹340"). Gemini sometimes emits "₹340" because
  // the prompt schema example uses the symbol; the regex below would then
  // attach a second ₹ in front of the matched digits.
  const str = String(input).replace(/₹/g, "").trim();
  if (!str) return "";

  const symbol = withSymbol ? "₹" : "";
  const formatNum = (raw: string) => {
    const n = Number(raw.replace(/,/g, ""));
    if (!isFinite(n) || raw.replace(/[\d.\-]/g, "").length > 0) return raw;
    return `${symbol}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  };

  return str.replace(/-?\d+(?:\.\d+)?/g, (match) => formatNum(match));
}

export function formatNumber(input: any): string {
  return formatINR(input, false);
}

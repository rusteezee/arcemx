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
  if (val == null || isNaN(val)) return "·".replace("·", "");
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

  // Match digit groups only, NOT a leading minus. Otherwise a range
  // string like "325-335" splits as "325" + "-335" (the hyphen swallowed
  // as a negative sign) and we double-prefix to "Rs.325Rs.-335". With
  // the minus excluded, "325-335" matches "325" and "335" cleanly and
  // the hyphen stays as a separator -> "Rs.325-Rs.335". A genuinely
  // negative number "-100" still renders as "-Rs.100" which is the
  // right convention anyway.
  return str.replace(/\d+(?:\.\d+)?/g, (match) => formatNum(match));
}

export function formatNumber(input: any): string {
  return formatINR(input, false);
}

// Post-process model-emitted prose so it reads in the brand voice
// without depending on the model getting every detail right:
//   - First character uppercased (the model often emits lower-case
//     openers like "price 1.2% above ...").
//   - Bare 4+ digit integers get Indian comma grouping (23070 -> 23,070).
//     Numbers already containing a comma or a decimal are left alone.
//   - A "₹" prefix is added when a number sits right after a clear
//     price-level word (support, resistance, target, stop / stop loss,
//     entry, level). Other contexts (RSI 42, FII -2800cr, 1.2%) are
//     untouched so we never get nonsense like "RSI ₹42".
// Idempotent: passing already-formatted text through a second time is
// a no-op (₹ is detected and skipped, commas already present skipped).
export function polishMarketText(input: string | null | undefined): string {
  if (input == null) return "";
  let s = String(input).trim();
  if (!s) return "";

  s = s.replace(/\b(\d{4,})\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n)) return m;
    return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  });

  // The model emits clauses joined with semicolons (e.g. "RSI 39 below 50;
  // price 0.6% above support"). Convert to a period + space + capitalize
  // the next clause's opener so each clause reads as a complete sentence.
  s = s.replace(/;\s+([a-zA-Z])/g, (_m, c) => ". " + c.toUpperCase());

  s = s.replace(
    /\b(support|resistance|target|stop[_ ]?loss|stop|entry|level)(\s+(?:[a-z0-9_]+\s+){0,2})(\d[\d,]*(?:\.\d+)?)/gi,
    (_full, word: string, mid: string, num: string) => {
      const between = mid || " ";
      // Already prefixed with ₹ somewhere in the gap? Leave it.
      if (between.includes("₹")) return `${word}${between}${num}`;
      return `${word}${between}₹${num}`;
    },
  );

  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

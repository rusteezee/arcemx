// Indian market state. Open: Mon-Fri 09:15-15:30 IST.

export type MarketState = "open" | "closed" | "pre_open" | "post_close";

function nowIST(): Date {
  const now = new Date();
  const istMs = now.getTime() + (now.getTimezoneOffset() + 330) * 60 * 1000;
  return new Date(istMs);
}

export function getMarketState(): MarketState {
  const ist = nowIST();
  const day = ist.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return "closed";

  const mins = ist.getHours() * 60 + ist.getMinutes();
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;
  if (mins < open) return "pre_open";
  if (mins >= open && mins < close) return "open";
  return "post_close";
}

export function marketStateLabel(s: MarketState): string {
  return { open: "Open", closed: "Closed", pre_open: "Pre-open", post_close: "Closed" }[s];
}

export function isMarketOpen(s: MarketState): boolean {
  return s === "open";
}

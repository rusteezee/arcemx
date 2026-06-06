// Yahoo Finance via Netlify Edge Function proxy (/api/quote/<ticker>)

export interface Quote {
  ticker: string;
  last: number;
  prev: number;
  pct: number;
  high?: number;
  low?: number;
  yHigh?: number;
  yLow?: number;
  history?: Array<{ date: string; close: number }>;
}

export async function fetchQuote(ticker: string, range = "5d"): Promise<Quote | null> {
  try {
    const r = await fetch(`/api/quote/${encodeURIComponent(ticker)}?range=${range}&interval=1d`);
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta || {};
    const closes: (number | null)[] = (result.indicators?.quote?.[0]?.close || []).filter(
      (c: number | null) => c != null
    );
    const seriesLast = closes[closes.length - 1] as number | undefined;
    const seriesPrev = closes[closes.length - 2] as number | undefined;
    const last = (meta.regularMarketPrice ?? seriesLast ?? meta.previousClose) as number;
    let prev = (meta.previousClose ?? seriesPrev ?? last) as number;
    // Yahoo quirk: sometimes previousClose === regularMarketPrice. Use series prev.
    if (prev === last && seriesPrev != null) prev = seriesPrev;
    return {
      ticker,
      last,
      prev,
      pct: prev ? ((last - prev) / prev) * 100 : 0,
      high: meta.regularMarketDayHigh,
      low: meta.regularMarketDayLow,
      yHigh: meta.fiftyTwoWeekHigh,
      yLow: meta.fiftyTwoWeekLow,
    };
  } catch {
    return null;
  }
}

// Pick the best Yahoo interval for a given range so 5Y doesn't try to return
// 1250 daily candles (which Yahoo sometimes throttles to a few points).
function intervalForRange(range: string): string {
  switch (range) {
    case "1mo":
    case "3mo":
      return "1d";
    case "6mo":
    case "1y":
      return "1d";
    case "2y":
    case "5y":
      return "1wk";
    case "10y":
    case "max":
      return "1mo";
    default:
      return "1d";
  }
}

export async function fetchHistory(ticker: string, range = "6mo"): Promise<Quote | null> {
  try {
    const interval = intervalForRange(range);
    const r = await fetch(
      `/api/quote/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta || {};
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const history = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        close: closes[i] as number,
      }))
      .filter((p) => p.close != null);
    const last = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prev = meta.previousClose ?? closes[closes.length - 2];
    return {
      ticker,
      last,
      prev,
      pct: prev ? ((last - prev) / prev) * 100 : 0,
      history,
    };
  } catch {
    return null;
  }
}

export async function fetchQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const results = await Promise.all(tickers.map((t) => fetchQuote(t)));
  const map = new Map<string, Quote>();
  results.forEach((q, i) => {
    if (q) map.set(tickers[i], q);
  });
  return map;
}

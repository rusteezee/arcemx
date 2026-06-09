// Phase 9a: deterministic portfolio scoring + benchmark comparison.
//
// No LLM. Pure math on the current holdings snapshot + cached prices.
// The "history" we use is a buy-and-hold simulation backwards from
// today using current quantities. It is NOT realized P&L, it is "how
// would your current basket have moved over the last N sessions". Same
// quantity through the window so the curve compares apples-to-apples
// against NIFTY and Sensex.

import { sb, DEFAULT_UID } from "@/lib/supabase";
import { UNIVERSE } from "@/lib/universe";

const BENCH_TICKERS = ["^NSEI", "^BSESN"] as const;

export interface Holding {
  ticker: string;
  qty: number;
  avgBuyPrice: number;
  lastClose?: number;
  marketValue?: number;
  weightPct?: number;
  sector?: string;
  cap?: string;
}

export interface SeriesPoint {
  date: string;
  value: number;       // normalized to 100 at series start
}

export interface PortfolioScore {
  total: number;       // 0-100 composite
  components: {
    diversification: number;     // 0-100
    singleNameRisk: number;      // 0-100 (high = low risk)
    momentum30d: number;         // 0-100 (alpha relative to NIFTY scaled)
    drawdown: number;            // 0-100 (small drawdown = high score)
    edge: number;                // 0-100 (Sharpe-style ratio over 60d)
  };
}

export interface PortfolioReport {
  holdings: Holding[];
  totalValue: number;
  sectorWeights: Record<string, number>;
  capWeights: Record<string, number>;
  series: {
    portfolio: SeriesPoint[];
    nifty: SeriesPoint[];
    sensex: SeriesPoint[];
  };
  metrics: {
    return30dPct: number | null;
    return60dPct: number | null;
    niftyReturn30dPct: number | null;
    niftyReturn60dPct: number | null;
    alpha30dPct: number | null;
    maxDrawdownPct: number | null;     // negative number, e.g. -8.5
    annualizedVolPct: number | null;
    beta: number | null;
  };
  score: PortfolioScore;
  redFlags: string[];
  tips: string[];
  edgeVerdict: string;
  hasHistory: boolean;
  generatedAt: string;
}


export async function fetchHoldings(): Promise<Holding[]> {
  const { data } = await sb
    .from("portfolio")
    .select("ticker,qty,avg_buy_price")
    .eq("user_id", DEFAULT_UID);
  const out: Holding[] = [];
  for (const r of (data || []) as any[]) {
    const qty = Number(r.qty);
    const avg = Number(r.avg_buy_price);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      ticker: r.ticker,
      qty,
      avgBuyPrice: Number.isFinite(avg) ? avg : 0,
    });
  }
  return out;
}


async function fetchCloses(
  tickers: string[],
  cutoff: Date,
): Promise<Record<string, Array<{ date: string; close: number }>>> {
  if (!tickers.length) return {};
  const { data } = await sb
    .from("prices")
    .select("ticker,ts,close")
    .in("ticker", tickers)
    .gte("ts", cutoff.toISOString())
    .order("ts", { ascending: true })
    .limit(20000);
  const out: Record<string, Array<{ date: string; close: number }>> = {};
  for (const row of (data || []) as Array<{ ticker: string; ts: string; close: number | null }>) {
    if (row.close == null) continue;
    const date = row.ts.slice(0, 10);
    (out[row.ticker] ??= []).push({ date, close: Number(row.close) });
  }
  return out;
}


function normalize(series: number[], dates: string[]): SeriesPoint[] {
  if (!series.length) return [];
  const base = series[0];
  if (!base || base <= 0) return [];
  return series.map((v, i) => ({
    date: dates[i],
    value: (v / base) * 100,
  }));
}


function maxDrawdown(vals: number[]): number {
  if (vals.length < 2) return 0;
  let peak = vals[0];
  let dd = 0;
  for (const v of vals) {
    if (v > peak) peak = v;
    const drop = ((v - peak) / peak) * 100;
    if (drop < dd) dd = drop;
  }
  return dd;
}


function dailyLogReturns(vals: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    const a = vals[i - 1];
    const b = vals[i];
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}


function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}


function covariance(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const my = ys.slice(0, n).reduce((s, y) => s + y, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx) * (ys[i] - my);
  return s / n;
}


function clamp(x: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, x));
}


function diversificationScore(weights: Record<string, number>): number {
  const ws = Object.values(weights);
  if (ws.length === 0) return 0;
  // HHI on weights. Lower HHI = better diversification.
  // Single-sector portfolio HHI = 100^2 = 10000. Even split across N
  // sectors HHI = N * (100/N)^2 = 10000/N. Convert to 0-100 where 100
  // = roughly evenly spread across at least 4 sectors.
  const hhi = ws.reduce((s, w) => s + w * w, 0);
  const target = 2500;   // 4 equally-weighted sectors -> HHI ~2500
  return clamp(100 * (1 - Math.max(0, (hhi - target) / 7500)));
}


function singleNameScore(holdings: Holding[]): number {
  const maxW = holdings.reduce((m, h) => Math.max(m, h.weightPct || 0), 0);
  // 100 if max weight <=15; 0 if >=45; linear interp between.
  if (maxW <= 15) return 100;
  if (maxW >= 45) return 0;
  return 100 - ((maxW - 15) / 30) * 100;
}


function momentumScore(alpha30dPct: number | null): number {
  if (alpha30dPct == null) return 50;
  // +5% alpha over 30d = 90; 0 = 50; -5% = 10.
  return clamp(50 + alpha30dPct * 8);
}


function drawdownScore(maxDD: number | null): number {
  if (maxDD == null) return 50;
  // 0 dd = 100; -5% = 75; -10% = 50; -20% = 0.
  return clamp(100 + maxDD * 5);
}


function edgeScore(ret60d: number | null, annVol: number | null): number {
  if (ret60d == null || annVol == null || annVol <= 0) return 50;
  // Sharpe-ish: 60d return / 60d vol-equivalent. Rough scale: >0.5 great, <-0.5 weak.
  const sharpe = ret60d / (annVol / 100 * Math.sqrt(60 / 252) * 100);
  return clamp(50 + sharpe * 40);
}


function sectorFor(ticker: string): string {
  const u = UNIVERSE.find((x) => x.ticker === ticker);
  return u?.sector || "OTHER";
}


function capFor(ticker: string): string {
  const u = UNIVERSE.find((x) => x.ticker === ticker);
  return u?.cap || "unknown";
}


export async function buildPortfolioReport(): Promise<PortfolioReport | null> {
  const holdings = await fetchHoldings();
  if (!holdings.length) return null;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 80);
  const allTickers = [...new Set([...holdings.map((h) => h.ticker), ...BENCH_TICKERS])];
  const closes = await fetchCloses(allTickers, cutoff);

  // Determine canonical session dates: intersection of NIFTY history
  // with each holding's history. Use NIFTY's date axis as the spine.
  const niftyHist = closes["^NSEI"] || [];
  const dateSpine = niftyHist.map((p) => p.date);

  const closeOnDate = (ticker: string, date: string): number | null => {
    const hist = closes[ticker] || [];
    const row = hist.find((p) => p.date === date);
    return row?.close ?? null;
  };

  // Per-holding latest close: take the most recent entry; if there is no
  // cached price the holding contributes its avg_buy_price as fallback so
  // it still shows in the table without inflating the NAV curve.
  for (const h of holdings) {
    const hist = closes[h.ticker] || [];
    const last = hist.length ? hist[hist.length - 1].close : null;
    h.lastClose = last ?? h.avgBuyPrice ?? 0;
    h.marketValue = (h.lastClose || 0) * h.qty;
    h.sector = sectorFor(h.ticker);
    h.cap = capFor(h.ticker);
  }
  const totalValue = holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
  for (const h of holdings) {
    h.weightPct = totalValue > 0 ? ((h.marketValue || 0) / totalValue) * 100 : 0;
  }

  const sectorWeights: Record<string, number> = {};
  const capWeights: Record<string, number> = {};
  for (const h of holdings) {
    const sec = h.sector || "OTHER";
    const cap = h.cap || "unknown";
    sectorWeights[sec] = (sectorWeights[sec] || 0) + (h.weightPct || 0);
    capWeights[cap] = (capWeights[cap] || 0) + (h.weightPct || 0);
  }

  // Build NAV curve using simulated buy-and-hold of current quantities.
  // Skip dates where ANY holding has no price; they would inject NaN.
  const navByDate: { date: string; value: number }[] = [];
  for (const d of dateSpine) {
    let v = 0;
    let ok = true;
    for (const h of holdings) {
      const c = closeOnDate(h.ticker, d);
      if (c == null) { ok = false; break; }
      v += c * h.qty;
    }
    if (ok && v > 0) navByDate.push({ date: d, value: v });
  }

  const niftyByDate: { date: string; value: number }[] = niftyHist.map((p) => ({
    date: p.date,
    value: p.close,
  }));
  const sensexByDate: { date: string; value: number }[] = (closes["^BSESN"] || [])
    .map((p) => ({ date: p.date, value: p.close }));

  const portfolioVals = navByDate.map((p) => p.value);
  const portfolioDates = navByDate.map((p) => p.date);
  const niftyVals = niftyByDate.map((p) => p.value);
  const niftyDates = niftyByDate.map((p) => p.date);
  const sensexVals = sensexByDate.map((p) => p.value);
  const sensexDates = sensexByDate.map((p) => p.date);

  const series = {
    portfolio: normalize(portfolioVals, portfolioDates),
    nifty:     normalize(niftyVals,     niftyDates),
    sensex:    normalize(sensexVals,    sensexDates),
  };

  const hasHistory = portfolioVals.length >= 5 && niftyVals.length >= 5;

  const pctOver = (vals: number[], n: number): number | null => {
    if (vals.length < n + 1) return null;
    const a = vals[vals.length - 1 - n];
    const b = vals[vals.length - 1];
    if (!a) return null;
    return ((b - a) / a) * 100;
  };

  const return30d = pctOver(portfolioVals, 30);
  const return60d = pctOver(portfolioVals, 60);
  const niftyRet30 = pctOver(niftyVals, 30);
  const niftyRet60 = pctOver(niftyVals, 60);
  const alpha30 = (return30d != null && niftyRet30 != null) ? return30d - niftyRet30 : null;

  const maxDD = portfolioVals.length >= 2 ? maxDrawdown(portfolioVals) : null;

  const pRets = dailyLogReturns(portfolioVals);
  const nRets = dailyLogReturns(niftyVals);
  const annVol = pRets.length >= 5 ? stdev(pRets) * Math.sqrt(252) * 100 : null;
  const beta = (pRets.length >= 10 && nRets.length >= 10)
    ? covariance(pRets, nRets) / Math.max(1e-12, covariance(nRets, nRets))
    : null;

  const components = {
    diversification: diversificationScore(sectorWeights),
    singleNameRisk: singleNameScore(holdings),
    momentum30d: momentumScore(alpha30),
    drawdown: drawdownScore(maxDD),
    edge: edgeScore(return60d, annVol),
  };
  // Composite: weighted average. Diversification and single-name carry
  // structural risk, the other three reward measured edge over the
  // benchmark. If history is thin, lean structural so a fresh portfolio
  // still gets a meaningful score.
  const weights = hasHistory
    ? { diversification: 0.18, singleNameRisk: 0.18, momentum30d: 0.24, drawdown: 0.20, edge: 0.20 }
    : { diversification: 0.45, singleNameRisk: 0.45, momentum30d: 0.05, drawdown: 0.025, edge: 0.025 };
  const total = clamp(
    components.diversification * weights.diversification +
    components.singleNameRisk  * weights.singleNameRisk  +
    components.momentum30d     * weights.momentum30d     +
    components.drawdown        * weights.drawdown        +
    components.edge            * weights.edge,
  );

  const score: PortfolioScore = {
    total: Math.round(total),
    components: {
      diversification: Math.round(components.diversification),
      singleNameRisk: Math.round(components.singleNameRisk),
      momentum30d: Math.round(components.momentum30d),
      drawdown: Math.round(components.drawdown),
      edge: Math.round(components.edge),
    },
  };

  const redFlags: string[] = [];
  for (const [sec, w] of Object.entries(sectorWeights)) {
    if (w > 45)
      redFlags.push(`${sec} at ${w.toFixed(0)}% of book. A sector drawdown will dominate the portfolio.`);
  }
  const maxName = holdings.reduce((m, h) => (h.weightPct || 0) > (m.weightPct || 0) ? h : m, holdings[0]);
  if (maxName && (maxName.weightPct || 0) > 30) {
    redFlags.push(`${maxName.ticker.replace(/\.NS$/, "")} alone is ${(maxName.weightPct || 0).toFixed(0)}% of NAV. Single-name blow-up risk.`);
  }
  if (alpha30 != null && alpha30 < -3) {
    redFlags.push(`30-day alpha vs NIFTY is ${alpha30.toFixed(1)}%. Portfolio is lagging the index meaningfully.`);
  }
  if (maxDD != null && maxDD < -15) {
    redFlags.push(`Trailing drawdown ${maxDD.toFixed(1)}%. Tail risk has shown up in the curve recently.`);
  }
  if (holdings.length < 4) {
    redFlags.push(`${holdings.length} holdings only. Concentration risk is structural; one bad earnings print swings the whole book.`);
  }

  const tips: string[] = [];
  if (score.components.diversification < 60) {
    tips.push("Add a position in an under-represented sector (the Sensei Calculator can propose one) to bring HHI below 2500.");
  }
  if (score.components.singleNameRisk < 60) {
    tips.push("Trim the largest position toward 20% of NAV. Single-name max-weight is the easiest score-component to fix.");
  }
  if (score.components.momentum30d < 50 && alpha30 != null) {
    tips.push(`Portfolio underperformed NIFTY by ${Math.abs(alpha30).toFixed(1)}pp over the last 30 sessions. Review which names dragged the curve.`);
  }
  if (score.components.drawdown < 50 && maxDD != null) {
    tips.push(`Trailing drawdown ${maxDD.toFixed(1)}%. Consider sizing into low-vol names or adding a hedge proxy.`);
  }
  if (capWeights["small"] && capWeights["small"] > 40) {
    tips.push("Small-cap weight above 40%. Drawdowns will be 2-3x of NIFTY in stress. Confirm the horizon supports holding through volatility.");
  }
  if (!hasHistory) {
    tips.push("Trailing NAV history is thin. The score leans on structural factors until the prices table accumulates more sessions.");
  }

  const edgeVerdict =
    !hasHistory
      ? "Insufficient history to call edge. Wait for at least 30 scored sessions in the prices table."
      : alpha30 == null
      ? "Edge undefined: NIFTY benchmark data missing for the same window."
      : alpha30 > 2
      ? `Portfolio is beating NIFTY by ${alpha30.toFixed(1)}pp over 30 sessions. Edge is real for now; monitor whether it holds beyond 60 sessions.`
      : alpha30 < -2
      ? `Portfolio is trailing NIFTY by ${Math.abs(alpha30).toFixed(1)}pp over 30 sessions. No edge over a plain index right now.`
      : `Portfolio is tracking NIFTY within ${Math.abs(alpha30).toFixed(1)}pp over 30 sessions. No demonstrable edge; the work is in finding it.`;

  return {
    holdings,
    totalValue,
    sectorWeights,
    capWeights,
    series,
    metrics: {
      return30dPct: return30d,
      return60dPct: return60d,
      niftyReturn30dPct: niftyRet30,
      niftyReturn60dPct: niftyRet60,
      alpha30dPct: alpha30,
      maxDrawdownPct: maxDD,
      annualizedVolPct: annVol,
      beta,
    },
    score,
    redFlags,
    tips,
    edgeVerdict,
    hasHistory,
    generatedAt: new Date().toISOString(),
  };
}

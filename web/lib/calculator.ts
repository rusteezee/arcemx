// Sensei Calculator (Phase 8a, deterministic skeleton).
//
// Picks stocks from UNIVERSE given an amount, horizon, risk appetite,
// and a sector / cap filter. Pure functions. Pulls recent OHLC from
// the cached `prices` table in Supabase, computes simple momentum +
// RSI + realized vol, scores per ticker, and allocates weights.
//
// All math is deterministic and explainable; the LLM layer wraps this
// in stage 8b. The skeleton is honest about being a quant prefilter,
// not advice. The output prose is conservative on purpose.

import { sb } from "@/lib/supabase";
import { UNIVERSE, UniverseRow, Cap } from "@/lib/universe";

export type Risk = "Conservative" | "Balanced" | "Aggressive";

export interface CalcInput {
  amount: number;          // INR
  horizonDays: number;     // total invest window in days
  risk: Risk;
  sectors: string[];       // empty = all
  caps: Cap[];             // empty = all
}

export interface PriceBundle {
  ticker: string;
  closes: number[];        // chronological, oldest to newest
}

export interface Pick {
  ticker: string;
  name: string;
  cap: Cap;
  sector: string;
  weightPct: number;       // 0-100
  amountInr: number;
  lastClose: number;
  momentumPct: number;     // 60d % move
  rsi: number;             // 0-100
  volPct: number;          // annualized realized vol estimate
  score: number;           // ranking score
  reasoning: string;
}

export interface CalcResult {
  picks: Pick[];
  backups: Array<Pick>;    // next 3 in scoring order, not allocated
  risks: string[];
  totals: {
    amount: number;
    nPicks: number;
    sectorsUsed: string[];
    capsUsed: Cap[];
    pickedSectors: Record<string, number>;  // sector -> pct
    pickedCaps: Record<string, number>;     // cap -> pct
  };
  notes: string[];
  generatedAt: string;
}

// "Recommended" sectors per risk appetite. Used by the "Sensei
// Recommend" button on the form. The picks are intentionally
// boring: defensive sectors for Conservative, broad for Balanced,
// cyclical + cap-heavy for Aggressive.
export function recommendSectors(risk: Risk): string[] {
  if (risk === "Conservative") return ["FMCG", "PHARMA", "IT", "BANK"];
  if (risk === "Balanced") return ["BANK", "IT", "FMCG", "AUTO", "FINSERV", "INFRA"];
  return ["AUTO", "METAL", "ENERGY", "FINSERV", "INFRA", "CHEMICALS", "CONSUMER"];
}

export function recommendCaps(risk: Risk): Cap[] {
  if (risk === "Conservative") return ["large"];
  if (risk === "Balanced") return ["large", "mid"];
  return ["large", "mid", "small"];
}

// Filter the universe by sectors / caps. Empty arrays mean
// "any". Indices and the few non-stock rows are excluded by
// universe construction (UNIVERSE only carries stocks).
export function filterUniverse(
  sectors: string[],
  caps: Cap[],
): UniverseRow[] {
  return UNIVERSE.filter((r) => {
    if (sectors.length && !sectors.includes(r.sector)) return false;
    if (caps.length && !caps.includes(r.cap)) return false;
    return true;
  });
}

// Pull last ~70 calendar days of closes from the cached `prices` table.
// 70 days covers ~50 trading sessions, enough for a 60d momentum and a
// 14d RSI. Missing tickers come back with closes:[] and are dropped
// from scoring; the calculator never fabricates a price.
export async function fetchPriceBundles(
  tickers: string[],
): Promise<Record<string, PriceBundle>> {
  if (!tickers.length) return {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 75);
  const { data } = await sb
    .from("prices")
    .select("ticker,ts,close")
    .in("ticker", tickers)
    .gte("ts", cutoff.toISOString())
    .order("ts", { ascending: true })
    .limit(8000);

  const by: Record<string, number[]> = {};
  for (const row of (data || []) as Array<{ ticker: string; close: number | null }>) {
    if (row.close == null) continue;
    (by[row.ticker] ??= []).push(Number(row.close));
  }
  const out: Record<string, PriceBundle> = {};
  for (const t of tickers) {
    out[t] = { ticker: t, closes: by[t] || [] };
  }
  return out;
}

// 14-day Wilder RSI. Returns NaN if not enough data.
export function rsi14(closes: number[]): number {
  if (closes.length < 16) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses += -d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// Annualized realized vol from daily log returns over last N closes.
// Defaults to N=30 sessions (~6 weeks). Returns NaN on insufficient data.
export function realizedVolPct(closes: number[], n = 30): number {
  if (closes.length < n + 1) return NaN;
  const slice = closes.slice(-n - 1);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1];
    const b = slice[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return NaN;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(variance);
  return sd * Math.sqrt(252) * 100;
}

// 60-session momentum %. Falls back to whatever history exists when the
// series is shorter than 60 (this gives newer listings a fair shot).
export function momentum60Pct(closes: number[]): number {
  if (closes.length < 5) return NaN;
  const last = closes[closes.length - 1];
  const baseIdx = Math.max(0, closes.length - 61);
  const base = closes[baseIdx];
  if (!base || base <= 0) return NaN;
  return ((last - base) / base) * 100;
}

// Risk-tilted scoring. Pure number; same scale across calls.
export function score(
  mom: number,
  rsi: number,
  vol: number,
  risk: Risk,
): number {
  // Normalize RSI: 50 = neutral. Reward 55-70 (uptrend, not overbought)
  // strongest, punish <30 and >80.
  const rsiSignal =
    isNaN(rsi) ? 0 :
    rsi >= 55 && rsi <= 70 ? 1 :
    rsi >= 50 && rsi < 55 ? 0.6 :
    rsi > 70 && rsi <= 78 ? 0.4 :
    rsi >= 45 && rsi < 50 ? 0.2 :
    -0.6;
  const momSignal = isNaN(mom) ? 0 : Math.tanh(mom / 25);  // squash to [-1, 1]
  // Volatility is penalty (higher vol = lower score). Skip when missing.
  const volPenalty = isNaN(vol) ? 0 : -Math.min(1, vol / 80);
  // Risk weights: Conservative leans on RSI + low vol; Aggressive leans
  // on momentum and tolerates vol; Balanced sits in between.
  const w =
    risk === "Conservative"
      ? { mom: 0.2, rsi: 0.5, vol: 0.6 }
      : risk === "Balanced"
      ? { mom: 0.45, rsi: 0.35, vol: 0.3 }
      : { mom: 0.65, rsi: 0.2, vol: 0.1 };
  return w.mom * momSignal + w.rsi * rsiSignal + w.vol * volPenalty;
}

// Target pick count by risk + horizon. Longer horizon -> wider basket
// because dispersion matters more over months than over a few days.
export function targetPickCount(risk: Risk, horizonDays: number): number {
  const base = risk === "Conservative" ? 6 : risk === "Balanced" ? 8 : 10;
  const lift = horizonDays >= 180 ? 2 : horizonDays >= 30 ? 1 : 0;
  return Math.min(12, base + lift);
}

// Allocation policy. Conservative -> equal weight, capped 18%.
// Balanced -> 1/vol weights (lower-vol gets more), Aggressive ->
// score-tilted (high score gets more) with floor + cap so no name
// dominates.
export function allocateWeights(
  ranked: Array<{ row: UniverseRow; sc: number; vol: number }>,
  risk: Risk,
): number[] {
  const n = ranked.length;
  if (n === 0) return [];
  let weights: number[];
  if (risk === "Conservative") {
    const w = 1 / n;
    weights = Array(n).fill(w);
  } else if (risk === "Balanced") {
    const invVol = ranked.map((r) => 1 / Math.max(15, isNaN(r.vol) ? 30 : r.vol));
    const sum = invVol.reduce((s, x) => s + x, 0);
    weights = invVol.map((x) => x / sum);
  } else {
    // Shift scores into a positive band so weights are non-negative.
    const lift = ranked.map((r) => Math.max(0.02, r.sc + 0.4));
    const sum = lift.reduce((s, x) => s + x, 0);
    weights = lift.map((x) => x / sum);
  }
  // Cap + floor to avoid degenerate allocations. Cap 22%, floor 4%,
  // then renormalize so weights still sum to 1.
  const FLOOR = 0.04;
  const CAP = 0.22;
  weights = weights.map((w) => Math.min(CAP, Math.max(FLOOR, w)));
  const total = weights.reduce((s, w) => s + w, 0);
  return weights.map((w) => w / total);
}

function reasoningFor(p: {
  cap: Cap;
  sector: string;
  mom: number;
  rsi: number;
  vol: number;
}): string {
  const bits: string[] = [];
  if (!isNaN(p.mom)) bits.push(`${p.mom >= 0 ? "+" : ""}${p.mom.toFixed(1)}% 60d`);
  if (!isNaN(p.rsi)) bits.push(`RSI ${p.rsi.toFixed(0)}`);
  if (!isNaN(p.vol)) bits.push(`${p.vol.toFixed(0)}% vol`);
  const capLabel = p.cap === "large" ? "Large-cap" : p.cap === "mid" ? "Mid-cap" : "Small-cap";
  return `${capLabel} ${p.sector}. ${bits.join(", ")}.`;
}

export async function runCalculator(input: CalcInput): Promise<CalcResult> {
  const filtered = filterUniverse(input.sectors, input.caps);
  if (filtered.length === 0) {
    return {
      picks: [],
      backups: [],
      risks: ["Filter returned zero tickers. Widen the sector or cap selection."],
      totals: {
        amount: input.amount,
        nPicks: 0,
        sectorsUsed: input.sectors,
        capsUsed: input.caps,
        pickedSectors: {},
        pickedCaps: {},
      },
      notes: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const bundles = await fetchPriceBundles(filtered.map((r) => r.ticker));
  // Build ranked list. Drop tickers without enough price history to score.
  const scored = filtered
    .map((row) => {
      const b = bundles[row.ticker];
      const closes = b?.closes || [];
      if (closes.length < 5) {
        return null;
      }
      const mom = momentum60Pct(closes);
      const rsi = rsi14(closes);
      const vol = realizedVolPct(closes);
      const sc = score(mom, rsi, vol, input.risk);
      return {
        row,
        last: closes[closes.length - 1],
        mom,
        rsi,
        vol,
        sc,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.sc - a.sc);

  if (scored.length === 0) {
    return {
      picks: [],
      backups: [],
      risks: [
        "Filter matched tickers but none had cached price history. The daily prices cron needs to run before the calculator can rank them.",
      ],
      totals: {
        amount: input.amount,
        nPicks: 0,
        sectorsUsed: input.sectors,
        capsUsed: input.caps,
        pickedSectors: {},
        pickedCaps: {},
      },
      notes: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const target = Math.min(scored.length, targetPickCount(input.risk, input.horizonDays));
  const topRanked = scored.slice(0, target).map((x) => ({ row: x.row, sc: x.sc, vol: x.vol }));
  const weights = allocateWeights(topRanked, input.risk);

  const picks: Pick[] = scored.slice(0, target).map((x, i) => ({
    ticker: x.row.ticker,
    name: x.row.name,
    cap: x.row.cap,
    sector: x.row.sector,
    weightPct: weights[i] * 100,
    amountInr: weights[i] * input.amount,
    lastClose: x.last,
    momentumPct: x.mom,
    rsi: x.rsi,
    volPct: x.vol,
    score: x.sc,
    reasoning: reasoningFor({
      cap: x.row.cap,
      sector: x.row.sector,
      mom: x.mom,
      rsi: x.rsi,
      vol: x.vol,
    }),
  }));

  const backups: Pick[] = scored.slice(target, target + 3).map((x) => ({
    ticker: x.row.ticker,
    name: x.row.name,
    cap: x.row.cap,
    sector: x.row.sector,
    weightPct: 0,
    amountInr: 0,
    lastClose: x.last,
    momentumPct: x.mom,
    rsi: x.rsi,
    volPct: x.vol,
    score: x.sc,
    reasoning: reasoningFor({
      cap: x.row.cap,
      sector: x.row.sector,
      mom: x.mom,
      rsi: x.rsi,
      vol: x.vol,
    }),
  }));

  // Sector + cap concentration metrics.
  const pickedSectors: Record<string, number> = {};
  const pickedCaps: Record<string, number> = {};
  for (const p of picks) {
    pickedSectors[p.sector] = (pickedSectors[p.sector] || 0) + p.weightPct;
    pickedCaps[p.cap] = (pickedCaps[p.cap] || 0) + p.weightPct;
  }

  const risks: string[] = [];
  for (const [sec, w] of Object.entries(pickedSectors)) {
    if (w > 45)
      risks.push(`${sec} concentration ${w.toFixed(0)}% of book. Sector drawdown will hit hard. Widen the sector filter or accept the concentrated bet.`);
  }
  for (const p of picks) {
    if (p.weightPct > 20)
      risks.push(`${p.name} carries ${p.weightPct.toFixed(0)}% of the book. Single-name risk. The capped allocator already limits at 22% which is the ceiling here.`);
  }
  const smallShare = pickedCaps["small"] || 0;
  if (smallShare > 50)
    risks.push(`Small-cap exposure ${smallShare.toFixed(0)}%. Liquidity drops fast in stress; expect drawdowns 2-3x of NIFTY in a sell-off.`);
  if (input.horizonDays < 30 && (pickedCaps["small"] || 0) > 25)
    risks.push("Short horizon plus small-cap weight is a mismatch. Short windows do not give small-caps time to recover from a wobble.");
  if (Number.isFinite(input.amount) && input.amount < 5000 && picks.length > 6)
    risks.push(`Amount ₹${input.amount.toFixed(0)} split across ${picks.length} stocks means a few hundred rupees per name. Brokerage friction eats the alpha; consider widening to a single ETF or cutting to 3-4 names.`);

  const notes: string[] = [];
  notes.push(
    "Scores are deterministic: 60-day momentum, 14-day RSI band, and realized volatility, weighted by risk appetite. The LLM layer (Phase 8b) will rewrite the rationale per pick with macro and news context.",
  );
  notes.push(
    "Allocation is a first-draft size, not advice. Validate every pick against your own thesis before deploying capital.",
  );
  if (smallShare > 0 && input.risk !== "Aggressive")
    notes.push(
      "Small-cap names included despite non-Aggressive risk because they ranked into the top of the filtered set. Drop the small cap if the tighter risk profile is binding.",
    );

  return {
    picks,
    backups,
    risks,
    totals: {
      amount: input.amount,
      nPicks: picks.length,
      sectorsUsed: input.sectors,
      capsUsed: input.caps,
      pickedSectors,
      pickedCaps,
    },
    notes,
    generatedAt: new Date().toISOString(),
  };
}

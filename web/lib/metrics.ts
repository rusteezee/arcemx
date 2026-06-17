// Phase A edge metrics computed client-side from paper_trades.
// Mirror of analyzer/metrics.py — keep formulas in sync. Both surfaces
// must agree numerically; the dashboard is read-only but the Python
// module is the source of truth for cron / future tier-gate writes.

const PORTFOLIO_BASE_INR = 65_000;
const RISK_FREE_ANNUAL = 0.065;
const PERIODS_PER_YEAR = 252;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[], ddof = 1): number {
  if (xs.length < ddof + 1) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - ddof);
  return Math.sqrt(v);
}

function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs, 0);
  if (s <= 0) return 0;
  return xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / n;
}

function excessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  const s = stdev(xs, 0);
  if (s <= 0) return 0;
  return xs.reduce((a, x) => a + ((x - m) / s) ** 4, 0) / n - 3;
}

// Standard normal CDF via Abramowitz-Stegun erf approximation (max error
// ~1.5e-7; identical to scipy.stats.norm.cdf at 6+ decimals). Matches
// math.erf-based path used in analyzer/metrics.py.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface ClosedTrade {
  exit_at: string | null;
  net_pnl: number | null;
}

export function equityCurve(trades: ClosedTrade[]): { date: string; cum: number }[] {
  const by = new Map<string, number>();
  for (const t of trades) {
    if (!t.exit_at || t.net_pnl == null) continue;
    const d = t.exit_at.slice(0, 10);
    by.set(d, (by.get(d) || 0) + t.net_pnl);
  }
  const sorted = Array.from(by.keys()).sort();
  let cum = 0;
  return sorted.map((d) => {
    cum += by.get(d) || 0;
    return { date: d, cum };
  });
}

export function dailyReturns(curve: { date: string; cum: number }[], base = PORTFOLIO_BASE_INR): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const p of curve) {
    out.push((p.cum - prev) / base);
    prev = p.cum;
  }
  return out;
}

export function sharpe(returns: number[],
                       rfAnnual = RISK_FREE_ANNUAL,
                       periods = PERIODS_PER_YEAR): number {
  if (returns.length < 2) return 0;
  const rfp = rfAnnual / periods;
  const excess = returns.map((r) => r - rfp);
  const s = stdev(excess, 1);
  if (s <= 0) return 0;
  return (mean(excess) / s) * Math.sqrt(periods);
}

export interface DrawdownResult {
  maxDdPct: number;
  peakAt: string | null;
  troughAt: string | null;
}

export function maxDrawdown(curve: { date: string; cum: number }[],
                            base = PORTFOLIO_BASE_INR): DrawdownResult {
  if (!curve.length) return { maxDdPct: 0, peakAt: null, troughAt: null };
  let peak = curve[0].cum;
  let peakAt = curve[0].date;
  let worst = 0;
  let worstPeakAt = peakAt;
  let worstTroughAt = peakAt;
  for (const p of curve) {
    if (p.cum > peak) {
      peak = p.cum;
      peakAt = p.date;
    }
    const denom = base + peak;
    const ddPct = denom > 0 ? (peak - p.cum) / denom : 0;
    if (ddPct > worst) {
      worst = ddPct;
      worstPeakAt = peakAt;
      worstTroughAt = p.date;
    }
  }
  return { maxDdPct: worst * 100, peakAt: worstPeakAt, troughAt: worstTroughAt };
}

export function psr(returns: number[],
                    benchmarkSrAnnual = 0,
                    periods = PERIODS_PER_YEAR): number {
  const n = returns.length;
  if (n < 4) return 0;
  const rfp = RISK_FREE_ANNUAL / periods;
  const excess = returns.map((r) => r - rfp);
  const s = stdev(excess, 1);
  const srPer = s > 0 ? mean(excess) / s : 0;
  const srStar = benchmarkSrAnnual / Math.sqrt(periods);
  const sk = skewness(excess);
  const ku = excessKurtosis(excess);
  const denom = Math.sqrt(Math.max(1e-12, 1 - sk * srPer + ((ku - 1) / 4) * srPer ** 2));
  const z = ((srPer - srStar) * Math.sqrt(n - 1)) / denom;
  return normCdf(z);
}

export const TIER_GATES = [
  { tier: 1, sharpe: 1.0, maxDdPct: 15.0, psr: 0.95, label: "Phase B unlock" },
  { tier: 2, sharpe: 1.3, maxDdPct: 12.0, psr: 0.97, label: "Phase C unlock" },
  { tier: 3, sharpe: 1.6, maxDdPct: 10.0, psr: 0.99, label: "Hardening" },
  { tier: 4, sharpe: 2.0, maxDdPct: 8.0,  psr: 0.995, label: "Peak (2028)" },
];

export interface TierEval {
  clearedTier: number;
  nextTier: number;
  nextLabel: string;
  nextGates: { sharpe: number; maxDdPct: number; psr: number };
  passMap: { sharpe: boolean; maxDd: boolean; psr: boolean };
}

export function evaluateTiers(sharpeV: number, maxDdPct: number, psrV: number): TierEval {
  let cleared = 0;
  let next = TIER_GATES[0];
  for (const gate of TIER_GATES) {
    if (sharpeV >= gate.sharpe && maxDdPct <= gate.maxDdPct && psrV >= gate.psr) {
      cleared = gate.tier;
      continue;
    }
    next = gate;
    break;
  }
  return {
    clearedTier: cleared,
    nextTier: next.tier,
    nextLabel: next.label,
    nextGates: { sharpe: next.sharpe, maxDdPct: next.maxDdPct, psr: next.psr },
    passMap: {
      sharpe: sharpeV >= next.sharpe,
      maxDd: maxDdPct <= next.maxDdPct,
      psr: psrV >= next.psr,
    },
  };
}

export interface PaperMetrics {
  tradeCount: number;
  spanDays: number;
  totalNetPnl: number;
  annualReturnPct: number;
  sharpe: number;
  maxDd: DrawdownResult;
  calmar: number;
  psr: number;
  tierEval: TierEval;
  equityCurve: { date: string; cum: number }[];
}

export function computePaperMetrics(trades: ClosedTrade[],
                                    base = PORTFOLIO_BASE_INR): PaperMetrics {
  const curve = equityCurve(trades);
  const rets = dailyReturns(curve, base);
  const sharpeV = sharpe(rets);
  const dd = maxDrawdown(curve, base);
  const psrV = rets.length >= 4 ? psr(rets) : 0;
  const totalNet = curve.length ? curve[curve.length - 1].cum : 0;
  const spanDays = curve.length >= 2
    ? Math.max(1, Math.round(
        (new Date(curve[curve.length - 1].date).getTime()
         - new Date(curve[0].date).getTime()) / 86400_000) + 1)
    : 0;
  const annualRetPct = spanDays > 0 ? (totalNet / base) * (365 / spanDays) * 100 : 0;
  const calmar = dd.maxDdPct > 0 ? annualRetPct / dd.maxDdPct : 0;
  return {
    tradeCount: trades.length,
    spanDays,
    totalNetPnl: totalNet,
    annualReturnPct: annualRetPct,
    sharpe: sharpeV,
    maxDd: dd,
    calmar,
    psr: psrV,
    tierEval: evaluateTiers(sharpeV, dd.maxDdPct, psrV),
    equityCurve: curve,
  };
}

// Per-dim skill from prediction_scores rows (mirror of per_dim_skill in
// analyzer/metrics.py). Caller fetches rows; this is pure aggregate.
export interface PredictionScoreRow {
  dimension: string;
  score: number | null;
  scored_at?: string | null;
}

export interface DimSkill {
  dimension: string;
  sampleSize: number;
  meanAcc: number;
  stdevAcc: number;
  skillRatio: number;
  lowSample: boolean;
}

export function perDimSkill(rows: PredictionScoreRow[], minSamples = 5): DimSkill[] {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.dimension || r.score == null) continue;
    const arr = by.get(r.dimension) || [];
    arr.push(r.score);
    by.set(r.dimension, arr);
  }
  const out: DimSkill[] = [];
  for (const [dim, scores] of by) {
    const m = mean(scores);
    const s = stdev(scores, 1);
    out.push({
      dimension: dim,
      sampleSize: scores.length,
      meanAcc: m,
      stdevAcc: s,
      skillRatio: s > 0 ? (m - 50) / s : 0,
      lowSample: scores.length < minSamples,
    });
  }
  out.sort((a, b) => b.skillRatio - a.skillRatio);
  return out;
}

// Per-dim skill cut by trailing time windows. Used by the heatmap viz
// on /paper: rows = dims, cols = {7d, 30d, 90d}, cells = skill ratio
// over that trailing window.
export interface DimSkillByWindow {
  dimension: string;
  byWindow: Record<number, DimSkill | null>;
}

export function perDimSkillByWindow(
  rows: PredictionScoreRow[],
  windowDays: number[] = [7, 30, 90],
  minSamples = 5,
): DimSkillByWindow[] {
  const nowMs = Date.now();
  const dimsSeen = new Set<string>();
  for (const r of rows) {
    if (r.dimension) dimsSeen.add(r.dimension);
  }
  const out: DimSkillByWindow[] = [];
  for (const dim of dimsSeen) {
    const dimRows = rows.filter((r) => r.dimension === dim);
    const byWindow: Record<number, DimSkill | null> = {};
    for (const w of windowDays) {
      const cutoff = nowMs - w * 86400_000;
      const slice = dimRows.filter((r) => {
        if (!r.scored_at) return false;
        return new Date(r.scored_at).getTime() >= cutoff;
      });
      const skills = perDimSkill(slice, minSamples);
      byWindow[w] = skills.find((s) => s.dimension === dim) || null;
    }
    out.push({ dimension: dim, byWindow });
  }
  // Sort by widest window's skill ratio descending so the strongest
  // dims surface at the top of the heatmap regardless of which window
  // they spike in.
  const wMax = Math.max(...windowDays);
  out.sort((a, b) => {
    const ra = a.byWindow[wMax]?.skillRatio ?? -999;
    const rb = b.byWindow[wMax]?.skillRatio ?? -999;
    return rb - ra;
  });
  return out;
}

// Heatmap cell background style. Continuous gradient from red (skill
// <= -1) through gray (skill ~= 0) to green (skill >= 2). Returns a
// CSS background-color string the caller can drop onto a <td>.
export function skillCellStyle(skill: number | null | undefined): { background: string; color: string } {
  if (skill == null || !isFinite(skill)) {
    return { background: "transparent", color: "var(--muted)" };
  }
  // Clamp to a visible range so a runaway 10+ skill doesn't make every
  // other cell look the same shade of green.
  const s = Math.max(-1.5, Math.min(2.5, skill));
  if (s >= 0) {
    // 0 -> 0% opacity, 2 -> 35% opacity green
    const alpha = Math.min(0.35, (s / 2.0) * 0.35);
    return {
      background: `color-mix(in srgb, var(--gain) ${(alpha * 100).toFixed(0)}%, transparent)`,
      color: "var(--foreground)",
    };
  }
  const alpha = Math.min(0.35, (Math.abs(s) / 1.5) * 0.35);
  return {
    background: `color-mix(in srgb, var(--loss) ${(alpha * 100).toFixed(0)}%, transparent)`,
    color: "var(--foreground)",
  };
}

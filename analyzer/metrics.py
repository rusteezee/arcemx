"""Phase A edge measurement.

Pure-compute module. Reads paper_trades + prediction_scores and emits
the metric bundle the Tier-1 gate evaluates against:

  - Equity curve (cumulative net P&L by exit date)
  - Daily return series (net P&L / portfolio base, per exit day)
  - Annualised Sharpe ratio (risk-free = RBI repo proxy 6.5%)
  - Max drawdown + Calmar ratio
  - PSR (probabilistic Sharpe ratio, Bailey-Lopez de Prado 2012)
  - Per-dim skill ratio from prediction_scores accuracy series

Tier ladder reference (locked in handoff section 6):
  Tier 1 (Phase B unlock): Sharpe > 1.0, max DD < 15%, PSR > 0.95
  Tier 2 (Phase C unlock): Sharpe > 1.3, max DD < 12%, PSR > 0.97
  Tier 3:                  Sharpe > 1.6, max DD < 10%, PSR > 0.99
  Peak (2028 target):      Sharpe > 2.0, max DD < 8%,  PSR > 0.995

No scipy dep on purpose. Render free tier already carries pandas + numpy
+ torch via the embed path; adding scipy bloats the cold start. Normal
CDF computed via math.erf instead.
"""
from __future__ import annotations

import math
import os
from datetime import date, datetime, timedelta, timezone
from itertools import combinations
from typing import Any

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

PORTFOLIO_BASE_INR = 65_000  # mirrors paper_trader.PORTFOLIO_BASE_INR
RISK_FREE_ANNUAL = 0.065     # RBI repo rate proxy (Jun 2026)
PERIODS_PER_YEAR = 252       # NSE trading days
SKILL_BASELINE = 50.0        # neutral accuracy score; per-dim ratio measures lift above this


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _norm_cdf(x: float) -> float:
    """Standard normal CDF via math.erf. Identical to scipy.stats.norm.cdf
    to ~15 decimal places; avoids the scipy import cost."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (percent-point function), Acklam's
    rational approximation (Acklam 2003) - max abs error ~1.15e-9,
    identical to scipy.stats.norm.ppf to that tolerance. Used by
    deflated_sharpe() to turn a trial count into a z-score without a
    scipy dependency."""
    if p <= 0.0:
        return float("-inf")
    if p >= 1.0:
        return float("inf")
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    p_low = 0.02425
    p_high = 1.0 - p_low
    if p < p_low:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1.0)
    if p <= p_high:
        q = p - 0.5
        r = q * q
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
               (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1.0)
    q = math.sqrt(-2.0 * math.log(1.0 - p))
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1.0)


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _stdev(xs: list[float], ddof: int = 1) -> float:
    if len(xs) < ddof + 1:
        return 0.0
    m = _mean(xs)
    var = sum((x - m) ** 2 for x in xs) / (len(xs) - ddof)
    return math.sqrt(var)


def _skewness(xs: list[float]) -> float:
    """Fisher-Pearson sample skewness (third standardised moment)."""
    n = len(xs)
    if n < 3:
        return 0.0
    m = _mean(xs)
    s = _stdev(xs, ddof=0)
    if s <= 0:
        return 0.0
    return sum(((x - m) / s) ** 3 for x in xs) / n


def _excess_kurtosis(xs: list[float]) -> float:
    """Excess kurtosis (fourth standardised moment minus 3). Normal = 0."""
    n = len(xs)
    if n < 4:
        return 0.0
    m = _mean(xs)
    s = _stdev(xs, ddof=0)
    if s <= 0:
        return 0.0
    return sum(((x - m) / s) ** 4 for x in xs) / n - 3.0


# ---------------------------------------------------------------------------
# Equity curve + daily returns
# ---------------------------------------------------------------------------
def equity_curve(closed_trades: list[dict]) -> list[tuple[date, float]]:
    """Sum net_pnl by exit date, then cumulative-sum across dates. Used
    as the input to Sharpe / max DD calculations. Trades without an
    exit_at or net_pnl are silently dropped (still-open or malformed)."""
    by_date: dict[date, float] = {}
    for t in closed_trades:
        exit_at = t.get("exit_at")
        net = t.get("net_pnl")
        if not exit_at or net is None:
            continue
        try:
            d = datetime.fromisoformat(str(exit_at).replace("Z", "+00:00")).date()
        except Exception:
            continue
        by_date[d] = by_date.get(d, 0.0) + float(net)
    sorted_dates = sorted(by_date.keys())
    cum = 0.0
    curve: list[tuple[date, float]] = []
    for d in sorted_dates:
        cum += by_date[d]
        curve.append((d, cum))
    return curve


def daily_returns(curve: list[tuple[date, float]], base_inr: float = PORTFOLIO_BASE_INR) -> list[float]:
    """Per-exit-day return as fraction of portfolio base. Uses the
    raw delta from one curve point to the next (NOT calendar daily;
    days without exits don't contribute and shouldn't dilute the
    Sharpe denominator the way a zero-padded series would). Sharpe
    annualisation below assumes ~252 trading days per year of activity,
    which is roughly correct for an always-on strategy and slightly
    pessimistic for one that trades less often (the right direction
    for a discipline gate)."""
    rets: list[float] = []
    prev = 0.0
    for _, cum in curve:
        delta = cum - prev
        rets.append(delta / base_inr)
        prev = cum
    return rets


# ---------------------------------------------------------------------------
# Sharpe, max drawdown, Calmar
# ---------------------------------------------------------------------------
def sharpe(returns: list[float],
           rf_annual: float = RISK_FREE_ANNUAL,
           periods_per_year: int = PERIODS_PER_YEAR) -> float:
    """Annualised Sharpe = (mean_excess / stdev) * sqrt(periods_per_year).
    Empty / single-point series return 0 rather than NaN so the metric
    bundle never has to special-case None downstream."""
    if len(returns) < 2:
        return 0.0
    rf_per_period = rf_annual / periods_per_year
    excess = [r - rf_per_period for r in returns]
    s = _stdev(excess, ddof=1)
    if s <= 0:
        return 0.0
    return (_mean(excess) / s) * math.sqrt(periods_per_year)


def max_drawdown(curve: list[tuple[date, float]],
                 base_inr: float = PORTFOLIO_BASE_INR) -> dict[str, Any]:
    """Largest peak-to-trough drop on the cumulative P&L curve, expressed
    as a fraction of (base_inr + peak). Returns peak/trough timestamps
    so the UI can highlight the worst window."""
    if not curve:
        return {"max_dd_pct": 0.0, "peak_at": None, "trough_at": None,
                "peak_value": 0.0, "trough_value": 0.0}
    peak = curve[0][1]
    peak_at = curve[0][0]
    worst = 0.0
    worst_peak_at = peak_at
    worst_trough_at = peak_at
    worst_peak = peak
    worst_trough = peak
    for d, v in curve:
        if v > peak:
            peak = v
            peak_at = d
        dd_inr = peak - v
        # Drawdown denominator includes the working capital; otherwise a
        # 1-trade loss on a 0-peak curve reports "-inf%".
        denom = base_inr + peak
        dd_pct = dd_inr / denom if denom > 0 else 0.0
        if dd_pct > worst:
            worst = dd_pct
            worst_peak_at = peak_at
            worst_trough_at = d
            worst_peak = peak
            worst_trough = v
    return {
        "max_dd_pct": float(worst * 100.0),
        "peak_at": worst_peak_at.isoformat() if worst_peak_at else None,
        "trough_at": worst_trough_at.isoformat() if worst_trough_at else None,
        "peak_value": float(worst_peak),
        "trough_value": float(worst_trough),
    }


def calmar(sharpe_value: float, max_dd_pct: float, annual_return_pct: float) -> float:
    """Calmar = annualised return / |max drawdown|. Higher is better.
    Returns 0 if drawdown is zero (insufficient data)."""
    if max_dd_pct <= 0:
        return 0.0
    return annual_return_pct / max_dd_pct


# ---------------------------------------------------------------------------
# PSR (Probabilistic Sharpe Ratio). Bailey & Lopez de Prado 2012
# ---------------------------------------------------------------------------
def psr(returns: list[float],
        benchmark_sr_annual: float = 0.0,
        periods_per_year: int = PERIODS_PER_YEAR) -> float:
    """Probability the *true* Sharpe exceeds `benchmark_sr_annual`,
    adjusted for skew + kurtosis of the return series. Output in [0, 1].

    Formula (Bailey & Lopez de Prado 2012 Eq. 6):
        PSR = Phi( (SR_hat - SR*) * sqrt(N - 1)
                   / sqrt(1 - skew*SR_hat + ((kurt - 1) / 4) * SR_hat^2) )
    where SR_hat is the per-period sample Sharpe, SR* is the per-period
    benchmark, N is the sample size, skew + kurt are sample moments.

    A negative-skewed strategy with fat tails gets a lower PSR for the
    same point Sharpe. exactly what we want as a discipline gate."""
    n = len(returns)
    if n < 4:
        return 0.0
    rf_per_period = RISK_FREE_ANNUAL / periods_per_year
    excess = [r - rf_per_period for r in returns]
    sr_per_period = _mean(excess) / _stdev(excess, ddof=1) if _stdev(excess, ddof=1) > 0 else 0.0
    sr_star = benchmark_sr_annual / math.sqrt(periods_per_year)
    sk = _skewness(excess)
    ku = _excess_kurtosis(excess)
    denom = math.sqrt(max(1e-12, 1.0 - sk * sr_per_period + ((ku - 1.0) / 4.0) * sr_per_period ** 2))
    z = (sr_per_period - sr_star) * math.sqrt(n - 1) / denom
    return float(_norm_cdf(z))


_EULER_MASCHERONI = 0.5772156649


def deflated_sharpe(returns: list[float], trial_sharpes: list[float],
                    periods_per_year: int = PERIODS_PER_YEAR) -> dict[str, Any]:
    """Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014): PSR evaluated
    at a benchmark SR* that corrects for how many strategy variants
    (trials) were tried before picking this one - the multiple-testing
    correction plain PSR does not make.

        SR* = sqrt(Var[{SR_n}]) * ((1-gamma)*z(1-1/N) + gamma*z(1-1/(N*e)))

    trial_sharpes are the N per-period Sharpe estimates whose spread
    stands in for how far luck alone could move the Sharpe (Trials
    definition, decided in blueprint 10: N = the walk-forward confidence-
    floor grid, 9 floors 40..80 step 5, run once against the FULL closed-
    trade set - the parameter sweep itself IS the multiple-testing event.
    Nothing else is counted as a trial). SR* comes out per-period from
    the formula above; annualised to sr_star_annual so it plugs straight
    into psr()'s existing benchmark_sr_annual parameter unchanged.

    Returns dsr=psr (no deflation applied) with degenerate=True when
    N<2 or the trial variance is 0 - deflation is meaningless without
    cross-trial spread, and the caller must never mistake "couldn't
    deflate" for "deflated to a real number"."""
    n_trials = len(trial_sharpes)
    var_sr = _stdev(trial_sharpes, ddof=1) ** 2 if n_trials >= 2 else 0.0
    if n_trials < 2 or var_sr <= 0:
        psr_v = psr(returns, benchmark_sr_annual=0.0, periods_per_year=periods_per_year)
        return {"dsr": psr_v, "sr_star_annual": 0.0, "n_trials": n_trials, "degenerate": True}
    z1 = _norm_ppf(1.0 - 1.0 / n_trials)
    z2 = _norm_ppf(1.0 - 1.0 / (n_trials * math.e))
    sr_star_per_period = math.sqrt(var_sr) * ((1.0 - _EULER_MASCHERONI) * z1 + _EULER_MASCHERONI * z2)
    sr_star_annual = sr_star_per_period * math.sqrt(periods_per_year)
    dsr = psr(returns, benchmark_sr_annual=sr_star_annual, periods_per_year=periods_per_year)
    return {"dsr": dsr, "sr_star_annual": round(sr_star_annual, 4),
            "n_trials": n_trials, "degenerate": False}


# ---------------------------------------------------------------------------
# Per-dim skill ratio from prediction_scores
# ---------------------------------------------------------------------------
def per_dim_skill(sb, days: int = 90, min_samples: int = 5) -> list[dict[str, Any]]:
    """Group prediction_scores by dimension over the lookback window
    and emit (mean_acc, stdev_acc, sample_size, skill_ratio) per dim.

    Skill ratio = (mean_acc - 50) / stdev_acc. Reads: standard deviations
    above coin-flip baseline. >1.0 = the dim's accuracy distribution sits
    comfortably above noise; <0 = systematically worse than guessing.

    Dims with sample_size < min_samples are flagged but not filtered out
    (caller decides how to render. exclude from charts, show in table)."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = sb.table("prediction_scores").select(
        "dimension,score"
    ).gte("scored_at", since).execute().data or []
    by_dim: dict[str, list[float]] = {}
    for r in rows:
        d = r.get("dimension")
        s = r.get("score")
        if not d or s is None:
            continue
        try:
            by_dim.setdefault(d, []).append(float(s))
        except (TypeError, ValueError):
            continue
    out: list[dict[str, Any]] = []
    for dim, scores in by_dim.items():
        n = len(scores)
        mean_acc = _mean(scores)
        std_acc = _stdev(scores, ddof=1)
        skill = (mean_acc - SKILL_BASELINE) / std_acc if std_acc > 0 else 0.0
        out.append({
            "dimension": dim,
            "sample_size": n,
            "mean_acc": round(mean_acc, 2),
            "stdev_acc": round(std_acc, 2),
            "skill_ratio": round(skill, 3),
            "low_sample": n < min_samples,
        })
    out.sort(key=lambda x: x["skill_ratio"], reverse=True)
    return out


# ---------------------------------------------------------------------------
# Tier gate evaluation
# ---------------------------------------------------------------------------
TIER_GATES = [
    {"tier": 1, "sharpe": 1.0, "max_dd_pct": 15.0, "psr": 0.95, "label": "Phase B unlock"},
    {"tier": 2, "sharpe": 1.3, "max_dd_pct": 12.0, "psr": 0.97, "label": "Phase C unlock"},
    {"tier": 3, "sharpe": 1.6, "max_dd_pct": 10.0, "psr": 0.99, "label": "Hardening"},
    {"tier": 4, "sharpe": 2.0, "max_dd_pct": 8.0,  "psr": 0.995, "label": "Peak (Phase B terminal)"},
]


def evaluate_tiers(sharpe_v: float, max_dd_pct: float, psr_v: float) -> dict[str, Any]:
    """Walk the tier ladder. Return current cleared tier plus the per-gate
    pass/fail map for the NEXT tier so the UI can show exactly which knob
    is still short of the gate. Never-give-up doctrine: failure becomes
    diagnostic input, not a kill signal."""
    cleared = 0
    next_gate = TIER_GATES[0]
    for gate in TIER_GATES:
        if (sharpe_v >= gate["sharpe"]
                and max_dd_pct <= gate["max_dd_pct"]
                and psr_v >= gate["psr"]):
            cleared = gate["tier"]
            continue
        next_gate = gate
        break
    pass_map = {
        "sharpe": sharpe_v >= next_gate["sharpe"],
        "max_dd": max_dd_pct <= next_gate["max_dd_pct"],
        "psr": psr_v >= next_gate["psr"],
    }
    return {
        "cleared_tier": cleared,
        "next_tier": next_gate["tier"],
        "next_label": next_gate["label"],
        "next_gates": {
            "sharpe": next_gate["sharpe"],
            "max_dd_pct": next_gate["max_dd_pct"],
            "psr": next_gate["psr"],
        },
        "pass_map": pass_map,
    }


# ---------------------------------------------------------------------------
# Walk-forward parameter tuning
# ---------------------------------------------------------------------------
def _trade_to_return(t: dict, base_inr: float) -> float | None:
    """Per-trade fractional return on the portfolio base. Used by walk-
    forward grid search: a trade's contribution is its net_pnl / base.
    Returns None if the trade is missing the fields a return needs."""
    net = t.get("net_pnl")
    if net is None:
        return None
    try:
        return float(net) / base_inr
    except (TypeError, ValueError):
        return None


def _filter_trades_by_confidence(trades: list[dict], floor: int) -> list[dict]:
    """Hypothetical re-filter: which trades WOULD have been entered if
    the gate floor was `floor` instead of the floor in effect when they
    fired? A trade with confidence >= floor would still have entered."""
    return [t for t in trades if (t.get("confidence") or 0) >= floor]


def _window_sharpe(trades: list[dict], base_inr: float) -> float:
    """Per-trade-treated-as-day Sharpe over a window. NOT annualised the
    same way the equity-curve Sharpe is because per-trade frequency may
    not be daily. we use sqrt(len(returns)) as a coarse n adjustment
    only, so two windows with the same return distribution but different
    trade counts can be compared. Caller should think of this as a
    relative score across window-floor pairs, not an absolute Sharpe."""
    rets: list[float] = []
    for t in trades:
        r = _trade_to_return(t, base_inr)
        if r is not None:
            rets.append(r)
    if len(rets) < 3:
        return 0.0
    s = _stdev(rets, ddof=1)
    if s <= 0:
        return 0.0
    return (_mean(rets) / s) * math.sqrt(len(rets))


def pbo_cscv(trades: list[dict], grid: list[int], base_inr: float,
            blocks: int = 8) -> dict[str, Any] | None:
    """Probability of Backtest Overfitting via Combinatorially Symmetric
    Cross-Validation (Bailey, Borwein, Lopez de Prado & Zhu 2015),
    minimal correct version. Splits the chronological closed-trade
    return series into `blocks` equal contiguous slices, tries every
    way to hold out half of them as in-sample (C(8,4) = 70 combos for
    blocks=8), and for each combo: pick the confidence-floor grid point
    with the best IN-SAMPLE Sharpe, then find where that SAME floor's
    Sharpe actually ranks OUT-OF-SAMPLE among the grid (0 = best). PBO
    is the fraction of combos where the in-sample pick's OOS rank lands
    in the bottom half (relative rank > 0.5) - i.e. how often "trust the
    best in-sample floor" would have actively misled you.

    Returns None ("pbo_insufficient_data" - caller checks this) below
    40 closed trades; 8 blocks need real per-block sample size to carry
    any signal."""
    closed = [t for t in trades if t.get("exit_at") and t.get("net_pnl") is not None]
    if len(closed) < 40:
        return None
    closed_sorted = sorted(closed, key=lambda t: t["exit_at"])
    n = len(closed_sorted)
    bounds = [round(i * n / blocks) for i in range(blocks + 1)]
    block_slices = [closed_sorted[bounds[i]:bounds[i + 1]] for i in range(blocks)]

    half = blocks // 2
    combos = list(combinations(range(blocks), half))
    below_median = 0
    for is_idx in combos:
        oos_idx = [i for i in range(blocks) if i not in is_idx]
        is_trades = [t for b in is_idx for t in block_slices[b]]
        oos_trades = [t for b in oos_idx for t in block_slices[b]]

        is_sharpes = {f: _window_sharpe(_filter_trades_by_confidence(is_trades, f), base_inr) for f in grid}
        oos_sharpes = {f: _window_sharpe(_filter_trades_by_confidence(oos_trades, f), base_inr) for f in grid}

        best_floor = max(grid, key=lambda f: is_sharpes[f])
        oos_rank_order = sorted(grid, key=lambda f: oos_sharpes[f], reverse=True)
        rank = oos_rank_order.index(best_floor)
        relative_rank = rank / (len(grid) - 1) if len(grid) > 1 else 0.0
        if relative_rank > 0.5:
            below_median += 1

    return {"pbo": round(below_median / len(combos), 4), "combos": len(combos), "grid": grid}


def walk_forward_confidence_floor(
    sb=None,
    grid: list[int] | None = None,
    train_days: int = 60,
    test_days: int = 14,
    base_inr: float = PORTFOLIO_BASE_INR,
) -> dict[str, Any]:
    """Rolling-window optimisation of the entry-gate confidence floor.

    For each Monday in the closed-trade history:
      1. train window = [monday - train_days, monday]
      2. Grid-search floor in `grid` (default 40..80 step 5)
      3. Pick floor that maximises Sharpe on trades within the train
         window. Stamp the picked floor as the "what would have been
         optimal" floor for the next `test_days`.

    Output:
      - per_window list of {monday_date, picked_floor, train_n_trades, train_sharpe}
      - latest_floor: the most recent window's pick
      - drift: stdev of picked floors across windows (high stdev = the
        optimal floor is unstable, signal does not generalise)

    The result is a discipline check, not an automation: the user reads
    it and decides whether to change paper_trader.MIN_CONF, never the
    other way around. Auto-changing live parameters on a 60d window is
    exactly the overfitting trap the walk-forward exists to detect.

    Returns an empty bundle (per_window=[], latest_floor=None) when
    there are not enough closed trades to score even one window.
    """
    if grid is None:
        grid = list(range(40, 85, 5))
    if sb is None:
        sb = _sb()
    rows = sb.table("paper_trades").select(
        "id,entered_at,exit_at,net_pnl,confidence,status"
    ).neq("status", "open").execute().data or []
    if not rows:
        return {"per_window": [], "latest_floor": None, "drift_stdev": 0.0,
                "trade_count": 0, "grid": grid, "note": "no closed trades yet"}
    parsed: list[dict] = []
    for r in rows:
        ea = r.get("entered_at")
        if not ea:
            continue
        try:
            dt = datetime.fromisoformat(str(ea).replace("Z", "+00:00"))
        except Exception:
            continue
        parsed.append({**r, "_entered_dt": dt})
    parsed.sort(key=lambda x: x["_entered_dt"])
    if not parsed:
        return {"per_window": [], "latest_floor": None, "drift_stdev": 0.0,
                "trade_count": 0, "grid": grid, "note": "no parseable trades"}

    first = parsed[0]["_entered_dt"].date()
    last = parsed[-1]["_entered_dt"].date()
    # Walk Mondays in [first + train_days, last] so each window has
    # at least one full train slice behind it. weekday() == 0 -> Monday.
    cursor = first + timedelta(days=train_days)
    while cursor.weekday() != 0:
        cursor += timedelta(days=1)
    per_window: list[dict] = []
    while cursor <= last:
        train_start_d = cursor - timedelta(days=train_days)
        train = [t for t in parsed
                 if train_start_d <= t["_entered_dt"].date() <= cursor]
        best_floor = None
        best_sharpe = float("-inf")
        for floor in grid:
            cand = _filter_trades_by_confidence(train, floor)
            sh = _window_sharpe(cand, base_inr)
            if sh > best_sharpe:
                best_sharpe = sh
                best_floor = floor
        per_window.append({
            "monday": cursor.isoformat(),
            "picked_floor": best_floor,
            "train_n_trades": len(train),
            "train_sharpe": round(best_sharpe, 3) if best_sharpe != float("-inf") else 0.0,
        })
        cursor += timedelta(days=7)

    if per_window:
        picks = [w["picked_floor"] for w in per_window if w["picked_floor"] is not None]
        drift = _stdev(picks, ddof=1) if len(picks) >= 2 else 0.0
        latest_floor = per_window[-1]["picked_floor"]
    else:
        drift = 0.0
        latest_floor = None

    return {
        "per_window": per_window,
        "latest_floor": latest_floor,
        "drift_stdev": round(drift, 2),
        "trade_count": len(parsed),
        "grid": grid,
    }


# ---------------------------------------------------------------------------
# Top-level: read paper_trades + prediction_scores, emit metric bundle
# ---------------------------------------------------------------------------
def compute_paper_metrics(base_inr: float = PORTFOLIO_BASE_INR) -> dict[str, Any]:
    """One-shot bundle for the /paper dashboard tab. Idempotent reads;
    safe to call from cron or page render. Empty paper_trades returns a
    zero-bundle rather than raising so the dashboard renders clean."""
    sb = _sb()
    rows = sb.table("paper_trades").select(
        "id,entered_at,exit_at,net_pnl,gross_pnl,brokerage,stt,slippage_cost,status"
    ).neq("status", "open").execute().data or []
    curve = equity_curve(rows)
    rets = daily_returns(curve, base_inr=base_inr)
    sharpe_v = sharpe(rets)
    dd = max_drawdown(curve, base_inr=base_inr)
    psr_v = psr(rets) if len(rets) >= 4 else 0.0
    total_net = curve[-1][1] if curve else 0.0
    span_days = ((curve[-1][0] - curve[0][0]).days + 1) if len(curve) >= 2 else 0
    annual_ret_pct = (total_net / base_inr) * (365.0 / span_days) * 100.0 if span_days > 0 else 0.0
    calmar_v = calmar(sharpe_v, dd["max_dd_pct"], annual_ret_pct)
    tiers = evaluate_tiers(sharpe_v, dd["max_dd_pct"], psr_v)
    per_dim = per_dim_skill(sb)
    wf = walk_forward_confidence_floor(sb=sb, base_inr=base_inr)

    # Circuit breaker (blueprint 08): CURRENT drawdown from the curve's
    # running peak, NOT max_drawdown()'s worst-historical-window figure
    # above - the breaker cares where the curve sits right now. Same
    # denominator convention (base_inr + peak). Deferred import avoids a
    # module-load cycle (paper_trader.py itself imports this module for
    # equity_curve); see paper_trader._breaker_state for the canonical
    # implementation this mirrors.
    breaker_dd_pct = 0.0
    breaker_tripped = False
    if curve:
        peak = curve[0][1]
        for _, v in curve:
            if v > peak:
                peak = v
        denom = base_inr + peak
        breaker_dd_pct = ((peak - curve[-1][1]) / denom * 100.0) if denom > 0 else 0.0
        from analyzer.paper_trader import BREAKER_DD_PCT, BREAKER_REARM_PCT, BREAKER_MIN_TRADES
        if len(rows) >= BREAKER_MIN_TRADES:
            prev_tripped = False
            try:
                prev = sb.table("metrics_snapshot").select("bundle").order(
                    "computed_at", desc=True).limit(1).execute().data or []
                if prev:
                    prev_tripped = bool((prev[0].get("bundle") or {}).get("breaker_tripped"))
            except Exception:
                pass
            breaker_tripped = (
                breaker_dd_pct >= BREAKER_REARM_PCT if prev_tripped
                else breaker_dd_pct > BREAKER_DD_PCT
            )

    return {
        "trade_count": len(rows),
        "span_days": span_days,
        "total_net_pnl": float(total_net),
        "annual_return_pct": round(annual_ret_pct, 2),
        "sharpe": round(sharpe_v, 3),
        "max_drawdown": dd,
        "calmar": round(calmar_v, 3),
        "psr": round(psr_v, 4),
        "tier_eval": tiers,
        "equity_curve": [(d.isoformat(), v) for d, v in curve],
        "per_dim_skill": per_dim,
        "walk_forward": wf,
        "breaker_tripped": breaker_tripped,
        "breaker_dd_pct": round(breaker_dd_pct, 2),
    }


if __name__ == "__main__":
    import json
    bundle = compute_paper_metrics()
    # Trim per_dim list + equity curve for terminal-friendly print.
    preview = {**bundle}
    preview["per_dim_skill"] = bundle["per_dim_skill"][:10]
    preview["equity_curve"] = bundle["equity_curve"][:5] + (
        ["..."] if len(bundle["equity_curve"]) > 5 else []
    )
    print(json.dumps(preview, indent=2, default=str))

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
# PSR (Probabilistic Sharpe Ratio) — Bailey & Lopez de Prado 2012
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
    same point Sharpe — exactly what we want as a discipline gate."""
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
    (caller decides how to render — exclude from charts, show in table)."""
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
    {"tier": 4, "sharpe": 2.0, "max_dd_pct": 8.0,  "psr": 0.995, "label": "Peak (2028 target)"},
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

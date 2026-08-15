"""Volatility-scaled trade geometry (De Prado's triple-barrier method,
"Advances in Financial Machine Learning" ch.3: horizontal barriers must
be "a dynamic function of estimated volatility (whether realized or
implied)", not fixed/freehand price levels).

Root cause this closes: paper_trades geometry came straight from the
LLM's raw target_price/stop_loss with no volatility check. Live-measured
2026-08-15 across 27 closed trades: mean target distance 3.80 daily
sigma (P(touch) in 1 session ~0.6%), mean stop distance 1.67 sigma
(P(touch) ~16%) - stops ~28x more likely to hit than targets, naive EV
-0.377%/trade before costs. Matches the realized outcome exactly (15
stop/11 horizon/1 target of 27). No amount of directional model
accuracy fixes geometry that is structurally almost-unreachable on one
side and near-certain on the other.

Fix: entry price and side (the LLM's actual market-timing read) are
still trusted. target_px/stop_px are NOT - they are reconstructed here
from realized volatility, sqrt-time scaled to the position's horizon.
Shared by paper_trader.py (live) and backtest.py (replay) so both use
identical math; the caller supplies sigma_daily via its own no-lookahead
path (paper_trader: fresh yfinance pull; backtest: HistCache slice
strictly before asof) - this module does no I/O itself.
"""
from __future__ import annotations

import math
from statistics import NormalDist

_ND = NormalDist()

# De Prado's ptSl multipliers. Asymmetric by design: a 1.5x/1.0x split
# gives every trade a constant 1.5 nominal reward:risk by construction,
# so the old freehand MIN_RR gate (checking the LLM's own geometry) is
# retired - what actually varies trade-to-trade now is the *probability*
# of reaching either barrier (via expected_value_pct), not the ratio.
PT_MULT = 1.5
SL_MULT = 1.0

# Floor so a garbage/zero volatility read (e.g. a stale or illiquid
# series) can't collapse barriers to zero and pass every gate.
MIN_SIGMA_DAILY = 0.005  # 0.5%


def sigma_horizon(sigma_daily: float, horizon_days: int) -> float:
    """Sqrt-time scaling of daily realized vol to the position's full
    holding horizon. Floors sigma_daily first so a bad read never
    produces near-zero barriers."""
    sd = max(float(sigma_daily or 0.0), MIN_SIGMA_DAILY)
    return sd * math.sqrt(max(int(horizon_days or 1), 1))


def volatility_scaled_barriers(
    intent_px: float, side: str, sigma_daily: float, horizon_days: int,
    pt_mult: float = PT_MULT, sl_mult: float = SL_MULT,
) -> tuple[float, float]:
    """Returns (target_px, stop_px) built from realized volatility, not
    the LLM's stated levels. side is 'long' or 'short'."""
    unit = sigma_horizon(sigma_daily, horizon_days) * intent_px
    if side == "long":
        return intent_px + pt_mult * unit, intent_px - sl_mult * unit
    return intent_px - pt_mult * unit, intent_px + sl_mult * unit


def touch_probabilities(
    target_dist_pct: float, stop_dist_pct: float, sigma_daily: float, horizon_days: int,
) -> tuple[float, float]:
    """P(touch target) and P(touch stop) within horizon_days, using the
    reflection-principle approximation for a driftless random walk:
    P(max |W_t| >= a) = 2*(1 - Phi(a/sigma)). A gate-threshold
    approximation (ignores drift and the two-barrier path-dependence
    De Prado's actual triple-barrier labeler resolves by full path
    simulation) - deliberately simple and conservative for a live
    entry gate, not a pricing model. *_dist_pct are positive percentage
    distances (e.g. 8.0 for an 8% move away from entry)."""
    sh = sigma_horizon(sigma_daily, horizon_days)
    if sh <= 0:
        return 0.0, 0.0
    d_t = (target_dist_pct / 100.0) / sh
    d_s = (stop_dist_pct / 100.0) / sh
    p_t = min(1.0, 2 * (1 - _ND.cdf(d_t)))
    p_s = min(1.0, 2 * (1 - _ND.cdf(d_s)))
    return p_t, p_s


def expected_value_pct(
    target_dist_pct: float, stop_dist_pct: float, sigma_daily: float,
    horizon_days: int, friction_pct: float = 0.0,
) -> float:
    """Volatility-derived EV in percent under a DRIFTLESS (zero assumed
    directional skill) random walk. Diagnostic/reporting only - do not
    gate entries on this. Any target set farther than the stop (as
    volatility_scaled_barriers always does, pt_mult > sl_mult) will
    show negative EV here by construction, because a wider barrier is
    always less likely to be touched first than a narrower one with no
    drift assumed. That does not mean the trade is bad; it means this
    formula carries no opinion on the LLM's directional skill. Use
    breakeven_win_rate() + calibration.recalibrate()'s real measured
    hit-rate for the actual entry gate instead."""
    p_t, p_s = touch_probabilities(target_dist_pct, stop_dist_pct, sigma_daily, horizon_days)
    return p_t * target_dist_pct - p_s * stop_dist_pct - friction_pct


def breakeven_win_rate(pt_mult: float = PT_MULT, sl_mult: float = SL_MULT) -> float:
    """Minimum true win probability (0-1) needed for positive EV at a
    fixed pt_mult:sl_mult payoff ratio: p*pt > (1-p)*sl solved for p.
    With the default 1.5:1.0 split this is 0.4 - a trade needs > 40%
    real (calibrated, not stated) hit-rate to clear its own geometry."""
    return sl_mult / (pt_mult + sl_mult)

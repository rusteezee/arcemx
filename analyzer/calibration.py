"""Platt-scaling recalibration of stated LLM confidence against
calibration_log's own track record (blueprint 04). Pure stdlib, no
sklearn, deterministic (no randomness) - a small 2-parameter logistic
fit is the right capacity at ~250 pairs; isotonic regression waits
until ~1,000+ (see ROADMAP.md).

This upgrades analyzer.paper_trader._dim_confidence_bias, which only
shifts confidence by a flat gap (stated_mean - realized_mean). Platt
scaling instead learns the actual shape p_cal = sigmoid(a*x + b) of
"stated confidence -> real hit rate", so it can reshape as well as
shift. The legacy bias debit remains the fallback whenever there is not
enough data to fit (see MIN_PAIRS)."""
import math
from datetime import datetime, timezone

MIN_PAIRS = 80
_NEWTON_STEPS = 25
_RIDGE = 1e-6


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    ez = math.exp(z)
    return ez / (1.0 + ez)


def fit_platt(pairs: list[tuple[float, int]]) -> tuple[float, float] | None:
    """Newton-Raphson fit of p = sigmoid(a*x + b) on (x, y) pairs, x =
    stated_confidence/100, y = hit (0/1). Uses Platt's target smoothing
    (y+ = (N+ + 1)/(N+ + 2), y- = 1/(N- + 2)) instead of raw 0/1 labels
    so the fit does not overfit the exact training pairs. Returns None
    if there are fewer than MIN_PAIRS pairs, both classes are not
    present, or the fit diverges (any non-finite parameter)."""
    n = len(pairs)
    if n < MIN_PAIRS:
        return None
    n_pos = sum(1 for _, y in pairs if y == 1)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    y_pos = (n_pos + 1) / (n_pos + 2)
    y_neg = 1 / (n_neg + 2)
    xs = [x for x, _ in pairs]
    ys = [y_pos if y == 1 else y_neg for _, y in pairs]

    a, b = 1.0, 0.0
    for _ in range(_NEWTON_STEPS):
        g1 = g2 = 0.0
        h11 = h12 = h22 = 0.0
        for x, y in zip(xs, ys):
            p = _sigmoid(a * x + b)
            diff = p - y
            g1 += diff * x
            g2 += diff
            w = p * (1.0 - p)
            h11 += w * x * x
            h12 += w * x
            h22 += w
        h11 += _RIDGE
        h22 += _RIDGE
        det = h11 * h22 - h12 * h12
        if not det:
            return None
        da = (h22 * g1 - h12 * g2) / det
        db = (-h12 * g1 + h11 * g2) / det
        a -= da
        b -= db
        if not (math.isfinite(a) and math.isfinite(b)):
            return None
    return a, b


def apply(fit: tuple[float, float], stated_conf: float) -> float:
    """Map a raw 0-100 stated confidence through a fitted (a, b) to a
    calibrated 0-100 confidence."""
    a, b = fit
    x = float(stated_conf) / 100.0
    return max(0.0, min(100.0, _sigmoid(a * x + b) * 100.0))


def fit_for_dimension(pairs_by_dim: dict[str, list[tuple[float, int]]],
                      dimension: str) -> tuple[float, float] | None:
    """Per-dimension fit if that dimension alone has >= MIN_PAIRS rows;
    else one pooled GLOBAL fit across all dimensions if the total has
    >= MIN_PAIRS; else None (caller falls back to the legacy bias
    debit). At current live volumes (~250-300 total pairs, largest
    single dim in the 40-60s) this always resolves to the global fit -
    expected, and correct: per-dim fits arrive for free as each
    dimension's own history grows past MIN_PAIRS."""
    fit = fit_platt(pairs_by_dim.get(dimension, []))
    if fit is not None:
        return fit
    all_pairs = [p for rows in pairs_by_dim.values() for p in rows]
    return fit_platt(all_pairs)


def load_pairs(sb, before: datetime | None = None) -> dict[str, list[tuple[float, int]]]:
    """DB-backed loader for the live gate: pulls the whole
    calibration_log table (paginated via .range()), optionally as-of
    filtered to rows with graded_at strictly before `before`, grouped
    by dimension into (stated_confidence/100, hit) pairs. hit =
    realized_score >= 60 (the grader's own "materially correct"
    threshold for its 0-100 gradient scoring)."""
    pairs_by_dim: dict[str, list[tuple[float, int]]] = {}
    page = 1000
    start = 0
    while True:
        rows = sb.table("calibration_log").select(
            "dimension,stated_confidence,realized_score,graded_at"
        ).range(start, start + page - 1).execute().data or []
        for r in rows:
            sc, rs = r.get("stated_confidence"), r.get("realized_score")
            if sc is None or rs is None:
                continue
            if before is not None:
                graded_at = r.get("graded_at")
                if not graded_at or graded_at >= before.isoformat():
                    continue
            dim = r.get("dimension") or ""
            pairs_by_dim.setdefault(dim, []).append(
                (float(sc) / 100.0, 1 if float(rs) >= 60 else 0))
        if len(rows) < page:
            break
        start += page
    return pairs_by_dim


_pairs_cache: dict[str, dict[str, list[tuple[float, int]]]] = {}
_fit_cache: dict[tuple[str, str], tuple[float, float] | None] = {}


def recalibrate(sb, stated_conf: float, dimension: str,
                before: datetime | None = None) -> float | None:
    """Return a Platt-recalibrated 0-100 confidence for `stated_conf` on
    `dimension`, or None when there is not enough calibration_log data
    yet (caller should fall back to the existing bias-debit path).
    Cached per (dimension, day) so one evaluation pass fits once, not
    once per signal - `before=None` (the live gate) caches under the
    single key "live" for the life of this process."""
    if not isinstance(stated_conf, (int, float)):
        return None
    day_key = before.date().isoformat() if before is not None else "live"
    if day_key not in _pairs_cache:
        _pairs_cache[day_key] = load_pairs(sb, before)
    cache_key = (dimension, day_key)
    if cache_key not in _fit_cache:
        _fit_cache[cache_key] = fit_for_dimension(_pairs_cache[day_key], dimension)
    fit = _fit_cache[cache_key]
    if fit is None:
        return None
    return apply(fit, stated_conf)

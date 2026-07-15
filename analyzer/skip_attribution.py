"""Skipped-winner attribution (blueprint 12): "had this skipped signal
entered anyway, what would net P&L have been?" - described in
db/schema.sql:276-278 since day one, never implemented until now.

Retro-scores paper_signals rows with action='skip' and known entry
geometry, using the exact same walk-forward exit simulator the backtest
replay uses (ShadowBook + _open_shadow_trade + _mark_shadow_book from
analyzer.backtest), so a skip's would-be P&L is computed identically to
how a real entry would have been graded.

CAVEAT - independent fill: every retro result is simulated in its own
isolated ShadowBook, so it ignores sector-cap/already-open/book
interactions entirely. A skipped trade might have blocked a DIFFERENT
real trade from entering (sector cap, ticker freeze); this retro score
only asks "if literally nothing else had changed, what would THIS ONE
trade alone have done." Every retro result carries
`"caveat": "independent_fill"` so this is never silently forgotten
downstream.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from analyzer.backtest import HistCache, ShadowBook, _open_shadow_trade, _mark_shadow_book
from analyzer.paper_trader import (
    MAX_NOTIONAL_PCT,
    RISK_PER_TRADE,
    _resolve_portfolio_base,
    _sb,
    _ticker_sector_and_cap,
)

# Settle buffer beyond a signal's own horizon before attempting to score
# it - mirrors grader._session_bounds's own settle-buffer discipline
# elsewhere in this codebase: give the horizon's exit bar time to
# actually print before trusting it's resolved.
_SETTLE_BUFFER_DAYS = 2


def _eligible_candidates(sb, days: int) -> list[tuple[dict, dict, datetime]]:
    """Pull skip rows from the last `days`, filter to ones with captured
    geometry, not yet retro-scored, and old enough that their horizon has
    actually had a chance to resolve. Returns (row, geometry, evaluated_at)
    tuples."""
    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).isoformat()
    rows = sb.table("paper_signals").select(
        "id,ticker,evaluated_at,meta"
    ).eq("action", "skip").gte("evaluated_at", since).execute().data or []

    out = []
    for r in rows:
        meta = r.get("meta") or {}
        geo = meta.get("geometry")
        if not geo or not geo.get("intent") or not geo.get("target") or not geo.get("stop"):
            continue
        if meta.get("retro") is not None:
            continue
        try:
            eval_at = datetime.fromisoformat(str(r["evaluated_at"]).replace("Z", "+00:00"))
        except Exception:
            continue
        horizon_days = int(geo.get("horizon_days") or 30)
        if now < eval_at + timedelta(days=horizon_days + _SETTLE_BUFFER_DAYS):
            continue
        out.append((r, geo, eval_at))
    return out


def score_skips(days: int = 7, sb=None) -> dict:
    """Retro-score skip rows with known geometry whose outcome window has
    closed, not yet scored. Idempotent - re-running only touches
    newly-eligible rows (meta.retro is null is the dedup check), matching
    eval_signals()'s own idempotent-upsert pattern elsewhere in this
    codebase. Fails open per-row: one ticker's yfinance hiccup does not
    stop the rest of the batch, and the whole call never raises - callers
    (grader._run_paper_trader) wrap it anyway as defense in depth, but
    this function itself is already safe to call unguarded."""
    sb = sb or _sb()
    try:
        candidates = _eligible_candidates(sb, days)
    except Exception as e:
        print(f"  skip_attribution: candidate query failed: {str(e)[:150]}")
        return {"scored": 0, "candidates": 0, "error": str(e)[:150]}

    if not candidates:
        return {"scored": 0, "candidates": 0}

    now = datetime.now(timezone.utc)
    portfolio_base = _resolve_portfolio_base(sb)
    earliest = min(c[2] for c in candidates).date()
    hist = HistCache(earliest, now.date())

    scored = 0
    for row, geo, eval_at in candidates:
        ticker = row["ticker"]
        try:
            intent_px = float(geo["intent"])
            target_px = float(geo["target"])
            stop_px = float(geo["stop"])
            horizon_days = int(geo.get("horizon_days") or 30)
            risk_per_share = abs(intent_px - stop_px)
            if risk_per_share <= 0 or intent_px <= 0:
                continue

            avg_turnover = hist.avg_turnover(ticker, eval_at.date()) or 1e8
            _, cap_tier = _ticker_sector_and_cap(sb, ticker)
            # Same sizing formula a real entry would have used - the
            # question is "what would THIS trade's P&L have been", which
            # only means something at a realistic size, not qty=1.
            qty = max(1, min(
                int((portfolio_base * RISK_PER_TRADE) / risk_per_share),
                int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px),
            ))

            book = ShadowBook()
            _open_shadow_trade(
                book, source_kind="retro", source_run_id=row["id"], ticker=ticker,
                entered_at=eval_at, intent_px=intent_px, target_px=target_px,
                stop_px=stop_px, horizon_days=horizon_days, qty=qty,
                confidence=None, edge=None, sector=None, cap_tier=cap_tier,
                avg_turnover=avg_turnover, hist=hist,
            )
            _mark_shadow_book(book, hist, now)

            if not book.closed:
                # Didn't resolve within available history even past the
                # settle buffer (a data gap, e.g.) - leave unscored,
                # meta.retro stays null so the next pass retries it
                # rather than this call guessing at an outcome.
                continue

            closed = book.closed[0]
            retro = {
                "net_pnl": closed.get("net_pnl"),
                "exit_reason": closed.get("exit_reason"),
                "qty": qty,
                "scored_at": now.isoformat(),
                "caveat": "independent_fill",
            }
            meta = row.get("meta") or {}
            new_meta = {**meta, "retro": retro}
            sb.table("paper_signals").update({"meta": new_meta}).eq("id", row["id"]).execute()
            scored += 1
        except Exception as e:
            print(f"  skip_attribution: score failed ({ticker}, id={row['id']}): {str(e)[:150]}")
            continue

    result = {"scored": scored, "candidates": len(candidates)}
    print(f"  skip_attribution.score_skips: {result}")
    return result


def backfill_geometry(limit: int = 500, sb=None) -> int:
    """One-time backfill for historical top_performer skips that predate
    the geometry-capture code (blueprint 12 step 1 only captures going
    forward). Geometry is recoverable for this source_kind specifically
    because top_performers picks carry entry/target/stop_loss directly in
    the analysis row's raw_json - joins each ungeometried skip back to
    its source analysis row and extracts the matching pick by ticker.
    Only top_performer, per the blueprint's own scoping (stock_analyst
    geometry would need stock_analyses.llm_json, outlook geometry the
    range band - both a different join shape, not attempted here).
    Idempotent: only touches rows genuinely missing geometry."""
    sb = sb or _sb()
    rows = sb.table("paper_signals").select(
        "id,ticker,source_run_id,meta"
    ).eq("action", "skip").eq("source_kind", "top_performer").limit(limit).execute().data or []
    candidates = [r for r in rows if not (r.get("meta") or {}).get("geometry")]
    if not candidates:
        return 0

    analysis_ids = sorted({r["source_run_id"] for r in candidates if r.get("source_run_id")})
    analysis_by_id: dict[int, dict] = {}
    for i in range(0, len(analysis_ids), 50):
        batch = analysis_ids[i:i + 50]
        res = sb.table("analysis").select("id,raw_json").in_("id", batch).execute()
        for a in res.data or []:
            analysis_by_id[a["id"]] = a.get("raw_json") or {}

    def _parse_inr(v):
        if isinstance(v, (int, float)):
            return float(v) if v > 0 else None
        if not isinstance(v, str):
            return None
        cleaned = v.replace("₹", "").replace(",", "").strip()
        if not cleaned:
            return None
        parts = [p.strip() for p in cleaned.replace("to", "-").split("-") if p.strip()]
        nums = []
        for p in parts:
            try:
                nums.append(float(p))
            except ValueError:
                continue
        return sum(nums) / len(nums) if nums else None

    filled = 0
    for r in candidates:
        raw = analysis_by_id.get(r.get("source_run_id"))
        if not raw:
            continue
        picks = raw.get("top_performers") or []
        match = next(
            (p for p in picks if isinstance(p, dict)
             and (p.get("ticker") or "").strip().upper() == r["ticker"]),
            None,
        )
        if not match:
            continue
        intent_px = _parse_inr(match.get("entry"))
        target_px = _parse_inr(match.get("target"))
        stop_px = _parse_inr(match.get("stop_loss"))
        if not intent_px or not target_px or not stop_px:
            continue
        geometry = {
            "intent": intent_px, "target": target_px, "stop": stop_px,
            "horizon_days": int(match.get("horizon_days") or 1),
        }
        meta = r.get("meta") or {}
        new_meta = {**meta, "geometry": geometry}
        try:
            sb.table("paper_signals").update({"meta": new_meta}).eq("id", r["id"]).execute()
            filled += 1
        except Exception as e:
            print(f"  skip_attribution: backfill write failed (id={r['id']}): {str(e)[:120]}")
            continue

    print(f"  skip_attribution.backfill_geometry: filled {filled}/{len(candidates)}")
    return filled


def summarize(days: int = 90, sb=None) -> list[dict]:
    """Per-skip_reason aggregate: count, scored count, would-be win rate,
    total would-be net_pnl, avg net_pnl. Answers the headline question
    ("which gate rejected the most ultimately-profitable signals?") with
    real numbers. Prints a table and returns the same data."""
    sb = sb or _sb()
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = sb.table("paper_signals").select(
        "skip_reason,meta"
    ).eq("action", "skip").gte("evaluated_at", since).execute().data or []

    by_reason: dict[str, dict] = {}
    for r in rows:
        reason = r.get("skip_reason") or "unknown"
        b = by_reason.setdefault(reason, {"count": 0, "scored": 0, "wins": 0, "total_pnl": 0.0})
        b["count"] += 1
        retro = (r.get("meta") or {}).get("retro")
        if not retro or retro.get("net_pnl") is None:
            continue
        b["scored"] += 1
        pnl = float(retro["net_pnl"])
        b["total_pnl"] += pnl
        if pnl > 0:
            b["wins"] += 1

    out = []
    for reason, b in sorted(by_reason.items(), key=lambda kv: -kv[1]["total_pnl"]):
        win_rate = (b["wins"] / b["scored"] * 100.0) if b["scored"] else 0.0
        avg_pnl = (b["total_pnl"] / b["scored"]) if b["scored"] else 0.0
        out.append({
            "skip_reason": reason,
            "count": b["count"],
            "scored": b["scored"],
            "would_be_win_rate_pct": round(win_rate, 1),
            "total_would_be_net_pnl": round(b["total_pnl"], 2),
            "avg_would_be_net_pnl": round(avg_pnl, 2),
        })

    print(f"{'reason':<20} {'count':>6} {'scored':>7} {'win%':>7} {'total_pnl':>12} {'avg_pnl':>10}")
    for row in out:
        print(f"{row['skip_reason']:<20} {row['count']:>6} {row['scored']:>7} "
              f"{row['would_be_win_rate_pct']:>6.1f}% {row['total_would_be_net_pnl']:>12.2f} "
              f"{row['avg_would_be_net_pnl']:>10.2f}")
    return out


if __name__ == "__main__":
    backfill_geometry()
    score_skips(days=90)
    summarize(days=90)

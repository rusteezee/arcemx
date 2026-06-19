"""Phase A paper trader.

Reads Stock Analyst output, applies a research-backed gate stack, and
simulates entries / exits with realistic Indian-market friction. Every
evaluation is logged to paper_signals (skip reason or trade id). Every
opened position is logged to paper_trades. mark_to_market walks open
trades daily, closing at target/stop/horizon and computing net P&L
after slippage + STT + brokerage + GST.

No real money. No broker calls. Pure simulation. Phase B introduces
a sibling live_trader module once the edge gate clears.

Two-step daily cycle (called by daily_grader after grade pass):
  1. mark_to_market() — close open trades that hit target/stop/horizon
  2. eval_signals()   — apply gate stack to new stock_analyses rows

Order matters: mark before eval so a newly-closed slot frees up sector
cap / total open count before the next batch of signals is evaluated.

Research priors built in:
- PolyBench: discard signals below confidence 60 (model meta-cognition
  shown to be sharper above that floor in 2026 SOTA benchmarks)
- Friction (Indian retail): largecap spread ~5 bps, mid ~12, small ~25;
  sqrt market impact bounded at 150 bps so a runaway size estimate
  cannot fabricate a phantom cost
- Position size: fixed 2% portfolio risk per trade until 60+ closed
  trades exist; then half-Kelly takes over (separate commit, deferred
  until paper history is real)
- Edge floor: 1.5% expected_edge_pct, calibrated to round-trip friction
  (spread + STT + GST + brokerage ~= 0.5-1.0% per round trip; need a
  comfortable cushion above that for the trade to be net-positive)
"""
from __future__ import annotations

import argparse
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()


# ---------------------------------------------------------------------------
# Constants. All edit-here knobs live at the top so the next iterate
# cycle (per the never-give-up doctrine) can tighten/loosen them in
# one commit, not search-and-replace across the file.
# ---------------------------------------------------------------------------
PORTFOLIO_BASE_FALLBACK = 65_000  # used only when portfolio table lookup fails
RISK_PER_TRADE = 0.02            # 2% portfolio risk per single trade
MAX_NOTIONAL_PCT = 0.05          # 5% portfolio cap on any single trade's notional
MIN_CONF = 60                    # PolyBench discard floor
MIN_EDGE_PCT = 1.5               # round-trip friction safety cushion
SECTOR_CAP = 2                   # max concurrent open trades in same sector
LIQUIDITY_MIN_CR = 1.0           # avg 20d turnover >= 1 cr
BROKERAGE_FLAT = 5.0             # INDstocks flat per order
STT_DELIVERY_SELL = 0.001        # 0.1% on sell side delivery
EXCHANGE_TXN = 0.0000345         # NSE per-side charge
SEBI_TXN = 0.000001              # SEBI turnover fee per side
GST_RATE = 0.18                  # 18% on (brokerage + exchange)
SPREAD_BPS = {"large": 5, "mid": 12, "small": 25}  # half-spread per cap tier
IMPACT_COEF = 50                 # sqrt-impact coefficient (bps)
IMPACT_CAP_BPS = 150             # bound runaway impact estimate
TICKER_FREEZE_LOSSES = 3         # >= N losses in lookback => freeze ticker
TICKER_FREEZE_LOOKBACK_DAYS = 90 # lookback window for loss count
TICKER_FREEZE_DURATION_DAYS = 30 # how long the freeze lasts after the trigger
OUTLOOK_MIN_CONF = 65            # higher floor for 1d outlook entries (less confirmation than Stock Analyst)
OUTLOOK_MIN_EDGE_PCT = 1.0       # outlooks have tighter horizons so the friction cushion is smaller
CALIBRATION_LOOKBACK_DAYS = 90   # window over which per-dim confidence bias is measured
CALIBRATION_MIN_PAIRS = 8        # below this, ignore the dim's bias (too noisy)


def _sb():
    return create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))


def _resolve_portfolio_base(sb) -> float:
    """Read the user's live portfolio cost basis as the working capital
    denominator. Replaces the old hardcoded 65000 so position sizing
    tracks the actual portfolio as it grows / shrinks via INDmoney
    syncs. Cost basis (qty * avg_buy_price) is used rather than mark-
    to-market because (a) it avoids a price fetch per ticker on every
    eval and (b) the trader's RISK budget is naturally denominated in
    deployed capital, not unrealised P&L. Falls back to the constant
    on any failure so a missing portfolio row never breaks an eval.

    Resolves user_id from DEFAULT_USER_ID env (matches the dashboard
    pattern at web/lib/supabase.ts). INDmoney sync writes rows under
    the user's Telegram chat id, not 'default'; the env var holds
    that id so server-side reads stay consistent with the browser.
    Falls back to reading every row regardless of user_id when the
    env is unset so a fresh-install never silently fails."""
    user_id = os.getenv("DEFAULT_USER_ID") or os.getenv("NEXT_PUBLIC_DEFAULT_USER_ID")
    try:
        q = sb.table("portfolio").select("qty,avg_buy_price")
        if user_id:
            q = q.eq("user_id", user_id)
        rows = q.execute().data or []
        invested = 0.0
        for r in rows:
            q = r.get("qty")
            p = r.get("avg_buy_price")
            if q is None or p is None:
                continue
            try:
                invested += float(q) * float(p)
            except (TypeError, ValueError):
                continue
        if invested > 0:
            return float(invested)
    except Exception as e:
        print(f"  _resolve_portfolio_base fallback ({str(e)[:80]})")
    return float(PORTFOLIO_BASE_FALLBACK)


def _dim_confidence_bias(sb, dim: str) -> float:
    """Per-dim overconfidence gap learnt from calibration_log.

    Returns stated_mean - realized_mean over the last
    CALIBRATION_LOOKBACK_DAYS for the given dimension. Positive bias =
    model has been historically overconfident on this dim (stated 70
    when realized was 55, returns +15). Caller subtracts the bias from
    raw confidence to get the calibrated effective_conf for the gate.

    Returns 0.0 (no adjustment) when fewer than CALIBRATION_MIN_PAIRS
    rows exist for the dim — the bias estimate would be too noisy to
    act on. This closes the never-give-up loop: dim that overclaims
    self-corrects via the gate, dim that underclaims gets a free pass."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(days=CALIBRATION_LOOKBACK_DAYS)).isoformat()
        rows = sb.table("calibration_log").select(
            "stated_confidence,realized_score"
        ).eq("dimension", dim).gte("graded_at", since).execute().data or []
        if len(rows) < CALIBRATION_MIN_PAIRS:
            return 0.0
        stated = [float(r["stated_confidence"]) for r in rows
                  if r.get("stated_confidence") is not None]
        realized = [float(r["realized_score"]) for r in rows
                    if r.get("realized_score") is not None]
        if not stated or not realized:
            return 0.0
        gap = sum(stated) / len(stated) - sum(realized) / len(realized)
        # Clamp to [-25, 25] so a single quirky window cannot fully
        # zero out the gate. The doctrine says iterate, not nuke.
        return max(-25.0, min(25.0, gap))
    except Exception:
        return 0.0


def _ticker_is_frozen(sb, ticker: str, now: datetime) -> tuple[bool, dict]:
    """Per-ticker risk gate: if a ticker has accumulated >= N losses in
    the last lookback window, freeze it from new entries for the freeze
    duration after the most recent loss. Phase C risk gate brought
    forward to Phase A because it costs nothing to enforce now and
    surfaces serial-losers as a separate skip reason from low_conf /
    low_edge / sector_cap. Returns (frozen?, meta_dict)."""
    try:
        since = (now - timedelta(days=TICKER_FREEZE_LOOKBACK_DAYS)).isoformat()
        rows = sb.table("paper_trades").select(
            "id,exit_at,net_pnl,status"
        ).eq("ticker", ticker).like(
            "status", "closed_%"
        ).gte("exit_at", since).execute().data or []
        losses = [r for r in rows
                  if (r.get("net_pnl") or 0) < 0 and r.get("exit_at")]
        if len(losses) < TICKER_FREEZE_LOSSES:
            return False, {"loss_count_90d": len(losses)}
        latest_loss_at = max(losses, key=lambda r: r["exit_at"])["exit_at"]
        try:
            ll_dt = datetime.fromisoformat(str(latest_loss_at).replace("Z", "+00:00"))
        except Exception:
            return False, {"loss_count_90d": len(losses), "parse_failed": True}
        freeze_until = ll_dt + timedelta(days=TICKER_FREEZE_DURATION_DAYS)
        if now < freeze_until:
            return True, {
                "loss_count_90d": len(losses),
                "latest_loss_at": latest_loss_at,
                "freeze_until": freeze_until.isoformat(),
            }
        return False, {"loss_count_90d": len(losses), "freeze_expired": True}
    except Exception:
        return False, {}


# ---------------------------------------------------------------------------
# Cap tier + friction primitives
# ---------------------------------------------------------------------------
def _cap_tier(market_cap_inr) -> str:
    """Coarse cap-tier classification by INR market cap.
    Thresholds aligned to common Indian retail conventions:
      large  >= 1L cr  (>= 1e12)
      mid    >= 20k cr (>= 2e11)  — note: 1L cr is ₹1,00,000 cr = 1e12
      small  everything else
    Unknown cap defaults to small (conservative — widest spread / highest
    impact assumption, kills bad signals at the gate not at the fill)."""
    if not isinstance(market_cap_inr, (int, float)) or market_cap_inr <= 0:
        return "small"
    if market_cap_inr >= 1e12:
        return "large"
    if market_cap_inr >= 2e11:
        return "mid"
    return "small"


def _apply_slippage(
    reference_px: float,
    qty: int,
    action: str,        # "buy" or "sell"
    cap_tier: str,
    avg_turnover_inr: float,
) -> tuple[float, float]:
    """Return (adverse_fill_px, slippage_cost_inr).

    Models spread half + sqrt market impact. Buy fills above reference;
    sell fills below. Slippage cost is the per-share adverse-direction
    cost times qty, always positive. The sqrt impact is bounded at
    IMPACT_CAP_BPS so a runaway turnover/0-divide cannot fabricate a
    massive cost."""
    if reference_px <= 0 or qty <= 0:
        return float(reference_px), 0.0
    spread_half = reference_px * SPREAD_BPS.get(cap_tier, SPREAD_BPS["small"]) / 20_000
    notional = qty * reference_px
    ratio = max(0.0, notional / max(1.0, avg_turnover_inr))
    impact_bps = min(IMPACT_CAP_BPS, IMPACT_COEF * math.sqrt(ratio))
    impact = reference_px * impact_bps / 10_000
    if action == "buy":
        fill = reference_px + spread_half + impact
    else:
        fill = reference_px - spread_half - impact
    slippage = abs(fill - reference_px) * qty
    return float(fill), float(slippage)


def _broker_friction(notional_inr: float, action: str) -> tuple[float, float]:
    """Return (total_friction_inr, stt_component_inr). action: 'buy'/'sell'.
    Buy side has zero STT for delivery; sell side has 0.1% delivery STT.
    GST is on brokerage + exchange charges, not on STT/SEBI fees."""
    brokerage = BROKERAGE_FLAT
    exch = notional_inr * EXCHANGE_TXN
    sebi = notional_inr * SEBI_TXN
    stt = notional_inr * STT_DELIVERY_SELL if action == "sell" else 0.0
    gst = (brokerage + exch) * GST_RATE
    total = brokerage + exch + sebi + stt + gst
    return float(total), float(stt)


# ---------------------------------------------------------------------------
# yfinance helpers (always threaded-safe with timeout via yfinance global)
# ---------------------------------------------------------------------------
def _yf_avg_turnover(ticker: str, days: int = 20) -> float | None:
    """Rolling-20-session average turnover (qty * close) in INR."""
    try:
        h = yf.download(
            ticker,
            period=f"{days + 8}d",
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
        if h is None or h.empty or "Volume" not in h or "Close" not in h:
            return None
        h = h.tail(days)
        turnover_series = (h["Volume"] * h["Close"]).dropna()
        if turnover_series.empty:
            return None
        return float(turnover_series.mean())
    except Exception:
        return None


def _yf_next_open(ticker: str, after: datetime) -> float | None:
    """First open price strictly after `after` (date in IST tz)."""
    try:
        start = after.date()
        end = start + timedelta(days=10)
        h = yf.download(
            ticker,
            start=start.isoformat(),
            end=end.isoformat(),
            interval="1d",
            auto_adjust=False,
            progress=False,
            threads=False,
        )
        if h is None or h.empty or "Open" not in h:
            return None
        for ts, row in h.iterrows():
            if ts.date() > start:
                v = row["Open"]
                if v == v and v > 0:
                    return float(v)
        return None
    except Exception:
        return None


def _yf_history_after(ticker: str, since: datetime, until: datetime):
    """Daily OHLC bars in (since.date, until.date] used to walk an open
    paper position forward looking for stop / target / horizon hit."""
    try:
        h = yf.download(
            ticker,
            start=since.date().isoformat(),
            end=(until.date() + timedelta(days=2)).isoformat(),
            interval="1d",
            auto_adjust=False,
            progress=False,
            threads=False,
        )
        if h is None or h.empty:
            return None
        return h
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Portfolio state probes used by the gate stack
# ---------------------------------------------------------------------------
def _has_open_position(sb, ticker: str) -> bool:
    r = sb.table("paper_trades").select("id").eq("ticker", ticker).eq(
        "status", "open"
    ).limit(1).execute()
    return bool(r.data)


def _open_in_sector(sb, sector: str | None) -> int:
    if not sector:
        return 0
    r = sb.table("paper_trades").select("id,meta").eq("status", "open").execute()
    rows = r.data or []
    return sum(1 for x in rows if ((x.get("meta") or {}).get("sector")) == sector)


def _ticker_sector_and_cap(sb, ticker: str) -> tuple[str | None, str]:
    """Read sector + cap tier from ticker_enrichment cache. Falls back
    to (None, 'small') when the cache row is missing; the conservative
    cap_tier widens the modeled friction so a missing cache does not
    silently under-estimate slippage."""
    try:
        r = sb.table("ticker_enrichment").select("payload").eq(
            "ticker", ticker
        ).limit(1).execute()
        if r.data:
            payload = (r.data[0] or {}).get("payload") or {}
            fund = payload.get("fundamentals") or {}
            sector = fund.get("sector")
            mc = fund.get("market_cap")
            return sector, _cap_tier(mc)
    except Exception:
        pass
    return None, "small"


# ---------------------------------------------------------------------------
# Signal evaluation: stock_analyses -> paper_signals (+ paper_trades on enter)
# ---------------------------------------------------------------------------
def _log_signal(sb, ticker: str, sa_id: int, action: str,
                skip_reason: str | None = None,
                paper_trade_id: int | None = None,
                confidence=None, edge=None, meta: dict | None = None,
                source_kind: str = "stock_analyst"):
    """Upsert one paper_signals row. Unique (source, run_id, ticker)
    handles same-day re-runs of the eval cleanly. source_kind defaults
    to 'stock_analyst' so existing callers stay unchanged; outlook
    evaluators pass 'holding_outlook_1d' or 'wishlist_outlook_1d'
    explicitly so the skip-reason histogram is per-source."""
    row = {
        "ticker": ticker,
        "source_kind": source_kind,
        "source_run_id": sa_id,
        "action": action,
        "skip_reason": skip_reason,
        "paper_trade_id": paper_trade_id,
        "meta": meta,
    }
    if isinstance(confidence, (int, float)):
        row["confidence"] = int(confidence)
    if isinstance(edge, (int, float)):
        row["expected_edge_pct"] = float(edge)
    try:
        sb.table("paper_signals").upsert(
            row, on_conflict="source_kind,source_run_id,ticker"
        ).execute()
    except Exception as e:
        print(f"  paper_signals upsert skip ({ticker}): {str(e)[:120]}")


def _evaluate_one(sb, analysis_row: dict, now: datetime,
                  portfolio_base: float | None = None) -> str:
    """Apply gate stack to one stock_analyses row. Returns action or
    skip_reason string for logging. ALWAYS writes a paper_signals row
    so the skipped-winner attribution is computable later."""
    sa_id = analysis_row["id"]
    ticker = analysis_row["ticker"]
    j = analysis_row.get("llm_json") or {}
    rating = j.get("rating")
    confidence = j.get("confidence")
    edge = j.get("expected_edge_pct")
    horizon = int(analysis_row.get("horizon_days") or j.get("horizon_days") or 30)
    if portfolio_base is None:
        portfolio_base = _resolve_portfolio_base(sb)

    # Idempotency: skip if (source, ticker) already evaluated this run.
    existing = sb.table("paper_signals").select("id").eq(
        "source_kind", "stock_analyst"
    ).eq("source_run_id", sa_id).eq("ticker", ticker).limit(1).execute()
    if existing.data:
        return "already_evaluated"

    # Pre-schema attribution: Stock Analyst runs that predate the edge
    # decomposition commit (f406518) have edge=None. Distinguish that
    # from a fresh run that scored real-but-low edge so the skip reason
    # histogram on /trade does not lump them together. pre_schema rows
    # cannot be re-graded; they are just legacy data.
    edge_present = isinstance(edge, (int, float))

    # Gate stack (ordered cheapest-first so we do the yfinance hit only
    # when the JSON-only gates pass).
    if rating != "buy":
        _log_signal(sb, ticker, sa_id, "skip", "not_buy", confidence=confidence, edge=edge)
        return "not_buy"
    if not edge_present:
        _log_signal(sb, ticker, sa_id, "skip", "pre_schema", confidence=confidence, edge=edge)
        return "pre_schema"
    if not isinstance(confidence, (int, float)) or confidence < MIN_CONF:
        _log_signal(sb, ticker, sa_id, "skip", "low_conf", confidence=confidence, edge=edge)
        return "low_conf"
    if edge < MIN_EDGE_PCT:
        _log_signal(sb, ticker, sa_id, "skip", "low_edge", confidence=confidence, edge=edge)
        return "low_edge"
    if _has_open_position(sb, ticker):
        _log_signal(sb, ticker, sa_id, "skip", "already_open", confidence=confidence, edge=edge)
        return "already_open"
    frozen, freeze_meta = _ticker_is_frozen(sb, ticker, now)
    if frozen:
        _log_signal(sb, ticker, sa_id, "skip", "ticker_freeze",
                    confidence=confidence, edge=edge, meta=freeze_meta)
        return "ticker_freeze"

    bw = j.get("buy_window") or {}
    lo = bw.get("target_price_low")
    hi = bw.get("target_price_high")
    intent_px = ((lo or 0) + (hi or 0)) / 2 if lo and hi else None
    if not intent_px or intent_px <= 0:
        _log_signal(sb, ticker, sa_id, "skip", "no_intent_px", confidence=confidence, edge=edge)
        return "no_intent_px"

    ew = j.get("exit_window") or {}
    target_px = ew.get("target_price")
    stop_px = ew.get("stop_loss")
    if not target_px or not stop_px or target_px <= 0 or stop_px <= 0:
        _log_signal(sb, ticker, sa_id, "skip", "no_target_stop", confidence=confidence, edge=edge)
        return "no_target_stop"

    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        _log_signal(sb, ticker, sa_id, "skip", "bad_risk", confidence=confidence, edge=edge)
        return "bad_risk"

    avg_turnover = _yf_avg_turnover(ticker)
    if avg_turnover is None:
        _log_signal(sb, ticker, sa_id, "skip", "no_liquidity_data", confidence=confidence, edge=edge)
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        _log_signal(sb, ticker, sa_id, "skip", "liquidity",
                    confidence=confidence, edge=edge,
                    meta={"avg_turnover_inr": avg_turnover})
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and _open_in_sector(sb, sector) >= SECTOR_CAP:
        _log_signal(sb, ticker, sa_id, "skip", "sector_cap",
                    confidence=confidence, edge=edge,
                    meta={"sector": sector})
        return "sector_cap"

    # Position sizing: 2% portfolio risk, capped at 5% notional.
    # portfolio_base flows in from eval_signals so a single lookup
    # serves the whole pass (avoids one Supabase hit per signal).
    risk_budget = portfolio_base * RISK_PER_TRADE
    qty_by_risk = int(risk_budget / risk_per_share)
    qty_by_notional_cap = int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)
    qty = max(1, min(qty_by_risk, qty_by_notional_cap))

    # Fill simulation: anchor on next-session open, add buy-side slippage.
    requested_at = analysis_row.get("requested_at") or now.isoformat()
    try:
        ra_dt = datetime.fromisoformat(requested_at.replace("Z", "+00:00"))
    except Exception:
        ra_dt = now
    next_open = _yf_next_open(ticker, ra_dt)
    anchor = next_open if next_open else intent_px
    fill_px, slippage_cost = _apply_slippage(anchor, qty, "buy", cap_tier, avg_turnover)
    buy_friction, _ = _broker_friction(fill_px * qty, "buy")

    # Insert paper trade. paper_signals enter row links back via FK.
    try:
        t_res = sb.table("paper_trades").insert({
            "source_kind": "stock_analyst",
            "source_run_id": sa_id,
            "ticker": ticker,
            "side": "long",
            "entered_at": now.isoformat(),
            "intent_px": float(intent_px),
            "fill_px": float(fill_px),
            "qty": int(qty),
            "target_px": float(target_px),
            "stop_px": float(stop_px),
            "horizon_days": horizon,
            "brokerage": float(buy_friction),
            "stt": 0.0,
            "slippage_cost": float(slippage_cost),
            "confidence": int(confidence),
            "expected_edge_pct": float(edge),
            "status": "open",
            "meta": {
                "sector": sector,
                "cap_tier": cap_tier,
                "avg_turnover_inr": avg_turnover,
                "next_open_anchor": next_open,
                "intent_px_mid": intent_px,
                "risk_per_share": risk_per_share,
            },
        }).execute()
        trade_id = (t_res.data or [{}])[0].get("id") if t_res.data else None
    except Exception as e:
        print(f"  paper_trades insert failed ({ticker}): {str(e)[:200]}")
        _log_signal(sb, ticker, sa_id, "skip", "insert_failed", confidence=confidence, edge=edge)
        return "insert_failed"

    _log_signal(sb, ticker, sa_id, "enter",
                paper_trade_id=trade_id,
                confidence=confidence, edge=edge,
                meta={"sector": sector, "cap_tier": cap_tier})
    return "enter"


def eval_signals(now: datetime | None = None) -> dict:
    """Pull recently-graded stock_analyses (status=ok) AND today's
    morning analysis outlook signals (holding_outlooks_1d +
    wishlist_outlooks_1d), then evaluate each through the gate stack.
    Window is the last 3 days of requested_at / run_at so a late
    grade still gets evaluated once. Idempotent via paper_signals
    (source, run_id, ticker) unique constraint.

    Two signal sources, evaluated in this order:
      1. stock_analyst (deep, multi-day horizon, has buy_window/target/stop)
      2. holding_outlook_1d / wishlist_outlook_1d (intraday, 1d horizon,
         derive synthetic target/stop from outlook.range)

    Stock Analyst signals get priority because they carry explicit
    target/stop levels the model committed to. Outlook signals are
    secondary because they synthesize entry geometry from the range
    band; they fire when stock_analyst hasn't been triggered for the
    ticker recently."""
    sb = _sb()
    now = now or datetime.now(timezone.utc)
    portfolio_base = _resolve_portfolio_base(sb)
    print(f"paper_trader: portfolio_base resolved = {portfolio_base:.0f}")

    counts = {"evaluated": 0, "entered": 0}
    skips: dict[str, int] = {}

    # Source 1: Stock Analyst
    since = (now - timedelta(days=3)).isoformat()
    sa_rows = sb.table("stock_analyses").select(
        "id,ticker,horizon_days,requested_at,llm_json,status"
    ).gte("requested_at", since).eq("status", "ok").execute().data or []
    for r in sa_rows:
        counts["evaluated"] += 1
        outcome = _evaluate_one(sb, r, now, portfolio_base=portfolio_base)
        if outcome == "enter":
            counts["entered"] += 1
        elif outcome == "already_evaluated":
            pass
        else:
            skips[outcome] = skips.get(outcome, 0) + 1

    # Source 2: Morning analysis outlook signals + top_performers
    a_rows = sb.table("analysis").select(
        "id,run_at,raw_json"
    ).gte("run_at", since).order("run_at", desc=True).limit(5).execute().data or []
    for a in a_rows:
        raw = a.get("raw_json") or {}
        for source_kind, key in (("holding_outlook_1d", "holding_outlooks_1d"),
                                 ("wishlist_outlook_1d", "wishlist_outlooks_1d")):
            for outlook in (raw.get(key) or []):
                counts["evaluated"] += 1
                outcome = _evaluate_outlook(sb, a, outlook, source_kind, now,
                                           portfolio_base=portfolio_base)
                if outcome == "enter":
                    counts["entered"] += 1
                elif outcome == "already_evaluated":
                    pass
                else:
                    skips[outcome] = skips.get(outcome, 0) + 1
        # top_performers: the model's INDEPENDENT market-wide long picks.
        # This is the source that breaks the portfolio/wishlist tunnel
        # vision — names here are chosen from the whole NSE universe, not
        # the user's existing exposure.
        for tp in (raw.get("top_performers") or []):
            counts["evaluated"] += 1
            outcome = _evaluate_top_performer(sb, a, tp, now,
                                              portfolio_base=portfolio_base)
            if outcome == "enter":
                counts["entered"] += 1
            elif outcome == "already_evaluated":
                pass
            else:
                skips[outcome] = skips.get(outcome, 0) + 1

    counts["skips"] = skips
    print(f"paper_trader.eval_signals: {counts}")
    return counts


def _evaluate_top_performer(sb, analysis_row: dict, tp: dict, now: datetime,
                            portfolio_base: float) -> str:
    """Gate-stack a single top_performers entry. Unlike outlook signals
    (which synthesize geometry from a range band), top_performers carry
    the model's explicit entry / target / stop_loss + a pre-computed
    expected_edge_pct, so this evaluator trusts those directly and runs
    the same gate order as the Stock Analyst path. source_kind is
    'top_performer' so the per-source breakdown isolates the engine's
    independent picks from holdings/wishlist exposure."""
    a_id = analysis_row["id"]
    raw_ticker = (tp.get("ticker") or "").strip().upper()
    if not raw_ticker:
        return "no_ticker"
    if not raw_ticker.endswith(".NS") and not raw_ticker.endswith(".BO") \
            and not raw_ticker.startswith("^"):
        ticker = raw_ticker + ".NS"
    else:
        ticker = raw_ticker

    def L(action, skip_reason=None, paper_trade_id=None, edge=None, meta=None):
        _log_signal(sb, ticker, a_id, action, skip_reason=skip_reason,
                    paper_trade_id=paper_trade_id, confidence=_conf_from_winprob(tp),
                    edge=edge, meta=meta, source_kind="top_performer")

    existing = sb.table("paper_signals").select("id").eq(
        "source_kind", "top_performer"
    ).eq("source_run_id", a_id).eq("ticker", ticker).limit(1).execute()
    if existing.data:
        return "already_evaluated"

    conf = _conf_from_winprob(tp)
    edge = tp.get("expected_edge_pct")
    if not isinstance(edge, (int, float)):
        L("skip", "pre_schema")
        return "pre_schema"
    if conf < MIN_CONF:
        L("skip", "low_conf", edge=edge)
        return "low_conf"
    if edge < MIN_EDGE_PCT:
        L("skip", "low_edge", edge=edge)
        return "low_edge"

    intent_px = _parse_inr(tp.get("entry"))
    target_px = _parse_inr(tp.get("target"))
    stop_px = _parse_inr(tp.get("stop_loss"))
    if not intent_px or intent_px <= 0:
        L("skip", "no_intent_px", edge=edge)
        return "no_intent_px"
    if not target_px or not stop_px or target_px <= 0 or stop_px <= 0:
        L("skip", "no_target_stop", edge=edge)
        return "no_target_stop"
    if _has_open_position(sb, ticker):
        L("skip", "already_open", edge=edge)
        return "already_open"
    frozen, freeze_meta = _ticker_is_frozen(sb, ticker, now)
    if frozen:
        L("skip", "ticker_freeze", edge=edge, meta=freeze_meta)
        return "ticker_freeze"

    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        L("skip", "bad_risk", edge=edge)
        return "bad_risk"

    avg_turnover = _yf_avg_turnover(ticker)
    if avg_turnover is None:
        L("skip", "no_liquidity_data", edge=edge)
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        L("skip", "liquidity", edge=edge, meta={"avg_turnover_inr": avg_turnover})
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and _open_in_sector(sb, sector) >= SECTOR_CAP:
        L("skip", "sector_cap", edge=edge, meta={"sector": sector})
        return "sector_cap"

    risk_budget = portfolio_base * RISK_PER_TRADE
    qty = max(1, min(int(risk_budget / risk_per_share),
                     int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)))
    horizon = int(tp.get("horizon_days") or 1)

    run_at = analysis_row.get("run_at") or now.isoformat()
    try:
        ra_dt = datetime.fromisoformat(str(run_at).replace("Z", "+00:00"))
    except Exception:
        ra_dt = now
    next_open = _yf_next_open(ticker, ra_dt)
    anchor = next_open if next_open else intent_px
    fill_px, slippage_cost = _apply_slippage(anchor, qty, "buy", cap_tier, avg_turnover)
    buy_friction, _ = _broker_friction(fill_px * qty, "buy")

    try:
        t_res = sb.table("paper_trades").insert({
            "source_kind": "top_performer",
            "source_run_id": a_id,
            "ticker": ticker,
            "side": "long",
            "entered_at": now.isoformat(),
            "intent_px": float(intent_px),
            "fill_px": float(fill_px),
            "qty": int(qty),
            "target_px": float(target_px),
            "stop_px": float(stop_px),
            "horizon_days": horizon,
            "brokerage": float(buy_friction),
            "stt": 0.0,
            "slippage_cost": float(slippage_cost),
            "confidence": int(conf),
            "expected_edge_pct": float(edge),
            "status": "open",
            "meta": {
                "sector": sector, "cap_tier": cap_tier,
                "avg_turnover_inr": avg_turnover, "next_open_anchor": next_open,
                "conviction": (tp.get("conviction") or "").upper(),
                "expected_move_pct": tp.get("expected_move_pct"),
                "thesis": (tp.get("thesis") or "")[:200],
            },
        }).execute()
        trade_id = (t_res.data or [{}])[0].get("id") if t_res.data else None
    except Exception as e:
        print(f"  top_performer insert failed ({ticker}): {str(e)[:200]}")
        L("skip", "insert_failed", edge=edge)
        return "insert_failed"

    L("enter", paper_trade_id=trade_id, edge=edge,
      meta={"sector": sector, "conviction": (tp.get("conviction") or "").upper()})
    return "enter"


# ---------------------------------------------------------------------------
# Outlook signal evaluator (B5): holding_outlooks_1d + wishlist_outlooks_1d
# ---------------------------------------------------------------------------
def _conf_from_winprob(entry: dict) -> float:
    """Resolve a 0-100 confidence for a top_performer entry. Prefer an
    explicit confidence field; else derive from win_prob (0-1 -> 0-100);
    else 0 so the conf gate rejects an unscored entry rather than
    fabricating a number."""
    c = entry.get("confidence")
    if isinstance(c, (int, float)) and c > 1:
        return float(c)
    wp = entry.get("win_prob")
    if isinstance(wp, (int, float)):
        return float(wp) * 100.0
    return 0.0


def _parse_inr(v) -> float | None:
    """Parse a numeric INR value from a model string like '₹1,280' or
    '1280-1300' (takes the midpoint of a range) or a bare number.
    Returns None when nothing numeric is present."""
    if isinstance(v, (int, float)):
        return float(v) if v > 0 else None
    if not isinstance(v, str):
        return None
    cleaned = v.replace("₹", "").replace(",", "").strip()
    if not cleaned:
        return None
    parts = [p.strip() for p in cleaned.replace("to", "-").split("-") if p.strip()]
    nums: list[float] = []
    for p in parts:
        try:
            nums.append(float(p))
        except ValueError:
            continue
    if not nums:
        return None
    return sum(nums) / len(nums)


def _parse_range_band(s) -> tuple[float, float] | None:
    """Parse a tight INR band string like '320-330' or '₹320 - ₹330' into
    (lo, hi) floats. Returns None on any failure. The morning prompt
    forces this format so the parse is lenient on whitespace + ₹ but
    strict on the two-number shape."""
    if not isinstance(s, str):
        return None
    cleaned = s.replace("₹", "").replace(",", "").strip()
    parts = [p.strip() for p in cleaned.replace("to", "-").split("-") if p.strip()]
    if len(parts) != 2:
        return None
    try:
        lo, hi = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if lo <= 0 or hi <= 0 or lo >= hi:
        return None
    return lo, hi


def _evaluate_outlook(sb, analysis_row: dict, outlook: dict,
                      source_kind: str, now: datetime,
                      portfolio_base: float) -> str:
    """Gate-stack a single outlook entry. outlook carries direction +
    range + confidence + key_driver. Target/stop synthesized from the
    range band: long entry at mid, target = upper of range, stop = lower.
    The per-dim calibration bias for the relevant calibration_log dim
    is subtracted from raw confidence before the conf gate fires, so a
    dim that historically overclaims confidence self-tightens the gate."""
    a_id = analysis_row["id"]
    raw_ticker = (outlook.get("ticker") or "").strip().upper()
    if not raw_ticker:
        return "no_ticker"
    if not raw_ticker.endswith(".NS") and not raw_ticker.endswith(".BO") \
            and not raw_ticker.startswith("^"):
        ticker = raw_ticker + ".NS"
    else:
        ticker = raw_ticker

    # Closure logger so every outlook skip / enter row writes the correct
    # source_kind without each call site repeating the kwarg.
    def L(action: str, skip_reason: str | None = None,
          paper_trade_id: int | None = None, edge=None, meta: dict | None = None):
        _log_signal(sb, ticker, a_id, action,
                    skip_reason=skip_reason, paper_trade_id=paper_trade_id,
                    confidence=outlook.get("confidence"), edge=edge,
                    meta=meta, source_kind=source_kind)

    # Idempotency check first so noisy re-runs don't waste CPU.
    existing = sb.table("paper_signals").select("id").eq(
        "source_kind", source_kind
    ).eq("source_run_id", a_id).eq("ticker", ticker).limit(1).execute()
    if existing.data:
        return "already_evaluated"

    direction = (outlook.get("direction") or "").lower()
    stated_conf = outlook.get("confidence")
    # Direction filter: only long entries for now. down + sideways skip.
    if direction != "up":
        L("skip", "not_buy")
        return "not_buy"

    # Per-dim confidence recalibration (A1). Pull the dim's bias from
    # calibration_log; apply only if a non-trivial gap exists.
    dim_for_calibration = (
        "holding_outlook_dir_1d" if source_kind == "holding_outlook_1d"
        else "wishlist_outlook_dir_1d"
    )
    bias = _dim_confidence_bias(sb, dim_for_calibration)
    if not isinstance(stated_conf, (int, float)):
        L("skip", "low_conf")
        return "low_conf"
    effective_conf = float(stated_conf) - bias
    if effective_conf < OUTLOOK_MIN_CONF:
        L("skip", "low_conf",
          meta={"bias": bias, "effective_conf": effective_conf})
        return "low_conf"

    band = _parse_range_band(outlook.get("range"))
    if not band:
        L("skip", "no_intent_px")
        return "no_intent_px"
    lo, hi = band
    intent_px = (lo + hi) / 2.0
    target_px = hi
    stop_px = lo
    # Synthetic edge: pure geometry off the band. Compare against the
    # outlook-specific (tighter) edge floor since 1d horizon has less
    # friction cushion than a 30d Stock Analyst trade.
    expected_return_pct = (target_px - intent_px) / intent_px * 100.0
    expected_loss_pct = (intent_px - stop_px) / intent_px * 100.0
    win_prob = max(0.0, min(1.0, effective_conf / 100.0))
    loss_prob = 1.0 - win_prob
    edge = expected_return_pct * win_prob - expected_loss_pct * loss_prob
    if edge < OUTLOOK_MIN_EDGE_PCT:
        L("skip", "low_edge", edge=edge, meta={"effective_conf": effective_conf})
        return "low_edge"

    if _has_open_position(sb, ticker):
        L("skip", "already_open", edge=edge)
        return "already_open"
    frozen, freeze_meta = _ticker_is_frozen(sb, ticker, now)
    if frozen:
        L("skip", "ticker_freeze", edge=edge, meta=freeze_meta)
        return "ticker_freeze"

    risk_per_share = abs(intent_px - stop_px)
    if risk_per_share <= 0:
        L("skip", "bad_risk", edge=edge)
        return "bad_risk"

    avg_turnover = _yf_avg_turnover(ticker)
    if avg_turnover is None:
        L("skip", "no_liquidity_data", edge=edge)
        return "no_liquidity_data"
    if (avg_turnover / 1e7) < LIQUIDITY_MIN_CR:
        L("skip", "liquidity", edge=edge,
          meta={"avg_turnover_inr": avg_turnover})
        return "liquidity"

    sector, cap_tier = _ticker_sector_and_cap(sb, ticker)
    if sector and _open_in_sector(sb, sector) >= SECTOR_CAP:
        L("skip", "sector_cap", edge=edge, meta={"sector": sector})
        return "sector_cap"

    risk_budget = portfolio_base * RISK_PER_TRADE
    qty_by_risk = int(risk_budget / risk_per_share)
    qty_by_notional_cap = int((portfolio_base * MAX_NOTIONAL_PCT) / intent_px)
    qty = max(1, min(qty_by_risk, qty_by_notional_cap))

    run_at = analysis_row.get("run_at") or now.isoformat()
    try:
        ra_dt = datetime.fromisoformat(str(run_at).replace("Z", "+00:00"))
    except Exception:
        ra_dt = now
    next_open = _yf_next_open(ticker, ra_dt)
    anchor = next_open if next_open else intent_px
    fill_px, slippage_cost = _apply_slippage(anchor, qty, "buy", cap_tier, avg_turnover)
    buy_friction, _ = _broker_friction(fill_px * qty, "buy")

    try:
        t_res = sb.table("paper_trades").insert({
            "source_kind": source_kind,
            "source_run_id": a_id,
            "ticker": ticker,
            "side": "long",
            "entered_at": now.isoformat(),
            "intent_px": float(intent_px),
            "fill_px": float(fill_px),
            "qty": int(qty),
            "target_px": float(target_px),
            "stop_px": float(stop_px),
            "horizon_days": 1,
            "brokerage": float(buy_friction),
            "stt": 0.0,
            "slippage_cost": float(slippage_cost),
            "confidence": int(stated_conf),
            "expected_edge_pct": float(edge),
            "status": "open",
            "meta": {
                "sector": sector,
                "cap_tier": cap_tier,
                "avg_turnover_inr": avg_turnover,
                "next_open_anchor": next_open,
                "calibration_bias_applied": bias,
                "effective_conf": effective_conf,
                "key_driver": outlook.get("key_driver"),
            },
        }).execute()
        trade_id = (t_res.data or [{}])[0].get("id") if t_res.data else None
    except Exception as e:
        print(f"  paper_trades insert failed ({ticker}, {source_kind}): {str(e)[:200]}")
        L("skip", "insert_failed", edge=edge)
        return "insert_failed"

    L("enter", paper_trade_id=trade_id, edge=edge,
      meta={"sector": sector, "calibration_bias_applied": bias})
    return "enter"


# ---------------------------------------------------------------------------
# Mark-to-market: walk open trades, close at target/stop/horizon
# ---------------------------------------------------------------------------
def _close_trade(
    sb,
    t_row: dict,
    exit_at: datetime,
    exit_ref_px: float,
    exit_reason: str,
) -> None:
    """Apply sell-side slippage + STT + brokerage to compute the realised
    fill, then write the close-out row update. Buy-side slippage + buy
    brokerage are already booked at entry; this only adds the sell-side
    components and updates net_pnl."""
    qty = int(t_row["qty"])
    fill_px = float(t_row["fill_px"])
    cap_tier = (t_row.get("meta") or {}).get("cap_tier", "small")
    avg_turnover = (t_row.get("meta") or {}).get("avg_turnover_inr") or 1e8

    sim_exit_fill, exit_slippage = _apply_slippage(
        exit_ref_px, qty, "sell", cap_tier, float(avg_turnover)
    )
    sell_friction, stt_amt = _broker_friction(sim_exit_fill * qty, "sell")

    gross_pnl = (sim_exit_fill - fill_px) * qty
    buy_friction = float(t_row.get("brokerage") or BROKERAGE_FLAT)
    buy_slippage = float(t_row.get("slippage_cost") or 0.0)
    net_pnl = gross_pnl - (buy_friction + sell_friction) - (buy_slippage + exit_slippage)

    sb.table("paper_trades").update({
        "exit_at": exit_at.isoformat(),
        "exit_px": float(sim_exit_fill),
        "exit_reason": exit_reason,
        "gross_pnl": float(gross_pnl),
        "brokerage": float(buy_friction + sell_friction),
        "stt": float(stt_amt),
        "slippage_cost": float(buy_slippage + exit_slippage),
        "net_pnl": float(net_pnl),
        "status": f"closed_{exit_reason}",
    }).eq("id", t_row["id"]).execute()


def _mark_one(sb, t_row: dict, now: datetime) -> bool:
    """Look for stop / target / horizon hit on one open trade. Returns
    True if the trade was closed in this pass."""
    entered_at = datetime.fromisoformat(
        t_row["entered_at"].replace("Z", "+00:00")
    )
    horizon_days = int(t_row.get("horizon_days") or 30)
    expiry = entered_at + timedelta(days=horizon_days)
    target_px = float(t_row["target_px"])
    stop_px = float(t_row["stop_px"])
    side = t_row["side"]
    ticker = t_row["ticker"]

    until = min(now, expiry + timedelta(days=2))
    h = _yf_history_after(ticker, entered_at, until)
    if h is None or h.empty:
        return False
    if not all(c in h.columns for c in ("High", "Low", "Close")):
        return False

    for ts, row in h.iterrows():
        bar_date = ts.date()
        if bar_date <= entered_at.date():
            continue
        high = float(row["High"])
        low = float(row["Low"])
        close = float(row["Close"])
        bar_dt = datetime.combine(bar_date, datetime.min.time()).replace(
            tzinfo=timezone.utc
        )

        if side == "long":
            # Pessimistic ordering: if both target + stop intersect the
            # same bar, assume stop fires first. Worst-case fill.
            if low <= stop_px:
                _close_trade(sb, t_row, bar_dt, stop_px, "stop")
                return True
            if high >= target_px:
                _close_trade(sb, t_row, bar_dt, target_px, "target")
                return True
        # Horizon exit: close at the close of the first session at or
        # after expiry.
        if bar_dt >= expiry:
            _close_trade(sb, t_row, bar_dt, close, "horizon")
            return True
    return False


def mark_to_market(now: datetime | None = None) -> dict:
    """Walk every status='open' paper trade and try to close it."""
    sb = _sb()
    now = now or datetime.now(timezone.utc)
    rows = sb.table("paper_trades").select("*").eq("status", "open").execute().data or []
    n_closed = 0
    for r in rows:
        try:
            if _mark_one(sb, r, now):
                n_closed += 1
        except Exception as e:
            print(f"  mark_to_market {r.get('ticker')}: {str(e)[:120]}")
    print(f"paper_trader.mark_to_market: open_walked={len(rows)}, closed={n_closed}")
    return {"open_walked": len(rows), "closed": n_closed}


# ---------------------------------------------------------------------------
# CLI entry: mark first, then eval. daily_grader invokes this with no args.
# ---------------------------------------------------------------------------
def run_daily() -> dict:
    m = mark_to_market()
    e = eval_signals()
    return {"mark_to_market": m, "eval_signals": e}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--mark", action="store_true", help="mark-to-market open trades only")
    p.add_argument("--eval", action="store_true", help="evaluate new signals only")
    args = p.parse_args()
    if args.mark and not args.eval:
        mark_to_market()
    elif args.eval and not args.mark:
        eval_signals()
    else:
        run_daily()

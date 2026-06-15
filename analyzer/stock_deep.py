"""Deep per-stock data fetcher.

Backend for the Stock Analyst feature on the Sensei page. Pulls EVERY
free yfinance endpoint we can use for a single ticker plus
multi-source news, packs them into a single dict the LLM consumes
for a deep analysis pass. Designed to also serve as the future
shared backend for holdings + wishlist daily enrichment (today's
aggregator._fetch_ticker_enrichment is a strict subset of what
deep_fetch returns).

Soft-fails per-endpoint: any one of the ~15 yfinance calls can 404,
429, or hang; deep_fetch tolerates each individually so a single
broken call (e.g. options for a thinly-traded name) never empties
the whole payload.

GH-Actions only when called at LLM-prompt-build scale. The Render
512 MB dyno can run a SINGLE deep_fetch (Telegram bot fallback) but
not a fan-out across multiple tickers.
"""
from __future__ import annotations

import gc
import threading
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf


# Per-yfinance-call timeout. Yahoo silently retries on rate limit
# with no client cap; the Phase 1 RAG backfill hung 55 min before we
# wrapped yf.download() the same way. Same hard cap here.
_YF_TIMEOUT_S = 12


def _safe_call(fn, timeout: int = _YF_TIMEOUT_S):
    """Run a zero-arg callable with a threaded timeout. Returns
    (result, error_str). The thread leaks on timeout (daemon=True
    cleans on process exit); acceptable because deep_fetch is at the
    edge of memory budget and a hung yfinance call is the bigger risk.
    """
    holder: dict = {"r": None, "e": None}

    def _do():
        try:
            holder["r"] = fn()
        except Exception as e:
            holder["e"] = str(e)[:160]

    th = threading.Thread(target=_do, daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        return None, f"timeout after {timeout}s"
    return holder["r"], holder["e"]


def _df_to_records(df, max_rows: int = 20) -> list[dict]:
    """Coerce a yfinance DataFrame to a JSON-serializable list-of-dicts.
    Trims to max_rows newest. Renames index to "period" when it carries
    a date or label. Drops NaN values so the LLM payload stays compact.
    """
    if df is None:
        return []
    try:
        if isinstance(df, pd.DataFrame):
            d = df.copy()
        else:
            return []
        if d.empty:
            return []
        # MultiIndex columns -> flat
        if isinstance(d.columns, pd.MultiIndex):
            d.columns = [c[0] if isinstance(c, tuple) else c for c in d.columns]
        # Keep at most max_rows newest by date if the index is a date-ish thing
        if isinstance(d.index, (pd.DatetimeIndex,)):
            d = d.sort_index(ascending=False).head(max_rows)
        else:
            d = d.head(max_rows)
        # Stringify index for JSON
        d.index = [str(i)[:19] if hasattr(i, "isoformat") else str(i) for i in d.index]
        d = d.reset_index().rename(columns={"index": "period"})
        # Drop rows that are entirely null on numeric cols
        out = []
        for _, row in d.iterrows():
            rec = {}
            for k, v in row.items():
                if v is None:
                    continue
                if isinstance(v, float) and (v != v):  # NaN
                    continue
                if isinstance(v, (int, float)):
                    rec[str(k)] = float(v)
                else:
                    rec[str(k)] = str(v)
            if rec:
                out.append(rec)
        return out
    except Exception:
        return []


def _technicals_from_history(hist) -> dict:
    """Compute RSI14, MACD signal, SMA20/50/200 distances, ATR14,
    52-week high/low + range position, from the OHLCV history. Same
    inputs technical.py uses; replicating here so deep_fetch is
    standalone and does not pull screen_universe weight."""
    out: dict = {}
    if hist is None or hist.empty:
        return out
    try:
        c = hist["Close"].dropna()
        if c.empty:
            return out
        last = float(c.iloc[-1])
        out["last_close"] = round(last, 2)
        if len(c) >= 15:
            delta = c.diff().dropna()
            gain = delta.clip(lower=0).tail(14).mean()
            loss = (-delta.clip(upper=0)).tail(14).mean()
            if loss > 0:
                rs = gain / loss
                out["rsi14"] = round(100 - (100 / (1 + rs)), 1)
            elif gain > 0:
                out["rsi14"] = 100.0
        for n in (20, 50, 200):
            if len(c) >= n:
                sma = float(c.tail(n).mean())
                out[f"sma{n}"] = round(sma, 2)
                if sma:
                    out[f"dist_sma{n}_pct"] = round((last - sma) / sma * 100, 2)
        # MACD 12/26/9 signal direction (sign only)
        if len(c) >= 35:
            ema12 = c.ewm(span=12, adjust=False).mean()
            ema26 = c.ewm(span=26, adjust=False).mean()
            macd = ema12 - ema26
            sig = macd.ewm(span=9, adjust=False).mean()
            out["macd"] = round(float(macd.iloc[-1]), 3)
            out["macd_signal"] = round(float(sig.iloc[-1]), 3)
            out["macd_hist"] = round(float(macd.iloc[-1] - sig.iloc[-1]), 3)
            out["macd_bullish"] = bool(macd.iloc[-1] > sig.iloc[-1])
        # ATR14
        if "High" in hist.columns and "Low" in hist.columns and len(hist) >= 15:
            high = hist["High"]; low = hist["Low"]; close_prev = c.shift()
            tr = pd.concat([
                (high - low),
                (high - close_prev).abs(),
                (low - close_prev).abs(),
            ], axis=1).max(axis=1)
            atr = float(tr.tail(14).mean())
            out["atr14"] = round(atr, 2)
            if last:
                out["atr14_pct"] = round(atr / last * 100, 2)
        # 52-week high/low + range position
        win = c.tail(252) if len(c) >= 252 else c
        hi52, lo52 = float(win.max()), float(win.min())
        out["wk52_high"] = round(hi52, 2)
        out["wk52_low"] = round(lo52, 2)
        if hi52 > lo52:
            out["wk52_range_pos_pct"] = round((last - lo52) / (hi52 - lo52) * 100, 1)
        # Trailing returns
        for n_d, key in ((5, "ret_5d_pct"), (21, "ret_21d_pct"),
                         (63, "ret_63d_pct"), (252, "ret_252d_pct")):
            if len(c) >= n_d + 1:
                prev = float(c.iloc[-(n_d + 1)])
                if prev:
                    out[key] = round((last - prev) / prev * 100, 2)
        # Volatility (annualised daily stdev)
        if len(c) >= 30:
            r = c.pct_change().dropna().tail(63)
            if len(r) >= 20:
                out["realized_vol_pct"] = round(float(r.std() * (252 ** 0.5) * 100), 2)
    except Exception as e:
        out["technicals_error"] = str(e)[:120]
    return out


def _info_summary(info: dict) -> dict:
    """Trim Ticker.info to the high-signal subset for the LLM payload.
    Same shape as aggregator._ticker_fundamentals + a few extra fields
    relevant for a deep analyst pass (officers, sector summary text)."""
    if not isinstance(info, dict):
        return {}

    def _g(k):
        v = info.get(k)
        return v if isinstance(v, (int, float)) and v == v else None

    last = _g("regularMarketPrice") or _g("currentPrice")
    target_mean = _g("targetMeanPrice")
    upside = None
    if last and target_mean and last > 0:
        upside = round((target_mean - last) / last * 100, 1)

    mcap = _g("marketCap")
    return {
        "name": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "country": info.get("country"),
        "currency": info.get("currency"),
        "summary": (info.get("longBusinessSummary") or "")[:1200],
        "website": info.get("website"),
        "employees": _g("fullTimeEmployees"),
        # Valuation
        "pe_trailing": _g("trailingPE"),
        "pe_forward": _g("forwardPE"),
        "peg": _g("pegRatio"),
        "pb": _g("priceToBook"),
        "ps": _g("priceToSalesTrailing12Months"),
        "ev_to_ebitda": _g("enterpriseToEbitda"),
        "ev_to_revenue": _g("enterpriseToRevenue"),
        "market_cap_cr": round(mcap / 1e7, 0) if mcap else None,
        "enterprise_value_cr": round(_g("enterpriseValue") / 1e7, 0) if _g("enterpriseValue") else None,
        # Profitability + margins
        "roe_pct": (_g("returnOnEquity") or 0) * 100 if _g("returnOnEquity") is not None else None,
        "roa_pct": (_g("returnOnAssets") or 0) * 100 if _g("returnOnAssets") is not None else None,
        "profit_margin_pct": (_g("profitMargins") or 0) * 100 if _g("profitMargins") is not None else None,
        "op_margin_pct": (_g("operatingMargins") or 0) * 100 if _g("operatingMargins") is not None else None,
        "gross_margin_pct": (_g("grossMargins") or 0) * 100 if _g("grossMargins") is not None else None,
        # Growth
        "revenue_growth_yoy_pct": (_g("revenueGrowth") or 0) * 100 if _g("revenueGrowth") is not None else None,
        "earnings_growth_yoy_pct": (_g("earningsGrowth") or 0) * 100 if _g("earningsGrowth") is not None else None,
        "earnings_growth_qoq_pct": (_g("earningsQuarterlyGrowth") or 0) * 100 if _g("earningsQuarterlyGrowth") is not None else None,
        # Leverage + liquidity
        "debt_to_equity": _g("debtToEquity"),
        "current_ratio": _g("currentRatio"),
        "quick_ratio": _g("quickRatio"),
        "total_cash_cr": round(_g("totalCash") / 1e7, 0) if _g("totalCash") else None,
        "total_debt_cr": round(_g("totalDebt") / 1e7, 0) if _g("totalDebt") else None,
        "free_cash_flow_cr": round(_g("freeCashflow") / 1e7, 0) if _g("freeCashflow") else None,
        # Dividend
        "dividend_yield_pct": (_g("dividendYield") or 0) * 100 if _g("dividendYield") is not None else None,
        "payout_ratio_pct": (_g("payoutRatio") or 0) * 100 if _g("payoutRatio") is not None else None,
        # Risk
        "beta": _g("beta"),
        "short_pct_float": (_g("shortPercentOfFloat") or 0) * 100 if _g("shortPercentOfFloat") is not None else None,
        # Volume
        "avg_volume_10d": _g("averageVolume10days"),
        # Holders breakdown
        "held_pct_institutions": (_g("heldPercentInstitutions") or 0) * 100 if _g("heldPercentInstitutions") is not None else None,
        "held_pct_insiders": (_g("heldPercentInsiders") or 0) * 100 if _g("heldPercentInsiders") is not None else None,
        # Analyst consensus
        "analyst_target_mean": target_mean,
        "analyst_target_low": _g("targetLowPrice"),
        "analyst_target_high": _g("targetHighPrice"),
        "analyst_upside_pct": upside,
        "analyst_recommendation": info.get("recommendationKey"),
        "analyst_recommendation_mean": _g("recommendationMean"),
        "analyst_count": _g("numberOfAnalystOpinions"),
    }


def _ticker_news(news_list) -> list[dict]:
    """Normalise yfinance Ticker.news across SDK versions. Same logic
    as aggregator._ticker_news but keeps 15 (not 5) for the deep
    payload."""
    out = []
    for item in (news_list or [])[:25]:
        if not isinstance(item, dict):
            continue
        c = item.get("content") if isinstance(item.get("content"), dict) else item
        title = c.get("title") or item.get("title")
        if not title:
            continue
        prov = c.get("provider")
        if isinstance(prov, dict):
            publisher = prov.get("displayName")
        else:
            publisher = c.get("publisher") or item.get("publisher")
        pub_raw = (c.get("pubDate") or c.get("displayTime")
                   or item.get("providerPublishTime"))
        published_at = None
        if isinstance(pub_raw, (int, float)):
            try:
                published_at = datetime.utcfromtimestamp(pub_raw).isoformat()
            except (OSError, ValueError):
                pass
        elif isinstance(pub_raw, str):
            published_at = pub_raw
        out.append({
            "title": title,
            "publisher": publisher,
            "published_at": published_at,
        })
        if len(out) >= 15:
            break
    return out


def _calendar(cal) -> dict:
    """Extract next earnings + ex-dividend dates from Ticker.calendar.
    Dict-form on newer yfinance, DataFrame on older."""
    out: dict = {}
    if cal is None:
        return out
    try:
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date") or cal.get("earningsDate")
            if isinstance(ed, (list, tuple)) and ed:
                first = ed[0]
                out["next_earnings_date"] = (
                    first.isoformat()[:10] if hasattr(first, "isoformat") else str(first)[:10]
                )
            elif ed:
                out["next_earnings_date"] = (
                    ed.isoformat()[:10] if hasattr(ed, "isoformat") else str(ed)[:10]
                )
            ex = cal.get("Ex-Dividend Date") or cal.get("exDividendDate")
            if ex:
                out["ex_dividend_date"] = (
                    ex.isoformat()[:10] if hasattr(ex, "isoformat") else str(ex)[:10]
                )
        ned = out.get("next_earnings_date")
        if ned:
            try:
                d = datetime.fromisoformat(ned).date()
                out["days_to_earnings"] = (d - datetime.now(timezone.utc).date()).days
            except Exception:
                pass
    except Exception:
        pass
    return out


def _option_chain_summary(t) -> dict:
    """Pull the nearest-expiry option chain and emit a compact summary:
    nearest expiry date, total call / put OI, PCR (put/call OI ratio),
    weighted IV, max-pain strike. Heavy on memory; soft-fails on any
    hiccup since options data for thinly-traded NSE names is
    notoriously patchy."""
    out: dict = {}
    try:
        opts, err = _safe_call(lambda: t.options)
        if not opts:
            return out
        nearest = sorted([str(o) for o in opts])[0]
        out["nearest_expiry"] = nearest
        chain, err = _safe_call(lambda: t.option_chain(nearest))
        if chain is None:
            return out
        calls = getattr(chain, "calls", None)
        puts = getattr(chain, "puts", None)
        if calls is not None and not calls.empty:
            out["calls_count"] = int(len(calls))
            if "openInterest" in calls.columns:
                out["calls_oi_total"] = int(calls["openInterest"].fillna(0).sum())
            if "impliedVolatility" in calls.columns:
                ivs = calls["impliedVolatility"].dropna()
                if not ivs.empty:
                    out["calls_iv_mean_pct"] = round(float(ivs.mean()) * 100, 2)
        if puts is not None and not puts.empty:
            out["puts_count"] = int(len(puts))
            if "openInterest" in puts.columns:
                out["puts_oi_total"] = int(puts["openInterest"].fillna(0).sum())
            if "impliedVolatility" in puts.columns:
                ivs = puts["impliedVolatility"].dropna()
                if not ivs.empty:
                    out["puts_iv_mean_pct"] = round(float(ivs.mean()) * 100, 2)
        if out.get("calls_oi_total") and out.get("puts_oi_total"):
            c = out["calls_oi_total"]
            p = out["puts_oi_total"]
            if c > 0:
                out["pcr_oi"] = round(p / c, 2)
        # Max pain (strike minimising total cash loss across writers).
        # Compute only when both legs present + small chain (skip if
        # over 200 strikes to keep memory down).
        try:
            if (calls is not None and puts is not None
                    and "strike" in calls.columns and "strike" in puts.columns
                    and len(calls) + len(puts) < 400):
                strikes = sorted(set(
                    list(calls["strike"].dropna()) + list(puts["strike"].dropna())
                ))
                best_strike, best_pain = None, None
                for s in strikes:
                    call_pain = ((calls["strike"] - s).clip(lower=-1e12).where(
                        calls["strike"] > s, 0) * calls.get("openInterest", 0).fillna(0)).sum()
                    put_pain = ((s - puts["strike"]).clip(lower=-1e12).where(
                        puts["strike"] < s, 0) * puts.get("openInterest", 0).fillna(0)).sum()
                    pain = abs(call_pain) + abs(put_pain)
                    if best_pain is None or pain < best_pain:
                        best_pain, best_strike = pain, s
                if best_strike is not None:
                    out["max_pain_strike"] = float(best_strike)
        except Exception:
            pass
    except Exception as e:
        out["options_error"] = str(e)[:120]
    return out


def deep_fetch(ticker: str) -> dict:
    """Pull EVERY useful free yfinance endpoint for one ticker plus
    derived technicals. Soft-fails each call independently so a
    partial payload still ships. Output is JSON-serialisable.

    Memory budget: a single deep_fetch is ~3-5 MB peak (historicals
    DataFrame + financials + option chain). Render's 512 MB dyno can
    handle one at a time; do NOT fan-out across tickers on the bot.
    """
    t = yf.Ticker(ticker)
    out: dict = {"ticker": ticker, "fetched_at": datetime.now(timezone.utc).isoformat()}

    # 1. .info
    info, err = _safe_call(lambda: t.info)
    if info:
        out["info"] = _info_summary(info)
    elif err:
        out["info_error"] = err

    # 2. Calendar
    cal, err = _safe_call(lambda: t.calendar)
    cal_dict = _calendar(cal)
    if cal_dict:
        out["calendar"] = cal_dict

    # 3. Ticker.news (yfinance native, top 15 trimmed)
    news, err = _safe_call(lambda: t.news)
    if news:
        out["news"] = _ticker_news(news)

    # 4. Full price history (max). Compress to a 60-bar tail + 5y
    # monthly summary so the LLM payload does not bloat. The technicals
    # block carries the derived numbers; the LLM rarely needs raw
    # daily candles older than 3 months.
    hist, err = _safe_call(lambda: t.history(period="max", interval="1d"))
    if hist is not None and not hist.empty:
        out["history_summary"] = {
            "listed_since": str(hist.index[0])[:10] if len(hist) else None,
            "bars_total": int(len(hist)),
            "tail_60d": _df_to_records(hist.tail(60), max_rows=60),
        }
        # Resample to monthly for a longer-horizon view at low cost
        try:
            mo = hist["Close"].resample("ME").last().dropna()
            if not mo.empty:
                out["history_summary"]["monthly_close"] = [
                    {"period": str(i)[:7], "close": round(float(v), 2)}
                    for i, v in mo.tail(60).items()
                ]
        except Exception:
            pass
        out["technicals"] = _technicals_from_history(hist)

    # 5. Analyst tables. Trim to most-recent 15 rows each so the
    # payload stays under 50 KB for any single deep_fetch.
    for attr, key in (
        ("recommendations", "recommendations"),
        ("recommendations_summary", "recommendations_summary"),
        ("upgrades_downgrades", "upgrades_downgrades"),
        ("analyst_price_targets", "analyst_price_targets"),
        ("earnings_estimate", "earnings_estimate"),
        ("revenue_estimate", "revenue_estimate"),
        ("earnings_dates", "earnings_dates"),
        ("earnings_history", "earnings_history"),
    ):
        df, err = _safe_call(lambda a=attr: getattr(t, a, None))
        if df is None:
            continue
        if isinstance(df, pd.DataFrame):
            out[key] = _df_to_records(df, max_rows=15)
        elif isinstance(df, dict):
            # analyst_price_targets returns a dict in newer yfinance
            out[key] = {k: v for k, v in df.items() if v is not None}

    # 6. Financials. Annual + quarterly income / balance / cashflow.
    # Keep most-recent 6 columns each (6 quarters or 4-6 years).
    for attr, key in (
        ("income_stmt", "income_stmt_annual"),
        ("quarterly_income_stmt", "income_stmt_quarterly"),
        ("balance_sheet", "balance_sheet_annual"),
        ("quarterly_balance_sheet", "balance_sheet_quarterly"),
        ("cashflow", "cashflow_annual"),
        ("quarterly_cashflow", "cashflow_quarterly"),
    ):
        df, err = _safe_call(lambda a=attr: getattr(t, a, None))
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            continue
        # yfinance returns rows=metrics, columns=periods. Transpose so
        # rows=periods reading top-down newest-first.
        try:
            d = df.T.head(6)
            d.index = [str(i)[:10] for i in d.index]
            recs = []
            for period, row in d.iterrows():
                rec = {"period": period}
                for k, v in row.items():
                    if v is None or (isinstance(v, float) and v != v):
                        continue
                    if isinstance(v, (int, float)):
                        rec[str(k)] = round(float(v) / 1e7, 2)  # cr
                if len(rec) > 1:
                    recs.append(rec)
            if recs:
                out[key] = recs
        except Exception as e:
            out[f"{key}_error"] = str(e)[:120]

    # 7. Holders breakdown.
    for attr, key in (
        ("major_holders", "major_holders"),
        ("institutional_holders", "institutional_holders"),
        ("mutualfund_holders", "mutualfund_holders"),
        ("insider_transactions", "insider_transactions"),
        ("insider_roster_holders", "insider_roster_holders"),
    ):
        df, err = _safe_call(lambda a=attr: getattr(t, a, None))
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            continue
        out[key] = _df_to_records(df, max_rows=10)

    # 8. Options chain summary (single nearest expiry only).
    opts = _option_chain_summary(t)
    if opts:
        out["options"] = opts

    # 9. Sustainability scores when available (free for some tickers).
    sust, err = _safe_call(lambda: t.sustainability)
    if isinstance(sust, pd.DataFrame) and not sust.empty:
        try:
            out["sustainability"] = {
                str(i): float(v) for i, v in sust.iloc[:, 0].items()
                if isinstance(v, (int, float))
            }
        except Exception:
            pass

    # Cleanup. Ticker objects hold a curl_cffi session that lingers
    # across calls and is the documented cause of the per-thread
    # heap creep aggregator.py mitigates the same way.
    del t
    gc.collect()
    return out


if __name__ == "__main__":
    import json
    import sys
    tk = sys.argv[1] if len(sys.argv) > 1 else "RELIANCE.NS"
    d = deep_fetch(tk)
    print(json.dumps(d, indent=2, default=str)[:4000])

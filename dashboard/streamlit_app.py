"""Arc'emX! Streamlit dashboard v2.

Features:
- Today's Call: mood, picks, portfolio verdicts, wishlist signals
- Markets: index candles + top movers + sector heatmap
- Portfolio: live P&L table + allocation pie + value timeline
- Wishlist: live prices + day % colored
- History: past Gemini calls timeline
"""
import os
import json
import pandas as pd
import streamlit as st
import yfinance as yf
import plotly.graph_objects as go
import plotly.express as px
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
st.set_page_config(page_title="Arc'emX!", layout="wide", page_icon="📈")


def cfg(key, default=None):
    try:
        return st.secrets.get(key, os.getenv(key, default))
    except Exception:
        return os.getenv(key, default)


SUPABASE_URL = cfg("SUPABASE_URL")
SUPABASE_KEY = cfg("SUPABASE_KEY")
DEFAULT_UID = cfg("TELEGRAM_CHAT_ID", "default")
sb = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None


def is_indian(ticker: str) -> bool:
    return ticker.endswith(".NS") or ticker.endswith(".BO") or ticker.startswith("^NSE") or ticker.startswith("^BSE")


def currency(ticker: str) -> str:
    return "₹" if is_indian(ticker) else "$"


def fmt_money(val: float, ticker: str = "") -> str:
    c = currency(ticker) if ticker else "₹"
    return f"{c}{val:,.2f}"


@st.cache_data(ttl=300)
def fetch_ohlc(ticker: str, period: str = "6mo", interval: str = "1d") -> pd.DataFrame:
    df = yf.download(ticker, period=period, interval=interval, progress=False, auto_adjust=True)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df


@st.cache_data(ttl=120)
def fetch_quote(ticker: str) -> dict:
    try:
        info = yf.Ticker(ticker).fast_info
        last = info.last_price
        prev = info.previous_close
        return {
            "last": last,
            "prev": prev,
            "pct": (last - prev) / prev * 100 if prev else 0,
            "high": info.day_high,
            "low": info.day_low,
            "y_high": info.year_high,
            "y_low": info.year_low,
        }
    except Exception:
        try:
            h = yf.Ticker(ticker).history(period="2d")
            if not h.empty:
                last = float(h["Close"].iloc[-1])
                prev = float(h["Close"].iloc[-2]) if len(h) > 1 else last
                return {"last": last, "prev": prev, "pct": (last - prev) / prev * 100,
                        "high": last, "low": last, "y_high": last, "y_low": last}
        except Exception:
            pass
    return {}


@st.cache_data(ttl=300)
def latest_analysis():
    if not sb: return None
    res = sb.table("analysis").select("*").order("run_at", desc=True).limit(1).execute()
    return res.data[0] if res.data else None


@st.cache_data(ttl=600)
def analysis_history(n: int = 30):
    if not sb: return pd.DataFrame()
    res = sb.table("analysis").select("run_at,market_mood,nifty_outlook,sensex_outlook").order(
        "run_at", desc=True
    ).limit(n).execute()
    return pd.DataFrame(res.data or [])


@st.cache_data(ttl=120)
def portfolio_rows(uid: str):
    if not sb: return []
    res = sb.table("portfolio").select("*").eq("user_id", uid).execute()
    rows = []
    for h in res.data:
        q = fetch_quote(h["ticker"])
        if not q:
            continue
        inv = h["avg_buy_price"] * h["qty"]
        cur = q["last"] * h["qty"]
        rows.append({
            "ticker": h["ticker"], "qty": h["qty"],
            "avg_buy": h["avg_buy_price"], "last": q["last"],
            "invested": inv, "current": cur,
            "pnl": cur - inv, "pnl_pct": (cur - inv) / inv * 100,
            "currency": currency(h["ticker"]),
        })
    return rows


@st.cache_data(ttl=120)
def wishlist_rows(uid: str):
    if not sb: return []
    res = sb.table("wishlist").select("*").eq("user_id", uid).execute()
    rows = []
    for w in res.data:
        q = fetch_quote(w["ticker"])
        if not q:
            continue
        rows.append({
            "ticker": w["ticker"],
            "last": q["last"], "pct": q["pct"],
            "y_high": q.get("y_high", 0), "y_low": q.get("y_low", 0),
            "currency": currency(w["ticker"]),
        })
    return rows


# Sidebar
st.sidebar.title("Arc'emX!")
uid = st.sidebar.text_input("User ID", value=DEFAULT_UID, help="Your Telegram user ID")
if st.sidebar.button("🔄 Refresh data"):
    st.cache_data.clear()
    st.rerun()
st.sidebar.markdown("---")
st.sidebar.caption("Bot: t.me/your_bot")
st.sidebar.caption("Repo: github.com/rusteezee/arcemx")

st.title("📈 Arc'emX!")
st.caption("AI market intelligence • Not SEBI-registered advice • Educational only • DYOR")

tabs = st.tabs(["🎯 Today's Call", "📊 Markets", "💼 Portfolio", "👁 Wishlist", "📜 History"])

# ============ TAB 1: Today's Call ============
with tabs[0]:
    a = latest_analysis()
    if not a:
        st.warning("No analysis yet. Run: `python -m analyzer.aggregator`")
    else:
        raw = a.get("raw_json") or {}
        mood = raw.get("market_mood", "?").upper()
        conf = raw.get("confidence", 0)

        mood_color = {"BULL": "🟢", "BEAR": "🔴", "NEUTRAL": "🟡"}.get(mood, "⚪")

        c1, c2, c3 = st.columns(3)
        c1.metric(f"{mood_color} Market Mood", mood)
        c2.metric("Confidence", f"{conf}%")
        run_at = a.get("run_at", "")[:16].replace("T", " ")
        c3.metric("As of", run_at)

        c1, c2 = st.columns(2)
        with c1:
            st.subheader("📊 Nifty 50")
            no = raw.get("nifty_outlook", {})
            dir_emoji = {"up": "📈", "down": "📉", "sideways": "➡️"}.get(no.get("direction", ""), "")
            st.markdown(f"### {dir_emoji} {no.get('direction', '?').title()}")
            st.markdown(f"**Range:** `{no.get('range', '?')}`")
            with st.expander("Drivers"):
                for d in no.get("drivers", []):
                    st.markdown(f"- {d}")
        with c2:
            st.subheader("📊 Sensex")
            so = raw.get("sensex_outlook", {})
            dir_emoji = {"up": "📈", "down": "📉", "sideways": "➡️"}.get(so.get("direction", ""), "")
            st.markdown(f"### {dir_emoji} {so.get('direction', '?').title()}")
            st.markdown(f"**Range:** `{so.get('range', '?')}`")
            with st.expander("Drivers"):
                for d in so.get("drivers", []):
                    st.markdown(f"- {d}")

        st.markdown("---")
        c1, c2 = st.columns(2)
        with c1:
            st.subheader("⚡ Short-term Picks")
            stp = pd.DataFrame(raw.get("short_term_picks", []))
            if not stp.empty:
                st.dataframe(stp, use_container_width=True, hide_index=True)
            else:
                st.info("None")
        with c2:
            st.subheader("🎯 Long-term Picks")
            ltp = pd.DataFrame(raw.get("long_term_picks", []))
            if not ltp.empty:
                st.dataframe(ltp, use_container_width=True, hide_index=True)
            else:
                st.info("None")

        st.subheader("💼 Your Portfolio Verdicts")
        pv = raw.get("portfolio_verdicts", [])
        if pv:
            pv_df = pd.DataFrame(pv)
            def color_verdict(v):
                colors = {"hold": "🟡", "add": "🟢", "trim": "🟠", "exit": "🔴"}
                return f"{colors.get(v, '')} {v}"
            if "verdict" in pv_df.columns:
                pv_df["verdict"] = pv_df["verdict"].apply(color_verdict)
            st.dataframe(pv_df, use_container_width=True, hide_index=True)
        else:
            st.info("Sync portfolio via Telegram /sync first.")

        st.subheader("👁 Wishlist Signals")
        ws = raw.get("wishlist_signals", [])
        if ws:
            st.dataframe(pd.DataFrame(ws), use_container_width=True, hide_index=True)
        else:
            st.info("Sync wishlist via Telegram /sync.")

        st.subheader("🚫 Stocks to Avoid")
        sa = pd.DataFrame(raw.get("stocks_to_avoid", []))
        if not sa.empty:
            st.dataframe(sa, use_container_width=True, hide_index=True)

        with st.expander("📝 Full Reasoning"):
            st.write(raw.get("reasoning", ""))
            st.markdown("**Global factors:**")
            for f in raw.get("global_factors", []):
                st.markdown(f"- {f}")
            st.markdown("**Key news drivers:**")
            for n in raw.get("key_news_drivers", []):
                st.markdown(f"- {n}")
            st.markdown("**Search trends:**")
            for t in raw.get("search_trend_signals", []):
                st.markdown(f"- {t}")


# ============ TAB 2: Markets ============
with tabs[1]:
    st.subheader("Indian Indices")
    idx_specs = [("^NSEI", "NIFTY 50"), ("^BSESN", "SENSEX"), ("^NSEBANK", "Bank Nifty")]
    cols = st.columns(3)
    for col, (tk, name) in zip(cols, idx_specs):
        q = fetch_quote(tk)
        if q:
            col.metric(name, f"{q['last']:,.2f}", f"{q['pct']:+.2f}%")

    st.markdown("---")
    sel = st.selectbox("Chart ticker", ["^NSEI", "^BSESN", "^NSEBANK", "RELIANCE.NS", "TCS.NS",
                                          "HDFCBANK.NS", "INFY.NS", "Custom..."])
    if sel == "Custom...":
        sel = st.text_input("Enter ticker (e.g. RELIANCE.NS, AAPL)", "RELIANCE.NS")
    period = st.radio("Period", ["1mo", "3mo", "6mo", "1y", "5y"], index=2, horizontal=True)

    df = fetch_ohlc(sel, period=period)
    if not df.empty:
        fig = go.Figure(data=[go.Candlestick(
            x=df.index, open=df["Open"], high=df["High"], low=df["Low"], close=df["Close"],
            name=sel,
        )])
        # Add MAs
        ma20 = df["Close"].rolling(20).mean()
        ma50 = df["Close"].rolling(50).mean()
        fig.add_trace(go.Scatter(x=df.index, y=ma20, name="MA20", line=dict(color="orange", width=1)))
        fig.add_trace(go.Scatter(x=df.index, y=ma50, name="MA50", line=dict(color="cyan", width=1)))
        fig.update_layout(title=f"{sel} — {period}", xaxis_rangeslider_visible=False,
                          height=500, template="plotly_dark")
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning(f"No data for {sel}")

    # Sector heatmap from NIFTY 50 + portfolio + wishlist
    st.markdown("---")
    st.subheader("🔥 Heatmap (NIFTY 50 + your stocks)")
    heat_tickers = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
                    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
                    "LT.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS", "HCLTECH.NS",
                    "SUNPHARMA.NS", "TITAN.NS", "BAJFINANCE.NS", "WIPRO.NS", "NTPC.NS",
                    "POWERGRID.NS", "M&M.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ONGC.NS"]
    # Add portfolio + wishlist tickers
    for r in portfolio_rows(uid):
        heat_tickers.append(r["ticker"])
    for r in wishlist_rows(uid):
        heat_tickers.append(r["ticker"])
    heat_tickers = list(dict.fromkeys(heat_tickers))  # dedupe, preserve order

    heat_rows = []
    for t in heat_tickers:
        q = fetch_quote(t)
        if q and q.get("last"):
            heat_rows.append({"ticker": t, "pct": q["pct"],
                              "size": abs(q["last"] * 1000)})  # size proxy
    if heat_rows:
        hdf = pd.DataFrame(heat_rows)
        fig = px.treemap(hdf, path=["ticker"], values="size", color="pct",
                         color_continuous_scale=["red", "white", "green"],
                         color_continuous_midpoint=0, range_color=[-5, 5])
        fig.update_layout(height=600, template="plotly_dark")
        st.plotly_chart(fig, use_container_width=True)


# ============ TAB 3: Portfolio ============
with tabs[2]:
    rows = portfolio_rows(uid)
    if not rows:
        st.info("Empty portfolio. Send `/sync` to Telegram bot or `/buy TICKER PRICE QTY`.")
    else:
        df = pd.DataFrame(rows)

        # Summary cards (India only for total; US shown separately later)
        ind_df = df[df["currency"] == "₹"]
        us_df = df[df["currency"] == "$"]

        c1, c2, c3, c4 = st.columns(4)
        if not ind_df.empty:
            c1.metric("Invested (₹)", f"₹{ind_df['invested'].sum():,.0f}")
            c2.metric("Current (₹)", f"₹{ind_df['current'].sum():,.0f}")
            pnl = ind_df["pnl"].sum()
            pct = pnl / ind_df["invested"].sum() * 100
            c3.metric("P&L (₹)", f"₹{pnl:+,.0f}", f"{pct:+.2f}%")
            c4.metric("Holdings", len(ind_df))

        if not us_df.empty:
            st.markdown("**🇺🇸 US Holdings**")
            c1, c2, c3 = st.columns(3)
            c1.metric("Invested ($)", f"${us_df['invested'].sum():,.2f}")
            c2.metric("Current ($)", f"${us_df['current'].sum():,.2f}")
            c3.metric("P&L ($)", f"${us_df['pnl'].sum():+,.2f}")

        # Holdings table
        st.markdown("### Holdings")
        disp = df.copy()
        disp["P&L %"] = disp["pnl_pct"].apply(lambda x: f"{x:+.2f}%")
        disp["P&L"] = disp.apply(lambda r: f"{r['currency']}{r['pnl']:+,.0f}", axis=1)
        disp["Avg Buy"] = disp.apply(lambda r: f"{r['currency']}{r['avg_buy']:.2f}", axis=1)
        disp["Last"] = disp.apply(lambda r: f"{r['currency']}{r['last']:.2f}", axis=1)
        disp["Invested"] = disp.apply(lambda r: f"{r['currency']}{r['invested']:,.0f}", axis=1)
        disp["Current"] = disp.apply(lambda r: f"{r['currency']}{r['current']:,.0f}", axis=1)
        st.dataframe(
            disp[["ticker", "qty", "Avg Buy", "Last", "Invested", "Current", "P&L", "P&L %"]],
            use_container_width=True, hide_index=True
        )

        # Allocation pie
        if not ind_df.empty:
            st.markdown("### Allocation by current value")
            fig = px.pie(ind_df, values="current", names="ticker", hole=0.4)
            fig.update_layout(height=400, template="plotly_dark")
            st.plotly_chart(fig, use_container_width=True)

        # Value timeline (uses prices table if populated)
        st.markdown("### Portfolio value timeline (30d)")
        if sb and not ind_df.empty:
            tickers = ind_df["ticker"].tolist()
            qty_map = dict(zip(ind_df["ticker"], ind_df["qty"]))
            try:
                cutoff = (datetime.utcnow() - timedelta(days=60)).isoformat()
                p = sb.table("prices").select("ticker,ts,close").in_(
                    "ticker", tickers
                ).gte("ts", cutoff).execute()
                pdf = pd.DataFrame(p.data or [])
                if not pdf.empty:
                    pdf["ts"] = pd.to_datetime(pdf["ts"])
                    pdf["value"] = pdf.apply(lambda r: r["close"] * qty_map.get(r["ticker"], 0), axis=1)
                    daily = pdf.groupby(pdf["ts"].dt.date)["value"].sum().reset_index()
                    daily.columns = ["date", "value"]
                    fig = px.line(daily, x="date", y="value", title="Portfolio value (₹)")
                    fig.update_layout(height=350, template="plotly_dark")
                    st.plotly_chart(fig, use_container_width=True)
                else:
                    st.info("Run prices fetcher for timeline data.")
            except Exception as e:
                st.warning(f"Timeline unavailable: {e}")


# ============ TAB 4: Wishlist ============
with tabs[3]:
    rows = wishlist_rows(uid)
    if not rows:
        st.info("Empty wishlist. Send `/sync` to bot or `/add_wish TICKER`.")
    else:
        df = pd.DataFrame(rows)
        # India + US split
        ind = df[df["currency"] == "₹"].copy()
        us = df[df["currency"] == "$"].copy()

        if not ind.empty:
            st.markdown("### 🇮🇳 Indian stocks")
            ind["Last"] = ind.apply(lambda r: f"₹{r['last']:.2f}", axis=1)
            ind["Day %"] = ind["pct"].apply(lambda x: f"{x:+.2f}%")
            ind["52W H"] = ind["y_high"].apply(lambda x: f"₹{x:.2f}" if x else "")
            ind["52W L"] = ind["y_low"].apply(lambda x: f"₹{x:.2f}" if x else "")
            st.dataframe(ind[["ticker", "Last", "Day %", "52W H", "52W L"]],
                         use_container_width=True, hide_index=True)
        if not us.empty:
            st.markdown("### 🇺🇸 US stocks")
            us["Last"] = us.apply(lambda r: f"${r['last']:.2f}", axis=1)
            us["Day %"] = us["pct"].apply(lambda x: f"{x:+.2f}%")
            us["52W H"] = us["y_high"].apply(lambda x: f"${x:.2f}" if x else "")
            us["52W L"] = us["y_low"].apply(lambda x: f"${x:.2f}" if x else "")
            st.dataframe(us[["ticker", "Last", "Day %", "52W H", "52W L"]],
                         use_container_width=True, hide_index=True)


# ============ TAB 5: History ============
with tabs[4]:
    df = analysis_history(50)
    if df.empty:
        st.info("No history yet.")
    else:
        df["run_at"] = pd.to_datetime(df["run_at"])
        df["mood_score"] = df["market_mood"].map({"bull": 1, "neutral": 0, "bear": -1}).fillna(0)
        fig = px.line(df.sort_values("run_at"), x="run_at", y="mood_score",
                      markers=True, title="Market mood timeline (1=bull, 0=neutral, -1=bear)")
        fig.update_layout(height=300, template="plotly_dark", yaxis=dict(range=[-1.5, 1.5]))
        st.plotly_chart(fig, use_container_width=True)

        st.dataframe(df[["run_at", "market_mood"]], use_container_width=True, hide_index=True)

"""Arc'emX! Streamlit dashboard v2.1. Minimalistic. Material icons. No emojis."""
import os
import pandas as pd
import streamlit as st
import yfinance as yf
import plotly.graph_objects as go
import plotly.express as px
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
st.set_page_config(page_title="Arc'emX!", layout="wide",
                   page_icon=":material/show_chart:",
                   initial_sidebar_state="collapsed")

# ===== Custom CSS =====
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

html, body, [class*="css"] {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}

.block-container { padding-top: 2rem; padding-bottom: 3rem; max-width: 1400px; }

h1, h2, h3, h4, h5 { font-weight: 600; letter-spacing: -0.02em; }
h1 { font-size: 2.25rem; }
h2 { font-size: 1.5rem; margin-top: 1.5rem; }
h3 { font-size: 1.15rem; color: rgba(250,250,250,0.85); }

[data-testid="stMetric"] {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 1rem 1.25rem;
    transition: all 0.2s ease;
}
[data-testid="stMetric"]:hover {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.15);
}
[data-testid="stMetricLabel"] {
    font-size: 0.8rem; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.7;
}
[data-testid="stMetricValue"] { font-size: 1.75rem; font-weight: 600; }

div[data-testid="stTabs"] button {
    font-weight: 500; padding: 0.6rem 1.1rem; font-size: 0.95rem;
}

[data-testid="stDataFrame"] {
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.08);
}

.stPlotlyChart > div {
    border-radius: 12px;
    background: rgba(255,255,255,0.02);
    padding: 0.5rem;
}

.muted { color: rgba(250,250,250,0.55); font-size: 0.9rem; }
.disclaimer { font-size: 0.78rem; opacity: 0.55; margin-top: 0.5rem; }
.pill {
    display: inline-block; padding: 0.2rem 0.7rem; border-radius: 999px;
    font-size: 0.8rem; font-weight: 500;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
}
.pill-bull { background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.4); color: rgb(134,239,172); }
.pill-bear { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.4); color: rgb(252,165,165); }
.pill-neutral { background: rgba(234,179,8,0.15); border-color: rgba(234,179,8,0.4); color: rgb(253,224,71); }
</style>
""", unsafe_allow_html=True)


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
            "last": last, "prev": prev,
            "pct": (last - prev) / prev * 100 if prev else 0,
            "high": info.day_high, "low": info.day_low,
            "y_high": info.year_high, "y_low": info.year_low,
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


PLOTLY_TEMPLATE = "plotly_dark"
LINE_COLOR = "#7dd3fc"
MA20_COLOR = "#fbbf24"
MA50_COLOR = "#a78bfa"
GAIN = "#22c55e"
LOSS = "#ef4444"


# ===== Sidebar =====
with st.sidebar:
    st.markdown("### Arc'emX!")
    uid = st.text_input("User ID", value=DEFAULT_UID, help="Your Telegram user ID")
    if st.button("Refresh data", icon=":material/refresh:", use_container_width=True):
        st.cache_data.clear()
        st.rerun()
    st.divider()
    st.markdown('<span class="muted">AI market intelligence. Educational only.</span>',
                unsafe_allow_html=True)


# ===== Header =====
col_h1, col_h2 = st.columns([3, 1])
with col_h1:
    st.markdown("# Arc'emX!")
    st.markdown('<span class="muted">Market intelligence powered by Gemini, INDmoney and Supabase.</span>',
                unsafe_allow_html=True)
with col_h2:
    st.markdown(f'<div style="text-align:right; margin-top:1rem;"><span class="pill">{datetime.now().strftime("%a, %d %b %Y")}</span></div>',
                unsafe_allow_html=True)


tabs = st.tabs([
    ":material/insights: Today",
    ":material/show_chart: Markets",
    ":material/account_balance_wallet: Portfolio",
    ":material/visibility: Wishlist",
    ":material/history: History",
])

# ============ TAB 1: Today's Call ============
with tabs[0]:
    a = latest_analysis()
    if not a:
        st.warning("No analysis yet. Run `python -m analyzer.aggregator`.")
    else:
        raw = a.get("raw_json") or {}
        mood = raw.get("market_mood", "neutral").lower()
        conf = raw.get("confidence", 0)

        mood_class = {"bull": "pill-bull", "bear": "pill-bear", "neutral": "pill-neutral"}.get(mood, "pill-neutral")
        run_at = a.get("run_at", "")[:16].replace("T", " ")

        c1, c2, c3 = st.columns(3)
        with c1:
            st.markdown(f"<div data-testid='stMetric'><div data-testid='stMetricLabel'>Market mood</div>"
                        f"<div style='margin-top:0.5rem;'><span class='pill {mood_class}'>{mood.upper()}</span></div></div>",
                        unsafe_allow_html=True)
        c2.metric("Confidence", f"{conf}%")
        c3.metric("As of", run_at)

        c1, c2 = st.columns(2)
        with c1:
            st.markdown("### Nifty 50 outlook")
            no = raw.get("nifty_outlook", {})
            direction = no.get("direction", "?").title()
            st.markdown(f"**Direction:** `{direction}`  ·  **Range:** `{no.get('range', '?')}`")
            with st.expander("Drivers"):
                for d in no.get("drivers", []):
                    st.markdown(f"- {d}")
        with c2:
            st.markdown("### Sensex outlook")
            so = raw.get("sensex_outlook", {})
            direction = so.get("direction", "?").title()
            st.markdown(f"**Direction:** `{direction}`  ·  **Range:** `{so.get('range', '?')}`")
            with st.expander("Drivers"):
                for d in so.get("drivers", []):
                    st.markdown(f"- {d}")

        st.divider()
        c1, c2 = st.columns(2)
        with c1:
            st.markdown("### Short term picks")
            stp = pd.DataFrame(raw.get("short_term_picks", []))
            if not stp.empty:
                st.dataframe(stp, use_container_width=True, hide_index=True)
            else:
                st.markdown('<span class="muted">None</span>', unsafe_allow_html=True)
        with c2:
            st.markdown("### Long term picks")
            ltp = pd.DataFrame(raw.get("long_term_picks", []))
            if not ltp.empty:
                st.dataframe(ltp, use_container_width=True, hide_index=True)
            else:
                st.markdown('<span class="muted">None</span>', unsafe_allow_html=True)

        st.markdown("### Your portfolio verdicts")
        pv = raw.get("portfolio_verdicts", [])
        if pv:
            st.dataframe(pd.DataFrame(pv), use_container_width=True, hide_index=True)
        else:
            st.markdown('<span class="muted">Sync portfolio via Telegram first.</span>', unsafe_allow_html=True)

        st.markdown("### Wishlist signals")
        ws = raw.get("wishlist_signals", [])
        if ws:
            st.dataframe(pd.DataFrame(ws), use_container_width=True, hide_index=True)
        else:
            st.markdown('<span class="muted">Sync wishlist via Telegram first.</span>', unsafe_allow_html=True)

        st.markdown("### Stocks to avoid")
        sa = pd.DataFrame(raw.get("stocks_to_avoid", []))
        if not sa.empty:
            st.dataframe(sa, use_container_width=True, hide_index=True)
        else:
            st.markdown('<span class="muted">None</span>', unsafe_allow_html=True)

        with st.expander("Full reasoning"):
            st.write(raw.get("reasoning", ""))
            if raw.get("global_factors"):
                st.markdown("**Global factors:**")
                for f in raw.get("global_factors", []):
                    st.markdown(f"- {f}")
            if raw.get("key_news_drivers"):
                st.markdown("**Key news drivers:**")
                for n in raw.get("key_news_drivers", []):
                    st.markdown(f"- {n}")
            if raw.get("search_trend_signals"):
                st.markdown("**Search trends:**")
                for t in raw.get("search_trend_signals", []):
                    st.markdown(f"- {t}")


# ============ TAB 2: Markets ============
def line_chart(ticker: str, period: str = "6mo") -> go.Figure | None:
    df = fetch_ohlc(ticker, period=period)
    if df.empty:
        return None
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=df.index, y=df["Close"], mode="lines", name=ticker,
        line=dict(color=LINE_COLOR, width=2.2),
        fill="tozeroy", fillcolor="rgba(125,211,252,0.08)",
    ))
    ma20 = df["Close"].rolling(20).mean()
    ma50 = df["Close"].rolling(50).mean()
    fig.add_trace(go.Scatter(x=df.index, y=ma20, mode="lines", name="MA 20",
                             line=dict(color=MA20_COLOR, width=1, dash="dot")))
    fig.add_trace(go.Scatter(x=df.index, y=ma50, mode="lines", name="MA 50",
                             line=dict(color=MA50_COLOR, width=1, dash="dot")))
    fig.update_layout(
        title=dict(text=ticker, font=dict(size=16)),
        height=460, template=PLOTLY_TEMPLATE,
        margin=dict(l=20, r=20, t=50, b=20),
        plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
        xaxis=dict(showgrid=False), yaxis=dict(gridcolor="rgba(255,255,255,0.05)"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        hovermode="x unified",
    )
    return fig


with tabs[1]:
    st.markdown("### Indices")
    idx_specs = [("^NSEI", "NIFTY 50"), ("^BSESN", "SENSEX"), ("^NSEBANK", "Bank Nifty")]
    cols = st.columns(3)
    for col, (tk, name) in zip(cols, idx_specs):
        q = fetch_quote(tk)
        if q:
            col.metric(name, f"{q['last']:,.2f}", f"{q['pct']:+.2f}%")

    st.divider()
    st.markdown("### Chart")
    presets = ["^NSEI", "^BSESN", "^NSEBANK", "RELIANCE.NS", "TCS.NS",
               "HDFCBANK.NS", "INFY.NS", "Custom"]
    c1, c2 = st.columns([3, 2])
    with c1:
        sel = st.selectbox("Ticker", presets, label_visibility="collapsed")
        if sel == "Custom":
            sel = st.text_input("Enter ticker", "RELIANCE.NS")
    with c2:
        period = st.radio("Period", ["1mo", "3mo", "6mo", "1y", "5y"],
                          index=2, horizontal=True, label_visibility="collapsed")

    fig = line_chart(sel, period)
    if fig:
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.warning(f"No data for {sel}.")

    st.divider()
    st.markdown("### Heatmap")
    st.markdown('<span class="muted">NIFTY 50 plus your portfolio and wishlist. Box size proportional to price. Colour by day percent change.</span>',
                unsafe_allow_html=True)
    heat_tickers = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
                    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
                    "LT.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS", "HCLTECH.NS",
                    "SUNPHARMA.NS", "TITAN.NS", "BAJFINANCE.NS", "WIPRO.NS", "NTPC.NS",
                    "POWERGRID.NS", "M&M.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ONGC.NS"]
    for r in portfolio_rows(uid):
        heat_tickers.append(r["ticker"])
    for r in wishlist_rows(uid):
        heat_tickers.append(r["ticker"])
    heat_tickers = list(dict.fromkeys(heat_tickers))

    heat_rows = []
    for t in heat_tickers:
        q = fetch_quote(t)
        if q and q.get("last"):
            heat_rows.append({"ticker": t.replace(".NS", "").replace(".BO", ""),
                              "pct": q["pct"],
                              "size": abs(q["last"]) + 1})
    if heat_rows:
        hdf = pd.DataFrame(heat_rows)
        fig = px.treemap(hdf, path=["ticker"], values="size", color="pct",
                         color_continuous_scale=[(0, LOSS), (0.5, "#1f2937"), (1, GAIN)],
                         color_continuous_midpoint=0, range_color=[-5, 5])
        fig.update_traces(textfont=dict(size=14, family="Inter"),
                          marker=dict(cornerradius=6))
        fig.update_layout(height=620, margin=dict(l=10, r=10, t=10, b=10),
                          plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
                          coloraxis_colorbar=dict(title="%"))
        st.plotly_chart(fig, use_container_width=True)


# ============ TAB 3: Portfolio ============
with tabs[2]:
    rows = portfolio_rows(uid)
    if not rows:
        st.info("Empty portfolio. Send `/sync` to Telegram bot or `/buy TICKER PRICE QTY`.")
    else:
        df = pd.DataFrame(rows)
        ind_df = df[df["currency"] == "₹"]
        us_df = df[df["currency"] == "$"]

        c1, c2, c3, c4 = st.columns(4)
        if not ind_df.empty:
            c1.metric("Invested", f"₹{ind_df['invested'].sum():,.0f}")
            c2.metric("Current", f"₹{ind_df['current'].sum():,.0f}")
            pnl = ind_df["pnl"].sum()
            pct = pnl / ind_df["invested"].sum() * 100
            c3.metric("P&L", f"₹{pnl:+,.0f}", f"{pct:+.2f}%")
            c4.metric("Holdings", len(ind_df))

        if not us_df.empty:
            st.markdown("### US holdings")
            c1, c2, c3 = st.columns(3)
            c1.metric("Invested", f"${us_df['invested'].sum():,.2f}")
            c2.metric("Current", f"${us_df['current'].sum():,.2f}")
            c3.metric("P&L", f"${us_df['pnl'].sum():+,.2f}")

        st.markdown("### Holdings")
        disp = df.copy()
        disp["P&L %"] = disp["pnl_pct"].apply(lambda x: f"{x:+.2f}%")
        disp["P&L"] = disp.apply(lambda r: f"{r['currency']}{r['pnl']:+,.0f}", axis=1)
        disp["Avg buy"] = disp.apply(lambda r: f"{r['currency']}{r['avg_buy']:.2f}", axis=1)
        disp["Last"] = disp.apply(lambda r: f"{r['currency']}{r['last']:.2f}", axis=1)
        disp["Invested"] = disp.apply(lambda r: f"{r['currency']}{r['invested']:,.0f}", axis=1)
        disp["Current"] = disp.apply(lambda r: f"{r['currency']}{r['current']:,.0f}", axis=1)
        st.dataframe(
            disp[["ticker", "qty", "Avg buy", "Last", "Invested", "Current", "P&L", "P&L %"]],
            use_container_width=True, hide_index=True
        )

        if not ind_df.empty:
            c1, c2 = st.columns(2)
            with c1:
                st.markdown("### Allocation")
                fig = px.pie(ind_df, values="current", names="ticker", hole=0.55)
                fig.update_traces(textposition="outside", textinfo="label+percent",
                                  marker=dict(line=dict(color="rgba(0,0,0,0)", width=2)))
                fig.update_layout(height=380, template=PLOTLY_TEMPLATE, showlegend=False,
                                  margin=dict(l=10, r=10, t=10, b=10),
                                  paper_bgcolor="rgba(0,0,0,0)")
                st.plotly_chart(fig, use_container_width=True)

            with c2:
                st.markdown("### Value timeline (60d)")
                if sb:
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
                            fig = go.Figure()
                            fig.add_trace(go.Scatter(x=daily["date"], y=daily["value"],
                                                     mode="lines", line=dict(color=LINE_COLOR, width=2.2),
                                                     fill="tozeroy", fillcolor="rgba(125,211,252,0.08)"))
                            fig.update_layout(height=380, template=PLOTLY_TEMPLATE,
                                              plot_bgcolor="rgba(0,0,0,0)",
                                              paper_bgcolor="rgba(0,0,0,0)",
                                              margin=dict(l=20, r=20, t=20, b=20),
                                              xaxis=dict(showgrid=False),
                                              yaxis=dict(gridcolor="rgba(255,255,255,0.05)"))
                            st.plotly_chart(fig, use_container_width=True)
                        else:
                            st.markdown('<span class="muted">Run prices fetcher to populate timeline.</span>',
                                        unsafe_allow_html=True)
                    except Exception as e:
                        st.warning(f"Timeline unavailable: {e}")


# ============ TAB 4: Wishlist ============
with tabs[3]:
    rows = wishlist_rows(uid)
    if not rows:
        st.info("Empty wishlist. Send `/sync` to bot or `/add_wish TICKER`.")
    else:
        df = pd.DataFrame(rows)
        ind = df[df["currency"] == "₹"].copy()
        us = df[df["currency"] == "$"].copy()

        if not ind.empty:
            st.markdown("### Indian stocks")
            ind["Last"] = ind.apply(lambda r: f"₹{r['last']:.2f}", axis=1)
            ind["Day %"] = ind["pct"].apply(lambda x: f"{x:+.2f}%")
            ind["52W high"] = ind["y_high"].apply(lambda x: f"₹{x:.2f}" if x else "")
            ind["52W low"] = ind["y_low"].apply(lambda x: f"₹{x:.2f}" if x else "")
            st.dataframe(ind[["ticker", "Last", "Day %", "52W high", "52W low"]],
                         use_container_width=True, hide_index=True)
        if not us.empty:
            st.markdown("### US stocks")
            us["Last"] = us.apply(lambda r: f"${r['last']:.2f}", axis=1)
            us["Day %"] = us["pct"].apply(lambda x: f"{x:+.2f}%")
            us["52W high"] = us["y_high"].apply(lambda x: f"${x:.2f}" if x else "")
            us["52W low"] = us["y_low"].apply(lambda x: f"${x:.2f}" if x else "")
            st.dataframe(us[["ticker", "Last", "Day %", "52W high", "52W low"]],
                         use_container_width=True, hide_index=True)


# ============ TAB 5: History ============
with tabs[4]:
    df = analysis_history(50)
    if df.empty:
        st.info("No history yet.")
    else:
        df["run_at"] = pd.to_datetime(df["run_at"])
        df["mood_score"] = df["market_mood"].map({"bull": 1, "neutral": 0, "bear": -1}).fillna(0)
        sorted_df = df.sort_values("run_at")
        fig = go.Figure()
        fig.add_trace(go.Scatter(
            x=sorted_df["run_at"], y=sorted_df["mood_score"],
            mode="lines+markers", line=dict(color=LINE_COLOR, width=2.2),
            marker=dict(size=8, color=LINE_COLOR),
            fill="tozeroy", fillcolor="rgba(125,211,252,0.06)",
        ))
        fig.update_layout(
            title=dict(text="Market mood timeline", font=dict(size=15)),
            height=320, template=PLOTLY_TEMPLATE,
            plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)",
            margin=dict(l=20, r=20, t=50, b=20),
            xaxis=dict(showgrid=False),
            yaxis=dict(range=[-1.5, 1.5], tickvals=[-1, 0, 1],
                       ticktext=["Bear", "Neutral", "Bull"],
                       gridcolor="rgba(255,255,255,0.05)"),
        )
        st.plotly_chart(fig, use_container_width=True)

        st.dataframe(df[["run_at", "market_mood"]], use_container_width=True, hide_index=True)


# ===== Footer =====
st.divider()
st.markdown(
    '<div class="disclaimer">Arc\'emX! is for educational use only. '
    'Not SEBI registered investment advice. Do your own research.</div>',
    unsafe_allow_html=True
)

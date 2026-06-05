"""Streamlit dashboard. Deploy to share.streamlit.io free."""
import os
import json
import pandas as pd
import streamlit as st
import yfinance as yf
import plotly.graph_objects as go
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()
st.set_page_config(page_title="Arc'emX!", layout="wide", page_icon="📈")

# Streamlit Cloud uses st.secrets; local uses .env
def cfg(key, default=None):
    try:
        return st.secrets.get(key, os.getenv(key, default))
    except Exception:
        return os.getenv(key, default)

SUPABASE_URL = cfg("SUPABASE_URL")
SUPABASE_KEY = cfg("SUPABASE_KEY")
sb = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None


st.title("📈 Arc'emX! Dashboard")
st.caption("Not SEBI-registered advice. Educational only. DYOR.")

tab1, tab2, tab3, tab4, tab5 = st.tabs(["Today's Call", "Indices", "Portfolio", "Wishlist", "History"])


def latest_analysis():
    if not sb: return None
    res = sb.table("analysis").select("*").order("run_at", desc=True).limit(1).execute()
    return res.data[0] if res.data else None


with tab1:
    a = latest_analysis()
    if not a:
        st.info("No analysis yet. Run aggregator.")
    else:
        raw = a.get("raw_json") or {}
        col1, col2, col3 = st.columns(3)
        col1.metric("Market Mood", raw.get("market_mood", "?").upper())
        col2.metric("Confidence", f"{raw.get('confidence', '?')}")
        col3.metric("As of", a.get("run_at", "")[:16])

        c1, c2 = st.columns(2)
        with c1:
            st.subheader("Nifty Outlook")
            no = raw.get("nifty_outlook", {})
            st.write(f"**Direction:** {no.get('direction')}")
            st.write(f"**Range:** {no.get('range')}")
            st.write("**Drivers:**")
            for d in no.get("drivers", []): st.write(f"- {d}")
        with c2:
            st.subheader("Sensex Outlook")
            so = raw.get("sensex_outlook", {})
            st.write(f"**Direction:** {so.get('direction')}")
            st.write(f"**Range:** {so.get('range')}")
            st.write("**Drivers:**")
            for d in so.get("drivers", []): st.write(f"- {d}")

        st.subheader("Short-term Picks")
        st.dataframe(pd.DataFrame(raw.get("short_term_picks", [])), use_container_width=True)
        st.subheader("Long-term Picks")
        st.dataframe(pd.DataFrame(raw.get("long_term_picks", [])), use_container_width=True)
        st.subheader("Avoid")
        st.dataframe(pd.DataFrame(raw.get("stocks_to_avoid", [])), use_container_width=True)
        st.subheader("Reasoning")
        st.write(raw.get("reasoning", ""))


def candle(ticker: str):
    df = yf.download(ticker, period="6mo", interval="1d", progress=False, auto_adjust=True)
    if df.empty: return None
    fig = go.Figure(data=[go.Candlestick(
        x=df.index, open=df["Open"], high=df["High"], low=df["Low"], close=df["Close"]
    )])
    fig.update_layout(title=ticker, xaxis_rangeslider_visible=False, height=400)
    return fig


with tab2:
    c1, c2, c3 = st.columns(3)
    with c1:
        fig = candle("^NSEI")
        if fig: st.plotly_chart(fig, use_container_width=True)
    with c2:
        fig = candle("^BSESN")
        if fig: st.plotly_chart(fig, use_container_width=True)
    with c3:
        fig = candle("^NSEBANK")
        if fig: st.plotly_chart(fig, use_container_width=True)


with tab3:
    uid = st.text_input("User ID (your Telegram user id)", value="default")
    if sb:
        res = sb.table("portfolio").select("*").eq("user_id", uid).execute()
        rows = []
        for h in res.data:
            try:
                last = yf.Ticker(h["ticker"]).fast_info.last_price
                inv = h["avg_buy_price"] * h["qty"]
                cur = last * h["qty"]
                rows.append({
                    "Ticker": h["ticker"], "Qty": h["qty"],
                    "Avg Buy": h["avg_buy_price"], "Last": round(last, 2),
                    "Invested": round(inv, 2), "Current": round(cur, 2),
                    "P&L": round(cur - inv, 2), "P&L %": round((cur - inv) / inv * 100, 2),
                })
            except Exception:
                pass
        if rows:
            df = pd.DataFrame(rows)
            st.dataframe(df, use_container_width=True)
            st.metric("Total P&L", f"₹{df['P&L'].sum():,.0f}", f"{df['P&L %'].mean():.2f}% avg")
        else:
            st.info("Empty portfolio. Add holdings via Telegram bot.")


with tab4:
    uid = st.text_input("User ID", value="default", key="w_uid")
    if sb:
        res = sb.table("wishlist").select("*").eq("user_id", uid).execute()
        rows = []
        for w in res.data:
            try:
                info = yf.Ticker(w["ticker"]).fast_info
                rows.append({
                    "Ticker": w["ticker"], "Last": round(info.last_price, 2),
                    "Day %": round((info.last_price - info.previous_close) / info.previous_close * 100, 2)
                    if info.previous_close else 0,
                    "52W H": info.year_high, "52W L": info.year_low,
                })
            except Exception:
                pass
        if rows:
            st.dataframe(pd.DataFrame(rows), use_container_width=True)
        else:
            st.info("Empty. Add via bot: /add_wish TICKER")


with tab5:
    if sb:
        res = sb.table("analysis").select("run_at,market_mood,reasoning").order("run_at", desc=True).limit(30).execute()
        if res.data:
            st.dataframe(pd.DataFrame(res.data), use_container_width=True)
        else:
            st.info("No history.")

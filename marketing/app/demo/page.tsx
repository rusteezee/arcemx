"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const tabs = [
  { id: "today", label: "Today" },
  { id: "markets", label: "Markets" },
  { id: "portfolio", label: "Portfolio" },
  { id: "wishlist", label: "Wishlist" },
  { id: "accuracy", label: "Accuracy" },
  { id: "history", label: "History" },
] as const;

type TabId = (typeof tabs)[number]["id"];

const TAB_IDS: TabId[] = tabs.map((t) => t.id) as TabId[];

const SAMPLE = {
  today: {
    mood: "NEUTRAL" as const,
    confidence: 62,
    date: "5 June 2026",
    time: "8:30 AM",
    nifty: {
      dir: "Sideways",
      range: "23,200 - 23,500",
      drivers: [
        "Mixed global cues (US tech weak, EU energy strong)",
        "Q4 earnings tape skewed toward financials",
        "RBI cautious tone after last MPC",
        "Crude steady near $84 limiting energy upside",
      ],
    },
    sensex: {
      dir: "Sideways",
      range: "73,800 - 74,500",
      drivers: [
        "Heavyweights Reliance, HDFC Bank consolidating",
        "FII outflows on Friday but DII absorbing",
        "USD/INR stable around 83.4",
      ],
    },
    shortTerm: [
      { ticker: "ADANIENT", entry: "₹3,040 - ₹3,050", target: "₹3,150 - ₹3,200", stop: "₹2,980" },
      { ticker: "TITAN", entry: "₹4,200 - ₹4,250", target: "₹4,350 - ₹4,400", stop: "₹4,180" },
      { ticker: "COALINDIA", entry: "₹470 - ₹475", target: "₹485 - ₹490", stop: "₹465" },
    ],
    longTerm: [
      { ticker: "APOLLOHOSP", entry: "₹6,800 - ₹6,900", target: "₹8,500", stop: "₹6,400" },
      { ticker: "GRASIM", entry: "₹2,300 - ₹2,350", target: "₹2,800", stop: "₹2,200" },
    ],
    verdicts: [
      { ticker: "ANGELONE", verdict: "HOLD", reason: "Wait for stronger volume confirmation. Sector rotation pending.", target: "₹360", stop: "₹305" },
      { ticker: "ETERNAL", verdict: "ADD", reason: "Earnings momentum strong. RSI healthy.", target: "₹275", stop: "₹230" },
      { ticker: "SUZLON", verdict: "TRIM", reason: "Already +27%. Lock half. Trail rest.", target: "₹60", stop: "₹52" },
    ],
    reasoning: {
      summary:
        "Tape reads sideways with a slight upward skew. Financials and capital goods are absorbing FII outflows while IT remains under pressure on weak US tech cues. No clear breakout signal yet, so bias stays neutral with selective bullish setups.",
      points: [
        { label: "Technicals", text: "NIFTY holding 20DMA at 23,180. RSI at 54, MACD flat. Bank NIFTY relatively stronger, breaking out of 54,200 range." },
        { label: "Macro", text: "USD/INR stable. Crude steady near $84. RBI MPC tone cautious but no rate cut catalyst until July." },
        { label: "News Flow", text: "Q4 commentary skewed toward credit growth in financials. Adani group sees inflows on infra capex narrative. IT names downgraded on TCS guidance miss." },
        { label: "Sentiment", text: "Google Trends rising for ETERNAL, SUZLON. Reddit mentions up 18% for ADANIENT. FII net sellers Friday, DII absorbed all of it." },
        { label: "Prior Call Check", text: "Yesterday called NEUTRAL with NIFTY range 23,150 - 23,450. Closed at 23,366. Range hit. Direction correct. Self-feedback applied: confidence trimmed by 4%." },
      ],
    },
  },
  markets: {
    indices: [
      { name: "NIFTY 50", last: "23,366.70", pct: 0.42 },
      { name: "SENSEX", last: "74,243.34", pct: 0.38 },
      { name: "BANK NIFTY", last: "54,496.25", pct: 0.71 },
    ],
    heatmap: [
      { t: "RELIANCE", p: 1.2 }, { t: "TCS", p: -0.8 }, { t: "HDFCBANK", p: 0.5 },
      { t: "INFY", p: -1.4 }, { t: "ICICIBANK", p: 0.9 }, { t: "ITC", p: 0.3 },
      { t: "SBIN", p: 1.8 }, { t: "BHARTIARTL", p: -0.2 }, { t: "LT", p: 2.1 },
      { t: "TITAN", p: 0.4 }, { t: "ADANIENT", p: 3.2 }, { t: "MARUTI", p: -0.6 },
    ],
  },
  portfolio: {
    summary: { invested: 65142, current: 67533, pnl: 2391, pct: 3.67 },
    rows: [
      { ticker: "ANGELONE", qty: 40, avg: 325.82, last: 332.6, pnl: 271, pct: 2.08 },
      { ticker: "GROWW", qty: 65, avg: 208.24, last: 196.09, pnl: -790, pct: -5.83 },
      { ticker: "ETERNAL", qty: 55, avg: 231.91, last: 256.5, pnl: 1352, pct: 10.6 },
      { ticker: "SUZLON", qty: 215, avg: 43.72, last: 55.31, pnl: 2492, pct: 26.5 },
      { ticker: "WAAREERTL", qty: 6, avg: 1126.05, last: 970.25, pnl: -935, pct: -13.85 },
    ],
  },
  wishlist: [
    { t: "VEDL", last: 315.6, pct: 1.2, currency: "₹" },
    { t: "AMBUJACEM", last: 417.55, pct: -0.4, currency: "₹" },
    { t: "ADANIPOWER", last: 232.6, pct: 2.8, currency: "₹" },
    { t: "ADANIGREEN", last: 1525.7, pct: 0.9, currency: "₹" },
    { t: "POWERGRID", last: 285.65, pct: -0.6, currency: "₹" },
    { t: "TATAPOWER", last: 409.2, pct: 1.5, currency: "₹" },
    { t: "NTPC", last: 361.65, pct: 0.7, currency: "₹" },
    { t: "AAPL", last: 215.42, pct: 0.5, currency: "$" },
    { t: "NVDA", last: 142.18, pct: 1.9, currency: "$" },
  ],
  accuracy: {
    overall: 67,
    samples: 142,
    dimensions: [
      { label: "Next Day Direction", w7: 72, w30: 68, w90: 64 },
      { label: "Next Day Range", w7: 60, w30: 62, w90: 58 },
      { label: "Short Picks (7d)", w7: 65, w30: 61, w90: 56 },
      { label: "Short Picks (30d)", w7: null, w30: 58, w90: 54 },
      { label: "Avoid List (7d)", w7: 70, w30: 66, w90: 62 },
    ],
  },
  history: [
    { date: "5 June 2026 · 8:30 AM", mood: "NEUTRAL" as const },
    { date: "4 June 2026 · 8:30 AM", mood: "BULL" as const },
    { date: "3 June 2026 · 8:30 AM", mood: "BULL" as const },
    { date: "2 June 2026 · 8:30 AM", mood: "NEUTRAL" as const },
    { date: "30 May 2026 · 8:30 AM", mood: "BEAR" as const },
    { date: "29 May 2026 · 8:30 AM", mood: "BEAR" as const },
    { date: "28 May 2026 · 8:30 AM", mood: "NEUTRAL" as const },
  ],
};

function MoodPill({ mood }: { mood: "BULL" | "BEAR" | "NEUTRAL" }) {
  const map = { BULL: "pill-gain", BEAR: "pill-loss", NEUTRAL: "pill-warn" };
  const g = { BULL: "↑", BEAR: "↓", NEUTRAL: "→" };
  return (
    <span className={`pill ${map[mood]}`}>
      <span className="glyph !text-current !opacity-100 text-[0.85em]">{g[mood]}</span>
      {mood}
    </span>
  );
}

function VerdictPill({ v }: { v: string }) {
  const map: Record<string, string> = { HOLD: "pill-warn", ADD: "pill-gain", TRIM: "pill-warn", EXIT: "pill-loss" };
  return <span className={`pill ${map[v] || ""}`}>{v}</span>;
}

function readTabFromHash(): TabId {
  if (typeof window === "undefined") return "today";
  const h = window.location.hash.slice(1) as TabId;
  return TAB_IDS.includes(h) ? h : "today";
}

export default function DemoPage() {
  const [tab, setTab] = useState<TabId>("today");

  useEffect(() => {
    setTab(readTabFromHash());
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const labelMap: Record<TabId, string> = {
    today: "Today's read on the Indian Market.",
    markets: "Live Indices, Charts, Heatmap.",
    portfolio: "Your Live Positions.",
    wishlist: "Stocks you are Watching.",
    accuracy: "Self-Learning Scores.",
    history: "Past Market Calls.",
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 pt-20 pb-16 lg:pt-24">
      <div className="mb-8">
        <span className="pill mb-4">Interactive Demo · Sample Data</span>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          {labelMap[tab]}
        </h1>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 14, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          {tab === "today" && <TodayView />}
          {tab === "markets" && <MarketsView />}
          {tab === "portfolio" && <PortfolioView />}
          {tab === "wishlist" && <WishlistView />}
          {tab === "accuracy" && <AccuracyView />}
          {tab === "history" && <HistoryView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function TodayView() {
  const d = SAMPLE.today;
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="card p-5">
          <div className="section-num mb-3">Market Mood</div>
          <MoodPill mood={d.mood} />
        </div>
        <div className="card p-5">
          <div className="section-num mb-2">Confidence</div>
          <div className="text-2xl font-semibold num">{d.confidence}%</div>
        </div>
        <div className="card p-5">
          <div className="section-num mb-2">Last AI Call</div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-xl font-semibold num">{d.date}</div>
            <span className="pill num" style={{
              color: "var(--gain)",
              borderColor: "color-mix(in srgb, var(--gain) 50%, transparent)",
              background: "color-mix(in srgb, var(--gain) 10%, transparent)",
            }}>{d.time}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {[{ name: "Nifty 50", data: d.nifty }, { name: "Sensex", data: d.sensex }].map(({ name, data }) => (
          <div key={name} className="card p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="section-num mb-1.5">{name}</div>
                <div className="text-xl font-semibold capitalize">{data.dir}</div>
              </div>
              <span className="pill num">{data.range}</span>
            </div>
            <ul className="space-y-2 text-sm text-[var(--muted)]">
              {data.drivers.map((dr, i) => (
                <li key={i} className="flex gap-2"><span className="glyph mt-0.5">·</span><span>{dr}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="card p-6 mb-8">
        <div className="section-num mb-3">Reasoning</div>
        <p className="text-sm text-foreground leading-relaxed mb-5 max-w-3xl">
          {d.reasoning.summary}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          {d.reasoning.points.map((p) => (
            <div key={p.label} className="border-l border-border pl-4">
              <div className="text-[0.7rem] uppercase tracking-wider text-[var(--muted)] mb-1.5 font-medium">
                {p.label}
              </div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{p.text}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-border"><div className="section-num">Short Term</div></div>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
            <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Ticker</th>
              <th className="px-4 py-3 font-medium">Entry</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium">Stop</th>
            </tr></thead>
            <tbody>{d.shortTerm.map((r) => (
              <tr key={r.ticker} className="border-t border-border">
                <td className="px-4 py-3 font-medium">{r.ticker}</td>
                <td className="px-4 py-3 num text-[var(--muted)]">{r.entry}</td>
                <td className="px-4 py-3 num text-[var(--gain)]">{r.target}</td>
                <td className="px-4 py-3 num text-[var(--loss)]">{r.stop}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>

        <div className="card overflow-hidden">
          <div className="p-5 border-b border-border"><div className="section-num">Long Term</div></div>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
            <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Ticker</th>
              <th className="px-4 py-3 font-medium">Entry</th>
              <th className="px-4 py-3 font-medium">Target</th>
              <th className="px-4 py-3 font-medium">Stop</th>
            </tr></thead>
            <tbody>{d.longTerm.map((r) => (
              <tr key={r.ticker} className="border-t border-border">
                <td className="px-4 py-3 font-medium">{r.ticker}</td>
                <td className="px-4 py-3 num text-[var(--muted)]">{r.entry}</td>
                <td className="px-4 py-3 num text-[var(--gain)]">{r.target}</td>
                <td className="px-4 py-3 num text-[var(--muted)]">{r.stop}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="p-5 border-b border-border"><div className="section-num">Your Portfolio Verdicts</div></div>
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
            <th className="px-4 py-3 font-medium">Ticker</th>
            <th className="px-4 py-3 font-medium">Verdict</th>
            <th className="px-4 py-3 font-medium">Reason</th>
            <th className="px-4 py-3 font-medium">Target</th>
            <th className="px-4 py-3 font-medium">Stop</th>
          </tr></thead>
          <tbody>{d.verdicts.map((v) => (
            <tr key={v.ticker} className="border-t border-border">
              <td className="px-4 py-3 font-medium">{v.ticker}</td>
              <td className="px-4 py-3"><VerdictPill v={v.verdict} /></td>
              <td className="px-4 py-3 text-[var(--muted)] max-w-md">{v.reason}</td>
              <td className="px-4 py-3 num text-[var(--gain)]">{v.target}</td>
              <td className="px-4 py-3 num text-[var(--loss)]">{v.stop}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

function MarketsView() {
  const d = SAMPLE.markets;
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {d.indices.map((i) => (
          <div key={i.name} className="card p-5">
            <div className="section-num mb-2">{i.name}</div>
            <div className="text-2xl font-semibold num">{i.last}</div>
            <div className={`text-xs num mt-1 font-medium ${i.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>
              {i.pct >= 0 ? "+" : ""}{i.pct.toFixed(2)}%
            </div>
          </div>
        ))}
      </div>

      <div className="card p-6">
        <div className="section-num mb-4">Heatmap (sample)</div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {d.heatmap.map((h) => {
            const c = h.p >= 0 ? "var(--gain)" : "var(--loss)";
            const alpha = Math.min(0.45, 0.08 + Math.abs(h.p) / 5 * 0.4);
            return (
              <div key={h.t} className="rounded-lg border border-border p-3 min-h-[70px] flex flex-col justify-between"
                style={{ background: `color-mix(in srgb, ${c} ${alpha * 100}%, var(--card))` }}>
                <div className="text-xs font-medium">{h.t}</div>
                <div className="text-sm font-semibold num" style={{ color: c }}>
                  {h.p >= 0 ? "+" : ""}{h.p.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PortfolioView() {
  const d = SAMPLE.portfolio;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="card p-5"><div className="section-num mb-2">Invested</div><div className="text-2xl font-semibold num">₹{d.summary.invested.toLocaleString("en-IN")}</div></div>
        <div className="card p-5"><div className="section-num mb-2">Current</div><div className="text-2xl font-semibold num">₹{d.summary.current.toLocaleString("en-IN")}</div></div>
        <div className="card p-5"><div className="section-num mb-2">P&L</div><div className="text-2xl font-semibold num">{d.summary.pnl >= 0 ? "+" : ""}₹{d.summary.pnl.toLocaleString("en-IN")}</div><div className={`text-xs num mt-1 ${d.summary.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>{d.summary.pct >= 0 ? "+" : ""}{d.summary.pct}%</div></div>
        <div className="card p-5"><div className="section-num mb-2">Holdings</div><div className="text-2xl font-semibold num">{d.rows.length}</div></div>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
            <th className="px-4 py-3 font-medium">Ticker</th>
            <th className="px-4 py-3 font-medium">Qty</th>
            <th className="px-4 py-3 font-medium">Avg Buy</th>
            <th className="px-4 py-3 font-medium">Last</th>
            <th className="px-4 py-3 font-medium">P&L</th>
            <th className="px-4 py-3 font-medium">P&L %</th>
          </tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={r.ticker} className="border-t border-border">
              <td className="px-4 py-3 font-medium">{r.ticker}</td>
              <td className="px-4 py-3 num">{r.qty}</td>
              <td className="px-4 py-3 num">₹{r.avg.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className="px-4 py-3 num">₹{r.last.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className={`px-4 py-3 num font-medium whitespace-nowrap ${r.pnl >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>{r.pnl >= 0 ? "+" : ""}₹{r.pnl.toLocaleString("en-IN")}</td>
              <td className={`px-4 py-3 num font-medium ${r.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>{r.pct >= 0 ? "+" : ""}{r.pct.toFixed(2)}%</td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

function WishlistView() {
  const ind = SAMPLE.wishlist.filter((w) => w.currency === "₹");
  const us = SAMPLE.wishlist.filter((w) => w.currency === "$");
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <div className="section-num mb-3">Indian Stocks</div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col style={{ width: "42%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "28%" }} />
            </colgroup>
            <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Ticker</th>
              <th className="px-4 py-3 font-medium">Last</th>
              <th className="px-4 py-3 font-medium">Day %</th>
            </tr></thead>
            <tbody>{ind.map((w) => (
              <tr key={w.t} className="border-t border-border">
                <td className="px-4 py-3 font-medium truncate">{w.t}</td>
                <td className="px-4 py-3 num">₹{w.last.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className={`px-4 py-3 num font-medium ${w.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>{w.pct >= 0 ? "+" : ""}{w.pct.toFixed(2)}%</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div>
        <div className="section-num mb-3">US Stocks</div>
        <div className="card overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col style={{ width: "42%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "28%" }} />
            </colgroup>
            <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Ticker</th>
              <th className="px-4 py-3 font-medium">Last</th>
              <th className="px-4 py-3 font-medium">Day %</th>
            </tr></thead>
            <tbody>{us.map((w) => (
              <tr key={w.t} className="border-t border-border">
                <td className="px-4 py-3 font-medium truncate">{w.t}</td>
                <td className="px-4 py-3 num">${w.last.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className={`px-4 py-3 num font-medium ${w.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}`}>{w.pct >= 0 ? "+" : ""}{w.pct.toFixed(2)}%</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AccuracyView() {
  const d = SAMPLE.accuracy;
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="card p-5"><div className="section-num mb-2">Avg Accuracy</div><div className="text-2xl font-semibold num text-[var(--gain)]">{d.overall}%</div></div>
        <div className="card p-5"><div className="section-num mb-2">Samples</div><div className="text-2xl font-semibold num">{d.samples}</div></div>
        <div className="card p-5"><div className="section-num mb-2">Dimensions</div><div className="text-2xl font-semibold num">{d.dimensions.length}</div></div>
        <div className="card p-5"><div className="section-num mb-2">Window</div><div className="text-2xl font-semibold num">30 days</div></div>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
            <th className="px-4 py-3 font-medium">Dimension</th>
            <th className="px-4 py-3 font-medium">7d</th>
            <th className="px-4 py-3 font-medium">30d</th>
            <th className="px-4 py-3 font-medium">90d</th>
          </tr></thead>
          <tbody>{d.dimensions.map((dim) => (
            <tr key={dim.label} className="border-t border-border">
              <td className="px-4 py-3 font-medium">{dim.label}</td>
              {[dim.w7, dim.w30, dim.w90].map((v, i) => (
                <td key={i} className="px-4 py-3 num font-medium" style={{
                  color: v == null ? "var(--muted)" : v >= 65 ? "var(--gain)" : v >= 50 ? "var(--warn)" : "var(--loss)",
                }}>{v == null ? "·" : `${v}%`}</td>
              ))}
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

function HistoryView() {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
        <thead><tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
          <th className="px-4 py-3 font-medium">When</th>
          <th className="px-4 py-3 font-medium">Mood</th>
        </tr></thead>
        <tbody>{SAMPLE.history.map((h, i) => (
          <tr key={i} className="border-t border-border">
            <td className="px-4 py-3 num">{h.date}</td>
            <td className="px-4 py-3"><MoodPill mood={h.mood} /></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

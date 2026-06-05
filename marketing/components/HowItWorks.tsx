"use client";

import { motion } from "framer-motion";
import { SectionLabel } from "./SectionLabel";

const steps = [
  {
    n: "01",
    title: "Collect",
    body: "Cron fetches NIFTY 50 OHLCV, RSS news, Google Trends, Reddit threads, global indices, plus your INDmoney holdings.",
  },
  {
    n: "02",
    title: "Screen",
    body: "Hand-rolled technical engine computes RSI, MACD, MAs, momentum. Ranks 50+ tickers. Picks top candidates for deep analysis.",
  },
  {
    n: "03",
    title: "Synthesize",
    body: "Gemini reads the bundle plus your prior call plus your accuracy track record. Returns a structured JSON call with reasoning.",
  },
  {
    n: "04",
    title: "Deliver",
    body: "Telegram push at 8:30 AM IST. Live dashboard at arcemdash. Sync button refreshes on demand from any device.",
  },
  {
    n: "05",
    title: "Score",
    body: "Daily 9 PM IST grader compares yesterday's call against today's actuals. Scores every dimension. Feeds back into next call.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="py-28 px-6 bg-[var(--muted-bg)]/30 border-y border-border">
      <div className="max-w-7xl mx-auto">
        <SectionLabel num="003" title="How It Works" />
        <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-14 max-w-3xl">
          Five steps. Repeat <span className="italic">forever.</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-5">
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: i * 0.06 }}
              className="card p-6 relative"
            >
              <div className="section-num !text-foreground mb-4">{s.n}</div>
              <h3 className="text-base font-semibold tracking-tight mb-2">{s.title}</h3>
              <p className="text-xs text-[var(--muted)] leading-relaxed">{s.body}</p>
              {i < steps.length - 1 && (
                <span className="hidden lg:block absolute top-1/2 -right-3 text-[var(--muted)] glyph text-xl">
                  →
                </span>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

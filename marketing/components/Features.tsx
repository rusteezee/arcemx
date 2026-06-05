"use client";

import { motion } from "framer-motion";
import { SectionLabel } from "./SectionLabel";
import {
  Brain, LineChart, Newspaper, TrendingUp,
  Briefcase, Award, Workflow,
} from "lucide-react";

const features = [
  {
    n: "001",
    icon: Brain,
    title: "Gemini-powered Brain",
    body: "Each call is a fresh JSON synthesis of 30+ signals across price action, news flow, and sentiment, validated against a structured schema.",
  },
  {
    n: "002",
    icon: TrendingUp,
    title: "Technical Screener",
    body: "RSI, MACD, moving averages, momentum, volume confirmation. Top 15 bullish and bearish candidates surfaced before the LLM ever runs.",
  },
  {
    n: "003",
    icon: Newspaper,
    title: "News Sentiment",
    body: "Live RSS from Moneycontrol, ET, Bloomberg, Reuters plus a 72 hour DB lookback so no signal is lost across weekends or gaps.",
  },
  {
    n: "004",
    icon: LineChart,
    title: "Search and Social",
    body: "Google Trends interest plus Reddit hot threads from Indian investing subs. Catches retail mood shifts before they hit price.",
  },
  {
    n: "005",
    icon: Briefcase,
    title: "INDmoney Sync",
    body: "Live OAuth connection to your INDmoney holdings and watchlist. Per stock hold, add, trim, or exit verdicts on every call.",
  },
  {
    n: "006",
    icon: Award,
    title: "Self-learning Loop",
    body: "Every past prediction is scored on direction, range, picks, and avoid lists. The next call sees its own track record and calibrates.",
  },
  {
    n: "007",
    icon: Workflow,
    title: "Automation",
    body: "Daily 8:30 AM IST cron pushes to Telegram. Sync from any browser. Render plus Netlify plus Supabase plus Gemini. All free tier.",
  },
];

export function Features() {
  return (
    <section id="features" className="py-28 px-6 relative">
      <div className="max-w-7xl mx-auto">
        <SectionLabel num="002" title="Features" />
        <h2 className="text-4xl md:text-5xl font-semibold tracking-tight mb-4 max-w-3xl">
          Seven layers between you<br />
          and a <span className="italic">guess.</span>
        </h2>
        <p className="sub-headline max-w-2xl mb-14">
          Every component is designed to reduce uncertainty. Together they form a feedback-driven intelligence stack.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => {
            const Icon = f.icon;
            return (
              <motion.div
                key={f.n}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1], delay: i * 0.04 }}
                className="card p-7 flex flex-col"
              >
                <div className="flex items-start justify-between mb-6">
                  <Icon className="size-5 text-foreground" strokeWidth={1.6} />
                  <span className="section-num">{f.n}</span>
                </div>
                <h3 className="text-lg font-semibold mb-2 tracking-tight">{f.title}</h3>
                <p className="text-sm text-[var(--muted)] leading-relaxed">{f.body}</p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

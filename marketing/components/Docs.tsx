"use client";

import { motion } from "framer-motion";
import { SectionLabel } from "./SectionLabel";
import { Code2 } from "lucide-react";

const REPO_URL = "https://github.com/rusteezee/arcemx";
const DASHBOARD_URL = "https://arcemdash.arcarmor.co.in";

const steps = [
  {
    n: "01",
    t: "Clone the Repo",
    body: "Pull arcemx from GitHub. Pure Python plus Next.js. Open source. Self host or fork.",
    code: "gh repo clone rusteezee/arcemx",
  },
  {
    n: "02",
    t: "Spin Up Services",
    body: "Free tier on Supabase, Render, Netlify. Gemini API key from AI Studio. Telegram bot from BotFather.",
    code: "cp .env.example .env\\nnotepad .env",
  },
  {
    n: "03",
    t: "Connect INDmoney",
    body: "One time browser OAuth. Tokens persist in Supabase. Refreshes silently. Re-auth only if INDmoney rotates credentials.",
    code: "python -m fetchers.indmoney_auth",
  },
  {
    n: "04",
    t: "Schedule the Loop",
    body: "GitHub Actions cron at 8:30 AM IST for analysis. 9:00 PM IST for grader. Render runs the Telegram bot.",
    code: "git push  # CI takes over",
  },
];

export function Docs() {
  return (
    <section id="docs" className="py-28 px-6">
      <div className="max-w-7xl mx-auto">
        <SectionLabel num="006" title="Build It Yourself" />
        <div className="flex items-end justify-between flex-wrap gap-4 mb-12">
          <h2 className="text-4xl md:text-5xl font-semibold tracking-tight max-w-3xl">
            Documented. Open source.<br />
            <span className="italic">Zero lock-in.</span>
          </h2>
          <a href={REPO_URL} target="_blank" rel="noopener" className="btn-primary">
            <Code2 className="size-4" /> View Repo
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.05 }}
              className="card p-7"
            >
              <div className="flex items-baseline justify-between mb-4">
                <div className="section-num !text-foreground">{s.n}</div>
                <span className="glyph">✦</span>
              </div>
              <h3 className="text-lg font-semibold tracking-tight mb-2">{s.t}</h3>
              <p className="text-sm text-[var(--muted)] leading-relaxed mb-4">{s.body}</p>
              <div className="card !bg-[var(--background)] p-3 font-mono text-xs text-[var(--muted)] whitespace-pre">
                {s.code.replace(/\\n/g, "\n")}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

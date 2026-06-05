"use client";

import { motion } from "framer-motion";
import { SectionLabel } from "./SectionLabel";

const stats = [
  { n: "0", l: "Cost per month" },
  { n: "30+", l: "Signals per call" },
  { n: "72h", l: "News lookback" },
  { n: "1M", l: "Gemini context tokens" },
  { n: "6", l: "Accuracy dimensions" },
  { n: "8:30", l: "AM IST daily push" },
];

export function Stats() {
  return (
    <section className="py-24 px-6 border-y border-border bg-[var(--muted-bg)]/20">
      <div className="max-w-7xl mx-auto">
        <SectionLabel num="005" title="By the Numbers" />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {stats.map((s, i) => (
            <motion.div
              key={s.l}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.5, delay: i * 0.04 }}
              className="text-center p-4"
            >
              <div className="text-4xl md:text-5xl font-semibold tracking-tight num">{s.n}</div>
              <div className="section-num mt-2">{s.l}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

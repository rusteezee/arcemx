"use client";

import { motion } from "framer-motion";
import { SectionLabel } from "./SectionLabel";
import { ArrowUpRight } from "lucide-react";

const DEMO_URL = "/demo";

// Static dummy data so this works without backend
const SAMPLE = {
  mood: "NEUTRAL",
  confidence: 62,
  date: "5 June 2026",
  time: "8:30 AM",
  nifty: { dir: "Sideways", range: "23,200 - 23,500" },
  sensex: { dir: "Sideways", range: "73,800 - 74,500" },
  shortTerm: [
    { t: "ADANIENT", e: "₹3,040 - ₹3,050", g: "₹3,150 - ₹3,200", s: "₹2,980" },
    { t: "TITAN", e: "₹4,200 - ₹4,250", g: "₹4,350 - ₹4,400", s: "₹4,180" },
    { t: "COALINDIA", e: "₹470 - ₹475", g: "₹485 - ₹490", s: "₹465" },
  ],
  accuracy: { dir: 72, range: 64, picks: 58 },
};

function MoodChip({ mood }: { mood: string }) {
  const klass = mood === "BULL" ? "pill-gain" : mood === "BEAR" ? "pill-loss" : "pill-warn";
  const glyph = mood === "BULL" ? "↑" : mood === "BEAR" ? "↓" : "→";
  return (
    <span className={`pill ${klass}`}>
      <span className="glyph !text-current !opacity-100 text-[0.85em]">{glyph}</span>
      {mood}
    </span>
  );
}

export function Demo() {
  return (
    <section id="demo" className="py-28 px-6 relative">
      <div className="max-w-7xl mx-auto">
        <SectionLabel num="004" title="Demo" />
        <div className="flex items-end justify-between flex-wrap gap-4 mb-12">
          <h2 className="text-4xl md:text-5xl font-semibold tracking-tight max-w-3xl">
            A peek at what runs<br />
            on the <span className="italic">real dashboard.</span>
          </h2>
          <a href={DEMO_URL} className="btn-ghost">
            Try Dashboard <ArrowUpRight className="size-4" />
          </a>
        </div>

        {/* Mock dashboard surface */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="card p-6 md:p-10"
        >
          <div className="section-num mb-3">000 · Daily Call · Preview</div>
          <h3 className="text-3xl md:text-4xl font-semibold tracking-tight mb-2 max-w-2xl">
            Today&apos;s read on the <span className="italic">Indian Market.</span>
          </h3>
          <p className="sub-headline mb-8 max-w-xl">Sample output. Live dashboard refreshes on demand.</p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-10">
            <div className="card p-5">
              <div className="section-num mb-3">Market Mood</div>
              <MoodChip mood={SAMPLE.mood} />
            </div>
            <div className="card p-5">
              <div className="section-num mb-2">Confidence</div>
              <div className="text-2xl font-semibold num">{SAMPLE.confidence}%</div>
            </div>
            <div className="card p-5">
              <div className="section-num mb-2">Last AI Call</div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="text-xl font-semibold tracking-tight num">{SAMPLE.date}</div>
                <span className="pill num" style={{
                  color: "var(--gain)",
                  borderColor: "color-mix(in srgb, var(--gain) 50%, transparent)",
                  background: "color-mix(in srgb, var(--gain) 10%, transparent)",
                }}>{SAMPLE.time}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-10">
            {[
              { name: "Nifty 50", data: SAMPLE.nifty },
              { name: "Sensex", data: SAMPLE.sensex },
            ].map((idx) => (
              <div key={idx.name} className="card p-6">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="section-num mb-1.5">{idx.name}</div>
                    <div className="text-xl font-semibold capitalize">{idx.data.dir}</div>
                  </div>
                  <span className="pill num">{idx.data.range}</span>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  Driven by global mixed cues, Q4 earnings tape, FII flow patterns, and recent RBI tone.
                </p>
              </div>
            ))}
          </div>

          <div className="card overflow-hidden mb-10">
            <div className="p-5 border-b border-border">
              <div className="section-num">Short Term Picks</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-[var(--muted)] text-[0.7rem] uppercase tracking-wider">
                    <th className="px-4 py-3 font-medium">Ticker</th>
                    <th className="px-4 py-3 font-medium">Entry</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Stop</th>
                  </tr>
                </thead>
                <tbody>
                  {SAMPLE.shortTerm.map((r) => (
                    <tr key={r.t} className="border-t border-border">
                      <td className="px-4 py-3 font-medium">{r.t}</td>
                      <td className="px-4 py-3 num text-[var(--muted)] whitespace-nowrap">{r.e}</td>
                      <td className="px-4 py-3 num text-[var(--gain)] whitespace-nowrap">{r.g}</td>
                      <td className="px-4 py-3 num text-[var(--loss)] whitespace-nowrap">{r.s}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { l: "Direction Accuracy (30d)", v: SAMPLE.accuracy.dir },
              { l: "Range Accuracy (30d)", v: SAMPLE.accuracy.range },
              { l: "Pick Edge vs NIFTY", v: SAMPLE.accuracy.picks },
            ].map((m) => (
              <div key={m.l} className="card p-5">
                <div className="section-num mb-2">{m.l}</div>
                <div className="text-2xl font-semibold num"
                  style={{ color: m.v >= 65 ? "var(--gain)" : m.v >= 50 ? "var(--warn)" : "var(--loss)" }}
                >{m.v}%</div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

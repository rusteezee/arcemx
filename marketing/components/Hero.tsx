"use client";

import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";

const DEMO_URL = "/demo";

export function Hero() {
  return (
    <section className="relative pt-32 pb-24 px-6 overflow-hidden">
      <div className="relative max-w-5xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="inline-flex items-center gap-2 pill mb-7"
        >
          <Sparkles className="size-3.5" />
          <span>AI Market Intelligence for India</span>
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
          className="headline mb-6"
        >
          Read the Indian Market<br />
          <span className="italic">Before It Moves.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
          className="sub-headline max-w-2xl mx-auto mb-10"
        >
          A self-learning AI that synthesises technicals, news, search trends, global cues, and your INDmoney portfolio into a daily call. It scores every prediction. It gets sharper every run.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
          className="flex items-center justify-center gap-3 flex-wrap"
        >
          <a href={DEMO_URL} className="btn-primary">
            Try Dashboard <ArrowRight className="size-4" />
          </a>
          <a href="#features" className="btn-ghost">
            See Features
          </a>
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.35 }}
          className="mt-16 flex items-center justify-center gap-6 text-xs text-[var(--muted)] flex-wrap"
        >
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--gain)] inline-block" />
            Zero-cost stack
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--gain)] inline-block" />
            Self-learning loop
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--gain)] inline-block" />
            Telegram + Web
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-[var(--gain)] inline-block" />
            INDmoney sync
          </span>
        </motion.div>
      </div>
    </section>
  );
}

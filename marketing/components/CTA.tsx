"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";

const DEMO_URL = "/demo";

export function CTA() {
  return (
    <section className="py-32 px-6 border-y border-border">
      <div className="max-w-4xl mx-auto text-center">
        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-5xl md:text-6xl font-semibold tracking-tight mb-6"
        >
          Stop guessing.<br />
          Start <span className="italic">reading the tape.</span>
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="sub-headline mb-10"
        >
          A daily market call that learns from itself. Open the dashboard now.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="flex items-center justify-center gap-3 flex-wrap"
        >
          <a href={DEMO_URL} className="btn-primary">
            Try Dashboard <ArrowRight className="size-4" />
          </a>
        </motion.div>
      </div>
    </section>
  );
}

"use client";

import { Code2 } from "lucide-react";

const DEMO_URL = "/demo";
const REPO_URL = "https://github.com/rusteezee/arcemx";

export function Footer() {
  return (
    <footer className="px-6 py-12">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-10">
          <div className="md:col-span-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-banner.svg" alt="Arc'emX!" className="h-7 w-auto mb-4" />
            <p className="text-sm text-[var(--muted)] max-w-sm leading-relaxed">
              AI market intelligence for the Indian equity market. Built with intent. Released to the public.
            </p>
          </div>
          <div>
            <div className="section-num mb-4">Product</div>
            <ul className="space-y-2.5 text-sm">
              <li><a href="#features" className="text-[var(--muted)] hover:text-foreground transition-colors">Features</a></li>
              <li><a href="#how" className="text-[var(--muted)] hover:text-foreground transition-colors">How It Works</a></li>
              <li><a href="#demo" className="text-[var(--muted)] hover:text-foreground transition-colors">Demo</a></li>
              <li><a href={DEMO_URL} className="text-[var(--muted)] hover:text-foreground transition-colors">Try Dashboard</a></li>
            </ul>
          </div>
          <div>
            <div className="section-num mb-4">Build</div>
            <ul className="space-y-2.5 text-sm">
              <li><a href="#docs" className="text-[var(--muted)] hover:text-foreground transition-colors">Docs</a></li>
              <li><a href={REPO_URL} target="_blank" rel="noopener" className="text-[var(--muted)] hover:text-foreground transition-colors flex items-center gap-1.5">
                <Code2 className="size-3.5" /> GitHub
              </a></li>
            </ul>
          </div>
        </div>
        <div className="pt-8 border-t border-border flex items-center justify-between flex-wrap gap-4 text-xs text-[var(--muted)]">
          <div className="flex items-baseline gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.svg" alt="" aria-hidden className="h-5 w-auto" />
            <span>Arc&apos;emX! · Built with intent.</span>
          </div>
          <span className="pill text-[0.7rem] tracking-wide">
            Not SEBI registered investment advice. Educational only.
          </span>
        </div>
      </div>
    </footer>
  );
}

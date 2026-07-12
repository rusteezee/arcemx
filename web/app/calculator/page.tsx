"use client";

import { Section } from "@/components/Section";
import { Calculator } from "@/components/Calculator";

export default function CalculatorPage() {
  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Calculator</div>
        <h1 className="headline mb-3">
          Size Your <span className="italic">Allocation.</span>
        </h1>
      </div>

      <Section
        num="001 / 001"
        title="Sensei's Calculator"
        glyph="✦"
        description="Tell Sensei how much you want to deploy, for how long, and how much risk you can stomach. A deterministic prefilter ranks the universe by momentum + RSI + realized vol and proposes an allocation. Ask Sensei wraps the picks with macro and sector context."
      >
        <Calculator />
      </Section>
    </>
  );
}

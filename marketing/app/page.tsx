import { Hero } from "@/components/Hero";
import { Features } from "@/components/Features";
import { HowItWorks } from "@/components/HowItWorks";
import { Demo } from "@/components/Demo";
import { Stats } from "@/components/Stats";
import { Docs } from "@/components/Docs";
import { CTA } from "@/components/CTA";
import { Footer } from "@/components/Footer";

export default function Landing() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <Demo />
      <Stats />
      <Docs />
      <CTA />
      <Footer />
    </>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
import { PageTransition } from "@/components/PageTransition";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Arc'emX! — Market intelligence",
  description: "AI driven market intelligence for the Indian equity market.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Nav />
        <main className="flex-1">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-20 pb-10 lg:pt-24 lg:pb-14">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
        <footer className="border-t border-border py-8 mt-10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 flex flex-col sm:flex-row justify-between sm:items-center items-start gap-4 text-xs text-[var(--muted)]">
            <div className="flex items-baseline gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo-mark.svg"
                alt=""
                aria-hidden
                className="h-6 w-auto select-none pointer-events-none shrink-0"
                draggable={false}
              />
              <span>Arc&apos;emX! · Built with intent.</span>
            </div>
            <span className="pill text-[0.7rem] tracking-wide self-start sm:self-auto">
              Not SEBI registered investment advice. Educational only.
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}

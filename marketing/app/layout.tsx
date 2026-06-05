import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/Nav";
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
  title: "Arc'emX! — AI Market Intelligence for India",
  description:
    "A self-learning AI that reads the Indian equity market every morning. Built on Gemini, Supabase, and free-tier infra.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col relative">
        <div className="spotlight" aria-hidden />
        <Nav />
        <main className="flex-1 relative z-10">{children}</main>
      </body>
    </html>
  );
}

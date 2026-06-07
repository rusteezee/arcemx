"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { Stat } from "@/components/Stat";
import { MoodPill } from "@/components/MoodPill";
import { EmptyState } from "@/components/EmptyState";
import { sb } from "@/lib/supabase";
import { formatINR, formatNumber } from "@/lib/utils";

export default function TodayPage() {
  const [analysis, setAnalysis] = useState<any>(null);
  const [lastSyncTs, setLastSyncTs] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: aData }, lsRes] = await Promise.all([
        sb
          .from("analysis")
          .select("*")
          .order("run_at", { ascending: false })
          .limit(1),
        // Pull the same "latest of analysis or sync_log" timestamp the
        // nav indicator uses so this page's "Last Update" card and the
        // nav badge always agree on the most recent refresh moment.
        fetch("/api/last-sync", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setAnalysis(aData?.[0] || null);
      setLastSyncTs(lsRes?.ts || null);
      setLoading(false);
    })();
  }, []);

  if (!loading && !analysis) {
    return (
      <EmptyState
        title="No analysis yet."
        hint="Run the aggregator from the Python repo or wait for the next cron."
      />
    );
  }

  const raw = analysis?.raw_json || {};
  const mood = raw.market_mood || "neutral";
  const conf = raw.confidence || 0;
  // Show the most recent of (analysis.run_at, sync_log latest) so this
  // card reads the same as the nav badge. The two events refresh
  // different parts of the dashboard (AI call vs INDmoney positions),
  // but the user just wants one "this is how fresh the page is" number.
  const analysisTs = analysis?.run_at ? new Date(analysis.run_at) : null;
  const syncTs = lastSyncTs ? new Date(lastSyncTs) : null;
  const runAtDate =
    syncTs && analysisTs
      ? syncTs > analysisTs
        ? syncTs
        : analysisTs
      : syncTs ?? analysisTs;
  const runDateStr = runAtDate
    ? runAtDate.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric", month: "long", year: "numeric",
      })
    : "·";
  const runTimeStr = runAtDate
    ? runAtDate
        .toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "numeric", minute: "2-digit", hour12: true,
        })
        .replace(/am|pm/i, (m) => m.toUpperCase())
        .replace(/\s+/g, " ")
    : "";
  const no = raw.nifty_outlook || {};
  const so = raw.sensex_outlook || {};

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · Daily Call</div>
        <h1 className="headline mb-3">
          Today&apos;s read on the <span className="italic">Indian Market</span>.
        </h1>
        <p className="sub-headline max-w-2xl">
          Gemini synthesises technicals, news flow, search interest, and global cues every weekday at 8:30 AM IST. The sync button refreshes both your INDmoney positions and this call on demand.
        </p>
      </div>

      <Section num="001 / 005" title="Snapshot" glyph="✦">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="card p-5">
            <div className="section-num mb-3">Market Mood</div>
            <MoodPill mood={mood} size="lg" />
          </div>
          <Stat label="Confidence" value={`${conf}%`} glyph="◎" />
          <div className="card p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="section-num">Last Update</div>
              <span className="glyph text-sm">◈</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="text-2xl font-semibold tracking-tight num">{runDateStr}</div>
              {runTimeStr && (
                <span
                  className="pill num"
                  style={{
                    color: "var(--gain)",
                    borderColor: "color-mix(in srgb, var(--gain) 50%, transparent)",
                    background: "color-mix(in srgb, var(--gain) 10%, transparent)",
                  }}
                >
                  {runTimeStr}
                </span>
              )}
            </div>
          </div>
        </div>
      </Section>

      <Section num="002 / 005" title="Index Outlooks" glyph="◈">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            { name: "Nifty 50", data: no },
            { name: "Sensex", data: so },
          ].map(({ name, data }) => (
            <div key={name} className="card p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="section-num mb-1.5">{name}</div>
                  <div className="text-xl font-semibold capitalize">
                    {data.direction || "Unknown"}
                  </div>
                </div>
                <span className="pill num">{formatNumber(data.range)}</span>
              </div>
              {data.drivers?.length > 0 && (
                <ul className="space-y-2 text-sm text-[var(--muted)]">
                  {data.drivers.map((d: string, i: number) => (
                    <li key={i} className="flex gap-3">
                      <span className="glyph mt-0.5">·</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section num="003 / 005" title="Picks" glyph="◉">
        {/*
          items-start lets each table size to its own row count instead
          of stretching to the taller sibling. Short Term with 3 picks
          and Long Term with 2 picks no longer leave dead space below
          the shorter card.
        */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <PickTable title="Short Term" rows={raw.short_term_picks || []} />
          <PickTable title="Long Term" rows={raw.long_term_picks || []} />
        </div>
      </Section>

      <Section num="004 / 005" title="Your Portfolio Verdicts" glyph="⬡">
        {raw.portfolio_verdicts?.length ? (
          <div className="card overflow-hidden">
            <table className="data">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Verdict</th>
                  <th>Reason</th>
                  <th>Target</th>
                  <th>Stop loss</th>
                </tr>
              </thead>
              <tbody>
                {raw.portfolio_verdicts.map((v: any, i: number) => (
                  <tr key={i}>
                    <td className="font-medium">{v.ticker}</td>
                    <td>
                      <VerdictPill v={v.verdict} />
                    </td>
                    <td className="text-[var(--muted)] max-w-md">{v.reason}</td>
                    <td className="num text-[var(--gain)]">{formatINR(v.target)}</td>
                    <td className="num text-[var(--loss)]">{formatINR(v.stop_loss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Sync portfolio via Telegram" hint="Send /sync to the bot, then refresh." />
        )}
      </Section>

      <Section num="005 / 005" title="Reasoning" glyph="✦">
        <ReasoningCard summary={raw.reasoning} breakdown={raw.reasoning_breakdown} />
      </Section>
    </>
  );
}

function PickTable({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="p-5 border-b border-border">
        <div className="section-num mb-1">{title}</div>
      </div>
      {rows.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Entry</th>
              <th>Target</th>
              <th>Stop Loss</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="font-medium">{r.ticker}</td>
                <td className="num">{formatINR(r.entry || r.entry_zone)}</td>
                <td className="num text-[var(--gain)]">{formatINR(r.target)}</td>
                <td className="num text-[var(--loss)]">{formatINR(r.stop_loss)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="p-8 text-center text-sm text-[var(--muted)]">None today</div>
      )}
    </div>
  );
}

function VerdictPill({ v }: { v: string }) {
  const map: Record<string, string> = {
    hold: "pill-warn",
    add: "pill-gain",
    trim: "pill-warn",
    exit: "pill-loss",
  };
  return <span className={`pill ${map[v?.toLowerCase()] || ""}`}>{v?.toUpperCase()}</span>;
}

const REASONING_LABELS: Record<string, string> = {
  technicals: "Technicals",
  macro: "Macro",
  news_flow: "News Flow",
  sentiment: "Sentiment",
  prior_call_check: "Prior Call Check",
};

function ReasoningCard({
  summary,
  breakdown,
}: {
  summary?: string;
  breakdown?: Record<string, string> | null;
}) {
  const points = breakdown
    ? Object.entries(breakdown).filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    : [];

  if (!summary && points.length === 0) {
    return (
      <div className="card p-6">
        <p className="text-sm leading-relaxed text-[var(--muted)]">No reasoning available.</p>
      </div>
    );
  }

  return (
    <div className="card p-6 md:p-8">
      {summary && (
        <p className="text-sm md:text-[0.95rem] text-foreground leading-relaxed mb-6 max-w-3xl">
          {summary}
        </p>
      )}
      {points.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {points.map(([key, text]) => (
            <div key={key} className="border-l border-border pl-4">
              <div className="text-[0.7rem] uppercase tracking-wider text-[var(--muted)] mb-1.5 font-medium">
                {REASONING_LABELS[key] || key.replace(/_/g, " ")}
              </div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

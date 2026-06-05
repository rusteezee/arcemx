"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { LineChart } from "@/components/LineChart";
import { MoodPill } from "@/components/MoodPill";
import { sb } from "@/lib/supabase";

export default function HistoryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("analysis")
        .select("run_at, market_mood")
        .order("run_at", { ascending: false })
        .limit(60);
      setRows(data || []);
      setLoading(false);
    })();
  }, []);

  if (!loading && !rows.length) return <EmptyState title="No history yet." />;

  const moodScore = (m: string) =>
    ({ bull: 1, neutral: 0, bear: -1 } as Record<string, number>)[m?.toLowerCase()] ?? 0;

  const chart = [...rows]
    .reverse()
    .map((r) => ({ date: r.run_at.slice(0, 10), value: moodScore(r.market_mood) }));

  return (
    <>
      <div className="mb-12">
        <div className="section-num mb-2">000 · History</div>
        <h1 className="headline mb-3">
          Past <span className="italic">Market Calls.</span>
        </h1>
      </div>

      <Section
        num="001 / 002"
        title="Mood Timeline"
        glyph="✦"
        description="Last 60 calls. Plus one bull, zero neutral, minus one bear."
      >
        <div className="card p-6">
          <LineChart data={chart} height={300} color="var(--foreground)" fill={false} />
        </div>
      </Section>

      <Section num="002 / 002" title="Call Log" glyph="◈">
        <div className="card overflow-hidden">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Mood</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const d = new Date(r.run_at);
                const datePart = d.toLocaleDateString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "numeric", month: "long", year: "numeric",
                });
                const timePart = d
                  .toLocaleTimeString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    hour: "numeric", minute: "2-digit", hour12: true,
                  })
                  .replace(/am|pm/i, (m) => m.toUpperCase())
                  .replace(/\s+/g, " ");
                return (
                  <tr key={i}>
                    <td className="num">{datePart} · {timePart}</td>
                    <td><MoodPill mood={r.market_mood} size="sm" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

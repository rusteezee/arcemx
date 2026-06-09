"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { TriggerButton } from "@/components/TriggerButton";
import { sb } from "@/lib/supabase";

interface SenseiRow {
  id: number;
  run_at: string;
  analysis_id: number | null;
  market_close_date: string;
  model_used: string | null;
  raw_json: any;
  what_worked: any[] | null;
  what_missed: any[] | null;
  conviction_review: any;
  key_insights: string[] | null;
  tomorrow_watch: string[] | null;
  calibration_note: string | null;
  insight_quality_avg: number | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "·";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export default function SenseiPage() {
  const [row, setRow] = useState<SenseiRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from("sensei_eod")
        .select(
          "id,run_at,analysis_id,market_close_date,model_used,raw_json,what_worked,what_missed,conviction_review,key_insights,tomorrow_watch,calibration_note,insight_quality_avg"
        )
        .order("market_close_date", { ascending: false })
        .limit(1);
      setRow(((data || [])[0] as SenseiRow) || null);
      setLoading(false);
    })();
  }, []);

  if (!loading && !row) {
    return (
      <main className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 pb-24">
        <div className="mb-6 flex justify-end">
          <TriggerButton
            endpoint="/api/trigger-sensei"
            label="Run Sensei"
            queuedLabel="Queued"
            title="Run Sensei now against the latest morning analysis."
          />
        </div>
        <EmptyState
          title="No Sensei retrospective yet."
          hint="Sensei runs at 8:00 PM IST Mon-Fri after market close and the grader pass. First row lands after today's session is reviewed."
        />
      </main>
    );
  }

  if (!row) return null;
  const conv = row.conviction_review || {};

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 pb-24">
      <header className="mb-10">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="section-num mb-2">Sensei · EOD Retrospective</div>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              What the analyst learned today
            </h1>
            <p className="sub-headline mt-2 max-w-2xl">
              End-of-day synthesis over today's morning call, actual closes, and graded scores.
              Tomorrow's morning call reads this before forecasting.
            </p>
          </div>
          <TriggerButton
            endpoint="/api/trigger-sensei"
            label="Run Sensei"
            queuedLabel="Queued"
            title="Run Sensei now against the latest morning analysis. Result lands in 3-12 minutes; refresh the page after."
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-[var(--muted)]">
          <span>Close date: {row.market_close_date}</span>
          <span>·</span>
          <span>Synthesised: {fmtDate(row.run_at)}</span>
          {row.model_used && (
            <>
              <span>·</span>
              <span>Model: {row.model_used}</span>
            </>
          )}
          {typeof row.insight_quality_avg === "number" && (
            <>
              <span>·</span>
              <span>Reasoning quality: {row.insight_quality_avg}</span>
            </>
          )}
        </div>
      </header>

      <Section
        num="001 / 007"
        title="Today's Reading"
        glyph="◈"
        description="One-line calibration note on stated confidence vs realized accuracy."
      >
        <div className="card p-5">
          <p className="text-base leading-relaxed">
            {row.calibration_note || "No calibration note returned."}
          </p>
        </div>
      </Section>

      <Section
        num="002 / 007"
        title="What Worked"
        glyph="◉"
        description="Calls that scored well. Read the evidence column for the numbers."
      >
        {row.what_worked && row.what_worked.length > 0 ? (
          <div className="card overflow-hidden">
            <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                <col style={{ width: "32%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "12%" }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Dimension</th>
                  <th>Score</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {row.what_worked.map((w: any, i: number) => (
                  <tr key={i} className="align-top">
                    <td className="font-medium align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {w.call}
                    </td>
                    <td className="num align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {w.dimension || "·"}
                    </td>
                    <td className="num align-top">{w.score_pct ?? "·"}</td>
                    <td className="text-[var(--muted)] text-sm align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }} title={w.evidence}>
                      {w.evidence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No graded wins yet today." hint="" />
        )}
      </Section>

      <Section
        num="003 / 007"
        title="What Missed"
        glyph="◉"
        description="Calls that scored poorly. Root-cause column tags why."
      >
        {row.what_missed && row.what_missed.length > 0 ? (
          <div className="card overflow-hidden">
            <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                <col style={{ width: "26%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "24%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Dimension</th>
                  <th>Actual</th>
                  <th>Gap</th>
                  <th>Root Cause</th>
                </tr>
              </thead>
              <tbody>
                {row.what_missed.map((m: any, i: number) => (
                  <tr key={i} className="align-top">
                    <td className="font-medium align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {m.call}
                    </td>
                    <td className="num align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {m.dimension || "·"}
                    </td>
                    <td className="num align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {m.actual ?? "·"}
                    </td>
                    <td className="num align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {m.gap ?? "·"}
                    </td>
                    <td className="text-[var(--muted)] text-sm align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {m.root_cause || "·"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No graded misses today." hint="" />
        )}
      </Section>

      <Section
        num="004 / 007"
        title="Conviction Tier Review"
        glyph="◉"
        description="Did A / B / C labels track actual performance? Inflated tiers will surface here."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {([
            { key: "tier_A", label: "A", pill: "pill-gain", accent: "var(--gain)" },
            { key: "tier_B", label: "B", pill: "", accent: "var(--border)" },
            { key: "tier_C", label: "C", pill: "pill-warn", accent: "var(--warn)" },
          ] as const).map(({ key, label, pill, accent }) => {
            const t = (conv && (conv as any)[key]) || {};
            return (
              <div
                key={key}
                className="card p-5"
                style={{ borderTop: `2px solid ${accent}` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className={`pill ${pill}`} style={{ minWidth: 50, justifyContent: "center" }}>
                    Tier {label}
                  </span>
                </div>
                <div className="text-2xl font-semibold mb-2">
                  {(t.n_hits ?? "·")} / {(t.n_picks ?? "·")}
                </div>
                <p className="text-sm text-[var(--muted)] leading-relaxed">
                  {t.comment || "No picks at this tier today."}
                </p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        num="005 / 007"
        title="Key Insights"
        glyph="◉"
        description="Actionable reads of today's data. Each cites at least two numbers."
      >
        {row.key_insights && row.key_insights.length > 0 ? (
          <div className="card p-5">
            <ul className="list-disc pl-6 space-y-2.5 text-sm leading-relaxed">
              {row.key_insights.map((s: string, i: number) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState title="No insights returned." hint="" />
        )}
      </Section>

      <Section
        num="006 / 007"
        title="Tomorrow Watch"
        glyph="⬡"
        description="Specific levels and events to track at next open. Read these before the morning."
      >
        {row.tomorrow_watch && row.tomorrow_watch.length > 0 ? (
          <div className="card p-5">
            <ul className="list-disc pl-6 space-y-2.5 text-sm leading-relaxed">
              {row.tomorrow_watch.map((s: string, i: number) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState title="No watch items returned." hint="" />
        )}
      </Section>

      <Section
        num="007 / 007"
        title="Source"
        glyph="✦"
        description="Reference to the morning call this retrospective covers."
      >
        <div className="card p-5 text-sm text-[var(--muted)] leading-relaxed">
          Built from analysis_id {row.analysis_id ?? "·"} ({row.market_close_date}). Model:{" "}
          {row.model_used || "unknown"}. Reasoning quality (today):{" "}
          {row.insight_quality_avg ?? "·"}.
        </div>
      </Section>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
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

// Human labels for grader dimension identifiers. The model emits raw
// dim names like "direction_1d" in what_worked / what_missed; we never
// render those bare. Anything not in the map falls back to a title-cased
// fragment so a future dim still renders readably without a code change.
const DIM_LABEL: Record<string, string> = {
  market_mood_1d: "Market Mood (1d)",
  direction_1d: "NIFTY Direction (1d)",
  range_1d: "NIFTY Range (1d)",
  direction_5d: "NIFTY Trend (5d)",
  direction_20d: "NIFTY Trend (20d)",
  vol_regime_5d: "Volatility Regime (5d)",
  sensex_direction_1d: "Sensex Direction (1d)",
  sensex_range_1d: "Sensex Range (1d)",
  pick_tp_sl: "Short Pick Target / Stop (10d)",
  short_pick_7d: "Short Picks (7d)",
  short_pick_14d: "Short Picks (14d)",
  short_pick_30d: "Short Picks (30d)",
  long_pick_180d: "Long Picks (180d)",
  long_pick_tp_sl: "Long Pick Target / Stop (60d)",
  avoid_7d: "Avoid List (7d)",
  verdict_7d: "Portfolio Verdicts (7d)",
  verdict_tp_sl: "Holding Target / Stop (20d)",
  wishlist_7d: "Wishlist Signals (7d)",
  holding_outlook_dir_1d: "Holdings Direction (1d)",
  holding_outlook_range_1d: "Holdings Range (1d)",
  wishlist_outlook_dir_1d: "Wishlist Direction (1d)",
  wishlist_outlook_range_1d: "Wishlist Range (1d)",
  sector_dir_1d: "Sectors Direction (1d)",
  sector_range_1d: "Sectors Range (1d)",
  index_pair_1d: "NIFTY vs BankNifty (1d)",
  cap_pair_1d: "NIFTY vs Midcap 150 (1d)",
  fii_flow_1d: "FII Cash Flow Direction (1d)",
  short_pick_A_7d: "Short Picks · Tier A (7d)",
  short_pick_B_7d: "Short Picks · Tier B (7d)",
  short_pick_C_7d: "Short Picks · Tier C (7d)",
  insight_quality: "Reasoning Quality",
};

function humaniseDim(d: any): string {
  if (typeof d !== "string" || !d) return "·";
  if (DIM_LABEL[d]) return DIM_LABEL[d];
  // Best-effort fallback: replace underscores, title-case each word.
  return d
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
      <motion.main
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 pb-24"
      >
        <div className="mb-12">
          <div className="section-num mb-2">000 · Sensei</div>
          <h1 className="headline mb-3">
            Yesterday's <span className="italic">Verdict.</span>
          </h1>
          <p className="sub-headline max-w-2xl">
            End-of-day synthesis lands here once Sensei runs against today's morning call and the grader's scores.
          </p>
        </div>
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
      </motion.main>
    );
  }

  if (!row) return null;
  const conv = row.conviction_review || {};

  return (
    <motion.main
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto max-w-6xl px-4 sm:px-6 pt-8 pb-24"
    >
      <header className="mb-10">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="section-num mb-2">000 · Sensei</div>
            <h1 className="headline mb-3">
              Yesterday's <span className="italic">Verdict.</span>
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
          {typeof row.insight_quality_avg === "number" && (
            <>
              <span>·</span>
              <span>Reasoning quality: {row.insight_quality_avg}</span>
            </>
          )}
        </div>
      </header>

      <Section
        num="001 / 006"
        title="Sensei's Read"
        glyph="◈"
        description="One-line verdict on whether stated confidence matched delivered accuracy. Strict, no softening."
      >
        <div className="card p-5">
          <p className="text-base leading-relaxed">
            {row.calibration_note || "No verdict returned for today's session."}
          </p>
        </div>
      </Section>

      <Section
        num="002 / 006"
        title="What Worked"
        glyph="◉"
        description="Calls that hit. Evidence column shows the numbers behind each win. Treat as a checklist of what to repeat tomorrow."
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
                    <td className="align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {humaniseDim(w.dimension)}
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
        num="003 / 006"
        title="What Missed"
        glyph="◉"
        description="Calls that broke. Root Cause column says why. Read every row before the next session opens."
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
                    <td className="align-top" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                      {humaniseDim(m.dimension)}
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
        num="004 / 006"
        title="Conviction Tier Review"
        glyph="◉"
        description="Did A / B / C labels track actual performance? Inflated tiers will surface here."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {([
            { key: "tier_A", label: "A", pill: "pill-gain" },
            { key: "tier_B", label: "B", pill: "pill-mid" },
            { key: "tier_C", label: "C", pill: "pill-warn" },
          ] as const).map(({ key, label, pill }) => {
            const t = (conv && (conv as any)[key]) || {};
            return (
              <div key={key} className="card p-5">
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
        num="005 / 006"
        title="Key Insights"
        glyph="◉"
        description="Sensei's strict reads of today's data. Every bullet cites at least two concrete numbers. No vibe takes."
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
        num="006 / 006"
        title="Tomorrow's Watchlist"
        glyph="⬡"
        description="Specific levels and events to track at next open. These are the things Sensei wants you to flag before tomorrow's session begins."
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

    </motion.main>
  );
}

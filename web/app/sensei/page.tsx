"use client";

import { useEffect, useRef, useState } from "react";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Calculator } from "@/components/Calculator";
import { PortfolioScorecard } from "@/components/PortfolioScorecard";
import { StockAnalyst } from "@/components/StockAnalyst";
import { sb } from "@/lib/supabase";
import { polishMarketText } from "@/lib/utils";

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
  stock_range_1d: "Stock Range (1d)",
  index_pair_1d: "NIFTY vs BankNifty (1d)",
  cap_pair_1d: "NIFTY vs Midcap 150 (1d)",
  fii_flow_1d: "FII Cash Flow Direction (1d)",
  short_pick_A_7d: "Short Picks · Tier A (7d)",
  short_pick_B_7d: "Short Picks · Tier B (7d)",
  short_pick_C_7d: "Short Picks · Tier C (7d)",
  insight_quality: "Reasoning Quality",
  // Shorthand variants the model sometimes writes in prose.
  sector_direction_1d: "Sectors Direction (1d)",
  wishlist_dir_1d: "Wishlist Direction (1d)",
  wishlist_range_1d: "Wishlist Range (1d)",
  holding_dir_1d: "Holdings Direction (1d)",
  holding_range_1d: "Holdings Range (1d)",
};

// Root-cause codes from the Sensei schema, humanized.
const ROOT_CAUSE_LABEL: Record<string, string> = {
  regime_shift: "Regime shift",
  flow_surprise: "Flow surprise",
  news_catalyst: "News catalyst",
  technical_break: "Technical break",
  overconfidence: "Overconfidence",
  data_thin: "Not enough data yet",
  model_noise: "Model noise",
};

function humaniseDim(d: any): string {
  if (typeof d !== "string" || !d) return "·";
  if (DIM_LABEL[d]) return DIM_LABEL[d];
  // Best-effort fallback: replace underscores, title-case each word.
  return d
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Strip backend identifiers out of model prose so every sentence reads
// as plain English. Older Sensei rows (and occasional new ones despite
// the prompt ban) embed raw tokens like "direction_1d 100.0" or
// "technical_break" mid-sentence. Replace every known dimension key and
// root-cause code with its human label, then de-underscore anything
// left, then run the standard market-text polish (capitalize, Indian
// commas, ₹ on price levels).
function humaniseText(s: any): string {
  if (typeof s !== "string" || !s) return "·";
  let out = s;
  // Longest keys first so "sensex_direction_1d" is consumed whole
  // before the shorter "direction_1d" substring can mangle it.
  const dimEntries = Object.entries(DIM_LABEL).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [key, label] of dimEntries) {
    out = out.split(key).join(label);
  }
  for (const [key, label] of Object.entries(ROOT_CAUSE_LABEL)) {
    out = out.split(key).join(label);
  }
  // Any leftover snake_case token: spaces instead of underscores.
  out = out.replace(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g, (m) =>
    m.replace(/_/g, " ")
  );
  return polishMarketText(out);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "·";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Long-form date ("June 20 2026") used in the Last Sync and Close Date
// header boxes per the design spec. Everywhere else still uses the
// terse dd/mm/yyyy form.
const _MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function fmtLongDate(iso: string | null): string {
  if (!iso) return "·";
  const d = new Date(iso);
  return `${_MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

// 12-hour IST clock formatted to AM/PM uppercase per the brand rules.
function fmtTime(iso: string | null): string {
  if (!iso) return "·";
  const d = new Date(iso);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

export default function SenseiPage() {
  const [row, setRow] = useState<SenseiRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const rowRef = useRef<SenseiRow | null>(null);
  rowRef.current = row;

  const fetchLatest = async (): Promise<SenseiRow | null> => {
    // Secondary order on run_at desc so a same-day re-run (today,
    // Saturday, with market_close_date stuck on Friday's close) still
    // surfaces the latest synthesis instead of the first one written
    // against that close date.
    const { data } = await sb
      .from("sensei_eod")
      .select(
        "id,run_at,analysis_id,market_close_date,model_used,raw_json,what_worked,what_missed,conviction_review,key_insights,tomorrow_watch,calibration_note,insight_quality_avg"
      )
      .order("market_close_date", { ascending: false })
      .order("run_at", { ascending: false })
      .limit(1);
    return ((data || [])[0] as SenseiRow) || null;
  };

  useEffect(() => {
    (async () => {
      setRow(await fetchLatest());
      setLoading(false);
    })();
  }, []);

  // When the nav queues a Sensei run (202 from the bot), poll for the
  // fresh row and swap it in the moment it lands. The synthesis takes
  // 1-5 minutes; without this the user clicks Sync, sees "Queued", and
  // nothing on the page ever changes until a manual reload.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onQueued = (e: Event) => {
      const mode = (e as CustomEvent).detail?.mode;
      if (mode !== "sensei") return;
      const baseline = rowRef.current?.run_at
        ? new Date(rowRef.current.run_at).getTime()
        : 0;
      const deadline = Date.now() + 20 * 60 * 1000;
      setRefreshing(true);
      const poll = async () => {
        if (cancelled) return;
        const latest = await fetchLatest();
        const ts = latest?.run_at ? new Date(latest.run_at).getTime() : 0;
        if (latest && ts > baseline) {
          setRow(latest);
          setRefreshing(false);
          return;
        }
        if (Date.now() < deadline) {
          timer = setTimeout(poll, 15_000);
        } else {
          setRefreshing(false);
        }
      };
      timer = setTimeout(poll, 15_000);
    };

    window.addEventListener("arcemx:sync-queued", onQueued);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("arcemx:sync-queued", onQueued);
    };
  }, []);

  // Single render path at all times. This page used to return `null`
  // while its first fetch was in flight: the document collapsed to just
  // nav + footer, the scrollbar vanished, the viewport widened, and the
  // whole UI shifted sideways before snapping back when data landed.
  // It was also the only page whose content mounted AFTER the route
  // transition finished, so it popped in with no entry animation.
  // Rendering the full shell immediately (quiet static placeholders in
  // the data sections, no skeleton shimmer) keeps the height stable and
  // lets the shared PageTransition animate real content like every
  // other page.
  const conv = row?.conviction_review || {};
  const pending = (
    <div className="card p-5">
      <p className="text-sm text-[var(--muted)]">Loading the latest retrospective.</p>
    </div>
  );

  return (
    <>
      <header className="mb-10">
        <div>
          <div className="section-num mb-2">000 · Sensei</div>
          <h1 className="headline mb-3">
            Sensei&apos;s <span className="italic">Verdict.</span>
          </h1>
          <p className="sub-headline mt-2 max-w-2xl">
            End-of-day synthesis over today&apos;s morning call, actual closes, and graded scores.
            Tomorrow&apos;s morning call reads this before forecasting. Trigger a fresh run from the
            nav sync button at the top right.
          </p>
        </div>
        {/* Three-box header strip mirrors the Today page's Last Update
         *  card design so the page reads with the same visual cadence.
         *  Box 1 carries the synthesis timestamp + a live status line
         *  with a blinking green dot while a fresh retrospective is in
         *  flight. Box 2 surfaces the reasoning-quality score. Box 3
         *  surfaces the market session the row analysed. The old inline
         *  bullet-separated strip is gone (those facts live in the
         *  boxes now), so is the synchronising span below it.
         */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
          {/* Box 1: Last Sync. Date + green time pill, blinking-dot
              live status while a fresh run is in flight. */}
          <div className="card p-7 h-[200px] relative overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Last Sync</div>
              <span className="glyph text-sm">◷</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap mb-3">
              <div className="text-3xl font-semibold tracking-tight">
                {row ? fmtLongDate(row.run_at) : "·"}
              </div>
              {row?.run_at && (
                <span
                  className="pill num"
                  style={{
                    color: "var(--gain)",
                    borderColor: "color-mix(in srgb, var(--gain) 50%, transparent)",
                    background: "color-mix(in srgb, var(--gain) 10%, transparent)",
                  }}
                >
                  {fmtTime(row.run_at)}
                </span>
              )}
            </div>
            <div className="mt-auto min-h-[1.5rem]">
              {refreshing ? (
                <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="inline-block size-2 rounded-full bg-[var(--gain)] animate-pulse" />
                  <span>Synthesizing a fresh retrospective</span>
                </span>
              ) : (
                <span className="text-xs text-[var(--muted)]">
                  No fresh synthesis pending. Next refresh after next market close.
                </span>
              )}
            </div>
          </div>

          {/* Box 2: Reasoning Quality (insight_quality_avg, 0-100). */}
          <div className="card p-7 h-[200px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Reasoning Quality</div>
              <span className="glyph text-sm">◎</span>
            </div>
            <div className="text-5xl font-semibold tracking-tight num">
              {typeof row?.insight_quality_avg === "number"
                ? row.insight_quality_avg
                : "·"}
            </div>
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug">
              Sensei&apos;s self-rated reasoning strength on the latest
              synthesis, graded against realized accuracy.
            </p>
          </div>

          {/* Box 3: Close Date. Session the retrospective analysed. */}
          <div className="card p-7 h-[200px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Close Date</div>
              <span className="glyph text-sm">◈</span>
            </div>
            <div className="text-3xl font-semibold tracking-tight num">
              {row ? fmtDate(row.market_close_date) : "·"}
            </div>
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug">
              The market session whose closes, graded scores, and
              calibration this retrospective rolls up.
            </p>
          </div>
        </div>
      </header>

      <Section
        num="001 / 009"
        title="Sensei's Read"
        glyph="◈"
        description="One-line verdict on whether stated confidence matched delivered accuracy. Strict, no softening."
      >
        {loading ? (
          pending
        ) : (
          <div className="card p-5">
            <p className="text-base leading-relaxed">
              {row?.calibration_note
                ? humaniseText(row.calibration_note)
                : "No verdict returned for today's session."}
            </p>
          </div>
        )}
      </Section>

      <Section
        num="002 / 009"
        title="Stock Analyst"
        glyph="◎"
        description="Deep single-stock analysis on demand. Pick a horizon, type a ticker, the analyst pulls every free yfinance data point (info, financials, holders, analyst targets, earnings calendar, news, options, full history since IPO) plus a fresh technical battery, runs the LLM, returns rating + phase + buy zone + reasoning. Every prediction is logged and graded at horizon; the next call for the same ticker injects your past graded calls as prior_self_predictions so the model literally learns from its own track record."
      >
        <StockAnalyst />
      </Section>

      <Section
        num="003 / 009"
        title="What Worked"
        glyph="◉"
        description="Calls that hit. Evidence column shows the numbers behind each win. Treat as a checklist of what to repeat tomorrow."
      >
        {loading ? (
          pending
        ) : row?.what_worked && row.what_worked.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="table-scroll">
            <table className="data" style={{ width: "100%" }}>
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
                  <tr key={i}>
                    <td className="font-medium">
                      <div className="clamp-3">{humaniseText(w.call)}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      {humaniseDim(w.dimension)}
                    </td>
                    <td className="num">{w.score_pct ?? "·"}</td>
                    <td className="text-[var(--muted)] text-sm">
                      <div className="clamp-3">{humaniseText(w.evidence)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title="No graded wins for this session yet."
            hint="Populates after the evening grader pass scores the day's call."
          />
        )}
      </Section>

      <Section
        num="004 / 009"
        title="What Missed"
        glyph="◉"
        description="Calls that broke. Root Cause column says why. Read every row before the next session opens."
      >
        {loading ? (
          pending
        ) : row?.what_missed && row.what_missed.length > 0 ? (
          <div className="card overflow-hidden">
            <div className="table-scroll">
            <table className="data" style={{ width: "100%" }}>
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
                  <tr key={i}>
                    <td className="font-medium">
                      <div className="clamp-3">{humaniseText(m.call)}</div>
                    </td>
                    <td className="whitespace-nowrap">
                      {humaniseDim(m.dimension)}
                    </td>
                    <td className="num whitespace-nowrap">
                      {m.actual ?? "·"}
                    </td>
                    <td className="num whitespace-nowrap">
                      {m.gap ?? "·"}
                    </td>
                    <td className="text-[var(--muted)] text-sm">
                      <div className="clamp-3">{m.root_cause ? humaniseText(m.root_cause) : "·"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title="No graded misses for this session yet."
            hint="Populates after the evening grader pass scores the day's call."
          />
        )}
      </Section>

      <Section
        num="005 / 009"
        title="Conviction Tier Review"
        glyph="◉"
        description="Did A / B / C labels track actual performance? Inflated tiers will surface here."
      >
        {loading ? (
          pending
        ) : (
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
                  {t.comment ? humaniseText(t.comment) : "No picks at this tier today."}
                </p>
              </div>
            );
          })}
        </div>
        )}
      </Section>

      <Section
        num="006 / 009"
        title="Key Insights"
        glyph="◉"
        description="Sensei's strict reads of today's data. Every bullet cites at least two concrete numbers. No vibe takes."
      >
        {loading ? (
          pending
        ) : row?.key_insights && row.key_insights.length > 0 ? (
          <div className="card p-5">
            <ul className="list-disc pl-6 space-y-2.5 text-sm leading-relaxed">
              {row.key_insights.map((s: string, i: number) => (
                <li key={i}>{humaniseText(s)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState title="No insights returned." hint="" />
        )}
      </Section>

      <Section
        num="007 / 009"
        title="Tomorrow's Watchlist"
        glyph="⬡"
        description="Specific levels and events to track at next open. These are the things Sensei wants you to flag before tomorrow's session begins."
      >
        {loading ? (
          pending
        ) : row?.tomorrow_watch && row.tomorrow_watch.length > 0 ? (
          <div className="card p-5">
            <ul className="list-disc pl-6 space-y-2.5 text-sm leading-relaxed">
              {row.tomorrow_watch.map((s: string, i: number) => (
                <li key={i}>{humaniseText(s)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState title="No watch items returned." hint="" />
        )}
      </Section>

      <Section
        num="008 / 009"
        title="Sensei's Calculator"
        glyph="✦"
        description="Tell Sensei how much you want to deploy, for how long, and how much risk you can stomach. A deterministic prefilter ranks the universe by momentum + RSI + realized vol and proposes an allocation. Ask Sensei wraps the picks with macro and sector context."
      >
        <Calculator />
      </Section>

      <Section
        num="009 / 009"
        title="Portfolio Scorecard"
        glyph="◉"
        description="Live score on your actual holdings. Sector spread, single-name risk, momentum vs NIFTY, drawdown, edge over the index. Red flags and tips to lift the score below."
      >
        <PortfolioScorecard />
      </Section>
    </>
  );
}

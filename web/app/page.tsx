"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { MoodPill } from "@/components/MoodPill";
import { EmptyState } from "@/components/EmptyState";
import { DirPill } from "@/components/DirPill";
import { sb } from "@/lib/supabase";
import { formatINR, formatNumber, formatPct, polishMarketText } from "@/lib/utils";

export default function TodayPage() {
  const [analysis, setAnalysis] = useState<any>(null);
  // Live portfolio tickers used to filter raw.holding_outlooks_1d down
  // to positions still held. Analysis rows freeze a snapshot at run
  // time; without this guard a position sold AFTER the morning run
  // would keep rendering in Forecast Holdings until the next 08:30
  // cron. null = not yet loaded (no filter); empty set = portfolio
  // genuinely empty (filter to []).
  const [portfolioTickers, setPortfolioTickers] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);

  const refetchAnalysis = async () => {
    const { data } = await sb
      .from("analysis")
      .select("*")
      .order("run_at", { ascending: false })
      .limit(1);
    if (data?.[0]) setAnalysis(data[0]);
    return data?.[0] || null;
  };

  const refetchPortfolio = async () => {
    try {
      const { data } = await sb.from("portfolio").select("ticker");
      const set = new Set<string>((data || []).map((r: any) => r.ticker).filter(Boolean));
      setPortfolioTickers(set);
    } catch {
      // Soft-fail: leave the existing snapshot unfiltered rather than
      // hide everything on a transient Supabase blip.
      setPortfolioTickers(null);
    }
  };

  useEffect(() => {
    (async () => {
      await Promise.all([refetchAnalysis(), refetchPortfolio()]);
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
  // Last Update reflects the LLM analysis's run_at exclusively. The nav
  // INDmoney sync writes a sync_log row but does not by itself create a
  // new analysis, so blending the two (previous behavior) made the time
  // here jump forward on a nav-sync click and read as "the AI just
  // refreshed" when it had not. The nav badge keeps the blended max via
  // /api/last-sync; this card answers "when did the model last speak".
  const runAtDate = analysis?.run_at ? new Date(analysis.run_at) : null;
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
          A free-tier LLM chain (Nemotron 3 Super primary, Ultra backup) synthesises technicals, news flow, search interest, sectors, and global cues every weekday at 8:30 AM IST. The sync button refreshes both your INDmoney positions and this call on demand.
        </p>
      </div>

      <Section num="001 / 006" title="Snapshot" glyph="✦">
        {/* Inline cards (not the shared Stat) so all three boxes share the
            larger fixed-height footprint without touching Stat's other
            call sites on the accuracy page. Height is FIXED (h-[200px])
            so the Run Analysis result popup floats inside its card
            instead of pushing the row taller when it appears. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="card p-7 h-[230px] flex flex-col items-start relative">
            <div className="flex w-full items-center justify-between mb-4">
              <div className="section-num">Market Mood</div>
              <span className="glyph text-sm">◈</span>
            </div>
            {/* items-start on the card prevents flex column from stretching
                the pill to full card width, so it sits compact at its own
                content width. */}
            <MoodPill mood={mood} size="lg" />
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug whitespace-pre-line">
              {moodOneLiner(mood, no)}
            </p>
          </div>
          <div className="card p-7 h-[230px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Confidence</div>
              <span className="glyph text-sm">◎</span>
            </div>
            <div className="text-5xl font-semibold tracking-tight num">{conf}%</div>
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug">
              Model&apos;s self-rated certainty on today&apos;s direction call, calibrated against realized accuracy on past predictions.
            </p>
          </div>
          <div className="card p-7 h-[230px] relative overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Last Update</div>
              <span className="glyph text-sm">◷</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap mb-4">
              <div className="text-3xl font-semibold tracking-tight num">{runDateStr}</div>
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
            <RunAnalysisButton
              currentRunAt={analysis?.run_at || null}
              onComplete={refetchAnalysis}
            />
          </div>
        </div>
      </Section>

      <Section num="002 / 006" title="Index Outlooks" glyph="◈">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[
            { name: "Nifty 50", data: no },
            { name: "Sensex", data: so },
          ].map(({ name, data }) => (
            <div key={name} className="card p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="section-num mb-1.5">{name}</div>
                  <div className="text-xl font-semibold uppercase tracking-wide">
                    {data.direction || "UNKNOWN"}
                  </div>
                </div>
                <span className="pill num">{formatNumber(data.range)}</span>
              </div>
              {data.drivers?.length > 0 && (
                <ul className="space-y-2 text-sm text-[var(--muted)]">
                  {data.drivers.map((d: string, i: number) => (
                    <li key={i} className="flex gap-3">
                      <span className="glyph mt-0.5">·</span>
                      <span>{polishMarketText(d)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section num="003 / 006" title="Picks" glyph="◉">
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

      <Section num="004 / 006" title="Your Portfolio Verdicts" glyph="⬡">
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
                  <tr key={i} className="align-middle">
                    <td className="font-medium whitespace-nowrap">{v.ticker}</td>
                    <td className="whitespace-nowrap">
                      <VerdictPill v={v.verdict} />
                    </td>
                    <td
                      className="text-[var(--muted)] align-top leading-snug"
                      style={{ whiteSpace: "normal", maxWidth: "44rem" }}
                    >
                      {polishMarketText(v.reason)}
                    </td>
                    <td className="num whitespace-nowrap text-[var(--gain)]">{formatINR(v.target)}</td>
                    <td className="num whitespace-nowrap text-[var(--loss)]">{formatINR(v.stop_loss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Sync portfolio via Telegram" hint="Send /sync to the bot, then refresh." />
        )}
      </Section>

      <Section num="005 / 006" title="Forecast Holdings" glyph="◎" description="Per-holding next-day direction + ATR-anchored range. The key driver cites 2+ specific numbers (RSI, MACD, DMA distance, support/resistance). Wishlist 1-day calls live on the Wishlist page.">
        <StockOutlooks
          holdings={
            // Filter the analysis row's frozen snapshot down to
            // tickers still held. portfolioTickers===null means the
            // live fetch has not landed or errored, so we render
            // the raw snapshot rather than hiding everything.
            portfolioTickers
              ? (raw.holding_outlooks_1d || []).filter((r: any) =>
                  r?.ticker ? portfolioTickers.has(r.ticker) : false
                )
              : (raw.holding_outlooks_1d || [])
          }
        />
      </Section>

      <Section num="006 / 006" title="Reasoning" glyph="✦">
        <ReasoningCard summary={raw.reasoning} breakdown={raw.reasoning_breakdown} />
      </Section>
    </>
  );
}

// One-line read on why the mood is what it is. Prefer the model's own
// first driver of the nifty outlook (already a number-anchored short
// sentence per the system prompt); fall back to a generic regime line
// when drivers are missing.
// Two-line read on why the mood is what it is. Renders the first two
// drivers from the model's nifty outlook (each is a number-anchored
// short clause per the system prompt) as separate sentences, each one
// polished by polishMarketText (capitalized first letter, Indian comma
// grouping, ₹ prefix on price-context numbers). Falls back to a regime
// sentence with the band rule when drivers are missing.
function moodOneLiner(mood: string, niftyOutlook: any): string {
  const drivers: string[] = Array.isArray(niftyOutlook?.drivers) ? niftyOutlook.drivers : [];
  const clean = drivers
    .map((d) => (d || "").trim().replace(/[\.;,]+$/, ""))
    .filter(Boolean);
  if (clean.length) {
    const polished = clean.slice(0, 2).map((d) => polishMarketText(d) + ".");
    return polished.join("\n");
  }
  const m = (mood || "").toLowerCase();
  if (m === "bull") return "Tilt up: model expects NIFTY to close >0.4% above the prior session on supportive technicals and flows.";
  if (m === "bear") return "Tilt down: model expects NIFTY to close >0.4% below the prior session on weak technicals or risk-off flows.";
  return "Mixed signals: model expects the move to stay inside the ±0.4% noise band; no decisive direction either way.";
}

function RunAnalysisButton({
  currentRunAt,
  onComplete,
}: {
  currentRunAt: string | null;
  onComplete: () => Promise<any> | void;
}) {
  // Inline trigger button living inside the Last Update card. Hits
  // /api/trigger-analysis which kicks the LLM pipeline asynchronously
  // on the bot. INDmoney sync stays on the nav button; this fires only
  // the analysis pass so the user does not pay a 7-12 minute wait when
  // they just want refreshed positions.
  // idle -> syncing (POST in flight + LLM in flight) -> ok | error.
  // syncing covers both "the bot accepted the trigger" and "the new
  // analysis row is still pending"; we poll the analysis table until
  // it lands or the timeout fires.
  const [state, setState] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  // Poll the analysis table for a row newer than the one the page
  // started with. The bot's LLM call takes 3-12 min; rather than ask
  // the user to refresh manually, watch for the new row and refresh
  // the displayed analysis as soon as it lands.
  const waitForNewAnalysis = async (since: string | null): Promise<boolean> => {
    const deadline = Date.now() + 15 * 60 * 1000; // 15 min cap
    const sinceMs = since ? new Date(since).getTime() : 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      const { data } = await sb
        .from("analysis")
        .select("run_at")
        .order("run_at", { ascending: false })
        .limit(1);
      const latest = data?.[0]?.run_at;
      if (latest && new Date(latest).getTime() > sinceMs) return true;
    }
    return false;
  };

  const run = async () => {
    if (state === "syncing") return;
    setState("syncing");
    setMsg("Syncing");
    setDetail("Sending the trigger to the bot...");
    let kicked = false;
    try {
      const r = await fetch("/api/trigger-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.ok) {
        kicked = true;
        setDetail("Analysis running. Fresh call with current news typically lands in 3-12 min.");
      } else if (r.status === 409 || data?.status === "already_running") {
        kicked = true;
        setDetail("An analysis is already running. Waiting for it to finish.");
      } else {
        setState("error");
        setMsg("Failed");
        setDetail(data?.error || "Bot unreachable. Render may be waking from sleep; try again in ~30s.");
        setTimeout(() => { setState("idle"); setMsg(null); setDetail(null); }, 10000);
        return;
      }
    } catch {
      setState("error");
      setMsg("Failed");
      setDetail("Network error reaching the bot. Try again in ~30s.");
      setTimeout(() => { setState("idle"); setMsg(null); setDetail(null); }, 10000);
      return;
    }
    if (!kicked) return;

    const landed = await waitForNewAnalysis(currentRunAt);
    if (landed) {
      await onComplete();
      setState("ok");
      setMsg("Synced");
      setDetail("Synced. Page refreshed with the new analysis.");
      setTimeout(() => { setState("idle"); setMsg(null); setDetail(null); }, 10000);
    } else {
      setState("error");
      setMsg("Failed");
      setDetail("Timed out waiting for the new analysis. It may still complete; refresh the page in a few minutes.");
      setTimeout(() => { setState("idle"); setMsg(null); setDetail(null); }, 12000);
    }
  };

  const borderColor =
    state === "ok"
      ? "color-mix(in srgb, var(--gain) 60%, transparent)"
      : state === "error"
      ? "color-mix(in srgb, var(--loss) 60%, transparent)"
      : "var(--border)";
  const bg =
    state === "ok"
      ? "color-mix(in srgb, var(--gain) 14%, transparent)"
      : state === "error"
      ? "color-mix(in srgb, var(--loss) 14%, transparent)"
      : "transparent";
  const fg =
    state === "ok" ? "var(--gain)" : state === "error" ? "var(--loss)" : "var(--foreground)";

  return (
    <>
    <button
      type="button"
      onClick={run}
      disabled={state === "syncing"}
      title={msg || "Run analysis (LLM call, 3-12 min). INDmoney sync lives on the nav."}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[0.7rem] font-medium transition-all duration-300 disabled:cursor-not-allowed"
      style={{
        border: `1px solid ${borderColor}`,
        background: bg,
        color: fg,
      }}
    >
      <span
        aria-hidden
        className={`shrink-0 inline-block bg-current ${state === "syncing" ? "animate-spin" : ""}`}
        style={{
          width: 14,
          height: 14,
          WebkitMaskImage: "url(/icons/analysis.svg)",
          maskImage: "url(/icons/analysis.svg)",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
      <span className="tracking-wide whitespace-nowrap">
        {state === "syncing"
          ? msg || "Syncing"
          : state === "ok"
          ? msg || "Synced"
          : state === "error"
          ? msg || "Failed"
          : "Run Analysis"}
      </span>
    </button>
    {detail && (
      // Pinned to the card's footer baseline. left/right/bottom all use
      // the same 7-unit (28px) offset as the card's p-7 padding, so the
      // popup's left edge, right edge, and bottom baseline land exactly
      // where the Market Mood and Confidence one-liners sit (those are
      // <p mt-auto> inside p-7 = 28px from card bottom). Same vertical
      // line across all three Snapshot cards.
      // Text stays muted neutral; the button border + background already
      // carry the green / red status signal, so the message itself reads
      // as plain informational copy.
      <div className="absolute left-7 right-7 bottom-7 text-xs leading-snug text-[var(--muted)]">
        {detail}
      </div>
    )}
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
              <th>Tier</th>
              <th>Entry</th>
              <th>Target</th>
              <th>Stop Loss</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="font-medium">{r.ticker}</td>
                <td><ConvictionPill tier={r.conviction} /></td>
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

function ConvictionPill({ tier }: { tier?: string }) {
  const t = (tier || "").toUpperCase();
  // Tier A = highest conviction, green. Tier B = solid setup, lime/mid
  // (sits between gain and warn). Tier C = speculative, amber.
  // Unlabelled = grey dot so a missing tier is visible (it should not
  // happen post-Step-4 prompt).
  const cls =
    t === "A" ? "pill-gain" :
    t === "B" ? "pill-mid" :
    t === "C" ? "pill-warn" : "";
  return (
    <span className={`pill ${cls}`} style={{ minWidth: 30, justifyContent: "center" }}>
      {t || "·"}
    </span>
  );
}


function StockOutlooks({ holdings }: { holdings: any[] }) {
  if (!holdings.length) {
    return <EmptyState title="No per-holding outlooks yet" hint="Populates once today's cron has run with the new schema." />;
  }
  return (
    <div className="grid grid-cols-1 gap-4">
      <StockOutlookTable title="Holdings" rows={holdings} />
    </div>
  );
}

function StockOutlookTable({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="p-5 border-b border-border">
        <div className="section-num mb-1">{title}</div>
      </div>
      {rows.length ? (
        <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "10%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Direction</th>
              <th>Range</th>
              <th>Confidence</th>
              <th>Key Driver</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any, i: number) => (
              <tr key={i} className="align-middle">
                <td className="font-medium whitespace-nowrap">{(r.ticker || "").replace(/\.NS$/, "")}</td>
                <td className="whitespace-nowrap"><DirPill direction={r.direction} /></td>
                <td className="num whitespace-nowrap">{r.range ? formatINR(r.range) : "·"}</td>
                <td className="num whitespace-nowrap">{r.confidence ?? "·"}</td>
                <td
                  className="text-[var(--muted)] text-sm align-top leading-snug"
                  style={{ whiteSpace: "normal" }}
                >
                  {polishMarketText(r.key_driver)}
                </td>
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
          {polishMarketText(summary)}
        </p>
      )}
      {points.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {points.map(([key, text]) => (
            <div key={key} className="border-l border-border pl-4">
              <div className="text-[0.7rem] uppercase tracking-wider text-[var(--muted)] mb-1.5 font-medium">
                {REASONING_LABELS[key] || key.replace(/_/g, " ")}
              </div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{polishMarketText(text)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

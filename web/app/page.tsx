"use client";

import { useEffect, useState } from "react";
import { Section } from "@/components/Section";
import { MoodPill } from "@/components/MoodPill";
import { EmptyState } from "@/components/EmptyState";
import { sb } from "@/lib/supabase";
import { fetchQuote } from "@/lib/quotes";
import { formatINR, formatNumber, formatPct } from "@/lib/utils";

// Live leaderboard universe. Matches the analyzer payload's
// market_context indices + 10 NSE sectors so today's actual board
// mirrors what the model is reasoning over for tomorrow.
const LEADERBOARD_SYMBOLS: { sym: string; name: string }[] = [
  { sym: "^NSEI",              name: "NIFTY" },
  { sym: "^BSESN",             name: "Sensex" },
  { sym: "^NSEBANK",           name: "BankNifty" },
  { sym: "NIFTYMIDCAP150.NS",  name: "Midcap 150" },
  { sym: "^CNXIT",             name: "IT" },
  { sym: "^CNXAUTO",           name: "Auto" },
  { sym: "^CNXPHARMA",         name: "Pharma" },
  { sym: "^CNXFMCG",           name: "FMCG" },
  { sym: "^CNXENERGY",         name: "Energy" },
  { sym: "^CNXMETAL",          name: "Metal" },
  { sym: "^CNXREALTY",         name: "Realty" },
  { sym: "^CNXMEDIA",          name: "Media" },
  { sym: "NIFTY_FIN_SERVICE.NS", name: "FinServ" },
];

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
          A free-tier LLM chain (Nemotron 3 Super primary, Ultra backup) synthesises technicals, news flow, search interest, sectors, and global cues every weekday at 8:30 AM IST. The sync button refreshes both your INDmoney positions and this call on demand.
        </p>
      </div>

      <Section num="001 / 007" title="Snapshot" glyph="✦">
        {/* Inline cards (not the shared Stat) so all three boxes share the
            larger fixed-height footprint without touching Stat's other
            call sites on the accuracy page. Height is FIXED (h-[200px])
            so the Run Analysis result popup floats inside its card
            instead of pushing the row taller when it appears. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="card p-7 h-[200px] flex flex-col items-start">
            <div className="section-num mb-4">Market Mood</div>
            {/* items-start on the card prevents flex column from stretching
                the pill to full card width, so it sits compact at its own
                content width. */}
            <MoodPill mood={mood} size="lg" />
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug">
              {moodOneLiner(mood, no)}
            </p>
          </div>
          <div className="card p-7 h-[200px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="section-num">Confidence</div>
              <span className="glyph text-sm">◎</span>
            </div>
            <div className="text-3xl font-semibold tracking-tight num">{conf}%</div>
            <p className="text-xs text-[var(--muted)] mt-auto leading-snug">
              Model&apos;s self-rated certainty on today&apos;s direction call, calibrated against realized accuracy on past predictions.
            </p>
          </div>
          <div className="card p-7 h-[200px] relative overflow-hidden">
            <div className="section-num mb-4">Last Update</div>
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
            <RunAnalysisButton />
          </div>
        </div>
      </Section>

      <Section num="002 / 007" title="Index Outlooks" glyph="◈">
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
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section num="003 / 007" title="Picks" glyph="◉">
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

      <Section num="004 / 007" title="Your Portfolio Verdicts" glyph="⬡">
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
                      className="text-[var(--muted)] whitespace-nowrap overflow-hidden text-ellipsis max-w-[32rem]"
                      title={v.reason}
                    >
                      {v.reason}
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

      <Section num="005 / 007" title="Forecast Holdings" glyph="◎" description="Per-holding next-day direction + ATR-anchored range. The key driver cites 2+ specific numbers (RSI, MACD, DMA distance, support/resistance). Wishlist 1-day calls live on the Wishlist page.">
        <StockOutlooks holdings={raw.holding_outlooks_1d || []} />
      </Section>

      <Section num="006 / 007" title="Playground" glyph="◉" description="Three views in one. LIVE: today's actual move across NIFTY, Sensex, BankNifty, Midcap 150 and the 10 NSE sectors. FORECAST: the model's ranking for tomorrow (direction sign x confidence). PAIR CALLS FORECAST: relative-pair predictions.">
        <Playground
          sectors={raw.sector_outlooks || []}
          nifty={raw.nifty_outlook}
          sensex={raw.sensex_outlook}
          confidence={raw.confidence}
          pair={raw.index_pair_outlook}
          capPair={raw.cap_pair_outlook}
        />
      </Section>

      <Section num="007 / 007" title="Reasoning" glyph="✦">
        <ReasoningCard summary={raw.reasoning} breakdown={raw.reasoning_breakdown} />
      </Section>
    </>
  );
}

// One-line read on why the mood is what it is. Prefer the model's own
// first driver of the nifty outlook (already a number-anchored short
// sentence per the system prompt); fall back to a generic regime line
// when drivers are missing.
// Two-line read on why the mood is what it is. Joins the first two
// drivers from the model's nifty outlook (each is a number-anchored
// short clause per the system prompt) so the card carries genuine
// market reasoning, not just a pill label. Falls back to a regime
// sentence with the band rule when drivers are missing.
function moodOneLiner(mood: string, niftyOutlook: any): string {
  const drivers: string[] = Array.isArray(niftyOutlook?.drivers) ? niftyOutlook.drivers : [];
  const clean = drivers
    .map((d) => (d || "").trim().replace(/\.$/, ""))
    .filter(Boolean);
  if (clean.length >= 2) {
    const joined = clean.slice(0, 2).join("; ") + ".";
    return joined.length > 200 ? joined.slice(0, 197) + "..." : joined;
  }
  if (clean.length === 1) return clean[0] + ".";
  const m = (mood || "").toLowerCase();
  if (m === "bull") return "Tilt up: model expects NIFTY to close >0.4% above the prior session on supportive technicals and flows.";
  if (m === "bear") return "Tilt down: model expects NIFTY to close >0.4% below the prior session on weak technicals or risk-off flows.";
  return "Mixed signals: model expects the move to stay inside the ±0.4% noise band; no decisive direction either way.";
}

function RunAnalysisButton() {
  // Inline trigger button living inside the Last Update card. Hits
  // /api/trigger-analysis which kicks the LLM pipeline asynchronously
  // on the bot. INDmoney sync stays on the nav button; this fires only
  // the analysis pass so the user does not pay a 7-12 minute wait when
  // they just want refreshed positions.
  // States: idle -> loading -> ok | error -> idle (auto-reset).
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  // One-line result popup under the button so the outcome is readable
  // text, not just a border color flash.
  const [detail, setDetail] = useState<string | null>(null);

  const run = async () => {
    if (state === "loading") return;
    setState("loading");
    setMsg("Queueing");
    setDetail(null);
    try {
      const r = await fetch("/api/trigger-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data?.ok) {
        setState("ok");
        setMsg("Queued");
        setDetail("Analysis queued. Fresh call with current news lands in 3-12 min; refresh the page after.");
      } else if (r.status === 409 || data?.status === "already_running") {
        setState("ok");
        setMsg("Running");
        setDetail("An analysis is already in progress. Refresh in a few minutes.");
      } else {
        setState("error");
        setMsg("Failed");
        setDetail(data?.error || "Bot unreachable. Render may be waking from sleep; try again in ~30s.");
      }
    } catch {
      setState("error");
      setMsg("Failed");
      setDetail("Network error reaching the bot. Try again in ~30s.");
    } finally {
      setTimeout(() => {
        setState("idle");
        setMsg(null);
        setDetail(null);
      }, 8000);
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
      disabled={state === "loading"}
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
        className={`shrink-0 inline-block bg-current ${state === "loading" ? "animate-spin" : ""}`}
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
        {state === "loading"
          ? msg || "Queueing"
          : state === "ok"
          ? msg || "Queued"
          : state === "error"
          ? msg || "Error"
          : "Run Analysis"}
      </span>
    </button>
    {detail && (
      // Pinned to the card's bottom-left via absolute positioning so the
      // popup never pushes the card taller. The parent card is `relative
      // overflow-hidden` and 200px tall; this sits inside that frame.
      // Text stays muted neutral; the button border + background already
      // carry the green / red status signal, so the message itself reads
      // as plain informational copy.
      <div className="absolute left-7 right-7 bottom-5 text-[0.7rem] leading-snug text-[var(--muted)]">
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

function DirPill({ direction }: { direction?: string }) {
  const d = (direction || "").toLowerCase();
  const cls = d === "up" ? "pill-gain" : d === "down" ? "pill-loss" : "pill-warn";
  const glyph = d === "up" ? "↑" : d === "down" ? "↓" : "→";
  return (
    <span className={`pill ${cls}`} style={{ minWidth: 96, justifyContent: "center" }}>
      {glyph} {d ? d.toUpperCase() : "?"}
    </span>
  );
}

interface PlaygroundItem {
  name: string;
  direction: string;
  confidence: number;
  range?: string;
  driver?: string;
  score: number;     // signed: up=+conf, down=-conf, sideways=0
}

function compositeScore(direction: string | undefined, confidence: number | undefined): number {
  const d = (direction || "").toLowerCase();
  const c = typeof confidence === "number" ? confidence : 50;
  if (d === "up") return c;
  if (d === "down") return -c;
  return 0;
}

function buildPlaygroundList(
  sectors: any[],
  nifty: any,
  sensex: any,
  topConf: number | undefined,
): PlaygroundItem[] {
  const items: PlaygroundItem[] = [];
  if (nifty) {
    items.push({
      name: "NIFTY",
      direction: nifty.direction || "sideways",
      confidence: typeof topConf === "number" ? topConf : 50,
      range: nifty.range,
      driver: Array.isArray(nifty.drivers) ? nifty.drivers.join("; ") : undefined,
      score: compositeScore(nifty.direction, topConf),
    });
  }
  if (sensex) {
    items.push({
      name: "Sensex",
      direction: sensex.direction || "sideways",
      confidence: typeof topConf === "number" ? topConf : 50,
      range: sensex.range,
      driver: Array.isArray(sensex.drivers) ? sensex.drivers.join("; ") : undefined,
      score: compositeScore(sensex.direction, topConf),
    });
  }
  for (const s of sectors) {
    items.push({
      name: s.sector,
      direction: s.direction || "sideways",
      confidence: typeof s.confidence === "number" ? s.confidence : 50,
      range: s.range,
      driver: s.key_driver,
      score: compositeScore(s.direction, s.confidence),
    });
  }
  // Stable sort: composite desc, then by name to keep equal ties readable.
  items.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return items;
}

interface LiveRow {
  name: string;
  pct: number;
  last: number;
}

function Playground({
  sectors,
  nifty,
  sensex,
  confidence,
  pair,
  capPair,
}: {
  sectors: any[];
  nifty?: any;
  sensex?: any;
  confidence?: number;
  pair?: any;
  capPair?: any;
}) {
  const [live, setLive] = useState<LiveRow[]>([]);
  const [liveLoading, setLiveLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        LEADERBOARD_SYMBOLS.map(async ({ sym, name }) => {
          const q = await fetchQuote(sym);
          if (!q || q.pct == null || !Number.isFinite(q.pct)) return null;
          return { name, pct: q.pct, last: q.last } as LiveRow;
        })
      );
      if (cancelled) return;
      const rows = results
        .filter((r): r is LiveRow => r !== null)
        .sort((a, b) => b.pct - a.pct);
      setLive(rows);
      setLiveLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!sectors.length && !nifty && !sensex && !pair && !capPair) {
    return <EmptyState title="No leaderboard data" hint="Populates from tomorrow's cron." />;
  }
  const items = buildPlaygroundList(sectors, nifty, sensex, confidence);
  const max = Math.max(1, ...items.map((it) => Math.abs(it.score)));
  const liveMax = Math.max(0.1, ...live.map((r) => Math.abs(r.pct)));
  return (
    <div className="space-y-4">
      {/* Live leaderboard. Today's actual chg_pct ranking, top to bottom.
          Sits above the forecast ranking so the reader anchors on what
          actually happened before reading what the model expects next. */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-2">
          <div className="section-num mb-1 tracking-widest">LIVE</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Actual percent change today across the same universe the model
            forecasts on. Fetched live from yfinance each page load.
          </p>
        </div>
        {liveLoading ? (
          <div className="px-5 pb-5 flex items-center gap-2 text-sm text-[var(--muted)]">
            <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
            Fetching live quotes
          </div>
        ) : live.length === 0 ? (
          <div className="px-5 pb-5 text-sm text-[var(--muted)]">
            No live quotes available. Yfinance may be rate-limiting.
          </div>
        ) : (
          <LiveBars rows={live} max={liveMax} />
        )}
      </div>

      {/* Forecast ranking. The model's directional + confidence call for
          tomorrow, sorted same direction-sign x confidence convention. */}
      {items.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-5 pb-2">
            <div className="section-num mb-1 tracking-widest">FORECAST</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Model's ranked board for the next session. Direction sign times
              confidence, with the key driver behind every row.
            </p>
          </div>
          <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
            <colgroup>
              <col style={{ width: "5%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "10%" }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Instrument</th>
                <th>Direction</th>
                <th>Range</th>
                <th>Confidence</th>
                <th>Key Driver</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const accent =
                  it.score > 0
                    ? "var(--gain)"
                    : it.score < 0
                    ? "var(--loss)"
                    : "var(--muted)";
                const barPct = Math.min(100, (Math.abs(it.score) / max) * 100);
                return (
                  <tr key={`${it.name}-${i}`} className="align-middle">
                    <td className="num text-[var(--muted)] font-medium">{i + 1}</td>
                    <td className="font-medium whitespace-nowrap">{it.name}</td>
                    <td className="whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <DirPill direction={it.direction} />
                        <span
                          aria-hidden
                          className="inline-block rounded-full"
                          style={{
                            width: `${barPct * 0.6}px`,
                            maxWidth: 60,
                            height: 4,
                            background: accent,
                            opacity: 0.55,
                          }}
                        />
                      </div>
                    </td>
                    <td className="num whitespace-nowrap">
                      {it.range ? formatNumber(it.range) : "·"}
                    </td>
                    <td className="num whitespace-nowrap">{it.confidence ?? "·"}</td>
                    <td
                      className="text-[var(--muted)] text-sm whitespace-nowrap overflow-hidden text-ellipsis"
                      title={it.driver}
                    >
                      {it.driver || "·"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(pair || capPair) && (
        <div>
          <div className="mb-2 mt-2">
            <div className="section-num mb-1 tracking-widest">PAIR CALLS FORECAST</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              The model's relative-pair predictions for tomorrow. Read as
              context behind the ranked boards above.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pair && <PairBadge label="NIFTY vs BankNifty" data={pair} />}
            {capPair && <PairBadge label="NIFTY vs Midcap 150" data={capPair} />}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveBars({ rows, max }: { rows: LiveRow[]; max: number }) {
  // Horizontal bar graph. Each row: name on the left, bar centered at the
  // zero line, value at the right. Gain bars shoot right, loss bars shoot
  // left, mirrored around a vertical zero line so the visual axis itself
  // tells you "up vs down today" at a glance.
  return (
    <div className="px-5 pb-5">
      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const isGain = r.pct > 0;
          const isLoss = r.pct < 0;
          const accent = isGain ? "var(--gain)" : isLoss ? "var(--loss)" : "var(--muted)";
          // Half the inner track each side of zero so the largest absolute
          // move (up or down) fills 100% of its side.
          const widthPct = Math.min(100, (Math.abs(r.pct) / max) * 100);
          return (
            <div key={r.name} className="flex items-center gap-3 text-sm">
              <div className="w-6 text-right num text-[var(--muted)] font-medium">
                {i + 1}
              </div>
              <div className="w-24 sm:w-28 font-medium whitespace-nowrap truncate">
                {r.name}
              </div>
              {/* Bar track. Split at the center for symmetric mirroring. */}
              <div className="flex-1 flex items-center" style={{ minHeight: 18 }}>
                <div className="flex-1 flex justify-end pr-[1px]">
                  {isLoss && (
                    <span
                      aria-hidden
                      className="block rounded-l-full"
                      style={{
                        width: `${widthPct}%`,
                        height: 12,
                        background: accent,
                        opacity: 0.78,
                        transition: "width 0.5s ease-out",
                      }}
                    />
                  )}
                </div>
                <div
                  className="self-stretch"
                  style={{ width: 1, background: "var(--border)" }}
                  aria-hidden
                />
                <div className="flex-1 flex justify-start pl-[1px]">
                  {isGain && (
                    <span
                      aria-hidden
                      className="block rounded-r-full"
                      style={{
                        width: `${widthPct}%`,
                        height: 12,
                        background: accent,
                        opacity: 0.78,
                        transition: "width 0.5s ease-out",
                      }}
                    />
                  )}
                </div>
              </div>
              <div
                className="num whitespace-nowrap w-20 text-right"
                style={{ color: accent }}
              >
                {formatPct(r.pct)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PairBadge({ label, data }: { label: string; data: any }) {
  // Compact relative-pair card. Sits at the foot of the Playground so the
  // ranked board owns the headline; the pairs read as supporting context.
  const outperformer = (data.outperformer || "").toUpperCase();
  const spread = data.spread_pct;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="section-num mb-1">{label}</div>
          <div className="text-sm font-semibold">
            {outperformer ? `${outperformer} leads` : "Even"}
          </div>
        </div>
        {spread !== undefined && (
          <span className="pill num">spread {spread}%</span>
        )}
      </div>
      {data.rationale && (
        <p className="text-xs text-[var(--muted)] leading-relaxed mt-2 line-clamp-2" title={data.rationale}>
          {data.rationale}
        </p>
      )}
    </div>
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
                  className="text-[var(--muted)] text-sm whitespace-nowrap overflow-hidden text-ellipsis"
                  title={r.key_driver}
                >
                  {r.key_driver}
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

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CAPS,
  SECTORS,
  type Cap,
} from "@/lib/universe";
import {
  runCalculator,
  recommendSectors,
  recommendCaps,
  type CalcResult,
  type Risk,
  type Pick,
} from "@/lib/calculator";
import { formatMoney } from "@/lib/utils";
import { sb } from "@/lib/supabase";

interface LlmEnrichment {
  thesis?: string;
  per_pick?: Array<{ ticker: string; rationale: string }>;
  extra_risks?: string[];
  rebalance_triggers?: string[];
  exit_signals?: string[];
  backup_notes?: Array<{ ticker: string; when_to_swap: string }>;
}

type LlmStatus = "idle" | "queued" | "polling" | "ok" | "failed";

type HorizonUnit = "days" | "weeks" | "months" | "years";

function unitDays(u: HorizonUnit): number {
  if (u === "days") return 1;
  if (u === "weeks") return 7;
  if (u === "months") return 30;
  return 365;
}

const RISKS: Risk[] = ["Conservative", "Balanced", "Aggressive"];

export function Calculator() {
  const [amount, setAmount] = useState<number>(25000);
  const [horizonN, setHorizonN] = useState<number>(6);
  const [horizonU, setHorizonU] = useState<HorizonUnit>("months");
  const [risk, setRisk] = useState<Risk>("Balanced");
  const [sectors, setSectors] = useState<string[]>([]);
  const [caps, setCaps] = useState<Cap[]>([]);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const horizonDays = useMemo(() => horizonN * unitDays(horizonU), [horizonN, horizonU]);

  const toggleSector = (s: string) =>
    setSectors((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  const toggleCap = (c: Cap) =>
    setCaps((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );

  const onRecommend = () => {
    setSectors(recommendSectors(risk));
    setCaps(recommendCaps(risk));
  };

  const onRun = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await runCalculator({
        amount,
        horizonDays,
        risk,
        sectors,
        caps,
      });
      setResult(r);
    } catch (e: any) {
      setErr(e?.message || "Calculator failed");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const onReset = () => {
    setResult(null);
    setErr(null);
  };

  // LLM enrichment state lives at the parent so a Reset clears it too.
  const [llmStatus, setLlmStatus] = useState<LlmStatus>("idle");
  const [llmEnrichment, setLlmEnrichment] = useState<LlmEnrichment | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmRunId, setLlmRunId] = useState<number | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Stop polling when component unmounts or a new run starts.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const askSensei = async () => {
    if (!result || llmStatus === "queued" || llmStatus === "polling") return;
    if (pollRef.current) clearInterval(pollRef.current);
    setLlmStatus("queued");
    setLlmError(null);
    setLlmEnrichment(null);
    try {
      const inputPayload = {
        amount,
        horizonDays,
        risk,
        sectors,
        caps,
      };
      const r = await fetch("/api/calc-explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: inputPayload, deterministic: result }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok || typeof data.run_id !== "number") {
        setLlmStatus("failed");
        setLlmError(data?.error || `bot returned ${r.status}`);
        return;
      }
      setLlmRunId(data.run_id);
      setLlmStatus("polling");
      pollEnrichment(data.run_id);
    } catch (e: any) {
      setLlmStatus("failed");
      setLlmError(e?.message || "network error");
    }
  };

  // Poll the calculator_runs row every 4s until status flips from 'pending'.
  // Free-tier LLM calls take 30s-12min, so we cap polls at 25 minutes.
  const pollEnrichment = (runId: number) => {
    const start = Date.now();
    const MAX_MS = 25 * 60_000;
    const fetchOnce = async () => {
      try {
        const { data, error } = await sb
          .from("calculator_runs")
          .select("status,llm_json,error")
          .eq("id", runId)
          .limit(1);
        if (error) throw error;
        const row = (data || [])[0];
        if (!row) return;
        if (row.status === "ok") {
          setLlmEnrichment((row.llm_json || {}) as LlmEnrichment);
          setLlmStatus("ok");
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (row.status === "failed") {
          setLlmStatus("failed");
          setLlmError(row.error || "LLM call failed");
          if (pollRef.current) clearInterval(pollRef.current);
        } else if (Date.now() - start > MAX_MS) {
          setLlmStatus("failed");
          setLlmError("LLM call timed out after 25 minutes");
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (e: any) {
        // Transient supabase miss; keep polling.
        console.warn("Calc poll error:", e?.message || e);
      }
    };
    fetchOnce();
    pollRef.current = setInterval(fetchOnce, 4000);
  };

  // Wrapper around onReset that also clears LLM state.
  const onResetAll = () => {
    onReset();
    if (pollRef.current) clearInterval(pollRef.current);
    setLlmStatus("idle");
    setLlmEnrichment(null);
    setLlmError(null);
    setLlmRunId(null);
  };

  return (
    <div className="space-y-5">
      {/* Form */}
      <div className="card p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Amount */}
          <div>
            <div className="section-num mb-2">Amount</div>
            <div className="flex items-baseline gap-3 mb-3">
              <span className="text-3xl font-semibold num">
                {formatMoney(amount, "RELIANCE.NS")}
              </span>
              <span className="text-xs text-[var(--muted)]">
                ₹1,000 to ₹5,00,000
              </span>
            </div>
            <input
              type="range"
              min={1000}
              max={500000}
              step={1000}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full accent-[var(--foreground)]"
            />
            <div className="flex justify-between text-[0.7rem] text-[var(--muted)] mt-1">
              <span>₹1k</span>
              <span>₹50k</span>
              <span>₹1L</span>
              <span>₹2.5L</span>
              <span>₹5L</span>
            </div>
          </div>

          {/* Horizon */}
          <div>
            <div className="section-num mb-2">Horizon</div>
            <div className="text-3xl font-semibold mb-3 num">
              {horizonN} {horizonU}{" "}
              <span className="text-xs text-[var(--muted)] font-normal">
                ({horizonDays.toLocaleString("en-IN")} days)
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="number"
                min={1}
                max={120}
                value={horizonN}
                onChange={(e) => setHorizonN(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 px-2.5 py-1 text-sm rounded-md border border-border bg-transparent focus:outline-none focus:border-foreground"
              />
              <div className="flex gap-1 flex-wrap">
                {(["days", "weeks", "months", "years"] as HorizonUnit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setHorizonU(u)}
                    className={`px-3 py-1 text-xs rounded-md border border-border transition-colors ${
                      horizonU === u
                        ? "bg-foreground text-background"
                        : "hover:bg-[var(--muted-bg)]"
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Risk */}
        <div>
          <div className="section-num mb-2">Risk Appetite</div>
          <div className="flex gap-2 flex-wrap">
            {RISKS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRisk(r)}
                className={`px-4 py-1.5 text-sm rounded-full border transition-colors ${
                  risk === r
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:bg-[var(--muted-bg)]"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Sectors + Caps */}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="section-num">Sectors and Caps</div>
            <button
              type="button"
              onClick={onRecommend}
              className="px-4 py-1.5 text-xs rounded-full border border-foreground/40 hover:bg-[var(--muted-bg)] transition-colors"
              title="Auto-fill sectors and caps based on your risk appetite."
            >
              ✦ Sensei Recommend
            </button>
          </div>

          <div>
            <div className="text-xs text-[var(--muted)] mb-2">
              Sectors {sectors.length === 0 ? "(none = all sectors included)" : `(${sectors.length} selected)`}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SECTORS.map((s) => {
                const on = sectors.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSector(s)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                      on
                        ? "border-foreground bg-foreground text-background"
                        : "border-border hover:bg-[var(--muted-bg)]"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs text-[var(--muted)] mb-2">
              Caps {caps.length === 0 ? "(none = all caps included)" : `(${caps.length} selected)`}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CAPS.map((c) => {
                const on = caps.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleCap(c)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                      on
                        ? "border-foreground bg-foreground text-background"
                        : "border-border hover:bg-[var(--muted-bg)]"
                    }`}
                  >
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onRun}
            disabled={loading}
            className="px-5 py-2 text-sm font-medium rounded-full border border-foreground bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? "Computing" : "Run Calculator"}
          </button>
          {result && (
            <button
              type="button"
              onClick={onResetAll}
              className="px-4 py-2 text-sm rounded-full border border-border hover:bg-[var(--muted-bg)] transition-colors"
            >
              Reset
            </button>
          )}
          {err && (
            <span className="text-sm text-[var(--loss)]">{err}</span>
          )}
        </div>
      </div>

      {/* Result */}
      {result && (
        <CalcOutput
          result={result}
          enrichment={llmEnrichment}
          llmStatus={llmStatus}
          llmError={llmError}
          llmRunId={llmRunId}
          onAskSensei={askSensei}
        />
      )}
    </div>
  );
}

function CalcOutput({
  result,
  enrichment,
  llmStatus,
  llmError,
  llmRunId,
  onAskSensei,
}: {
  result: CalcResult;
  enrichment: LlmEnrichment | null;
  llmStatus: LlmStatus;
  llmError: string | null;
  llmRunId: number | null;
  onAskSensei: () => void;
}) {
  const { picks, backups, risks, totals, notes } = result;
  // Index per-pick rationale by ticker for table merge.
  const rationaleByTicker = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of enrichment?.per_pick || []) {
      if (p.ticker) m[p.ticker] = p.rationale;
    }
    return m;
  }, [enrichment]);
  const backupNoteByTicker = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of enrichment?.backup_notes || []) {
      if (b.ticker) m[b.ticker] = b.when_to_swap;
    }
    return m;
  }, [enrichment]);

  if (!picks.length) {
    return (
      <div className="card p-5">
        <div className="section-num mb-2">No allocation generated</div>
        <ul className="list-disc pl-5 space-y-1 text-sm text-[var(--muted)]">
          {risks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }

  const maxWeight = Math.max(1, ...picks.map((p) => p.weightPct));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-5"
    >
      {/* Summary header */}
      <div className="card p-5">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="section-num mb-1">Deployed</div>
            <div className="text-2xl font-semibold num">
              {formatMoney(totals.amount, "RELIANCE.NS")}
            </div>
          </div>
          <div>
            <div className="section-num mb-1">Picks</div>
            <div className="text-2xl font-semibold num">{totals.nPicks}</div>
          </div>
          <div>
            <div className="section-num mb-1">Sector Spread</div>
            <div className="text-2xl font-semibold num">
              {Object.keys(totals.pickedSectors).length}
            </div>
          </div>
          <div>
            <div className="section-num mb-1">Caps Used</div>
            <div className="text-2xl font-semibold num capitalize">
              {Object.keys(totals.pickedCaps).join(", ") || "·"}
            </div>
          </div>
        </div>
      </div>

      {/* Ask Sensei: triggers the LLM enrichment pass and polls the
          calculator_runs row by id. Result merges into picks (per-pick
          rationale) and renders extra sections below. */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[16rem]">
            <div className="section-num mb-1">Sensei's Layer</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Ask Sensei to wrap macro and sector context around every pick. The
              LLM call writes a per-stock rationale, rebalance triggers, exit
              signals, and risk insights beyond the mechanical flags. Result
              streams in below; free-tier calls land in 3-12 minutes.
            </p>
          </div>
          <button
            type="button"
            onClick={onAskSensei}
            disabled={llmStatus === "queued" || llmStatus === "polling"}
            className="px-5 py-2 text-sm font-medium rounded-full border border-foreground bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {llmStatus === "queued" && "Queueing"}
            {llmStatus === "polling" && "Sensei thinking"}
            {llmStatus === "ok" && "Re-run Sensei"}
            {llmStatus === "failed" && "Retry"}
            {llmStatus === "idle" && "Ask Sensei"}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {(llmStatus === "polling" || llmStatus === "queued") && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]"
            >
              <span className="inline-block size-2 rounded-full bg-[var(--muted)] animate-pulse" />
              <span>
                Polling calculator_runs id {llmRunId ?? "·"}. This page can
                stay open; the row updates when the LLM returns.
              </span>
            </motion.div>
          )}
          {llmStatus === "failed" && llmError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 text-sm text-[var(--loss)]"
            >
              {llmError}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {enrichment?.thesis && (
        <div className="card p-5">
          <div className="section-num mb-2">Sensei's Thesis</div>
          <p className="text-base leading-relaxed">{enrichment.thesis}</p>
        </div>
      )}

      {/* Allocation bars */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-2">
          <div className="section-num mb-1 tracking-widest">ALLOCATION</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Per-stock weight and INR amount. Ranking driven by momentum + RSI band,
            allocation by risk policy (Conservative equal-weight, Balanced 1/vol,
            Aggressive score-tilted).
          </p>
        </div>
        <div className="px-5 pb-5 space-y-1.5">
          {picks.map((p, i) => {
            const barPct = (p.weightPct / maxWeight) * 100;
            return (
              <div key={p.ticker} className="flex items-center gap-3 text-sm">
                <div className="w-6 text-right num text-[var(--muted)] font-medium">
                  {i + 1}
                </div>
                <div className="w-28 sm:w-36 font-medium whitespace-nowrap truncate" title={p.name}>
                  {p.ticker.replace(/\.NS$/, "")}
                </div>
                <div className="flex-1">
                  <div
                    aria-hidden
                    className="rounded-r-full bg-[var(--foreground)] opacity-70"
                    style={{
                      width: `${barPct}%`,
                      height: 12,
                      transition: "width 0.6s ease-out",
                    }}
                  />
                </div>
                <div className="num whitespace-nowrap w-16 text-right">
                  {p.weightPct.toFixed(1)}%
                </div>
                <div className="num whitespace-nowrap w-24 text-right text-[var(--muted)]">
                  {formatMoney(p.amountInr, "RELIANCE.NS")}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-pick detail table */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-2">
          <div className="section-num mb-1 tracking-widest">PER PICK</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Why each name made the cut. Reasoning is data-only: cap, sector, 60d move,
            RSI, realized vol. Phase 8b will layer macro and news on top.
          </p>
        </div>
        <table className="data" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: "11%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "8%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Cap</th>
              <th>Sector</th>
              <th>Weight</th>
              <th>Amount</th>
              <th>60d</th>
              <th>RSI</th>
              <th>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => (
              <PickRow
                key={p.ticker}
                p={p}
                llmRationale={rationaleByTicker[p.ticker]}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Sector concentration */}
      <div className="card p-5">
        <div className="section-num mb-2">Sector Spread</div>
        <div className="space-y-1.5">
          {Object.entries(totals.pickedSectors)
            .sort((a, b) => b[1] - a[1])
            .map(([sec, w]) => (
              <div key={sec} className="flex items-center gap-3 text-sm">
                <div className="w-24 font-medium">{sec}</div>
                <div className="flex-1">
                  <div
                    aria-hidden
                    className="rounded-r-full bg-[var(--muted)] opacity-60"
                    style={{ width: `${Math.min(100, w)}%`, height: 8 }}
                  />
                </div>
                <div className="num w-14 text-right">{w.toFixed(1)}%</div>
              </div>
            ))}
        </div>
      </div>

      {/* Backups */}
      {backups.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Backups (next in queue)</div>
          <ul className="space-y-3 text-sm">
            {backups.map((b) => {
              const swap = backupNoteByTicker[b.ticker];
              return (
                <li key={b.ticker}>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-medium">{b.ticker.replace(/\.NS$/, "")}</span>
                    <span className="text-[var(--muted)] text-xs">{b.reasoning}</span>
                  </div>
                  {swap && (
                    <div className="mt-1 pl-3 border-l border-border text-sm">
                      <span className="text-[var(--muted)] text-[0.7rem] uppercase tracking-wider mr-2">
                        Sensei
                      </span>
                      {swap}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Risks */}
      {risks.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Risk Flags</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {enrichment?.extra_risks && enrichment.extra_risks.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Sensei's Risk Insights</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {enrichment.extra_risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {enrichment?.rebalance_triggers && enrichment.rebalance_triggers.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Rebalance Triggers</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {enrichment.rebalance_triggers.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {enrichment?.exit_signals && enrichment.exit_signals.length > 0 && (
        <div className="card p-5">
          <div className="section-num mb-3">Exit Signals</div>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {enrichment.exit_signals.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes */}
      <div className="card p-5">
        <div className="section-num mb-3">Sensei's Note</div>
        <ul className="list-disc pl-5 space-y-2 text-sm text-[var(--muted)] leading-relaxed">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          <li>
            Not SEBI-registered advice. Educational allocation skeleton only. Validate
            every name against your own thesis before placing capital.
          </li>
        </ul>
      </div>
    </motion.div>
  );
}

function PickRow({ p, llmRationale }: { p: Pick; llmRationale?: string }) {
  return (
    <tr className="align-top">
      <td className="font-medium align-top" title={p.name}>
        {p.ticker.replace(/\.NS$/, "")}
      </td>
      <td className="align-top capitalize">{p.cap}</td>
      <td className="align-top">{p.sector}</td>
      <td className="num align-top">{p.weightPct.toFixed(1)}%</td>
      <td className="num align-top">{formatMoney(p.amountInr, "RELIANCE.NS")}</td>
      <td className="num align-top">
        {Number.isFinite(p.momentumPct)
          ? `${p.momentumPct >= 0 ? "+" : ""}${p.momentumPct.toFixed(1)}%`
          : "·"}
      </td>
      <td className="num align-top">
        {Number.isFinite(p.rsi) ? p.rsi.toFixed(0) : "·"}
      </td>
      <td
        className="text-[var(--muted)] text-sm align-top"
        style={{ whiteSpace: "normal", wordBreak: "break-word" }}
      >
        <div>{p.reasoning}</div>
        {llmRationale && (
          <div
            className="mt-2 pt-2 border-t border-border text-foreground"
            style={{ fontSize: "0.85rem" }}
          >
            <span className="text-[var(--muted)] text-[0.7rem] uppercase tracking-wider mr-2">
              Sensei
            </span>
            {llmRationale}
          </div>
        )}
      </td>
    </tr>
  );
}

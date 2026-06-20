"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { sb, DEFAULT_UID } from "@/lib/supabase";
import { cn, polishMarketText } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";

// Horizon selector. 30 = tactical (technicals + catalysts), 90 = swing
// (earnings + sector cycle), 180 = positional (valuation + multi-quarter).
// Each horizon has its own grading dim so cohorts stay disjoint.
const HORIZONS = [
  { days: 30, label: "30D", note: "Tactical · technicals + catalysts" },
  { days: 90, label: "90D", note: "Swing · earnings + sector cycle" },
  { days: 180, label: "180D", note: "Positional · valuation + trend" },
] as const;

const PHASE_PILL: Record<string, string> = {
  bearish: "pill-loss",
  moderate_bearish: "pill-warn",
  moderate_bullish: "pill-mid",
  bullish: "pill-gain",
};

const RATING_PILL: Record<string, string> = {
  buy: "pill-gain",
  hold: "pill-mid",
  sell: "pill-loss",
};

const PHASE_LABEL: Record<string, string> = {
  bearish: "Bearish",
  moderate_bearish: "Moderate Bearish",
  moderate_bullish: "Moderate Bullish",
  bullish: "Bullish",
};

interface StockAnalysisRow {
  id: number;
  requested_at: string;
  user_id: string | null;
  ticker: string;
  horizon_days: number;
  llm_json: any;
  model_used: string | null;
  status: "pending" | "ok" | "failed";
  error: string | null;
  graded_at: string | null;
  grade_score: number | null;
  grade_notes: string | null;
}

// localStorage key for ids the user has hidden from Recent Analyses.
// Hidden client-side ONLY - the underlying stock_analyses row, its
// graded score, and any prediction_scores it spawned stay in the DB
// so accuracy metrics and the next call's prior_self_predictions
// injection remain whole. Clearing this key shows every row again.
const HIDDEN_HISTORY_LS_KEY = "arcemx.stockAnalyst.hiddenHistoryIds.v1";

function normalizeTicker(raw: string): string {
  let t = raw.trim().toUpperCase();
  if (!t) return "";
  if (t.startsWith("^")) return t;
  if (t.endsWith(".NS") || t.endsWith(".BO") || t.includes(".")) return t;
  return `${t}.NS`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "·";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function StockAnalyst() {
  const [ticker, setTicker] = useState<string>("");
  const [horizon, setHorizon] = useState<number>(30);
  const [status, setStatus] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [currentRow, setCurrentRow] = useState<StockAnalysisRow | null>(null);
  const [history, setHistory] = useState<StockAnalysisRow[]>([]);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Each suggestion carries ticker + display name so the typeahead
  // can match the user's input against either, and render the name
  // alongside the slug. Sources merged on mount: NIFTY 500+ universe
  // (web/public/universe.json) + portfolio + wishlist.
  const [suggestions, setSuggestions] = useState<{ticker: string; name: string}[]>([]);
  // Typeahead state. open=true shows the floating result list under
  // the input; activeIdx tracks the keyboard-highlighted row so
  // ArrowUp / ArrowDown / Enter / Escape work without a mouse.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const suggestBoxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Tracks which history row ids are mid fade-out, so the AnimatePresence
  // exit animation lands before we drop the row from state.
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());

  // Ticker autocomplete: full NIFTY 500+ universe (web/public/
  // universe.json) merged with the user's holdings + wishlist so the
  // typeahead works for any listed Indian stock, not just names the
  // user already tracks. Universe carries display names too so a
  // typed brand ("ATHER") resolves to its slug ("ATHERENERG.NS")
  // even though the brand and slug do not share a prefix.
  useEffect(() => {
    (async () => {
      try {
        const [ph, wl, uniRes] = await Promise.all([
          sb.from("portfolio").select("ticker").eq("user_id", DEFAULT_UID),
          sb.from("wishlist").select("ticker").eq("user_id", DEFAULT_UID),
          fetch("/universe.json", { cache: "force-cache" }),
        ]);
        const byTicker = new Map<string, string>();
        // Hold + wishlist tickers come without display names from
        // their tables. Inserted first so the universe lookup can
        // back-fill a name when one matches.
        for (const r of (ph.data || []) as any[]) {
          if (r.ticker) byTicker.set(r.ticker, "");
        }
        for (const r of (wl.data || []) as any[]) {
          if (r.ticker) byTicker.set(r.ticker, "");
        }
        if (uniRes.ok) {
          const uni: {ticker: string; name: string}[] = await uniRes.json();
          for (const e of uni) {
            // Universe wins for display name; existing portfolio /
            // wishlist entry gets enriched with the name if it matches.
            byTicker.set(e.ticker, e.name || "");
          }
        }
        const merged = Array.from(byTicker.entries())
          .map(([ticker, name]) => ({ ticker, name }))
          .sort((a, b) => a.ticker.localeCompare(b.ticker));
        setSuggestions(merged);
      } catch {
        // Soft-fail: suggestions empty, user can still type freely.
      }
    })();
  }, []);

  // Load recent history (last 12 analyses across all tickers/horizons)
  // for the table below the result card.
  const loadHistory = async () => {
    try {
      // Fetch a few extra rows so the displayed list still hits the
      // 12-row visual cap after hidden ids are filtered out.
      const { data } = await sb
        .from("stock_analyses")
        .select("*")
        .order("requested_at", { ascending: false })
        .limit(40);
      let rows = (data || []) as StockAnalysisRow[];
      try {
        const raw = localStorage.getItem(HIDDEN_HISTORY_LS_KEY) || "[]";
        const hidden: number[] = JSON.parse(raw);
        if (hidden.length) {
          const hset = new Set(hidden);
          rows = rows.filter((r) => !hset.has(r.id));
        }
      } catch {}
      setHistory(rows.slice(0, 12));
    } catch {}
  };

  useEffect(() => {
    loadHistory();
  }, []);

  // Poll a single run row by id until status leaves pending. 2.5s
  // interval is the same cadence the calculator + portfolio_score
  // surfaces use; matches the LLM round-trip pace without flooding
  // the dyno.
  const pollUntilDone = (runId: number) => {
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const { data } = await sb
          .from("stock_analyses")
          .select("*")
          .eq("id", runId)
          .limit(1);
        const row = (data?.[0] as StockAnalysisRow) || null;
        if (!row) {
          if (attempts >= 80) {
            setStatus("error");
            setStatusMsg("Row not found");
            return;
          }
          pollTimer.current = setTimeout(tick, 2500);
          return;
        }
        setCurrentRow(row);
        if (row.status === "ok") {
          setStatus("ok");
          setStatusMsg(null);
          loadHistory();
          return;
        }
        if (row.status === "failed") {
          setStatus("error");
          setStatusMsg(row.error || "LLM call failed");
          return;
        }
        if (attempts >= 240) {
          // ~10 minutes total. The Nemotron Super chain can take
          // 7-12 min for a deep reasoning pass on free tier.
          setStatus("error");
          setStatusMsg("Timed out waiting for analysis");
          return;
        }
        pollTimer.current = setTimeout(tick, 2500);
      } catch (e: any) {
        if (attempts >= 80) {
          setStatus("error");
          setStatusMsg(String(e?.message || e));
          return;
        }
        pollTimer.current = setTimeout(tick, 2500);
      }
    };
    tick();
  };

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  const run = async () => {
    const tk = normalizeTicker(ticker);
    if (!tk) {
      setStatus("error");
      setStatusMsg("Enter a ticker");
      return;
    }
    setStatus("running");
    setStatusMsg("Calling the bot");
    setCurrentRow(null);
    try {
      const r = await fetch("/api/stock-analyst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: tk, horizon_days: horizon }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        setStatus("error");
        setStatusMsg(j?.error || j?.detail || `bot returned ${r.status}`);
        return;
      }
      if (j.status === "cached") {
        // Cache hit: row is already ok, fetch and render straight away.
        setStatusMsg("Cached for today");
        pollUntilDone(j.run_id);
        return;
      }
      setStatusMsg("Analyzing, 3 to 8 minutes typical");
      pollUntilDone(j.run_id);
    } catch (e: any) {
      setStatus("error");
      setStatusMsg(String(e?.message || e));
    }
  };

  const tickerCoverage = useMemo(() => {
    const tk = normalizeTicker(ticker);
    if (!tk || !suggestions.length) return null;
    return suggestions.some((s) => s.ticker === tk);
  }, [ticker, suggestions]);

  // Filtered, ranked suggestion list for the typeahead. Empty input
  // shows nothing (avoids a giant default dropdown on focus); typed
  // input matches either the ticker slug OR the display name. Rank
  // priority: ticker-prefix > name-prefix > ticker-contains >
  // name-contains, so a typed "REL" surfaces RELIANCE.NS before
  // INFRELRENEW.NS, and a typed "ATHER" finds ATHERENERG.NS via
  // its name (Ather Energy Ltd.) even though "ATHER" is not a
  // prefix of the slug.
  const filteredSuggestions = useMemo(() => {
    const q = ticker.trim().toUpperCase();
    if (!q) return [];
    const tickerPrefix: typeof suggestions = [];
    const namePrefix: typeof suggestions = [];
    const tickerContains: typeof suggestions = [];
    const nameContains: typeof suggestions = [];
    for (const s of suggestions) {
      const t = s.ticker.toUpperCase();
      const n = (s.name || "").toUpperCase();
      if (t.startsWith(q)) tickerPrefix.push(s);
      else if (n.startsWith(q)) namePrefix.push(s);
      else if (t.includes(q)) tickerContains.push(s);
      else if (n.includes(q)) nameContains.push(s);
    }
    return [...tickerPrefix, ...namePrefix, ...tickerContains, ...nameContains].slice(0, 12);
  }, [ticker, suggestions]);

  // Close the typeahead when the user clicks anywhere outside of it.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!suggestBoxRef.current) return;
      if (suggestBoxRef.current.contains(e.target as Node)) return;
      setSuggestOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const pickSuggestion = (s: { ticker: string; name: string }) => {
    setTicker(s.ticker);
    setSuggestOpen(false);
    setActiveIdx(0);
    inputRef.current?.focus();
  };

  // Remove a row from the Recent Analyses list. FRONTEND ONLY - the
  // stock_analyses row, its grading, and all downstream prediction_
  // scores must stay intact so accuracy metrics and the next call's
  // prior_self_predictions injection do not lose history. The hidden
  // id is persisted to localStorage so the row stays hidden across
  // page reloads; clearing localStorage brings every hidden row back.
  const removeHistoryRow = (id: number) => {
    if (removingIds.has(id)) return;
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Drop from local state so AnimatePresence runs the exit animation.
    setHistory((prev) => prev.filter((r) => r.id !== id));
    // If the removed row was the currently displayed analysis, clear it.
    setCurrentRow((cur) => (cur && cur.id === id ? null : cur));
    // Persist the hide so loadHistory does not re-surface the row on
    // the next refetch / page load.
    try {
      const raw = localStorage.getItem(HIDDEN_HISTORY_LS_KEY) || "[]";
      const list: number[] = JSON.parse(raw);
      if (!list.includes(id)) {
        list.push(id);
        localStorage.setItem(HIDDEN_HISTORY_LS_KEY, JSON.stringify(list));
      }
    } catch {
      // localStorage disabled / quota full: row stays hidden until
      // refresh, then returns. Acceptable graceful fallback.
    }
  };

  const llm = currentRow?.llm_json || null;

  return (
    <div className="space-y-5">
      {/* Input row */}
      <div className="card p-5">
        <div className="flex flex-col md:flex-row md:items-end gap-4">
          <div className="flex-1" ref={suggestBoxRef}>
            <div className="section-num mb-2">Ticker</div>
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                value={ticker}
                onChange={(e) => {
                  setTicker(e.target.value);
                  setSuggestOpen(true);
                  setActiveIdx(0);
                }}
                onFocus={() => { if (ticker.trim()) setSuggestOpen(true); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && filteredSuggestions.length) {
                    e.preventDefault();
                    setSuggestOpen(true);
                    setActiveIdx((i) => Math.min(i + 1, filteredSuggestions.length - 1));
                  } else if (e.key === "ArrowUp" && filteredSuggestions.length) {
                    e.preventDefault();
                    setActiveIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Escape") {
                    setSuggestOpen(false);
                  } else if (e.key === "Enter") {
                    if (suggestOpen && filteredSuggestions[activeIdx]) {
                      e.preventDefault();
                      pickSuggestion(filteredSuggestions[activeIdx]);
                    } else {
                      run();
                    }
                  }
                }}
                placeholder="Type to search e.g. RELIANCE, ANGELONE, NSEI"
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "w-full rounded-full border border-border bg-transparent",
                  "px-4 py-2 text-base font-medium tracking-wide outline-none",
                  "focus:border-foreground transition-colors"
                )}
              />
              {/* Custom typeahead. Replaces the native <datalist> dropdown
               * which (a) only showed after a click on the chevron in
               * many browsers and (b) could not be styled to match the
               * card aesthetic. Floats absolutely so it overlays the next
               * row without expanding the layout, and lives inside the
               * suggestBoxRef wrapper so an outside-click closes it. */}
              {suggestOpen && filteredSuggestions.length > 0 && (
                <ul
                  className={cn(
                    "absolute left-0 right-0 top-full mt-1 z-30",
                    "rounded-2xl border border-border bg-[var(--card)]",
                    "shadow-[0_10px_30px_rgba(0,0,0,0.18)] overflow-hidden",
                    "max-h-[280px] overflow-y-auto"
                  )}
                >
                  {filteredSuggestions.map((s, i) => (
                    <li
                      key={s.ticker}
                      onMouseDown={(e) => {
                        // mouseDown (not click) so the input does not lose
                        // focus and trigger the outside-click close before
                        // the selection lands.
                        e.preventDefault();
                        pickSuggestion(s);
                      }}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={cn(
                        "px-4 py-2 text-sm cursor-pointer flex items-center justify-between gap-3",
                        i === activeIdx
                          ? "bg-foreground text-background"
                          : "text-foreground hover:bg-[var(--muted-bg)]"
                      )}
                    >
                      <span className="font-medium tracking-wide">{s.ticker}</span>
                      {s.name && (
                        <span className={cn(
                          "text-xs truncate",
                          i === activeIdx ? "opacity-80" : "text-[var(--muted)]"
                        )}>
                          {s.name}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {tickerCoverage === false && ticker && (
              <p className="text-xs text-[var(--muted)] mt-2">
                Not in your holdings or wishlist. Analysis still runs; pattern depth is best for names you track.
              </p>
            )}
          </div>
          <div>
            <div className="section-num mb-2">Horizon</div>
            <div className="flex gap-1">
              {HORIZONS.map((h) => {
                const active = horizon === h.days;
                return (
                  <button
                    key={h.days}
                    type="button"
                    onClick={() => setHorizon(h.days)}
                    title={h.note}
                    className={cn(
                      "text-xs font-medium tracking-wide rounded-full px-4 py-2 border transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-[var(--muted)] hover:text-foreground"
                    )}
                  >
                    {h.label}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            onClick={run}
            disabled={status === "running" || !ticker.trim()}
            className={cn(
              "rounded-full border px-6 py-2 text-sm font-medium transition-colors",
              status === "running"
                ? "opacity-70 border-border"
                : "border-foreground bg-foreground text-background hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {status === "running" ? "Analyzing" : "Analyze"}
          </button>
        </div>
        <AnimatePresence>
          {statusMsg && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={cn(
                "mt-3 text-sm",
                status === "error" ? "text-[var(--loss)]" : "text-[var(--muted)]"
              )}
            >
              {statusMsg}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Result card */}
      {llm && currentRow?.status === "ok" && (
        <motion.div
          key={currentRow.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="card p-6 space-y-5"
        >
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <div className="section-num mb-1">
                {(currentRow.ticker || "").replace(/\.NS$/, "")}
                {" · "}
                {currentRow.horizon_days}D
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("pill", RATING_PILL[llm.rating])} style={{ minWidth: 70, justifyContent: "center" }}>
                  {(llm.rating || "").toUpperCase()}
                </span>
                <span className={cn("pill", PHASE_PILL[llm.phase])}>
                  {PHASE_LABEL[llm.phase] || llm.phase}
                </span>
                <span className="text-xs text-[var(--muted)] num">
                  Score {llm.score} · Confidence {llm.confidence}
                </span>
              </div>
            </div>
            <div className="text-xs text-[var(--muted)] text-right">
              {timeAgo(currentRow.requested_at)}
              {currentRow.model_used && (
                <div className="mt-1 truncate max-w-[180px]">
                  {currentRow.model_used.replace(/:free$/, "")}
                </div>
              )}
            </div>
          </div>

          <p className="text-base leading-relaxed">
            {polishMarketText(llm.summary)}
          </p>

          {llm.buy_window && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="rounded-2xl border border-border p-4">
                <div className="section-num mb-2">Buy Zone</div>
                <div className="text-lg font-semibold num">
                  ₹{llm.buy_window.target_price_low?.toLocaleString("en-IN")} – ₹{llm.buy_window.target_price_high?.toLocaleString("en-IN")}
                </div>
                {llm.buy_window.time_window_text && (
                  <p className="text-xs text-[var(--muted)] mt-2 leading-snug">
                    {polishMarketText(llm.buy_window.time_window_text)}
                  </p>
                )}
              </div>
              {llm.exit_window?.target_price != null && (
                <div className="rounded-2xl border border-border p-4">
                  <div className="section-num mb-2">Target</div>
                  <div className="text-lg font-semibold num text-[var(--gain)]">
                    ₹{Number(llm.exit_window.target_price).toLocaleString("en-IN")}
                  </div>
                </div>
              )}
              {llm.exit_window?.stop_loss != null && (
                <div className="rounded-2xl border border-border p-4">
                  <div className="section-num mb-2">Stop Loss</div>
                  <div className="text-lg font-semibold num text-[var(--loss)]">
                    ₹{Number(llm.exit_window.stop_loss).toLocaleString("en-IN")}
                  </div>
                </div>
              )}
            </div>
          )}

          {llm.reasoning && (
            <div className="space-y-3">
              <div className="section-num">Reasoning</div>
              {(
                [
                  ["technicals", "Technicals"],
                  ["valuation", "Valuation"],
                  ["fundamentals", "Fundamentals"],
                  ["news_flow", "News Flow"],
                  ["catalysts", "Catalysts"],
                  ["prior_calls", "Prior Calls"],
                ] as const
              ).map(([k, label]) => {
                const v = llm.reasoning?.[k];
                if (!v) return null;
                return (
                  <div key={k} className="rounded-2xl border border-border p-4">
                    <div className="text-xs uppercase tracking-wider text-[var(--muted)] mb-2">
                      {label}
                    </div>
                    <p className="text-sm leading-relaxed">{polishMarketText(String(v))}</p>
                  </div>
                );
              })}
              {Array.isArray(llm.reasoning?.risks) && llm.reasoning.risks.length > 0 && (
                <div className="rounded-2xl border border-[var(--loss)] border-opacity-40 p-4">
                  <div className="text-xs uppercase tracking-wider text-[var(--loss)] mb-2">Risks</div>
                  <ul className="list-disc pl-5 space-y-1.5 text-sm">
                    {llm.reasoning.risks.map((r: string, i: number) => (
                      <li key={i}>{polishMarketText(String(r))}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}

      {currentRow?.status === "failed" && (
        <div className="card p-5 border-[var(--loss)] border-opacity-40">
          <div className="section-num mb-2 text-[var(--loss)]">Analysis Failed</div>
          <p className="text-sm leading-relaxed">{currentRow.error || "Unknown error"}</p>
          <button
            onClick={run}
            className="mt-3 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-[var(--muted-bg)]"
          >
            Retry
          </button>
        </div>
      )}

      {/* History */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-2">
          <div className="section-num mb-1">Recent Analyses</div>
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Last 12 runs. Click a row to load it. Graded runs show the verdict score.
          </p>
        </div>
        {history.length === 0 ? (
          <EmptyState title="No analyses yet." hint="Run one above to populate this list." />
        ) : (
          <div className="table-scroll">
          <table className="data" style={{ width: "100%" }}>
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col />
            </colgroup>
            <colgroup>
              <col style={{ width: "18%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "9%" }} />
              <col style={{ width: "10%" }} />
              <col />
              <col style={{ width: "76px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Horizon</th>
                <th>Rating</th>
                <th>Phase</th>
                <th>Score</th>
                <th>Grade</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
              {history.map((h) => {
                const j = h.llm_json || {};
                const tk = (h.ticker || "").replace(/\.NS$/, "");
                return (
                  <motion.tr
                    key={h.id}
                    layout="position"
                    initial={false}
                    animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                    exit={{
                      opacity: 0,
                      scale: 0.96,
                      filter: "blur(2px)",
                      transition: { duration: 0.45, ease: [0.4, 0, 0.2, 1] }
                    }}
                    transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                    onClick={() => setCurrentRow(h)}
                    className="cursor-pointer hover:bg-[var(--muted-bg)]"
                  >
                    <td className="font-medium">{tk}</td>
                    <td className="num">{h.horizon_days}D</td>
                    <td>
                      {h.status === "ok" && j.rating ? (
                        <span className={cn("pill", RATING_PILL[j.rating])}>
                          {j.rating.toUpperCase()}
                        </span>
                      ) : h.status === "pending" ? (
                        <span className="pill pill-warn">PENDING</span>
                      ) : h.status === "failed" ? (
                        <span className="pill pill-loss">FAILED</span>
                      ) : (
                        "·"
                      )}
                    </td>
                    <td>
                      {h.status === "ok" && j.phase ? (
                        <span className={cn("pill", PHASE_PILL[j.phase])}>
                          {PHASE_LABEL[j.phase]}
                        </span>
                      ) : (
                        "·"
                      )}
                    </td>
                    <td className="num">{j.score ?? "·"}</td>
                    <td className="num">
                      {h.grade_score != null
                        ? `${Math.round(h.grade_score)}`
                        : h.graded_at
                        ? "·"
                        : <span className="text-[var(--muted)] text-xs">grading at +{h.horizon_days}d</span>}
                    </td>
                    <td className="text-[var(--muted)] text-sm whitespace-nowrap">{timeAgo(h.requested_at)}</td>
                    <td className="text-right pr-5">
                      <button
                        type="button"
                        aria-label={`Remove ${tk} analysis`}
                        title="Remove from list"
                        onClick={(e) => {
                          // Prevent the row click handler from loading the
                          // analysis back into the result card mid-removal.
                          e.stopPropagation();
                          removeHistoryRow(h.id);
                        }}
                        className={cn(
                          "inline-flex items-center justify-center size-9 rounded-full",
                          "border border-border text-[var(--muted)]",
                          "hover:text-[var(--loss)] hover:border-[var(--loss)]",
                          "hover:bg-[color-mix(in_srgb,var(--loss)_10%,transparent)]",
                          "transition-colors"
                        )}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2.4"
                          strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6L6 18" />
                          <path d="M6 6l12 12" />
                        </svg>
                      </button>
                    </td>
                  </motion.tr>
                );
              })}
              </AnimatePresence>
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

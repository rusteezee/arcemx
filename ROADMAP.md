# Arc'emX Roadmap — 6-12 Months Through Phase B

Planned 2026-07-13 by the planning model (Fable 5), grounded in a full repo audit
(4 subsystem maps), live July-2026 research (free-tier LLM/infra/training facts, all
sourced), and the project's standing doctrines. Execution is designed for cheaper
builder models via the blueprints in `blueprints/` — each is cold-start buildable.

## North star (unchanged)

Personal research-grade system. Peak tier — **Sharpe > 2.0, max DD < 8%, PSR > 0.995 —
lives in Phase B and is not rushed.** Tier 1 (Sharpe > 1.0, DD < 15%, PSR > 0.95 on
live paper trades) unlocks Phase B. ₹0 recurring cost is a hard rule; one-time spends
are flagged decisions, never assumptions. Not SEBI-registered advice; educational.

## Where the system stands (2026-07-13)

- Single-model LLM chain (nemotron-3-super → gpt-oss-120b/20b, one provider: OpenRouter).
- Paper trader was silently broken since launch (yfinance MultiIndex bug, fixed
  2026-07-12) — **0 trades ever; sample accumulation starts now.** 747 signals evaluated,
  all skipped (low_conf 300 / not_buy 274 / low_edge 116 / no_liquidity_data 44).
- Backtest v2 live: 47 replayed trades, Sharpe -13.3, win rate 21% — small, hostile
  sample; the honest read is "the gates and the geometry need the Wave-1/2 work below."
- Fine-tune dataset: 2,274 / 3,000 graded rows (≈42/day → gate clears ~30 Jul 2026).
- Alerts, Realized P&L, backtest page all shipped. Render's free tier degrades Aug 1.

## The critical path

Everything routes through one number: **closed paper trades.** Sharpe/PSR/tier gates,
Kelly activation (60 trades), calibration quality, and the LoRA dataset all scale with
it. Wave 1-2 features exist to make the trades that now start flowing *measured,
protected, and honest* — not to add surface area.

## Waves

### Wave 0 — Stop the bleeding (this week, ~Jul 14-20)
| # | Blueprint | Why now |
|---|---|---|
| 16 | hygiene-sweep | mcp_tokens RLS security probe FIRST; schema parity; dead code/secrets; NSE-holiday guard |
| 02 | deadman-switch-observability | closes the "silent 2-week outage" class forever; 20 free checks |
| 01 | multi-provider-llm-failover | one-provider fragility is the top pipeline risk; Gemini (1,500 req/day) + Groq free |
| — | **Decision: $10 OpenRouter one-time** | unlocks 50 → 1,000 req/day permanently (verified live 2026-07-13). Single highest-leverage spend available. User's call. |
| — | **[USER] Start Oracle signup** | lead time for card friction + A1 capacity; Singapore region; convert to PAYG immediately |

### Wave 1 — Protect + measure the new trade flow (Jul 20 – Aug 1, hard deadline)
| # | Blueprint | Why |
|---|---|---|
| 15 | oracle-migration-runbook | **Render forced migration Aug 1** (5GB bandwidth cap). Deploy-script-first, zero state on box |
| 03 | regime-filter-gate | trend + VIX + vol-percentile gate (small-N-robust; HMM rejected) — protects the young book |
| 07 | earnings-blackout-gate | July earnings season is NOW; gap risk stops can't protect against |
| 12 | skipped-winner-attribution | starts capturing geometry on every skip immediately — the longer it runs, the smarter gate tuning gets |

### Wave 2 — Honesty layer (early-mid Aug)
| # | Blueprint | Why |
|---|---|---|
| 04 | winprob-recalibration-platt | replace the crude bias debit with a fitted calibration curve (214 pairs suffice for global fit) |
| 08 | drawdown-circuit-breaker | armed automatically at 10 closed trades |
| 10 | dsr-pbo-honesty-layer | Deflated Sharpe + PBO on every backtest; Tier-1 claims must survive DSR ≥ 0.90 |
| 06 | fii-dii-history-trend | cheap payload upgrade; persistent-flow context |

### Wave 3 — Signal expansion (mid Aug – Sep)
| # | Blueprint | Why |
|---|---|---|
| 05 | options-signals-indmoney | PCR/OI-walls/max-pain via INDmoney MCP (datacenter-IP-proof; nsepython path is blocked from runners) |
| 11 | short-side-paper-trading | doubles sample rate; hedges book; reactivates dormant pick_tp_sl dim; honesty-tagged idealized shorts |
| 14 | rag-phase1-activation | similarity exemplars (consumer already built, gated); requires re-embed + user-run RPC; 14-day A/B verdict |

### Wave 4 — Gated Phase B core (fires when its gate clears, not by date)
| # | Blueprint | Gate |
|---|---|---|
| 09 | half-kelly-sizing | **60 closed paper trades** (est. late Aug – Sep) |
| 13 | lora-finetune-pipeline | **3,000 prediction_scores** (est. ~30 Jul for export build; train after). Free Kaggle T4 + Unsloth; specialist stays ADVISORY (own model_slug, graded 14+ days) until it beats the live chain on ≥2 dims — promotion is the user's call |

### Dependency notes
03 before 11 (shorts reference regime interaction). 16's security probe precedes
everything. 10's DSR check becomes binding on any Tier-1 claim. 13's exporter can build
any time; the training run waits for the row gate. All others are independent.

## Cost ledger

**Recurring: ₹0.** Optional one-times, all flagged, all user decisions:
| Item | Cost | Buys |
|---|---|---|
| OpenRouter lifetime credit | $10 (~₹850) | 50 → 1,000 req/day forever; strongly recommended |
| Oracle PAYG verification hold | $0 (temporary ~$100 card hold, released) | kills idle-reclaim risk |
| LoRA paid fallback (RunPod/Fireworks) | ~$1-5 one-time | only if free Kaggle path fails |
| Hetzner CAX11 fallback | ~₹500/mo **recurring — decision point, not default** | only if Oracle signup fails outright |

## Measurable exit gates per wave

- **W0:** every scheduled cron deadman-monitored; ≥3 independent LLM providers callable;
  mcp_tokens verified anon-blocked.
- **W1:** bot answering from Oracle, Render suspended; regime + earnings gates active in
  BOTH paper_trader and backtest; skip geometry accumulating.
- **W2:** every backtest run reports DSR + PBO; breaker armed; calibration method =
  "platt" appearing in signal meta.
- **W3:** options_signals + flows_trend in ≥90% of morning payloads; first short trade
  graded; RAG A/B baseline + activation snapshot recorded.
- **W4:** Kelly meta on live trades; specialist-v1 accuracy tracked ≥14 days.
- **Phase B unlock (unchanged + hardened):** Tier-1 on live paper trades **plus DSR ≥ 0.90**.

## Parked — with reasons (do not resurrect casually)

- **IPO tracker** — no verified free data path from cloud runners (NSE blocks datacenter
  IPs; INDmoney MCP has no IPO tool). Revisit only with a working data probe.
- **US stocks / MF+US realized-P&L imports** — zero real holdings data to validate
  against (get-the-real-sample doctrine). Auto-unparks when holdings exist.
- **Multi-user / public product** — explicitly out of scope (user decision 2026-07-13).
- **Isotonic recalibration** — needs ~1,000+ calibration pairs; Platt (2-param) until then.
- **HMM regime detection** — decorative at current sample size; trend+VIX filter chosen.
- **Always-on specialist serving** — no viable free path (verified July 2026); batch-only.
- **Vibe-Trading** — parked per 2026-07-12 evaluation; needs explicit re-confirmation.
- **Ensemble revival** — if ever reconsidered, fix the vote-fraction dilution
  (`eff_wp = stated_wp * votes/n`) first; see memory `project-12jul-ensemble-removal`.

## Operating rules for executing this roadmap

1. One blueprint per session/PR; verify live before the next (the standing doctrine).
2. Any blueprint that changes gates MUST show the before/after backtest delta.
3. New spend of any kind: ask first (`feedback-ask-before-spending-new-quota`).
4. Blueprints are exact but not sacred: if the repo has drifted when a builder picks one
   up, the builder re-grounds against the named files and tags ASSUMPTION on deviations.

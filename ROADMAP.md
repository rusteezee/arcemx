# Arc'emX Roadmap. 6-12 Months Through Phase B

Planned 2026-07-13 by the planning model (Fable 5), grounded in a full repo audit
(4 subsystem maps), live July-2026 research (free-tier LLM/infra/training facts, all
sourced), and the project's standing doctrines. Execution is designed for cheaper
builder models via the blueprints in `blueprints/`. each is cold-start buildable.

**Refreshed 2026-08-16** (Claude, this session): verified every Wave 0-3 blueprint's
actual implementation status against the live code (not assumption) - almost
everything below was still marked as future work but is in fact already built and
wired in. The one real gate left is Wave 4's paper-trade sample size; see below.

## North star (unchanged)

Personal research-grade system. Peak tier. **Sharpe > 2.0, max DD < 8%, PSR > 0.995 -
lives in Phase B and is not rushed.** Tier 1 (Sharpe > 1.0, DD < 15%, PSR > 0.95 on
live paper trades) unlocks Phase B. ₹0 recurring cost is a hard rule; one-time spends
are flagged decisions, never assumptions. Not SEBI-registered advice; educational.

## Where the system stands (2026-08-16)

- Multi-provider LLM chain live: OpenRouter (nemotron-3-super) → Gemini → Groq
  failover (blueprint 01). A 4th failure mode (semantically-degenerate-but-
  syntactically-valid output, e.g. every ticker given the same uniform call) was
  found and fixed 2026-08-15 (`llm_router._response_degenerate`), unverified
  against a real live failover event yet.
- Paper trader is live and accumulating: **27 closed trades** (was 0 at the last
  roadmap pass). Kelly-sizing gate (blueprint 09, 60 trades) is **not built yet** -
  correctly deferred, the gate hasn't cleared anyway. Rate of accumulation going
  forward is uncertain: `top_performer_1d` alone drove ~96% of historical volume and
  was just correctly gated off by the calibration system (Pearson r=0.0254 vs
  realized outcome - no measurable skill).
- **The paper trader's entry geometry had a fundamental negative-EV bug**, found and
  fixed 2026-08-15: target/stop came straight from the LLM's freehand price picks
  with zero volatility validation (mean target 3.80σ, stop 1.67σ - stops ~28x more
  likely to hit than targets). Replaced with De Prado's triple-barrier method
  (`analyzer/geometry.py`, volatility-scaled). Official post-fix backtest
  (`backtest_runs` id=5): 64 trades, win rate 20.31%, **Sharpe -14.1, PSR 0, DSR 0**.
  Geometry is fixed; the LLM's directional accuracy (needs ~40% win rate at this
  ratio) is the one blocker left before Tier-1 can even be attempted honestly.
- LoRA specialist model: **v1 shipped, found unusable** (degenerate output -
  schema-placeholder echo, ~139 training examples/dim was too few for a 3B model
  regardless of hyperparameters). **v2 trained and shipped 2026-08-16** as GitHub
  Release `specialist-v2` - merged live+historical data (~1,330 examples/dim, ~12x
  v1), dropped `top_performer_1d` entirely (no measurable skill, see above). Passed
  a real local inference sanity check (no degenerate output, unlike v1). Advisory
  only until it beats the live chain on ≥2 dimensions over 14+ days.
- **Full security lockdown shipped 2026-08-15/16** (not in the original roadmap - an
  audit found the dashboard fully public with no auth, and RLS granting the public
  anon key unrestricted read on ~19 tables regardless of any login screen):
  owner-only auth wall (`web/proxy.ts`, Google + password via Supabase Auth), RLS
  rewritten to `authenticated` + `auth.uid()`-scoped, real CSP/security headers,
  `next` bumped 16.2.7→16.3.1 (0 vulnerabilities, was 4 high). Separately, the
  Telegram bot had a critical unrelated gap - **zero caller-identity check on any
  command**, including `/halt` `/resume` `/real_open` `/close_order` which act on
  global exec state - fixed with a single owner-only guard (commit `2911377`).
- PWA shipped (manifest, icons, service worker) - installable today. A native app
  (widgets, biometric unlock, push notifications, full Telegram elimination) is
  planned but research-stage only - see `blueprints/20-native-app-migration.md`,
  0% built, real architecture decisions not yet made.
- One open loose end: **blueprint 14's RAG Phase 1 A/B review is overdue.** Activated
  2026-07-16, review date was 2026-08-06 (10 days ago as of this refresh) - see
  `blueprints/_pending_ab_rag.md` for the exact comparison to run. Not done yet.

## The critical path

Everything routes through one number: **closed paper trades.** Sharpe/PSR/tier gates,
Kelly activation (60 trades), calibration quality, and the LoRA dataset all scale with
it. Wave 1-2 features exist to make the trades that now flow *measured, protected, and
honest* - that infrastructure is now built (see Waves below); what's left is the
sample itself accumulating, and closing the directional-accuracy gap geometry alone
couldn't fix.

## Waves

### Wave 0. Stop the bleeding — ✅ DONE
| # | Blueprint | Status |
|---|---|---|
| 16 | hygiene-sweep | ✅ Done - RLS probe, schema parity, dead code, NSE-holiday guard all verified live in code |
| 02 | deadman-switch-observability | ✅ Done - dead-man pings wired into workflows (e.g. `specialist_eval.yml`) |
| 01 | multi-provider-llm-failover | ✅ Done - OpenRouter → Gemini → Groq chain live, extended 2026-08-15 with degenerate-output detection |

### Wave 1. Protect + measure the new trade flow — ✅ DONE (Oracle migration excepted)
| # | Blueprint | Status |
|---|---|---|
| 15 | oracle-migration-runbook | **✅ Bot live on Oracle (2026-08-29)** - `VM.Standard.A1.Flex` 4 OCPU/24GB, verified end-to-end (`/trigger/sync` returned real data through the full Netlify->bot->Supabase->GH Actions path). Render kept suspended-not-deleted for a ~2 week safety window before full retirement. Two real bugs found and fixed during migration: Oracle's stock Ubuntu image blocks port 80/443 via iptables regardless of the cloud Security List (now fixed in `setup.sh` permanently), and reserved-IP attachment only works from the instance's own VNIC page, not the Reserved IPs list. See `KNOWLEDGE_BASE.md` §8. Cron-scheduling migration (GH Actions -> this box) is a separate, not-yet-started future step |
| 03 | regime-filter-gate | ✅ Done - trend+VIX+vol-percentile gate active in both `paper_trader.py` and `backtest.py` |
| 07 | earnings-blackout-gate | ✅ Done - active in both live and backtest paths |
| 12 | skipped-winner-attribution | ✅ Done - `analyzer/skip_attribution.py`, geometry captured on every skip, rendered on the trader page |
| 17 | news-relevance-engine | ✅ Done - ticker linking + portfolio-aware alerts, `hourly_news.yml` live |
| 18 | free-data-source-expansion | ✅ Done - dead feeds replaced, new sources added |

### Wave 2. Honesty layer — ✅ DONE
| # | Blueprint | Status |
|---|---|---|
| 04 | winprob-recalibration-platt | ✅ Done - Platt calibration live on multiple dims |
| 08 | drawdown-circuit-breaker | ✅ Done - breaker logic in both live and backtest paths |
| 10 | dsr-pbo-honesty-layer | ✅ Done - DSR + PBO computed on every backtest run (confirmed live in `backtest_runs` output) |
| 06 | fii-dii-history-trend | ✅ Done |

### Wave 3. Signal expansion — ✅ DONE
| # | Blueprint | Status |
|---|---|---|
| 05 | options-signals-indmoney | ✅ Done - PCR/OI-walls/max-pain wired into the payload |
| 11 | short-side-paper-trading | ✅ Done - short paper trades live, graded separately (`short_pick_tp_sl`) |
| 14 | rag-phase1-activation | ✅ Built and active, **⚠️ 14-day A/B review overdue** (see loose end above) |
| 19 | indstocks-execution-layer | ✅ Done, at its designed ceiling - read-only stage (funds/LTP) and manual-confirm stage (Execute/Skip) both live; Stage 3 auto-execution explicitly rejected in code, correctly stays locked behind Phase B |

### Wave 4. Gated Phase B core — blocked on the gate, not by date
| # | Blueprint | Gate | Status |
|---|---|---|
| 09 | half-kelly-sizing | 60 closed paper trades | **Not built** - correctly deferred, currently 27/60 |
| 13 | lora-finetune-pipeline | 3,000 prediction_scores | ✅ Gate cleared 2026-07-26. v1 shipped (unusable), **v2 shipped 2026-08-16**, advisory-only pending 14+ day live comparison |

### Wave 5. Native app migration (new, not in the original plan)
| # | Blueprint | Status |
|---|---|---|
| 20 | native-app-migration | **Research-stage only, 0% built.** Push notifications w/ actions, biometric unlock, and sensors all confirmed feasible inside the existing PWA (no native wrapper needed); home-screen interactive widgets confirmed to require a native TWA wrapper - the one piece forcing this wave. See `blueprints/20-native-app-migration.md` for the full research + open questions |

### Dependency notes
03 before 11 (shorts reference regime interaction) - satisfied, both done. 16's
security probe preceded everything - satisfied. 10's DSR check is binding on any
Tier-1 claim - live, and currently failing (DSR 0). 18 after 17 - satisfied, both
done. Wave 5 depends on nothing above being incomplete; it's independent, just not
started.

## Cost ledger

**Recurring: ₹0.** Spend so far, all one-time:
| Item | Cost | Status |
|---|---|---|
| OpenRouter lifetime credit | $10 (~₹850) | Approved 2026-07-13 by user |
| LoRA training | ₹0 | Free Kaggle T4 GPU-hours used for both v1 and v2, no paid fallback needed |
| INDstocks brokerage | ₹5 flat per real order | Not yet incurred - Stage 3 auto-execution doesn't exist, and no real orders have been manually confirmed either as of this refresh |
| Oracle Cloud | $0 | Live - bot hosted on Always Free VM.Standard.A1.Flex since 2026-08-29, see Wave 1 |

## Measurable exit gates per wave

- **W0-W3:** all satisfied and verified live as of this refresh (2026-08-16).
- **W4:** Kelly meta on live trades - not yet, blocked on trade count. Specialist
  accuracy tracking - v2 just started its 14+ day clock 2026-08-16.
- **Phase B unlock (unchanged + hardened):** Tier-1 on live paper trades **plus
  DSR ≥ 0.90**. Current real numbers: Sharpe -14.1, PSR 0, DSR 0. Not close - the
  geometry bug is fixed, directional accuracy is the remaining blocker.
- **W5 (new):** no exit gate defined yet - blueprint 20 isn't build-ready.

## Parked. with reasons (do not resurrect casually)

- **IPO tracker**. no verified free data path from cloud runners (NSE blocks datacenter
  IPs; INDmoney MCP has no IPO tool). Revisit only with a working data probe.
- **Twitter/X sentiment**. official API $5K-$42K/month; free scraping libraries
  (twscrape, Twikit) confirmed live broken (biometric login checks, 429s, unpatched
  KeyErrors since March 2026) plus a real $15,000/1M-post ToS liability; Apify-hosted
  scraping inherits the same legal risk and prices free-tier Twitter access at
  $40/1,000 specifically to block this use case. Revisit only if a genuinely free,
  legal, reliable path appears - none exists as of 2026-08-28.
- **US stocks / MF+US realized-P&L imports**. zero real holdings data to validate
  against (get-the-real-sample doctrine). Auto-unparks when holdings exist.
- **Multi-user / public product**. explicitly out of scope (user decision 2026-07-13).
- **Isotonic recalibration**. needs ~1,000+ calibration pairs; Platt (2-param) until then.
- **HMM regime detection**. decorative at current sample size; trend+VIX filter chosen.
- **Always-on specialist serving**. no viable free path (verified July 2026); batch-only.
- **Vibe-Trading**. parked per 2026-07-12 evaluation; needs explicit re-confirmation.
- **Ensemble revival**. if ever reconsidered, fix the vote-fraction dilution
  (`eff_wp = stated_wp * votes/n`) first; see memory `project-12jul-ensemble-removal`.

## Operating rules for executing this roadmap

1. One blueprint per session/PR; verify live before the next (the standing doctrine).
2. Any blueprint that changes gates MUST show the before/after backtest delta.
3. New spend of any kind: ask first (`feedback-ask-before-spending-new-quota`).
4. Blueprints are exact but not sacred: if the repo has drifted when a builder picks one
   up, the builder re-grounds against the named files and tags ASSUMPTION on deviations.
5. This file drifts too - it went a full month stale before this refresh. Re-verify
   against real code before trusting it, the same way blueprint 4 above says to.

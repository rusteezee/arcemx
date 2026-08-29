# Blueprint 21. Horizon Pivot: trade where the model actually has skill

**Status:** Phase 0 + revised Phase 1 built 2026-08-28. Phase 5 built
2026-08-29 (see PHASE 5 REVISED below - `portfolio_verdicts` "add" ruled
out, `stock_analyst` seeding built instead). Supersedes nothing; changes
what the paper trader consumes, not how it manages risk.

**CORRECTION 2026-08-28, same day, before Phase 1 was implemented:** the
original version of this blueprint recommended trading `wishlist_signals`
`buy_now` calls at a 60-session horizon, justified by `long_pick_tp_sl`
(t=+5.71). That justification was wrong on two independent counts, both
caught before any trading code shipped:

1. `long_pick_tp_sl` grades `raw.get("long_term_picks")`. That field was
   real in the schema used up to ~analysis_id 77 (June 2026) - confirmed
   by reading `analysis.raw_json` directly for id=24, which has a genuine
   `long_term_picks` array with real theses. **The current SYSTEM_PROMPT
   does not generate this field at all.** It is dead - no longer connected
   to anything the live pipeline produces. It has nothing to do with
   `wishlist_signals`.
2. Even setting that aside, isolating `wishlist_signals` `buy_now` calls
   specifically (not the blended `wishlist_7d` score, which mixes
   buy_now/wait/skip) shows **no edge**: n=338, mean 7-day return -0.13%,
   t=-0.44. The strong `wishlist_7d` aggregate score is driven almost
   entirely by `skip` calls correctly predicting declines (n=176, mean
   -2.11%, t=-6.97), not by `buy_now` predicting gains.

Net effect: there is currently **no validated positive-edge "what to buy"
signal** anywhere in the live schema. Every source with real, live,
current skill is a NEGATIVE filter (`avoid_7d`, wishlist `skip`). Phase 1
below was rewritten accordingly - it adds negative filters, not a new buy
source. Reviving a buy source is deferred to Phase 5.

**Origin:** a full skill audit of all 4,310 graded `prediction_scores` rows,
run 2026-08-28 to answer "why is the paper trader's win rate only 20%?".
Every number below is measured from live data, not assumed. Reproduce with
the queries in the APPENDIX.

---

## GOAL

Stop trading the signal class the model is measurably WORST at, and start
trading the signal classes it is measurably BEST at. No change to gates,
sizing, or risk doctrine. This is a signal-selection change.

---

## CONTEXT THE BUILDER NEEDS

### The diagnosis, in one line

The paper trader is trading at the exact horizon where the model has the
least skill, from the one signal source with proven negative alpha, while
the model's genuinely skilled long-horizon output is never traded at all.

### Finding 1: the traded signal has negative alpha, persistently

`top_performer_1d`, 792 individually-graded picks (alpha = pick's 1-day move
minus NIFTY's same-day move):

| slice | n | mean alpha | win rate | t |
|---|---|---|---|---|
| ALL | 792 | **-0.181%** | 41.7% | -2.56 |
| quarter 1 | 259 | -0.010% | 42.5% | -0.08 |
| quarter 2 | 191 | -0.590% | 30.4% | -3.91 |
| quarter 3 | 210 | -0.014% | 49.0% | -0.10 |
| quarter 4 | 132 | -0.192% | 44.7% | -1.15 |

Never positive in any quarter. This source drove **47 of 64 trades** in
backtest run id=5.

### Finding 2: conviction tiering is not informative

| tier | n | mean alpha | win rate | t |
|---|---|---|---|---|
| A (highest conviction) | 43 | +0.019% | 44.2% | +0.05 |
| B (the bulk) | 622 | -0.217% | 39.7% | -2.80 |
| C (speculative) | 125 | -0.095% | **50.4%** | -0.54 |

The model's "speculative" C-tier picks have a HIGHER win rate than its
"solid" B-tier picks. The A/B/C label carries no usable information. Do not
gate on conviction, and do not size by it.

### Finding 3: skill increases monotonically with horizon

Target-before-stop outcomes (score 100 = target hit first, 0 = stop first,
50 = neutral):

| dimension | horizon | n | mean | t vs 50 | target-first | stop-first |
|---|---|---|---|---|---|---|
| `short_pick_tp_sl` | 10 sessions | 40 | 38.28 | **-2.60** | 7.5% | 17.5% |
| `pick_tp_sl` | 10 sessions | 76 | 42.16 | **-1.96** | 13.2% | 30.3% |
| `verdict_tp_sl` | 20 sessions | 139 | 56.40 | +3.13 | 8.6% | 2.9% |
| `long_pick_tp_sl` | **60 sessions** | 48 | **73.96** | **+5.71** | **52.1%** | **4.2%** |

At 60 sessions the model's long picks hit target before stop 52.1% of the
time and hit the stop first only 4.2% of the time - a 12:1 ratio. At 10
sessions the same style of pick is significantly NEGATIVE. The horizon is
the variable that matters most.

Two more long-horizon dimensions with good sample sizes and strong results:

| dimension | n | mean | t vs 50 |
|---|---|---|---|
| `wishlist_7d` | 157 | 64.53 | **+8.31** |
| `avoid_7d` | 141 | 66.92 | **+7.68** |
| `verdict_7d` | 160 | 47.77 | -1.51 |

### Finding 4: none of the skilled signals are traded

The trader's `eval_signals()` consumes exactly four sources:
`stock_analyst`, `top_performer`, `worst_performer`,
`holding_outlook_1d`/`wishlist_outlook_1d`.

- `wishlist_signals` `skip` calls (the real, validated half of
  `wishlist_7d` - see CORRECTION above; `buy_now` itself has no edge):
  **never used**, not even as a negative filter.
- `stocks_to_avoid` (graded as `avoid_7d` t=+7.68): **never traded**, not
  even as a negative filter.
- `portfolio_verdicts` (graded as `verdict_tp_sl` t=+3.13): **never traded.**
- `stock_analyst` (horizon 30, the deep path): produced **zero** trades in
  the backtest, because `stock_analyses` rows are only created on-demand
  from the dashboard, never systematically.

Meanwhile **all 64 backtest trades ran at `horizon_days=1`**, and 59 of 64
were long.

### Finding 5: the economics of a 1-day horizon do not work at this size

- Measured 1-day alpha magnitude: ~0.2%.
- Measured round-trip cost hurdle: 0.5% on larger positions, **0.86% on the
  qty=1 cohort** (27 of 64 trades, avg entry ₹2,928, avg cost ₹25.10).
- The cost hurdle is 2.5x to 4.5x the size of the signal.

Even a *correct* 1-day call cannot pay for its own execution at this
account size. This is not a tuning problem; it is arithmetic. External
research agrees: intraday/1-day predictable returns are real but measured
in basis points, and turn negative for every size category once the spread
is paid ([Intraday Patterns in the Cross-section of Stock
Returns](https://arxiv.org/pdf/1005.3535)).

A 60-session hold pays the same ~0.5% round trip once, against a move with
room to be multiples of that. That is the only version of this that clears
its own costs.

### Finding 6 (weaker, do NOT build on yet): a bearish index signal

When the model calls NIFTY "down" for tomorrow it is right 66.7% (14/21)
against a 29.9% base rate - an edge of +36.8pp, binomial p=0.00054.
`market_mood` bear calls: 73.7% (14/19) vs 31.0% base, p=0.00016.

**But it is not time-stable.** Split chronologically, down-calls went 10/10
in the first half and 4/11 in the second. That is either regime luck or
real decay; 21 calls cannot distinguish them. Treat as a hypothesis to
track forward, not an edge to trade. See PHASE 4.

For contrast, the model's bullish calls are near-worthless: `direction_5d`
up-calls 5.9% correct (n=17), `direction_20d` down-calls 0/21,
`fii_flow_1d` inflow-calls **0/30**. There is a systematic optimism bias in
every forward-looking bullish claim it makes.

---

## CONSTRAINTS

1. ₹0 recurring cost stays a hard rule. Every change here is signal
   selection, no new data source, no new spend.
2. Do NOT invert the long-pick signal to "trade the opposite". Two reasons:
   inverting a fitted negative is a textbook overfit, and the alpha
   magnitude (~0.2%) is below the cost hurdle (~0.5-0.9%) in either
   direction, so an inverted signal still does not pay for itself.
3. Do NOT loosen `MIN_CONF`, `MIN_EDGE_PCT`, or the drawdown breaker to
   recover trade volume. Volume is not the goal; a positive expectancy is.
4. Do NOT gate or size on conviction tier (Finding 2).
5. The DSR/PBO honesty layer (blueprint 10) is binding on any claim this
   worked. `backtest_runs.results.dsr` must be > 0 before the change is
   called an improvement, and Tier-1 still needs DSR >= 0.90.
6. Kelly sizing (blueprint 09) stays gated at 60 closed trades. Note this
   pivot will make trades RARER and slower to close, pushing that gate
   further out. That is an acceptable and honest cost.

---

## STEP-BY-STEP PLAN

### Phase 0. Stop the bleeding (smallest change, largest effect)

Disable `top_performer` as a trade source. Keep it flowing to the grader
(so its skill keeps being measured and the finding stays falsifiable), but
stop it opening positions.

- In `analyzer/paper_trader.eval_signals()`, gate the `top_performers` loop
  behind a module constant `TRADE_TOP_PERFORMERS = False`.
- Mirror it in `analyzer/backtest.py`'s replay loop. **The gate stack in
  `backtest.py` is a hand-written mirror, not a call into
  `paper_trader.py`** - a change in one does not appear in the other. This
  was learned the hard way on 2026-08-28 when a new gate fired 0 times in a
  replay because only `paper_trader.py` had it.
- Expected effect: removes 47 of 64 trades, the bulk of realised losses.
  It does NOT by itself create a profitable system. It stops paying to be
  wrong.

### Phase 1 (REVISED). Negative filters only - no new buy source

No positive-edge buy signal exists in the live schema (see CORRECTION
above). Phase 1 is therefore risk reduction, not signal addition:

1. **Disable `worst_performer` too, alongside `top_performer`.**
   `short_pick_tp_sl` (its 10-session target/stop grade) is significantly
   negative: t=-2.60. Same treatment as Phase 0, same reasoning. It is
   only 5 of 64 backtest trades and already flagged `idealized_short`
   (retail cannot short delivery), so this is not where the money was
   being lost - it is disabled for consistency with the evidence, not
   because it was a large loss source.
2. **`stocks_to_avoid` as a negative filter.** If a ticker appears in
   today's `stocks_to_avoid`, block any entry on it from any remaining
   source. `avoid_7d` scores t=+7.68 on this - real, current, live.
3. **Wishlist `skip` as a second negative filter**, separate from
   `stocks_to_avoid`. When `wishlist_signals` names a ticker with
   `signal == "skip"`, block entries on it too. This is the actual
   validated half of `wishlist_7d` (t=-6.97 on realized returns after a
   skip call - the model is right that the stock will underperform).
   `wait` and `buy_now` carry no filtering signal (t=+1.13 and -0.44,
   both statistically flat) and should NOT be used to block or allow
   anything.

What this leaves live to actually open a NEW long position: `stock_analyst`
(currently near-dormant - see Phase 5) and the 1-day outlook evaluators
(`holding_outlook_1d` / `wishlist_outlook_1d`, ungraded in this audit -
should be measured before trusting them, see Phase 3 note). Realistic
expectation: **trade count may drop to near zero** until Phase 5 gives the
trader something with a genuine buy-side edge to act on. That is the
honest, intended outcome of this phase, not a bug.

### Phase 5. Revive a buy signal - DONE 2026-08-29, systematize stock_analyst

Investigated both candidates from the original plan before building
either, to avoid trusting an aggregate score the way the original Phase 1
plan wrongly trusted `wishlist_7d` (see CORRECTION at the top):

- **`portfolio_verdicts` "add"** - ruled out. Decomposed `verdict_tp_sl`
  by verdict type: the aggregate t=+3.13 is entirely driven by "hold"
  (n=291, t=+4.98, correctly staying in existing positions), not "add"
  (n=199, **t=+0.78 - statistical noise**). "trim" -0.40, "exit" -2.71.
  Not a usable buy signal.
- **`long_term_picks`** - still dead (current `SYSTEM_PROMPT` doesn't
  generate it), still the strongest historical signal (t=+5.71), but its
  old track record was itself produced under the same crammed-prompt
  design that plausibly caused `top_performer_1d`'s flat, negative-alpha
  output (Finding 1/2) - less trustworthy on reflection than it first
  looked. Not revived; left as a future option, not the chosen path.
- **`stock_analyst`** - chosen. Already fully wired end to end in both
  `paper_trader._evaluate_one` (the FIRST source `eval_signals()` checks)
  and `backtest.py`'s mirror - purely data-starved (13 rows total, ever,
  last one 2026-07-12), not a missing-feature problem. Lower implementation
  risk (zero new trading-logic code, vs. writing + mirroring a brand new
  evaluator for a revived `long_term_picks`) and a structurally sounder
  design (dedicated single-ticker attention vs. another array crammed
  into the overloaded daily prompt).

**Built:** `analyzer/stock_analyst_dispatch.py` + `.github/workflows/
stock_analyst_dispatch.yml`. Screens a FRESH, independent technical
scan (`analyzer.technical.screen_universe` + `rank_candidates`) for
bullish candidates - deliberately NOT the LLM's own `top_performers`
list, since that's the exact source just proven to have negative alpha
(Finding 1); seeding from it would reintroduce the same bad candidate
selection one level removed. Dispatches 6 candidates/day at 09:00 IST
(after the primary `daily_analysis` window, before market open) via the
existing `stock_analyst.yml` workflow, at the 30-day horizon (closest
fit to the long-horizon regime in Finding 3). Mirrors `web/app/api/
stock-analyst/route.ts`'s insert+dispatch contract exactly - zero
changes needed to `stock_analyst.yml` or the paper trader's consumption
of it.

**Verified live 2026-08-29:** dispatched 6/6 cleanly (MEDANTA, APARINDS,
CARTRADE, HINDZINC, IFCI, JINDALSTEL), 5/6 completed with real ratings
before this was written. **Watch, not yet a problem:** those 5 came back
4 "hold" + 1 "sell" + 0 "buy" - `_evaluate_one` requires `rating ==
"buy"` to open a trade, so working candidate generation alone doesn't
guarantee trades follow. Needs a real run of days to know either way -
same no-shortcut discipline as the rest of this blueprint.

### Phase 2. Re-tune the cost gate for the new horizon - DONE 2026-08-29

`COST_TO_PROFIT_MAX = 0.40` was set on 2026-08-28 against 1-day trades and
proved too aggressive there (cut 69% of volume, Sharpe went -13.2 to -16.2
in run id=8 while absolute losses and drawdown improved). At a 60-session
horizon the expected move is far larger relative to the same fixed cost, so
the same threshold will bind much less often.

Do not re-tune it by guessing. Re-run the replay after Phase 1 and read the
actual `skips.cost_dominated` count. If it is near zero, leave the constant
alone - it is correctly acting as a floor, not a filter.

**Result:** backtest id=10 (2026-08-29, post Phase 5) shows
`skips.cost_dominated = 18` out of 1,869 evaluated (~1%). Near zero.
**Constant left alone.** The gate is correctly acting as a floor, not a
filter - nothing to re-tune.

### Phase 3. Validate honestly before believing any of this - RUN 2026-08-29, NOT A CLEAN PASS

Run `python -m analyzer.backtest` and compare against the current baseline
run **id=9** (Phase 0+1, superseded id=8 which used the since-fixed
optimistic-profit cost-gate reference - see §27 of `KNOWLEDGE_BASE.md`):
5 trades, win rate 40.0%, Sharpe -10.663, max DD 0.29%, net -₹133.
(Earlier runs for reference: id=5 = 64 trades / 20.31% / -14.101;
id=6 = 65 trades / 23.08% / -13.245; id=8 = 20 trades / 20.0% / -16.199,
superseded.)

Bar for calling this an improvement, all three required:
1. Sharpe strictly better than -13.245 (the best of any run so far).
2. `results.dsr.dsr` > 0. It has been exactly 0.0 on every run to date.
3. Positive total net P&L, or a clearly documented reason why not.

If the replay does not clear this, the pivot is wrong and should be
reverted, not tuned until it passes. Tuning until it passes is exactly what
the PBO metric exists to catch.

Sample-size caution to state in the PR: `long_pick_tp_sl` is n=48. It is
the strongest signal in the dataset and it is still a small sample. Expect
the replay to produce FEW trades. Few good trades is the intended outcome.

**Result (run id=10, saved 2026-08-29):** identical to id=9 in every
number - 5 trades, 40.0% win rate, Sharpe -10.663, max DD 0.29%, net
-₹133.18, DSR 0.0. Real reason confirmed via a direct Supabase query
before running: **all 19 `stock_analyst` rows ever written (13 pre-Phase-5
+ 6 from Phase 5's first live dispatch on 2026-08-29) are rated hold or
sell - zero rated "buy," ever.** `_evaluate_one`/`_eval_stock_analyst`
require `rating == "buy"` to open a position, so Phase 5's new candidates
mechanically could not have entered a trade yet, regardless of whether the
pipeline is working (it is - see §26a).

Bar check: (1) Sharpe -10.663 beats -13.245 - **pass**, but this was
already true at id=9, not a Phase-5 contribution. (2) DSR 0.0 - **fail**.
(3) Net P&L negative - **fail on the number, but with the clean documented
reason above**, not silence or a shrug.

**Verdict: not reverting.** Nothing regressed - Phase 5 added zero trades,
net neutral, not net negative. This is not "the pivot is wrong," it's "the
new source hasn't been given a chance yet." The real Phase 3 test is still
pending on `stock_analyst_dispatch` producing its first "buy" rating.
Re-run the backtest again once that happens, or after ~2 weeks of daily
dispatch accumulate with no buy at all (which would itself be a finding
worth investigating - either the scan's technical-bullish screen or the
LLM's rating logic may be too conservative at this horizon).

### Phase 4. Track the bearish-index signal forward, do not trade it

Add a `regime_bearish_block` flag: when today's `market_mood` is `bear` or
`nifty_outlook.direction` is `down`, block new LONG entries for that
session. This is free, reversible, and costs nothing if the signal is
noise.

Do NOT build a short strategy on it. Re-test the edge after roughly 20 more
down-calls accumulate (currently 21 total). If the second-half hit rate
recovers toward the first half's, it is real; if it stays near the 29.9%
base rate, it was regime luck and the flag should be removed.

---

## EXACT INPUTS

- `analyzer/paper_trader.py` - `eval_signals()`, the four `_evaluate_*`
  functions, module constants block at the top.
- `analyzer/backtest.py` - the mirrored `_eval_*` functions and the replay
  loop. **Must be edited in parallel with paper_trader.py.**
- `analyzer/grader.py` - already grades every dimension named here. No
  change needed; do not stop grading `top_performer_1d` when it stops being
  traded, or the finding becomes unfalsifiable.
- Baseline to beat: `backtest_runs` id=8 (and id=5, id=6 for context).

## DEFINITION OF DONE

- [ ] `top_performer` no longer opens trades in either `paper_trader.py` or
      `backtest.py`, and is still graded.
- [ ] `worst_performer` no longer opens trades in either file, and is
      still graded.
- [ ] `stocks_to_avoid` blocks entries (from any remaining source) on
      named tickers, in both files.
- [ ] `wishlist_signals` with `signal == "skip"` blocks entries on named
      tickers, in both files. `buy_now`/`wait` do nothing (no edge either
      direction).
- [ ] A fresh `backtest_runs` row exists, with its id and full
      before/after delta quoted in the PR body (standing doctrine: any
      change to gates must show the backtest delta).
- [ ] `KNOWLEDGE_BASE.md` updated with the outcome, including the case
      where it did NOT work.
- [x] Phase 5 (reviving a real buy signal) - DONE 2026-08-29: `portfolio_
      verdicts` "add" ruled out (t=+0.78, noise), `stock_analyst` seeding
      built and verified live instead (6/6 dispatched, 5/6 completed).
      Not yet known whether it produces real "buy" ratings at a usable
      rate - watch over the coming days, no shortcut available.

---

## APPENDIX: reproducing the audit

All findings came from `prediction_scores` via the Supabase REST API. The
shape of every query:

```
GET {SUPABASE_URL}/rest/v1/prediction_scores
    ?select=dimension,predicted,actual,score,delta,scored_at
    &dimension=eq.<dim>
```

- Per-pick alpha (Findings 1, 2) lives in `actual.results[]` on
  `top_performer_1d` rows: each entry has `ticker`, `alpha`, `conviction`.
- Direction hit rates (Finding 6) use `score >= 100` as "correct"; the
  scorer is binary 0/100 with 50 partial credit for `sideways`, so a raw
  mean over-states accuracy and MUST be decomposed by predicted call.
- Base rates (Finding 6) come from the `delta` column on `direction_1d`,
  which stores the realised NIFTY move; the flat band is 0.4% for 1 day.
- `tp_sl` dimensions (Finding 3) score 100 target-first / 0 stop-first / 50
  neutral, so `t` is computed against a null of 50, not 0.

# Blueprint 22: Cron-to-Oracle Migration

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions.
(systemd unit authoring + a shared bash wrapper - mechanical, well-scoped,
no novel design once the phasing below is followed in order)

## GOAL

Move the 10 *scheduled* jobs currently triggered by GH Actions' `schedule:`
(some also double-dispatched by the Cloudflare Worker) onto systemd timers
running directly on the always-on Oracle VM, eliminating both remaining
sources of trigger drift/delay. When done: every time-sensitive job fires
from the box's own clock, with no queue delay and no dependency on GH
Actions runner availability or a separate Cloudflare Worker. GH Actions
workflow files are NOT deleted - `schedule:` triggers are removed but the
workflows stay `workflow_dispatch`-callable as a manual recovery path,
exactly like the 4 dashboard-triggered workflows already are.

This is stated intent from the Oracle migration itself (2026-08-29, see
`blueprints/15-oracle-migration-runbook.md` and `KNOWLEDGE_BASE.md` §8/§28)
- 4 OCPU/24GB was deliberately over-provisioned for exactly this, motivated
directly by the 2026-08-28 Telegram-dedup incident, a textbook demonstration
of GH Actions cron's unreliability (a run landed ~10h late and, separately
during the 2026-08-30 stall re-check, another native-schedule run drifted
across midnight IST and caused `grader.py` to skip its entire pass via a
now-fixed date-check bug - see KB changelog 2026-08-30).

**This blueprint is a SCOPE + DESIGN document, not yet approved for build.**
Read it, then get explicit user go-ahead before starting Phase A - this
touches every time-sensitive live job the bot depends on.

## CONTEXT THE BUILDER NEEDS

**The 10 jobs in scope** (all `python -m <module>`, all already run this
way in CI, so the invocation itself needs zero code change):

| Workflow | Cron (UTC) | IST target | Module | Cloudflare-covered? |
|---|---|---|---|---|
| `daily_analysis.yml` | `50 2 * * 1-5` (+ `13 3 * * 1-5` secondary) | 08:20 / 08:43 | `bot.daily_push` | Yes (`50 2 * * 1-5` only) |
| `daily_sync.yml` | `25 2 * * 1-5` | 07:55 | (INDmoney sync, see workflow) | No |
| `daily_grader.yml` | `30 11 * * 1-5` | 17:00 | `analyzer.grader`, `analyzer.stock_analyst_grader`, `analyzer.embed_backfill` | Yes |
| `sensei_eod.yml` | `41 14 * * 1-5` | 20:11 | `analyzer.sensei` | Yes (mapped as `35 14 * * 1-5` in the Worker - **mismatch found while scoping this, see Gotchas**) |
| `daily_prices.yml` | `30 16 * * 1-5` | 22:00 | `fetchers.prices` | No |
| `hourly_news.yml` | `0 * * * *` | every hour | `fetchers.news`, `bot.news_alerts` | No |
| `alerts_checker.yml` | `*/15 3-10 * * 1-5` | every 15min, NSE hours | `bot.alerts_checker` | No |
| `stock_analyst_dispatch.yml` | `30 3 * * 1-5` | 09:00 | `analyzer.stock_analyst_dispatch` | No |
| `specialist_eval.yml` | `0 3 * * 6` | Sat 08:30 | `analyzer.specialist_eval` | No |

**Out of scope, stay on GH Actions exactly as-is:** `backtest.yml`,
`calculator.yml`, `portfolio_score.yml`, `stock_analyst.yml` -
`workflow_dispatch`-only today, fired on-demand by dashboard API routes.
Nothing about their trigger is unreliable; moving them would add risk for
zero benefit.

- Files to read first: `deploy/oracle/setup.sh`, `deploy/oracle/arcemx-bot.service`
  (the exact pattern to mirror), `cloudflare/cron-dispatcher/src/index.js`,
  every `.github/workflows/*.yml` listed above (cron string, module
  invocation, `HC_PING_URLS` wiring, any workflow-only prep steps that
  won't exist in a persistent venv - e.g. dependency install, which is a
  no-op on Oracle since deps are already installed once, not per-run).
- Oracle box facts (from `KNOWLEDGE_BASE.md` §8, live as of 2026-08-29):
  `92.4.84.48`, `VM.Standard.A1.Flex`, 4 OCPU/24GB, Ubuntu 24.04, repo at
  `/opt/arcemx`, venv at `/opt/arcemx/.venv`, secrets at `/etc/arcemx.env`,
  SSH key `W:\ssh-key-2026-08-29.key`, user `ubuntu`. `arcemx-bot.service`
  is the live template: `EnvironmentFile=/etc/arcemx.env`,
  `WorkingDirectory=/opt/arcemx`, `ExecStart=/opt/arcemx/.venv/bin/python -m <module>`.
- Dead-man ping mechanism (`HC_PING_URLS`): a JSON secret keyed by job name,
  e.g. `{"daily_prices": "https://hc-ping.com/xxxx", ...}`. Success pings
  the bare URL; failure pings `<url>/fail`. Currently implemented as a
  bash step INSIDE each workflow YAML (see `daily_prices.yml` lines 34-45
  for the exact pattern), not in any Python module - this logic does not
  exist anywhere reusable yet and must be ported, not just imported.
- **Gotcha found while scoping this (real, not yet fixed):** the Cloudflare
  Worker's `CRON_TO_WORKFLOW` maps `sensei_eod.yml` to cron string
  `"35 14 * * 1-5"`, but the workflow's own YAML schedule is
  `"41 14 * * 1-5"` - a 6-minute mismatch. Cloudflare Cron Triggers match
  the Worker's OWN configured trigger (set in the Cloudflare dashboard, not
  visible in this repo), which must equal one of the `CRON_TO_WORKFLOW` key
  strings exactly to route. Whether the dashboard's actual trigger is
  `35` or `41` past the hour is unconfirmed from repo state alone - if it's
  `35`, sensei has been firing 6 minutes before its own documented target
  every single day, harmlessly (nothing else depends on the exact minute),
  but it means the repo's own cron string comment can't be trusted as the
  live truth. Worth a dashboard check before or during Phase B, not urgent.
- Repo-wide facts from `blueprints/_TEMPLATE.md` still apply (₹0 hard rule,
  Python 3.11 venv, no em dashes, etc).

## CONSTRAINTS

- Must stay inside: `deploy/oracle/` (new `.service`/`.timer` unit files, a
  shared `run_job.sh` wrapper), `deploy/oracle/setup.sh` (idempotent
  install/enable steps), `.github/workflows/*.yml` (removing `schedule:`
  blocks only - keep `workflow_dispatch:` and everything else unchanged),
  `cloudflare/cron-dispatcher/` (retire or keep dormant, do not delete the
  repo folder without asking).
- Must not change: any Python module's logic. This is a trigger-plumbing
  migration only - `python -m analyzer.grader` must run byte-identical
  whether GH Actions or systemd invokes it.
- Non-negotiables: ₹0 recurring cost (Oracle Always Free covers this
  fully - 4 OCPU/24GB has enormous headroom over current bot usage; no new
  paid service). Never skip the dead-man ping port - losing that
  observability while gaining trigger reliability would be a net loss for
  operator visibility.
- **Real tradeoff to state to the user before any code is written, not to
  bury in a changelog after:** consolidating cron onto the Oracle box turns
  it into a single point of failure for scheduling too, not just bot
  hosting. Today, if the Oracle box goes down, GH Actions + the Cloudflare
  Worker keep the daily pipeline running (bot goes silent, but analysis/
  grading/pushes continue). After this migration, a box outage stops
  everything at once. The recovery doctrine already in place (`KNOWLEDGE_BASE.md`
  §8's Appendix: "zero unique state, re-run setup.sh fresh") mitigates
  the RECOVERY time but not the detection time - the existing
  Healthchecks.io pings become the ONLY early-warning signal once this
  ships, so porting them correctly (not just as an afterthought) is load-
  bearing, not decorative.

## STEP-BY-STEP PLAN (phased, get sign-off between phases)

### Phase A. Prove the pattern on the lowest-risk jobs - DONE, cut over 2026-08-31

**Status: complete.** All 5 job timers installed, enabled, confirmed
firing real work automatically, and the GH Actions `schedule:` trigger
removed from all 5 workflow YAMLs (`workflow_dispatch:` kept as manual
fallback). `git-pull.timer` running. Full detail, including the two bugs
found by testing and the real GH-schedule-was-already-silent evidence
found at cutover time, is in `KNOWLEDGE_BASE.md` §30.

**Known gap, accepted, not blocking:** `HC_PING_URLS` was never filled in
- the user chose to enable and cut over without it rather than wait on a
healthchecks.io setup. These 5 jobs currently run with zero automated
dead-man alerting; manual `journalctl`/`systemctl` checks are the only
detection mechanism. Add pings whenever convenient - no rework needed,
`run_job.sh` already reads `HC_PING_URLS` and no-ops cleanly when it's
unset.

**What actually happened, for the record (deviated from the original
step order below, deliberately, on live evidence):** the original plan
was secrets first, then enable, then watch 3-5 days, then only pull
`schedule:` once proven. In practice: enabled without the ping secret on
explicit user call, watched the first real automatic fire of all 5 jobs
(not the originally-planned multi-day window - cut short once GH's own
schedule was caught having already gone silent on 4 of 5 jobs, which made
"wait to see if the old trigger still works" a moot question for those
four), then pulled `schedule:` from all 5 the same day. `daily_prices` was
included despite not yet having fired via its own Oracle timer at cutover
time - accepted on explicit go-ahead, not a default judgment call.

### Original plan (kept for reference)

Move `hourly_news.yml`, `daily_prices.yml`, `daily_sync.yml`,
`alerts_checker.yml`, `stock_analyst_dispatch.yml` first. None of these
have any reliable-clock backup today (not in `CRON_TO_WORKFLOW`), so
moving them to systemd is a strict reliability upgrade with low
consequence if something's misconfigured (worst case: a news/price fetch
runs a few minutes late once, not a missed or duplicated user-facing push).

1. Write `deploy/oracle/run_job.sh`: takes a module path and an
   `HC_PING_URLS` lookup key as args, `cd /opt/arcemx`, runs
   `.venv/bin/python -m "$1"`, pings Healthchecks success/fail based on
   exit code (mirror the exact bash logic from `daily_prices.yml` lines
   34-45), exits with the module's own exit code so systemd's own
   `Restart=`/failure tracking still works correctly.
2. For each of the 5 jobs: one `.service` file (`Type=oneshot`,
   `EnvironmentFile=/etc/arcemx.env`, `WorkingDirectory=/opt/arcemx`,
   `ExecStart=/opt/arcemx/deploy/oracle/run_job.sh <module> <hc_key>`) and
   one `.timer` file (`OnCalendar=` translated directly from the existing
   UTC cron string - confirm `timedatectl` on the box reports UTC before
   trusting a direct string port, per Gotchas above).
3. Add a `git-pull.timer`/`.service` pair (`OnCalendar=*:0/5`, i.e. every
   5 min): `cd /opt/arcemx && git pull --ff-only`. This is what keeps the
   box's checkout current without a webhook - every job always runs
   against code pushed within the last 5 minutes, same currency GH Actions
   gives today (checkout at `ref: master` on every dispatch).
4. Add all new units to `deploy/oracle/setup.sh`'s systemd section
   (idempotent `cp` + `daemon-reload` + `enable --now`, same pattern as
   `arcemx-bot.service`).
5. Remove the `schedule:` block from these 5 workflow YAMLs (keep
   `workflow_dispatch:`). Do NOT remove `HC_PING_URLS` wiring from the
   YAML - it's harmless dead code on a manually-dispatched run and costs
   nothing to leave.
6. Watch for 3-5 real days. Confirm via Healthchecks.io (or a direct
   Supabase staleness check per KB §24's query patterns) that each job is
   firing on time, no gaps, no duplicate runs.

### Phase B. Migrate the 3 Cloudflare-covered, business-critical jobs - DESIGNED 2026-09-01, NOT YET BUILT

Only after Phase A has run clean for a stretch (Phase A cut over
2026-08-31, all 5 jobs confirmed firing real automatic work - see
`KNOWLEDGE_BASE.md` section 30). This section was originally a thin
placeholder assuming all 3 jobs needed the same extra-careful,
staggered-cutover treatment `daily_analysis` does. Real investigation
found that is true for exactly one of the three, not all three - the
other two are already safe by design and can port the plain Phase-A way.

**Per-job risk, verified against real code, not assumed:**

- **`daily_grader` -> `analyzer.grader`: safe, ports like Phase A.**
  Every write goes through `_upsert_score()`, an upsert on a stable key -
  grading the same prediction twice is a no-op, not a duplicate. No
  Telegram push in its normal path (the paper-trader circuit-breaker
  alert inside it is itself gated on a state *transition*, not a naive
  re-fire). A dual-trigger overlap during cutover costs redundant compute,
  nothing else.
- **`sensei_eod` -> `analyzer.sensei`: safe, ports like Phase A.**
  The workflow's own comment says it outright: "Sensei self-grades before
  synthesizing, so double runs are idempotent and ordering vs the grader
  no longer matters." Same low-risk profile as `daily_grader`.
- **`daily_analysis` -> `bot.daily_push`: real risk, needs a new script.**
  `bot/daily_push.py` has **no staleness check of its own** - it
  unconditionally reads the latest `analysis` row and sends it. The
  workflow's actual dedup is GH-Actions-specific YAML plumbing: an
  `id: agg` step runs `run_if_stale(max_age_minutes=90)`, writes
  `ran=true/false` to `$GITHUB_OUTPUT`, and the push step only runs
  `if: steps.agg.outputs.ran == 'true'`. A naive systemd port that just
  runs `python -m analyzer.aggregator` then `python -m bot.daily_push`
  in sequence (Phase A's `run_job.sh <hc_key> <module1> <module2>`
  pattern) **loses this gate entirely** and reintroduces the exact
  double-push failure mode from the 2026-08-28 five-message incident,
  just through a new code path instead of the old `FORCE_RUN` one.

**The fix: one new script, not a workflow-level trick.** Add
`bot/daily_analysis_runner.py`:

```python
import asyncio
from analyzer.aggregator import run_if_stale
from bot.daily_push import push

if __name__ == "__main__":
    res = run_if_stale(max_age_minutes=90)
    ran = res is not None and not (res or {}).get("error")
    if ran:
        asyncio.run(push())
    else:
        print("Skipped push - no fresh analysis produced by this run.")
```

This is a straight port of the exact same conditional the GH workflow
already encodes in YAML - `run_if_stale()`'s return value decides whether
`push()` ever runs, in the same process, so there is no window for the
two halves to disagree. The Oracle timer calls this ONE script via
`run_job.sh daily_analysis bot.daily_analysis_runner` - never
`aggregator` and `daily_push` as two separate steps, and never with a
`--force` equivalent on the scheduled path (mirrors the YAML's own rule:
automated dispatches stay unforced; only a human recovering a confirmed
miss should force, via a manual invocation with an explicit flag, not
added here since Phase A's precedent already keeps `workflow_dispatch`
around for exactly that case).

**Real consequence of this finding: the "atomic cutover" worry in the
original Phase A-era plan was overstated for all three jobs.** Because
`run_if_stale()` checks the database, not any workflow-local state, it
correctly dedupes regardless of which physical machine (GH runner or the
Oracle box) calls it, and regardless of how many trigger sources are
live at once - GH's native `schedule:`, the Cloudflare Worker's
`workflow_dispatch`, and the new Oracle timer could all be live
simultaneously without producing more than one real analysis + one real
push, AS LONG AS `daily_analysis_runner.py` is what runs on Oracle, not
a naive two-command sequence. This means Phase B can follow the exact
same cutover shape Phase A used - enable, watch one real automatic fire
per job, then pull `schedule:` - rather than needing a special
stop-the-world procedure.

**Step-by-step:**

1. Add `bot/daily_analysis_runner.py` (above). No changes to
   `analyzer/aggregator.py` or `bot/daily_push.py` - both stay exactly as
   they are, this only adds the missing orchestration layer.
2. Three new `.service`/`.timer` pairs, mirroring Phase A's shape:
   `arcemx-daily-analysis` (`ExecStart` calls
   `run_job.sh daily_analysis bot.daily_analysis_runner`, `OnCalendar`
   matching `50 2 * * 1-5` UTC), `arcemx-daily-grader`
   (`run_job.sh daily_grader analyzer.grader`, `30 11 * * 1-5` UTC),
   `arcemx-sensei-eod` (`run_job.sh sensei_eod analyzer.sensei`). Resolve
   the `sensei_eod` cron-string mismatch (Gotchas above) by checking the
   Cloudflare dashboard's actual configured trigger before picking which
   minute to port - do not silently pick one.
3. Install, enable, confirm one real automatic fire per job (same
   verification bar Phase A used: check the journal shows genuine work,
   not just exit 0).
4. Remove `schedule:` from the 3 workflow YAMLs (keep
   `workflow_dispatch:` as the manual recovery path, same as Phase A).
5. Once confirmed stable, retire the Cloudflare Worker: either
   `wrangler delete` it (ask first - this is the kind of action that
   needs explicit confirmation) or simply remove its Cron Triggers in the
   dashboard and leave the Worker code dormant (lower-risk, fully
   reversible, costs nothing to leave deployed-but-untriggered). Prefer
   leaving it dormant over deleting, at least initially.

### Phase C. Weekly/low-frequency cleanup

`specialist_eval.yml` (Saturday only) - move whenever convenient, real
bonus here beyond reliability: the box can now CACHE the llama.cpp binary
and the specialist-v2 GGUF between runs instead of re-downloading them via
`gh release download` every single week (current CI behavior, wastes
bandwidth/time on an ephemeral runner). Not required for this blueprint's
goal, worth a one-line follow-up note in `KNOWLEDGE_BASE.md` if done.

## EXACT INPUTS TO USE

- Oracle SSH: `ssh -i "W:\ssh-key-2026-08-29.key" ubuntu@92.4.84.48`
- Existing service template to mirror exactly:
  `deploy/oracle/arcemx-bot.service` (already read into this blueprint's
  Context section above).
- `HC_PING_URLS` secret value: already present in `/etc/arcemx.env` on the
  box (pulled from Render's env during the original Oracle migration) - do
  not ask the user for it again, read it from the box.
- Confirm box timezone before writing any `OnCalendar=` line:
  `timedatectl` over SSH. If not UTC, either set it to UTC (cleanest,
  matches every existing cron string with zero translation) or translate
  every `OnCalendar=` explicitly - do not guess.

## DEFINITION OF DONE

Per phase, all of:
- [ ] Every migrated job's `.timer` fires within a few seconds of its
      target time (systemd's own precision), confirmed via
      `systemctl list-timers` and at least 3 real consecutive firings.
- [ ] Dead-man ping fires correctly on both success AND induced failure
      (test by temporarily pointing `ExecStart` at a command that exits 1).
- [ ] `git-pull.timer` keeps `/opt/arcemx` within 5 minutes of `origin/master`
      at all times (`git log -1` on the box vs `git log -1` locally).
- [ ] The corresponding GH Actions `schedule:` trigger is removed, but
      `workflow_dispatch` still works (`gh workflow run <file>` succeeds).
- [ ] No duplicate runs during the cutover window (a job firing from both
      GH's still-warm schedule AND the new systemd timer on the same day) -
      stagger the schedule removal and timer enablement, don't flip both
      at once.
- [ ] `KNOWLEDGE_BASE.md` updated same-session with what moved and when,
      per this repo's own update discipline.

Phase B additionally:
- [ ] Cloudflare Worker's Cron Triggers confirmed removed/dormant, its
      `CRON_TO_WORKFLOW` map's 3 entries no longer receiving traffic
      (check Worker Logs, now Enabled per KB §28, for a quiet week).

## IF SOMETHING IS UNCLEAR (anti-stall)

Make the smallest safe assumption, write it at the top of the output as
"ASSUMPTION: ...", and keep going. Never stall, never invent big new scope.
If the box's timezone or the sensei cron mismatch can't be resolved
without dashboard/SSH access this session doesn't have, stop and hand the
specific question back to the user rather than guessing at a live
schedule.

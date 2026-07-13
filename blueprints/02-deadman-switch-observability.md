BLUEPRINT 2: Dead-man-switch observability on every scheduled job

BUILDER: Claude Haiku, working alone, cold start, cannot ask questions.
(Purely mechanical: one curl line per workflow + a tiny helper. No judgment calls.)

GOAL
If any scheduled job (analysis, grader, sensei, sync, prices, news, alerts) stops running
— for ANY reason including the failure mode where the pipeline silently stops being
scheduled at all — the user gets a Telegram alert within hours. This closes the failure
class where Render deploys were silently blocked for 2+ weeks in June 2026.

CONTEXT THE BUILDER NEEDS
- Files to read first: `.github/workflows/daily_analysis.yml` (the pattern), all other
  files in `.github/workflows/`.
- Researched facts (July 2026, verified): healthchecks.io free plan = 20 cron checks,
  each check gets a unique ping URL like `https://hc-ping.com/<uuid>`. A check "fails"
  when a ping does not arrive within its schedule + grace period. Integrations include
  Telegram (native) — alerts go straight to the user's chat with no code on our side.
  Pinging is one HTTP GET; `curl -fsS -m 10 --retry 3 <url>` is the documented pattern.
  A failed job can ping `<url>/fail` to signal explicitly.
- The user must create the checks by hand (free account, no card): one check per
  scheduled workflow, cron expression matching each workflow's schedule (listed in step 1),
  grace 2 hours, Telegram integration enabled. Then save each ping URL as ONE GitHub
  Actions secret `HC_PING_URLS` in the JSON form
  `{"daily_analysis":"https://hc-ping.com/...","daily_grader":"...","sensei_eod":"...","daily_sync":"...","daily_prices":"...","hourly_news":"...","alerts_checker":"..."}`.
- Gotcha: scheduled workflows are the monitored set. workflow_dispatch-only workflows
  (backtest, calculator, portfolio_score, stock_analyst) must NOT get checks — they are
  on-demand and would false-alarm.

CONSTRAINTS
- Must stay inside: `.github/workflows/*.yml`.
- Must not change: any Python, any schedule, any existing step.
- Non-negotiables: ping failure must NEVER fail the job (always `|| true`); ₹0.

STEP-BY-STEP PLAN
1. For each of these 7 workflow files — `daily_analysis.yml` (key `daily_analysis`),
   `daily_grader.yml` (`daily_grader`), `sensei_eod.yml` (`sensei_eod`), `daily_sync.yml`
   (`daily_sync`), `daily_prices.yml` (`daily_prices`), `hourly_news.yml` (`hourly_news`),
   `alerts_checker.yml` (`alerts_checker`) — append as the LAST step of the main job:
   ```yaml
      - name: Dead-man ping
        if: always()
        env:
          HC_PING_URLS: ${{ secrets.HC_PING_URLS }}
        run: |
          url=$(echo "$HC_PING_URLS" | python3 -c "import json,sys;print(json.load(sys.stdin).get('<KEY>',''))")
          if [ -n "$url" ]; then
            if [ "${{ job.status }}" = "success" ]; then
              curl -fsS -m 10 --retry 3 "$url" || true
            else
              curl -fsS -m 10 --retry 3 "$url/fail" || true
            fi
          fi
   ```
   replacing `<KEY>` with that workflow's key. Keep indentation consistent with each file.
2. Print for the user (final summary): the exact list of 7 checks to create on
   healthchecks.io with their cron schedules copied from each workflow's `on.schedule.cron`
   plus timezone UTC, grace period 2h, Telegram integration on; and the one
   `gh secret set HC_PING_URLS` command with the JSON template to fill.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 02-deadman-switch-observability.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Read it fully, then edit the 7 workflow
  files exactly as specified."

DEFINITION OF DONE
[ ] All 7 scheduled workflows end with the Dead-man ping step guarded by `if: always()`.
[ ] The 4 on-demand workflows are untouched.
[ ] With HC_PING_URLS unset, every workflow still passes (step is a no-op) — verify by
    dispatching `daily_sync.yml` once and confirming success.
[ ] Summary for the user lists 7 checks + schedules + the secret-set command.

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going.

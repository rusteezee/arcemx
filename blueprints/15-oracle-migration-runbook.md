BLUEPRINT 15: Oracle Cloud migration runbook (bot off Render before Aug 1)

BUILDER: Claude Sonnet, working alone, cold start, cannot ask questions. EXCEPT this
blueprint is half runbook: steps marked [USER] are performed by the user by hand; the
builder does the code steps and prints the runbook steps in order.

GOAL
The Telegram bot runs on an Oracle Always Free ARM instance under systemd, deployed by
a single idempotent script kept in the repo, with the same env, health endpoint, and
trigger URLs (via a reserved public IP + caddy). Render is retired before its Aug 1,
2026 forced plan migration (5GB/month bandwidth cap incoming). Every piece of state
already lives off-box (Supabase/GitHub), so a destroyed instance is a 15-minute redeploy,
not a disaster.

CONTEXT THE BUILDER NEEDS (researched facts, July 2026, verified)
- Oracle Always Free was HALVED 2026-06-15: now 2 OCPU / 12 GB A1 ARM total, 47GB min
  boot volume, ~2 public IPs, reserved IPs persist across instance rebuilds.
- Signup friction from India is real: needs a real credit card (no virtual/prepaid),
  "Error Processing Transaction" rejections are common; A1 capacity errors persist in
  many regions. Singapore provisions most reliably; home region is locked at signup.
- Idle-reclaim: Always Free instances get reclaimed when 7-day p95 CPU/network/memory
  are ALL under 20%. Converting the tenancy to Pay-As-You-Go (card + temporary ~$100
  hold) exempts reclamation while remaining $0 within free limits. DECISION: convert to
  PAYG right after signup. the bot idles far below 20%.
- Tail risk documented: Always Free tenancies terminated without warning, data purged.
  MITIGATION (architectural rule): the box holds ZERO unique state. Supabase has all
  data, GitHub has all code + this deploy script, tokens live in Supabase mcp_tokens.
- INDmoney 512-from-datacenter-IPs does NOT improve on Oracle (also datacenter IPs) -
  keep the GH Actions sync redundancy exactly as is.
- Current Render deployment (from repo grounding): `python -m bot.telegram_bot`,
  long-poll + HTTP health/trigger server on PORT, env vars: SUPABASE_URL, SUPABASE_KEY,
  OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TRIGGER_SECRET, GH_TOKEN,
  GH_REPO (list verified live 2026-07-12). Netlify API routes call
  ${ARCEMX_BOT_URL}/trigger/*. ARCEMX_BOT_URL must repoint at cutover.
- Leftover to fix during migration: `bot/telegram_bot.py:1202`. scheduled_analysis
  refuses the in-process fallback "when ensemble env absent"; the ensemble was REMOVED
  2026-07-12, so this guard's comment/logic references a dead concept. Re-read the
  block; keep the behavior (GH-dispatch-first, no heavy in-process analysis on a small
  box) but fix the stale comment and make the refusal unconditional-by-config
  (env ARCEMX_ALLOW_INPROCESS_ANALYSIS=0 default) instead of keying on ensemble vars.

CONSTRAINTS
- Must stay inside: new `deploy/oracle/` directory (script + systemd units + caddyfile),
  `bot/telegram_bot.py` (only the :1202 cleanup), README deployment section,
  `web/` env docs (ARCEMX_BOT_URL note). No other code changes.
- Must not change: bot behavior, trigger auth, GH workflows, Supabase.
- Non-negotiables: idempotent deploy script (safe to rerun); zero unique state on box;
  Render stays alive as fallback until the Definition of Done's cutover checks pass.

STEP-BY-STEP PLAN
[USER] 1. Sign up at oracle.com/cloud/free. real credit card, home region Singapore
  (ap-singapore-1). If "Error Processing Transaction": retry with a different card/day.
[USER] 2. Convert tenancy to Pay-As-You-Go (Billing → Upgrade). Stay within Always
  Free shapes = still ₹0. This kills idle-reclaim.
[USER] 3. Create instance: VM.Standard.A1.Flex, 2 OCPU / 12 GB, Ubuntu 24.04 ARM,
  47GB boot. Reserve a public IP and attach it. Open ingress 80/443/22 in the VCN
  security list. Save the SSH key.
4. Builder: create `deploy/oracle/setup.sh`. idempotent: apt update; install python3.11
   + venv + git + caddy; clone/pull rusteezee/arcemx to /opt/arcemx; venv install
   requirements.txt; write /etc/arcemx.env from a template (chmod 600, placeholders the
   user fills once); install + enable systemd units; `systemctl restart arcemx-bot caddy`.
5. Builder: `deploy/oracle/arcemx-bot.service`. systemd unit: ExecStart the venv python
   -m bot.telegram_bot, EnvironmentFile=/etc/arcemx.env, Restart=always, RestartSec=10,
   MemoryMax=2G.
6. Builder: `deploy/oracle/Caddyfile`. reverse proxy :80/:443 → localhost:$PORT with
   automatic self-signed/internal TLS on the bare IP (no domain yet; Netlify calls can
   use http://<reserved-ip>. decision: keep ARCEMX_BOT_URL as http://<ip> initially;
   optional later: point a free DuckDNS name at it for TLS).
7. Builder: `bot/telegram_bot.py:1202` cleanup per CONTEXT (config-driven refusal,
   stale ensemble comment removed).
8. Builder: README deployment section rewrite: Oracle path primary, the [USER] steps,
   the env template, and "recovery = rerun setup.sh on a fresh instance" doctrine.
   Flag Hetzner CAX11 (~₹500/mo) as the paid fallback if Oracle signup fails outright.
[USER] 9. Fill /etc/arcemx.env with the 8 env vars (same values as Render) + run setup.sh.
10. Builder (verification, run from local machine): /health returns OK on the new IP;
   /trigger/sync with TRIGGER_SECRET returns ok:true JSON; Telegram /today answers;
   APScheduler jobs visible in journalctl logs.
[USER] 11. Cutover: update Netlify env ARCEMX_BOT_URL to the Oracle URL (both deploy
   contexts. remember the greyed-out "same value" UI quirk), redeploy web; verify a
   dashboard-triggered sync; THEN suspend the Render service (do not delete for 2 weeks).
12. Builder: add the bot's /health to UptimeRobot (free, [USER] creates monitor) and a
   healthchecks.io check for scheduled_analysis dispatch confirmation if blueprint 02
   landed.

EXACT INPUTS TO USE
- Kick-off prompt: "Implement blueprint 15-oracle-migration-runbook.md from
  C:\Users\rahul\Downloads\stock-ai\blueprints\. Do the builder steps; print the [USER]
  steps as a checklist in order and pause where the plan says the user acts."

DEFINITION OF DONE
[ ] deploy/oracle/{setup.sh, arcemx-bot.service, Caddyfile} committed; setup.sh rerun-safe
    (second run changes nothing. prove with a dry-run echo mode or shellcheck review).
[ ] telegram_bot.py:1202 block no longer references ensemble; refusal is env-driven.
[ ] Live checks: /health OK, /trigger/sync ok:true, /today answers. all on Oracle.
[ ] Netlify ARCEMX_BOT_URL repointed; dashboard sync works end-to-end.
[ ] Render suspended (not deleted); README documents recovery-by-redeploy.
[ ] Zero unique state on the box (audit: no files outside /opt/arcemx + /etc/arcemx.env).

IF SOMETHING IS UNCLEAR
Smallest safe assumption, tag "ASSUMPTION:", keep going. except [USER] steps, which
are always the user's.

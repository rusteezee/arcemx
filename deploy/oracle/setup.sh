#!/usr/bin/env bash
# Idempotent Oracle Cloud (or any Ubuntu 24.04 ARM/amd64 box) deploy for the
# Arc'emX! Telegram bot. Safe to rerun: package installs are no-ops when
# already present, the repo pull is a fast-forward, /etc/arcemx.env is
# written once from the template and never overwritten on rerun (so filled-
# in secrets survive a redeploy). Recovery doctrine: a destroyed instance is
# a fresh `curl ... | bash` of this script plus refilling /etc/arcemx.env -
# the box holds zero unique state, everything else lives in Supabase/GitHub.
set -euo pipefail

REPO_URL="https://github.com/rusteezee/arcemx.git"
APP_DIR="/opt/arcemx"
ENV_FILE="/etc/arcemx.env"

echo "== Arc'emX! Oracle deploy =="

echo "-- system packages --"
sudo apt-get update -y
sudo apt-get install -y software-properties-common git curl gnupg \
  debian-keyring debian-archive-keyring apt-transport-https

if ! command -v python3.11 >/dev/null 2>&1; then
  echo "-- installing python3.11 (deadsnakes PPA; Ubuntu 24.04 ships 3.12 by"
  echo "   default, pin 3.11 to match GH Actions exactly) --"
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -y
  sudo apt-get install -y python3.11 python3.11-venv
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "-- installing caddy --"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "-- repo --"
if [ -d "$APP_DIR/.git" ]; then
  echo "pulling latest into $APP_DIR"
  sudo git -C "$APP_DIR" pull --ff-only
else
  echo "cloning fresh into $APP_DIR"
  sudo git clone "$REPO_URL" "$APP_DIR"
fi
sudo chown -R "$(id -u)":"$(id -g)" "$APP_DIR"

echo "-- venv + deps --"
if [ ! -d "$APP_DIR/.venv" ]; then
  python3.11 -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "-- env file --"
if [ ! -f "$ENV_FILE" ]; then
  echo "writing $ENV_FILE template - fill in real values, then:"
  echo "  sudo systemctl restart arcemx-bot"
  sudo cp "$APP_DIR/deploy/oracle/arcemx.env.template" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
else
  echo "$ENV_FILE already exists, leaving it untouched"
  echo "(delete it first if you want it reset to the template)"
fi

echo "-- firewall --"
# Oracle's stock Ubuntu 24.04 marketplace image ships iptables pre-configured
# to allow ONLY port 22 by default (RELATED/ESTABLISHED + 2 generic ACCEPTs +
# an SSH-only ACCEPT + a trailing REJECT), completely separate from the VCN's
# cloud-level Security List. Root-caused live 2026-08-29: the Security List
# correctly allowed 80/443 from 0.0.0.0/0, but the box's own iptables still
# silently rejected both - `curl` from outside timed out while SSH (22)
# worked fine, and `curl localhost` on the box itself worked fine too, which
# is what pointed at an OS-level firewall rather than the cloud one. `-C`
# (check) makes each insert idempotent - safe to rerun.
if ! sudo iptables -C INPUT -p tcp -m state --state NEW --dport 80 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport 80 -j ACCEPT
fi
if ! sudo iptables -C INPUT -p tcp -m state --state NEW --dport 443 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport 443 -j ACCEPT
fi
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4 >/dev/null || true

echo "-- systemd units --"
sudo cp "$APP_DIR/deploy/oracle/arcemx-bot.service" /etc/systemd/system/arcemx-bot.service
sudo cp "$APP_DIR/deploy/oracle/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable arcemx-bot caddy
sudo systemctl restart arcemx-bot caddy

# Scheduled jobs (blueprint 22 Phase A). These replace GH Actions' native
# `schedule:` triggers, which drift hours late or skip days on the free tier
# (root-caused twice: the 2026-08-28 five-Telegram-push incident, and a
# 2026-08-30 grader run that landed past midnight IST and skipped its whole
# pass). The workflows themselves stay `workflow_dispatch`-callable as a
# manual recovery path. Timers are NOT auto-enabled here - see the enable
# command printed at the end, run it once /etc/arcemx.env has HC_PING_URLS
# and GNEWS_API_KEY filled in, so a job never goes live unmonitored.
echo "-- scheduled job units --"
chmod +x "$APP_DIR/deploy/oracle/run_job.sh"
for unit in arcemx-hourly-news arcemx-daily-prices arcemx-daily-sync \
            arcemx-alerts-checker arcemx-stock-analyst-dispatch \
            arcemx-factor-mining arcemx-git-pull; do
  sudo cp "$APP_DIR/deploy/oracle/$unit.service" "/etc/systemd/system/$unit.service"
  sudo cp "$APP_DIR/deploy/oracle/$unit.timer" "/etc/systemd/system/$unit.timer"
done
sudo systemctl daemon-reload
# git-pull is safe to enable unconditionally: no secrets, no external writes,
# and every other job depends on the checkout being current.
sudo systemctl enable --now arcemx-git-pull.timer

echo "== Done. =="
echo "Check status:  systemctl status arcemx-bot caddy"
echo "Watch logs:    journalctl -u arcemx-bot -f"
echo "Health check:  curl http://localhost/health"
echo
echo "Scheduled jobs are installed but NOT enabled. First confirm"
echo "/etc/arcemx.env has HC_PING_URLS and GNEWS_API_KEY, then:"
echo "  sudo systemctl enable --now arcemx-hourly-news.timer \\"
echo "    arcemx-daily-prices.timer arcemx-daily-sync.timer \\"
echo "    arcemx-alerts-checker.timer arcemx-stock-analyst-dispatch.timer"
echo "Verify:        systemctl list-timers 'arcemx-*'"
echo "Test one now:  sudo systemctl start arcemx-daily-sync.service"

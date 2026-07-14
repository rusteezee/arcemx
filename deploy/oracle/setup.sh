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

echo "-- systemd units --"
sudo cp "$APP_DIR/deploy/oracle/arcemx-bot.service" /etc/systemd/system/arcemx-bot.service
sudo cp "$APP_DIR/deploy/oracle/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable arcemx-bot caddy
sudo systemctl restart arcemx-bot caddy

echo "== Done. =="
echo "Check status:  systemctl status arcemx-bot caddy"
echo "Watch logs:    journalctl -u arcemx-bot -f"
echo "Health check:  curl http://localhost/health"

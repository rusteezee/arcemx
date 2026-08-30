#!/usr/bin/env bash
# Shared entrypoint for every scheduled job that used to run as a GH Actions
# workflow (blueprint 22). Runs one or more python modules in sequence, then
# fires the Healthchecks.io dead-man ping for the job.
#
# usage: run_job.sh <hc_key> <module> [module...]
#   hc_key   key into the HC_PING_URLS JSON map, e.g. "hourly_news"
#   module   python module path, e.g. "fetchers.news"
#
# Ports the ping logic that previously lived inline in each workflow YAML
# (see .github/workflows/daily_prices.yml's "Dead-man ping" step before this
# migration). It existed nowhere reusable, so it had to be rewritten here
# rather than imported - keep the semantics identical: bare URL on success,
# <url>/fail on failure, never let a ping failure change the job's own exit
# code, and stay silent when no URL is configured for the key.
#
# Deliberately NOT `set -e`: a failing module must still reach the ping,
# otherwise a broken job goes silently undetected - exactly the failure mode
# blueprint 02 (dead-man switch) exists to prevent.
set -uo pipefail

APP_DIR="/opt/arcemx"
PY="$APP_DIR/.venv/bin/python"

if [ "$#" -lt 2 ]; then
  echo "usage: run_job.sh <hc_key> <module> [module...]" >&2
  exit 2
fi

HC_KEY="$1"
shift

cd "$APP_DIR" || exit 1

rc=0
for module in "$@"; do
  echo "run_job: starting $module"
  if ! "$PY" -m "$module"; then
    rc=$?
    echo "run_job: $module FAILED (exit $rc)" >&2
    # Stop at the first failure. Matches GH Actions step semantics, where a
    # failed step skips the remaining ones in the job.
    break
  fi
  echo "run_job: $module ok"
done

# Ping is best-effort and must never mask the job's real exit code.
url=$("$PY" -c "import json,os;print(json.loads(os.environ.get('HC_PING_URLS') or '{}').get('$HC_KEY',''))" 2>/dev/null || true)
if [ -n "$url" ]; then
  if [ "$rc" -eq 0 ]; then
    curl -fsS -m 10 --retry 3 "$url" >/dev/null || true
  else
    curl -fsS -m 10 --retry 3 "$url/fail" >/dev/null || true
  fi
fi

exit "$rc"

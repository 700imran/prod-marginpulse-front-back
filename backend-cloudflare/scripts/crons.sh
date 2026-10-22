#!/usr/bin/env bash
# Inspect (and optionally reset) the Worker's cron schedules through the
# Cloudflare API. Why this exists: `wrangler rollback` restores a previous
# Worker *version*, but cron schedules are deployment-level config and may NOT
# be rolled back — leaving the old code running on a schedule it was never
# written for (the old scheduled() handler runs the full tenant sweep on ANY
# cron). So: after a rollback we put the schedule back to exactly the one the
# pre-keep-warm code expects.
#
# Env:  CLOUDFLARE_API_TOKEN (required)   WORKER_NAME (default: from wrangler.toml)
#       FIX=1 → set the schedule to ONLY the daily sweep; otherwise read-only.
set -euo pipefail

DAILY_CRON="0 3 * * *"
API="https://api.cloudflare.com/client/v4"
NAME="${WORKER_NAME:-$(grep -E '^name\s*=' "$(dirname "$0")/../wrangler.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')}"
auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}" -H "Content-Type: application/json")

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-$(curl -sS "${auth[@]}" "$API/accounts" | jq -r '.result[0].id // empty')}"
if [ -z "$ACCOUNT" ]; then echo "::error title=crons::could not determine the Cloudflare account id (token may lack account read access; set CLOUDFLARE_ACCOUNT_ID)"; exit 1; fi

show() { curl -sS "${auth[@]}" "$API/accounts/$ACCOUNT/workers/scripts/$NAME/schedules" | jq -c '[.result.schedules[]?.cron]'; }

before="$(show)"
echo "::notice title=cron schedules for $NAME (before)::$before"

if [ "${FIX:-0}" = "1" ]; then
  resp="$(curl -sS -X PUT "${auth[@]}" "$API/accounts/$ACCOUNT/workers/scripts/$NAME/schedules" --data "[{\"cron\":\"$DAILY_CRON\"}]")"
  if [ "$(echo "$resp" | jq -r '.success')" != "true" ]; then
    echo "::error title=crons::failed to reset schedules: $(echo "$resp" | jq -c '.errors')"; exit 1
  fi
  after="$(show)"
  echo "::notice title=cron schedules for $NAME (after reset)::$after"
  [ "$after" = "[\"$DAILY_CRON\"]" ] || { echo "::error title=crons::schedule is $after, expected only [\"$DAILY_CRON\"]"; exit 1; }
fi

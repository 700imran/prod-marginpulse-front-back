#!/usr/bin/env bash
# READ-ONLY look at how the deployed Workers are wired in Cloudflare — the things the
# code can't see and that most often explain "the button does nothing":
#   * which custom domains (e.g. api.marginpulse.in) are attached to which Worker
#   * which secrets/vars exist on the backend Worker — NAMES ONLY for secrets, never values
# Output is GitHub annotations. Nothing is changed.
set -uo pipefail
API="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}" -H "Content-Type: application/json")
NAME="${WORKER_NAME:-$(grep -E '^name\s*=' "$(dirname "$0")/../wrangler.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')}"
# vars whose VALUES are safe to show (configuration, not secrets)
SHOW_VALUES='["FRONTEND_ORIGIN","ALLOWED_ORIGINS","ENVIRONMENT","ENFORCE_PLAN_GATING","PLAN_PRICES_INR","ASSISTANT_MUTATIONS_ENABLED"]'

note() { echo "::notice title=$1::$2"; }

ACCOUNT="$(curl -sS "${auth[@]}" "$API/accounts" | jq -r '.result[0].id // empty')"
[ -n "$ACCOUNT" ] || { echo "::error title=inspect::could not read the Cloudflare account (token lacks access?)"; exit 1; }

# 1. custom domains per Worker
resp="$(curl -sS "${auth[@]}" "$API/accounts/$ACCOUNT/workers/domains")"
if [ "$(echo "$resp" | jq -r '.success')" = "true" ]; then
  note "custom domains" "$(echo "$resp" | jq -c '[.result[] | {host: .hostname, worker: .service}]')"
else
  note "custom domains" "could not list: $(echo "$resp" | jq -c '.errors')"
fi

# 2. the Worker's workers.dev subdomain switch
sub="$(curl -sS "${auth[@]}" "$API/accounts/$ACCOUNT/workers/scripts/$NAME/subdomain")"
note "workers.dev for $NAME" "$(echo "$sub" | jq -c '.result // .errors')"

# 3. bindings: secret NAMES + selected config values
set="$(curl -sS "${auth[@]}" "$API/accounts/$ACCOUNT/workers/scripts/$NAME/settings")"
if [ "$(echo "$set" | jq -r '.success')" = "true" ]; then
  note "secrets present on $NAME (names only)" "$(echo "$set" | jq -c '[.result.bindings[] | select(.type=="secret_text") | .name] | sort')"
  note "config values on $NAME" "$(echo "$set" | jq -c --argjson show "$SHOW_VALUES" '[.result.bindings[] | select(.type=="plain_text" and (.name as $n | $show | index($n))) | {(.name): .text}] | add')"
  note "other non-secret vars on $NAME (names only)" "$(echo "$set" | jq -c --argjson show "$SHOW_VALUES" '[.result.bindings[] | select(.type=="plain_text" and (.name as $n | ($show | index($n)) | not)) | .name] | sort')"
else
  note "settings of $NAME" "could not read: $(echo "$set" | jq -c '.errors')"
fi

# 4. the required ones, as an explicit checklist
need=(RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET SUPABASE_JWT_SECRET SUPABASE_SERVICE_ROLE_KEY FIELD_ENCRYPTION_KEY ANTHROPIC_API_KEY)
have="$(echo "$set" | jq -r '[.result.bindings[]?.name] | .[]' 2>/dev/null)"
missing=""; for n in "${need[@]}"; do echo "$have" | grep -qx "$n" || missing="$missing $n"; done
note "MISSING required secrets" "${missing:-none}"

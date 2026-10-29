#!/bin/bash
# Starts the Worker in the REAL Workers runtime (workerd) and requires it to answer requests.
# Catches what tsc / unit tests / `wrangler deploy --dry-run` cannot: global-scope violations,
# bad bindings, startup crashes — the failures Cloudflare reports as "build failed" at upload time.
set -u
PORT=${PORT:-8799}
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://u:p@127.0.0.1:5432/db"
LOG=$(mktemp)
npx wrangler dev --local --port "$PORT" --ip 127.0.0.1 --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; pkill -f workerd 2>/dev/null; rm -f "$LOG"' EXIT
for i in $(seq 1 60); do
  sleep 1
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/config/public" || true)
  [ "$CODE" = "200" ] && break
done
if [ "${CODE:-000}" != "200" ]; then echo "BOOT FAILED (HTTP ${CODE:-000})"; sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -E "ERROR|Error|Uncaught" | head -8; exit 1; fi
BODY=$(curl -s "http://127.0.0.1:$PORT/api/v1/config/public")
echo "$BODY" | grep -q '"enabled":true' || { echo "public config wrong: $BODY"; exit 1; }
echo "$BODY" | grep -qi 'secret' && { echo "SECRET LEAKED in public config"; exit 1; }
ME=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/auth/me")
[ "$ME" = "401" ] || { echo "/auth/me expected 401, got $ME"; exit 1; }
ROI=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/v1/roi")
[ "$ROI" = "403" ] || { echo "anonymous ROI expected 403 (captcha), got $ROI"; exit 1; }
sleep 1
grep -q '"msg":"http_request"' "$LOG" || { echo "no structured request log line emitted"; exit 1; }
echo "BOOT OK: Worker starts in workerd; config/public=200, auth/me=401, anonymous ROI=403 (captcha), telemetry log line emitted"

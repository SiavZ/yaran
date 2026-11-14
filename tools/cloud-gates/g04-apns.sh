#!/usr/bin/env bash
# G04 — A deployed Worker sends to APNs over HTTP/2.
#
# Deploys `workers/apns-probe` with the APNs auth key and a random probe key as
# secrets (one `--secrets-file`, never argv), then sends through it: one push to
# the spike app's token on an iOS 17.4+ simulator, one to a physical iPhone, one
# to a garbage token (the negative control: a 400 BadDeviceToken can only come
# from APNs answering over HTTP/2), and 50 sequential pushes. It repeats the
# garbage-token send under `wrangler dev` (local) and `wrangler dev --remote`
# to record the local failure Phase 08's docs must warn about.
#
# - The .p8 file is read from GATE_APNS_P8_FILE; device tokens come from the
#   environment or hidden prompts and travel in owner-only request files.
# - Prerequisites: Apple developer account (APNs key, test bundle id with Push),
#   the spike app on a simulator and an iPhone (spikes/mobile, PushSpike).
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g04-apns.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/access.sh
# External: curl, jq, npx (wrangler)
#
# Used by:
# tools/cloud-gates/g04-apns.sh
# └── entry point (tools/cloud-gates/run.sh G04)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"

gate_init G04 apns
is_recheck && die "G04 needs devices; it is not part of --recheck"
require_tty
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_APNS_P8_FILE GATE_APNS_KEY_ID GATE_APPLE_TEAM_ID GATE_APNS_TOPIC
[[ -r "$GATE_APNS_P8_FILE" ]] || die "cannot read GATE_APNS_P8_FILE"
PROBE="$HERE/workers/apns-probe"
NAME="yaran-gate-apns-probe-$RUN_ID"
PROBE_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
SEC="$RUN_TMP/secrets.json"
(umask 077; jq -n --rawfile p8 "$GATE_APNS_P8_FILE" --arg kid "$GATE_APNS_KEY_ID" --arg team "$GATE_APPLE_TEAM_ID" \
  --arg topic "$GATE_APNS_TOPIC" --arg pk "$PROBE_KEY" '{P8:$p8, KID:$kid, TEAM:$team, TOPIC:$topic, PROBE_KEY:$pk}' >"$SEC")
KEYH="$(header_file key "x-probe-key: $PROBE_KEY" 'content-type: application/json')"

# send <base url> <token> [count]: prints the probe's JSON answer.
send() {
  local bodyf="$RUN_TMP/body.json"
  (umask 077; jq -nc --arg t "$2" --argjson n "${3:-1}" '{token:$t, count:$n, sandbox:true}' >"$bodyf")
  curl -sS --max-time 300 -H "@$KEYH" --data-binary "@$bodyf" "$1/send" || printf '{"error":"request failed"}'
}

step "1: deploy"
worker_deploy "$PROBE" "$NAME" --secrets-file "$SEC" || die "wrangler deploy failed (see wrangler.txt)"
URL="$(workers_dev_url "$NAME")"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' -X POST $URL/send) == 401 ]]" || die "$URL never answered"

step "2-3: simulator and physical iPhone"
for dev in simulator iphone; do
  var="GATE_APNS_$(printf '%s' "$dev" | tr '[:lower:]' '[:upper:]')_TOKEN"
  if read_secret "$var" "APNs device token shown by the spike app on the $dev"; then
    r="$(send "$URL" "${!var}")"; printf '%s: %s\n' "$dev" "$r" | record sends
    check "$dev: APNs answered 200 with an apns-id" "200 yes" "$(jq -r '.results[0] | "\(.status) \(if .apnsId then "yes" else "no" end)"' <<<"$r")"
    confirm_check "$dev: the notification appeared" "did the notification show on the $dev?"
  else skip "$dev push" "no token"; fi
done

step "4: garbage token (negative control)"
r="$(send "$URL" 00ff00ff)"; printf 'garbage: %s\n' "$r" | record sends
check "garbage token: 400 BadDeviceToken (APNs answered over HTTP/2)" "400 BadDeviceToken" \
  "$(jq -r '.results[0] | "\(.status) \((.body | fromjson? | .reason) // .body)"' <<<"$r")"

step "5: 50 sequential pushes"
tok="${GATE_APNS_IPHONE_TOKEN:-${GATE_APNS_SIMULATOR_TOKEN:-}}"
if [[ -n "$tok" ]]; then
  r="$(send "$URL" "$tok" 50)"; printf 'burst: %s\n' "$(jq -c '{errors, statuses: ([.results[].status] | group_by(.) | map({(.[0]|tostring): length}) | add)}' <<<"$r")" | record sends
  check "50 sends complete with no connection errors" 0 "$(jq -r .errors <<<"$r")"
else skip "50 sequential pushes" "no device token"; fi

step "6: wrangler dev (local) and wrangler dev --remote"
D="$RUN_TMP/dev"; mkdir -p "$D" && cp -R "$PROBE/src" "$PROBE/wrangler.jsonc" "$PROBE/package.json" "$D/"
(umask 077; jq -r 'to_entries[] | "\(.key)=\(.value | @json)"' "$SEC" >"$D/.dev.vars")
for mode in local remote; do
  port=$((8800 + RANDOM % 100))
  args=(dev --port "$port"); [[ "$mode" == remote ]] && args+=(--remote)
  bg_start "wrangler-dev-$mode" wrangler_run "$D" "${args[@]}"
  if wait_until 90 bash -c "curl -s -o /dev/null http://127.0.0.1:$port/"; then
    r="$(send "http://127.0.0.1:$port" 00ff00ff)"; printf 'wrangler dev %s: %s\n' "$mode" "$r" | record dev
    observe "wrangler dev ($mode), garbage token" "$(jq -c '.results[0] | {status, body}' <<<"$r" 2>/dev/null || echo "$r")"
  else observe "wrangler dev ($mode)" "did not start (see wrangler-dev-$mode.txt)"; fi
  pkill -f "wrangler.*--port $port" 2>/dev/null || true
done

#!/usr/bin/env bash
# G12 — Access session_duration versus JWT exp, and an open WebSocket after expiry.
#
# On the G1-shaped machine fixture, sets the app's session_duration to 5m and
# the reusable policy's to 3m, then: checks `exp - iat` of a fresh JWT equals
# the effective duration (180 s), holds a cookie-authenticated WebSocket open
# for GATE_G12_HOLD_PAST_EXP seconds (default 900) past exp and records when
# and how it closes, probes a new upgrade and /cdn-cgi/access/get-identity
# after exp, and replays a token after /cdn-cgi/access/logout, after the app's
# revoke_tokens and after the org's revoke_user, polling up to 60 s each for
# the refusal. The yaran-socket half (events and PTY sockets inside the spike
# machine-view) is a checklist.
#
# - Each replay step asks for its own fresh JWT, since the previous one is the
#   thing being revoked. Unattended runs take them from GATE_IDENTITY_JWT_CMD
#   (steps 1 and 3-6, per Phase 19) and skip step 2's long hold.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g12-session-expiry.sh
# ├── tools/cloud-gates/lib/access.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/jwt.sh
# External: none
#
# Used by: entry point (tools/cloud-gates/run.sh G<NN>; G02, G03, G08, G09, G12 and G14 also via run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"
# shellcheck source=tools/cloud-gates/lib/jwt.sh
. "$(dirname "$0")/lib/jwt.sh"

gate_init G12 session-expiry
require_env "${FIXTURE_ENV[@]}"
H="$GATE_MACHINE_HOST"
HOLD="${GATE_G12_HOLD_PAST_EXP:-900}"

machine_fixture_up rule
access_app_update "$FIX_APP_ID" '{"session_duration":"5m"}' || die "setting the app session_duration failed"
access_policy_update "$FIX_POLICY_ID" '{"session_duration":"3m"}' || die "setting the policy session_duration failed"
sleep 15

# fresh <VAR> <why>: a new JWT for H (env, identity command, or prompt).
fresh() { unset "$1"; obtain_jwt "$1" "$H" "sign in again at https://$H/echo and paste a FRESH header JWT ($2)"; }
cookie_hdr() { header_file "$1" "Cookie: CF_Authorization=$2"; }
# refused_within <seconds> <header-file>: poll GET and WS until both stop succeeding.
refused_within() {
  local deadline=$((SECONDS + $1)) g w
  while ((SECONDS < deadline)); do
    g="$(probe_status get "https://$H/echo" "$2")"; w="$(probe_status ws "https://$H/ws" "$2")"
    [[ "$g" != 200 && "$w" != 101 ]] && { printf '%s/%s after %ss' "$g" "$w" "$(($1 - deadline + SECONDS))"; return 0; }
    sleep 5
  done
  printf 'still accepted (GET %s, WS %s) after %ss' "$g" "$w" "$1"; return 1
}

step "1: exp - iat versus the effective session duration"
fresh JWT1 "step 1" || die "no JWT supplied"
observe "JWT claims" "$(jwt_claims "$JWT1" | jq -c '{iat, exp, lifetime:(.exp - .iat), type}')"
check "exp - iat equals the policy session_duration (3m)" 180 "$(jwt_lifetime "$JWT1")"
EXP="$(jwt_claim "$JWT1" exp)"

step "2: an open WebSocket past exp"
if is_recheck; then skip "open socket past exp" "long hold skipped in unattended mode"
else
  hold=$((EXP - $(date +%s) + HOLD))
  log "holding a WebSocket for ${hold}s (until ${HOLD}s past exp)"
  node "$HERE/origin/ws-probe.mjs" "wss://$H/ws" --headers-file "$(cookie_hdr ws "$JWT1")" --hold "$hold" --ping-every 30 2>&1 | record ws-hold || true
  sum="$(grep '"summary":true' "$EVIDENCE_DIR/ws-hold.txt" | tail -1 || true)"
  observe "socket summary" "${sum:-none}"
  closed="$(jq -r '.closedAt // empty' <<<"$sum" 2>/dev/null)"
  observe "socket closedAt (exp is epoch $EXP)" "${closed:-still open ${HOLD}s after exp}"
fi

step "3: after exp, a new upgrade and get-identity"
if ! jwt_is_expired "$JWT1"; then log "waiting for exp"; sleep $((EXP - $(date +%s) + 5)); fi
hf="$(cookie_hdr e "$JWT1")"
check "new WS upgrade after exp is redirected" 302 "$(probe_status ws "https://$H/ws" "$hf")"
probe fetch "https://$H/cdn-cgi/access/get-identity" "$hf" | record get-identity-after-exp
fresh JWT2 "get-identity before expiry" && probe fetch "https://$H/cdn-cgi/access/get-identity" "$(cookie_hdr g "$JWT2")" | record get-identity-fresh

step "4: replay after /cdn-cgi/access/logout"
if fresh JWT3 "logout replay"; then
  probe get "https://$H/cdn-cgi/access/logout" "$(cookie_hdr l "$JWT3")" | record logout
  sleep 30
  check "cookie replay after logout" 302 "$(probe_status get "https://$H/echo" "$(cookie_hdr l2 "$JWT3")")"
  check "cf-access-token replay after logout" 302 "$(probe_status get "https://$H/echo" "$(header_file l3 "cf-access-token: $JWT3")")"
else skip "logout replay" "no JWT"; fi

step "5: replay after the app's revoke_tokens"
if fresh JWT4 "revoke_tokens replay"; then
  cf_api POST "$(cf_acct)/access/apps/$FIX_APP_ID/revoke_tokens" >/dev/null || die "revoke_tokens failed"
  r="$(refused_within 60 "$(cookie_hdr r "$JWT4")")" && ok=yes || ok=no
  observe "revoke_tokens" "$r"; check "revoke_tokens refused within 60 s (requests and upgrades)" yes "$ok"
else skip "revoke_tokens replay" "no JWT"; fi

step "6: replay after the org's revoke_user"
if fresh JWT5 "revoke_user replay"; then
  cf_api POST "$(cf_acct)/access/organizations/revoke_user" "$(jq -nc --arg e "$GATE_OWNER_EMAIL" '{email:$e}')" >/dev/null || die "revoke_user failed"
  r="$(refused_within 60 "$(cookie_hdr u "$JWT5")")" && ok=yes || ok=no
  observe "revoke_user" "$r"; check "revoke_user refused within 60 s (requests and upgrades)" yes "$ok"
else skip "revoke_user replay" "no JWT"; fi

is_recheck || checklist "G12 yaran sockets past exp (spikes/mobile machine-view)" <<EOF
Prerequisite: G1 L0 (or the adopted L1/L2 credential) and yaran reachable behind the gate tunnel (G1 step 6).
1. Inject a 3-minute JWT (this run's policy) into machine-view and open the yaran UI on $H.
2. Keep the events socket and one PTY socket open ${HOLD}s past exp, with the normal client heartbeat
   (config.server.heartbeat_seconds). Record close time, close code and reason, and whether data
   flowed after exp.
3. Reconnect after exp: the upgrade should be refused (302), which shows the probe must fire.
EOF
is_recheck || confirm_check "yaran events and PTY sockets past exp observed and recorded" "did you record the yaran socket behaviour past exp?"

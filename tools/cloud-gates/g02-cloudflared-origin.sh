#!/usr/bin/env bash
# G02 — cloudflared preserves Host, speaks HTTP/1.1 with WebSockets, and per-rule access.required + audTag enforces.
#
# Stands up a remotely managed tunnel with the production ingress shape
# (`http://127.0.0.1:<port>`, Phase 05) in front of the echo origin, then
# measures what reaches the origin: the request line and HTTP version, Host and
# the Cf-*/X-Forwarded-* set, the effect of `httpHostHeader` and `http2Origin`,
# a WebSocket round trip, and how cloudflared answers missing, garbage,
# wrong-audience and expired JWTs when `originRequest.access` sits on the rule
# versus only on the tunnel-wide block. Step 9 repeats the Host/Origin check
# against yaran in tools/preview-env when GATE_YARAN_PORT is set.
#
# - The access probes run with NO Access app on the hostname (the AUD comes from
#   an app on an unrouted host), so requests reach cloudflared directly and its
#   own check is what is measured, as the phase's "direct request" asks.
# - Unattended (--recheck): wrong-aud uses GATE_IDENTITY_JWT_CMD when set;
#   expired-JWT and step 9 are skipped.
# - Prerequisites: GATE_CF_ACCOUNT_ID, GATE_CF_API_TOKEN, GATE_STAGING_ZONE,
#   GATE_TEAM, GATE_MACHINE_HOST, GATE_OWNER_EMAIL; cloudflared >= 2026.11.0;
#   `npm ci` in tools/cloud-gates/origin.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g02-cloudflared-origin.sh
# ├── tools/cloud-gates/lib/common.sh
# ├── tools/cloud-gates/lib/access.sh
# └── tools/cloud-gates/lib/jwt.sh
# External: cloudflared, curl, jq, node
#
# Used by:
# tools/cloud-gates/g02-cloudflared-origin.sh
# └── entry point (tools/cloud-gates/run.sh G02; also run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"
# shellcheck source=tools/cloud-gates/lib/jwt.sh
. "$(dirname "$0")/lib/jwt.sh"

gate_init G02 cloudflared-origin
require_env "${FIXTURE_ENV[@]}"
H="$GATE_MACHINE_HOST"
SVC="http://127.0.0.1:${GATE_ORIGIN_PORT:-3890}"

echo_json() { curl -sS --max-time 10 -H "@${1:-/dev/null}" "https://$H/echo"; }

# config_count: how many remote configurations cloudflared has applied so far (its own log line).
config_count() { local n; n="$(grep -c "Updated to new configuration" "$EVIDENCE_DIR/cloudflared.txt" 2>/dev/null)" || true; printf '%s' "${n:-0}"; }
config_after() { [[ "$(config_count)" -gt "$1" ]]; }
# apply <access mode> <aud> <rule originRequest JSON>: PUT the ingress, wait until cloudflared applied it.
apply() {
  local before; before="$(config_count)"
  tunnel_config_put "$FIX_TUNNEL_ID" "$(ingress_json "$H" "$SVC" "$1" "$GATE_TEAM" "$2" "$3")" || die "tunnel configuration failed"
  wait_until 120 config_after "$before" || die "cloudflared did not report applying the new configuration within 120 s (see cloudflared.txt)"
  sleep 3
}

step "1-2: tunnel with the production ingress shape, echo origin on 127.0.0.1"
machine_fixture_up none

step "3: what reaches the origin"
e="$(echo_json)"; printf '%s\n' "$e" | jq . | record echo-plain
check "request line" "GET /echo HTTP/1.1" "$(jq -r .requestLine <<<"$e")"
check "origin HTTP version" "1.1" "$(jq -r .httpVersion <<<"$e")"
check "Host preserved" "$H" "$(jq -r .headers.host <<<"$e")"
observe "Cf-* and X-Forwarded-* headers" "$(jq -r '[.headers | keys[] | select(test("^(cf-|x-forwarded-)"))] | join(" ")' <<<"$e")"

step "4: httpHostHeader override (shows the field must stay unset, D4)"
apply none "" '{"httpHostHeader":"localhost:3890"}'
e="$(echo_json)"; printf '%s\n' "$e" | jq . | record echo-httpHostHeader
check "httpHostHeader rewrites Host" "localhost:3890" "$(jq -r .headers.host <<<"$e")"
check "original Host moves to X-Forwarded-Host" "$H" "$(jq -r '.headers["x-forwarded-host"] // "absent"' <<<"$e")"

step "5: http2Origin on an http:// service"
apply none "" '{"http2Origin":true}'
sleep 5
e="$(echo_json)"; printf '%s\n' "$e" | jq . | record echo-http2Origin
check "origin still sees HTTP/1.1 with http2Origin" "1.1" "$(jq -r .httpVersion <<<"$e")"
apply none "" ''

step "6: WebSocket upgrade round trip"
ws="$(node "$HERE/origin/ws-probe.mjs" "wss://$H/ws" || true)"; printf '%s\n' "$ws" | record ws
check "WebSocket upgrade answered 101" 101 "$(jq -r .status <<<"$ws")"
check "origin saw the upgrade request" upgrade "$(jq -r '.firstMessageKind // empty' <<<"$ws")"
check "WebSocket frames round-trip" true "$(jq -r .echoed <<<"$ws")"

step "7: per-rule originRequest.access with no Access app in front"
access_app_create "$GATE_TAG-aud" "$GATE_TAG-aud.$GATE_STAGING_ZONE" "" || die "Access app create failed"
AUD="$CREATED_AUD"
apply rule "$AUD" ''
access_matrix() { # <label>: none, garbage, wrong aud, expired
  local label="$1" hf
  check "$label: missing JWT" 403 "$(probe_status get "https://$H/echo")"
  hf="$(header_file garbage 'Cf-Access-Jwt-Assertion: garbage')"
  observe "$label: garbage JWT status" "$(probe_status get "https://$H/echo" "$hf")"
  check "$label: garbage JWT refused" 're:^(4|5)[0-9][0-9]$' "$(probe_status get "https://$H/echo" "$hf")"
  if obtain_jwt WRONG_AUD_JWT "$H" "JWT from a different Access app of team $GATE_TEAM (wrong aud)"; then
    hf="$(header_file wrong "Cf-Access-Jwt-Assertion: $WRONG_AUD_JWT")"
    check "$label: wrong-aud JWT" 403 "$(probe_status get "https://$H/echo" "$hf")"
  else skip "$label: wrong-aud JWT" "no JWT supplied"; fi
  if read_secret EXPIRED_JWT "an EXPIRED JWT from team $GATE_TEAM" && jwt_is_expired "$EXPIRED_JWT"; then
    hf="$(header_file expired "Cf-Access-Jwt-Assertion: $EXPIRED_JWT")"
    local s; s="$(probe_status get "https://$H/echo" "$hf")"
    observe "$label: expired JWT status (expected 502)" "$s"
    check "$label: expired JWT refused" 're:^(4|5)[0-9][0-9]$' "$s"
  else skip "$label: expired JWT" "no expired JWT supplied"; fi
}
access_matrix "per-rule access"
probe get "https://$H/echo" | record access-per-rule-body

step "8: access only on the tunnel-wide originRequest"
apply tunnel "$AUD" ''
sleep 10
s="$(probe_status get "https://$H/echo")"
observe "tunnel-level-only access, missing JWT (200 = not enforced, as the source reading predicts)" "$s"

step "9: yaran's Host/Origin check through the tunnel (tools/preview-env)"
if [[ -n "${GATE_YARAN_PORT:-}" ]] && ! is_recheck; then
  SVC="http://127.0.0.1:$GATE_YARAN_PORT"
  apply none "" ''
  hf="$(header_file origin "Origin: https://$H")"
  pause "preview-env must allow $H for this step (Phase 11's live host rule is not built yet: add it with --bind/allowed_hosts for the gate only)"
  probe fetch "https://$H/api/v1/bootstrap" "$hf" | record yaran-bootstrap
  check "yaran accepts Origin https://$H with the live host rule" 200 "$(probe_status fetch "https://$H/api/v1/bootstrap" "$hf")"
else
  skip "yaran Origin check" "GATE_YARAN_PORT unset or unattended; depends on Phase 11's live host rule"
fi

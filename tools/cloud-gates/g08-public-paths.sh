#!/usr/bin/env bash
# G08 — Public path overrides for /v1/meta and /v1/machine/* on the Worker's Access-protected hostname, and precedence.
#
# Deploys `workers/public-path-probe` on <cp-host> (custom domain, G14's API
# attach), protects the host with a control-plane-shaped self-hosted Access app
# carrying exactly two `destinations[].overrides` (`/v1/meta`,
# `/v1/machine/*`), and probes the paths the phase lists, including the
# normalisation probes that must never reach a protected route. It checks the
# API round-trips the overrides, tries a pattern without the leading slash,
# records the Access request log, then rebuilds the same policy as Option B
# (path-scoped apps with a reusable Bypass policy) and probes again.
#
# - "Public" means the probe Worker answered 200 with no Cf-Access-Jwt-Assertion;
#   "protected" means Access answered 302 before the Worker ran.
# - Fully unattended, so it is part of run.sh --recheck.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g08-public-paths.sh
# ├── tools/cloud-gates/lib/access.sh
# └── tools/cloud-gates/lib/common.sh
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

gate_init G08 public-paths
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE GATE_CP_HOST GATE_OWNER_EMAIL
CP="$GATE_CP_HOST"
SCRIPT="yaran-gate-public-path-probe-$RUN_ID"
ZONE_ID="$(zone_id_for "$GATE_STAGING_ZONE")"; [[ -n "$ZONE_ID" ]] || die "zone $GATE_STAGING_ZONE not found"

step "1: deploy the probe Worker on $CP"
worker_deploy "$HERE/workers/public-path-probe" "$SCRIPT" || die "wrangler deploy failed (see wrangler.txt)"
worker_domain_attach "$CP" "$SCRIPT" "$ZONE_ID" || die "custom domain attach failed (run G14 first; see log)"
wait_until 300 bash -c "curl -sf https://$CP/v1/meta >/dev/null" || die "https://$CP never served the probe"

step "2: control-plane-shaped app with two public overrides"
access_policy_create "$GATE_TAG-owner" "$GATE_OWNER_EMAIL" || die "policy create failed"
POLICY="$CREATED_ID"
OVR='[{"type":"public","uri":"'"$CP"'","overrides":[{"behavior":"public","path_pattern":"/v1/meta"},{"behavior":"public","path_pattern":"/v1/machine/*"}]}]'
access_app_create "$GATE_TAG-cp" "$CP" "$POLICY" '{"destinations":'"$OVR"'}' || die "Access app create failed"
APP="$CREATED_ID"
got="$(cf_get "$(cf_acct)/access/apps/$APP" '[.destinations[]?.overrides[]? | "\(.behavior) \(.path_pattern)"] | join(", ")')"
check "API round-trips the overrides" "public /v1/meta, public /v1/machine/*" "$got"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' https://$CP/v1/me) == 302 ]]" || die "Access never started protecting $CP"

# probe_path <label> <method> <path> <expect public|protected>
probe_path() {
  local s body jwt
  s="$(curl -sS -o "$RUN_TMP/b" -w '%{http_code}' -X "$2" --path-as-is --max-time 10 "https://$CP$3" || echo 000)"
  body="$(head -c 300 "$RUN_TMP/b")"
  jwt="$(jq -r '.jwtPresent // "n/a"' <<<"$body" 2>/dev/null || echo n/a)"
  printf '%s\t%s\t%s\t%s\tjwt=%s\t%s\n' "$1" "$2" "$3" "$s" "$jwt" "$(tr '\n' ' ' <<<"$body")" | record probes
  if [[ "$4" == public ]]; then check "$1: $2 $3 reaches the Worker unauthenticated" "200 jwt=false" "$s jwt=$jwt"
  else check "$1: $2 $3 stays behind Access" 302 "$s"; fi
}

probe_set() { # <label>
  probe_path "$1" GET /v1/meta public
  probe_path "$1" GET /v1/meta/x protected
  probe_path "$1" GET /v1/machine protected
  probe_path "$1" GET /v1/machine/claim public
  probe_path "$1" POST /v1/machine/unpair public
  probe_path "$1" PUT /v1/machine/origin public
  probe_path "$1" GET /v1/me protected
  probe_path "$1" GET /v1/MACHINE/claim protected
  probe_path "$1" GET /v1/machine/%2e%2e/me protected
  local s; s="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$CP/v1/machine/a/b" || echo 000)"
  observe "$1: GET /v1/machine/a/b (one * per segment?)" "$s"
}

step "3: probes against the override variant"
probe_set overrides

step "4: path_pattern without the leading slash"
r="$(cf_probe PUT "$(cf_acct)/access/apps/$APP" "$(cf_api GET "$(cf_acct)/access/apps/$APP" | jq -c --arg cp "$CP" \
  '.result | .destinations = [{type:"public", uri:$cp, overrides:[{behavior:"public", path_pattern:"v1/meta"}]}] | del(.id, .aud, .created_at, .updated_at)')")"
observe "API answer to path_pattern \"v1/meta\" (status, error codes)" "$r"

step "5: Access request log"
cf_api GET "$(cf_acct)/access/logs/access_requests?limit=50&direction=desc" 2>/dev/null |
  jq -c --arg cp "$CP" '.result[]? | select((.app_domain // "") | startswith($cp)) | {created_at, action, allowed, app_domain, path: (.path // null)}' |
  record access-log || observe "Access request log" "not readable with this token"
observe "Access log note" "bypassed/public requests are expected to be absent from this log (see access-log.txt)"

step "6: Option B, path apps with a reusable Bypass policy"
access_app_update "$APP" '{"destinations":[{"type":"public","uri":"'"$CP"'"}]}' || die "removing overrides failed"
CREATED_ID=""
bypass="$(jq -nc --arg n "$GATE_TAG-bypass" '{name:$n, decision:"bypass", include:[{everyone:{}}]}')"
BYPASS="$(cf_api POST "$(cf_acct)/access/policies" "$bypass" | jq -r '.result.id // empty')"
[[ -n "$BYPASS" ]] || die "bypass policy create failed"
cleanup_push "cf_api DELETE '$(cf_acct)/access/policies/$BYPASS'"
access_app_create "$GATE_TAG-meta" "$CP/v1/meta" "$BYPASS" || die "path app /v1/meta failed"
access_app_create "$GATE_TAG-machine" "$CP/v1/machine/" "$BYPASS" || die "path app /v1/machine/ failed"
sleep 30
probe_set option-b

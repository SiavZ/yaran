#!/usr/bin/env bash
# G03 — Access responses for unauthenticated and expired requests, by request kind and org age.
#
# Builds the response matrix Phase 13's session-expiry classifier is written
# from: credential (none, expired, garbage, revoked) × request kind
# (navigation, fetch, XHR, WebSocket upgrade, CORS preflight) × with/without a
# service-token header pair, recording status, Location host+path,
# WWW-Authenticate, content type and the first 200 bytes. `--target A` (the
# default) runs account A and then account A with Managed OAuth enabled on the
# app; `--target B` runs the pre-2026-10-05 org from the GATE_B_* settings, or
# records "not available" when they are absent. The device half (fetch with
# redirect:"manual" and a WebSocket inside machine-view after expiry) is a
# checklist.
#
# - Not pass/fail on values: the gate passes when every matrix row has a status.
# - Unattended (--recheck): target A only; expired/revoked rows need
#   GATE_IDENTITY_JWT_CMD (revoked) and are skipped without it.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g03-access-responses.sh
# ├── tools/cloud-gates/lib/common.sh
# ├── tools/cloud-gates/lib/access.sh
# └── tools/cloud-gates/lib/jwt.sh
# External: cloudflared, curl, jq, node
#
# Used by:
# tools/cloud-gates/g03-access-responses.sh
# └── entry point (tools/cloud-gates/run.sh G03 [--target A|B]; also run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"
# shellcheck source=tools/cloud-gates/lib/jwt.sh
. "$(dirname "$0")/lib/jwt.sh"

TARGET=A
while (($#)); do case "$1" in --target) TARGET="$2"; shift ;; --recheck) ;; *) die "unknown argument $1" ;; esac; shift; done
gate_init G03 access-responses

if [[ "$TARGET" == B ]]; then
  if [[ -z "${GATE_B_CF_ACCOUNT_ID:-}" ]]; then
    observe "account B (org created before 2026-10-05)" "not available; Phase 13 uses the documented expectation (strict mode changes service-token requests only)"
    exit 0
  fi
  require_env GATE_B_CF_API_TOKEN GATE_B_STAGING_ZONE GATE_B_TEAM GATE_B_MACHINE_HOST
  GATE_CF_ACCOUNT_ID="$GATE_B_CF_ACCOUNT_ID" GATE_CF_API_TOKEN="$GATE_B_CF_API_TOKEN" GATE_STAGING_ZONE="$GATE_B_STAGING_ZONE"
  GATE_TEAM="$GATE_B_TEAM" GATE_MACHINE_HOST="$GATE_B_MACHINE_HOST"
elif [[ "$TARGET" != A ]]; then die "--target must be A or B"; fi
require_env "${FIXTURE_ENV[@]}"
H="$GATE_MACHINE_HOST"

org="$(cf_api GET "$(cf_acct)/access/organizations" 2>/dev/null || true)"
observe "account $TARGET org" "$(jq -c '.result | {auth_domain, created_at, strict_service_token_auth: (.strict_service_token_auth // "absent")}' <<<"$org" 2>/dev/null || echo unknown)"

machine_fixture_up rule
service_token_create "$GATE_TAG-svc" || die "service token create failed"
SVC_HDRS=("CF-Access-Client-Id: $CREATED_CLIENT_ID" "CF-Access-Client-Secret: $CREATED_CLIENT_SECRET")

step "credentials"
read_secret EXPIRED_JWT "an EXPIRED JWT for $H (G12 makes short-lived ones)" && jwt_is_expired "$EXPIRED_JWT" || EXPIRED_JWT=""
REVOKED_JWT=""
if obtain_jwt FRESH_JWT "$H" "a FRESH JWT for $H (it will be revoked)"; then
  REVOKED_JWT="$FRESH_JWT"
  cf_api POST "$(cf_acct)/access/apps/$FIX_APP_ID/revoke_tokens" >/dev/null || die "revoke_tokens failed"
  log "revoked app tokens; waiting 60 s for propagation"; sleep 60
fi

# run_matrix <label>: every credential × kind × service-token combination.
run_matrix() {
  local label="$1" tsv="$EVIDENCE_DIR/matrix-$1.tsv" cred tok kind st hf line rows=0 answered=0
  printf 'target\tcredential\tkind\tservice_token\tstatus\tlocation\tcontent_type\twww_authenticate\tbody\n' >"$tsv"
  for cred in none expired garbage revoked; do
    case "$cred" in
      none) tok="" ;; garbage) tok="eyJnYXJiYWdlIjp0cnVlfQ.eyJnYXJiYWdlIjp0cnVlfQ.Z2FyYmFnZQ" ;;
      expired) tok="$EXPIRED_JWT" ;; revoked) tok="$REVOKED_JWT" ;;
    esac
    if [[ "$cred" != none && -z "$tok" ]]; then skip "$label: $cred rows" "no $cred JWT supplied"; continue; fi
    for kind in nav fetch xhr ws preflight; do
      for st in no yes; do
        local hdrs=()
        [[ -n "$tok" ]] && hdrs+=("Cookie: CF_Authorization=$tok")
        [[ "$st" == yes ]] && hdrs+=("${SVC_HDRS[@]}")
        hf="$(header_file m "${hdrs[@]+"${hdrs[@]}"}")"
        line="$(probe "$kind" "https://$H/echo" "$hf")"
        printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$cred" "$kind" "$st" "$line" | redact >>"$tsv"
        rows=$((rows + 1)); [[ "$(cut -f1 <<<"$line")" != 000 ]] && answered=$((answered + 1))
      done
    done
  done
  column -t -s $'\t' "$tsv" >&2 || cat "$tsv" >&2
  check "$label: every matrix row answered" "$rows" "$answered"
}

step "matrix: account $TARGET"
run_matrix "account-$TARGET"

if [[ "$TARGET" == A ]]; then
  step "matrix: account A with Managed OAuth enabled on the app"
  if access_app_update "$FIX_APP_ID" '{"oauth_configuration":{"enabled":true}}'; then
    sleep 20
    run_matrix "account-A-managed-oauth"
  else
    observe "Managed OAuth" "enabling oauth_configuration was refused (see log); the L2 fallback depends on it"
  fi
fi

if ! is_recheck; then
  checklist "G03 device half: responses inside machine-view after the cookie expires" <<EOF
Prerequisite: a short-lived JWT from G12 (policy session 3m), injected with the spike's machine-view.
1. In machine-view open https://$H/expiry (the echo origin serves it here).
2. Wait past the JWT exp. Record what fetch('/echo', {redirect:'manual'}) resolves to
   (expected type "opaqueredirect", status 0) and what the WebSocket reports (onerror, close code).
3. Do this in Android WebView (emulator and GrapheneOS Pixel) and WKWebView (simulator and iPhone).
EOF
  for dev in "Android WebView" "WKWebView"; do
    ask FETCH_RESULT_"${dev// /_}" "$dev: fetch redirect:'manual' result after expiry (type/status)" || skip "$dev fetch after expiry" "not observed"
    ask WS_RESULT_"${dev// /_}" "$dev: WebSocket result after expiry (event, close code)" || skip "$dev WebSocket after expiry" "not observed"
  done
fi

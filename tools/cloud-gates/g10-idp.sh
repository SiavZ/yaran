#!/usr/bin/env bash
# G10 — IdP detection and One-time PIN creation through the API in a fresh org, and the no-org branch.
#
# On account A it reads the Access organization (auth_domain, strict service-
# token mode) and the identity providers, expecting only the default
# `type:"cloudflare"` IdP; creates a One-time PIN IdP by API; and wires it into
# a test app whose policy admits a non-member address, so the operator can
# confirm the PIN sign-in. On scratch account C (no Zero Trust org) it records
# what `GET` and `POST /access/organizations` (empty, then with auth_domain and
# name) answer, which decides the wizard's no-org branch. Every call is also
# replayed with a token missing the Access organization permission.
#
# - The OTP IdP, the app and its policy are deleted at exit. An org created on
#   account C cannot be deleted by API; account C is a scratch account for that reason.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g10-idp.sh
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

gate_init G10 idp
is_recheck && die "G10 changes org state and needs an operator; it is not part of --recheck"
require_tty
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE GATE_NONMEMBER_EMAIL
A="$(cf_acct)"

step "1: organization and identity providers on account A"
org="$(cf_api GET "$A/access/organizations")" || die "reading the Access organization failed"
observe "organization" "$(jq -c '.result | {auth_domain, name, created_at, strict_service_token_auth: (.strict_service_token_auth // "absent")}' <<<"$org")"
idps="$(cf_api GET "$A/access/identity_providers")" || die "listing identity providers failed"
printf '%s\n' "$idps" | jq -c '.result[]? | {id, name, type, config}' | record idps
check "IdP types before (expect only the Cloudflare IdP)" cloudflare "$(jq -r '[.result[]?.type] | unique | join(",")' <<<"$idps")"
observe "Cloudflare IdP restricted to account members" "$(jq -c '[.result[]? | select(.type == "cloudflare") | (.config.restrict_to_account_members // .restrict_to_account_members // "absent")]' <<<"$idps")"

step "2: create One-time PIN by API and use it"
otp="$(cf_api POST "$A/access/identity_providers" "$(jq -nc --arg n "$GATE_TAG One-time PIN login" '{name:$n, type:"onetimepin", config:{}}')" || true)"
OTP_ID="$(jq -r '.result.id // empty' <<<"$otp")"
check "One-time PIN created by API" 're:^[0-9a-f-]{36}$' "${OTP_ID:-refused: $(cf_error_summary "$otp")}"
if [[ -n "$OTP_ID" ]]; then
  cleanup_push "cf_api DELETE '$A/access/identity_providers/$OTP_ID'"
  access_policy_create "$GATE_TAG-nonmember" "$GATE_NONMEMBER_EMAIL" || die "policy create failed"
  host="$GATE_TAG-otp.$GATE_STAGING_ZONE"
  access_app_create "$GATE_TAG-otp" "$host" "$CREATED_ID" "$(jq -nc --arg i "$OTP_ID" '{allowed_idps:[$i], auto_redirect_to_identity:false}')" ||
    die "test app create failed"
  log "Open https://$host/ in a private window, choose One-time PIN, and sign in as the non-member address."
  log "(No DNS record is needed: Access answers on the hostname before any origin.)"
  confirm_check "non-member receives a PIN and passes Access through the API-created OTP" "did the PIN arrive and the sign-in pass Access?"
fi

step "4a: account A calls with a token missing the Access organization permission"
if read_secret GATE_G10_TOKEN_NOACCESS "a token WITHOUT 'Access: Organizations, Identity Providers, and Groups'"; then
  observe "GET organizations without the permission" "$(CF_TOKEN_VAR=GATE_G10_TOKEN_NOACCESS cf_probe GET "$A/access/organizations")"
  observe "GET identity_providers without the permission" "$(CF_TOKEN_VAR=GATE_G10_TOKEN_NOACCESS cf_probe GET "$A/access/identity_providers")"
  observe "POST onetimepin without the permission" "$(CF_TOKEN_VAR=GATE_G10_TOKEN_NOACCESS cf_probe POST "$A/access/identity_providers" '{"name":"gate-denied","type":"onetimepin","config":{}}')"
else skip "missing-permission errors (account A)" "no token supplied"; fi

step "3: account C, no Zero Trust org"
if [[ -n "${GATE_C_CF_ACCOUNT_ID:-}" ]] && read_secret GATE_C_CF_API_TOKEN "account C token"; then
  C="/accounts/$GATE_C_CF_ACCOUNT_ID"
  observe "C: GET organizations" "$(CF_TOKEN_VAR=GATE_C_CF_API_TOKEN cf_probe GET "$C/access/organizations")"
  r="$(CF_TOKEN_VAR=GATE_C_CF_API_TOKEN cf_api POST "$C/access/organizations" '{}' 2>&1 || true)"
  printf 'POST {}: %s\n' "$r" | record account-c
  observe "C: POST organizations {} (status, codes)" "$(cf_last_status) $(cf_error_codes "$r")"
  body="$(jq -nc --arg d "$GATE_TAG.cloudflareaccess.com" --arg n "$GATE_TAG" '{auth_domain:$d, name:$n}')"
  r="$(CF_TOKEN_VAR=GATE_C_CF_API_TOKEN cf_api POST "$C/access/organizations" "$body" 2>&1 || true)"
  printf 'POST {auth_domain,name}: %s\n' "$r" | record account-c
  observe "C: POST organizations {auth_domain,name} (status, codes)" "$(cf_last_status) $(cf_error_codes "$r")"
  if read_secret GATE_C_TOKEN_NOACCESS "an account C token WITHOUT the Access organization permission"; then
    observe "C: GET organizations without the permission" "$(CF_TOKEN_VAR=GATE_C_TOKEN_NOACCESS cf_probe GET "$C/access/organizations")"
  fi
else skip "account C (no-org branch)" "GATE_C_CF_ACCOUNT_ID or its token missing"; fi

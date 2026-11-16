#!/usr/bin/env bash
# G09 — The account-owned API token template URL, with permission group IDs resolved by API.
#
# Resolves every permission group the control plane needs through
# `GET /accounts/{id}/tokens/permission_groups?name=…`, diffs the IDs against
# the research table (cloudflare-parts/04 §2, partly datamined), builds the
# account-owned template URL from the resolved IDs, and, with the token the
# operator creates from that link: verifies it, exercises each permission with
# one call, and records the exact error each permission's absence produces,
# from tokens the operator creates with one permission removed at a time.
#
# - The resolved table is written as `permission-groups.tsv`; Phase 07's
#   `token-template.ts` is generated from that evidence.
# - Unattended (--recheck): ID resolution only (Phase 03 WI-7).
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g09-token-template.sh
# ├── tools/cloud-gates/lib/cf.sh
# └── tools/cloud-gates/lib/common.sh
# External: none
#
# Used by: entry point (tools/cloud-gates/run.sh G<NN>; G02, G03, G08, G09, G12 and G14 also via run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/cf.sh
. "$(dirname "$0")/lib/cf.sh"

gate_init G09 token-template
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE

# name <TAB> research id (cloudflare-parts/04 §2; "-" when the research had none)
EXPECTED="Cloudflare Tunnel Write	c07321b023e944ff818fec44d8203567
Access: Apps and Policies Write	1e13c5124ca64b72b1969a67e8829049
Access: Organizations, Identity Providers, and Groups Read	26bc23f853634eb4bff59983b9064fde
Access: Organizations, Identity Providers, and Groups Write	bfe0d8686a584fa680f4c53b5eb0de6d
Account Settings Read	c1fde68c7bcc44588cbb6ddbc16d6480
Zone Read	c8fed203ed3043cba015a93ad1616f1f
DNS Write	4755a26eedb94da69e1066d98aa820be
Workers Scripts Write	e086da7e2179491d91ee5f35b3ca210a
Workers Routes Write	-"

step "1-2: resolve each permission group by name and diff against the research"
TSV="$EVIDENCE_DIR/permission-groups.tsv"
printf 'name\tid\tscopes\tresearch_id\tmatches_research\n' >"$TSV"
IDS=()
while IFS=$'\t' read -r name want; do
  out="$(cf_api GET "$(cf_acct)/tokens/permission_groups?name=$(jq -rn --arg n "$name" '$n | @uri')" 2>/dev/null || true)"
  row="$(jq -r --arg n "$name" '[.result[]? | select(.name == $n)][0] // {} | "\(.id // "")\t\((.scopes // []) | join(","))"' <<<"$out" 2>/dev/null || printf '\t')"
  id="${row%%$'\t'*}"
  m=n/a; [[ "$want" != - ]] && { [[ "$id" == "$want" ]] && m=yes || m=no; }
  printf '%s\t%s\t%s\n' "$name" "$row" "$want	$m" >>"$TSV"
  check "resolves: $name" 're:^[0-9a-f]{32}$' "${id:-unresolved}"
  [[ "$m" == no ]] && observe "research id differs: $name" "research $want, API $id"
  [[ -n "$id" ]] && IDS+=("$id")
done <<<"$EXPECTED"
column -t -s $'\t' "$TSV" >&2 || cat "$TSV" >&2

step "3: template URL"
URL="$(token_template_url "yaran control plane" "${IDS[@]+"${IDS[@]}"}")"
printf '%s\n' "$URL" | record template-url
is_recheck && exit 0
log "Open the URL above in the dashboard as an account admin."
confirm_check "template pre-fills every permission with no unresolved notice" "did every row pre-fill with no 'unresolved' notice?"
log "Scope the zone permissions to $GATE_STAGING_ZONE and create the token."

step "4: verify the created token"
read_secret GATE_G09_TOKEN "the token created from the template" || die "no token supplied"
r="$(CF_TOKEN_VAR=GATE_G09_TOKEN cf_api GET "$(cf_acct)/tokens/verify" 2>/dev/null || true)"
check "account token verify" active "$(jq -r '.result.status // "error"' <<<"$r")"
observe "/user/tokens/verify with an account token" "$(CF_TOKEN_VAR=GATE_G09_TOKEN cf_probe GET /user/tokens/verify)"

ZONE_ID="$(zone_id_for "$GATE_STAGING_ZONE")"
# exercise <token var> <label prefix> <record name>: one call per permission.
exercise() {
  local tv="$1" A; A="$(cf_acct)"
  local calls="tunnels	GET	$A/cfd_tunnel?per_page=1
access apps	GET	$A/access/apps?per_page=1
access policies	GET	$A/access/policies?per_page=1
identity providers	GET	$A/access/identity_providers
access organization	GET	$A/access/organizations
account settings	GET	$A
zones	GET	/zones?name=$GATE_STAGING_ZONE
dns records	GET	/zones/$ZONE_ID/dns_records?per_page=1
worker scripts	GET	$A/workers/scripts
worker domains (dry-run attach target)	GET	$A/workers/domains?zone_id=$ZONE_ID"
  while IFS=$'\t' read -r label m path; do
    printf '%s\t%s\t%s\n' "$2" "$label" "$(CF_TOKEN_VAR="$tv" cf_probe "$m" "$path")"
  done <<<"$calls" | tee -a "$EVIDENCE_DIR/$3.tsv"
}

step "5: exercise each permission with the full token"
exercise GATE_G09_TOKEN full exercise | while IFS=$'\t' read -r _ label status codes; do
  printf '%s\t%s\n' "$label" "$status"
done >"$RUN_TMP/full"
while IFS=$'\t' read -r label status; do check "full token: $label" 200 "$status"; done <"$RUN_TMP/full"

step "6: each permission removed in turn"
while IFS=$'\t' read -r name _; do
  unset GATE_G09_TOKEN_MINUS
  if read_secret GATE_G09_TOKEN_MINUS "a token with every permission EXCEPT \"$name\""; then
    exercise GATE_G09_TOKEN_MINUS "without $name" missing-permission >/dev/null
    observe "without $name" "$(grep -F "without $name" "$EVIDENCE_DIR/missing-permission.tsv" | awk -F'\t' '$3 != 200 {print $2 "=" $3 "/" $4}' | paste -sd ' ' -)"
  else skip "without $name" "no token supplied"; fi
done <<<"$EXPECTED"
confirm_check "every removal produces a distinguishable error (see missing-permission.tsv)" "is each removal's failure distinguishable?"

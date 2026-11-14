#!/usr/bin/env bash
# G14 — Attaching a Worker custom domain through the API from inside the Worker, the permission it needs, and the workers.dev host lock.
#
# Deploys `workers/domain-probe` with the shipped deploy tree's settings (D19:
# workers.dev on, preview URLs off, no route or custom domain in its config),
# then has the Worker itself call `PUT /accounts/{id}/workers/domains` with
# token A (Workers Scripts Write only) and token B (A + Zone Read, DNS Write,
# Workers Routes Write), each pasted into the Worker's form so no token is on
# argv. It times the certificate, proves a pre-existing CNAME or A record makes
# the attach refuse rather than overwrite, has the Worker disable its own
# workers.dev route, measures whether a redeploy brings workers.dev back (with
# and without `workers_dev` in the config), and probes the host lock 04/07
# implement: /setup* and /v1/meta only on workers.dev while setup is open, and
# `421 misdirected_host` naming no host for any other Host once it is closed.
#
# - Unattended (--recheck) runs step 6 only, with the gate runner token.
# - The Workers Builds redeploy variant of step 7 needs G11's connected
#   repository and is a checklist item.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g14-custom-domain.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/access.sh
# External: curl, jq, npx (wrangler)
#
# Used by:
# tools/cloud-gates/g14-custom-domain.sh
# └── entry point (tools/cloud-gates/run.sh G14; also run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"

gate_init G14 custom-domain
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE GATE_CP_HOST
CP="$GATE_CP_HOST"
SCRIPT="yaran-gate-domain-probe-$RUN_ID"
PROBE="$HERE/workers/domain-probe"
ZONE_ID="$(zone_id_for "$GATE_STAGING_ZONE")"; [[ -n "$ZONE_ID" ]] || die "zone $GATE_STAGING_ZONE not found"

deploy() { # <SETUP_STATE> [dir]
  wrangler_run "${2:-$PROBE}" deploy --name "$SCRIPT" --var "SETUP_STATE:$1" --var "CP_HOST:$CP" 2>&1 | record wrangler
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || echo 000; }
# form_post <path> <token-var> <field=value>...: POST to the Worker's setup form, token from a file.
form_post() {
  local path="$1" tf="$RUN_TMP/tok"; shift
  (umask 077; printf '%s' "${!1}" >"$tf"); shift
  local -a a=(--data-urlencode "token@$tf" --data-urlencode "account_id=$GATE_CF_ACCOUNT_ID")
  local kv; for kv in "$@"; do a+=(--data-urlencode "$kv"); done
  curl -sS --max-time 60 "${a[@]}" "$WDEV$path"; rm -f "$tf"
}
attach() { form_post /setup/attach "$1" "zone_id=$ZONE_ID" "hostname=$CP" "service=$SCRIPT"; }
detach_all() {
  local id
  for id in $(cf_get "$(cf_acct)/workers/domains?hostname=$CP" '.result[]?.id'); do cf_api DELETE "$(cf_acct)/workers/domains/$id" >/dev/null; done
}
subdomain() { form_post /setup/subdomain "$1" "script=$SCRIPT" "enabled=$2" "previews_enabled=false"; }

step "1: deploy with the shipped settings"
deploy open || die "wrangler deploy failed (see wrangler.txt)"
cleanup_push "wrangler_run '$PROBE' delete --name '$SCRIPT' --force"
cleanup_push detach_all
WDEV="$(workers_dev_url "$SCRIPT")" || die "account has no workers.dev subdomain"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' $WDEV/v1/meta) == 200 ]]" || die "$WDEV/v1/meta never answered"
observe "workers.dev URL" "$WDEV"

if is_recheck; then
  step "6 (recheck): the Worker disables its own workers.dev route"
  r="$(subdomain GATE_CF_API_TOKEN false)"; printf '%s\n' "$r" | record subdomain
  check "subdomain disable call succeeds" true "$(jq -r .success <<<"$r")"
  wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' $WDEV/v1/meta) != 200 ]]" || true
  check "workers.dev stops serving after disable" 're:^(404|52[0-9])$' "$(code "$WDEV/v1/meta")"
  exit 0
fi

step "2: tokens A and B"
WSW="$(perm_group_id "Workers Scripts Write")"; ZR="$(perm_group_id "Zone Read")"
DW="$(perm_group_id "DNS Write")"; WRW="$(perm_group_id "Workers Routes Write")"
observe "token A template" "$(token_template_url "gate G14 token A" "$WSW")"
observe "token B template" "$(token_template_url "gate G14 token B" "$WSW" "$ZR" "$DW" "$WRW")"
log "Create both tokens from the links above (scope B's zone permissions to $GATE_STAGING_ZONE)."
read_secret GATE_G14_TOKEN_A "token A (Workers Scripts Write only)" || die "token A is required"
read_secret GATE_G14_TOKEN_B "token B (A + Zone Read, DNS Write, Workers Routes Write)" || die "token B is required"

step "3: attach from inside the Worker"
WINNER=""
for t in A B; do
  r="$(attach "GATE_G14_TOKEN_$t")"; printf 'token %s: %s\n' "$t" "$r" | record attach
  observe "attach with token $t" "$(jq -c '{httpStatus, success, errors}' <<<"$r" 2>/dev/null || echo "$r")"
  if [[ "$(jq -r .success <<<"$r" 2>/dev/null)" == true ]]; then WINNER="$t"; break; fi
done
check "some token from the G9 set attaches the domain from inside the Worker" 're:^(A|B)$' "${WINNER:-none}"
[[ -n "$WINNER" ]] || die "no token attached the domain; adopt the fallback (dashboard steps + poll)"
TOK="GATE_G14_TOKEN_$WINNER"

step "4: time to a valid certificate"
t0=$SECONDS
wait_until 900 curl -sSf --max-time 10 "https://$CP/v1/meta" && ok=yes || ok=no
check "certificate valid within 15 minutes" yes "$ok"
observe "seconds from attach 200 to a verifying TLS handshake" "$((SECONDS - t0))"
cf_api GET "/zones/$ZONE_ID/ssl/certificate_packs?status=all" 2>/dev/null |
  jq -c --arg h "$CP" '.result[]? | select((.hosts // []) | index($h)) | {id, type, status, hosts}' | record certificate-packs || true

step "5: conflicting records are refused, not overwritten"
detach_all
for rec in "CNAME $GATE_STAGING_ZONE" "A 192.0.2.1"; do
  read -r ty content <<<"$rec"
  dns_record_create "$ZONE_ID" "$ty" "$CP" "$content" || die "could not pre-create the $ty record"
  rid="$CREATED_ID"
  r="$(attach "$TOK")"; printf '%s with pre-existing %s: %s\n' "$CP" "$ty" "$r" | record conflict
  check "attach over an existing $ty is refused" false "$(jq -r .success <<<"$r")"
  check "the existing $ty record survives" "$ty" "$(cf_get "/zones/$ZONE_ID/dns_records/$rid" '.result.type' || echo gone)"
  cf_api DELETE "/zones/$ZONE_ID/dns_records/$rid" >/dev/null
done
r="$(attach "$TOK")"; [[ "$(jq -r .success <<<"$r")" == true ]] || die "re-attach failed: $r"

step "6: the Worker disables its own workers.dev route"
r="$(subdomain "$TOK" false)"; printf '%s\n' "$r" | record subdomain
check "subdomain disable call succeeds" true "$(jq -r .success <<<"$r")"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' $WDEV/v1/meta) != 200 ]]" || true
check "workers.dev stops serving after disable" 're:^(404|52[0-9])$' "$(code "$WDEV/v1/meta")"

step "7: does a redeploy bring workers.dev back?"
deploy open || die "redeploy failed"; sleep 20
observe "workers.dev after redeploy with workers_dev: true" "$(code "$WDEV/v1/meta")"
subdomain "$TOK" false >/dev/null; sleep 20
mkdir -p "$RUN_TMP/unset" && cp -R "$PROBE/src" "$PROBE/package.json" "$RUN_TMP/unset/"
grep -v '"workers_dev"' "$PROBE/wrangler.jsonc" >"$RUN_TMP/unset/wrangler.jsonc"
ln -s "$PROBE/node_modules" "$RUN_TMP/unset/node_modules" 2>/dev/null || true
deploy open "$RUN_TMP/unset" || die "redeploy without workers_dev failed"; sleep 20
observe "workers.dev after redeploy with workers_dev unset" "$(code "$WDEV/v1/meta")"
checklist "G14 step 7, Workers Builds variant" <<EOF
With the G11 deploy-probe clone connected to Workers Builds: disable workers.dev from the Worker,
push a commit, and record whether workers.dev serves again after the build (shipped config keeps
workers_dev: true; Phase 07's update workflow rewrites it to false once setup is closed).
EOF

step "8: host lock"
cf_api POST "$(cf_acct)/workers/scripts/$SCRIPT/subdomain" '{"enabled":true,"previews_enabled":false}' >/dev/null || die "re-enabling workers.dev failed"
deploy open || die "redeploy failed"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' $WDEV/v1/meta) == 200 ]]" || die "workers.dev did not come back"
check "open: workers.dev /setup served" 200 "$(code "$WDEV/setup")"
check "open: workers.dev /v1/meta served" 200 "$(code "$WDEV/v1/meta")"
check "open: workers.dev / refused" 404 "$(code "$WDEV/")"
check "open: workers.dev /v1/me refused" 404 "$(code "$WDEV/v1/me")"
deploy closed || die "redeploy (closed) failed"
wait_until 120 bash -c "[[ \$(curl -s -o /dev/null -w '%{http_code}' $WDEV/v1/meta) == 421 ]]" || true
body="$(curl -s --max-time 10 "$WDEV/v1/meta")"; printf '%s\n' "$body" | record host-lock
check "closed: workers.dev gets 421" 421 "$(code "$WDEV/v1/meta")"
check "closed: 421 code is misdirected_host" misdirected_host "$(jq -r .error.code <<<"$body")"
check "closed: 421 body names no host" no "$(grep -qiE "$CP|workers\.dev" <<<"$body" && echo yes || echo no)"
check "closed: workers.dev /setup gets 421" 421 "$(code "$WDEV/setup")"
check "closed: $CP /v1/meta served" 200 "$(code "https://$CP/v1/meta")"
check "closed: $CP /setup is gone" 410 "$(code "https://$CP/setup")"

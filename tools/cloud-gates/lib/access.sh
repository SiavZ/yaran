#!/usr/bin/env bash
# Test-resource helpers: Access apps, reusable policies, tunnels, DNS, Worker
# domains and service tokens, all tagged `gate-<gate>-<run>`, plus the "machine
# fixture" (tunnel + Access app + DNS + echo origin + cloudflared) that G1, G2,
# G3, G6 and G12 stand on, and the `sweep` that removes anything a dead run left.
#
# Every create helper registers its own delete with `cleanup_push`, in the
# reverse of D21's provisioning order, so a run that dies mid-way still tears
# down DNS before the tunnel and the Access app last.
#
# - Never prints a tunnel token; it lives in a shell variable and reaches
#   cloudflared as TUNNEL_TOKEN in the child's environment only.
# - `ingress_json` is pure (tested offline): the per-rule versus tunnel-level
#   `originRequest.access` placement G2 measures is decided there.
# - Run directly for maintenance: `lib/access.sh sweep [--dry-run] [--max-age-hours N]`.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/lib/access.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/cf.sh
# External: curl, jq, cloudflared, node
#
# Used by:
# tools/cloud-gates/lib/access.sh
# ├── tools/cloud-gates/tests/lib_test.sh
# ├── tools/cloud-gates/g01-cookie-injection.sh
# ├── tools/cloud-gates/g02-cloudflared-origin.sh
# ├── tools/cloud-gates/g03-access-responses.sh
# ├── tools/cloud-gates/g04-apns.sh
# ├── tools/cloud-gates/g06-machine-view.sh
# ├── tools/cloud-gates/g08-public-paths.sh
# ├── tools/cloud-gates/g10-idp.sh
# ├── tools/cloud-gates/g11-deploy-button.sh
# ├── tools/cloud-gates/g12-session-expiry.sh
# ├── tools/cloud-gates/g13-system-browser-auth.sh
# └── tools/cloud-gates/g14-custom-domain.sh
# <module-headers:end>

# shellcheck source=tools/cloud-gates/lib/common.sh
[[ -n "${GATES_DIR:-}" ]] || . "$(dirname "${BASH_SOURCE[0]}")/common.sh"
# shellcheck source=tools/cloud-gates/lib/cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/cf.sh"

GATE_ORIGIN_PORT="${GATE_ORIGIN_PORT:-3890}"
GATE_CLOUDFLARED="${GATE_CLOUDFLARED:-cloudflared}"
GATE_CLOUDFLARED_MIN="${GATE_CLOUDFLARED_MIN:-2026.11.0}"
GATE_WRANGLER="${GATE_WRANGLER:-npx --yes wrangler@4.162.0}"
# Settings every machine-fixture gate needs, checked before anything is created.
FIXTURE_ENV=(GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE GATE_MACHINE_HOST GATE_TEAM GATE_OWNER_EMAIL)

zone_id_for() { cf_get "/zones?name=$1" '.result[0].id // empty'; }

# Creators below set CREATED_ID (and friends) instead of printing, because a
# function run inside $(...) would register its cleanup in a lost subshell.

# access_policy_create <name> <email> [session_duration]: reusable owner-only policy.
access_policy_create() {
  local body
  body="$(jq -nc --arg n "$1" --arg e "$2" --arg d "${3:-}" \
    '{name:$n, decision:"allow", include:[{email:{email:$e}}]} + (if $d != "" then {session_duration:$d} else {} end)')"
  CREATED_ID="$(cf_api POST "$(cf_acct)/access/policies" "$body" | jq -r '.result.id // empty')"
  [[ -n "$CREATED_ID" ]] || return 1
  cleanup_push "cf_api DELETE '$(cf_acct)/access/policies/$CREATED_ID'"
}

# access_app_create <name> <domain> <policy-id|""> [extra JSON merged in]: sets CREATED_ID CREATED_AUD.
access_app_create() {
  local body out x="${4:-}"
  [[ -n "$x" ]] || x='{}'
  body="$(jq -nc --arg n "$1" --arg d "$2" --arg p "$3" --argjson x "$x" \
    '{name:$n, type:"self_hosted", domain:$d, destinations:[{type:"public", uri:$d}],
      session_duration:"24h", enable_binding_cookie:false, app_launcher_visible:false,
      policies:(if $p != "" then [{id:$p, precedence:1}] else [] end)} + $x')"
  out="$(cf_api POST "$(cf_acct)/access/apps" "$body")" || return 1
  CREATED_ID="$(jq -r '.result.id' <<<"$out")"
  CREATED_AUD="$(jq -r '.result.aud' <<<"$out")"
  cleanup_push "cf_api DELETE '$(cf_acct)/access/apps/$CREATED_ID'"
}

# access_app_update <id> <JSON patch>: GET, merge, PUT (the API has no PATCH).
access_app_update() {
  local cur
  cur="$(cf_api GET "$(cf_acct)/access/apps/$1")" || return 1
  cf_api PUT "$(cf_acct)/access/apps/$1" "$(jq -c --argjson p "$2" '.result + $p | del(.id, .aud, .created_at, .updated_at)' <<<"$cur")" >/dev/null
}

access_policy_update() {
  local cur
  cur="$(cf_api GET "$(cf_acct)/access/policies/$1")" || return 1
  cf_api PUT "$(cf_acct)/access/policies/$1" "$(jq -c --argjson p "$2" '.result + $p | del(.id, .created_at, .updated_at, .app_count, .reusable)' <<<"$cur")" >/dev/null
}

# service_token_create <name>: sets CREATED_ID CREATED_CLIENT_ID CREATED_CLIENT_SECRET (memory only).
service_token_create() {
  local out
  out="$(cf_api POST "$(cf_acct)/access/service_tokens" "$(jq -nc --arg n "$1" '{name:$n, duration:"8760h"}')" 2>/dev/null)" || return 1
  CREATED_ID="$(jq -r .result.id <<<"$out")"
  CREATED_CLIENT_ID="$(jq -r .result.client_id <<<"$out")"
  CREATED_CLIENT_SECRET="$(jq -r .result.client_secret <<<"$out")"
  cleanup_push "cf_api DELETE '$(cf_acct)/access/service_tokens/$CREATED_ID'"
}

tunnel_create() {
  CREATED_ID="$(cf_api POST "$(cf_acct)/cfd_tunnel" "$(jq -nc --arg n "$1" '{name:$n, config_src:"cloudflare"}')" | jq -r '.result.id // empty')"
  [[ -n "$CREATED_ID" ]] || return 1
  cleanup_push "cf_api DELETE '$(cf_acct)/cfd_tunnel/$CREATED_ID'"
  cleanup_push "cf_api DELETE '$(cf_acct)/cfd_tunnel/$CREATED_ID/connections'"
}

tunnel_token() { cf_get "$(cf_acct)/cfd_tunnel/$1/token" '.result'; }

# ingress_json <host> <service> <access: none|rule|tunnel> [team] [aud] [rule originRequest JSON]
ingress_json() {
  local extra="${6:-}"
  [[ -n "$extra" ]] || extra='{}'
  jq -nc --arg h "$1" --arg s "$2" --arg mode "$3" --arg team "${4:-}" --arg aud "${5:-}" --argjson extra "$extra" '
    ({required:true, teamName:$team, audTag:[$aud]}) as $acc
    | {config:{
        ingress:[
          {hostname:$h, service:$s,
           originRequest:($extra + (if $mode == "rule" then {access:$acc} else {} end))},
          {service:"http_status:404"}],
        originRequest:(if $mode == "tunnel" then {access:$acc} else {} end)}}'
}

tunnel_config_put() { cf_api PUT "$(cf_acct)/cfd_tunnel/$1/configurations" "$2" >/dev/null; }

# dns_record_create <zone-id> <type> <host> <content>: proxied, tagged; sets CREATED_ID.
dns_record_create() {
  CREATED_ID="$(cf_api POST "/zones/$1/dns_records" "$(jq -nc --arg ty "$2" --arg h "$3" --arg t "$4" --arg c "$GATE_TAG" \
    '{type:$ty, name:$h, content:$t, proxied:true, comment:$c}')" | jq -r '.result.id // empty')"
  [[ -n "$CREATED_ID" ]] || return 1
  cleanup_push "cf_api DELETE '/zones/$1/dns_records/$CREATED_ID'"
}

dns_cname_create() { dns_record_create "$1" CNAME "$2" "$3.cfargotunnel.com"; } # <zone-id> <host> <tunnel-id>

# worker_domain_attach <host> <script> <zone-id>: sets CREATED_ID to the domain id.
worker_domain_attach() {
  CREATED_ID="$(cf_api PUT "$(cf_acct)/workers/domains" "$(jq -nc --arg h "$1" --arg s "$2" --arg z "$3" '{hostname:$h, service:$s, zone_id:$z}')" | jq -r '.result.id // empty')"
  [[ -n "$CREATED_ID" ]] || return 1
  cleanup_push "cf_api DELETE '$(cf_acct)/workers/domains/$CREATED_ID'"
}

# wrangler_run <dir> <args...>: wrangler with the gate token in its env, never argv.
wrangler_run() {
  local dir="$1"; shift
  # shellcheck disable=SC2086 # GATE_WRANGLER is a command line by design
  (cd "$dir" && CLOUDFLARE_API_TOKEN="${!CF_TOKEN_VAR}" CLOUDFLARE_ACCOUNT_ID="${!CF_ACCOUNT_VAR}" $GATE_WRANGLER "$@")
}

# worker_deploy <dir> <script-name> [wrangler deploy args...]: deploy + delete at exit.
worker_deploy() {
  local dir="$1" name="$2"; shift 2
  wrangler_run "$dir" deploy --name "$name" "$@" 2>&1 | record wrangler || return 1
  cleanup_push "wrangler_run '$dir' delete --name '$name' --force"
}

workers_dev_url() { # <script-name>
  local sub; sub="$(cf_get "$(cf_acct)/workers/subdomain" '.result.subdomain // empty')" || return 1
  printf 'https://%s.%s.workers.dev' "$1" "$sub"
}

cloudflared_check() {
  require_cmd "$GATE_CLOUDFLARED"
  local v; v="$("$GATE_CLOUDFLARED" --version 2>&1 | grep -Eo '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)"
  observe "cloudflared version" "${v:-unknown}"
  version_ge "${v:-0}" "$GATE_CLOUDFLARED_MIN" || die "cloudflared ${v:-unknown} is older than the floor $GATE_CLOUDFLARED_MIN (VULN-170057 fix); set GATE_CLOUDFLARED"
}

_run_echo() { PORT="$GATE_ORIGIN_PORT" exec node "$GATES_DIR/origin/echo-origin.mjs"; }
_run_cloudflared() {
  TUNNEL_TOKEN="$FIX_TUNNEL_TOKEN" exec "$GATE_CLOUDFLARED" tunnel --no-autoupdate --loglevel debug \
    --metrics "127.0.0.1:${GATE_METRICS_PORT:-20241}" run
}

# machine_fixture_up <access: none|rule|tunnel> [rule originRequest JSON]
# Sets FIX_ZONE_ID FIX_POLICY_ID FIX_APP_ID FIX_AUD FIX_TUNNEL_ID; host = GATE_MACHINE_HOST.
machine_fixture_up() {
  local mode="$1" extra="${2:-}"
  require_env GATE_CF_ACCOUNT_ID GATE_STAGING_ZONE GATE_MACHINE_HOST GATE_TEAM GATE_OWNER_EMAIL
  [[ -d "$GATES_DIR/origin/node_modules" ]] || die "echo origin not installed: (cd tools/cloud-gates/origin && npm ci)"
  cloudflared_check
  FIX_ZONE_ID="$(zone_id_for "$GATE_STAGING_ZONE")"; [[ -n "$FIX_ZONE_ID" ]] || die "zone $GATE_STAGING_ZONE not found"
  FIX_POLICY_ID="" FIX_APP_ID="" FIX_AUD=""
  # D21 order: policy, Access app, tunnel, ingress, DNS.
  if [[ "$mode" != none ]]; then
    access_policy_create "$GATE_TAG-owner" "$GATE_OWNER_EMAIL" || die "policy create failed"
    FIX_POLICY_ID="$CREATED_ID"
    access_app_create "$GATE_TAG-machine" "$GATE_MACHINE_HOST" "$FIX_POLICY_ID" || die "Access app create failed"
    FIX_APP_ID="$CREATED_ID" FIX_AUD="$CREATED_AUD"
  fi
  tunnel_create "$GATE_TAG" || die "tunnel create failed"
  FIX_TUNNEL_ID="$CREATED_ID"
  tunnel_config_put "$FIX_TUNNEL_ID" "$(ingress_json "$GATE_MACHINE_HOST" "http://127.0.0.1:$GATE_ORIGIN_PORT" "$mode" "$GATE_TEAM" "$FIX_AUD" "$extra")" ||
    die "tunnel configuration failed"
  dns_cname_create "$FIX_ZONE_ID" "$GATE_MACHINE_HOST" "$FIX_TUNNEL_ID" || die "DNS create failed (does a record already exist at $GATE_MACHINE_HOST?)"
  FIX_TUNNEL_TOKEN="$(tunnel_token "$FIX_TUNNEL_ID")"; [[ -n "$FIX_TUNNEL_TOKEN" ]] || die "tunnel token fetch failed"
  bg_start echo-origin _run_echo
  bg_start cloudflared _run_cloudflared
  wait_until 60 curl -sf "http://127.0.0.1:${GATE_METRICS_PORT:-20241}/ready" || die "cloudflared never reported /ready (see cloudflared.txt)"
  wait_until 180 _edge_reachable || die "https://$GATE_MACHINE_HOST never became reachable through the edge"
  log "machine fixture up: tunnel $FIX_TUNNEL_ID, app ${FIX_APP_ID:-none}, access $mode"
}

_edge_reachable() { [[ "$(probe_status get "https://$GATE_MACHINE_HOST/echo")" =~ ^(200|302|403)$ ]]; }

# sweep: delete (or list) every gate-tagged resource older than N hours.
sweep() {
  local dry=0 hours=24 cutoff
  while (($#)); do case "$1" in --dry-run) dry=1 ;; --max-age-hours) hours="$2"; shift ;; *) die "sweep: unknown flag $1" ;; esac; shift; done
  require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN
  cutoff=$(($(date +%s) - hours * 3600))
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/access/apps" '.name' '.created_at'
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/access/policies" '.name' '.created_at'
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/access/service_tokens" '.name' '.created_at'
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/access/identity_providers" '.name' '.created_at'
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/cfd_tunnel?is_deleted=false" '.name' '.created_at'
  _sweep_kind "$dry" "$cutoff" "$(cf_acct)/workers/scripts" '.id' '.created_on' yaran-gate-
  if [[ -n "${GATE_STAGING_ZONE:-}" ]]; then
    local z; z="$(zone_id_for "$GATE_STAGING_ZONE")"
    [[ -n "$z" ]] && _sweep_kind "$dry" "$cutoff" "/zones/$z/dns_records?per_page=500" '(.comment // "")' '.created_on'
  fi
}

# select_stale <prefix> <cutoff epoch> <name filter> <time filter>: jq over a list response.
select_stale() {
  jq -r --arg p "$1" --argjson c "$2" '
    def ts: (. // "1970-01-01T00:00:00Z") | sub("[.][0-9]+"; "") | sub("[+]00:00$"; "Z") | fromdateiso8601;
    .result[]? | select(('"$3"') | tostring | startswith($p)) | select((('"$4"') | ts) < $c)
    | "\(.id)\t\('"$3"')"'
}

_sweep_kind() { # <dry> <cutoff> <list path> <name filter> <time filter> [prefix]
  local out id name base="${3%%\?*}"
  out="$(cf_api GET "$3")" || return 0
  select_stale "${6:-gate-}" "$2" "$4" "$5" <<<"$out" | while IFS=$'\t' read -r id name; do
    if (($1)); then printf 'would delete %s/%s (%s)\n' "$base" "$id" "$name"
    else
      [[ "$base" == */cfd_tunnel ]] && cf_api DELETE "$base/$id/connections" >/dev/null
      cf_api DELETE "$base/$id" >/dev/null && printf 'deleted %s/%s (%s)\n' "$base" "$id" "$name"
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  case "${1:-}" in
    sweep) shift; sweep "$@" ;;
    *) printf 'usage: %s sweep [--dry-run] [--max-age-hours N]\n' "$0" >&2; exit 2 ;;
  esac
fi

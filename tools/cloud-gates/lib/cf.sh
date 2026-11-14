#!/usr/bin/env bash
# Cloudflare API client for gate scripts: auth header, error envelope, jq access.
#
# `cf_api METHOD PATH [JSON]` calls api.cloudflare.com/client/v4 with the token
# named by `CF_TOKEN_VAR` (default GATE_CF_API_TOKEN), prints the response body,
# and returns 0 only when the envelope says `success: true`. Failures print a
# redacted one-line summary of the envelope's `errors` to stderr; the HTTP status
# of the last call is in `$CF_TMP/cf.status` (`cf_last_status`).
#
# - The token never reaches argv: curl reads its Authorization header from a
#   config on a process-substitution fd.
# - `CF_API_BASE` can point at a local stub; tests override `_cf_http` instead.
# - Account-scoped paths use `cf_acct` (GATE_CF_ACCOUNT_ID, or CF_ACCOUNT_VAR).
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/lib/cf.sh
# └── tools/cloud-gates/lib/common.sh
# External: none
#
# Used by:
# tools/cloud-gates/lib/cf.sh
# ├── tools/cloud-gates/g09-token-template.sh
# └── tools/cloud-gates/lib/access.sh
# <module-headers:end>

# shellcheck source=tools/cloud-gates/lib/common.sh
[[ -n "${GATES_DIR:-}" ]] || . "$(dirname "${BASH_SOURCE[0]}")/common.sh"

CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
CF_TOKEN_VAR="${CF_TOKEN_VAR:-GATE_CF_API_TOKEN}"
CF_ACCOUNT_VAR="${CF_ACCOUNT_VAR:-GATE_CF_ACCOUNT_ID}"
CF_TMP="${CF_TMP:-${RUN_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/cloud-gates-cf.XXXXXX")}}"

cf_acct() { printf '/accounts/%s' "${!CF_ACCOUNT_VAR:?set $CF_ACCOUNT_VAR}"; }
cf_last_status() { cat "$CF_TMP/cf.status" 2>/dev/null || printf '000'; }

# _cf_http <method> <url> <body-file|-> : prints body, writes status file.
_cf_http() {
  local m="$1" url="$2" body="$3" tok="${!CF_TOKEN_VAR:-}"
  [[ -n "$tok" ]] || { printf '{"success":false,"errors":[{"code":0,"message":"%s is not set"}]}' "$CF_TOKEN_VAR"; printf '000' >"$CF_TMP/cf.status"; return; }
  local -a a=(-sS -X "$m" -o "$CF_TMP/cf.body" -w '%{http_code}' -H 'Content-Type: application/json' --max-time 60)
  [[ "$body" != - ]] && a+=(--data-binary "@$body")
  curl "${a[@]}" -K <(printf 'header = "Authorization: Bearer %s"\n' "$tok") "$url" >"$CF_TMP/cf.status" 2>/dev/null ||
    printf '000' >"$CF_TMP/cf.status"
  cat "$CF_TMP/cf.body" 2>/dev/null || true
}

# cf_api <METHOD> <PATH> [JSON]: body on stdout; 0 iff success:true.
cf_api() {
  local m="$1" path="$2" bodyf=- out
  if [[ $# -ge 3 ]]; then bodyf="$CF_TMP/cf.req"; printf '%s' "$3" >"$bodyf"; fi
  out="$(_cf_http "$m" "$CF_API_BASE$path" "$bodyf")"
  printf '%s\n' "$out"
  if cf_ok "$out"; then return 0; fi
  printf '[%s] cf %s %s -> HTTP %s: %s\n' "${GATE:-gates}" "$m" "${path%%\?*}" "$(cf_last_status)" "$(cf_error_summary "$out")" | redact >&2
  return 1
}

cf_ok() { jq -e '.success == true' >/dev/null 2>&1 <<<"$1"; }

# cf_error_summary <json>: "[code] message; [code] message", or the raw head.
cf_error_summary() {
  local s
  s="$(jq -r '[(.errors // [])[] | "[\(.code // "?")] \(.message // "")"] | join("; ")' 2>/dev/null <<<"$1")" || s=""
  [[ -n "$s" ]] || s="non-envelope response: $(head -c 160 <<<"$1" | tr '\n' ' ')"
  printf '%s' "$s"
}

# cf_error_codes <json>: comma-separated error codes (for missing-permission tables).
cf_error_codes() { jq -r '[(.errors // [])[] | .code | tostring] | join(",")' 2>/dev/null <<<"$1"; }

# cf_get <PATH> <jq filter>: GET and extract; fails like cf_api.
cf_get() {
  local out; out="$(cf_api GET "$1")" || return 1
  jq -r "$2" <<<"$out"
}

# perm_group_id <name>: the permission group's id, resolved by API (G9's method),
# exact name match only.
perm_group_id() {
  local out
  out="$(cf_api GET "$(cf_acct)/tokens/permission_groups?name=$(jq -rn --arg n "$1" '$n | @uri')")" || return 1
  jq -r --arg n "$1" '[.result[]? | select(.name == $n)][0].id // empty' <<<"$out"
}

# token_template_url <token name> <permission group id>...: the account-owned
# token template link (dash.cloudflare.com/?to=/:account/api-tokens, ids as keys).
token_template_url() {
  local name="$1"; shift
  jq -rn --arg name "$name" '$ARGS.positional | map({key: .}) | tojson | @uri as $k
    | "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=\($k)&name=\($name | @uri)"' --args "$@"
}

# cf_probe <METHOD> <PATH> [JSON]: never fails; prints "status<TAB>codes" for tables.
cf_probe() {
  local out; out="$(cf_api "$@" 2>/dev/null)" || true
  printf '%s\t%s\n' "$(cf_last_status)" "$(cf_error_codes "$out")"
}

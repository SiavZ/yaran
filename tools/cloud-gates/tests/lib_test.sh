#!/usr/bin/env bash
# Offline tests for the gate libraries: JWT decoding, the Cloudflare error
# envelope, probe-line parsing, ingress placement, sweep selection, version
# comparison and the result writers (observations table and summary JSON).
#
# Everything runs against canned responses in tests/fixtures/ and a stubbed
# `_cf_http`, so no network and no credentials are involved. Evidence the
# result-writer tests produce goes to a mktemp tree, never the real one.
#
# - Each assertion prints ok/FAIL; the script exits 1 on any failure.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/tests/lib_test.sh
# ├── tools/cloud-gates/lib/common.sh
# ├── tools/cloud-gates/lib/access.sh
# └── tools/cloud-gates/lib/jwt.sh
# External: jq, base64
#
# Used by:
# tools/cloud-gates/tests/lib_test.sh
# └── entry point (bash tools/cloud-gates/tests/lib_test.sh; Phase 03 Validation)
# <module-headers:end>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FX="$HERE/fixtures"
TMP="$(mktemp -d)"
export GATES_EVIDENCE_ROOT="$TMP/evidence" CF_TMP="$TMP"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/../lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/../lib/access.sh"
# shellcheck source=tools/cloud-gates/lib/jwt.sh
. "$(dirname "$0")/../lib/jwt.sh"
fails=0
eq() { if [[ "$2" == "$3" ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n     expected: %s\n     observed: %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
b64u() { base64 | tr '+/' '-_' | tr -d '=\n'; }

# --- jwt.sh
tok="$(printf '{"alg":"RS256","kid":"k"}' | b64u).$(printf '{"aud":["a1","a2"],"exp":2000000180,"iat":2000000000,"type":"app"}' | b64u).c2ln"
eq "jwt header alg" RS256 "$(jwt_header "$tok" | jq -r .alg)"
eq "jwt claim array joined" "a1,a2" "$(jwt_claim "$tok" aud)"
eq "jwt lifetime" 180 "$(jwt_lifetime "$tok")"
eq "jwt missing claim is empty" "" "$(jwt_claim "$tok" email)"
jwt_shape_ok "$tok" && eq "jwt shape ok" yes yes || eq "jwt shape ok" yes no
jwt_shape_ok "garbage.value.x" && eq "garbage rejected" no yes || eq "garbage rejected" no no
jwt_is_expired "$tok" 2000000181 && eq "expired after exp" yes yes || eq "expired after exp" yes no
jwt_is_expired "$tok" 2000000100 && eq "live before exp" no yes || eq "live before exp" no no
eq "b64url 2-pad" '{"a":1}' "$(b64url_decode "$(printf '{"a":1}' | b64u)")"

# --- cf.sh envelope
eq "error summary" "[10000] Authentication error; [9109] Unauthorized to access requested resource" "$(cf_error_summary "$(cat "$FX/cf-error-403.json")")"
eq "error codes" "10000,9109" "$(cf_error_codes "$(cat "$FX/cf-error-403.json")")"
eq "non-envelope summary" "non-envelope response: <html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html> " "$(cf_error_summary "$(cat "$FX/cf-nonjson.txt")")"
cf_ok "$(cat "$FX/cf-ok-tunnel.json")" && eq "cf_ok true" yes yes || eq "cf_ok true" yes no
cf_ok "$(cat "$FX/cf-error-403.json")" && eq "cf_ok false" no yes || eq "cf_ok false" no no

# Stub the transport: replay a fixture and a status, record what was asked.
_cf_http() { printf '%s %s\n' "$1" "$2" >"$TMP/asked"; printf '%s' "$STUB_STATUS" >"$CF_TMP/cf.status"; cat "$STUB_BODY"; }
GATE_CF_API_TOKEN=x GATE_CF_ACCOUNT_ID=acc1
STUB_BODY="$FX/cf-ok-tunnel.json" STUB_STATUS=200
eq "cf_get extracts" "5a1b2c3d-0000-4000-8000-00000000abcd" "$(cf_get "$(cf_acct)/cfd_tunnel/x" .result.id)"
eq "cf_api path" "GET https://api.cloudflare.com/client/v4/accounts/acc1/cfd_tunnel/x" "$(cat "$TMP/asked")"
STUB_BODY="$FX/cf-error-403.json" STUB_STATUS=403
if cf_api GET /zones >/dev/null 2>"$TMP/err"; then eq "cf_api fails on error" 1 0; else eq "cf_api fails on error" 1 1; fi
eq "cf_api status" 403 "$(cf_last_status)"
grep -q 'HTTP 403: \[10000\]' "$TMP/err" && eq "cf_api error line" yes yes || eq "cf_api error line" yes "$(cat "$TMP/err")"
eq "cf_probe line" "$(printf '403\t10000,9109')" "$(cf_probe GET /zones)"

# --- token template URL and permission-group resolution (G9, G14)
eq "template URL" 'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22aaaa%22%7D%2C%7B%22key%22%3A%22bbbb%22%7D%5D&name=yaran%20control%20plane' \
  "$(token_template_url "yaran control plane" aaaa bbbb)"
printf '{"success":true,"errors":[],"result":[{"id":"x1","name":"DNS Write Extra"},{"id":"e086","name":"DNS Write"}]}' >"$TMP/pg.json"
STUB_BODY="$TMP/pg.json" STUB_STATUS=200
eq "perm group exact-name match" e086 "$(perm_group_id "DNS Write")"
eq "perm group name is URL-encoded" "GET https://api.cloudflare.com/client/v4/accounts/acc1/tokens/permission_groups?name=DNS%20Write" "$(cat "$TMP/asked")"
eq "perm group unknown name is empty" "" "$(perm_group_id "Nope")"

# --- probe parsing
eq "probe 302" "$(printf '302\thttps://team.cloudflareaccess.com/cdn-cgi/access/login/gate-m1.example.invalid\ttext/html\t-\t-')" \
  "$(parse_probe_head "$FX/probe-302.head" /dev/null)"
eq "probe 101" "$(printf '101\t\t-\t-\t-')" "$(parse_probe_head "$FX/probe-101.head" /dev/null)"
eq "probe 401" "$(printf '401\t\tapplication/json\tBearer resource_metadata="https://gate-m1.example.invalid/.well-known/oauth-protected-resource"\t{"error":"unauthorized"} ')" \
  "$(parse_probe_head "$FX/probe-401.head" "$FX/probe-401.body")"
: >"$TMP/empty"
eq "probe no response" "$(printf '000\t\t-\t-\t-')" "$(parse_probe_head "$TMP/empty" "$TMP/empty")"

# --- ingress placement (G2 step 7 vs step 8)
rule="$(ingress_json h.example.invalid http://127.0.0.1:3890 rule team AUD)"
eq "per-rule access on the rule" '{"required":true,"teamName":"team","audTag":["AUD"]}' "$(jq -c '.config.ingress[0].originRequest.access' <<<"$rule")"
eq "per-rule: tunnel-level empty" '{}' "$(jq -c '.config.originRequest' <<<"$rule")"
eq "catch-all last" http_status:404 "$(jq -r '.config.ingress[1].service' <<<"$rule")"
tun="$(ingress_json h.example.invalid http://127.0.0.1:3890 tunnel team AUD)"
eq "tunnel-level access only" 'null|{"required":true,"teamName":"team","audTag":["AUD"]}' \
  "$(jq -c '.config.ingress[0].originRequest.access' <<<"$tun")|$(jq -c '.config.originRequest.access' <<<"$tun")"
extra="$(ingress_json h.example.invalid http://127.0.0.1:3890 none "" "" '{"httpHostHeader":"localhost:3890"}')"
eq "extra originRequest kept" '{"httpHostHeader":"localhost:3890"}' "$(jq -c '.config.ingress[0].originRequest' <<<"$extra")"

# --- sweep selection (cutoff 2026-11-14T00:00:00Z)
cutoff="$(jq -n '"2026-11-14T00:00:00Z" | fromdateiso8601')"
eq "stale gate apps only" "$(printf 'app-old\tgate-g01-11130900aaaa-machine\napp-offset\tgate-g08-11120000cccc-cp')" \
  "$(select_stale gate- "$cutoff" .name .created_at <"$FX/cf-list-apps.json")"

# --- version comparison
version_ge 2026.11.0 2026.11.0 && eq "version equal" yes yes || eq "version equal" yes no
version_ge 2026.11.1 2026.11.0 && eq "version newer" yes yes || eq "version newer" yes no
version_ge 2026.9.2 2026.11.0 && eq "version older" no yes || eq "version older" no no
version_ge 2027.1.0 2026.11.0 && eq "version next year" yes yes || eq "version next year" yes no

# --- result writers, in a subshell so gate_init's EXIT trap fires there
(
  gate_init G99 selftest >/dev/null 2>&1
  check "status is 302" 302 302 2>/dev/null
  check "location host" 're:^https://[a-z]+\.cloudflareaccess\.com' "https://team.cloudflareaccess.com/x" 2>/dev/null
  check "binding cookie refused" 302 200 2>/dev/null
  observe "Set-Cookie SameSite" None 2>/dev/null
  skip "device run" "no device" 2>/dev/null
  observe "pipe | in value" "a|b" 2>/dev/null
) >"$TMP/selftest.out" 2>&1 && rc=0 || rc=$?
eq "unmet criterion exits 1" 1 "$rc"
run_dir="$(ls -d "$TMP"/evidence/G99-selftest/run-*)"
sum="$run_dir/summary.json"
eq "summary counts" '{"gate":"G99","met":2,"unmet":1,"skipped":1,"ok":false,"exit_code":1}' \
  "$(jq -c '{gate, met, unmet, skipped, ok, exit_code}' "$sum")"
eq "summary printed" 1 "$(grep -c '^summary: {' "$TMP/selftest.out")"
eq "observations rows" 6 "$(($(wc -l <"$run_dir/observations.tsv") - 1))"
eq "markdown unmet row" '| binding cookie refused | 302 | 200 | UNMET |' "$(grep 'binding cookie' "$run_dir/observations.md")"
eq "markdown escapes pipes" '| pipe \| in value | - | a\|b | observed |' "$(grep 'pipe' "$run_dir/observations.md")"

# --- header_file is owner-only
RUN_TMP="$TMP"
hf="$(header_file t 'Cookie: CF_Authorization=x')"
eq "header file mode" 600 "$(stat -f %Lp "$hf" 2>/dev/null || stat -c %a "$hf")"

rm -rf "$TMP"
((fails == 0)) && printf 'lib_test: all passed\n' || { printf 'lib_test: %d failed\n' "$fails"; exit 1; }

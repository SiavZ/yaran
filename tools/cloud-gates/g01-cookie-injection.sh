#!/usr/bin/env bash
# G01 — An injected CF_Authorization cookie is accepted by Access for HTTP and WebSocket (curl half + device checklist).
#
# Provisions the machine fixture with an owner-only reusable policy, binding
# cookie off and per-rule `originRequest.access` (G2's shape), then: compares
# the Cf-Access-Jwt-Assertion header and the CF_Authorization cookie the origin
# received for a browser sign-in (by SHA-256, from values the operator pastes),
# records the Set-Cookie attributes Access set, and measures GET / and a
# WebSocket upgrade for no credentials, cookie = header JWT, cookie = cookie
# JWT, `cf-access-token`, and binding cookie switched on. Step 6 repeats the
# matrix against yaran in tools/preview-env when GATE_YARAN_PORT is set. The
# device half (spike machine-view on Android WebView and WKWebView) is printed
# as a checklist and its observations are entered at the prompts.
#
# - JWTs are pasted at hidden prompts and travel to curl in owner-only header
#   files; the evidence keeps only redacted summaries and hashes.
# - Prerequisites: G02's list plus a desktop browser for the operator sign-in.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g01-cookie-injection.sh
# ├── tools/cloud-gates/lib/common.sh
# ├── tools/cloud-gates/lib/access.sh
# └── tools/cloud-gates/lib/jwt.sh
# External: cloudflared, curl, jq, node
#
# Used by:
# tools/cloud-gates/g01-cookie-injection.sh
# └── entry point (tools/cloud-gates/run.sh G01)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"
# shellcheck source=tools/cloud-gates/lib/jwt.sh
. "$(dirname "$0")/lib/jwt.sh"

gate_init G01 cookie-injection
is_recheck && die "G01 needs an operator sign-in and devices; it is not part of --recheck"
require_tty
require_env "${FIXTURE_ENV[@]}"
H="$GATE_MACHINE_HOST"

# cookie_attrs <Set-Cookie line>: the attribute list with the value dropped.
cookie_attrs() { printf '%s' "${1#*:}" | tr ';' '\n' | tail -n +2 | sed 's/^ *//' | paste -sd ';' -; }

step "1-2: tunnel + Access app (binding cookie off, owner-only policy) + per-rule access"
machine_fixture_up rule
observe "Access app" "$FIX_APP_ID (aud $FIX_AUD)"

step "3: browser sign-in; header JWT versus cookie JWT"
log "Sign in at https://$H/echo in a desktop browser as $GATE_OWNER_EMAIL."
log "The page shows the Cf-Access-Jwt-Assertion header and the CF_Authorization cookie the origin received."
obtain_jwt HDR_JWT "$H" "paste the Cf-Access-Jwt-Assertion value from the echo page" || die "no header JWT supplied"
read_secret COOKIE_JWT "paste the CF_Authorization cookie value from the echo page" || die "no cookie JWT supplied"
jwt_shape_ok "$HDR_JWT" || die "the header value is not a JWT"
h1="sha256:$(printf '%s' "$HDR_JWT" | sha256_hex)"; h2="sha256:$(printf '%s' "$COOKIE_JWT" | sha256_hex)"
observe "header JWT" "$h1 $(printf '%s' "$HDR_JWT" | redact)"
observe "cookie JWT" "$h2 $(printf '%s' "$COOKIE_JWT" | redact)"
SAME=no; [[ "$h1" == "$h2" ]] && SAME=yes
observe "header and cookie byte-identical" "$SAME"
observe "header JWT claims" "$(jwt_claims "$HDR_JWT" | jq -c '{aud, iss, type, lifetime:(.exp - .iat), has_email:(.email != null)}')"

step "4: Set-Cookie attributes from the /cdn-cgi/access/authorized hop"
log "In the browser devtools (Network, preserve log), find the /cdn-cgi/access/authorized response on $H."
if read_secret SETCOOKIE "paste its full Set-Cookie header line for CF_Authorization"; then
  observe "Set-Cookie attributes (value dropped)" "$(cookie_attrs "$SETCOOKIE")"
else skip "Set-Cookie attributes" "not supplied"; fi
pause "Save a redacted HAR excerpt of that hop into ${EVIDENCE_DIR#"$REPO_ROOT"/}/ (pipe it through lib/redact.sh first)"

step "5: GET / and WebSocket upgrade per credential"
matrix() { # <label> <expect-get> <expect-ws> [header-file]
  local g w
  g="$(probe nav "https://$H/" "${4:-/dev/null}")"; w="$(probe ws "https://$H/ws" "${4:-/dev/null}")"
  printf '%s\tGET\t%s\n%s\tWS\t%s\n' "$1" "$g" "$1" "$w" | record matrix
  check "$1: GET /" "$2" "$(cut -f1 <<<"$g")"
  check "$1: WS upgrade" "$3" "$(cut -f1 <<<"$w")"
  [[ "$2" == 302 ]] && check "$1: redirect goes to the team domain" "re:^https://$GATE_TEAM\.cloudflareaccess\.com/" "$(cut -f2 <<<"$g")"
  return 0
}
matrix "no credentials" 302 302
matrix "cookie = header JWT" 200 101 "$(header_file c1 "Cookie: CF_Authorization=$HDR_JWT")"
if [[ "$SAME" == no ]]; then
  matrix "cookie = cookie JWT" 200 101 "$(header_file c2 "Cookie: CF_Authorization=$COOKIE_JWT")"
fi
matrix "cf-access-token header" 200 101 "$(header_file c3 "cf-access-token: $HDR_JWT")"
ws="$(node "$HERE/origin/ws-probe.mjs" "wss://$H/ws" --headers-file "$(header_file c4 "Cookie: CF_Authorization=$HDR_JWT")" || true)"
printf '%s\n' "$ws" | record ws
check "injected cookie: WebSocket frames stream" true "$(jq -r .echoed <<<"$ws")"

step "5b: binding cookie on (D2 says off is load-bearing)"
access_app_update "$FIX_APP_ID" '{"enable_binding_cookie":true}' || die "could not enable the binding cookie"
sleep 20
matrix "binding cookie on, injected cookie" 302 302 "$(header_file c5 "Cookie: CF_Authorization=$HDR_JWT")"
access_app_update "$FIX_APP_ID" '{"enable_binding_cookie":false}' || die "could not disable the binding cookie"

step "6: the same matrix against yaran (tools/preview-env)"
if [[ -n "${GATE_YARAN_PORT:-}" ]]; then
  tunnel_config_put "$FIX_TUNNEL_ID" "$(ingress_json "$H" "http://127.0.0.1:$GATE_YARAN_PORT" rule "$GATE_TEAM" "$FIX_AUD")" || die "re-pointing the tunnel failed"
  pause "preview-env must allow Host $H for the gate (--bind/allowed_hosts); wait ~30 s for cloudflared to reload"
  ck="$(header_file y1 "Cookie: CF_Authorization=$HDR_JWT" "Origin: https://$H")"
  check "yaran: bootstrap with injected cookie" 200 "$(probe_status fetch "https://$H/api/v1/bootstrap" "$ck")"
  check "yaran: /ws/events upgrade with injected cookie" 101 "$(probe_status ws "https://$H/ws/events" "$ck")"
  if ask GATE_YARAN_PTY_ID "a live pty id in preview-env (empty to skip)"; then
    check "yaran: PTY socket upgrade with injected cookie" 101 "$(probe_status ws "https://$H/ws/sessions/$GATE_YARAN_PTY_ID/pty" "$ck")"
  else skip "yaran: PTY socket" "no pty id"; fi
else skip "yaran matrix" "GATE_YARAN_PORT unset"; fi

step "device half"
checklist "G01 machine-view cookie injection (spikes/mobile)" <<EOF
Run on: Android 15/16 emulator (WebView >= M144: adb shell dumpsys webviewupdate), the GrapheneOS
Pixel (Vanadium WebView), iOS 17.4 and latest simulators, and a physical iPhone.
1. Build and install tools/cloud-gates/spikes/mobile (tools/cloud-gates/README.md, "Mobile spike"). Open "Machine view".
2. Paste a fresh header JWT for $H into the debug paste field (never a deep link).
   SameSite: use the attribute recorded in step 4 above.
3. Load https://$H/ (the yaran UI when step 6 ran, else /echo) and record:
   - the first request's Cookie (cloudflared.txt / echo-origin.txt here show hashes only);
   - HTML navigation 200; fetch('/api/v1/bootstrap') 200;
   - /ws/events and the PTY socket reach 101 and stream.
4. Repeat with no cookie: the WebView lands on $GATE_TEAM.cloudflareaccess.com.
EOF
for dev in "Android emulator" "GrapheneOS Pixel" "iOS 17.4 simulator" "latest iOS simulator" "physical iPhone"; do
  confirm_check "$dev: navigation 200, XHR 200, events 101, PTY 101 streaming with injected cookie" "$dev: did all four succeed?"
done

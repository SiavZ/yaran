#!/usr/bin/env bash
# G13 — Verified https callback (ASWebAuthenticationSession .https, Android App Link with Auth Tab / Custom Tab) and the dev-build custom scheme.
#
# Deploys `workers/callback-probe` on <gate-callback-host> (the stand-in for
# <publisher-domain>, D16), serving assetlinks.json and
# apple-app-site-association generated from settings, and on <cp-host>, where
# it serves the handoff-shaped consent page (02 §8 parameters) whose POST
# answers 303 to the callback with `state` and a dummy `jwe`, or
# `error=handoff_declined`. Consent and callback sit on different hosts so the
# redirect is cross-origin, as in production. The HTTP half (association files,
# allowlist, 303 shapes, CSP form-action) is checked here; the device half
# (iOS 17.4 and latest, Android emulator, GrapheneOS Pixel, stock Android, each
# browser, and the hijack APK) is a checklist with prompts.
#
# - Never commits a team id or certificate: GATE_APPLE_APP_ID and
#   GATE_ANDROID_CERT_SHA256 are passed to the Worker as vars at deploy time.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g13-system-browser-auth.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/access.sh
# External: curl, jq, npx (wrangler)
#
# Used by:
# tools/cloud-gates/g13-system-browser-auth.sh
# └── entry point (tools/cloud-gates/run.sh G13)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"

gate_init G13 system-browser-auth
is_recheck && die "G13 needs devices; it is not part of --recheck"
require_tty
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN GATE_STAGING_ZONE GATE_CALLBACK_HOST GATE_CP_HOST GATE_APPLE_APP_ID GATE_ANDROID_CERT_SHA256
CB="$GATE_CALLBACK_HOST" CP="$GATE_CP_HOST"
PKG="${GATE_SPIKE_PACKAGE:-io.github.siavz.yaran.gatespike}"
NAME="yaran-gate-callback-probe-$RUN_ID"
ZONE_ID="$(zone_id_for "$GATE_STAGING_ZONE")"; [[ -n "$ZONE_ID" ]] || die "zone $GATE_STAGING_ZONE not found"

step "deploy the callback probe on $CB and $CP"
worker_deploy "$HERE/workers/callback-probe" "$NAME" --var "CALLBACK_HOST:$CB" --var "ANDROID_PACKAGE:$PKG" \
  --var "ANDROID_CERT_SHA256:$GATE_ANDROID_CERT_SHA256" --var "APPLE_APP_ID:$GATE_APPLE_APP_ID" --var "DEV_SCHEME:yaranapp-gate" ||
  die "wrangler deploy failed (see wrangler.txt)"
worker_domain_attach "$CB" "$NAME" "$ZONE_ID" || die "attaching $CB failed"
worker_domain_attach "$CP" "$NAME" "$ZONE_ID" || die "attaching $CP failed (is G08's probe still on it?)"
wait_until 600 curl -sf --max-time 10 "https://$CB/.well-known/assetlinks.json" || die "https://$CB never served"

step "association files"
for f in assetlinks.json apple-app-site-association; do
  curl -sS --max-time 10 -o "$RUN_TMP/$f" -D "$RUN_TMP/$f.h" "https://$CB/.well-known/$f"
  line="$(parse_probe_head "$RUN_TMP/$f.h" /dev/null)"
  check "$f: 200 without redirect" 200 "$(cut -f1 <<<"$line")"
  check "$f: application/json" 're:^application/json' "$(cut -f3 <<<"$line")"
  jq . "$RUN_TMP/$f" | record "$f"
done
check "assetlinks names the spike package" "$PKG" "$(jq -r '.[0].target.package_name' "$RUN_TMP/assetlinks.json")"
check "AASA covers /auth/callback for the app id" yes \
  "$(jq -r --arg a "$GATE_APPLE_APP_ID" '[.applinks.details[] | select(.appIDs | index($a)) | .components[]."/"] | if index("/auth/callback") then "yes" else "no" end' "$RUN_TMP/apple-app-site-association")"
check "AASA webcredentials lists the app id" yes "$(jq -r --arg a "$GATE_APPLE_APP_ID" 'if (.webcredentials.apps | index($a)) then "yes" else "no" end' "$RUN_TMP/apple-app-site-association")"

step "consent page and 303 shapes"
STATE="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
REL="https://$CB/auth/callback"
q() { printf 'state=%s&redirect=%s&build=%s&device=%s' "$STATE" "$(jq -rn --arg r "$1" '$r|@uri')" "$2" "gate%20phone"; }
curl -sS --max-time 10 -o "$RUN_TMP/c.html" -D "$RUN_TMP/c.h" "https://$CP/v1/handoff?$(q "$REL" release)"
check "consent GET (release) answers 200" 200 "$(cut -f1 <<<"$(parse_probe_head "$RUN_TMP/c.h" /dev/null)")"
check "consent CSP form-action names the callback origin" "re:form-action 'self' https://$CB" "$(grep -i '^content-security-policy:' "$RUN_TMP/c.h" | tr -d '\r')"
check "consent Referrer-Policy same-origin" "re:same-origin" "$(grep -i '^referrer-policy:' "$RUN_TMP/c.h" | tr -d '\r')"
check "consent refuses a redirect off the allowlist" 400 "$(curl -s -o /dev/null -w '%{http_code}' "https://$CP/v1/handoff?$(q https://evil.example.invalid/auth/callback release)")"
post() { curl -s -o /dev/null -D - --max-time 10 --data "$(q "$1" "$2")&decision=$3" "https://$CP/v1/handoff" | tr -d '\r'; }
h="$(post "$REL" release continue)"
check "continue: 303" 303 "$(awk 'toupper($1) ~ /^HTTP\// {print $2}' <<<"$h" | tail -1)"
check "continue: Location is the https callback with state and jwe" "re:^location: https://$CB/auth/callback\?state=$STATE&jwe=" "$(grep -i '^location:' <<<"$h")"
h="$(post "$REL" release cancel)"
check "cancel: error=handoff_declined" "re:error=handoff_declined" "$(grep -i '^location:' <<<"$h")"
h="$(post yaranapp-gate://auth/callback dev continue)"
check "dev build: custom scheme callback" "re:^location: yaranapp-gate://auth/callback\?state=" "$(grep -i '^location:' <<<"$h")"

step "device half"
checklist "G13 system-browser auth (spikes/mobile AuthSpike + hijack module)" <<EOF
Build the spike with -PgateCallbackHost=$CB (Android) / GATE_CALLBACK_HOST=$CB (iOS); in AuthSpike
paste consent host $CP. Release-shaped run: callback $REL. Dev-shaped run: yaranapp-gate://auth/callback.
Android (emulator with Chrome >= 137, GrapheneOS Pixel with Vanadium and Chrome, a stock device, Firefox):
  1. adb shell pm get-app-links $PKG  -> record the verification state for $CB.
  2. AuthSpike logs isAuthTabSupported per default browser.
  3. Run release (Auth Tab, https redirect) and dev (redirectScheme). Record whether the result came
     as RESULT_OK or via the App Link / intent-filter Activity. Repeat with ephemeral browsing on.
  4. Install the hijack APK (android/hijack): run both modes again; record which app receives each.
  5. Press Cancel on the consent page: the app must see error=handoff_declined.
iOS (17.4 and latest; simulator and device):
  6. ASWebAuthenticationSession Callback.https (release) and .customScheme (dev): record the completion URL
     (parameter names only), cancel (canceledLogin), and the nil presentation-context error.
  7. Build once WITHOUT webcredentials:$CB in the entitlements; record the error.
  8. prefersEphemeralWebBrowserSession false: a second run reuses the IdP session; true: it does not.
EOF
for dev in "Android emulator" "GrapheneOS Pixel" "stock Android"; do
  ask APPLINK_STATE "$dev: pm get-app-links state for $CB" || { skip "$dev" "not run"; continue; }
  [[ "$dev" != "GrapheneOS Pixel" ]] && check "$dev: App Link verified" re:verified "$APPLINK_STATE"
  unset APPLINK_STATE
  confirm_check "$dev: release https callback reaches the spike in every browser listed" "release callback reached the spike?"
  confirm_check "$dev: hijack APK never receives the https callback" "hijack never got the https callback?"
  ask AUTHTAB_TABLE "$dev: per-browser isAuthTabSupported and delivery path (free text)" || true; unset AUTHTAB_TABLE
  ask CUSTOM_SCHEME_EXPOSURE "$dev: who received the custom-scheme callback on the Custom Tab fallback" || true; unset CUSTOM_SCHEME_EXPOSURE
done
for dev in "iOS 17.4" "iOS latest"; do
  confirm_check "$dev: Callback.https completes in the starting app" "https callback completed?"
  confirm_check "$dev: cancel detectable (canceledLogin) and consent Cancel yields handoff_declined" "cancel paths seen?"
  ask WEBCRED_ERROR "$dev: error without webcredentials: (or 'none')" || true; unset WEBCRED_ERROR
done
confirm_check "dev-shaped custom-scheme path works on every platform" "custom scheme worked?"

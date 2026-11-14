#!/usr/bin/env bash
# G05 — The Play build's embedded FCM distributor accepts standard VAPID Web Push with no publisher FCM credentials.
#
# Mints a VAPID key pair, has the operator register the spike app's `play`
# flavor (UnifiedPush connector 3.3.5 + embedded-fcm-distributor 3.1.0, no
# google-services.json) with its public key, then sends standard Web Push
# (RFC 8030/8291/8292) to the resulting `fcm.googleapis.com` endpoint with the
# `web-push` library: a normal send, a send signed with a different VAPID key
# (negative control), a high-urgency send under forced Doze, and a send after
# `am force-stop`. A device with no Play Services must fail registration
# cleanly. Delivery is observed on the device and entered at the prompts.
#
# - Subscription values and VAPID keys stay in this shell and reach the sender
#   through its environment only; the evidence keeps redacted forms.
# - adb steps run when GATE_ADB_SERIAL is set (for the shared GrapheneOS phone,
#   use the repo user's phone-testing workflow to get a serial), else they are
#   printed as checklist steps.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g05-embedded-fcm.sh
# └── tools/cloud-gates/lib/common.sh
# External: none
#
# Used by: entry point (tools/cloud-gates/run.sh G<NN>; G02, G03, G08, G09, G12 and G14 also via run.sh --recheck)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"

gate_init G05 embedded-fcm
is_recheck && die "G05 needs devices; it is not part of --recheck"
require_tty
require_cmd node
[[ -d "$HERE/origin/node_modules/web-push" ]] || die "web-push not installed: (cd tools/cloud-gates/origin && npm ci)"
PKG="${GATE_SPIKE_PACKAGE:-io.github.siavz.yaran.gatespike}"

keys() { node "$HERE/origin/webpush-send.mjs" --generate; }
K1="$(keys)"; K2="$(keys)"
V1_PUB="$(jq -r .publicKey <<<"$K1")"; V1_PRIV="$(jq -r .privateKey <<<"$K1")"
V2_PUB="$(jq -r .publicKey <<<"$K2")"; V2_PRIV="$(jq -r .privateKey <<<"$K2")"
observe "VAPID public key for the spike (not secret)" "$V1_PUB"

# push <label> <pub> <priv> [urgency]: one send; prints the sender's JSON.
push() {
  WP_ENDPOINT="$EP" WP_P256DH="$P256" WP_AUTH="$AUTH" WP_VAPID_PUBLIC="$2" WP_VAPID_PRIVATE="$3" \
    WP_URGENCY="${4:-high}" WP_PAYLOAD="{\"t\":\"gate\",\"case\":\"$1\"}" \
    node "$HERE/origin/webpush-send.mjs" 2>&1 | tail -1 || true
}
adbs() { if [[ -n "${GATE_ADB_SERIAL:-}" ]]; then adb -s "$GATE_ADB_SERIAL" shell "$@" 2>&1 | record adb; else log "run on the device: adb shell $*"; pause "done"; fi; }

checklist "G05 registration (play flavor)" <<EOF
Devices: the google_apis_playstore emulator, the GrapheneOS Pixel with sandboxed Google Play, and a
device with no Play Services.
1. Build and install the spike's play flavor (tools/cloud-gates/spikes/mobile; assemblePlayDebug).
2. Open "Push", paste the VAPID public key above, press Register.
3. Copy the endpoint, p256dh and auth from the debug screen when this script asks for them.
4. On the device with no Play Services, Register must show a clear error: note its text.
EOF

for dev in "Play emulator" "GrapheneOS sandboxed Play"; do
  step "$dev"
  unset EP P256 AUTH
  read_secret EP "$dev: endpoint" || { skip "$dev" "no endpoint supplied"; continue; }
  read_secret P256 "$dev: p256dh" || die "p256dh is required"
  read_secret AUTH "$dev: auth" || die "auth is required"
  observe "$dev: endpoint host" "$(sed -E 's#^(https://[^/]+)/.*#\1#' <<<"$EP")"
  r="$(push normal "$V1_PUB" "$V1_PRIV")"; printf '%s normal: %s\n' "$dev" "$r" | record sends
  check "$dev: send accepted" 201 "$(jq -r .statusCode <<<"$r" 2>/dev/null || echo error)"
  confirm_check "$dev: payload decrypted in onMessage" "did the spike log the decrypted payload {\"t\":\"gate\",\"case\":\"normal\"}?"
  r="$(push wrong-key "$V2_PUB" "$V2_PRIV")"; printf '%s wrong key: %s\n' "$dev" "$r" | record sends
  check "$dev: different VAPID key refused" 're:^4[0-9][0-9]$' "$(jq -r .statusCode <<<"$r" 2>/dev/null || echo error)"
  adbs dumpsys deviceidle force-idle
  r="$(push doze "$V1_PUB" "$V1_PRIV" high)"; printf '%s doze: %s\n' "$dev" "$r" | record sends
  confirm_check "$dev: high-urgency push delivered in forced Doze" "did the doze push arrive?"
  adbs dumpsys deviceidle unforce
  adbs am force-stop "$PKG"
  r="$(push force-stopped "$V1_PUB" "$V1_PRIV")"; printf '%s force-stop: %s\n' "$dev" "$r" | record sends
  ask DELIVERED_AFTER_STOP "$dev: delivered after am force-stop? (expected no)" || true
  unset DELIVERED_AFTER_STOP
done

step "device without Play Services"
confirm_check "no Play Services: registration reports a clear error" "did registration fail with a clear error?"
ask NOPLAY_ERROR "the error text shown" || true

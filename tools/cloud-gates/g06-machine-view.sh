#!/usr/bin/env bash
# G06 — A Capacitor app hosts a separate in-process native WebView with no bridge: cookie injection, file chooser, IME and insets, keyboard.
#
# Stands up the machine fixture so the echo origin's `/g6` test page (bridge
# detection, cookie echo, both file pickers, a bottom-anchored textarea, a live
# visualViewport/innerHeight/safe-area log, yaran's own viewport meta, and a
# `?variant=no-interactive-widget` contrast page) is reachable at
# https://<machine-host>/g6 behind Access, prints the device checklist for the
# spike's MachineViewSpike, and records each pass criterion per device from the
# operator's answers. The echo origin's own log (echo-origin.txt) shows the
# first request's cookie names and upload byte counts.
#
# - The yaran-UI half (compose bar, terminal-key row, rotation, file drop to
#   /api/v1/file-drop) needs yaran behind the gate tunnel: see G01 step 6.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g06-machine-view.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/access.sh
# External: cloudflared, curl, jq, node
#
# Used by:
# tools/cloud-gates/g06-machine-view.sh
# └── entry point (tools/cloud-gates/run.sh G06)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"

gate_init G06 machine-view
is_recheck && die "G06 needs devices; it is not part of --recheck"
require_tty
require_env "${FIXTURE_ENV[@]}"
H="$GATE_MACHINE_HOST"
machine_fixture_up rule

checklist "G06 machine-view (spikes/mobile MachineViewSpike)" <<EOF
Devices: Android 15/16 at targetSdk 36 with WebView >= M144; one WebView at M13x (check with
adb shell dumpsys webviewupdate); the GrapheneOS Pixel; iOS 17.4, 18 and 26; iPad split view.
Get a header JWT for $H by signing in at https://$H/echo in a desktop browser (G01 step 3).
1. In the spike, open Machine view with URL https://$H/g6 and paste the JWT.
2. Page shows typeof Capacitor and typeof androidBridge: both must read "undefined".
3. The cookie echo lists CF_Authorization on the FIRST request (echo-origin.txt here confirms).
4. Pick a file with <input type=file multiple> and with the camera-capture input: both open and
   the upload count appears. Repeat with the fileChooser=native extra on Android (the fallback).
5. Tap the bottom textarea: it stays visible above the keyboard, the first tap focuses it
   (the M139 caveat), and the log shows visualViewport.height shrinking.
6. Safe-area insets in the log are non-zero on devices with a notch / gesture bar.
7. Repeat 5 with https://$H/g6?variant=no-interactive-widget and note any difference.
8. Then load the real yaran UI the same way (G01 step 6 tunnel): compose bar with the soft keyboard,
   terminal-key row visibility, rotation, and a file picked into /api/v1/file-drop.
EOF

DEVICES=("Android 15/16 WebView >= M144" "Android WebView M13x" "GrapheneOS Pixel" "iOS 17.4" "iOS 18" "iOS 26" "iPad split view")
for dev in "${DEVICES[@]}"; do
  step "$dev"
  ask WV_VERSION "$dev: WebView / OS version" || { skip "$dev" "not run"; unset WV_VERSION; continue; }
  unset WV_VERSION
  confirm_check "$dev: bridge absent (Capacitor and androidBridge undefined)" "bridge absent?"
  confirm_check "$dev: cookie present on the first request" "cookie on the first request?"
  confirm_check "$dev: both pickers open and upload" "both pickers opened and uploaded?"
  confirm_check "$dev: textarea and compose bar stay above the keyboard" "textarea/compose bar visible above the keyboard?"
  confirm_check "$dev: safe-area insets non-zero where the device has them" "insets non-zero (or device has none)?"
  confirm_check "$dev: no focus lost on the first tap" "first tap focused?"
  ask VARIANT_DIFF "$dev: difference with no-interactive-widget (free text)" || true
  unset VARIANT_DIFF
done

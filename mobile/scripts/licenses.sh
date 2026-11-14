#!/usr/bin/env bash
# License list generator for the phone app (Phase 14 work item 13).
#
# Writes mobile/app/src/generated/licenses/{js,android-foss,android-play,ios}.json, which the
# About and licenses screen renders and which are committed (marked @generated):
#   js            packages actually bundled into the shell (mobile/app/scripts/bundleLicenses.mjs)
#   android-*     AboutLibraries exportLibraryDefinitions per flavor (foss must not list FCM)
#   ios           remote Swift packages from the manifests (mobile/scripts/ios-licenses.mjs)
#
# - `--check` regenerates into a temp dir and fails on any drift; Phase 18 runs it in CI.
# - Needs mobile/app/node_modules (npm ci) and, for the Android lists, the Android SDK.
#
# <module-headers:begin>
# Uses: none
# External: bash, node, gradle
#
# Used by: entry point (bash mobile/scripts/licenses.sh [--check]; Phase 18 CI)
# <module-headers:end>
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$MOBILE/app/src/generated/licenses"
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

OUT="$DEST"
if [[ $CHECK == 1 ]]; then
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
fi

# JS: a production build with the license plugin switched on (dist/ is gitignored).
(cd "$MOBILE/app" && YARAN_LICENSES_OUT="$OUT/js.json" npx --no-install vite build --logLevel error >/dev/null)

# iOS: from the Swift package manifests, offline.
node "$MOBILE/scripts/ios-licenses.mjs" "$OUT/ios.json"

# Android: AboutLibraries per flavor, converted to the shared list shape.
for flavor in foss play; do
  raw="$OUT/aboutlibraries-$flavor.json"
  (cd "$MOBILE/android" && ./gradlew --quiet :app:exportLibraryDefinitions \
    -PaboutLibraries.exportVariant="${flavor}Release" -PaboutLibraries.outputFile="$raw" >/dev/null)
  node "$MOBILE/scripts/android-licenses.mjs" "$raw" "$OUT/android-$flavor.json"
  rm -f "$raw"
done

if [[ $CHECK == 1 ]]; then
  drift=0
  for f in js android-foss android-play ios; do
    if ! cmp -s "$OUT/$f.json" "$DEST/$f.json"; then
      echo "licenses: $f.json is out of date; run bash mobile/scripts/licenses.sh" >&2
      drift=1
    fi
  done
  if grep -q '"com.google.firebase\|embedded-fcm' "$OUT/android-foss.json"; then
    echo "licenses: the foss list contains an FCM component" >&2
    drift=1
  fi
  [[ $drift == 0 ]] && echo "licenses: no drift"
  exit $drift
fi
echo "licenses: wrote $DEST"

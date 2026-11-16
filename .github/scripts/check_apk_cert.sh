#!/usr/bin/env bash
# APK signer gate: an APK ships only when its one signer is the committed app-signing key.
#
# Compares `apksigner verify --print-certs` against
# mobile/android/signing/app-signing-cert.sha256 (lowercase hex, the form apksigner
# prints). Every release APK passes through this before it is uploaded anywhere, so a
# wrong key, a second signer or a debug key can never ship (D14).
#
# - apksigner comes from $APKSIGNER, else PATH (build-tools 34 in CI).
# - A placeholder certificate file fails: nothing is signed before the D23 ceremony.
#
# Usage: check_apk_cert.sh <apk> [cert-sha256-file]
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (_mobile-android-release.yml and _mobile-android-ci.yml, and test_release_scripts.sh)
# <module-headers:end>

set -euo pipefail

APK="${1:?usage: check_apk_cert.sh <apk> [cert-sha256-file]}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CERT_FILE="${2:-$ROOT/mobile/android/signing/app-signing-cert.sha256}"
APKSIGNER="${APKSIGNER:-apksigner}"

want="$(tr -d '[:space:]' < "$CERT_FILE")"
if ! printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "FAIL: $CERT_FILE holds '$want', not a lowercase SHA-256; run the D23 key ceremony first" >&2
  exit 1
fi

certs="$("$APKSIGNER" verify --print-certs "$APK")"
digests="$(printf '%s\n' "$certs" | sed -nE 's/^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-f]{64})$/\1/p')"
count="$(printf '%s' "$digests" | grep -c . || true)"
if [ "$count" -ne 1 ]; then
  echo "FAIL: $APK has $count signer certificate(s); exactly one (the app-signing key) is allowed" >&2
  exit 1
fi
if [ "$digests" != "$want" ]; then
  echo "FAIL: $APK is signed by $digests, not the committed app-signing key $want" >&2
  exit 1
fi
echo "OK: $APK is signed by the committed app-signing key $want"

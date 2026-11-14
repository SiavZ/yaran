#!/usr/bin/env bash
# npm license gate: fails when a production dependency's license is outside deny.toml.
#
# One allowlist governs cargo, npm and Gradle: tools/release-trains/license-allowlist.mjs
# reads deny.toml's [licenses] allow array, and this runs license-checker-rseidelsohn
# (pinned in tools/release-trains/package-lock.json) over an already-installed package.
#
# - Installs tools/release-trains once (npm ci, no install scripts) when needed.
# - The package's node_modules must exist (run after `npm ci` in it).
# - With a second argument, also writes the license inventory JSON there.
#
# Usage: npm_license_gate.sh <package-dir> [inventory.json]
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (cloud-ci.yml, mobile-ci.yml, ui-kit-ci.yml, cloud-protocol.yml and _mobile-android-release.yml)
# <module-headers:end>

set -euo pipefail

PKG="${1:?usage: npm_license_gate.sh <package-dir> [inventory.json]}"
OUT="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS="$ROOT/tools/release-trains"
BIN="$TOOLS/node_modules/.bin/license-checker-rseidelsohn"

[ -x "$BIN" ] || npm ci --prefix "$TOOLS" --no-audit --no-fund
ALLOW="$(node "$TOOLS/license-allowlist.mjs" --npm)"

"$BIN" --start "$PKG" --production --excludePrivatePackages --onlyAllow "$ALLOW" --summary
if [ -n "$OUT" ]; then
  "$BIN" --start "$PKG" --production --excludePrivatePackages --json --out "$OUT"
fi

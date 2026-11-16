#!/usr/bin/env bash
# Offline tests for tools/cloudflared-pin/bump.sh: a pin from synthetic assets with
# both hashes verified, refusals for a tampered asset and a version below MIN_VERSION,
# and `--check` against the recorded releases fixture.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (bash tools/cloudflared-pin/tests/<name>_test.sh; Phase 10 Validation)
# <module-headers:end>

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUMP="$HERE/../bump.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# Synthetic assets: two raw binaries, two archives each holding one `cloudflared`.
mkdir -p "$WORK/assets" "$WORK/api" "$WORK/tgz"
for arch in amd64 arm64; do
  printf 'linux %s binary\n' "$arch" >"$WORK/assets/cloudflared-linux-$arch"
  printf 'darwin %s binary\n' "$arch" >"$WORK/tgz/cloudflared"
  tar -czf "$WORK/assets/cloudflared-darwin-$arch.tgz" -C "$WORK/tgz" cloudflared
  cp "$WORK/tgz/cloudflared" "$WORK/inner-$arch"
done
body="### SHA256 Checksums:\n\`\`\`\n"
assets_json=""
for a in cloudflared-linux-amd64 cloudflared-linux-arm64 cloudflared-darwin-amd64.tgz cloudflared-darwin-arm64.tgz; do
  digest=$(sha "$WORK/assets/$a")
  case "$a" in
    *darwin-amd64.tgz) inner=$(sha "$WORK/inner-amd64") ;;
    *darwin-arm64.tgz) inner=$(sha "$WORK/inner-arm64") ;;
    *) inner="$digest" ;;
  esac
  body+="$a: $inner\n"
  assets_json+="{\"name\":\"$a\",\"digest\":\"sha256:$digest\"},"
done
printf '{"tag_name":"2026.11.0","published_at":"2026-11-11T10:00:00Z","body":"%s```","assets":[%s]}' \
  "$body" "${assets_json%,}" >"$WORK/api/release-2026.11.0.json"

export CLOUDFLARED_PIN_API_DIR="$WORK/api" CLOUDFLARED_PIN_ASSET_DIR="$WORK/assets"
export CLOUDFLARED_PIN_OUT="$WORK/pins.rs"

# 1. A good pin writes every row with both hashes.
"$BUMP" 2026.11.0 >/dev/null || fail "a good pin was refused"
grep -q 'pub const PINNED_VERSION: &str = "2026.11.0";' "$WORK/pins.rs" || fail "version not written"
grep -q 'pub const PINNED_RELEASED: &str = "2026-11-11";' "$WORK/pins.rs" || fail "release date not written"
grep -q "binary_sha256: \"$(sha "$WORK/inner-arm64")\"" "$WORK/pins.rs" || fail "darwin binary hash not the inner one"
grep -q "asset_sha256: \"$(sha "$WORK/assets/cloudflared-darwin-arm64.tgz")\"" "$WORK/pins.rs" ||
  fail "darwin asset hash not the archive's"
[[ $(grep -c '    Pin {' "$WORK/pins.rs") -eq 4 ]] || fail "expected four rows"
head -1 "$WORK/pins.rs" | grep -q '@generated' || fail "the generated marker was lost"
# The generated layout is the committed one, apart from the values it fills in.
strip() { grep -v -e '_sha256:' -e '^pub const PINNED_' "$1"; }
diff <(strip "$HERE/../../../crates/yaran-core/src/cloud/cloudflared/pins.rs") <(strip "$WORK/pins.rs") ||
  fail "the generated pins.rs is laid out differently from the committed one"

# 2. A tampered asset is refused and nothing is written.
rm "$WORK/pins.rs"
printf 'evil' >>"$WORK/assets/cloudflared-linux-arm64"
if "$BUMP" 2026.11.0 >/dev/null 2>"$WORK/err"; then fail "a tampered asset was pinned"; fi
grep -q 'cloudflared-linux-arm64: downloaded file hashes to' "$WORK/err" || fail "unclear tamper message"
[[ ! -e "$WORK/pins.rs" ]] || fail "a refused pin wrote a file"

# 3. A version below MIN_VERSION is refused before any download.
if "$BUMP" 2025.4.0 >/dev/null 2>"$WORK/err"; then fail "a version below the floor was pinned"; fi
grep -q 'below MIN_VERSION 2026.11.0' "$WORK/err" || fail "unclear floor message"

# 4. --check against the recorded releases fixture.
export CLOUDFLARED_PIN_API_DIR="$HERE/fixtures"
CLOUDFLARED_PIN_TODAY=2026-11-20 "$BUMP" --check >/dev/null || fail "a fresh pin was reported due"
if CLOUDFLARED_PIN_TODAY=2027-01-15 "$BUMP" --check >"$WORK/out"; then fail "a 65-day-old pin was not due"; fi
grep -q 'bump at least every 60 days' "$WORK/out" || fail "missing the age sentence"
# 2026.12.1 mentions VULN- and is 8 days old on 2026-12-28 (the pin is 47 days old).
if CLOUDFLARED_PIN_TODAY=2026-12-28 "$BUMP" --check >"$WORK/out"; then fail "a VULN release was not due"; fi
grep -q '2026.12.1 fixes a VULN- issue' "$WORK/out" || fail "missing the VULN sentence"
CLOUDFLARED_PIN_TODAY=2026-12-24 "$BUMP" --check >/dev/null || fail "a VULN release inside its 7 days was due"

echo "bump_test: all checks passed"

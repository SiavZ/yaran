#!/usr/bin/env bash
# Regenerate crates/yaran-core/src/cloud/cloudflared/pins.rs for a cloudflared release,
# or (`--check`) say whether the pin is due for a bump.
#
# A pin row carries two hashes, and no hash is ever typed by hand:
# - asset_sha256: the GitHub API asset `digest` (the downloaded file);
# - binary_sha256: the release body's "SHA256 Checksums" line, which for a darwin `.tgz`
#   hashes the INNER binary.
# Every asset is downloaded and both hashes are verified before anything is written.
# A version below MIN_VERSION (version.rs) is refused.
#
# `--check` exits 1 when the pin is older than 60 days, or when a newer release whose
# notes mention `VULN-` has been out for more than 7 days.
#
# Offline knobs (tests): CLOUDFLARED_PIN_API_DIR (release JSON files instead of `gh api`:
# `release-<tag>.json`, `releases.json`), CLOUDFLARED_PIN_ASSET_DIR (assets instead of
# downloads), CLOUDFLARED_PIN_TODAY (YYYY-MM-DD), CLOUDFLARED_PIN_OUT (output path),
# CLOUDFLARED_PIN_VERSION_RS (where MIN_VERSION is read from).
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (maintainer CLI: tools/cloudflared-pin/bump.sh <version> | --check; Phase 18's pin-freshness workflow runs --check)
# <module-headers:end>

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PINS_RS="$REPO_ROOT/crates/yaran-core/src/cloud/cloudflared/pins.rs"
OUT="${CLOUDFLARED_PIN_OUT:-$PINS_RS}"
VERSION_RS="${CLOUDFLARED_PIN_VERSION_RS:-$REPO_ROOT/crates/yaran-core/src/cloud/cloudflared/version.rs}"
GH_REPO="cloudflare/cloudflared"
BUMP_EVERY_DAYS=60
VULN_GRACE_DAYS=7

# target triple | asset | kind
ROWS=(
  "x86_64-unknown-linux-musl|cloudflared-linux-amd64|Raw"
  "aarch64-unknown-linux-musl|cloudflared-linux-arm64|Raw"
  "x86_64-apple-darwin|cloudflared-darwin-amd64.tgz|Tgz"
  "aarch64-apple-darwin|cloudflared-darwin-arm64.tgz|Tgz"
)

die() { echo "bump.sh: $*" >&2; exit 1; }

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

today() { echo "${CLOUDFLARED_PIN_TODAY:-$(date -u +%F)}"; }

days_between() { # from to (YYYY-MM-DD)
  python3 -I -c 'import sys,datetime as d;a,b=(d.date.fromisoformat(x) for x in sys.argv[1:]);print((b-a).days)' "$1" "$2"
}

api() { # path-suffix name-in-fixture-dir
  if [[ -n "${CLOUDFLARED_PIN_API_DIR:-}" ]]; then
    cat "$CLOUDFLARED_PIN_API_DIR/$2"
  else
    gh api "repos/$GH_REPO/$1"
  fi
}

# "2026.11.0" -> sortable integer
version_key() {
  local y m p
  IFS=. read -r y m p <<<"$1"
  [[ "$y" =~ ^[0-9]+$ && "$m" =~ ^[0-9]+$ && "$p" =~ ^[0-9]+$ ]] || die "not a cloudflared version: $1"
  echo $(( y * 1000000 + m * 1000 + p ))
}

min_version() {
  local y m p
  y=$(grep -A3 'pub const MIN_VERSION' "$VERSION_RS" | sed -n 's/.*year: \([0-9]*\).*/\1/p')
  m=$(grep -A3 'pub const MIN_VERSION' "$VERSION_RS" | sed -n 's/.*month: \([0-9]*\).*/\1/p')
  p=$(grep -A4 'pub const MIN_VERSION' "$VERSION_RS" | sed -n 's/.*patch: \([0-9]*\).*/\1/p')
  [[ -n "$y" && -n "$m" && -n "$p" ]] || die "could not read MIN_VERSION from $VERSION_RS"
  echo "$y.$m.$p"
}

pinned_field() { sed -n "s/^pub const $1: &str = \"\\(.*\\)\";/\\1/p" "$PINS_RS"; }

check() {
  local pinned released age releases
  pinned=$(pinned_field PINNED_VERSION)
  released=$(pinned_field PINNED_RELEASED)
  [[ -n "$pinned" && -n "$released" ]] || die "could not read the pin from $PINS_RS"
  age=$(days_between "$released" "$(today)")
  local due=0
  if (( age > BUMP_EVERY_DAYS )); then
    echo "cloudflared $pinned was pinned from a release $age days old; bump at least every $BUMP_EVERY_DAYS days."
    due=1
  fi
  releases=$(api "releases?per_page=30" releases.json)
  local pinned_key
  pinned_key=$(version_key "$pinned")
  while IFS=$'\t' read -r tag published vuln; do
    [[ -n "$tag" ]] || continue
    (( $(version_key "$tag") > pinned_key )) || continue
    [[ "$vuln" == "true" ]] || continue
    local out
    out=$(days_between "${published:0:10}" "$(today)")
    if (( out > VULN_GRACE_DAYS )); then
      echo "cloudflared $tag fixes a VULN- issue and has been out $out days; bump within $VULN_GRACE_DAYS days."
      due=1
    fi
  done < <(jq -r '.[] | [.tag_name, .published_at, ((.body // "") | test("VULN-"))] | @tsv' <<<"$releases")
  if (( due == 0 )); then
    echo "cloudflared $pinned is current enough (pinned release is $age days old)."
  fi
  return "$due"
}

body_hash() { # body asset
  awk -v want="$2" '
    /SHA256 Checksums/ { on = 1; next }
    on && index($0, want ":") { sub(/.*: */, ""); gsub(/[^0-9a-f]/, ""); print; exit }
  ' <<<"$1"
}

fetch_asset() { # version asset dest
  if [[ -n "${CLOUDFLARED_PIN_ASSET_DIR:-}" ]]; then
    cp "$CLOUDFLARED_PIN_ASSET_DIR/$2" "$3"
  else
    curl -fsSL --proto '=https' -o "$3" "https://github.com/$GH_REPO/releases/download/$1/$2"
  fi
}

bump() {
  local version="$1" min release body released work rows=""
  min=$(min_version)
  if (( $(version_key "$version") < $(version_key "$min") )); then
    die "refusing to pin cloudflared $version: it is below MIN_VERSION $min (version.rs)"
  fi
  release=$(api "releases/tags/$version" "release-$version.json")
  body=$(jq -r '.body // ""' <<<"$release")
  released=$(jq -r '.published_at' <<<"$release")
  released="${released:0:10}"
  work=$(mktemp -d)
  BUMP_WORK="$work"
  trap 'rm -rf "$BUMP_WORK"' EXIT
  local row target asset kind digest asset_hash binary_hash actual
  for row in "${ROWS[@]}"; do
    IFS='|' read -r target asset kind <<<"$row"
    digest=$(jq -r --arg a "$asset" '.assets[] | select(.name == $a) | .digest // ""' <<<"$release")
    asset_hash="${digest#sha256:}"
    binary_hash=$(body_hash "$body" "$asset")
    [[ ${#asset_hash} -eq 64 ]] || die "$asset: no sha256 digest in the release API answer"
    [[ ${#binary_hash} -eq 64 ]] || die "$asset: no line in the release body's SHA256 Checksums block"
    fetch_asset "$version" "$asset" "$work/$asset"
    actual=$(sha256 "$work/$asset")
    [[ "$actual" == "$asset_hash" ]] || die "$asset: downloaded file hashes to $actual, the API digest says $asset_hash"
    if [[ "$kind" == "Tgz" ]]; then
      mkdir -p "$work/x-$asset"
      tar -xzf "$work/$asset" -C "$work/x-$asset" cloudflared
      actual=$(sha256 "$work/x-$asset/cloudflared")
    fi
    [[ "$actual" == "$binary_hash" ]] || die "$asset: binary hashes to $actual, the release body says $binary_hash"
    rows+="    Pin {
        target: \"$target\",
        asset: \"$asset\",
        kind: AssetKind::$kind,
        asset_sha256: \"$asset_hash\",
        binary_sha256: \"$binary_hash\",
    },
"
  done
  write_pins "$version" "$released" "$rows"
  echo "Pinned cloudflared $version (released $released) in $OUT."
}

write_pins() { # version released rows
  # Keep everything above the version constant (the header and its docs) verbatim.
  local head
  head=$(sed '/^\/\/\/ The cloudflared release the managed path downloads\./,$d' "$PINS_RS")
  {
    printf '%s\n\n' "$head"
    cat <<EOF
/// The cloudflared release the managed path downloads.
pub const PINNED_VERSION: &str = "$1";

/// The pinned release's publication date (\`YYYY-MM-DD\`), for the support-window warning.
pub const PINNED_RELEASED: &str = "$2";
EOF
    printf '\n'
    sed -n '/^\/\/\/ How a release asset is packaged\./,/^pub const PINS: &\[Pin\] = &\[$/p' "$PINS_RS"
    printf '%s];\n' "$3"
  } >"$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
}

case "${1:-}" in
  --check) check ;;
  ""|-h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  *) bump "$1" ;;
esac

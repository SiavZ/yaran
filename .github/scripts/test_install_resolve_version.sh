#!/usr/bin/env bash
# Offline test of install.sh's resolve_version tag-prefix filter.
#
# The repository publishes three release trains, and only the binary train
# (yaran-v*, historical dux-amq-v*) ships the archives install.sh downloads. This
# sources install.sh as a library (YARAN_INSTALL_SH_LIB=1), replaces http_get with
# a stub that serves fixture JSON, and asserts which tag resolve_version picks
# when "latest" is another train, when only prereleases exist, when drafts are
# present, and when nothing matches at all.
#
# - No network: http_get is stubbed; fixtures live in a temp dir removed on exit.
# - Exercises the real parse_tag, is_binary_tag and pick_binary_tag.
#
# Usage: .github/scripts/test_install_resolve_version.sh [path/to/install.sh]
#
# <module-headers:begin>
# Uses:
# .github/scripts/test_install_resolve_version.sh
# └── unresolved: "$INSTALL_SH"
# External: none
#
# Used by: entry point (install-script-ci.yml: bash .github/scripts/test_install_resolve_version.sh)
# <module-headers:end>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${1:-${SCRIPT_DIR}/../../install.sh}"

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

export YARAN_INSTALL_SH_LIB=1
# shellcheck disable=SC1090
. "$INSTALL_SH"
set +e

# Serve $FIX/latest.json and $FIX/list.json; a missing fixture is an HTTP error.
http_get() {
    case "$1" in
        */releases/latest)  cat "$FIX/latest.json" 2>/dev/null ;;
        */releases\?per_page=30) cat "$FIX/list.json" 2>/dev/null ;;
        *) echo "unexpected URL: $1" >&2; return 1 ;;
    esac
}

release() { # tag draft prerelease -> one release object with nested noise
    printf '{"url":"x","author":{"login":"a","type":"User"},"tag_name":"%s","name":"n","draft":%s,"immutable":false,"prerelease":%s,"assets":[{"name":"a.tgz","uploader":{"login":"b"}}],"body":"see \\"tag_name\\": \\"v9.9.9\\""}' "$1" "$2" "$3"
}

fails=0
expect() { # name expected-tag
    local got status
    got="$(VERSION="" resolve_version 2>"$FIX/err")"
    status=$?
    if [ "$status" -eq 0 ] && [ "$got" = "$2" ]; then
        echo "ok   $1"
    else
        echo "FAIL $1: expected '$2', got '$got' (exit $status)"; cat "$FIX/err"; fails=$((fails + 1))
    fi
}

setup() { # latest-json-or-empty list-entries...
    rm -f "$FIX/latest.json" "$FIX/list.json"
    [ -n "$1" ] && printf '%s' "$1" > "$FIX/latest.json"
    shift
    local IFS=,
    printf '[%s]' "$*" > "$FIX/list.json"
}

LIST=("$(release yaran-mobile-v1.0.0 false false)" "$(release yaran-cloud-v1.1.0 false false)" \
      "$(release yaran-v0.4.0-rc.1 false true)" "$(release yaran-v0.3.0 false false)" "$(release yaran-v0.2.0 false false)")

setup "$(release yaran-mobile-v1.0.0 false false)" "${LIST[@]}"
expect "latest is a mobile release -> newest stable yaran-v*" yaran-v0.3.0

setup "$(release yaran-cloud-v1.1.0 false false)" "${LIST[@]}"
expect "latest is a cloud release -> newest stable yaran-v*" yaran-v0.3.0

setup "$(release yaran-v0.3.0 false false)" "$(release yaran-mobile-v9.0.0 false false)"
expect "latest is a binary release -> taken directly" yaran-v0.3.0

setup "" "$(release yaran-mobile-v1.0.0-rc.1 false true)" "$(release yaran-v0.2.0-rc.2 false true)" "$(release yaran-v0.2.0-rc.1 false true)"
expect "only prereleases -> newest matching prerelease" yaran-v0.2.0-rc.2

setup "" "$(release yaran-v0.5.0 true false)" "$(release yaran-v0.4.0-rc.1 true true)" "$(release dux-amq-v0.1.1 false false)"
expect "drafts skipped -> historical dux-amq-v* tag" dux-amq-v0.1.1

setup "$(release yaran-mobile-v1.0.0 false false)" "$(release yaran-mobile-v1.0.0 false false)" "$(release yaran-cloud-v1.0.0 false true)"
if ! out="$( (VERSION="" resolve_version) 2>&1)" && printf '%s' "$out" | grep -q "Could not determine the latest release for"; then
    echo "ok   no binary release at all -> existing error text"
else
    echo "FAIL no binary release at all: got '$out'"; fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] || { echo "$fails case(s) failed"; exit 1; }
echo "All resolve_version cases passed."

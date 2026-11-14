#!/usr/bin/env bash
# Tests for check-release-config.sh and the entitlements selection it depends on.
#
# Runs the guard with the environment Xcode would export and checks each verdict, then checks
# that the plain entitlements file (no associated domains) is the one chosen for an empty
# publisher domain and the publisher file carries exactly the two domain entries.
#
# - No Xcode needed; reads only files in this directory tree.
# - Prints one line per case and exits non-zero on the first failure.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: none
# <module-headers:end>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/check-release-config.sh"
app="$here/../App"
fail=0

expect() { # expect <pass|fail> <description> <env assignments...>
  local want="$1" name="$2"; shift 2
  if env -i PATH="$PATH" "$@" bash "$guard" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [[ "$got" == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name (wanted $want, got $got)"; fail=1; fi
}

expect fail "example id fails Release"            CONFIGURATION=Release APP_ID=com.example.yaran
expect pass "example id passes Debug"             CONFIGURATION=Debug APP_ID=com.example.yaran
expect pass "example id passes E2E"               CONFIGURATION=E2E APP_ID=com.example.yaran
expect fail "empty id fails Release"              CONFIGURATION=Release APP_ID=
expect pass "real id passes Release"              CONFIGURATION=Release APP_ID=org.example2.yaran
expect fail "empty domain + REQUIRE fails"        CONFIGURATION=Release APP_ID=org.real.yaran REQUIRE_PUBLISHER_DOMAIN=YES PUBLISHER_DOMAIN=
expect pass "empty domain without REQUIRE passes" CONFIGURATION=Release APP_ID=org.real.yaran PUBLISHER_DOMAIN=
expect pass "domain + REQUIRE passes"             CONFIGURATION=Release APP_ID=org.real.yaran REQUIRE_PUBLISHER_DOMAIN=YES PUBLISHER_DOMAIN=cb.real.org

check() { # check <description> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; fail=1; fi
}

plain="$app/App/App.entitlements"
publisher="$app/App/App+Publisher.entitlements"
check "plain entitlements have no associated domains" bash -c "! grep -q associated-domains '$plain'"
check "publisher entitlements declare applinks"       grep -q 'applinks:$(PUBLISHER_DOMAIN)' "$publisher"
check "publisher entitlements declare webcredentials" grep -q 'webcredentials:$(PUBLISHER_DOMAIN)' "$publisher"
check "both share the app group"                      bash -c "grep -q 'group.\$(APP_ID)' '$plain' && grep -q 'group.\$(APP_ID)' '$publisher'"
check "project leaves the app's entitlements to the xcconfig" bash -c "! grep -q 'CODE_SIGN_ENTITLEMENTS = App' '$app/App.xcodeproj/project.pbxproj'"

# The generated xcconfig (mobile/scripts/publisher-config.mjs) picks the file from the domain.
xcconfig="$app/Config/Publisher.xcconfig"
if [[ -f "$xcconfig" ]]; then
  domain="$(sed -n 's/^PUBLISHER_DOMAIN *= *//p' "$xcconfig")"
  entitlements="$(sed -n 's/^CODE_SIGN_ENTITLEMENTS *= *//p' "$xcconfig")"
  if [[ -z "$domain" ]]; then want="App/App.entitlements"; else want="App/App+Publisher.entitlements"; fi
  check "xcconfig selects $want for domain '${domain}'" test "$entitlements" = "$want"
else
  echo "skip Publisher.xcconfig not generated yet (run node mobile/scripts/publisher-config.mjs)"
fi

exit "$fail"

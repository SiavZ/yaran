#!/usr/bin/env bash
# Release config guard: an Xcode Run Script phase that refuses an unpublishable Release build.
#
# Reads the build settings Xcode exports (from the generated Publisher.xcconfig) and fails the
# Release configuration when the bundle id is still the repo placeholder (`com.example.*`,
# D16), or when the release lane asked for a publisher domain (`REQUIRE_PUBLISHER_DOMAIN=YES`,
# Phase 18) and none is set, so an official build can never ship the dev callback (D8, T36).
#
# - Debug and E2E builds always pass; fork Release builds without the flag still build.
# - Messages use Xcode's `error:` prefix so they show in the issue navigator.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (Run Script build phase Check release config in mobile/ios/App/App.xcodeproj)
# <module-headers:end>
set -euo pipefail

config="${CONFIGURATION:-}"
[[ "$config" == "Release" ]] || exit 0

app_id="${APP_ID:-}"
if [[ -z "$app_id" || "$app_id" == com.example.* ]]; then
  echo "error: APP_ID is '${app_id}', the repo placeholder. Set appId in mobile/publisher.properties and run node mobile/scripts/publisher-config.mjs before a Release build."
  exit 1
fi

if [[ "${REQUIRE_PUBLISHER_DOMAIN:-}" == "YES" && -z "${PUBLISHER_DOMAIN:-}" ]]; then
  echo "error: REQUIRE_PUBLISHER_DOMAIN=YES but PUBLISHER_DOMAIN is empty. Set publisher_domain in publisher.json and run node mobile/scripts/publisher-config.mjs."
  exit 1
fi

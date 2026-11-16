#!/usr/bin/env bash
# iOS target type check without Xcode: MachineView, PushPlugin and the app delegates (Mac Catalyst UIKit).
#
# The Command Line Tools ship no iOS SDK, but the macOS SDK carries UIKit for Mac Catalyst
# (iOSSupport). This builds YaranCore, MachineViewCore and the push packages for
# arm64-apple-ios17.4-macabi, re-targets the real Capacitor 8.6.2 swiftinterface (fetched by
# `swift package resolve` at the plugin root) to the same triple, and compiles the MachineView
# and PushPlugin sources, the Notification Service Extension, and the app's AppDelegate and
# SceneDelegate. It proves the code names real APIs with the right types; it is not an iOS
# build and links nothing.
#
# - Writes only to a fresh temporary directory, removed on exit.
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (run by hand: `bash mobile/plugins/machine-view/ios/typecheck-catalyst.sh` (no-Xcode type check))
# <module-headers:end>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
triple=arm64-apple-ios17.4-macabi
fw="$sdk/System/iOSSupport/System/Library/Frameworks"
art="$root/.build/artifacts/capacitor-swift-pm"
[[ -d "$art" ]] || (cd "$root" && swift package resolve)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp -R "$art/Capacitor/Capacitor.xcframework/ios-arm64/Capacitor.framework" \
  "$art/Cordova/Cordova.xcframework/ios-arm64/Cordova.framework" "$tmp/"
mods="$tmp/Capacitor.framework/Modules/Capacitor.swiftmodule"
sed "s/-target arm64-apple-ios[0-9.]*/-target $triple/" "$mods/arm64-apple-ios.swiftinterface" \
  > "$mods/arm64-apple-ios-macabi.swiftinterface"

core="$root/../core/ios/Sources/YaranCore"
app="$root/../../ios/App/App"
swiftc -emit-module -module-name YaranCore -swift-version 5 -target "$triple" -sdk "$sdk" -Fsystem "$fw" \
  -emit-module-path "$tmp/YaranCore.swiftmodule" "$core"/*.swift
swiftc -emit-module -module-name MachineViewCore -target "$triple" -sdk "$sdk" -Fsystem "$fw" -I "$tmp" \
  -emit-module-path "$tmp/MachineViewCore.swiftmodule" "$here"/MachineViewCore/Sources/MachineViewCore/*.swift
swiftc -emit-module -module-name MachineView -target "$triple" -sdk "$sdk" -Fsystem "$fw" -F "$tmp" -I "$tmp" \
  -emit-module-path "$tmp/MachineView.swiftmodule" "$here"/Sources/MachineView/*.swift
# Phase 16's push modules, which the app delegate binds to the org client.
push="$root/../../ios/Shared/YaranPushCore/Sources"
swiftc -emit-module -module-name YaranPushCore -target "$triple" -sdk "$sdk" -Fsystem "$fw" \
  -emit-module-path "$tmp/YaranPushCore.swiftmodule" "$push"/YaranPushCore/*.swift
swiftc -emit-module -module-name YaranPushRegistration -target "$triple" -sdk "$sdk" -Fsystem "$fw" -I "$tmp" \
  -emit-module-path "$tmp/YaranPushRegistration.swiftmodule" "$push"/YaranPushRegistration/*.swift
swiftc -emit-module -module-name PushPlugin -target "$triple" -sdk "$sdk" -Fsystem "$fw" -F "$tmp" -I "$tmp" \
  -emit-module-path "$tmp/PushPlugin.swiftmodule" "$root"/../push/ios/Sources/PushPlugin/*.swift
swiftc -typecheck -target "$triple" -sdk "$sdk" -Fsystem "$fw" -I "$tmp" "$root"/../../ios/App/NotificationService/NotificationService.swift
# The app target's delegates, which install the core and push bindings at launch.
swiftc -typecheck -target "$triple" -sdk "$sdk" -Fsystem "$fw" -F "$tmp" -I "$tmp" "$app"/AppDelegate.swift "$app"/SceneDelegate.swift
echo "MachineView, PushPlugin, the NSE and the app delegates type-check against Mac Catalyst UIKit and Capacitor 8.6.2."

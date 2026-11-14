// swift-tools-version: 6.0
/// YaranCore package manifest: the phone app's native core library for iOS.
///
/// Vault, AppLock, Diagnostics, Sanitizer, ScreenPrivacy, HostRules and the plugin argument
/// rules, shared by every Capacitor plugin package (`.package(path:)`) and by the App target.
/// It is not a Capacitor plugin and never imports Capacitor, so `swift test` runs the pure
/// logic on a Mac.
///
/// - UIKit code sits behind `#if canImport(UIKit)`; everything else builds on macOS 14.
/// - Swift 5 language mode, matching the Capacitor plugins and the App target.
/// - iOS `.v17`, not 17.4: Capacitor generates CapApp-SPM with the major version only, and a
///   dependency may not require more than its dependent; the App target enforces 17.4.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: none
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "YaranCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "YaranCore", targets: ["YaranCore"])
    ],
    targets: [
        .target(name: "YaranCore"),
        .testTarget(name: "YaranCoreTests", dependencies: ["YaranCore"]),
    ],
    swiftLanguageModes: [.v5]
)

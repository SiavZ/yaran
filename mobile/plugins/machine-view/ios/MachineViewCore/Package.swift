// swift-tools-version: 5.9
/// MachineViewCore package manifest: the pure, host-testable Swift half of the machine-view plugin.
///
/// Holds the policy twins, the sealed-envelope opener, the device key and session stores, the
/// org API client, the handoff orchestrator, the renewal coordinator and the UIKit-free WebKit
/// delegates, so they build and run under `swift test` with only the Command Line Tools. The
/// iOS-only `MachineView` target of the root Package.swift links it.
///
/// - Foundation, CryptoKit, Security and WebKit only; no UIKit and no Capacitor.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM, a local dependency of mobile/plugins/machine-view/Package.swift)
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "MachineViewCore",
    platforms: [.iOS("17.4"), .macOS(.v14)],
    products: [
        .library(name: "MachineViewCore", targets: ["MachineViewCore"])
    ],
    dependencies: [
        .package(path: "../../../core/ios"),
    ],
    targets: [
        .target(name: "MachineViewCore", dependencies: [.product(name: "YaranCore", package: "ios")]),
        .testTarget(name: "MachineViewCoreTests", dependencies: ["MachineViewCore"]),
    ]
)

// swift-tools-version: 5.9
/// GateSpikeCore package manifest: the pure, host-testable Swift logic of the iOS gate spike.
///
/// Holds the cookie-string builder (G1) and the handoff URL / callback summary logic (G13) so
/// they run under `swift test` with only the Command Line Tools, and are linked into the App
/// target as a local package.
///
/// - Foundation only; no UIKit, WebKit or Capacitor, so macOS can run the tests.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM and by Xcode's local package reference)
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "GateSpikeCore",
    platforms: [.iOS("17.4"), .macOS(.v13)],
    products: [
        .library(name: "GateSpikeCore", targets: ["GateSpikeCore"])
    ],
    targets: [
        .target(name: "GateSpikeCore"),
        .testTarget(name: "GateSpikeCoreTests", dependencies: ["GateSpikeCore"]),
    ]
)

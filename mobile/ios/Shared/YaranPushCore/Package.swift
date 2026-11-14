// swift-tools-version: 5.9
/// YaranPushCore package manifest: the push logic shared by the iOS app, its push plugin and
/// the Notification Service Extension.
///
/// Two libraries. `YaranPushCore` is what the NSE links: RFC 8291 decryption, the per-org
/// subscription store, payload parsing, the topic, notification content and the App Group
/// state. `YaranPushRegistration` is app-only: relay endpoint minting, the W12 device
/// registration body and the foreground presentation policy.
///
/// - CryptoKit and Foundation only (UserNotifications for content), so `swift test` runs the
///   whole suite on macOS with just the Command Line Tools; nothing here imports Capacitor.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM, by Xcode's local package reference and by mobile/plugins/push/Package.swift)
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "YaranPushCore",
    platforms: [.iOS("17.4"), .macOS(.v13)],
    products: [
        .library(name: "YaranPushCore", targets: ["YaranPushCore"]),
        .library(name: "YaranPushRegistration", targets: ["YaranPushRegistration"]),
    ],
    targets: [
        .target(name: "YaranPushCore"),
        .target(name: "YaranPushRegistration", dependencies: ["YaranPushCore"]),
        .testTarget(name: "YaranPushCoreTests", dependencies: ["YaranPushCore"]),
        .testTarget(name: "YaranPushRegistrationTests", dependencies: ["YaranPushRegistration", "YaranPushCore"]),
    ]
)

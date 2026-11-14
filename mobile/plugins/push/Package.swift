// swift-tools-version: 5.9
/// YaranPush package manifest: the iOS half of the `@yaran/push` Capacitor plugin.
///
/// The Capacitor CLI links this package into the app's CapApp-SPM; the plugin target is a thin
/// adapter over `YaranPushCore` and `YaranPushRegistration`, which hold all the tested logic.
///
/// - Not compiled in this repository's checks: it needs Capacitor's Swift package and Xcode.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM through the Capacitor CLI's CapApp-SPM package)
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "YaranPush",
    platforms: [.iOS("17.4")],
    products: [
        .library(name: "YaranPush", targets: ["PushPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),
        .package(path: "../../ios/Shared/YaranPushCore"),
    ],
    targets: [
        .target(
            name: "PushPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "YaranPushCore", package: "YaranPushCore"),
                .product(name: "YaranPushRegistration", package: "YaranPushCore"),
            ],
            path: "ios/Sources/PushPlugin"
        )
    ]
)

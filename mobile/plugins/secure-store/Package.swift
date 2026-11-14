// swift-tools-version: 5.9
/// YaranSecureStore package manifest: the iOS half of the `@yaran/secure-store` Capacitor plugin.
///
/// The Capacitor CLI wants this file at the plugin root and names the package and product
/// after the npm id (`@yaran/secure-store` -> `YaranSecureStore`); `cap sync` then references
/// it from `mobile/ios/App/CapApp-SPM`. The adapters live in `ios/Sources` and depend on the
/// native core through its local path.
///
/// - Capacitor pin matches the app's CapApp-SPM (exact 8.6.2).
/// - iOS `.v17`, not 17.4: CapApp-SPM is generated with the major version only, and a package
///   may not require more than its dependent; the App target still enforces 17.4.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM through CapApp-SPM, which the Capacitor CLI sync writes)
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "YaranSecureStore",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "YaranSecureStore", targets: ["YaranSecureStorePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),
        .package(path: "../core/ios"),
    ],
    targets: [
        .target(
            name: "YaranSecureStorePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "YaranCore", package: "ios"),
            ],
            path: "ios/Sources/YaranSecureStorePlugin"
        )
    ]
)

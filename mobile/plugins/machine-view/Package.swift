// swift-tools-version: 5.9
/// YaranMachineView package manifest: the iOS half of the `@yaran/machine-view` Capacitor plugin.
///
/// Sits at the npm package root because the Capacitor CLI looks for a plugin's Package.swift
/// there when it generates CapApp-SPM. The `MachineView` target (Capacitor adapters, the
/// UIKit window, the ASWebAuthenticationSession launcher) links the pure `MachineViewCore`
/// package, which holds everything testable on a Mac.
///
/// - Phase 14 adds the `plugins/core` (YaranCore) dependency and binds it through
///   `CoreBindings.install` in its AppDelegate.
///
/// <module-headers:begin>
/// Uses: none
/// External: PackageDescription
///
/// Used by: entry point (read by SwiftPM and by the Capacitor CLI's CapApp-SPM package (plugin root))
/// <module-headers:end>
import PackageDescription

let package = Package(
    name: "YaranMachineView",
    platforms: [.iOS("17.4")],
    products: [
        .library(name: "YaranMachineView", targets: ["MachineView"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),
        .package(path: "ios/MachineViewCore"),
    ],
    targets: [
        .target(
            name: "MachineView",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "MachineViewCore", package: "MachineViewCore"),
            ],
            path: "ios/Sources/MachineView"
        )
    ]
)

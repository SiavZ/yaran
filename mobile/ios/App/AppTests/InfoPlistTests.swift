/// InfoPlistTests: asserts the shipped Info.plist facts other phases rely on.
///
/// Hosted in the App, so `Bundle.main` is the real app bundle: the `yaranapp` URL scheme
/// (`add-org` deep link), both usage strings, single-scene mode and the four iPad
/// orientations.
///
/// - Reads only; no Keychain or network.
///
/// <module-headers:begin>
/// Uses: none
/// External: XCTest
///
/// Used by: none
/// <module-headers:end>

import XCTest

final class InfoPlistTests: XCTestCase {
    private var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }

    func testURLSchemeIsRegistered() {
        let types = info["CFBundleURLTypes"] as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["yaranapp"])
    }

    func testUsageStringsArePresent() {
        for key in ["NSCameraUsageDescription", "NSFaceIDUsageDescription"] {
            let text = Bundle.main.localizedString(forKey: key, value: nil, table: "InfoPlist")
            XCTAssertFalse(text.isEmpty || text == key, key)
            XCTAssertNotNil(info[key] as? String, key)
        }
    }

    func testSingleSceneAndIPadOrientations() {
        let manifest = info["UIApplicationSceneManifest"] as? [String: Any]
        XCTAssertEqual(manifest?["UIApplicationSupportsMultipleScenes"] as? Bool, false)
        XCTAssertEqual((info["UISupportedInterfaceOrientations~ipad"] as? [String])?.count, 4)
        XCTAssertNil(info["UIRequiresFullScreen"])
        XCTAssertNotNil(info["ITSAppUsesNonExemptEncryption"])
    }
}

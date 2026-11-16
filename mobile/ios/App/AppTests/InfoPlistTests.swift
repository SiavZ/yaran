/// InfoPlistTests: asserts the shipped Info.plist facts other phases rely on.
///
/// Hosted in the App, so `Bundle.main` is the real app bundle; the tests read its packaged
/// Info.plist: the `yaranapp` URL scheme (`add-org` deep link), both usage strings,
/// single-scene mode and the four iPad orientations.
///
/// - Reads only; no Keychain or network.
///
/// <module-headers:begin>
/// Uses: none
/// External: XCTest
///
/// Used by: entry point (XCTest, hosted AppTests target of mobile/ios/App/App.xcodeproj)
/// <module-headers:end>

import XCTest

final class InfoPlistTests: XCTestCase {
    /// The packaged Info.plist as shipped. Not `infoDictionary`: CFBundle drops `~ipad` keys
    /// that do not match the running device, so on an iPhone that view never has them.
    private func packagedInfo() throws -> [String: Any] {
        let data = try Data(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    func testURLSchemeIsRegistered() throws {
        let info = try packagedInfo()
        let types = info["CFBundleURLTypes"] as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["yaranapp"])
    }

    func testUsageStringsArePresent() throws {
        let info = try packagedInfo()
        for key in ["NSCameraUsageDescription", "NSFaceIDUsageDescription"] {
            let text = Bundle.main.localizedString(forKey: key, value: nil, table: "InfoPlist")
            XCTAssertFalse(text.isEmpty || text == key, key)
            XCTAssertNotNil(info[key] as? String, key)
        }
    }

    func testSingleSceneAndIPadOrientations() throws {
        let info = try packagedInfo()
        let manifest = info["UIApplicationSceneManifest"] as? [String: Any]
        XCTAssertEqual(manifest?["UIApplicationSupportsMultipleScenes"] as? Bool, false)
        XCTAssertEqual((info["UISupportedInterfaceOrientations~ipad"] as? [String])?.count, 4)
        XCTAssertNil(info["UIRequiresFullScreen"])
        XCTAssertNotNil(info["ITSAppUsesNonExemptEncryption"])
    }
}

/// The APNs environment follows the signed `aps-environment` entitlement in the embedded profile.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushRegistrationTests/ApnsEnvironmentTests
/// └── YaranPushRegistration/ApnsEnvironment (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import YaranPushRegistration

/// An embedded.mobileprovision shape: CMS bytes around the XML plist.
private func profile(aps: String?) -> Data {
    let entitlement = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
    let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>Name</key><string>yaran dev</string>
    <key>Entitlements</key><dict><key>application-identifier</key><string>T.com.example.yaran</string>\(entitlement)</dict>
    </dict></plist>
    """
    return Data([0x30, 0x82, 0x4e, 0x3c, 0x06, 0x09]) + Data(plist.utf8) + Data([0xa0, 0x82, 0x0b, 0x00])
}

struct ApnsEnvironmentTests {
    @Test func developmentProfileRegistersSandboxTokens() {
        #expect(ApnsEnvironment.resolve(embeddedProfile: profile(aps: "development"), simulator: false) == "sandbox")
    }

    @Test func adHocProfileRegistersProductionTokens() {
        #expect(ApnsEnvironment.resolve(embeddedProfile: profile(aps: "production"), simulator: false) == "production")
    }

    @Test func storeInstallWithoutAProfileIsProduction() {
        #expect(ApnsEnvironment.resolve(embeddedProfile: nil, simulator: false) == "production")
    }

    @Test func simulatorTokensAreSandbox() {
        #expect(ApnsEnvironment.resolve(embeddedProfile: nil, simulator: true) == "sandbox")
    }

    @Test func unreadableOrPushlessProfileIsProduction() {
        #expect(ApnsEnvironment.resolve(embeddedProfile: profile(aps: nil), simulator: false) == "production")
        #expect(ApnsEnvironment.resolve(embeddedProfile: Data("not a profile".utf8), simulator: false) == "production")
    }
}

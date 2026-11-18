# Phase 21 — Publisher infrastructure and store readiness

**Track:** C (sequential) · **Parallel-safe with:** nothing (Wave C runs alone)
**Depends on:** 20 (zero open findings; data inventory and playbooks exist) · **Blocks:** 22

## Goal

Stand up everything the **publisher** (the yaran maintainers) has to run or own before the
public can install the apps, and take all four channels to the point where a release only
needs a button press. That means:

- the production push relay for iOS;
- a permanent review server, so store reviewers can sign in;
- developer accounts on Apple and Google, and the identifiers and signing setup for both
  (the Android app-signing key and its Play App Signing enrollment are Phase 18's, done
  before any Play upload, D23; this phase verifies them and registers developer
  verification);
- the association files (`assetlinks.json`, `apple-app-site-association`) on
  `<publisher-domain>`, which make the release-build handoff callback a verified https
  link (D8, R2);
- privacy disclosures that match the data inventory from Phase 20;
- the privacy policy and a support channel;
- store listings and screenshots;
- the F-Droid submission.

The phase exits when TestFlight external testing is approved, a Play closed test is running
on the `play` flavor, and the fdroiddata merge request is open and passing its CI.

## Evidence

All web sources were fetched on 2026-11-14.

### Apple

Review Guidelines, last updated "October 16, 2026"
(https://developer.apple.com/app-store/review/guidelines/):

- **2.1(a)** says to "include demo account info (and turn on your back-end service!) if your app includes a login". A demo mode is allowed only "with prior approval by Apple".
- **2.5.2** says the app may not "download, install, or execute code which introduces or changes features or functionality of the app".
- **2.5.6** says apps that browse the web must use WebKit.
- **4.2** asks to "elevate it beyond a repackaged website". **4.2.2** says no "web clippings … or a collection of links".
- **4.2.7** applies to apps that act "as a mirror of specific software or services". Its parts:
  - (a) requires "a user-owned host device … both … connected on a local and LAN-based network";
  - (c) requires that "All account creation and management must be initiated from the host device";
  - (e) says "Thin clients for cloud-based apps are not appropriate".
- **5.1.1(i)** says "All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app". The policy must explain "data retention/deletion policies and describe how a user can revoke consent and/or request deletion".
- **5.1.1(v)** requires account deletion only "If your app supports account creation".
- **4.8** says another login service is not required for an app that "requires the user to sign in with an existing education or enterprise account".

Privacy manifest (https://developer.apple.com/documentation/bundleresources/privacy-manifest-files):

- Keys: `NSPrivacyTracking`, `NSPrivacyTrackingDomains`, `NSPrivacyCollectedDataTypes`, `NSPrivacyAccessedAPITypes`.
- Required-reason API categories are FileTimestamp, SystemBootTime, DiskSpace, ActiveKeyboards and UserDefaults. Apps that omit them "aren't accepted" (since May 1, 2024).
- **Capacitor and Cordova are on Apple's list of SDKs** that must carry a manifest, and also a signature when used as a binary dependency (https://developer.apple.com/support/third-party-SDK-requirements/).
- Capacitor documents a UserDefaults `CA92.1` declaration for `@capacitor/preferences` (https://capacitorjs.com/docs/ios/privacy-manifest).

Privacy labels (https://developer.apple.com/app-store/app-privacy-details/):

- "'Collect' refers to transmitting data off the device in a way that allows you and/or your third-party partners to access it for a period longer than what is necessary to service the transmitted request in real time."
- "Data that is processed only on device is not 'collected'."

Export compliance:

- Encryption "built into the operating system" is typically exempt (https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).
- "Encryption limited to that within the Apple operating system" needs no documentation. A standard algorithm *not* provided by the OS needs a French declaration, and only for distribution in France (https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption).

Screenshots, TestFlight and toolchain:

- **Screenshots** (https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications): at least one iPhone with Dynamic Island (medium) set at 1179×2556 or 1206×2622, and an iPad 13" set at 2064×2752 or 2048×2732 if the app runs on iPad.
- **TestFlight** (https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview): up to 10,000 external testers. The first build added to an external group goes to App Review. Builds last 90 days.
- **Uploads** must be built with Xcode 26 and the iOS 26 SDK, and target iOS 13+ (https://developer.apple.com/news/upcoming-requirements/).

### Google

- **Data safety** (https://support.google.com/googleplay/android-developer/answer/10787469):
  - "'Collect' means transmitting data from your app off a user's device". SDK transmissions count.
  - Exemptions exist for end-to-end encrypted data ("unreadable by you or anyone other than the sender and recipient"), for ephemeral processing (declared in the form but not disclosed), for service providers, and for user-initiated transfers.
  - "All developers that have an app published on Google Play must complete the Data safety form". A privacy policy is required.
  - How a user-chosen org server is treated is **UNVERIFIED**. The page's closest text concerns a user's "own external drive or cloud storage account".
- **Target API:** new apps and updates must target API 36 since 2026-08-31 (https://developer.android.com/google/play/requirements/target-sdk). No later bump is announced, and an API 37 requirement for 2027 is UNVERIFIED.
- **Testing gate:** personal accounts created after 2023-11-13 need "a minimum of 12 testers … opted in continuously for at least 14 days" (https://support.google.com/googleplay/android-developer/answer/14151465). An exemption for organization accounts is **UNVERIFIED**, because the page does not mention them.
- **App access** (https://support.google.com/googleplay/android-developer/answer/9859455): "You can add up to five sets of instructions".
- **Developer verification** (https://developer.android.com/developer-verification and its FAQ):
  - Regional enforcement began on 2026-09-30, and it goes global "in 2027".
  - Organizations need a D-U-N-S number, which can take up to 28 days.
  - Play App Signing apps are registered automatically.
  - "add and verify multiple signing keys for a single package". "If you lose your signing key you won't be able to register your packages".
  - Sideloads and other stores are "not yet" covered (updated 2026-07-15).
- **Self-update and installs** (https://support.google.com/googleplay/android-developer/answer/16559646 and https://support.google.com/googleplay/android-developer/answer/12085295):
  - A Play app may not update itself outside Play.
  - JavaScript in a WebView is excluded from the remote-code rule.
  - `REQUEST_INSTALL_PACKAGES` is restricted.

### F-Droid

- **Inclusion** (https://f-droid.org/docs/Inclusion_Policy/): FLOSS only. Play Services and Firebase are excluded unless a flavor without them exists.
- **Anti-features** (https://f-droid.org/docs/Anti-Features/):
  - **NonFreeNet**: "apps that promote or depend entirely on a proprietary network service".
  - **TetheredNet** is not applied if the app can point at "an alternative, publicly available, self-hostable server".
- **Developer-signed reproducible builds** (https://f-droid.org/docs/Reproducible_Builds/): `Binaries` plus `AllowedAPKSigningKeys`. If F-Droid's rebuild does not match, it "will skip publishing this version".
- **Timing:** builds run daily, and a release takes "a few days" to appear (https://f-droid.org/docs/FAQ_-_App_Developers/).
- **Metadata** (https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/): `fastlane/metadata/android/<locale>/` with title ≤50, short ≤80 and full ≤4000 characters, and changelogs ≤500.
- **Stance:** F-Droid "unequivocally advise[s] against signing up" for Google's verification (open letter, 2026-02-24).

### Repo

- No privacy policy exists anywhere in the repo (see Phase 20 Evidence).
- The canonical repository is `SiavZ/yaran` (`CLAUDE.md:6`). A URL under `https://github.com/SiavZ/yaran/` is therefore real and not invented.
- The preview container already ships a fake streaming provider and seeded repos (`tools/preview-env/README.md:17-33`, `fake-agent.sh`).
- R5 §Store-policy risks ranks Apple 4.2.7(a), reviewer access and Google verification as HIGH.

## In scope

- Publisher Cloudflare accounts.
- The publisher domain site: association files and the callback landing page.
- The production relay.
- The demo review environment.
- Apple and Google accounts, identifiers, developer verification and declarations
  (verifying 18's Play App Signing enrollment, not performing it).
- The privacy manifest, nutrition labels and Data Safety form.
- Export compliance.
- Review notes.
- `PRIVACY.md` and support templates.
- Store metadata and screenshots.
- The F-Droid merge request.
- Verifying the content of the in-app licenses screen.
- Starting the Play closed test and TestFlight external testing.

## Out of scope

| Item | Owner |
|---|---|
| Rolling out to the public, alert thresholds, on-call, runbooks | 22 |
| Release pipelines and signing automation | 18. This phase supplies their remaining secrets and identifiers. |
| Generating the Android app-signing and upload keys and enrolling Play App Signing (before any Play upload) | 18 (work item 9, D23) |
| Checking the committed and live association files at release time | 18 (`check-association.mjs`) |
| The licenses screen itself and the update notice | 14 |
| The data inventory | 20 |

## Design

### Three publisher Cloudflare accounts, never shared

| Account | Holds | Why separate |
|---|---|---|
| `publisher-staging` (already used by 19) | E2E org, staging relay | Test traffic and credentials never touch production |
| `publisher-relay` | Production `cloud/push-relay` on the `<publisher-relay>` custom domain | Its compromise must not expose a demo or staging org. It holds the APNs key (T40) |
| `publisher-demo` | Demo org Worker, deployed with the **Deploy button** (dogfooding Phase 07), plus the demo machine's tunnel | Reviewer credentials circulate. Blast radius stays limited to fake data |
| `publisher-web` | The `<publisher-domain>` zone and the static site that serves the association files and the callback landing page | Whoever controls these files decides which app receives every release-build handoff callback (T63). Neither a relay nor a demo compromise may reach them |

Real hostnames are supplied by the maintainer as build and deploy variables (D16). The repo
holds only placeholders until the maintainer commits the real values. The relay URL reaches
the iOS build through the build-time setting defined in 08 and 18. The publisher domain is
committed once, in 18's `publisher.json`, and every callback is derived from it.

### Publisher domain site (D8, R2; T63)

**What it serves.** A static Workers site (assets only, no code paths that read requests) in
the `publisher-web` account, on `<publisher-domain>`:

- `/.well-known/assetlinks.json`: `delegate_permission/common.handle_all_urls` for the real
  `applicationId`, with the SHA-256 in 18's `mobile/android/signing/app-signing-cert.sha256`.
  One statement covers Play, GitHub and F-Droid installs, because they all carry the D14 key.
- `/.well-known/apple-app-site-association`: an `applinks` entry for
  `<TeamID>.<bundle id>` with the paths `/auth/callback` and `/oauth/callback` (02 §8,
  §10 URI table), served as `application/json` with no redirect and no extension.
- `/auth/callback` and `/oauth/callback`: a no-script landing page for a browser that
  reaches the callback without the app (app not installed, link not verified yet). It says
  to open the yaran app, links to the store listings, never echoes the query or fragment,
  sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and the site has
  logging off. The `jwe` it might receive is sealed to the phone's ephemeral key, so it is
  ciphertext to anyone else (T36).

**Source.** The files are committed under `publisher-site/` (CODEOWNERS-protected by 18)
and deployed by `publisher-site-deploy.yml` from `main` through a protected `publisher-web`
environment. 18's `check-association.mjs` gates the commit (fingerprint, ids, paths) and,
with `--live`, every stable mobile release.

**Custody.** The domain is registered by the maintainers with registrar lock and
auto-renew, and its renewal date is in `publisher-infrastructure.md`; 22 monitors the live
files daily. Losing the domain disables the release-build callback for every installed app
(availability), and a new holder could vouch for another app (T63), so domain custody is
treated like signing-key custody.

### Demo review environment (answers 2.1 and Play app access)

**Machine.** One always-on Linux VM runs the preview-env image with a new `demo` compose
profile:

- `fake-agent.sh` agents seeded across two projects;
- a demo provider variant that raises the agent attention signal every 15 minutes, so a
  reviewer receives a real push (the exact signal is taken from `attention.rs`, as 12 does);
- yaran running with Cloud Connect, paired once by a maintainer to the `publisher-demo`
  org.

**Hardening.**

- The container runs non-root, with no host mounts besides its volumes.
- Egress is restricted to Cloudflare edge ranges plus the relay.
- The data volumes are reset to the seed every night.
- The VM holds no publisher secret except the demo tunnel credentials. A reviewer reaching a
  shell inside it gets a disposable container.

**Reviewer identity.**

- Email PIN is unusable, because reviewers cannot read our mailbox. GitHub and Google
  accounts trigger new-device challenges (UNVERIFIED for GitHub's device-verification
  email, but that is the risk).
- The demo org therefore uses an Access **generic OIDC** identity provider backed by
  **Dex** (Apache-2.0), with a single `staticPasswords` reviewer user and no MFA. Dex runs
  on the same VM behind its own hostname on `publisher-demo`.
- The demo org's pairing and user allowlist contains only the reviewer email and the
  maintainers.
- Whether Access accepts Dex as a generic OIDC IdP is **UNVERIFIED** and is proven in work
  item 3 before anything depends on it.
- **Fallback:** Access One-time PIN, plus a reviewer-readable inbox on a publisher-owned
  mail route. Cloudflare Email Routing would forward to a Worker that shows the latest PIN
  behind a separate static secret given in the review notes. This is designed but is used
  only if the Dex proof fails.

**Uptime.** A scheduled GitHub workflow, `demo-healthcheck.yml`, runs every 30 minutes. It
checks that `/v1/meta` on the demo org answers and that the demo machine reports online
through the org API, and it opens an issue on failure. Phase 22 adds alerting on top.

### Positioning for Apple 4.2 / 4.2.7 / 2.5.2 (review notes text, owned here)

**Category: Developer Tools.** The app is a client for **self-hosted server software**
that the user installs on their own computer, in the same family as Home Assistant or
Plex. It is not a screen mirror. It does not stream frames from the host; it talks to a
server's API and web interface.

**Native value, listed explicitly:**

- QR onboarding;
- native SSO through `ASWebAuthenticationSession` with a verified https (Universal Link)
  callback, a one-tap consent page and a sealed handoff;
- end-to-end encrypted push decrypted in a Notification Service Extension;
- biometric lock;
- a native machine list with live status;
- file attach;
- an app-switcher privacy cover.

**2.5.2.** The remote interface is the user's own server's web page, rendered by WebKit
(2.5.6). It does not add features to the app binary.

**4.2.7(c).** Accounts are created and managed by the user's organization, never in the
app.

**5.1.1(v).** The app never creates accounts. In-app "Sign out of org" and "Remove this
device" exist anyway.

**4.8.** Sign-in uses existing enterprise accounts.

**Precedents.** The notes cite Spaces (https://apps.apple.com/app/id6791713994) and CC
Pocket (https://apps.apple.com/app/id6759188790) from R5 §4.

**Conflict reported.** R5's mitigation "note that LAN/Tailscale connections are also
supported" is **not available**, because the owner decided the app speaks Cloudflare only.
If App Review rejects under 4.2.7(a):

1. Reply in Resolution Center with the self-hosted-server positioning.
2. Appeal to the App Review Board.
3. Then escalate to the owner. The only remaining remedy is a scope change (adding a LAN
   transport), which this plan may not make on its own.

### Disclosures, derived only from `docs/operations/data-inventory.md` (20)

**Working conclusion, confirmed row by row in work item 7 against the inventory:**

- The **publisher** collects nothing. The relay processes APNs tokens and ciphertext only
  in real time, which matches Apple's "longer than necessary … in real time" carve-out and
  Google's ephemeral and end-to-end encrypted exemptions.
- Data sent to the org's own Worker and machine is held by the user's organization. It is
  not accessible to the publisher.
- The `play` flavor's embedded FCM library transmits a registration to Google. Under
  Google's rule that SDK transmissions count, it is declared as **Device or other IDs,
  collected, for app functionality, not shared** (Google acting as a service provider).
  The apps include no analytics or crash SDK (Phase 14).

Apple and iOS declarations:

- Privacy manifest: `NSPrivacyTracking=false`, no tracking domains, collected data types per
  the inventory (expected empty for the publisher).
- Required-reason APIs: each one actually used by Capacitor core and every plugin, found by
  a symbol audit of the built app, not by guessing. UserDefaults `CA92.1` at least, if
  preferences are used.
- **Export compliance:** all iOS crypto (P-256 ECDH with the JWE Concat KDF over CryptoKit
  SHA-256, and AES-256-GCM, for the handoff; ECDH, HKDF and AES-128-GCM for RFC 8291 push
  decryption) goes through **CryptoKit** in native code (D22: the handoff opener is
  native), which is
  "encryption within the Apple operating system". So `ITSAppUsesNonExemptEncryption=NO`,
  with no documentation required. A check fails the build if any third-party crypto library
  is linked into the iOS targets. If one ever becomes unavoidable, the French declaration
  path applies.

### Signing enrolment order (D14, D23, T46; irreversible, so done in Phase 18)

Steps 1–3 are **Phase 18's** (work item 9, D23), done in Wave B before any upload of the
package to Play on any track:

1. Generate the app-signing key: 4096-bit RSA, valid for 30+ years past 2033. Keep it
   offline with two backups, per Phase 20's playbook.
2. Generate a separate upload key.
3. Enrol Play App Signing with "use your own key" via PEPK export, and commit the
   enrollment record (`mobile/android/signing/play-enrollment.json`) and the certificate
   fingerprint (`mobile/android/signing/app-signing-cert.sha256`). 18's
   `check-versions.mjs --play` refuses every Play upload until both exist and agree.

This phase then:

4. Verifies the enrollment: Play Console's App signing page shows the committed SHA-256, and
   no upload predates `enrolled_at`.
5. Registers the package and the app-signing key under developer verification in Play
   Console, as the single place for apps distributed outside Play (FAQ). The GitHub APK and
   F-Droid builds carry the same key, so one registration covers all Android channels.
   F-Droid's open letter advises against registering. The publisher registers anyway,
   because Play requires it. F-Droid users are unaffected, because F-Droid publishes our
   developer-signed APK (`Binaries`/`AllowedAPKSigningKeys`).

**This phase uploads nothing to Play by hand.** Every upload goes through 18's workflows,
which carry the enrollment gate. **Ordering hazard, kept as a check.** If anything reached
Play before 18's enrollment, Play may already hold a Google-generated key. Work item 4 checks
that first. If it finds a mismatch, it stops and escalates, because the package name would
have to change.

## Work items

1. **Publisher Cloudflare accounts and custody.**
   - Create the `publisher-relay` and `publisher-demo` accounts with hardware-key MFA for
     every member and at least two maintainers.
   - Populate 18's `push-relay-production` environment, and create the `demo` and
     `publisher-web` environments (protected; required reviewers); record them in
     `.github/BRANCH_PROTECTION.md` beside 18's.
   - Create the `publisher-web` account the same way, and record the Play Console
     organization account that 18 opened for D23.
   - Create `docs/operations/publisher-infrastructure.md`: accounts, owners, environments,
     where each secret lives (pointing into `key-compromise-playbooks.md`), and the renewal
     dates (Apple membership, distribution certificate, D-U-N-S, `<publisher-domain>`).
   - Test: a checklist review is recorded in the PR.
2. **Production relay.**
   - Create the APNs auth key (`.p8`, token-based; certificate auth is not viable, R4 HC12)
     and store it only as a relay secret.
   - Deploy `cloud/push-relay` through `release-cloud`'s `push-relay-production`
     environment (18) to the `<publisher-relay>` custom domain. Apply the relay's rate limits as
     configured in 08 and the observability settings: counters only, and no token logging,
     which Phase 20 verified.
   - Add `relay-canary.yml`, which runs every 30 minutes. It sends a VAPID-signed push to a
     canary endpoint minted for a maintainer's test iPhone. APNs 200 means healthy, and a
     failure opens an issue.
   - If G4 adopted the fallback (a relay outside Workers), deploy that variant instead, with
     the same canary.
   - Tests: the canary passes 48 h continuously; the relay's own test suite runs against
     production config in dry-run.
3. **Demo review environment.**
   - Add a `demo` profile in `tools/preview-env/compose.yml`, a Dex service config
     `tools/preview-env/demo/dex.yaml` (the reviewer password comes from an env secret, not
     committed), the attention-raising demo provider script `tools/preview-env/demo/demo-agent.sh`
     (header per 00-CONVENTIONS §2), a nightly reset script, and an egress firewall script.
   - Deploy the `publisher-demo` org with the Deploy button, recording every manual step it
     needed. Phase 07's docs are corrected if a step was missing.
   - Prove Dex as an Access generic OIDC IdP. Fallback to the PIN inbox if that fails.
   - Pair the demo machine. Add `demo-healthcheck.yml`.
   - Tests: on a fresh device, a reviewer-path walkthrough on iOS and Android (scan the QR
     from the notes, Dex login, tap Continue on the consent page, machine list, open the
     machine and tap Continue again for the machine handoff, receive a push within 15 min),
     recorded as screen captures in `docs/audits/audit04-cloud-connect/10-review-path/`.
4. **Android signing verification and developer verification.**
   - Record the Play organization account and its D-U-N-S number (opened by 18 for D23) in
     the publisher doc.
   - Verify 18's enrollment (Signing enrolment order, step 4): Play holds the D14 key whose
     SHA-256 is in `mobile/android/signing/app-signing-cert.sha256`, and nothing reached Play
     before `play-enrollment.json`'s `enrolled_at`. On a mismatch, stop and escalate. Then
     register developer verification for the package and key. The committed fingerprint is
     what F-Droid's `AllowedAPKSigningKeys`, 18's verification step and `assetlinks.json`
     all use.
   - Tests: `apksigner verify --print-certs` on the GitHub APK, the Play-delivered APK
     (internal app sharing) and the local foss build all print the same SHA-256.
5. **Publisher domain site (T63).**
   - Create `publisher-site/` (static assets: the two association files and the callback
     landing page, as in Design) and `.github/workflows/publisher-site-deploy.yml`
     (SHA-pinned actions, `publisher-web` environment, deploys only from `main`).
   - Attach `<publisher-domain>` to the site in the `publisher-web` account, with registrar
     lock and auto-renew on.
   - Tests: 18's `check-association.mjs --live` passes; `adb shell pm get-app-links
     <applicationId>` shows the domain verified on a GitHub-channel install; on iOS a link to
     `https://<publisher-domain>/auth/callback` opens the TestFlight build, and Apple's CDN
     copy of the AASA matches; the landing page renders with no script and its response
     headers carry `no-store` and `no-referrer`.
6. **Apple account and identifiers.**
   - Organization enrolment (D-U-N-S; Apple's lead time is UNVERIFIED, so start it on day
     one).
   - Bundle IDs for the app and `…NotificationService`, an App Group and keychain access
     group shared with the NSE (16), the Push Notifications capability, and the
     distribution certificate and provisioning via 18's `match`.
   - Create the App Store Connect record: name, Developer Tools category, age rating
     questionnaire, the iPad support decision (15 supports iPad, so the 13" screenshots are
     required).
   - Test: `release-mobile` produces an archive accepted by App Store Connect processing.
7. **Privacy disclosures.**
   - Create `mobile/ios/App/App/PrivacyInfo.xcprivacy` and the NSE's manifest, if it uses
     required-reason APIs.
   - Write a required-reason symbol audit script, `mobile/ios/scripts/required-reason-audit.sh`
     (header), using `nm` over the built frameworks. Its output goes into the PR.
   - Fill in the App Store Connect nutrition labels and the Play Data Safety form from the
     inventory, with a mapping table appended to `data-inventory.md` (inventory row, then
     Apple answer, then Google answer).
   - Set `ITSAppUsesNonExemptEncryption=NO` in `Info.plist`, and add a CI check that fails
     if a non-Apple crypto library is linked.
   - Tests: Xcode privacy report generated from the archive matches the manifest; the CI
     crypto-link check runs with a positive fixture.
8. **Privacy policy and support.**
   - Create `PRIVACY.md` at the repo root. Its URL is
     `https://github.com/SiavZ/yaran/blob/main/PRIVACY.md`. It covers:
     - what the publisher processes (relay: real time only);
     - what the org controls (Worker and machine data) and who to contact (their admin);
     - Cloudflare, Apple, Google and distributors as processors, including the D17 edge
       decryption;
     - retention and deletion, and how to revoke (sign out, remove device, admin revoke);
     - children (not directed at children);
     - the contact (`SECURITY.md` email for security; issues for the rest);
     - its own effective date.
   - Link it from the app (14's About screen), both store records, `README.md`, and
     `cloud-security-privacy.md`.
   - Support: create `.github/ISSUE_TEMPLATE/mobile-app.yml` and `cloud-connect.yml`. These
     ask for app version, channel, OS, protocol version from Settings → Diagnostics, and
     never tokens. The support URL is `https://github.com/SiavZ/yaran/issues`.
   - Tests: the Phase 17 domain guard extended to `PRIVACY.md`; links checked by the
     website build where cited.
9. **Store listings and screenshots.**
   - Android metadata: `fastlane/metadata/android/en-US/` at the repo root, the one path
     F-Droid reads (00-README layout; 18) (`title.txt`,
     `short_description.txt`, `full_description.txt`, `images/`, `changelogs/<versionCode>.txt`).
     These are shared by Play and F-Droid.
   - iOS metadata: `mobile/fastlane/metadata/` for `deliver`. App Store field length limits
     are UNVERIFIED here and are checked against App Store Connect at entry.
   - The copy states:
     - that the app requires the user's own yaran and an org control plane;
     - the D17 edge decryption;
     - no invented domains.
   - Screenshots: create `screenshots_ios` and `screenshots_android` fastlane lanes that
     drive the demo environment with the E2E driver selected in 19, at the required sizes
     (iPhone 1206×2622 or 1179×2556; iPad 13" 2048×2732 or 2064×2752; Play phone).
   - Tests: a metadata-length check in `mobile-ci` (18) for the F-Droid limits; screenshot
     dimensions asserted by the lane.
10. **In-app licenses content check.**
   - Confirm that 14's licenses screen renders 18's generated inventory for the exact
     release build (Capacitor, plugins, the QR decoder, Kotlin and Swift dependencies), and
     that the `foss` build lists no proprietary component.
   - Test: an instrumentation or UI test asserting the screen lists a known dependency, plus
     a diff of the inventory against the build's dependency report.
11. **F-Droid submission.**
    - Open a merge request to `fdroiddata` with `metadata/<applicationId>.yml`, starting from
      18's tested draft `mobile/fdroid/<android-app-id>.yml`:
      - `Binaries:` set to the GitHub release APK URL with `%v`;
      - `AllowedAPKSigningKeys:` set from `mobile/android/signing/app-signing-cert.sha256`;
      - `UpdateCheckMode: Tags ^yaran-mobile-v\d+\.\d+\.\d+$`, following D15. This
        corrects R5's `yaran-v` pattern.
      - `AutoUpdateMode: Version`;
      - literal `versionCode` and `versionName` (R5 §7.7);
      - the `foss` flavor `subdir`;
      - `prebuild` steps as proven by G7.
    - **Anti-features:** propose **NonFreeNet**, because the app depends entirely on
      Cloudflare's proprietary network, and not TetheredNet, because the org server is
      self-hostable. F-Droid reviewers decide (UNVERIFIED how they will tag it).
    - Run `fdroid build` and `fdroid publish` locally against the release candidate and
      confirm the rebuild matches the developer-signed APK.
    - Tests: fdroiddata CI green on the MR; local reproducibility log in
      `docs/audits/audit04-cloud-connect/11-fdroid.md`.
12. **Testing tracks started.**
    - Play: run a closed test on `play` with at least 12 testers opted in, and start the
      14-day clock now. This applies whether or not the organization exemption holds; it is
      cheap insurance and doubles as 22's beta cohort.
    - Configure the app-access instructions (Dex reviewer credentials, QR, demo org URL, and
      "tap Continue on the sign-in confirmation page") in one of the five instruction sets.
    - All Play uploads come from 18's workflows (the D23 gate); none by hand.
    - TestFlight: an external group, with review notes attached. The first build goes
      through Beta App Review.
    - Tests: the TestFlight external build is approved and the Play closed test is live,
      with screenshots of both consoles in `00-summary.md`.

## Acceptance

- [ ] `publisher-relay`, `publisher-demo` and `publisher-web` accounts exist with hardware-key MFA. `docs/operations/publisher-infrastructure.md` lists every account, owner, secret location and renewal date.
- [ ] The production relay serves on `<publisher-relay>` (real value only in deploy config), and the canary has passed for 48 h.
- [ ] The demo environment is up. The Dex reviewer login (or the fallback) works on a fresh device. A push arrives within 15 minutes. The nightly reset and the healthcheck run.
- [ ] Play App Signing holds the D14 key that 18 enrolled before any upload (D23). One SHA-256 is printed by every Android channel's APK and recorded in `mobile/android/signing/app-signing-cert.sha256`. Developer verification registration is complete.
- [ ] `<publisher-domain>` serves `assetlinks.json` and `apple-app-site-association` matching the committed files; the release-build callback opens the app on Android (verified App Link) and iOS (Universal Link); `check-association.mjs --live` passes; the domain has registrar lock and auto-renew.
- [ ] The Apple identifiers, App Group, NSE and push capability exist, and App Store Connect accepts the archive.
- [ ] The privacy manifest, nutrition labels and Data Safety form match `data-inventory.md` through the mapping table. `ITSAppUsesNonExemptEncryption=NO`, and the crypto-link check is in CI.
- [ ] `PRIVACY.md` is published and linked from the app, both stores, the README and the docs. The issue templates exist.
- [ ] Store metadata and screenshots are complete at the required sizes, and the copy states the requirements and D17.
- [ ] The licenses screen matches the generated inventory, and the `foss` build has no proprietary entries.
- [ ] The fdroiddata MR is open with CI green, and the local `fdroid build` reproduces the developer-signed APK.
- [ ] TestFlight external testing is approved, and the Play closed test runs with at least 12 testers.

## Validation

```bash
cd /Users/siavash/Projects/yaran
# one signing cert across channels
for apk in dist/github/*.apk dist/play-internal/*.apk dist/foss-local/*.apk; do
  apksigner verify --print-certs "$apk" | grep 'SHA-256'; done | sort -u | wc -l   # expect: 1
diff <(apksigner verify --print-certs dist/github/*.apk | awk '/SHA-256/{print $NF}') mobile/android/signing/app-signing-cert.sha256
node tools/release-trains/check-versions.mjs --play                 # 18's D23 enrollment gate passes
node tools/release-trains/check-association.mjs --live              # live association files match
curl -fsSI "https://${PUBLISHER_DOMAIN}/.well-known/apple-app-site-association" | grep -i '^content-type: application/json'
plutil -lint mobile/ios/App/App/PrivacyInfo.xcprivacy
/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' mobile/ios/App/App/Info.plist   # expect: false
mobile/ios/scripts/required-reason-audit.sh build/App.xcarchive
for f in title short_description full_description; do wc -m fastlane/metadata/android/en-US/$f.txt; done
curl -fsS "https://${DEMO_ORG_HOST}/v1/meta" | jq -e '.protocol'
gh run list --workflow relay-canary.yml --limit 96 --json conclusion -q '[.[]|select(.conclusion!="success")]|length'   # expect: 0
grep -n 'PRIVACY.md' README.md website/docs/cloud-security-privacy.md
(cd website && npm test)
```

## Risks

| Risk | Mitigation |
|---|---|
| Apple rejects under 4.2.7(a) (LAN-only), and the Cloudflare-only decision removes R5's LAN/Tailscale argument | Self-hosted-server positioning, native-value list and precedents in the notes. Resolution Center, then the App Review Board, then escalate to the owner (scope change). |
| Reviewer cannot sign in (the 2.1 rejection most common for login apps) | Dex static user with no MFA. A proven fallback inbox. The walkthrough is recorded on a fresh device before submission. The demo healthcheck runs every 30 min. |
| Play already holds a Google-generated key from an earlier upload | 18 enrolls before any upload (D23) and gates every Play path with `check-versions.mjs --play`; this phase uploads nothing by hand. Work item 4 still checks, and stops and escalates on mismatch. |
| `<publisher-domain>` lapses or its association files are altered, so the release callback stops opening the app or vouches for another app (T63) | Separate `publisher-web` account, registrar lock and auto-renew, CODEOWNERS on `publisher-site/`, 18's live check on every stable mobile release, 22's daily check. The envelope stays sealed to the app's key (T36). |
| D-U-N-S or Apple organization enrolment lead time (up to 28 days for Google) | Google's is started on the first day of Wave B, because 18's D23 enrollment needs the Play account; start Apple's then too, since it has no code dependency. |
| F-Droid tags NonFreeNet or rejects the npm build | Propose NonFreeNet ourselves. G7 proved the build. Reproducibility is verified locally first. |
| F-Droid community objects to Google verification registration | Explain in the MR that F-Droid publishes our developer-signed APK, so nothing F-Droid signs is affected. |
| A demo-environment compromise (reviewer credentials are semi-public) | Disposable container, egress limits, nightly reset, separate Cloudflare account, no publisher secrets on the VM. |
| The Data Safety or nutrition label reading of org-held data is challenged | Answers are traced to inventory rows. If a store disagrees, follow the store's reading and update the mapping table. |

## References

- Apple: Review Guidelines; privacy manifest files; third-party SDK requirements; app privacy details; export compliance (both pages); screenshot specifications; TestFlight overview; upcoming requirements (all fetched 2026-11-14; URLs in Evidence)
- Google: Data safety (10787469); target SDK; testing requirements (14151465); app access (9859455); developer verification and FAQ; Device and Network Abuse (16559646); `REQUEST_INSTALL_PACKAGES` (12085295) (all fetched 2026-11-14)
- F-Droid: Inclusion Policy; Anti-Features; Reproducible Builds; FAQ for App Developers; descriptions and graphics docs; open letter (2026-02-24) (all fetched 2026-11-14)
- `research/R5-mobile.md` §4, §Store-policy risks, §7
- `research/R4-cloudflare.md` Hard constraint 12
- `20-security-review-and-hardening.md` (data inventory, playbooks)
- `18-build-ci-and-release-pipelines.md` (work item 9 D23 enrollment, `publisher.json`, `check-association.mjs`, environments); `02-protocol-contract.md` §8 (https callback, allowlist); `00-README.md` D8, D14, D16, D23; `17-docs-website-threat-model.md` T40, T46, T63

## Reconciliation notes (2026-11-14)

- Goal, In scope, Out of scope: the Android app-signing key generation and Play App Signing enrollment move to 18 (work item 9), done before any Play upload; this phase verifies and registers developer verification (R13, D23).
- Signing enrolment order rewritten: steps 1–3 are 18's with the `--play` gate; this phase uploads nothing to Play by hand; the ordering-hazard check is kept (R13).
- New Design section "Publisher domain site" and new work item 5: `publisher-web` account, `assetlinks.json` and `apple-app-site-association` covering `/auth/callback` and `/oauth/callback`, a no-script callback landing page, deploy workflow, domain custody (R2, T63). Later work items renumbered 6–12; the one cross-reference updated.
- Accounts table gains `publisher-web`; work item 1 creates it and records the Play account 18 opened (R2, R13).
- Environment name `relay-production` → 18's `push-relay-production` (R20).
- `mobile/android/SIGNING_CERT_SHA256.txt` → 18's `mobile/android/signing/app-signing-cert.sha256` everywhere (R20).
- Android metadata path `mobile/fastlane/metadata/android/` → root `fastlane/metadata/android/` per 00-README layout and 18 (R20).
- Export compliance: "HKDF … for the handoff" corrected to the JWE Concat KDF with AES-256-GCM; HKDF kept only for RFC 8291 push; crypto stated as native CryptoKit per D22 (R1, R12).
- Native value list and reviewer walkthrough/app-access text mention the https callback and the consent tap (R2).
- F-Droid MR starts from 18's tested recipe draft (R20).
- Acceptance, Validation, Risks, References extended for D23, T46, T63 and the association files; nothing removed. D-U-N-S risk now says Google's starts in Wave B (D23).

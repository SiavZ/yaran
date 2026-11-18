# Phase 14 — Mobile: Capacitor app foundation and bundled shell UI

**Track:** B (mobile) · **Parallel-safe with:** 04–13, 15–18 (Wave B; 15 and 16 build on this phase's scaffolding, but each one develops against the interfaces fixed here)
**Depends on:** 01 (header and 500-line gate), 02 (contract: `/v1/meta`, user API, URI schemes, error envelope), 03 (G6 outcome; G7 for the `foss` build; G13 for the callback filters) · **Blocks:** 15 (the shell hosts `machine-view` and `session`), 16 (app, flavors, settings rows), 18 (mobile CI targets, publisher build config), 19 (Wave C)

## Goal

Ship the native app shell for Android and iOS: a Capacitor project whose **bundled** React
shell UI covers onboarding (scan the QR code or type the org URL, run the `/v1/meta` protocol
check, sign in), the org and machine lists, settings, and every empty, error and offline state.
The phase also delivers:

- the device-local security base: a Keystore/Keychain vault, an optional biometric app lock,
  screen privacy, backup exclusion and local diagnostics;
- i18n with an English baseline and accessibility on both platforms;
- the `foss`/`play` flavor split, guarded so that `foss` stays free of Google libraries;
- the publisher build config (application and bundle ids, team id, publisher callback domain,
  relay URL, Play push transport, e2e test defaults) that Phase 18 checks and Phase 21 fills;
- a shared `@yaran/ui-kit` package (`packages/ui-kit/`) holding the design tokens and
  primitives. It is the one shared UI package: the web UI and the shell consume its tokens and
  components, and Phase 07's Worker console consumes its plain-CSS tokens (R18).

The remote yaran UI is never bundled (D10). This phase builds the shell that opens it through
Phase 15's `machine-view`.

## Evidence

All online sources were read on 2026-11-14.

- **Capacitor versions.**
  - Stable is **8.6.2** (2026-11-12). **9.0.0-rc.0** shipped on 2026-11-12, and 9 is not GA yet
    (https://github.com/ionic-team/capacitor/releases).
  - Capacitor 8 requires iOS 15.0, Xcode 26+, Android minSdk 24 with compile and target SDK 36,
    and Node 22+. New iOS projects use SPM by default
    (https://capacitorjs.com/docs/updating/8-0). This plan raises the iOS deployment target to
    **17.4**, because release builds return from sign-in on an
    `ASWebAuthenticationSession` `.https` callback, which needs 17.4 (D8, Phase 15).
  - Apple's `ASWebAuthenticationSession.Callback.https(host:path:)` needs the host in the app's
    associated domains (`webcredentials:`), and Universal Links need `applinks:`
    (https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback;
    re-verify the exact service type at implementation, per 00-CONVENTIONS §4).
  - The Capacitor 9 minimums are **UNVERIFIED**: there is no 9.0 upgrade page yet.
- **Config options.**
  - `android.path` and `ios.path` place the native projects anywhere; their defaults are
    `android` and `ios`.
  - `server.androidScheme` defaults to `https`, and `server.iosScheme` to `capacitor`.
  - `android.flavor` selects the flavor, and `cap run`/`cap build` accept `--flavor`. Flavor
    *dimensions* are not supported.
  - `webContentsDebuggingEnabled` defaults to `false`.
  - Source: https://capacitorjs.com/docs/config
- **Bridge security.** The bridge does not check the caller's origin on either platform
  (R5 §1 fact 7). This is why D9 makes the bundled shell the only bridge-enabled page, and why
  the shell gets a strict CSP (work item 2).
- **Plugin mechanics.**
  - A plugin can use `getActivity()`, the `handleOn*` lifecycle hooks,
    `startActivityForResult(call, intent, cb)` with `@ActivityCallback`, and `bridge.viewController`
    on iOS (https://capacitorjs.com/docs/plugins/android, https://capacitorjs.com/docs/core-apis/ios).
  - Local plugins are installed as `file:` dependencies. `cap sync` writes them into
    `capacitor.settings.gradle` and `capacitor.build.gradle`, and into the generated
    `CapApp-SPM/Package.swift` (https://capacitorjs.com/docs/plugins/workflow; CLI source
    `cli/src/android/update.ts`, `cli/src/util/spm.ts`).
  - Whether one plugin's native module can depend on another plugin's module is **UNVERIFIED**.
    This plan avoids that by putting shared native code in one non-plugin library (work item 3).
- **SystemBars and edge-to-edge.**
  - SystemBars ships in core. Its Android `insetsHandling` defaults to `css`, and "Starting in
    Capacitor 9, insetsHandling will default to native"
    (https://capacitorjs.com/docs/apis/system-bars).
  - `adjustMarginsForEdgeToEdge` was removed in 8.
- **Camera in the WebView.**
  - Capacitor's `BridgeWebChromeClient` maps `VIDEO_CAPTURE` to a runtime CAMERA request
    (`BridgeWebChromeClient.java`).
  - WKWebView has had `getUserMedia` since iOS 14.3. Whether it works under `capacitor://localhost`
    is **UNVERIFIED**: the evidence is forums and WebKit bug 220184 only.
- **QR decoding.**
  - **zxing-wasm 3.1.6** (2026-10-19) is MIT-licensed and actively maintained. Its reader-only
    wasm is 946,860 B. It can be self-hosted through `prepareZXingModule({ overrides: { locateFile } })`;
    without that it defaults to the jsDelivr CDN.
  - jsQR has had no release since 2021, and `@zxing/library` is in maintenance mode.
  - `BarcodeDetector` "requires Google Play Services on Android", so it is absent on de-Googled
    devices (https://github.com/Sec-ant/zxing-wasm, https://developer.chrome.com/docs/capabilities/shape-detection).
  - ML Kit is NonFree to the F-Droid scanner (R5 §1 fact 11, §6).
- **Secure storage.**
  - Jetpack `security-crypto` 1.1.0 "Deprecated all APIs in favour of existing platform APIs and
    direct use of Android Keystore" (https://developer.android.com/jetpack/androidx/releases/security).
  - Relevant `KeyGenParameterSpec.Builder` methods:
    - `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG|AUTH_DEVICE_CREDENTIAL)` (API 30)
      requires authentication on every use, and a CryptoObject is allowed with a timeout of 0.
    - `setInvalidatedByBiometricEnrollment` defaults to true.
    - `setUnlockedDeviceRequired` should be used on Android 15+ only.
    - Sources: https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder,
      https://developer.android.com/identity/sign-in/biometric-auth
  - androidx.biometric: the stable release is 1.1.0 and the beta is 1.4.0-beta01.
  - iOS:
    - `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and `AfterFirstUnlockThisDeviceOnly` never
      migrate to another device.
    - `.biometryCurrentSet` invalidates the item when biometrics are re-enrolled.
    - App-group keychain sharing uses `group.` IDs and has no team prefix.
    - Sources: https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps,
      https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id
- **Backup.** `allowBackup` defaults to true. Use `dataExtractionRules` on Android 12+ and
  `fullBackupContent` on Android 11 and earlier
  (https://developer.android.com/identity/data/autobackup).
- **Store and build baselines.**
  - Since 2026-08-31, Play requires target API 36 (R5 §4.15).
  - Since 2026-04-28, App Store uploads need Xcode 26 and the iOS 26 SDK
    (https://developer.apple.com/news/upcoming-requirements/).
  - `UIRequiresFullScreen` is deprecated in iPadOS 26.
- **i18n and licenses.**
  - Lingui 6.12.0 (MIT) has native ICU plurals and compiled catalogs, at about 2.5 + 1.8 kB.
  - For license lists: rollup-plugin-license 3.7.2 (MIT), AboutLibraries 15.3.0 (Apache-2.0,
    `exportLibraryDefinitions`) and LicensePlist 3.28.3 (MIT).
  - Google's `oss-licenses-plugin` needs Play services, so it is not F-Droid clean
    (https://lingui.dev/introduction, https://github.com/mikepenz/AboutLibraries,
    https://github.com/mono0926/LicensePlist).
- **Repo facts** (verified 2026-11-14; paths under `crates/yaran-web/web/` unless rooted):
  - The tokens are CSS-first Tailwind v4 in `src/index.css`:
    - the `@custom-variant dark` at :98
    - the `@theme inline` block at :100-201
    - the raw `:root` at :333-383 and `.dark` at :385-425
    - the font tokens at :101-107
    - the Geist import at :4

    The same file also mixes in app CSS: xterm rules, terminal fonts and keyframes.
  - The web is dark-only: `src/main.tsx:8-9` and `src/components/ui/sonner.tsx:84`.
  - `components.json` uses style `base-nova`, iconLibrary `lucide`, and the aliases `@/components/ui`
    and `@/lib/utils`.
  - 30 primitives live in `src/components/ui/`, 19 of them on `@base-ui/react`. A few depend on
    app code:
    - dropdown-menu, sonner, popover and sidebar on `@/hooks/use-mobile`
    - resizable and sidebar on `@/lib/paneDivider`
  - `InlineCode` is `src/components/ui/inline-code.tsx:11-22`.
  - The alias `@/*` is defined at `tsconfig.json:8`, `tsconfig.app.json:4` and `vite.config.ts:10`.
  - 93 non-test files import `@/components/ui/`.
  - `notify.ts` imports prose at :13. Its timing constants (:36-51) and `statusToastDuration`
    (:80-94) do not depend on prose. The notify boundary allow-list is at
    `src/lib/notifyBoundary.test.ts:51`.
  - The viewport meta is at `index.html:15`, pinned by `src/lib/viewportMeta.test.ts:30-56`.
  - The `build.rs` `rerun-if-changed` paths (`crates/yaran-web/build.rs:168-187`) are all under
    `web/`.
  - There are no npm workspaces anywhere.
  - `.github/dependabot.yml:34-35` covers npm for the web package only.
  - No `packages/`, `mobile/` or `cloud/` directory exists yet.

## In scope

- `packages/ui-kit/`, the shared tokens and primitives, and the web UI migration onto it. The
  kit's plain-CSS token file is also the input Phase 07's console reads (R18).
- `mobile/app/`, the bundled shell UI. It covers the onboarding, org, machine and settings
  screens, the empty, error, offline and locked states, i18n, and accessibility.
- `mobile/android/` and `mobile/ios/`: the native projects with their flavors, manifests,
  entitlements, privacy manifest, localized system strings and build guards.
- `mobile/plugins/core/`: a Capacitor-independent native library on both platforms containing
  the vault, app lock, diagnostics log, screen privacy and host rules.
- `mobile/plugins/secure-store/`: the Capacitor adapter that exposes the core library to the shell.
- `mobile/plugins/qr/`: the JS/WASM QR scanner, plus its designed native fallback.
- The license-list generation script, and the native color export from the ui-kit tokens.
- The publisher build config and its loader (`mobile/publisher.properties`, the generated
  `Publisher.xcconfig`), the dev-build warning, the `e2e`/`E2E` test build variants (Phase 19
  hook H4) and the e2e defaults in the build config (hook H6).
- A GitHub-releases link for `foss` builds in About (no update check, no installer; T50).

## Out of scope

| Item | Owning phase |
|---|---|
| `machine-view` WebView, `session` plugin (handoff client, per-host JWTs, org API client) | 15 (this phase codes against its TS definitions, which 15 lands first) |
| Push registration, distributors, NSE, permission UX, mute effect | 16 (this phase renders the settings rows and owns their local state) |
| Mobile CI workflows, signing, store uploads, F-Droid metadata, dependabot/CODEOWNERS lines, the `requirePublisherDomain` release flag and the association-file fingerprint check | 18 |
| `assetlinks.json` and `apple-app-site-association` hosting on `<publisher-domain>` | 21 |
| Worker console styling that reads the kit's tokens | 07 |
| Consumer docs pages, threat-model prose consolidation, NOTICE | 17 (each PR here still adds its own threat-model row, per CLAUDE.md) |
| Store listings, privacy labels/Data Safety, review notes, final privacy-manifest audit | 21 |
| Web UI native detection, control URLs, the "Switch machine" and "Phone app settings" menu entries (no ellipsis: they navigate, R19) | 13 |

## Design

### Package map (each package has its own `package.json` + lockfile v3, matching R3 §1)

```text
packages/ui-kit/                 @yaran/ui-kit (private, source-only .tsx/.css, peerDependencies);
                                 consumers: web UI, shell, Worker console (07, tokens.css only)
mobile/
├── app/                         shell UI (React 19, Vite 8, Tailwind 4, TS strict), capacitor.config.ts
│   └── capacitor.config.ts      android.path '../android', ios.path '../ios', webDir 'dist'
├── publisher.properties         publisher build values (D16 placeholders in the repo; 21 fills, 18 checks)
├── android/                     Gradle project; flavors foss | play (dimension "distribution"); build type e2e
├── ios/                         Xcode project (SPM); App target (+ NSE target added by 16); configuration E2E
└── plugins/
    ├── core/                    NOT a Capacitor plugin: android/ Gradle library, ios/ Swift package
    ├── secure-store/            Capacitor plugin pkg: SecureStore, AppLock, Diagnostics, ScreenPrivacy
    ├── qr/                      JS/WASM scanner package (zxing-wasm reader build, wasm bundled)
    ├── machine-view/            Phase 15 (MachineView, Session)
    └── push/                    Phase 16
```

`plugins/core` exists because cross-plugin native dependencies are unverified, and because the
G6 fallback reuses the native code without Capacitor. `packages/ui-kit` exists because the web
UI, the shell and the Worker console share it (R18). Both are in the 00-README layout. Neither
touches D1–D23.

### Trust model inside the app

- **The shell is the only page with a bridge** (D9). It is bundled, served from
  `https://localhost` on Android and `capacitor://localhost` on iOS, and locked down by a CSP:
  - `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'`
  - `img-src 'self' data: blob:; media-src 'self' blob:`
  - `style-src 'self' 'unsafe-inline'; connect-src 'self'`
  - `object-src 'none'; base-uri 'none'; frame-ancestors 'none'`

  The shell makes **no network request from JS**. Every Worker call, push registration
  included (Phase 16 calls it), goes through Phase 15's native `Session.request`/`Session.meta`,
  so CORS never applies and bearer credentials never enter JS (D22, T60).
- **Text from an org (org name, machine names) is rendered as React text, never as HTML.**
  Names inside dialogs render as `InlineCode` chips, following the web tenet.
- **The installed plugin set is minimal.** It is `@capacitor/app` (deep links, back button,
  app state), `secure-store`, `machine-view`, `push` and the core SystemBars. There is no
  analytics, crash or Firebase SDK in `foss`; `play` adds only Phase 16's embedded FCM
  distributor.

### Native core library (`mobile/plugins/core`)

| Module | Android (Kotlin) | iOS (Swift) |
|---|---|---|
| `Vault` | Encrypted blobs in `noBackupFilesDir/vault/<ns>.bin`, AES-256-GCM. The key is in AndroidKeyStore, non-exportable, with StrongBox when `KeyInfo` reports it is available. | One Keychain generic-password item per namespace, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Namespaces that Phase 16 needs in the NSE use `AfterFirstUnlockThisDeviceOnly` in the app group `group.<appId>`. |
| Protection classes | `standard` (device-bound, no user auth) and `locked` (encrypted with a data key that the AppLock key wraps). Sessions (Phase 15) go in `locked` when the lock is on. Push keys (Phase 16) always go in `standard`, because the background must reach them. | Same two classes. In `locked`, the data key is a Keychain item guarded by `SecAccessControl(.biometryCurrentSet)`, or by `.userPresence` when "Allow device passcode" is on. |
| `AppLock` | `BiometricPrompt` with a `CryptoObject` (Cipher, DECRYPT) on an auth-per-use key using `BIOMETRIC_STRONG`, or `BIOMETRIC_STRONG|DEVICE_CREDENTIAL` on API 30+ when passcode fallback is on. `KeyPermanentlyInvalidatedException` wipes the `locked` class and says so. | Reading the Keychain item triggers Face ID or Touch ID. An invalidated item wipes `locked` and says so. A bare `evaluatePolicy` gate is never used. |
| `Diagnostics` | Ring log: in memory, mirrored to `cacheDir/diag.log`. Capped at 1 MiB and 7 days. Every entry passes the sanitizer. | Same, in `Caches/`. |
| Sanitizer (pure, shared fixture) | Strips query strings and fragments, JWT-shaped strings (`eyJ…\.…\.…`), `Cookie`/`Authorization` values, and ANSI/OSC sequences. | Same rules, same fixture file. |
| `ScreenPrivacy` | Applies `FLAG_SECURE` to every app window when the setting is on. | Puts a cover view over the screen before the app-switcher snapshot is taken, and observes `sceneCaptureState` (iOS 17+). |
| `HostRules` (pure, shared fixture) | Accepts `https` only. Rejects userinfo, IP literals and IDN homograph mixes, normalizes case and the default port, and allows a path only for org URLs. | Same rules, same fixture file. |

The lock grace period is a user setting: **Immediately**, **1 min** (the default), **5 min** or
**15 min**. It is measured from the moment the app goes to the background. While the app is
locked, a native cover hides the shell and Phase 15's machine-view window until unlock succeeds.

### Shell screens and flow

```text
Welcome ─┬─ Scan QR ───────┐
         └─ Enter URL ─────┴─▶ Confirm org (/v1/meta: name, team domain, protocol check,
                                Cloudflare-edge disclosure D17) ─▶ Sign in (15) ─▶ Machines
Machines (per org; grouped when >1 org): row = name, status dot+word, last seen, ⋯ {Open, Remove…}
Orgs: list, add, ⋯ {Sign out of <org>…}
Settings: Notifications (16 rows) · Security (App lock, Allow device passcode, Lock after,
          Hide screen content) · Reopen last machine on launch · Language · Diagnostics (view, export…)
          · About & licenses (foss: GitHub releases link) · Erase everything on this phone…
States: empty (no orgs / no machines with the `yaran cloud login` hint), offline, error (envelope
        code → sentence), protocol mismatch (app too old / control plane too old), setup
        incomplete, phone removed (`device_revoked`), locked
Banner: development build (compiled without a publisher domain), on every screen
```

- **Confirm org** reads 02's `Meta`: `org.name`, `access.team_domain` and `protocol`. When
  `Meta.setup` is `open` it stops with the `setup_incomplete` sentence ("This control plane
  hasn't finished setup yet. Ask your admin to finish the setup page, then try again.") and
  offers no sign-in.
- **Development-build banner.** A build compiled without a publisher domain returns from
  sign-in on the custom scheme `yaranapp://auth/callback`, which any app can register, and sends
  `build=dev` (D8, Phase 02 §8; Phase 15 decides it from `Session.callbackMode()`). The shell
  then shows a persistent, non-dismissable banner on every screen: "Development build: sign-in
  replies use a link any app on this phone can claim. Use it only with test orgs." Release builds
  with a publisher domain never show it. The banner is a ui-kit component styled from tokens.
- **Phone removed.** A `device_revoked` result from any Worker call (02 §2: this install's
  device was revoked) means Phase 15's native client has already deleted that org's sessions and
  install id. The shell removes the org's local data and says "This phone was removed from
  `org` (by you or an admin), so its sign-ins were deleted. Add the org again to keep using it."
- **Machine status** renders `MachineSummary.status` (an open enum): online, degraded,
  offline, never connected, provisioning, tearing down, and an `unknown` arm for any value this
  build does not know.

- **Deep link.** `yaranapp://add-org?u=<org url>` arrives through `@capacitor/app` `appUrlOpen`.
  It always lands on **Confirm org**, which shows the URL as a chip, and is never added
  automatically. Any app or web page can fire this link, so the confirm step is the mitigation.
- **Protocol check.** The app compares its compiled range with the `protocol {min,max}` from
  `/v1/meta`, using Phase 02's negotiation helper from `cloud/protocol`. A mismatch names who has
  to update, and how.
- **Machine status.** It refreshes on resume, on pull-to-refresh, and every 30 s while the
  Machines screen is visible. The interval is measured in visible time, following the web's
  visible-clock tenet: a hidden app polls nothing.
- **Remove a machine.** `DELETE /v1/me/machines/{id}` tears down that machine's tunnel and
  Access app, so it confirms with a destructive dialog. The dialog names the machine as a chip,
  autofocuses Cancel, and says that `yaran` on the machine will stop its cloud connection. The
  outcome is confirmed by a toast (a destructive act is always confirmed).
- **Sign out of an org.** This revokes the phone's device record (`DELETE /v1/me/devices/{id}`,
  W14, sent by Phase 15's native client from Phase 16's hook). It also deletes every session for
  that org's hosts and the org's `install_id`, which Phase 15's `Session.signOut` handles, and
  removes the org's local data. "Erase everything" does the same for all orgs and then deletes
  the vault keys.
- **Updates (`foss` only).** Play, the App Store and F-Droid update the app themselves. About
  in `foss` builds says so and adds one link, "Releases on GitHub", to
  `https://github.com/SiavZ/yaran/releases` (the canonical repository), opened in the system
  browser. There is no update check, no notice built from fetched data and no in-app installer,
  so there is nothing to spoof (T50).
- **Toasts.** The shell has one toast raiser, `src/lib/notify.ts`, with a boundary test. Its
  timing policy comes from `@yaran/ui-kit/toast-policy`, which this phase moves out of the web's
  `notify.ts` so both surfaces share one policy.

### Pushback recorded (binding guidance questioned per Ponytail rules)

- **There is no "appearance" setting.** The web UI and the shared tokens are dark-only
  (`main.tsx:8-9`, CLAUDE.md "currently dark-only"). A light shell would need light tokens that
  the web does not have. The shell is dark-only like the web; if the web ever gains a light theme,
  the setting comes back with it.
- **There is no machine rename.** Phase 02's user API has no rename route. The machine name comes
  from `yaran cloud login` on the machine.

## Work items

Every created code file carries the 00-CONVENTIONS §2 header with generated `Uses`/`Used by`
trees: `/** */` in TS/TSX, KDoc before `package` in Kotlin, `///` in Swift, `#` in shell. Each
one stays under the 500-line ceiling. The budgets below are planned maxima.

1. **Extract `@yaran/ui-kit` and move the web onto it.**

   Create:

   | Path | Budget | Notes |
   |---|---|---|
   | `packages/ui-kit/package.json` | 60 | Private package. `exports` is a source map (`./*` → `./src/*.tsx`, `./tokens.css`, `./theme.css`). The peers are react, react-dom, `@base-ui/react`, lucide-react, class-variance-authority, clsx, tailwind-merge and sonner. |
   | `packages/ui-kit/src/tokens.css` | 150 | Plain CSS custom properties moved from `index.css` :333-425 (raw `:root` and `.dark`) plus the Geist font tokens. No Tailwind syntax, so Phase 07's console can import it as is (R18). |
| `packages/ui-kit/src/theme.css` | 150 | Tailwind v4 mapping moved from `index.css` :98-201 (`@custom-variant dark`, `@theme inline`); imports `tokens.css` |
   | `packages/ui-kit/src/cn.ts` | 20 | Moved from `src/lib/utils.ts` |
   | `packages/ui-kit/src/use-mobile.ts` | 40 | Moved from `src/hooks/use-mobile.ts` |
   | `packages/ui-kit/src/toast-policy.ts` | 80 | Moved from `notify.ts`: the constants at :36-51 and `statusToastDuration` at :80-94 |
   | `packages/ui-kit/src/*.tsx` | (unchanged) | Moved with `git mv`: button, card, checkbox, dialog, dropdown-menu, empty, inline-code, input, popover, popupSheet, scroll-area, select, separator, sheet, skeleton, sonner, switch, tooltip, plus their tests and any ui-internal transitive imports found by the import graph at move time |
   | `packages/ui-kit/scripts/export-native-colors.mjs` | 150 | Writes `mobile/android/app/src/main/res/values/yaran_colors.xml` and `mobile/ios/App/App/Colors.xcassets/*` from `tokens.css`. `--check` mode detects drift. |
   | `packages/ui-kit/vitest.config.ts`, `tsconfig.json` (strict) | 40 | |

   App-coupled primitives stay in the web: sidebar, resizable, command, context-menu, breadcrumb,
   avatar, button-group, collapsible and input-group. The shell does not use them, and they import
   app modules.

   Touch:
   - `crates/yaran-web/web/package.json`: add `"@yaran/ui-kit": "file:../../../packages/ui-kit"`,
     and refresh the lockfile.
   - `vite.config.ts`: add `resolve.preserveSymlinks: true`, and `resolve.dedupe` for every kit
     peer.
   - `tsconfig.app.json`: add `preserveSymlinks: true`.
   - `src/index.css`: add `@import "@yaran/ui-kit/theme.css"` and
     `@source "../node_modules/@yaran/ui-kit/src"`, and delete the moved blocks.
   - `src/lib/notify.ts`: import the policy from the kit.
   - `src/lib/notifyBoundary.test.ts:51`: point the allow-list at the kit's sonner path.
   - `crates/yaran-web/build.rs`: two `rerun-if-changed` lines for `../../packages/ui-kit/src` and
     its `package.json`. This file is over 500 lines, so the change is minimal wiring only.

   Use a codemod script, `packages/ui-kit/scripts/codemod-imports.mjs` (budget 120, run once and
   kept for forks), to rewrite `@/components/ui/<moved>`, `@/lib/utils` (`cn`) and
   `@/hooks/use-mobile` imports in the roughly 93 web files.

   Reuse: the existing primitives unchanged, `cn`, the token CSS, and the timing code from
   `notify.ts`.

   Tests:
   - The moved component tests run in the kit.
   - A new web test renders a kit `Dialog` inside the web build to prove there is a single React
     instance. A duplicate React would throw an invalid-hook-call error.
   - The existing web suite stays green: `viewportMeta`, `notifyBoundary` and `dialogNameChips`.
   - `export-native-colors --check` runs in the kit's test script.
   - A guard test fails if `tokens.css` contains Tailwind at-rules (`@theme`, `@custom-variant`,
     `@apply`), so the console import keeps working.

   If `preserveSymlinks` plus `dedupe` fails in either consumer, fall back to tsconfig `paths` plus
   a Vite alias to `packages/ui-kit/src`. In that case the kit has no `node_modules` of its own,
   and its tests run from the web package. Record which one was used in the PR.

2. **Scaffold the shell project (`mobile/app`).**

   Create:

   | Path | Budget | Notes |
   |---|---|---|
   | `package.json` | — | Pins `@capacitor/core`, `/cli`, `/android` and `/ios` at `~8.6.2`, plus `@capacitor/app`, React 19, Vite 8, Tailwind 4, `@lingui/*` 6.x and Vitest 4. Adds `file:` dependencies on ui-kit, qr, secure-store, machine-view, push and `cloud/protocol`, and an `engines` entry of node `>=22.12` (R21, matching 01/02/04/18). |
   | `capacitor.config.ts` | 60 | Sets `android.path`/`ios.path`, `webContentsDebuggingEnabled: false`, `android.allowMixedContent: false`, `appendUserAgent: 'YaranApp/<version> (…)'` (the shell UA follows the Phase 02 §11 token), and SystemBars `insetsHandling: 'css'` |
   | `index.html` | 40 | The CSP above. The viewport meta copies the web's (`index.html:15`) for parity. |
   | `vite.config.ts` | 60 | Lingui plugin, zxing wasm as an asset, `preserveSymlinks`/`dedupe` |
   | `tsconfig.json` | — | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
   | `eslint.config.js` | — | Mirrors the web config, plus `jsx-a11y` |
   | `src/main.tsx` | 60 | Adds the `dark` class as `main.tsx:8-9` does, mounts the i18n provider and app lock gate |
   | `src/App.tsx` | 200 | Hash router over the screens |
   | `src/lib/route.ts` | 150 | Pure hash-route parse and build for the shell's routes |
   | `src/test/setup.ts` | 60 | Plugin mocks |

   Tests:
   - Route parse/build round trips.
   - A CSP guard test that parses `index.html` and fails if the directives weaken.
   - A guard test that fails on any `fetch(`, `XMLHttpRequest` or `WebSocket` in `src/`, because
     all network access is native.

3. **Build the native core library (`mobile/plugins/core`).**

   Create:
   - Android, in `android/src/main/java/.../core/`:
     - `Vault.kt` (300)
     - `KeyProvider.kt` (150): an interface over AndroidKeyStore. The tests swap in a software key,
       because Robolectric has no AndroidKeyStore.
     - `AppLock.kt` (300)
     - `Diagnostics.kt` (200)
     - `Sanitizer.kt` (150)
     - `ScreenPrivacy.kt` (80)
     - `HostRules.kt` (200)
     - `build.gradle.kts`
   - iOS, in `ios/Sources/YaranCore/`:
     - `Vault.swift` (300)
     - `AppLock.swift` (250)
     - `Diagnostics.swift` (200)
     - `Sanitizer.swift` (150)
     - `ScreenPrivacy.swift` (120)
     - `HostRules.swift` (200)
     - `Package.swift`
   - Shared fixtures in `fixtures/`: `sanitizer-cases.json` and `host-rules-cases.json`, read by both
     test suites. This follows the repo's cross-language fixture pattern
     (`prose_cross_language.json`).

   Wiring: Android, in `mobile/android/settings.gradle`, adds `include ':yaran-core'` with its
   `projectDir`, because `cap sync` only writes plugins. iOS consumes the core through
   `.package(path:)` from each plugin's `Package.swift`. The CapApp-SPM resolution of that path is
   **UNVERIFIED**, and it is proven in this work item's first PR. If it fails, the core sources are
   vendored into each plugin's target by a symlinked `Sources/YaranCore` directory, checked by a
   test.

   Tests:
   - JUnit: Vault round trip, tamper detection (a GCM tag failure is an explicit error that never
     returns empty), namespace isolation and the invalidation path, all with the software
     `KeyProvider`. The sanitizer and host rules run against the fixtures.
   - androidTest: real AndroidKeyStore round trip, plus the AppLock key flags read through
     `KeyInfo`.
   - XCTest, in a hosted test target because the Keychain needs entitlements: Vault, access-class
     attributes read back from `SecItemCopyMatching`, and the fixtures.

4. **Build the secure-store plugin package (`mobile/plugins/secure-store`).**

   Create:
   - `src/definitions.ts` (150), which defines:
     - `SecureStore.{get,set,remove,list}` (namespaced and JSON-valued; the `session/*`,
       `handoff/*`, `install/*` and `push/*` namespaces are refused, because those belong to
       native code only: Phase 15 owns the first three, Phase 16 the last)
     - `AppLock.{status,enable,disable,unlock,setOptions}`
     - `Diagnostics.{append,export}` (export opens the native share sheet after an in-shell
       preview)
     - `ScreenPrivacy.set`
   - `src/index.ts` (40) and `src/web.ts` (60). The web implementation throws "unavailable" and is
     used by Vitest mocks only.
   - Android: `SecureStorePlugin.kt` (200), `AppLockPlugin.kt` (200) and
     `DiagnosticsPlugin.kt` (150; `FileProvider` with an `ACTION_SEND` chooser). Also the
     `ScreenPrivacyPlugin.kt` (80) and `build.gradle` (depends on `:yaran-core`).
   - iOS: `SecureStorePlugin.swift` (200), `AppLockPlugin.swift` (200),
     `DiagnosticsPlugin.swift` (150; `UIActivityViewController`), `ScreenPrivacyPlugin.swift` (80)
     and `Package.swift`.

   Each adapter validates its arguments and maps core errors to stable codes, and contains no
   logic.

   Tests:
   - Robolectric: argument validation and refusal of reserved namespaces.
   - XCTest: the same cases.
   - Vitest: the TS definitions match the mocks (type-level, plus a contract test).

5. **Create the Android project (`mobile/android`).**

   Create or edit (Capacitor template, then hardened):
   - `app/build.gradle.kts` (250):
     - `productFlavors { foss {} play {} }` in dimension `distribution`, with the same
       `applicationId` so channels can upgrade each other (D14).
     - `compileSdk = 36` and `targetSdk = 36` (Play's requirement since 2026-08-31), `minSdk = 24`.
     - A literal `versionCode`/`versionName` (R5 §7.8).
     - `dependenciesInfo { includeInApk = false }`.
     - `androidResources { generateLocaleConfig = true }`.
     - The release signing config reads environment variables that Phase 18 defines.
     - Reads `mobile/publisher.properties` (work item 17) into `BuildConfig` fields and the
       `manifestPlaceholders` `publisherDomain`, `publisherCallbackEnabled` and
       `devCallbackEnabled` that Phase 15's callback aliases use.
     - An `e2e` build type (`initWith(debug)`, `matchingFallbacks += "debug"`) that sets
       `BuildConfig.E2E_WEBVIEW_DEBUG = true` and the e2e build-config overrides (Phase 19 hook
       H4 and H6). Release, `foss` and `play` release variants set it `false`, which Phase 19's
       `check-release-flags.sh` verifies.
   - `app/src/main/AndroidManifest.xml`:
     - `allowBackup="false"`, `dataExtractionRules` and `fullBackupContent`.
     - `usesCleartextTraffic="false"` and a `networkSecurityConfig` with no cleartext and no pins
       (R5 §5.6).
     - The `CAMERA` permission.
     - A `<queries>` entry for the `CustomTabsService` action, which Phase 15 uses.
     - `MainActivity` with an intent filter for `yaranapp://add-org`. The sign-in callback
       filters (`https://<publisher-domain>/auth/callback` with `autoVerify`, and the dev-build
       `yaranapp://auth/callback`) live in Phase 15's plugin manifest, gated by the placeholders
       above.
     - `enableOnBackInvokedCallback="true"`.
     - `configChanges` for size, orientation and uiMode.
   - `res/xml/data_extraction_rules.xml` and `res/xml/backup_rules.xml`, excluding everything.
   - `res/resources.properties` with `unqualifiedResLocale=en-US`.
   - `res/values/strings.xml`.
   - `MainActivity.kt` (150):
     - `EdgeToEdge.enable` (per the SystemBars docs).
     - Sets the shell WebView's `textZoom` from `Configuration.fontScale`, through a pure mapping
       function.
     - Applies `ScreenPrivacy`.
     - Locks the shell under `AppLock` on resume.
   - `buildSrc/.../VerifyFossDependencies.kt` (150): a task, `:app:verifyFossDependencies`, that
     fails when the `fossReleaseRuntimeClasspath` contains `com.google.android.gms`,
     `com.google.firebase`, `com.google.mlkit` or `com.google.android.play` (the F-Droid scanner
     patterns, R5 §1 fact 11). Phase 18 calls it in CI.
   - `buildSrc/.../ReleaseAppIdGuard.kt` (80): fails any release build whose `applicationId`
     starts with `com.example.`. The repo default is `com.example.yaran`, because inventing a
     domain is forbidden (D16). The maintainer sets the real ID in `mobile/publisher.properties`
     during Phase 21. It also fails a release build with an empty `publisherDomain` when the
     Gradle property `requirePublisherDomain=true` is set, which Phase 18's official release jobs
     pass, so an official build can never ship the dev callback (D8, T36). Fork builds without
     the flag build as development builds and show the banner.
   - `gradle/libs.versions.toml`: pins androidx.biometric and the ktlint and detekt plugins.

   Tests:
   - A JUnit test for the font-scale mapping.
   - Gradle TestKit tests: `verifyFossDependencies` must fail on a fixture that adds a forbidden
     group, and `ReleaseAppIdGuard` must fail on the default ID and on an empty publisher domain
     with `requirePublisherDomain=true`.
   - A TestKit test that the `e2e` build type sets `E2E_WEBVIEW_DEBUG` and the release variants
     do not.
   - A Robolectric test that the manifest flags are present in the merged manifest.

6. **Create the iOS project (`mobile/ios`).**

   Create or edit:
   - `App/App.xcodeproj`, using SPM and a deployment target of **iOS 17.4** (D8: the `.https`
     sign-in callback needs it; Capacitor 8's own minimum is 15.0). Configurations Debug,
     Release and **E2E** (a copy of Release that defines the `E2E` compilation condition and the
     e2e build-config overrides; Phase 19 hooks H4 and H6). Only the E2E configuration compiles
     `isInspectable = true` paths (Phase 15).
   - `App/App/Info.plist`:
     - `CFBundleURLTypes` for `yaranapp` (the `add-org` deep link; the dev-build sign-in callback
       is captured by `ASWebAuthenticationSession` and needs no registration).
     - `NSCameraUsageDescription` and `NSFaceIDUsageDescription`, both localized.
     - `UIApplicationSupportsMultipleScenes=false`.
     - All four orientations on iPad.
     - No `UIRequiresFullScreen`, which is deprecated in iPadOS 26.
     - `ITSAppUsesNonExemptEncryption`, with its value set in Phase 21.
   - `App/App/App.entitlements`: `keychain-access-groups` and the app group `group.$(APP_ID)`, which
     the Phase 16 NSE shares. `App/App/App+Publisher.entitlements` adds
     `com.apple.developer.associated-domains` with `applinks:$(PUBLISHER_DOMAIN)` and
     `webcredentials:$(PUBLISHER_DOMAIN)` (the `.https` callback, Phase 15); the generated
     xcconfig selects it through `CODE_SIGN_ENTITLEMENTS` only when a publisher domain is set.
   - `App/App/PrivacyInfo.xcprivacy`: no tracking; the required-reason entries come from the final
     SDK list, audited in Phase 21.
   - `App/App/Localizable.xcstrings` and `InfoPlist.xcstrings`.
   - `App/App/AppDelegate.swift` (120): applies `ScreenPrivacy` on scene resign and engages the
     lock gate.
   - `Config/Publisher.xcconfig`, generated from `mobile/publisher.properties` (work item 17):
     `APP_ID = com.example.yaran`, `APPLE_TEAM_ID`, `PUBLISHER_DOMAIN`, `RELAY_URL`,
     `CODE_SIGN_ENTITLEMENTS`. A build-phase script fails a Release archive when the ID still has
     the example prefix, or when `REQUIRE_PUBLISHER_DOMAIN=YES` (set by Phase 18's release lane)
     and `PUBLISHER_DOMAIN` is empty.

   Tests:
   - An XCTest that reads `Bundle.main` and asserts the URL scheme, the usage strings and the
     scene flag.
   - A script test for the xcconfig guard (example ID; empty domain with
     `REQUIRE_PUBLISHER_DOMAIN=YES`), and one that the entitlements file without associated
     domains is selected when the domain is empty.

7. **Build the QR scanner (`mobile/plugins/qr`).**

   Create:
   - `src/scanner.ts` (250): `getUserMedia` (rear camera), a frame loop on
     `requestVideoFrameCallback` with a `requestAnimationFrame` fallback, decoding with zxing-wasm
     restricted to `QRCode` only, and teardown of every track on stop.
   - `src/wasm.ts` (60): `prepareZXingModule({ overrides: { locateFile } })` pointing at the bundled
     `zxing_reader.wasm?url` asset. No CDN is ever touched, and the shell CSP would block one
     anyway.
   - `src/payload.ts` (120): a pure parser that accepts only `yaranapp://add-org?u=<OrgUrl>`
     (02 §10; parser and constants from `cloud/protocol` `src/uri.ts`) and returns the org URL or
     a typed refusal.
   - `src/index.ts` (30).

   **Native fallback (fully designed).** It is used if the camera inside the WebView fails on
   device; Phase 19 and G6 record the outcome, and it is not used otherwise. A `Qr.scan()`
   Capacitor plugin keeps the same TS signature:
   - iOS uses `AVCaptureSession` with `AVCaptureMetadataOutput` (`.qr`), in about 200 lines and with
     no third-party code.
   - Android uses CameraX plus zxing-cpp, with the C++ built from source through Gradle's CMake
     integration so that F-Droid gets no prebuilt `.so`. That is about 250 lines plus the CMake
     file.

   The typed-URL path always exists, so a camera failure never blocks onboarding.

   Tests:
   - Vitest for the payload parser against `cloud/protocol/fixtures/uri/add-org.json`, plus:
     valid input, `http` refused, extra parameters ignored, a missing `u`, and a `u` that fails
     `HostRules`. The same cases are mirrored in the core fixture.
   - A decode test on PNG fixtures of real QR codes produced by Phase 09's CLI renderer format.
   - Proof that the wasm path resolves to a bundled URL (a build-output test).

8. **Write the shell domain modules (`mobile/app/src/lib`).**

   Create:

   | Path | Budget | Contents |
   |---|---|---|
   | `orgUrl.ts` | 150 | Normalizes typed input: adds `https://` when the scheme is absent, then runs `HostRules`. |
   | `protocolCompat.ts` | 80 | Wraps the `cloud/protocol` negotiation and adds an app-facing verdict. |
   | `api.ts` | 250 | Typed facade over Phase 15 `Session.request` for `GET /v1/me` (W9), `GET /v1/me/machines` (W10) and `DELETE /v1/me/machines/{id}` (W11, 202 `TeardownStarted`), using the generated types and mapping the Phase 02 error envelope and the `device_revoked` result. |
| `buildInfo.ts` | 60 | Reads `Session.callbackMode()` once at start for the dev-build banner. |
   | `orgStore.ts` | 200 | The org list in `SecureStore` namespace `orgs`. |
   | `machinesStore.ts` | 200 | Cache and refresh, with the visible-time poll. |
   | `settingsStore.ts` | 150 | Shell settings. |
   | `deepLinks.ts` | 120 | `appUrlOpen` handling and validation. |
   | `lifecycle.ts` | 120 | Resume refresh, lock check, and reopening the last machine. |
   | `notify.ts` | 120 | The one raiser, using the kit's toast policy. |
   | `i18n.ts` | 80 | Lingui setup and the language switch. |
   | `diagnostics.ts` | 100 | Console wrapper that forwards to `Diagnostics.append`. |
   | `visibleClock.ts` | 80 | Visible-time interval helper, modelled on the web's `lib/visibleClock.ts` but not imported from it. |

   Tests:
   - Unit tests for each module.
   - `api.ts` runs against the Phase 02 fixtures in `cloud/protocol/fixtures/`: valid responses
     parse, error envelopes map to sentences, and an unknown error code becomes a generic sentence
     that still names the code.
   - The notify boundary test, a copy of the web's pattern, allows sonner only in the kit and in
     `lib/notify.ts`.

9. **Build the onboarding screens (`mobile/app/src/screens/onboarding/`).**

   Create:
   - `Welcome.tsx` (120)
   - `ScanQr.tsx` (200): requests camera permission, shows the decoded org as a chip, and links to
     the typed path.
   - `EnterUrl.tsx` (150): a single-line field, so Enter submits.
   - `ConfirmOrg.tsx` (250): calls `Session.meta`, shows `org.name` and `access.team_domain`,
     runs the protocol verdict, stops on `setup: open` (`setup_incomplete`), shows the D17
     disclosure "Cloudflare decrypts traffic at its edge", and offers Sign in through
     `Session.signIn`. It also says that the browser will ask "Sign this device in to …?" and
     that the person should tap Continue (the consent interstitial, D8).
   - `SignInResult.tsx` (150): turns every handoff outcome from Phase 15's matrix into a sentence.

   Tests: Vitest DOM tests for each screen with mocked plugins. The meta failure cases are:
   network, non-JSON, an Access redirect (which means the public override is missing and points
   at G8), a protocol range mismatch in each direction, `setup: open`, and a sign-in cancel
   (including `handoff_declined`).

10. **Build the org and machine screens (`mobile/app/src/screens/orgs/`, `machines/`).**

    Create:
    - `OrgList.tsx` (200)
    - `SignOutOrgDialog.tsx` (150): destructive confirm.
    - `MachineList.tsx` (250)
    - `MachineRow.tsx` (200): status glyph and word, last seen, and a `⋯` menu with Open and
      Remove…. The menu follows the web row-menu idiom and its 40 px touch floor.
    - `RemoveMachineDialog.tsx` (150)
    - `states/Empty.tsx` (100)
    - `states/Offline.tsx` (80)
    - `states/ErrorState.tsx` (100)
    - `states/ProtocolMismatch.tsx` (100)
    - `states/SetupIncomplete.tsx` (60)
    - `states/PhoneRemoved.tsx` (80): the `device_revoked` sentence, names the org as a chip.
    - `DevBuildBanner.tsx` (60): rendered by `App.tsx` above every screen in dev builds.

    Open calls Phase 15 `MachineView.open({orgId, machineId})`.

    Tests:
    - DOM tests: the confirm dialogs autofocus Cancel and render the name as a chip; a remove
      success raises a toast; a 404 on remove (already gone) raises an info toast and refreshes; an
      expired session triggers the sign-in prompt; a `device_revoked` result removes the org and
      shows the phone-removed sentence.
    - The dev-build banner renders on every route when `callbackMode` is `dev` and never when it
      is `https`.
    - Every `MachineSummary.status` value, plus an unknown one, renders a word.
    - A machine-list grouping test with more than one org.

11. **Build the settings screens (`mobile/app/src/screens/settings/`).**

    Create:
    - `Settings.tsx` (250)
    - `SecuritySettings.tsx` (200): app lock and screen privacy.
    - `NotificationSettings.tsx` (200): renders the rows from the `push` plugin's TS definitions
      (Phase 16) and owns their local state; Phase 16 wires the effect.
    - `LanguageSettings.tsx` (100)
    - `Diagnostics.tsx` (200): preview plus Export…, with an explicit note that the file contains
      hostnames and machine names.
    - `Licenses.tsx` (150): also the `foss`-only "Releases on GitHub" link.
    - `EraseDialog.tsx` (150)
    - `LockScreen.tsx` (150)

    Tests:
    - DOM tests: enabling the lock calls `AppLock.enable` and shows its outcome; an invalidated lock
      shows the wiped-sessions sentence; erase confirms and wipes; the licenses page renders all
      three generated lists; the releases link exists only in `foss` and points exactly at
      `https://github.com/SiavZ/yaran/releases`.

12. **Add i18n and accessibility.**

    Create:
    - `mobile/app/lingui.config.ts` (30) and `src/locales/en/messages.po`.
    - `src/i18n.test.ts` (80): the compiled catalog has no missing English message, and
      `lingui extract --clean` in check mode has no diff.
    - `src/a11y.test.tsx` (150): runs `axe-core` on every screen and checks that every interactive
      element has an accessible name and at least a 40 px target.
    - On iOS, the root CSS `font: -apple-system-body` lets rem units follow Dynamic Type
      (**UNVERIFIED**; checked on device in Phase 19).
    - On Android, `textZoom` comes from the font scale (work item 5).
    - `prefers-reduced-motion` is honored through the kit's existing animation tokens.

13. **Generate the license lists.**

    Create `mobile/scripts/licenses.sh` (120). It runs rollup-plugin-license JSON output for the
    shell bundle, AboutLibraries `exportLibraryDefinitions` for each flavor (the `foss` list must
    not include the FCM distributor), and LicensePlist from `Package.resolved`. It writes
    `mobile/app/src/generated/licenses/{js,android-foss,android-play,ios}.json`, which are
    committed and marked as generated.

    Tests: `--check` mode fails on drift, and Phase 18 runs it.

14. **Upgrade to Capacitor 9.**

    When `9.0.0` is GA (expected by the end of November 2026, R5 §1), land a dedicated PR. It bumps
    the four packages, re-reads the 9.0 upgrade guide, and switches SystemBars to the new `native`
    default after checking the shell's insets. It also re-runs every validation command. Until GA
    the project stays on `~8.6.2` and pins nothing to an RC.

15. **G6 fallback: native host without Capacitor (conditional).**

    This applies only if G6 rules out hosting a separate native WebView from a Capacitor plugin, or
    shows the bridge cannot be confined. It is fully designed here and reuses everything above the
    adapter layer:
    - **Android.** `mobile/host-android/ShellActivity.kt` (300) serves `dist/` through
      `WebViewAssetLoader` at `https://appassets.androidplatform.net/`. Its bridge is
      `WebViewCompat.addWebMessageListener(webView, "yaranNative", setOf("https://appassets.androidplatform.net"), …)`,
      which is origin-restricted.
    - **iOS.** `mobile/host-ios/ShellViewController.swift` (300) uses a `WKURLSchemeHandler` for
      `yaranshell://` and a `WKScriptMessageHandlerWithReply` that answers only when
      `frameInfo.isMainFrame` and `securityOrigin.protocol == "yaranshell"`.
    - **JS.** `mobile/app/src/lib/nativeBridge.ts` (200) implements the same TS plugin interfaces
      over `postMessage`.
    - The `*Plugin.kt`/`*Plugin.swift` adapters gain twin `*Handler` adapters with the same
      argument validation. `core` stays unchanged.

    Tests: the adapter contract tests from work item 4 run against both adapter kinds.

16. **Add the threat-model rows.**

    Each PR that adds a surface updates its row in `docs/operations/threat-model.md` and the
    `SECURITY.md` STRIDE table, using the IDs Phase 17 allocated (T25–T64; 17 owns the
    consolidated prose):
    - the shell bridge, its CSP and the no-JS-credentials rule: **T60**;
    - the `add-org` deep link and QR: **T42**;
    - vault, app lock and backup exclusion: **T37**;
    - diagnostics export: **T51**;
    - the callback filters, associated domains and the dev-build banner: **T36**, **T63**;
    - the `foss` releases link: **T50**.

17. **Publisher build config (Phase 18's loader, Phase 19 hook H6).**

    Create:
    - `mobile/publisher.properties` (40, committed): `appId=com.example.yaran`, `appleTeamId=`,
      `publisherDomain=` (never hand-edited: `publisher-config.mjs` writes it from the repo-root
      `publisher.json`, Phase 18's one home for the publisher domain; the committed
      `<publisher-domain>` placeholder writes an empty value, D16), `relayUrl=<publisher-relay>`,
      `playPushTransport=` (values Phase 16 defines), and the e2e keys `e2e.controlPlaneUrl=`
      and `e2e.relayUrl=`. Every key carries an inline comment saying what it does and who sets
      it (Phase 21 fills the real values, Phase 18's `check-versions.mjs --publisher` fails a
      release on a remaining placeholder).
    - `mobile/scripts/publisher-config.mjs` (120): copies `publisher_domain` from the repo-root
      `publisher.json` into `publisherDomain`, then reads the properties file and writes
      `mobile/ios/App/Config/Publisher.xcconfig` and `E2E.xcconfig` (marked generated); `--check`
      fails on drift in either step, and 18's `check-versions.mjs --publisher` repeats the
      comparison at release time. The `e2e.*` keys reach only the `e2e`/`E2E` variants, where the shell
      prefills the org URL and the push plugin uses the staging relay; release variants never
      read them.
    - Android reading is in `app/build.gradle.kts` (work item 5).

    An empty `publisherDomain` makes a **development build**: Phase 15 sends `build=dev` with the
    `yaranapp://auth/callback` redirect, the shell shows the banner, and the associated-domain
    entitlement and App Link alias stay off.

    Tests: `publisher-config.mjs --check` in CI; a Vitest test that the generated xcconfig keys
    equal the properties keys and that `publisherDomain` equals `publisher.json`'s value (empty
    for the placeholder); the Gradle and xcconfig guard tests in work items 5 and 6.

## Acceptance

- [ ] The web UI builds, lints and passes its full Vitest suite on `@yaran/ui-kit`. `cargo build -p yaran-web` re-runs when kit sources change. The single-React test passes.
- [ ] `export-native-colors --check` and `licenses.sh --check` report no drift.
- [ ] `mobile/app` typechecks in strict mode, lints and passes Vitest, including the CSP guard, the no-JS-network guard, the notify boundary, i18n completeness and axe checks.
- [ ] `assembleFossRelease` and `assemblePlayRelease` build (unsigned locally). `verifyFossDependencies` passes on `foss` and fails on the forbidden-group fixture. `ReleaseAppIdGuard` fails on `com.example.yaran`.
- [ ] The iOS App target (deployment target 17.4) builds for the simulator with Xcode 26, and its XCTest suite passes, including the Keychain access-class tests.
- [ ] A build with an empty `publisherDomain` shows the development-build banner on every screen; a build with one shows none, carries the associated-domains entitlement (iOS) and the verified App Link alias (Android). An official release build with an empty domain fails (`requirePublisherDomain` / `REQUIRE_PUBLISHER_DOMAIN`).
- [ ] The `e2e`/`E2E` variants build and enable WebView inspection; no release variant does (Phase 19 hook H4). `publisher-config.mjs --check` reports no drift (hook H6).
- [ ] Phase 07's console imports `@yaran/ui-kit/tokens.css` unchanged (the no-Tailwind guard passes).
- [ ] Every onboarding path works on an emulator, on a simulator and on the GrapheneOS phone (no Play services) against a Phase 07 test org: scan, typed URL, deep link with confirm, protocol mismatch in each direction, setup incomplete, missing public override, offline, phone removed by the user console.
- [ ] App lock works in both modes (biometric only, and with passcode fallback) on both platforms. Re-enrolling biometrics wipes the sessions and says so.
- [ ] Screen privacy hides content in screenshots on Android and in the iOS app switcher.
- [ ] Backups contain no vault data: `adb shell bmgr backupnow` followed by an inspection, and the iOS backup holds only ThisDeviceOnly items.
- [ ] Diagnostics export contains no JWT, cookie or query string, verified by the sanitizer fixture plus a real export grep.
- [ ] Every new code file passes `module-headers --check` and stays at 500 lines or fewer.
- [ ] Threat-model rows are present for every surface in work item 16.

## Validation

```bash
# shared kit + web consumer
(cd packages/ui-kit && npm ci && npx tsc --noEmit && npm test && node scripts/export-native-colors.mjs --check)
node mobile/scripts/publisher-config.mjs --check
(cd crates/yaran-web/web && npm ci && npm run lint && npm run build && npm test)
cargo build -p yaran-web
# shell
(cd mobile/app && npm ci && npx tsc --noEmit && npm run lint && npm test && npm run build && npx cap sync)
mobile/scripts/licenses.sh --check
# Android
(cd mobile/android && ./gradlew :app:assembleFossDebug :app:assemblePlayDebug :app:assembleFossE2e \
   testFossDebugUnitTest :yaran-core:test :app:verifyFossDependencies ktlintCheck detekt lint)
(cd mobile/android && ./gradlew :yaran-core:connectedAndroidTest)   # emulator attached
# iOS
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
(cd mobile && swiftlint --strict)
# conventions (Phase 01 CLI)
node tools/module-headers/bin/module-headers.mjs --check mobile packages/ui-kit
node tools/module-headers/bin/module-headers.mjs --lines --check
```

## Risks

| Risk | Mitigation |
|---|---|
| `preserveSymlinks` with `dedupe` misbehaves under Vite 8 or Vitest 4, giving a duplicate React | A single-React test detects it. The fallback is a tsconfig `paths` plus alias setup (work item 1). |
| The codemod over about 93 web files collides with in-flight web PRs | Land it as one mechanical PR early in Wave B. The codemod script is kept, so a rebasing PR can re-run it. |
| WKWebView `getUserMedia` fails under `capacitor://` (UNVERIFIED) | The native AVFoundation fallback is designed (work item 7), and the typed URL always works. |
| Capacitor 9 GA lands mid-phase and changes inset defaults | Upgrade in a dedicated PR (work item 14). Shell insets run in CSS mode and are checked again. |
| CapApp-SPM cannot resolve `plugins/core` by path (UNVERIFIED) | Proven in the first PR. The fallback vendors the sources through a symlinked directory, with a test. |
| The biometric key is invalidated by enrollment and sessions are lost | By design. The wipe is announced, the org list survives because it is in the `standard` class, and re-sign-in is one tap per org. |
| F-Droid's scanner flags something `cap sync` pulls into `foss` | `verifyFossDependencies` gates the build, and Phase 18 runs F-Droid's `scanner` with G7. |
| Text from an org reaches the bridge page | Rendered as React text only. The CSP forbids inline script, and nothing interpolates HTML. |
| The Android font scale is not applied by default (UNVERIFIED) | `textZoom` is set explicitly, with a tested mapping. |
| An official build ships without a publisher domain and falls back to the custom-scheme callback | `requirePublisherDomain` / `REQUIRE_PUBLISHER_DOMAIN` fail the release (work items 5, 6); the banner makes any such build visible (T36). |
| iOS 17.4 minimum drops devices stuck on iOS 15–17.3 | Accepted by D8 (the `.https` callback needs 17.4); the store listing states the minimum (21). |
| The `.https` callback's associated-domain service type differs from `webcredentials:` | Re-verified at implementation (Evidence); both `applinks:` and `webcredentials:` are declared, and Phase 21's AASA lists the app under both. |

## References

- 00-README.md D8, D9, D10, D13, D14, D16, D17, D22; flows 3 and 4; the repository layout
- 00-CONVENTIONS.md §1 (reuse, 500 lines), §2 (headers), §3 (tests), §4 (research protocol)
- research/R5-mobile.md §1, §5 (baseline checklist), §6, §7, §8
- research/R2-web-frontend.md §7, §8, §9; research/R3-repo-process.md §1 and its implications 1, 2 and 4
- Phases 02 (contract: §2, §8, §10, §11), 03 (G6, G7, G8, G13), 07 (console tokens), 15 (Session/MachineView definitions), 16 (push rows), 17 (T36, T37, T42, T50, T51, T60, T63), 18, 19 (hooks H4, H6), 21
- URLs listed in Evidence (read 2026-11-14)

## Reconciliation notes (2026-11-14)

- R20: Parallel-safe/Depends/Blocks lines name Wave B and Wave C; G13 added as a dependency (callback filters).
- R2: iOS deployment target 15.0 → 17.4; associated-domains entitlement (`applinks:`, `webcredentials:`) in a separate entitlements file selected only with a publisher domain; Android placeholders for Phase 15's verified App Link alias and dev callback alias.
- R2: development-build banner (no publisher domain → `build=dev` custom-scheme callback) designed in Design and work item 10; release guard `requirePublisherDomain` / `REQUIRE_PUBLISHER_DOMAIN` added to the existing app-id guards; Confirm org tells the user to expect the consent page.
- R12/D22: trust model states push registration also goes through Phase 15's native client; sign-out uses W14 through it; `install/*` and `handoff/*` added to the native-only namespaces.
- R9: `device_revoked` (phone removed) state and sentence; `setup_incomplete` stop on `Meta.setup = open`; Confirm org reads `org.name` / `access.team_domain`; machine rows render `MachineSummary.status` with an unknown arm.
- R18: `packages/ui-kit/` named the one shared package; tokens split into plain-CSS `tokens.css` (Worker console input) and Tailwind `theme.css`, with a guard test; README layout note updated (D1–D23).
- R19: Out-of-scope row quotes 13's labels "Switch machine" and "Phone app settings" without the ellipsis.
- R21: compile/target SDK 36 stated in work item 5; Capacitor stays `~8.6.2` with work item 14 owning the 9 upgrade; iOS minimum 17.4.
- R15/Phase 19 hooks: H4 (`e2e` build type, `E2E` configuration) and H6 (relay URL and e2e control-plane defaults) implemented in work items 5, 6 and the new work item 17.
- Phase 18 dependency: new work item 17 defines the publisher build config and loader 18 refers to.
- R14: work item 16 placeholders replaced with T60, T42, T37, T51, T36, T63, T50.
- T50 (owner 14 in 17's table, and 21 assigns 14 "the update notice"): designed as a `foss`-only static GitHub releases link with no update check or installer.
- Names: QR parser and fixture use 02 §10 `OrgUrl` and `fixtures/uri/add-org.json`; API facade cites W9–W11.

### Straggler pass (2026-11-14)

- Straggler pass: `engines` node `>=22.12` (was `>=22`) and the `mobile/app/.nvmrc` row removed; the repo-root `.node-version` (18) is the one Node pin (R21). No stale iOS 15.0 target remains (only Capacitor's own minimum in Evidence).
- Straggler pass: `publisherDomain` is written by `publisher-config.mjs` from the repo-root `publisher.json` (18), never hand-edited; `--check` and a test cover it (D16).
- Straggler pass: Validation uses 01's real CLI (`node tools/module-headers/bin/module-headers.mjs`) (R20). H4 and H6 work items verified (R15).
- D24 (final pass): threat range reference T25–T63 → T25–T64 (17 appended T64, remembered-consent bypass).

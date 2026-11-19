# Mobile native parity: implementation and validation ledger

Native half of `t3-mobile-parity-implementation-plan.md` (tracks B, D, E and the native part of
F) against the frozen contract in `mobile-parity-contracts.md`. Date: 2026-11-17. Values someone
else supplies are written as `<publisher-domain>`, `<org-control-plane>` and `<machine-host>`.

Scope owned here: `mobile/plugins/machine-view` (Android, iOS, MachineViewCore, fixtures,
messages, and the TS contract only where a repair was needed), `mobile/android/app`
(manifests, share intake), `mobile/ios/App` (scene forwarding, Info.plist), and test-only rows
in `mobile/plugins/secure-store` and `mobile/plugins/core`. The shell, Rust, web, Worker and
protocol are other tracks and were not edited.

Nothing here was run on a phone or built for iOS. Every claim below is labelled with the check
that backs it.

## 1. What is implemented

| Gap | Android | iOS | Proof |
|---|---|---|---|
| G1 `Session.directStatus` | `DirectFlow.status`: refuses a non-public host and an org host, probes `/api/v1/auth/status` unauthenticated, attaches the stored session only to its own host and only after the open answer shows the instance it was issued by | `DirectFlow.status` over `DirectAuth.status`, same rules | Shared fixture `fixtures/direct-cases.json` (both twins); `DirectAuthTest` (MockWebServer, real TLS); Swift `DirectAuthTests` (URLProtocol stub) |
| G1 `Session.directSignIn` | `DirectFlow.signIn`: org-host refusal, unauthenticated probe, `not_required` when the route needs no password, native `PasswordSheet` (`FLAG_SECURE`, password input, autofill hint), `cli-login` with redirects off, password kept as `CharArray`/bytes and zeroed after the POST, record under `session-direct/<host>` (locked class from creation, App Lock on or off; see section 6), a token the phone cannot keep is revoked | `UIAlertController` secure field (`.password` content type), bytes zeroed after the POST (Swift `String` copies cannot be wiped; stated in the source) | Fixture `login` rows; `theLoginBodyCarriesThePasswordExactly…` both platforms; revoke tests both platforms |
| G1 `Session.directSignOut` | best-effort `cli-logout` with the bearer, record deleted, every cookie of the host expired and `WebStorage.deleteOrigin` | logout, record deleted, the host's whole `WKWebsiteDataStore` removed | `signOutEndsTheBearerOnTheMachine` (Android); type-check only on iOS |
| G1 cookie | `yaran_session_<port>=<token>; Path=/; Secure; HttpOnly; SameSite=Strict`, host-only, no expiry; name and token validated | `HTTPCookie`, same attributes, `.sameSiteStrict` | Fixture `cookie` rows; `aDirectWindowLoadsWithOnlyItsOwnCookie` |
| G1 one host, one credential kind | direct sign-in refuses `org_host`; org handoff for a host with a direct record ends `refused {code:"direct_host"}` | same | `aHostWithADirectSessionIsNotSignedInThroughAnOrg` (both) |
| G1 JS cannot reach `session-direct` | prefix-reserved by `securestore/Validation.kt` | prefix-reserved by `PluginArguments.swift` | `ValidationTest.refusesReservedNamespacesByPrefix` and `PluginArgumentsTests.reservedNamespacesAreRefused` now include `session-direct`. All four JS calls (get, set, remove, list) go through that one check on both platforms (read in source, lines named in section 4) |
| G1 machine window, direct form | `MachineState` holds the open form, routes, chosen route, instance; `RouteDriver` probes, closes `instance_changed` for another instance, Access in front is an overlay ("add it through its organization"), a 401/403 or missing session shows the native sheet, then loads with only that host's cookie | `MachineViewController+Direct` twin | `DirectWindowRobolectricTest` (real HTTPS probes); iOS type-check only |
| G2 `Session.routeStatus` (added on the shell's request) | `DirectFlow.routeStatus`: direct = `directStatus`; org = exact host, its own org's `CF_Authorization`, redirects off; none/expired/other org/Access redirect = `sign_in_required` | `DirectAuth.orgRouteStatus` + `DirectFlow.routeStatus` | `anOrgRouteIsProbedOnlyWithItsOwnOrgSession` (Android), `anOrgRouteCarriesOnlyItsOwnOrgSession` (Swift) |
| G2 route choice in the window | `RouteSelector` (pure): at open in order; at resume after 30 s away and from "Try another route" the current route first and kept if it answers; a switch destroys the WebView and makes a new one; the agent route rides over, nothing else | `RouteSelector.swift`, new WebView and per-host data store on a switch | Fixture `routes` rows (both twins, including probe order); `aRoutedWindowSkipsADeadRouteOntoAFreshWebView`; `aRoutedWindowNoRouteAnswersClosesAtOpenButNotOnRetry` |
| G2 close attribution (added on the shell's request) | `closed` carries `host` (route on screen; the rejected one for `instance_changed`; absent for `no_route`) and `requestedHost` | `ClosedPayload.make`, same fields | Android window tests assert the exact payload; Swift `ClosedPayloadTests` |
| G5 intake | `MainActivity` hands SEND / SEND_MULTIPLE to `ShareHolder`: `content://` only, at most 10, rest counted as dropped, text-only refused `no_files`, event held under the lock and emitted with `retainUntilConsumed` after unlock; `shareStatus`, `discardShare` | "Open in yaran" through `CFBundleDocumentTypes` (`public.item`, `LSSupportsOpeningDocumentsInPlace` false, no `UIFileSharingEnabled`): `SceneDelegate` routes file URLs to `ShareIntake`; `ShareInbox` moves them to `Library/Caches/shared-inbox`, deletes iOS's `Documents/Inbox` copy, refuses `unsupported_os` below iOS 18.4 and deletes the copies | `theShareIntakeKeepsContentOnlyAndWaitsForTheUnlock` (Android); `theInboxKeepsTenFilesPrivatelyAndRefusesOldSystems` (Swift) |
| G5 delivery | `open({share:true})` moves the URIs into the window intent as `ClipData` with `FLAG_GRANT_READ_URI_PERMISSION`; `ShareChooser` asks "Attach the N shared files here?" before the page's own chooser; single-file inputs get the first file; Choose other files opens the system picker; delivered or discarded files are forgotten; a restored window holds none | `ShareUIDelegate` implements `runOpenPanelWith` (iOS 18.4+, `@available`, selector spelled out) and is set only while files are held, so WebKit's own picker is untouched otherwise | `sharedFilesAreOfferedToThePageChooserOnce`, `aSingleFileInputTakesOnlyTheFirstSharedFile`, `aRestoredWindowHoldsNoSharedFiles`; iOS header check (section 4) |
| G6 links | `OpenLinkHttps` alias (`autoVerify`, `https`, `<publisher-domain>`, path `/open`) to `OpenLinkActivity`, which hands the URL to the app's launch activity as a VIEW intent; enabled only with a publisher domain, exactly like `AuthCallbackHttps`. `yaranapp://add-machine` VIEW filter on MainActivity | `applinks:$(PUBLISHER_DOMAIN)` was already in `App+Publisher.entitlements`; `scene(_:continue:)` already forwards through Capacitor's proxy; file URLs no longer reach the shell from `openURLContexts` | `ManifestTest.openLinkAliasIsVerifiedAndOffByDefault`; `BuildOutputsTest` (alias set, `/open` filter, add-machine, SEND filters, `ACCESS_NETWORK_STATE`) on the merged `fossDebug` manifest; `aapt2` dump of the packaged APK |
| G4 sibling gap (privacy cover) | no change needed: Android has no privacy overlay (`FLAG_SECURE` only) | `CoverState`: the page is out of the window while the lock cover **or** the screen-privacy cover is up, and comes back only when neither is | `thePageReturnsOnlyWhenNoCoverIsUp` (Swift, pure); controller wiring type-checked only |

G3 and G4 work from the earlier task is unchanged: `syncPageVisibility`, the iOS lock-cover
detach, `ACCESS_NETWORK_STATE`, and no `setNetworkAvailable`. The 10 window tests that pin
it (`MachineWindowRobolectricTest`) still pass.

## 2. Sol round 1 native findings

| Finding | Disposition | Proof |
|---|---|---|
| (1) An unreadable session record was treated as "no session" (Android window), and `HandoffClient.onRedirect` could throw `CoreError.Tampered` on the save after a successful browser sign-in, killing the io thread and leaving the external-flow hold | Fixed. Reads end in one of found/missing/locked/unreadable (`SessionReads`); unreadable shows "The saved sign-in for … can't be read on this phone. Sign in again to replace it." and starts nothing by itself; locked shows the lock cover. `onRedirect` never throws: a lock is `vault_locked`, any other storage failure `secure_storage_failed`, the hold is released on every path, a marker that cannot be deleted no longer fails the ending. iOS: `SessionStore.get` throws `StoredRecordError.unreadable` instead of returning nil; the controller shows the same overlay; the save maps the same way | `anUnreadableOrgSessionSaysSoAndStartsNoSignIn`; `aTamperedSaveAfterTheBrowserSignInEndsTruthfully` (hold counted); `aMarkerThatCannotBeDeletedDoesNotFailTheEnding`; Swift `anUnreadableOrgSessionIsNotAMissingOne`, `aFailedSaveAfterTheBrowserSignInEndsTruthfully` |
| (4) `HandoffClient.begin` reported any `ProviderException` as `vault_locked` while unlocked | Fixed with the new outcome `secure_storage_failed` on `SignInOutcome`, `DirectSignInOutcome` and `DirectSignOutOutcome`, in both natives, the TS union, `signInFailure` and `fixtures/messages.json`. Only `VaultLockedException` / `VaultError.locked` is `vault_locked`. `begin` builds the URL before taking the hold, so a failure leaves none. iOS `installId`/`deviceKey` now reject a non-lock failure with `native_error` (Android's code) | `anUnlockedKeyStoreFailureIsNotALockedVault` (Android), `anUnlockedKeyFailureIsNotALockedVault` (Swift), `aLockedVaultIsStillVaultLocked` |
| StrongBox fallback lacked runnable tests | The rule is now `KeyGenFallback.generate`: StrongBox, then the TEE on `StrongBoxUnavailableException`, or after removing the half-made entry on a StrongBox `ProviderException`; a TEE failure reaches the caller | `KeyGenFallbackRobolectricTest`: 5 tests with the real Android exception classes (the Keystore itself is not available under Robolectric) |

Mutation checks (Android, each reverted after): removing the instance check before attaching
a direct session, treating an unreadable session as readable, mapping a key failure back to
`vault_locked`, dropping the StrongBox `ProviderException` fallback, reusing the WebView on a
route switch, and handing a single-file input every shared file. Each made its test fail. No
mutation run was done on the Swift side.

## 3. Contract changes made here (all additive)

All in `mobile/plugins/machine-view/src`, recorded with exact signatures in
`mobile-parity-contracts.md`:

- `secure_storage_failed` on `SignInOutcome`, `DirectSignInOutcome` and `DirectSignOutOutcome`.
  The shell's exhaustive switches had to add a case; the shell track has done so, and
  `mobile/app` type-checks (`tsc --noEmit` clean, run here read-only).
- `Session.routeStatus({route: MachineRoute}): Promise<RouteStatus>`,
  `RouteStatus = DirectStatus | {kind:"sign_in_required"}`; the web stub rejects `unavailable`.
- `ClosedEvent.host?` and `ClosedEvent.requestedHost?`.
- `fixtures/messages.json` gained `sign_in.secure_storage_failed`, the overlay rows the window
  shows (session unreadable, Access on a direct machine, not a yaran, redirected, direct
  offline, offline on a route, no other route, the password sheet, the share banner and
  confirms, iOS too old), a `direct` section with the window's own sentence per
  `DirectSignInOutcome` kind, and the `{count}` placeholder. Kotlin and Swift copies are pinned
  to it by test.

For the shell (not done here, shell-owned): a cold start from "Open in yaran" on iOS still
reaches Capacitor's launch URL as a `file://` URL (the scene's connection options cannot be
filtered), so the shell's link handler must ignore `file:` URLs; later ones are filtered
natively.

## 4. Checks run

| Check | Result |
|---|---|
| `./gradlew -PappIdOverride=<app-id>.connectivitytest testFossDebugUnitTest :yaran-machine-view:testDebugUnitTest :app:verifyFossDependencies ktlintCheck detekt lint assembleFossDebug` (JDK 21) | passed |
| `:yaran-machine-view:testDebugUnitTest` | 116 tests, 0 failures (80 before this work) |
| `:app` unit tests (`BuildOutputsTest` 4, `PushGatewayTest`, `TextZoomTest`), `:yaran-secure-store` `ValidationTest` | passed |
| Packaged `app-foss-debug.apk`, `aapt2 dump xmltree` | package `<app-id>.connectivitytest`; `ACCESS_NETWORK_STATE`; `add-machine`; `SEND`, `SEND_MULTIPLE`, `*/*`; `OpenLinkHttps` with path `/open` (disabled: this build has no publisher domain). Not installed |
| `mobile/plugins/machine-view`: `tsc --noEmit`, `vitest run` | clean; 65 tests |
| `mobile/app`: `tsc --noEmit` (read-only) | clean |
| `bash mobile/plugins/machine-view/ios/MachineViewCore/test.sh` | 98 tests in 16 suites passed (80 before) |
| `bash mobile/plugins/machine-view/ios/typecheck-catalyst.sh` | MachineView, PushPlugin, the NSE and the app delegates type-check against Mac Catalyst UIKit and Capacitor 8.6.2 |
| `WKUIDelegate.h` in the installed macOS SDK | `webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:` is `API_AVAILABLE(macos(10.12), ios(18.4), visionos(2.4))`; the Swift method names that selector explicitly |
| `plutil -lint mobile/ios/App/App/Info.plist` | OK |
| `module-headers --check` and `--lines --check` | Every file in this scope is clean, checked against a throwaway git index that includes all untracked files (the real index was not touched). The remaining drift is in Rust, protocol, shell and ui-kit files owned by other tracks. Line gate OK; `MachineViewActivity.kt` stays under 500 lines because the route, read, share and link code moved into `RouteDriver`, `SessionReads`, `ShareChooser` and `ExternalLinks` |

The JS `SecureStore` refusal: Android `SecureStorePlugin.kt` calls `Validation.namespace` in
`get`, `set`, `remove` and `list` (lines 46, 53, 62, 69); iOS `SecureStorePlugin.swift` calls
`PluginArguments.namespace` in all four (lines 39, 48, 59, 68). The new test rows pin the
refusal of `session-direct` in that shared check; no plugin-level test drives the four calls.

## 5. Not proven, and limits

- **No device run.** Nothing here was installed or driven: the password sheet, a real
  `cli-login`, the cookie being accepted by a real yaran (track A's Cli-token-as-cookie test is
  that proof), route switching on a real network, share sheets, App Links verification.
- **No iOS build.** This host has no Xcode. The UIKit code is type-checked against Mac Catalyst
  only; nothing ran on iOS. `MachineViewCore` runs on macOS under `swift test`.
- **iOS share intake is "Open in yaran", not a Share Extension, so G5 is not complete on iOS.**
  iOS hands such a file over one at a time. A Share Extension (multiple files, the share-sheet
  row) is a new target in `App.xcodeproj` (hand-written `project.pbxproj` sections, an
  `NSExtension` Info.plist, the app-group entitlement and its own provisioning profile). The
  Swift could be type-checked here, but the target, its embedding, signing and the extension's
  memory limit cannot be built or checked without Xcode, and a hand-edited project file that
  nobody can open would put every iOS build at risk. It stays a bounded gap; Android G5 is
  complete.
- **iOS 18.4 open-panel delegate.** It is set only while files are held, because WebKit reads
  which delegate methods exist when the delegate is set (WebKit source reasoning, not a device
  observation). While files are held, Choose other files offers the Files picker only (no photo
  library).
- **Below iOS 18.4** a shared file is refused `unsupported_os` and deleted at once, as the
  contract says.
- **Android URI grants** are re-granted to the machine window through its own intent; that the
  grant outlives MainActivity being destroyed is Android's documented behaviour, not observed.
  A second open while a window is up now replaces the window's target (section 6, F5).
- **Android cookie clearing on sign-out** expires every cookie the store shows for the host with
  `Path=/`. A cookie with another path or set on a parent domain is not reachable this way;
  yaran sets neither.
- **G6 needs publisher infrastructure** outside this repo: `assetlinks.json` and
  `apple-app-site-association` on `<publisher-domain>` must list `/open`. The enabled path was
  built once with the test-only `-PpublisherDomainOverride=app.example.com` (section 6); App
  Links verification itself needs the real domain and a device.
- **Route probes are sequential** (at most four, 3 s for `*.ts.net`, 8 s otherwise), so a dead
  first route delays the open by its timeout.
- `MachineViewActivity` behaviour for an org-only window is unchanged except that an unreadable
  or locked session record is now said so instead of starting a sign-in.

## 6. Sol native review round 2 (REVISE, ten findings): repairs

| # | Finding | Fix (Android / iOS) | Proof |
|---|---|---|---|
| 1 P1 | After Keep on a changed instance, a load re-read the old record and injected the old token | A window remembers the instance its chosen direct route answered at the last probe; `DirectSessionStore.current(host, instance)` returns a record only when it was issued by that instance, otherwise deletes it, and the window clears every cookie of the host (Android `clearHost(storage = false)`, value overwritten then expired; iOS deletes the host's cookies from the window's own store) before loading. Every load and resume path reads through it | `aKeptReplacementInstanceGetsNoCookieOfTheOldOne` (first and only request carries no cookie, store and vault empty), `aKeptReplacementThatWantsAPasswordAsksInsteadOfReusingTheOldToken`; Swift `aRecordFromAnotherInstanceIsDroppedNotReused` |
| 2 P1 | The org fallback reused another org's session for the same host and loaded with no probe | Every org read is scoped to the route's own `orgId` (Android `refreshSession`, iOS `SessionStore.get(host, orgId:)` in the coordinator, the cookie injection and `vars`); after a sign-in a routed window probes the route again for the expected instance before loading (`reloadSameUrl`) | `anotherOrgsSessionIsNeverSentAndASignInIsCheckedAgainstTheInstance` (zero requests and no cookie before the right sign-in; another instance after it loads nothing; the right one loads); Swift `anotherOrgsSessionIsNotThisRoutes` |
| 3 P1 | A session saved with App Lock off stayed standard class and readable after the lock was enabled | Org and direct session records are written in the locked class from creation on both platforms (that class works with the lock off: its data key is then wrapped by the standard key). The lock-enable transition itself (`Vault.wrapUnderLock` on Android, `Vault.guardDataKey` on iOS) first moves any standard-class entry of the `session` and `session-direct` namespaces into the locked class, one atomic write per namespace, keeping only their `names` host index standard; a failure throws before the lock turns on and leaves every entry where it was | Core: `enablingTheLockMovesLegacySessionEntriesIntoTheLockedClass`, `aFailedPromotionLeavesTheLockOffAndEveryEntryReadable` (both platforms, real Vault; iOS through the real `AppLock.enable`). Machine-view over the real core Vault: `directSessionsAreUnreadableOnceTheLockIsEnabled` (both). Store tests assert the locked class with App Lock off |
| 4 P1 | The org/direct collision check ran outside `begin`'s handler and could throw on the io thread | The check is inside the handler, and `DirectSessionStore.has` never throws (a locked or unreadable record counts as present) | `anUnreadableDirectNamespaceRefusesWithoutThrowingOrHolding` (no hold left, control-plane sign-in unaffected) |
| 5 P2 | A second open into the singleTask window was ignored, and the consumed share lost | `onNewIntent` replaces the target (`RouteDriver.replace`): the old target is reported closed with its own host, its page, credentials and undelivered files go, the new one starts as a fresh open and takes the files and read grant its intent carries. Debug `singleTop` and release `singleTask` both reach `onNewIntent` | `aSecondOpenReplacesTheTargetAndItsSharedFiles` (closed A attributed, fresh WebView loads B, B's two files offered once, B's close attributed) |
| 6 P2 | The overlay stayed after a wrong then right password, or wrong then not required | Success and not-required hide the overlay, then probe again before loading | `aWrongThenRightPasswordClearsTheOverlay`, `aWrongPasswordThenNoPasswordNeededClearsTheOverlay` |
| 7 P2 | A kept route that needs a password only re-injected; single direct windows skipped the resume probe | Every non-org-only window probes again after 30 s away; a kept direct route whose session ended shows the native sheet, a healthy kept page is not reloaded | `aLongResumeChecksTheDirectSessionAndAsksWhenItEnded` (short resume: no probe; healthy long resume: no reload, no sheet; ended session: sheet, no reload) |
| 8 P2 | A renderer lost under the lock was not reloaded when a long-away resume chose a route first (Android), or at all (iOS) | Android passes the pending reload into the route choice, so the kept or the newly chosen route loads exactly once. iOS keeps it in `PageReload` (pure): a crash behind the lock owes exactly one reload at the next resume, on whichever route answers | `aRendererLostUnderTheLockReloadsOnceOnTheRouteThatAnswers` (kept and switched, exactly one navigation); Swift `reloadsHappenOnlyWhenOwed` |
| 9 P2 | iOS reloaded a healthy org page on every resume | A resume re-injects without navigating; it reloads only for a renewal or an owed renderer reload (`PageReload`) | Swift `reloadsHappenOnlyWhenOwed`; controller wiring type-checked only |
| 10 P2 | iOS closing an older window deleted a newer pending share | Each intake is a batch folder of its own; a window removes only the batches its own files came in (`ShareInbox.remove`), only inside the inbox (prefix and UUID checked); `discard` deletes only the batch still held | `aWindowRemovesOnlyItsOwnSharedFiles` (B survives A's close; a file outside the inbox and a same-length lookalike path naming B's batch are untouched) |

Also in this round:

- `DirectAuth` no longer uses fixed-length streaming for the login POST: in that mode a 401's
  refusal body is lost (found by the F6 test), so a wrong password read as `server_refused`.
  The HTTP stack keeps its own copy of the body either way; zeroing the caller's bytes stays
  best effort.
- **Enabled App Link build.** `mobile/android/app/build.gradle.kts` gained a test-only
  `-PpublisherDomainOverride=<host>`, beside `-PappIdOverride`, so the enabled path builds
  without editing `mobile/publisher.properties`. With `app.example.com` (a reserved test name):
  `assembleFossDebug`, `testFossDebugUnitTest` (`BuildOutputsTest` asserts the alias enabled
  with exactly `https://app.example.com/open` and `autoVerify`) and `lintFossDebug` (0 errors)
  passed, and `aapt2` shows `OpenLinkHttps` enabled into `OpenLinkActivity`. The final build
  went back to the default config, so the packaged APK has no publisher domain.
- `SECURITY.md` and `threat-model.md` T67 now describe the locked-class storage and the
  enable-time migration; no other row changed.
- Server integration (one line): the web store's events-socket reconnect recovery calls
  `invalidatePhoneLinkTarget()`; `storePhoneLinkReconnect.test.ts` proves a re-pair missed
  while disconnected copies B, never A, and fails without the line. `store.ts` is a baselined
  oversize file: its growth (this line plus the earlier server-track phone-link wiring and the
  two Used-by lines) was recorded with the gate's own `--accept-growth` and a stated reason.

Overlapping sign-in and sign-out (asked by the shell track). Every Android direct operation
(`directStatus`, `directSignIn`'s probe and POST plus save, `directSignOut`, the window's own
sign-in) runs on the plugin's single `machine-view-io` thread, and a sign-in's POST and save are
one task, so a sign-out never interleaves with them. On iOS they run on the main actor, and the
window's sheet is modal over the window, which covers the shell. No concrete native path was
found where a host-only sign-out cannot attribute its cleanup; no contract change is proposed.
One ordering is possible by design: a window sign-in submitted just before the window closes
still saves its session after the close, and a later shell sign-out removes it as usual.

Mutation checks this round (each reverted): Android F1, F2, F3 (org and direct store), F4, F5,
F6, F7, F8 and the streaming-mode change; Swift F1, F8 and both F10 guards; the web reconnect
line. Each made its test fail.

Checks this round: the Android gate set (`testFossDebugUnitTest`, `:yaran-machine-view`,
`:yaran-core`, `:yaran-secure-store` tests, `verifyFossDependencies`, `ktlintCheck`, `detekt`,
`lint`, `assembleFossDebug`) passed; machine-view 126 tests, core 21, secure-store 4, app 6,
all 0 failures. Swift: machine-view core 103 tests, YaranCore 27, Catalyst type-check clean.
Plugin TS: `tsc` clean, 65 tests. Web: store, phoneLink and app-menu tests (36 files, 637
tests), `eslint` on the two touched files clean. Module headers clean in every file of this
scope and the line gate passes.

## 7. Sol native review round 3 (REVISE, eleven findings): repairs

Base: main fast-forwarded to `a3acc113f` (PR #127) with this work carried over; every gate in
this section was run on that tree.

| # | Finding | Fix (Android / iOS) | Proof |
|---|---|---|---|
| 1 P1 | A host-only cleanup for sign-in A ended a later sign-in B; overwriting B left A live | Every direct session carries an opaque, non-secret `signInId` (128 random bits, base64url) returned in `signed_in`. `directSignOut({host, signInId})` ends only that sign-in and answers `not_current` without touching B's record, cookies or data (also for an older build's id-less record or none). A sign-in that replaces a record revokes the replaced token. Android: all direct operations share one io thread. iOS: `DirectLifecycle` (main actor) re-reads the record after every network await; without an id, a sign-in landing mid-revocation is revoked too | Android `aCleanupEndsOnlyItsOwnSignInAndAReplacedOneIsRevoked`; Swift the same plus `aSignInThatLandsDuringTheRevocationSurvives` (B lands during A's logout: B and its data survive, A revoked) |
| 2 P1 | Late continuations of an older open (session read, cookie injection, sign-in, share confirm) acted on the replacement or after close | Android: one `openGen` per open; every read, injection, renewal and sign-in callback checks `live(gen)` first; replacing or closing dismisses the password sheet and the share confirm (its page chooser answered with nothing); a confirm only ever hands over the files it showed. iOS: every selection, sign-in, injection and load continuation checks `closed`; the sheet is not shown once its window left the screen | `aLateReadOfTheReplacedOpenInjectsNothing`, `aShareConfirmOfTheReplacedOpenNeverHandsOverTheNewFiles`, `aClosedWindowsPasswordSheetIsDismissedAndPostsNothing`; iOS type-checked only |
| 3 P1 | A probe sent the stored token before the expected instance was checked; an unbound record was a wildcard | A stored session is attached only when bound to the instance that answered and that instance is the window's expected one; an unbound record (an older build's, or a machine with no instance) never authorizes reuse and is dropped on load; only the window's own fresh sign-in (by `signInId`) may load before a probe can bind it | `aStoredTokenIsNeverSentBeforeTheExpectedInstanceIsSeen`, `anUnboundLegacyTokenIsNeverSentAndIsDropped`, `anUnboundTokenIsNotReusedOnAMachineWithoutAnInstance`; Swift `noCredentialBeforeTheExpectedBoundInstance` |
| 4 P1 | A lock enabled by an older build skipped the standard-session promotion | Core `Vault.get` refuses a standard-class session secret while locked (both platforms), and the first authenticated unlock promotes them; a failed promotion keeps the refusal and the unlock | Core `aLockEnabledByAnOlderBuildRefusesThenPromotesLegacySessions` (Android real Vault, iOS real Vault and AppLock) |
| 5 P1 | The org API sent another org's session | Both `OrgApiClient`s require the record's org to be the requested one before building either header; another org's record is `session_expired`, never sent or deleted | Android `anotherOrgsSessionIsNeverSent`, Swift `anotherOrgsSessionIsNeverSentToTheOrgApi` (no request leaves) |
| 6 P1 | After an invalidated session, the served page showed its React password form inside the app | Server-served `AuthGate`: with the app's user agent (parsed by the existing strict `parseYaranAppUa`; a presentation hint only), signed-out shows `NativeSignInPage` with no password field and a Sign in that navigates to `reauthUri(hostname)`. Natively that control URL now asks a direct window's password sheet (then the instance check), while a real Access redirect stays the "add it through its organization" refusal; org routes renew as before | AuthGate tests for every signed-out reason (no input, strict URL), browser and look-alike UA keep the form; `thePagesSignInAsksTheNativeSheetAndAccessDoesNot` |
| 7 P1 | Control-plane target resolution ran outside `begin`'s handler | Android `begin` wraps the whole start, org lookup included; `SignInFlow` guards its own io boundary and every ending. iOS `OrgDirectory.orgUrl` cannot throw (non-throwing protocol, `try?` in the adapter) | Android `aThrowingOrgLookupEndsTheSignInWithoutAHold`; Swift `everyEndingReleasesTheHold` (unknown org, cancel, error reply, key failure) |
| 8 P1 | iOS lock enable could lose the key if the setting save failed or the process died | Vault transitions are three steps: new key copy, AppLock setting saved, old copy dropped; a failed save rolls back; `recoverGuard` at start drops whichever copy the saved setting no longer needs. Disable is symmetric | `anEnableWhoseSettingCannotBeSavedRollsBack`, `aProcessThatDiedBeforeTheSettingWasSavedComesBackUnlocked`, `aProcessThatDiedAfterTheSettingWasSavedComesBackLocked`, `aDisableWhoseSettingCannotBeSavedKeepsTheLock` (in-memory keychain with injected write/delete failures) |
| 9 P2 | iOS cleared the owed renderer reload before any navigation | `PageReload.owed` is cleared only when a navigation is actually submitted; a route choice that loads nothing keeps it | Swift `reloadsHappenOnlyWhenOwed`; controller wiring type-checked |
| 10 P2 | iOS deleted any incoming file whose path contained `/Documents/Inbox/` | Only a regular file, not a symlink, whose resolved path is inside the app's real `Documents/Inbox` is deleted | Swift `onlyTheRealInboxCopyIsDeleted` (look-alike path, symlink and its target survive) |
| 11 P2 | `-PpublisherDomainOverride` could reach a release | Release variants never take the override (applied per variant, debug and e2e only), and packaging a release APK or bundle with it set fails, decided by AGP packaging task type and variant, not task names | `mobile/scripts/check-publisher-override-guard.sh`: `assembleFossRelease`, `bundlePlayRelease` and plain `assemble` refused; `assembleFossDebug` and `testFossDebugUnitTest` allowed |

Mutation checks this round (each reverted; a run is bounded by a timeout and requests wait at
most seconds): Android F1 id check, F1 revoke, F2 read guard, F2 confirm, F2 sheet, F3 probe,
F3 unbound, F5, F6, F7; Swift F1 revoke, F3, F5, F10, core F4 refusal, F8 recovery and
rollback; web the native branch of AuthGate. Each made its test fail. A first iOS sign-out
re-check after the loop survived because the loop already re-reads after every await; it was
removed as dead code.

Shell integration owed (shell sources frozen during its review): `signed_in` fixtures gain
`signInId` in `approval.test.tsx` and `direct.test.tsx` (the only `tsc` errors in
`mobile/app`), the sign-out switch handles `not_current`, and the cleanup of an abandoned
approval passes its `signInId`.

Still not proven: no device or iOS build; the iOS controller's continuation guards and the
native-reauth branch are type-checked only.

Checks this round, on `a3acc113f` plus this work: the Android gate set (`testFossDebugUnitTest`,
the machine-view, core and secure-store unit tests, `verifyFossDependencies`, `ktlintCheck`,
`detekt`, `lint`, `assembleFossDebug`) passed: machine-view 136 tests, core 22, secure-store 4,
app 6, 0 failures. With `-PpublisherDomainOverride=app.example.com`: `assembleFossDebug` and
`testFossDebugUnitTest` pass and the packaged debug APK has `OpenLinkHttps` enabled; the release
guard script passes; the final APK is the default dev build (alias disabled). Swift:
MachineViewCore 109 tests, YaranCore 32, Catalyst type-check clean. Plugin TS: `tsc` clean, 65
tests. Web: `tsc -b` and `eslint` clean; components, auth and native suites 2880 tests. Module
headers clean in this scope and the line gate passes (the oversize files were split:
`DirectLifecycle.swift`, `DirectRepairTests.swift`, `AuthGateNative.test.tsx`,
`WindowEvents.kt`). `mobile/app` `tsc` has exactly the two frozen shell test files named above.

## 8. Sol native review round 4 (REVISE, seven findings): repairs

Base: `a3acc113f` plus this work, as in section 7.

| # | Finding | Fix (Android / iOS) | Proof |
|---|---|---|---|
| 1 P1 | Android native HTTP sent the WebView's cookies: Capacitor installs a process-wide `CookieHandler` backed by the WebView's jar | `NativeHttp.isolated` runs each `DirectAuth` and `OrgApiClient` exchange (open, send, read) with a thread-confined flag under which a permanent delegating guard handler gives no cookie and stores none; other threads' requests reach Capacitor's handler unchanged, and the global handler is never swapped around a request. `HandoffClient` makes no HTTP request of its own (it parses the redirect) | `NativeCookieIsolationRobolectricTest`, with Capacitor's real `CapacitorCookieManager` installed and the WebView holding `yaran_session_443` and `CF_Authorization` for the host: the public probe carries no Cookie, the credentialed probe only the attached session, the org call only its own `CF_Authorization`, and a response's `Set-Cookie` never reaches the WebView's jar; a control request outside the clients still gets the WebView cookie, so the harness is live |
| 2 P1 | iOS `SystemKeychainStore.write` deleted the item before adding it, so a failed add lost the old value | An unguarded item is updated in place with `SecItemUpdate` (value and access class) and added only on `errSecItemNotFound`; nothing is deleted first. The guarded lock key keeps delete-and-add, because its access control cannot be rewritten without a prompt and it is written only inside the Vault's recoverable lock transitions. The Security calls go through a `SecItemCalls` seam | `KeychainWriteTests` (call order only: a failed update deletes and adds nothing; an existing item is only updated; a missing one is added with its access class; the guarded key is replaced). The real Keychain's answers are the hosted AppTests' job and were not run here |
| 3 P1 | A replacement that failed part-way left the new, revoked token where the kept one was | Both `VaultSecrets.write`s write the host index first, and only when the name is new, so the record write is the only step that replaces anything: a failed `put` replaced nothing, and `keep` revokes only the new token | Android `aReplacementThatFailsPartWayKeepsTheOldSession` (real core `Vault`, the store breaking two key uses in); Swift the same over the real `Vault` and `InMemoryKeychainStore.writesBeforeFailure` at every failure point (a `put` that throws left the old record) |
| 4 P1 | Losing the lock key before any unlock kept an older build's standard-class session secrets | Both `Vault.wipeLocked`s drop standard-class session secrets along with the locked class; the `names` index and every other standard entry stay | Core `anInvalidationBeforePromotionDropsLegacySessions` (Android real `Vault`, iOS real `Vault` and `AppLock`) |
| 5 P1 | Android stale work acted before its generation check (a queued session read judged A's record by B's context and deleted it; a delayed preflight showed a sheet over B) | `openGen` is volatile. `refreshDirect` reads through `directReader(gen)`, which captures the open's observed instance and fresh sign-in on the main thread and checks the generation on the io thread before reading and again before deleting. `DirectFlow.signIn` takes an `owned` check, asked before the sheet is created, when it is submitted and before the POST | `StaleOpenRobolectricTest`: `aQueuedReadOfTheReplacedOpenDeletesNothing`, `aPreflightOfTheReplacedOpenShowsNoSheet` |
| 6 P2 | A closed iOS window kept changing cookies in the host's store, which a newer window may use | `DirectLifecycle.inject` makes the drop and set steps over a `DirectCookieJar` (`WKHTTPCookieStore` in the app), checking that the window is still open before every change and after every await; `loadDirect` and `reinjectDirect` also refuse once closed | `DirectOwnershipTests` over a fake jar (closed before the listing, closed mid-delete). The controller's `closed` wiring is type-checked only |
| 7 P2 | iOS unconditional sign-out deleted a sign-in D that landed during its third revocation, never revoking it | The record is deleted only once the loop found nothing it had not revoked (the delete then runs before any await); still changing after three revocations, the newest sign-in stays current, unrevoked and undeleted, and the answer is `not_current`. Android needs no change: its sign-out and sign-in share one io thread | Swift `anUnconditionalSignOutNeverDeletesASessionItDidNotRevoke` (A, then B, C, D land during each logout: A, B and C are revoked, D and its web data stay) |

Mutation checks this round, each reverted and each failing its test: Android isolation flag
off, old record-then-index order, `wipeLocked` keeping standard secrets, the io-time read
of a mutable context, the sheet's `owned` check; iOS delete-first Keychain write,
`wipeLocked` keeping standard secrets, the old write order, the missing `settled` guard, the
per-delete `owned` check.

### Compatibility boundary: older machines

Native password custody needs a yaran build that has both `cli-login`'s `cookie_name` and the
native-aware `AuthGate`. Both are in this change and neither is in a released yaran. What a
phone can do with each kind of machine:

- **A released yaran (no `cookie_name`).** The phone refuses the answer
  (`cookie_name_missing`) and revokes the token at once, so it never holds a session for that
  machine. A direct window shows the native sheet before it loads a page that wants a
  password, and on a refused sign-in it shows an overlay rather than the page, so the machine's
  own password form is not reached that way. The phone cannot sign in to such a machine
  directly.
- **A build with `cookie_name` but not the native `AuthGate`.** It does not exist unless the
  two halves ship separately. On such a build an invalidated session would show the page's own
  password form inside the window, typed into the page rather than the native sheet. This is
  not protected, and the phone cannot tell such a build from outside: the app's user agent is
  only a presentation hint.

Recommendation: ship the server half (`cookie_name`) and the `AuthGate` change in one release,
which is the case as long as they land together. If they must ship apart, the smallest guard is
an additive capability in the existing `auth/status` answer (for example
`native_sign_in: true`) that the phone requires before it keeps a direct session. That is a new
server auth surface, so it needs the server owner's approval and is not implemented here.

Shell integration owed: unchanged from section 7.

Still not proven: no device and no iOS build. The iOS controller wiring (`closed`, the
WebKit cookie store conformance) is type-checked only, and the real Keychain update path was
not run.

The module-headers gate oscillated on the Android package because its Kotlin parser read two
locals named after soft keywords as modifiers (`open` in `DirectAuth.status`, `external` in
`NavigationPolicy`, the latter already at HEAD), so the inferred edges depended on header
length. Both were renamed (`answer`, `offSite`); no behaviour changed, and the navigation
fixtures still pass.

Checks this round, on `a3acc113f` plus this work: the Android gate set (`testFossDebugUnitTest`,
the machine-view, core and secure-store unit tests, `verifyFossDependencies`, `ktlintCheck`,
`detekt`, `lint`, `assembleFossDebug`) passed: machine-view 142 tests, core 23, secure-store 4,
app 6, 0 failures. The release guard script passes. Swift: MachineViewCore 114 tests, YaranCore
37, Catalyst type-check clean. Plugin TS: `tsc` clean, 65 tests. The web was not changed this
round. Module headers clean and the line gate passes.

## 9. Sol native review round 5 (not finished): four recovered findings, repaired

The round-5 review stopped before its final report: it produced no verdict, and its older-machine
boundary check was not completed. These four findings were recovered from its messages, each with a
local reproduction. This section does not claim a clean review.

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | Android: an invalidation removed the lock marker (wrapped data key) and lock key before cleaning the namespaces; a failed namespace rewrite left a restart with the lock off and a legacy standard session readable | `Vault.wipeLocked` cleans every namespace first and throws the first failure (not `invalidated`) with the wrapped key and lock key still in place; only a full cleanup deletes them. `AppLock` already reports a non-`Invalidated` error as a failure and stays locked. A restart refuses the legacy secret and retries the wipe at the next unlock. iOS already ordered its wipe this way (the saved AppLock setting is its marker, and the wipe never touches it), and its regression is new | Core `aFailedInvalidationCleanupKeepsTheLockUntilARetryFinishesIt` (real `Vault`; the namespace's temp-file path is taken by a directory, so the real atomic write fails); Swift `aFailedInvalidationCleanupKeepsTheLockAcrossARestart` (`InMemoryKeychainStore.failingWrites`). The `names` index survives both |
| 2 P1 | iOS: changing the passcode fallback rewrote the only guarded key outside any recoverable transition; the guarded write is delete-then-add, so a failed add lost the key and the next unlock wiped the sessions | The guard change is now three steps with no unguarded copy: the key is staged behind the new guard (`key.locked.guarded.next.<kind>`), the setting is saved, then the main copy is rewritten and the staged one deleted. A failed save drops the staged copy and restores the setting. A failed main rewrite keeps the staged copy, which `unlock` reads first and repairs the main copy from. At start, a staged copy for a guard the saved setting does not name (a change whose setting never saved) is dropped. The wipe deletes staged copies too | `LockTransitionTests` through the production `SystemKeychainStore` over a synthetic in-memory Security backend (`SecItemCalls` now covers `SecItemCopyMatching` too): main rewrite fails after its delete, then restart unlocks with the session intact and the main copy repaired; setting save fails, then rollback; process dies after staging, then the staged copy is dropped at start. Not run against the OS Keychain |
| 3 P1 | Android: an accepted route switch kept the window's generation, so a read queued for route A put A's session and cookie into B's view | `switchTo` (taken only when the chosen route differs) increments `openGen` and dismisses the old route's dialogs, exactly as a new open does, before any state changes; every read, injection, sheet and renewal callback, and the io-time read check, belongs to the old route from then on. A kept route is no switch | `StaleOpenRobolectricTest`: `aReadOfTheOldRouteNeverReachesTheNewOne` (A to B: no A token in B's jar, A's record kept), `aReadFromBeforeASwitchBackIsStillStale` (A to B to A), `aKeptRouteKeepsItsWorkAndItsPage` (no invalidation, no reload) |
| 4 P1 | Android: a bridge start could replace the process-wide cookie handler between the guard's install and a native connection's creation, so that connection sent WebView cookies | The guard is made part of the connection: `HttpURLConnection` takes its cookie handler when it is created (the JDK in its constructor, Android's bundled OkHttp in `OkUrlFactory.open`). `NativeHttp.open` installs the guard and creates the connection under one lock, and `MainActivity.load()` (the bridge start, where `CapacitorCookies.load()` installs its handler) runs inside `NativeHttp.frameworkStart`, which re-wraps that handler under the same lock. The lock covers only a connection's creation (no network I/O) and the bridge start. Requests outside the native clients still reach Capacitor's handler | `aBridgeRestartDuringANativeOpenNeverReachesThatConnection`: a fresh real `CapacitorCookieManager` installed by a bridge start on another thread while a native probe is creating its connection. That probe and a later one carry no Cookie, and an outside request still gets the WebView cookie. Run on Robolectric's JDK stack; Android's OkHttp taking the handler at creation is from its source, not observed on a device |

Mutation checks this round, each reverted and each failing its test: Android marker deleted before the
failure check, cleanup failure swallowed, route switch without the generation bump, `open` unlocked,
no guard at `open`, bridge start unlocked; iOS main copy written directly instead of staged, unlock
ignoring the staged copy, start-up keeping an unsaved change's staged copy, abandon not deleting it,
AppLock swallowing the wipe failure. The concurrency tests passed on three extra reruns.

Residual: `NativeHttp` relies on every bridge start in the app going through `MainActivity.load()`.
There is one bridge (MainActivity), and no plugin `load()` waits on native HTTP, so the lock cannot
deadlock. The push plugin's relay client (`RelayEndpointClient`, outside this scope) still uses the
default handler; it talks only to the publisher relay host, for which the shell WebView holds no
cookies.

Checks this round, on `a3acc113f` plus this work: the Android gate set passed (machine-view 146 tests,
core 24, secure-store 4, app 6, 0 failures; `verifyFossDependencies`, `ktlintCheck`, `detekt`, `lint`,
`assembleFossDebug`). The release guard script passes. Swift: YaranCore 41, MachineViewCore 114,
Catalyst type-check clean. Plugin TS: `tsc` clean, 65 tests. Module headers and the line gate pass.

Still not proven: no device and no iOS build. iOS lock transitions run over a synthetic Security
backend, not the OS Keychain. Android's OkHttp handler capture is read from source.

## 10. Sol native review round 6 (REVISE, six source-traced findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | iOS: an unreadable or undecodable AppLock setting at start was read as "lock off", so `recoverGuard(false)` deleted a staged-only key copy and the process lost the lock and the legacy-secret refusal | `AppLock.loadSettings` separates none saved (a first install: the defaults) from saved but unreadable or undecodable. In the second case the lock is held engaged on provisional settings that are never saved. `Vault.lockEnabled` stays on, so the locked class and legacy session secrets are refused, and no key copy is recovered or dropped. `unlock`, `enable`, `disable` and `setOptions` read the settings again first and throw `unavailable` while they still fail, so an error never unlocks | `LockTransitionTests` through the production `SystemKeychainStore` over the synthetic Security backend: from a staged-only state with an unreadable setting, the lock stays engaged, the staged copy is kept, the session is refused and unlock throws; once the read works the same instance unlocks with the session intact and the main copy repaired. Also an undecodable setting (locked, staged copy kept), and a missing one (a first install, unlocked) |
| 2 P1 | Older machines: a password-free route (and every org page) admitted an older build's page, whose own login form would appear in the window if the machine later asked for a password; the `cookie_name` check never applies when no sign-in happens | Additive compatibility signal (authorized by the owner for this round): the served status gains `native_auth_ui: true` (`crates/yaran-web/src/auth/routes.rs`), the same for every client and read by nothing on the server. Natively, a well-formed status without `native_auth_ui === true` classifies as `upgrade_required` (`DirectStatus`, `RouteStatus`, `DirectSignInOutcome`), so status, sign-in and route checks refuse before anything is kept. Every page load in a window (lone direct, routed, org-only, reloads, retries, renderer recovery) needs an admission: a probe of the current route under the current window and route generation that found the flag, spent by one load; with none, the route is probed again first. A too-old build closes the window with `upgrade_required`, at open, for a routed window whose usable answers were all too old, and when a resume probe finds the current route no longer has the flag. Contract published to the shell before the native work: `{kind: "upgrade_required"}` and `DirectClosedCode "upgrade_required"` | Rust `the_status_tells_the_phone_its_page_signs_in_natively`; shared fixture rows (missing, `false`, a string, plus a malformed document still `not_yaran`) on both platforms; Android `UpgradeRequiredRobolectricTest`: an older password-free machine is never shown; the same machine now wanting a password gets no sheet and no login; an older org machine is never shown and a compatible one loads; older routes close `upgrade_required`; a machine that loses the flag is neither reloaded nor kept at resume. iOS: the classifier and fixtures in `swift test`; the controller's admission is type-checked and pinned by source wiring, not run |
| 3 P2 | iOS: after a route switch, A's pending cookie work, load, preflight sheet or sign-in could act on B's new WebView | `RouteTenure` (MachineViewCore): every accepted switch (`switchRoute`, which only runs when the route really changes) ends the current ticket before any state changes, and so does close. The selection's continuation, the sheet's preflight, submit and POST (`DirectFlow.signIn(owned:)`), the sign-in result, the org cookie injection, the direct cookie steps and every `webView.load` act only under the ticket they started with. A switch back to A starts a new ticket | `RouteTenureTests`: A to B and A to B to A make the old checks false and a kept route keeps them; one admission per load, never across a switch; A's cookie work stops at the switch; the controller's wiring is pinned by reading its source |
| 4 P2 | Android: the shared-files confirm survived a route switch; Attach delivered to the destroyed old page and cleared the held files | `ShareChooser.cancelConfirm` dismisses the open confirm (its dismiss answers the old page's chooser with nothing, once) and keeps the held files. `dismissDialogs` (route switch, replace, close) calls it; new-target discard and close behave as before | `aRouteSwitchCancelsTheOldPagesShareConfirmAndKeepsTheFiles`: answered once with nothing; the files stay and the new page's chooser gets them |
| 5 P2 | iOS: org route A's renewal timer survived a switch to direct route B and showed the reauth overlay over a healthy B | `RenewalCoordinator.routeChanged()` (called by `switchRoute`) cancels the timer, clears the overlay flag and invalidates, by an epoch, any callback already delivered and any renewal the old route started; only the new org route's own open or evaluate arms a timer again | Fake-scheduler tests: A's delivered deadline produces no UI event on B; org to org arms B's own deadline, which fires normally; A's late renewal success neither reloads nor hides anything on B; existing kept-route tests unchanged |
| 6 P2 | iOS `HandoffClient.launcherFinished` let a replaced sign-in's late redirect consume the newer sign-in's pending state and release its hold | Any launcher result whose state is not the pending sign-in's is ignored before parsing or cleanup. A sign-in replaced by a newer one releases its own hold when it is replaced, so each sign-in releases exactly once | `aReplacedSignInsLateRedirectLeavesTheNewOneAlone`: A's late redirect (with A's state, or naming B's) and cancel change nothing; B finishes once and releases the hold once |

Mutation checks this round, each reverted and each failing its tests:
- **Android:** classifier without the flag check, no load gate, an admission not spent, resume keeping a machine that lost the flag, routes closing `no_route`, no confirm cancel.
- **iOS:** settings read or decode falling back to defaults, no settings retry gate, a switch keeping its ticket, an admission not spent, a delivered timer acting, the timer not cancelled, an old renewal reloading, the classifier without the flag, the controller switch unwired, the handoff owner check removed, a replaced sign-in keeping its hold.

**Capability integration.** The phone admits a machine only when that machine's yaran build has
`native_auth_ui: true`, which ships in this change with the native-aware `AuthGate`.
- **Same build:** the flag and the `NativeSignInPage` branch are in the same server and web change, so a build that says true serves the safe page. Keep them together.
- **Machines that need an update:** released yaran builds and any build without this change get `upgrade_required` (the app shows nothing and asks for an update).
- **Not a version gate:** there is no published minimum version; the flag is the whole rule.
- **Not authorization:** the flag decides compatibility only; authorization still comes from the session cookie and Access.

Runtime limits: the parent validates a matching build on a real machine and device. The iOS controller wiring is type-checked and source-pinned only. iOS lock transitions run over a synthetic Security backend.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 153 tests, core 24, secure-store 4, app 6, 0 failures; `verifyFossDependencies`, `ktlintCheck`, `detekt`, `lint` and `assembleFossDebug` pass. The release guard passes.
- **Swift:** YaranCore 44, MachineViewCore 123, Catalyst type-check clean.
- **Plugin TS:** `tsc` clean, 65 tests.
- **Rust:** `cargo fmt` and `clippy -p yaran-web --all-targets --all-features -D warnings` clean; `auth_router` 79 tests and the `auth` module's 101 tests pass. The served `auth/routes.rs` did not grow: the status answer lives in `auth/status_answer.rs`.
- **Module headers and line gate:** pass within this scope. The one stale header is the shell's `mobile/plugins/push/src/index.ts`, made stale by its new push tests and left for the shell owner. The web UI was not changed this round, so the web suites were not rerun.

## 11. Sol native review round 7 (REVISE, eight source-traced findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | `native_auth_ui` was always `true`, even for a Rust-only build that embedded an old `web/dist` with the JS password form | The flag is now derived from proven build state. `build.rs`'s `mark_state` (called on every path, success and both hatch paths) also writes the state to `$OUT_DIR/ui_build_state`. `web_assets::native_auth_ui()` reads that file with `include_str!` and is true only for exactly `built`; `stale`, `not_built` and anything else are false. No environment variable can stand in for the file, a binary without it does not compile, and the hatch and the hard UI-build failure are unchanged. The status answer uses it | Unit `only_a_proven_frontend_build_claims_the_native_sign_in_page` (every unproven state false; the binary's claim equals its recorded build). `auth_router` asserts the served flag equals the proven state. Measured: a hatch build (state file `stale`) serves `false`, including with a forged ambient `YARAN_UI_BUILD_STATE=built`; a real build serves `true` (below) |
| 2 P1 | A reload admitted any `yaran` status and ignored a probe mismatch, so a changed instance at the route was loaded with the old instance's context | One verdict on both platforms (Android `RouteDriver.verdict`, iOS `DocumentVerdict.of`): a probe `mismatch`, or an instance other than the one observed at the last selection, means a new selection (whose existing rules drop the other instance's record and cookies, or close `instance_changed`), never an admission | Android `aRendererRecoveryThatFindsAnotherInstanceNeverCarriesTheOldSession`: A's record and cookie gone, nothing loaded, the password asked for. iOS `aDocumentOfAnotherInstanceIsANewSelection` |
| 3 P1 | Document navigations the WebView started itself (served reload, link, form, in-place new window) bypassed admission | Android: `MachineWebViewClient.shouldInterceptRequest` admits every main-frame document request on the WebView's request thread (never the UI thread). The native load's own request carries a one-shot pass bound to its generation and URL without the fragment; anything else is probed synchronously, and a refused request gets an empty 204 while the verdict is acted on, on the main thread. iOS: `NavigationDelegate.admitDocument` is asked for every main-frame document navigation the policy allows, the decision handler is called exactly once, and the native load passes its own. Same-document fragment and history moves make no request (Android) or are recognised (`isSameDocument`, iOS) and are untouched; subresources are not documents | Android `aDocumentThePageStartsIsAdmittedLikeANativeLoad` (through the real client: a subresource is not probed, a compatible reload loads, a reload after a downgrade gets 204 and closes `upgrade_required`) and `theNativeLoadsDocumentNeedsNoSecondProbe`. iOS `theNativeLoadPassesItsOwnDocumentOnce`, `onlyAFragmentMoveIsTheSameDocument` and source wiring |
| 4 P1 | A healthy resume granted an admission that only a later reload spent | Granted only for an impending load (a kept route with a retry, a chosen route). A kept page, a load that becomes a password sheet, and a blocked or unreadable session revoke it | Android `aKeptPageHoldsNoAdmissionForALaterReload` (kept, then capability lost, then reload: probed and closed). iOS `theNativeLoadPassesItsOwnDocumentOnce` (revoke) and wiring |
| 5 P1 | iOS: a login that awaited the network kept its session over a newer sign-in or recreated a removed machine | `DirectSessionStore.epoch(host)` counts writes and removals. `DirectFlow.post` reads it before the login, and `DirectLifecycle.keepIfCurrent` keeps the session only when the window still owns the work and the epoch is unchanged. Otherwise the new token is revoked on the machine, nothing is stored, and the answer is `cancelled` | `aLateLoginNeverReplacesANewerSignIn` (B kept, only A's token revoked), `aLateLoginNeverRecreatesARemovedMachine`, `aLateLoginOfAWindowThatMovedOnIsRevokedAndACurrentOneKept` |
| 6 P2 | Android: a replaced sign-in's late browser result (redirect, verification failure, cancel) consumed the newer sign-in | `HandoffClient.onRedirect` ends a pending sign-in only for a callback carrying its own `state` (`CallbackUrl.carriesState`). Anything else is ignored before parsing or cleanup; with nothing pending, the marker path for a restarted process is unchanged. Auth Tab results are bound to their launch (`SignInFlow.launchedWithResult`/`ownsNextResult`, process-wide, in launch order), and a replaced launch's result is ignored whole. A replaced sign-in releases its own hold, so each releases exactly once | `aReplacedSignInsLateRedirectLeavesTheNewOneAlone` (A's state, garbage and stateless answers ignored; B ends once, the hold released once), `SignInLaunchTicketTest`. Existing tests now expect a wrong-state or wrong-form callback to be ignored rather than end the pending sign-in |
| 7 P2 | iOS: an old org route's renewal failure (cancel, refusal) still showed reauth or a toast over the new route | `RenewalCoordinator.renewNow` delivers no ending of a renewal whose route was left (success or failure), and the window's renewal completions also check their route ticket | `aRenewalOfTheOldRouteDoesNothingOnTheNewOne` for success, cancel and refusal, `aRenewalOfTheCurrentRouteIsHeard` |
| 8 P2 | iOS: the shared-files confirm and Files picker of the old page attached B's files to A's chooser | `PendingChooser` captures the held files and the route ticket when the confirm opens. Attach delivers only those files, only while owned; a switch or close answers the old chooser with nothing, once, dismisses its sheet and keeps the held files | `anOldPagesChooserGetsNothingOnceAndTheFilesStay`, `aPickerEndingAfterTheSwitchDeliversNothing`, `theCurrentPagesChooserGetsItsHeldFiles`, wiring |

Mutation checks this round, each reverted and each failing its tests:
- **Rust:** the flag always true.
- **Android:** no request interceptor, verdict ignoring the observed instance, a kept page granting, a pass not spent, no callback state ownership, no launch ticket, a replaced sign-in keeping its hold.
- **iOS:** verdict ignoring the observed instance, a pass not spent, a stale renewal heard, `keepIfCurrent` without the epoch, the chooser ignoring ownership, a reload counted as the same document, the native pass unwired.

Build-state limits: `native_auth_ui` proves that this binary's build script ran the frontend build from this checkout, not that the bytes still match on disk later. The Brotli-staged copy is what is embedded. Exact source-to-embedded byte comparison is the parent's separate check. Android's `shouldInterceptRequest` coverage of POST and back-forward-cache restores is per Chromium's documented behaviour: a back-forward restore makes no request and shows an already admitted document. It was not observed on a device.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 159 tests, core 24, secure-store 4, app 6, 0 failures; FOSS dependencies, ktlint, detekt and lint (no new issues over the existing baseline) and `assembleFossDebug` pass. The release guard passes.
- **Swift:** YaranCore 44, MachineViewCore 134, Catalyst type-check clean.
- **Plugin TS:** 65 tests.
- **Rust:** fmt and clippy (`-D warnings`) clean; `auth_router` 79 and the auth and web-assets unit tests 119 pass under the hatch (recorded state `stale`, flag `false`, also with a forged ambient `YARAN_UI_BUILD_STATE=built`). The capability tests pass in a real build (recorded state `built`, flag `true`).
- **Module headers and line gate:** pass. `build.rs` grew 2 lines, recorded with `--accept-growth` and a reason. The capability lives in `auth/status_answer.rs`, so `web_assets.rs` and `routes.rs` did not grow.

## 12. Sol native review round 8 (REVISE, three reproduced findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | Android: a login answered after its window closed or was replaced was still saved, leaving an orphan session | `DirectFlow.post` receives the window's ownership check and asks it again once `cli-login` has answered, before anything is saved. Work the window no longer owns revokes only the token it just got, stores nothing, revokes nothing else and answers `cancelled`. A user's own sheet cancel is unchanged. No epoch check is needed here, unlike iOS: sign-in, removal and keep share the one io thread, so no other change to the record can land during the login | `AbandonedLoginRobolectricTest`, with a loopback machine that holds the login answer until released: window closed in flight (nothing stored, only the late token revoked); window replaced in flight with a newer current session for the host (that session stands, only the late token revoked) |
| 2 P2 | Android: the process-wide FIFO was not the Auth Tab result's real identity, because AndroidX does not promise results in launch order | The FIFO is gone. Each Auth Tab launch registers its own `ActivityResultRegistry` entry, keyed by the launch's handoff state, and each result reaches the callback of the launch it was made through. Every ending carries that state: verification failure, cancel (after its grace), a launch that found no browser, and a redirect (by the `state` it carries). `HandoffClient` ends a pending sign-in only for its own state. A recreated launcher (a rotation, or a restarted process through the handoff marker) re-registers the awaited launch's key, so its result still arrives. A plain Custom Tab returns no result and keeps the generation check | `AuthTabRegistryRobolectricTest` on a real `ComponentActivity` and its real registry, dispatching by the request codes the launches really got: A's late verification failure, cancel and redirect in any order before B's end nothing and keep B's hold; B's result arriving first is still B's; a launch that finds no browser ends only itself; a recreated activity still delivers the awaited result. The FIFO's queue-only test is removed |
| 3 P2 | Android: a lock marker whose deletion failed was ignored and its key deleted anyway | `Vault.wipeLocked` checks that the marker is really gone and throws `CoreError.Unavailable` with marker and key both kept; the key is deleted only after the marker is | Core `aMarkerThatCannotBeDeletedKeepsItsKeyUntilARetryFinishes`: the real filesystem refuses the deletion (vault directory not writable), so the call is `unavailable`, not `invalidated`, the key and marker stay and the lock stays on; after the directory is writable again, a restart retries and completes |

Mutation checks, each reverted and each failing its tests: no recheck after the login, an ending ignoring its launch's state, a result callback bound to whatever launch is current rather than its own, no re-registration on a new launcher, an unchecked marker deletion. Unchanged and still passing: the round 1 to 7 fixes, the capability proof and the Rust and iOS suites.

Limits: the registry tests use Robolectric's AndroidX registry and request codes, not a real browser's Auth Tab. The process-death path (a result delivered to a fresh process) relies on the registry's documented saved-state restore and was not reproduced.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 164 tests, core 25, secure-store 4, app 6, 0 failures; FOSS dependencies, ktlint, detekt, lint and `assembleFossDebug` pass. The release guard passes (5 checks).
- **Swift:** YaranCore 44, MachineViewCore 134 (unchanged this round).
- **Plugin TS:** 65 tests.
- **Module headers and line gate:** pass.

## 13. Sol native review round 9 (REVISE, three findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | A credentialed status that answered too old (`native_auth_ui` not true) or from another instance was replaced by the earlier public answer, so a document reload was admitted after the change was discovered | Both `DirectAuth.status`es return the credentialed answer as it is classified: another instance, `upgrade_required`, offline or a refusal. The admission verdicts (`RouteDriver.verdict`, `DocumentVerdict.of`) then act on it: close `upgrade_required`, or a new selection that drops the old instance's session. Cookie isolation and the expected-instance check before the credential is sent are unchanged | Android, through document admission over loopback HTTPS: `aReloadWhoseAuthenticatedStatusIsTooOldIsRefused` (blocked, closes `upgrade_required`) and `aReloadWhoseAuthenticatedStatusIsAnotherInstanceChoosesAgain` (blocked; i1's record and cookie gone; password asked). Swift `aDocumentProbeActsOnTheAuthenticatedAnswer` over the stubbed protocol: the window's probe composition gives `refuse`, or `reselect` (`mismatch` with a recorded instance) |
| 2 P1 | Android: a main-frame form POST to another host was let through, and one to the same host on port 8443 borrowed the route's 443 admission | `RouteDriver.admitDocument` checks the complete origin before any pass, probe or admission: for http or https, only `https://<route host>` on the default port (none or 443). Anything else gets the blocked 204, nothing is sent to it, and no pass is spent. Non-network schemes stay with the navigation policy, as before. iOS: the navigation policy already blocks these; admission now checks the origin as well (`DocumentVerdict.isRouteOrigin`) | Android `aDocumentForAnotherOriginIsBlockedBeforeAnyPassOrProbe` through the real client: other-host POST, `:8443` POST and plain-http POST each blocked with 204, no request made, nothing acted on, the native load's pass intact; `https://host:443/` is the route's own. Swift `onlyTheRoutesOwnOriginIsAdmitted` (policy and admission) and wiring |
| 3 P2 | Android: an Auth Tab RESULT_OK dropped its launch identity, so a replaced launch's redirect naming the current state ended the current sign-in | The result's launch state travels with the redirect into `HandoffClient.onRedirect(uri, launch)`. A launch that is not the awaited one (the pending sign-in's, or after a restart the marker's) is ignored first, whatever state its URI claims, before any parsing or cleanup. An intent-delivered redirect has no launch and keeps the URI-state rule and the marker path | `aReplacedLaunchsRedirectClaimingTheCurrentStateEndsNothing` on the real AndroidX registry: A's entry answers RESULT_OK naming B's state; B is not ended and keeps its hold, then ends once from its own result. The round 8 registry tests still pass |

Mutation checks, each reverted and each failing its tests: the public-answer fallback (Android and Swift), port ignored, host-only origin check, the redirect without its launch, the launch check removed.

Limits: as in round 8, the registry tests use Robolectric's AndroidX registry, not a real browser. The Swift controller's origin guard is source-pinned and type-checked. Every probe ran against loopback stand-ins.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 168 tests, core 25, secure-store 4, app 6; FOSS dependencies, ktlint, detekt, lint and `assembleFossDebug` pass. The release guard passes (5 checks).
- **Swift:** YaranCore 44, MachineViewCore 136, Catalyst type-check clean.
- **Plugin TS:** 65 tests.
- **Module headers and line gate:** pass.

## 14. Sol native review round 10 (three findings) and the share-batch ownership gap: repairs

The share-batch contract was published first (`src/outcomes.ts`, `src/definitions.ts`, `test/contract.test.ts`, `mobile-parity-contracts.md` §4) and sent to the shell owner. It is in the table below.

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | Android: a namespace emptied by the wipe whose file could not be unlinked was reported deleted, so a legacy session left with no `names` index (an older build's partial save) survived an invalidation that reported success and deleted the marker and key | `Vault.write` throws `CoreError.Unavailable` when an emptied namespace's file exists and cannot be deleted. The wipe already keeps marker and key on any namespace failure (round 5), and the marker's own deletion is checked (round 8) | Core `anEmptiedNamespaceThatCannotBeUnlinkedKeepsTheLock`: a real refused unlink of that one file (macOS `chflags uchg`, directory writable) reports `unavailable`, keeps key, marker and lock, and still refuses the secret after a restart; once the file can be removed, a retry completes. It is skipped where `chflags` does not exist (Linux CI without root) and ran here |
| 2 P2 | iOS: a cold start handed the launch's file URLs to Capacitor's scene proxy, which replays them into `App.getLaunchUrl` and `appUrlOpen` | `SceneDelegate` no longer passes the connection options to `SceneDelegateProxy` (`UIScene.ConnectionOptions` cannot be copied without them). `ShareIntake.connect` holds the file URLs natively and, on the same first `capacitorViewDidAppear` the proxy uses, replays only the non-file URL contexts and the user activities through the proxy's public methods, after posting its will-connect notification. The warm path already filtered | `aColdStartNeverHandsAFileURLToJS` pins Capacitor's real proxy source (it does replay the connection's URL contexts into both channels), the scene delegate (the options never reach the proxy) and `connect`'s filter and replay. Catalyst type-check clean, no warnings. The scene path needs a UIKit host and Capacitor's bridge, so it is type-checked, not run |
| 3 P2 | A reload owed after a renderer loss was recorded only behind the lock, and Android cleared it before admission, so an unlocked crash whose reload found the machine offline left a blank page that a later healthy resume only re-injected | Every renderer termination owes a reload (Android `onRendererGone`, iOS `PageReload.contentTerminated`). It is settled only where a navigation is really submitted: Android `enter` (the `loadUrl`), iOS `reloads.loaded()` next to each `webView.load` | Android `anUnlockedCrashWhoseReloadFoundTheMachineOfflineIsStillOwed` (offline, then long-away healthy resume with the route kept: exactly one load) and `anAdmittedReloadThatSubmitsNothingStaysOwed` (admitted but no navigation submitted: still owed). Swift `reloadsHappenOnlyWhenOwed` (updated: an unlocked crash is owed until loaded) and `theWindowSettlesAReloadOnlyWhenItLoads` (wiring) |
| 4 | Share ownership: a press for share A could act on share B, because Capacitor runs plugin calls after a hop (Android: its plugin thread; iOS: its bridge queue, then main) and a new share is taken in on the main thread meanwhile | Every share gets an opaque batch id: a random UUID, minted per share (Android in memory; iOS the share's private folder name), unrelated to files, names, URIs or credentials. `shareStatus` and `shareReceived` carry it; `open({shareBatch})` and `discardShare({batch})` compare and act in one step (Android inside the synchronized `ShareHolder`; iOS in the same main-queue block, `ShareCommand`). Another share held rejects `share_changed`, leaving it and its pending event as they are; none held rejects `no_share` for open and resolves for discard; a malformed or missing id rejects `invalid_arguments`; the old `share: true` is refused, never succeeding without its files. The internal unconditional take and discard remain for intake and tests only | Android `ShareBatchRobolectricTest` through the real `MachineViewPlugin` methods with real `PluginCall`s: A shown, B arrives, A's Send and Discard refused `share_changed` with B and its event intact, then B's own Send delivers B's files. Controls cover the current batch, nothing held, malformed ids and the old flag. Swift `ShareBatchTests` runs `ShareCommand` (what the plugin calls) over a real on-disk inbox with the same cases, plus the plugin's delegation pinned by source. Plugin contract tests updated |

Mutation checks, each reverted and each failing its tests:
- **Android:** an unlink ignored; take or discard of any batch; the old flag accepted; an unlocked crash not owed; the owed reload cleared before submission. That last mutant survived the first regression, so I added the admitted-but-unsubmitted case, which kills it.
- **iOS:** take or discard of any batch; an unlocked crash not owed; cold-start files forwarded to JS; the options handed to the proxy.

One existing test changed meaning: `anUnreadableOrgSessionSaysSoAndStartsNoSignIn` treated any vault read of `handoff` as a sign-in start. Since round 8 the launcher reads the marker to re-register an awaited Auth Tab result. The test now checks what a start really does: it reads the install id and writes the marker.

Contract coordination: the shell compiles against the new types once it adopts `batch` and `shareBatch`. `mobile/app` is not edited here. Its `tsc` failures name the call sites it must change.

Limits:
- The iOS cold-start replay and the plugin adapters are type-checked and source-pinned only.
- The Android share tests drive the plugin through recorded calls, not a WebView.
- The unlink regression runs only where `chflags` exists.
- Nothing ran on a device.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 174 tests, core 26, secure-store 4, app 6, 0 failures; FOSS dependencies, ktlint, detekt, lint and `assembleFossDebug` pass. The release guard passes (5 checks).
- **Swift:** YaranCore 44, MachineViewCore 142, Catalyst type-check clean with no warnings.
- **Plugin TS:** `tsc` clean, 65 tests.
- **Module headers and line gate:** pass.

## 15. Sol native review round 11 (REVISE, four findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | The window's fresh sign-in id let a record from a known other instance through, so after a direct window with no recorded instance signed in at i1 and then found i2, the i1 session was kept and loaded | One rule on both platforms, `DirectSession.usable(observed, fresh)`: bound to the observed instance, or, only while no identity is known on either side (observed null and the record has no instance), the window's own fresh sign-in (`ownFresh`). `DirectSessionStore.current` and both `loadRoute` own-sign-in shortcuts use it, so a fresh id never outweighs a known instance. Instance ids stay public: consistency, not authorization | Android `FreshSignInRobolectricTest` through the real window over loopback HTTPS: sign in at i1 (one load, with the cookie), then a document admission answered by i2 drops the i1 record and cookie, loads nothing more and asks for the password. Swift `aFreshSignInNeverOutweighsAKnownInstanceMismatch` over the real store, the bootstrap cases, and the window's shortcut wiring |
| 2 P1 | Android: a vault directory that could not be listed counted as having no namespaces, so the wipe skipped them and deleted the marker and key, leaving a standard legacy token readable | `listVault` (new `VaultFiles.kt`) is empty only for a directory never created; one that exists and cannot be listed is `CoreError.Unavailable`. The wipe therefore fails before touching the marker or key. `eraseAll` still deletes the keys, which leaves anything on disk unreadable, then reports a listing or deletion failure instead of claiming a finished erase | Core `aVaultThatCannotBeListedIsNotEmpty` (the directory's read permission really refused, with a legacy secret and no `names` index): `unavailable`, the key and marker kept, the secret refused after a restart; with the permission back, the retry completes. A never-created vault wipes fine. `anEraseThatCannotListSaysSo`. The round 8 and round 10 unlink and marker tests still pass |
| 3 P2 | iOS: an open over a window was presented after a fixed 0.4 s, so a close in that time, or overlapping opens, could leave a window appearing after the close, and claimed share files behind | `WindowSlot` (core): opening over a window asks it to close and presents the new one from that window's own dismissal completion. A newer open replaces a waiting one; a JS close cancels it; an open that never shows (superseded, cancelled, or with nothing to present on) releases only the files it claimed, never a share held since. The plugin presents only through the slot | `WindowSlotTests` with fake windows: open then close (never shown, files released); overlapping opens (only the newest shows, the first's files released, the old window asked once); a stale dismissal shows nothing; no presenter releases files; no window shows at once. Plugin wiring pinned (no `asyncAfter`) and Catalyst type-checked; there is no UIKit run |
| 4 P2 | iOS: route A's password alert stayed up after a resume moved the window to B (only the file chooser was tracked) | `PendingSheet` answers the sheet once: the user's buttons respond, and a cancel dismisses only that one alert and answers with nothing. `OpenPrompts` holds the sheet and the file chooser; every route switch and close settles both (`settlePrompts`). The existing ownership checks at preflight, submit and POST stay | `PasswordSheetTests`: A's sheet up, the route switches: A dismissed and cancelled once, nothing posted, a late tap ignored, B's own sheet untouched and working. Wiring for switch, close, `onSheet` and the alert's buttons pinned and type-checked |

Mutation checks, each reverted and each failing its tests:
- **Both platforms:** a fresh id outweighing the instance.
- **Android:** a failed listing read as empty, an erase swallowing failures.
- **iOS:** close keeping the waiting open, a superseded open keeping its files, any dismissal showing the next, no presenter leaking files, the sheet left open, a cancel not once, a route switch not settling prompts.

Line gate: `Vault.kt` and `MachineViewActivity.kt` sit at 500. The listing and erase moved to `VaultFiles.kt`, and one KDoc became a trailing comment. Earlier text was not shortened.

Limits:
- The iOS presentation, sheet and window wiring is type-checked and source-pinned, not run in UIKit.
- The permission-refusal tests depend on the filesystem honouring a missing read bit for this user. That holds on macOS; root would bypass it.
- Nothing ran on a device.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 175 tests, core 28, secure-store 4, app 6, 0 failures; FOSS dependencies, ktlint, detekt, lint and `assembleFossDebug` pass. The release guard passes (5 checks).
- **Swift:** YaranCore 44, MachineViewCore 153, Catalyst type-check clean with no warnings.
- **Plugin TS:** 65 tests.
- **Module headers and line gate:** pass.

## 16. Sol native review round 12 (five findings): repairs

| # | Finding | Fix | Proof |
|---|---|---|---|
| 1 P1 | A kept route's resume asked for the password straight from the probe, before the session read. In a window with no recorded instance, signed in at i1 and back after 30 s to i2, the sheet came up over the i1 record and cookie, and an instance-less machine's own fresh sign-in could be asked again | One decision on every direct path (initial load, document reselection, the kept route's resume): Android `RouteDriver.settleDirect`, iOS `DirectLifecycle.settle` (core) through `settleDirect`. The session is read first through `current` (with the `usable` rule), any stale record is deleted and the host's cookies cleared, and only then is the sheet asked or the load or re-injection run. A window's own fresh sign-in on an instance-less machine (`ownFresh`) asks for nothing | Android `WindowRound12RobolectricTest` through the real window over loopback HTTPS: sign in at i1, long background, i2: record and cookie gone, then the sheet, nothing more loaded. Null/null: no second sheet, one login, the cookie back. The round 11 `FreshSignInRobolectricTest` (document reselection) still passes. Swift `DirectSettleTests` over the real store and a fake jar: i1 to i2 drops both and answers `signIn`; null/null fresh answers `proceed`; a window gone at the start or during the cookie clear decides nothing and deletes nothing. The window's wiring is pinned, and no decision may read the session around `settle` |
| 2 P1 | Org cleanup reported success while skipping sessions: Android mapped a failed listing to none and skipped records it could not read; Swift skipped unreadable records. The device identity was then deleted | `hostsFor` / `hosts(orgId:)` propagate a listing or record failure. `wipeOrgData` (Android) and `SessionStore.wipe` (iOS) delete nothing, the device key included, until every session is found. Callers audited: the plugin's sign-out rejects with `vault_locked` or `native_error` ("the sign-out did not finish") instead of resolving. `device_revoked` still returns `DeviceRevoked` and records a failed cleanup in diagnostics | Android `CoreAdaptersTest.anOrgWipeThatCannotFindEverySessionDeletesNothing` over a real vault: an unreadable listing, then one record failing to read. Each time nothing is deleted, the install id is kept and no web data is cleared, and the retry wipes everything. Swift `OrgWipeTests` with a failing vault at both points, plus the plugin's reject codes pinned |
| 3 P2 | A lone direct window with a recorded instance i1, whose resume probe found i2, was treated as offline (the page kept) | `NoRoute`: a lone `direct` window whose current route answered as a yaran (a mismatch, not silence) closes `instance_changed` with its host. The true-offline keep and the multi-route fallback are unchanged | Android: recorded i1, long background, i2: closed `instance_changed` with the host, no load after the first. Swift: the clause pinned in the window source, Catalyst type-checked |
| 4 P2 | Two password asks before a preflight answered ran two preflights and two sheets. The window held only the second, and the first stayed up after close | One attempt per window and route is reserved before the preflight and released when the attempt ends. Android: `signing` holds the open generation, so a new open or route is never blocked. iOS: `OpenPrompts.reserveSignIn` gives out a token, `settleAll` (route switch, close) ends the attempt, and a late ending of an old token frees nothing newer | Android, through the real window: two asks after the first sheet's cancel give one sheet; close leaves no sheet and posts nothing. A replacing open dismisses the old sheet, and its own ask signs in normally (one login, the cookie set). Swift `onePasswordAttemptPerRoute` |
| 5 P2 | A cookie injection queued on the Android main thread ran after its window closed or was replaced | `CookieInjector.inject` and `clearHost` take `owned` and check it inside the queued step, right before the cookie store is touched. Callers audited: `load`'s two injections, the org resume injection, `RouteDriver.injectDirect` and the stale drop in `directReader` all pass the open generation they were started for | Android, through the real window: a load's queued cookie, then close: no cookie, no load. A re-injection's queued cookie, then a replacing open: no cookie. A stale drop queued for an open replaced before it ran leaves the jar alone |

Mutation checks, each reverted and each failing its tests:
- **Android:** the kept-route sheet decided before the read, `ownFresh` ignored, the `NoRoute` clause removed, the reservation removed, `inject` not checking `owned`, `clearHost` not checking `owned`, `loadRoute` deciding before the read.
- **iOS:** `settle` not clearing a dropped record's cookies, ignoring `ownFresh`, or not checking `owned` at the start; the reservation removed; `settleAll` keeping the attempt; a release of any token; the kept route bypassing `settleDirect`; the `NoRoute` clause removed; `hosts(orgId:)` swallowing a read failure with `try?`.

The iOS window mutants (kept-route bypass, `NoRoute`) fail source pins, not a UIKit run.

Line gate: `MachineViewActivity.kt` is at 499. One injection call was folded onto one line; nothing was moved or accepted as growth.

T67 (`SECURITY.md`, `docs/operations/threat-model.md`) now says the stale record and cookies go before the password is asked, on every path, and that a queued cookie change checks ownership right before it runs.

Limits:
- The iOS window wiring is type-checked and source-pinned, not run in UIKit.
- Robolectric's main looper stands in for the real one in the interleaving tests.
- Nothing ran on a device.

Checks this round, on `a3acc113f` plus this work:
- **Android gate set:** machine-view 184 tests, core 28, secure-store 4, app 6, 0 failures; FOSS dependencies, ktlint, detekt, lint and `assembleFossDebug` pass. The release guard passes (5 checks).
- **Swift:** YaranCore 44, MachineViewCore 161, Catalyst type-check clean.
- **Plugin TS:** 65 tests.
- **Module headers and line gate:** pass.

## 17. Sol native review round 13: closed direct-reader ownership

The parent applied the one-line repair: `RouteDriver.directReader` now captures `w.live(gen)`, which checks both the open generation and whether the activity is finishing or destroyed. Checking the generation alone let a closed window delete a host session on the IO queue or clear another owner's cookie on the main queue.

Two regressions were retained in `WindowRound12RobolectricTest` through the real window:
- Block IO, queue re-injection, close, then release IO: the current host record survives.
- Queue a stale-session cookie clear, close before it runs: the next owner's cookie survives.

Both tests failed against the old predicate before the fix. With the fix, all 186 machine-view tests pass. FOSS dependency verification, ktlint, detekt, lint and `assembleFossDebug` pass. No Swift, TypeScript, contract, Rust or server behavior changed, so their suites were not repeated for this guard. The previous full review passed those unchanged scopes.

The timing proof uses Robolectric and a loopback HTTPS stand-in. Nothing ran on a physical device. A fresh full native review is still required; this entry does not approve or release the APK.


## 18. Sol native review round 14: policy-approved local documents

The parent applied a small guard in the iOS controller's `admitDocument`. After navigation policy approves a document, non-HTTP(S) local documents complete immediately. HTTP(S) documents retain the complete HTTPS origin check and the existing one-use pass or fresh machine probe. `DocumentVerdict.isRouteOrigin` and navigation policy were not weakened.

An executable check extracted the exact current controller method, with a fake probe and the real `NavigationPolicy`, `RouteTenure` and `DocumentVerdict`. The allowed same-origin blob, `about:blank` and `about:srcdoc` cases each answer once without probing or spending the network pass. Same-origin HTTPS, including explicit port 443, probes. Foreign hosts, port 8443 and plain HTTP answer false with no probe. The previous review's frozen-method execution reproduced the local-document refusals before the fix.

Evidence and the runnable extracted check are in `/private/tmp/yaran-main-integration.UcYcSM/local-document-admission-probe.swift` and its log. All 161 MachineViewCore tests pass and the full Catalyst type-check is clean. The full temporary-index module-header and line gates pass. Android, Rust and the served frontend were unchanged and were not rebuilt for this iOS-only correction.

This is an extracted-method check and type-check, not UIKit navigation on a device. Full native/capability approval remains pending a fresh independent review. The real index, private configurations and existing worktrees are untouched; the APK remains held.

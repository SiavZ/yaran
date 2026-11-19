# Mobile push visibility validation (parity gap G4)

Ledger for G4 in `t3-mobile-parity-investigation.md`: do not notify the phone
about the agent tab it is showing. Date: 2026-11-17.

## Verdict

The engine already does this. No production logic was added.

A page that drives an agent tab (it owns the input, the document is visible and the
pane is on screen) sends a viewed beat every 2 s. The server passes it to
`Engine::note_agent_viewed_if_known`, which records the view only if the id is a
real tab. The push-only attention set uses the same `attention_engaged` check as the
sidebar, with a 3 s window. So while the view is held, that tab's signal raises
neither the sidebar flag nor a phone push. The phone's machine view loads this same
web UI, so its beat goes through this same path.

Scope of the suppression, as the code has it:

- Per tab, not per agent: a sibling tab of the same agent still raises.
- Only on the machine whose engine got the beat, over an authenticated PTY socket.
- Only for the input owner. A watcher sends `viewed:false`.
- Only while beats keep arriving. A hidden page (app in the background, screen off)
  stops beating, and suppression ends at most 3 s later.
- Rising-edge semantics, event ids and payload contents (ids, label, project,
  state token, no output) are unchanged.

## Evidence

- New test: `push_hook_a_held_view_of_the_tab_suppresses_its_push_and_nothing_else`
  in `crates/yaran-core/src/engine/push_hook_tests.rs`. It spawns a real signalling
  PTY, holds the view through `note_agent_viewed_if_known` and checks three things:
  no push and no sidebar flag for the viewed tab, a raise for an unviewed sibling
  tab, and a raise once the view is older than the window.
- Mutation check: with `attention_engaged` forced to `false`, the test fails at
  "a held view raises no push for the viewed tab". With the code restored, it passes.
- `cargo test -p yaran-core --lib push_hook`: 10 passed.
- `cargo clippy -p yaran-core --all-targets --all-features -- -D warnings`: clean.
  This run and the test run above used `YARAN_DISABLE_UI_BUILD=1`, because the
  checks were Rust-only.
- Web gating (`owner && visible && onScreen`, minus the post-return grace):
  `crates/yaran-web/web/src/lib/viewedPing.test.ts`, 16 passed.
- Module-header and line gates: OK.

Not verified on a device: that the machine-view WebView reports
`document.visibilityState = "hidden"` when the screen locks or the app goes to the
background. This is standard behaviour for Android WebView and WKWebView, but no
device was driven for this ledger.

## Native fix: the page under the App Lock cover is hidden

Before this fix both platforms only drew an overlay over the WebView while the App Lock
cover was up (Android `MachineViewActivity.showLockCover`, iOS
`MachineViewController.updateLockCover`). The page still reported itself visible and
kept sending `viewed:true`, so a phone in the foreground but still locked held back
attention and the push for the tab behind the cover.

What changed (machine-view only, no web, engine, bridge or injected script change):

- **Android.** `MachineViewActivity.syncPageVisibility()` calls `WebView.onResume()` only
  while the activity is resumed, no cover is shown and `AppLock` is unlocked, and
  `WebView.onPause()` in every other case. It runs on activity resume and pause, when the
  cover is shown or hidden, and when a WebView is attached (including the one recreated
  after a renderer crash under the cover). An unlock that lands while the activity is
  paused leaves the page paused until `onResume`.
- **iOS.** `updateLockCover()` removes the `WKWebView` from the view hierarchy while the
  lock cover is up and pins it back, behind the overlays, at unlock. A WebContent crash
  keeps the same `WKWebView`, so it stays detached until the unlock. The existing
  `LockGate` reload at unlock is unchanged.

Cookie injection, the lock gate, the privacy cover, `FLAG_SECURE` and renderer recovery
paths are otherwise unchanged.

### Why these calls (upstream source, not a device run)

- **Android.** Chromium `AwContents.onPause()` sets `mIsPaused` and calls
  `updateWebContentsVisibility()`, which calls `WebContents.onHide()` when
  `BrowserViewRenderer::IsClientVisible()` is false. That function returns false whenever
  the WebView is paused, and otherwise depends on attachment and window visibility. View
  visibility is not an input, so `View.INVISIBLE` would not hide the page. Source:
  `android_webview/java/src/org/chromium/android_webview/AwContents.java` and
  `android_webview/browser/gfx/browser_view_renderer.cc` at Chromium
  `cc1a78ecc5ed3ad4100344f40755fdebbf4e31b1`.
- **iOS.** WebKit's `PageClientImpl::isActiveViewVisible()`
  (`Source/WebKit/UIProcess/ios/PageClientImplIOS.mm`, WebKit `main` read 2026-11-17)
  counts the page visible when the view is in a window (`[webView window]`) and the app
  is not in the background (`_isBackground`), plus picture-in-picture cases. `isHidden`
  is not an input, so the `isHidden` recipe suggested earlier would have changed nothing.
  `-[WKWebView didMoveToWindow]` calls `activityStateDidChange(allActivityStates())`, so
  detaching and re-attaching updates the page's visibility. While the app is in the
  background, `_isBackground` keeps the page hidden whether or not the view is attached,
  so a re-attach at unlock cannot make a backgrounded page visible.

### Evidence

- `MachineWindowRobolectricTest.theLockCoverHidesThePageUntilTheWindowIsResumedAndUnlocked`:
  an open, unlocked window is not paused; an activity pause pauses it; a lock pauses it;
  pause/stop/start/resume while still locked keeps it paused; an unlock while the
  activity is paused keeps it paused; resume after the unlock un-pauses it.
- `aRendererCrashUnderTheCoverLoadsNothingUntilTheUnlock` now also checks that the
  recreated WebView starts paused and is un-paused at the unlock.
- The test shadow `PauseShadowWebView` keeps one paused flag, like `AwContents`.
  Robolectric's own `ShadowWebView` only records that the calls happened at some point.
- Mutation check: with the condition reduced to `resumed` (cover and lock ignored), both
  tests fail ("the page behind the lock cover is hidden", "a page recreated under the
  cover starts hidden"). With the code restored, both pass.
- `./gradlew :yaran-machine-view:testDebugUnitTest`: 80 tests, 0 failures.
  `:yaran-machine-view:lintDebug`: 0 errors; the 15 warnings were already there and none
  is on a changed line.
- iOS: `bash mobile/plugins/machine-view/ios/typecheck-catalyst.sh` type-checks
  `MachineViewController` against Mac Catalyst UIKit. `MachineViewCore/test.sh`: 80 tests
  pass. This machine has no Xcode, so there is no iOS build and no UIKit test of the
  controller. The iOS change is verified by type-check and WebKit source only.

## What is proven where

| Claim | Proof | Status |
| --- | --- | --- |
| A held view of a tab suppresses that tab's sidebar flag and push, and only that tab | Engine test above, mutation-checked | Proven (Rust) |
| The web stops beating when the document is hidden | `viewedPing.test.ts` | Proven (Vitest) |
| Android pauses the WebView behind the cover or when paused, and resumes it only when resumed and unlocked | Robolectric tests above, mutation-checked | Proven (Robolectric) |
| A paused Android WebView reports `document.visibilityState = "hidden"` | Chromium source | Source only |
| A detached `WKWebView` reports hidden; re-attached in a backgrounded app stays hidden | WebKit source | Source only |
| The iOS controller detaches and re-attaches at the right moments | Catalyst type-check only | Not tested |

Device unknowns, none of them observed on a device:

- That the page really fires `visibilitychange` to hidden under the cover on both
  platforms, and visible again after unlock, on the shipped WebView and iOS versions.
- That the PTY socket parks and comes back cleanly after a long lock (the web's own
  reconnect path, unchanged here).
- Whether iOS suspends the WebContent process while the view is detached for a long time,
  and how the page recovers if it does.
- The iOS screen-capture privacy cover (`updatePrivacyCover`) still only draws over the
  page. It is not the App Lock and was left out of scope, so a page shown under that
  cover still counts as viewed.

## G3: Android network-change wake

`mobile/plugins/machine-view/android/src/main/AndroidManifest.xml` now declares
`android.permission.ACCESS_NETWORK_STATE`, a normal permission with no prompt.

- Source evidence: Chromium
  `android_webview/glue/java/src/com/android/webview/chromium/WebViewChromiumAwInit.java`
  at `cc1a78ecc5ed3ad4100344f40755fdebbf4e31b1` turns on the WebView's automatic
  network-change notifier only when the app holds this permission. Without it the page
  never gets `online`/`offline` and `navigator.onLine` does not follow the network.
- No `setNetworkAvailable` fallback was added. `AwContents.setNetworkAvailable` turns off
  automatic detection for the whole process, so it is only worth it if the device check
  below fails. Nothing reloads the page on a healthy network change, and there is no
  injected script or bridge.
- `ManifestTest.asksForNetworkStateSoTheWebViewFiresOnline` pins the library's permission
  set to `INTERNET` and `ACCESS_NETWORK_STATE`. The merged manifests for `fossDebug` and
  `playRelease` (built with `-PappIdOverride=<app-id>.connectivitytest`, not
  installed) carry the permission, contributed by `:yaran-machine-view`.
  `BuildOutputsTest` checks permissions with `contains`, so it needed no change.
- iOS: no change. WebKit fires `online`/`offline` itself.
- Device unknown: airplane mode on then off in the machine window should fire `online`
  and reconnect a parked socket at once. Not run.

## Native `setVisibleAgent` hook (not used)

`mobile/plugins/push` exposes `setVisibleAgent`. Android's `NotificationPresenter`
drops a matching push; iOS's `PresentationPolicy.foregroundOptions` does the same,
in the foreground only. Nothing in production calls it today. Nothing should start
calling it for G4, because the engine path above already covers the case. If a
caller is ever added, it must clear the value on pause, background and lock.
Android's check does not look at foreground state, so a stale value would hide
pushes while the screen is locked.

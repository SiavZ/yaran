# Mobile agent connectivity: implementation and validation ledger

Scope: why an installed Android build could list a Cloud Connect machine but not open it, what
changed, how each change is checked, and what is still unproven. Values someone else supplies
are written as `<org-control-plane>`, `<machine-host>` and `<publisher-domain>`.

## Reported symptom

On the installed debug APK (`<app-id>`), the org's machine is listed. Tapping the machine
row, or its `⋯` menu and then Open, does nothing: no machine window, no sign-in, no message.

## Root cause (confirmed in code, regression-tested)

Both entry points call `OrgSection.open` in `mobile/app/src/screens/machines/MachineList.tsx`,
then `openMachine`, then the native `MachineView.open`.

1. **Android refused every real open.** `MachineState.of`
   (`mobile/plugins/machine-view/android/.../MachineState.kt`) checked `orgId` against
   `^[A-Za-z0-9._:-]{1,128}$`. The shell's `orgId` is the org's canonical OrgUrl
   (`https://<org-control-plane>`), and the `/` characters fail that pattern, so
   `MachineViewPlugin.open` rejected with `invalid_arguments` before any activity started. The
   native tests used `"org1"` as the org id, which is why nothing caught it. iOS checks only that
   the id is non-empty, so iOS was not affected.
2. **The shell threw the rejection away.** The row and the menu both call `void open(m)`, and
   `openMachine` did not catch a rejection from `MachineView.open`, so the failure never
   reached the screen. `open` also awaited the last-machine setting write first, so a failed
   write blocked the open the same way. The same silent path served the cold-start "reopen last
   machine" and the notification tap.

## Changes

| Area | File | Change |
|---|---|---|
| Native open | `MachineState.kt` | `orgId` is validated as an OrgUrl (`HostRules.ORG_URL`, at most 261 characters); the machine id and host rules are unchanged. |
| Shell open | `lib/openMachine.ts` | A native rejection becomes `{ok:false, reason:'native_refused', code}`. The code is kept only if it is a safe token. Each refusal has a sentence (`openFailureMessage`). |
| Shell UI | `screens/machines/MachineList.tsx` | A failed last-machine write is logged and does not block the open. A failed open raises an error toast through `lib/notify.ts` and writes a diagnostics line. |
| Org API | `lib/api.ts` | A rejected `Session.request` (Android rejects with `vault_locked`, and now `native_error`) becomes the new `ApiFailure` kind `native_error`, with its own sentence. A rejected `Session.meta` becomes `refused`. |
| List refresh | `lib/machinesStore.ts` | A rejected list call now clears its in-flight entry. Before, one rejection pinned every later refresh of that org to the same rejected promise, so the list stayed on "Loading machines…" until the app restarted. |
| Native worker | `SessionPlugin.kt` | An unexpected exception on the `machine-view-io` thread now rejects the call with `native_error` and writes a diagnostics line (exception class only). Before, the uncaught exception killed the app process. |
| Native sign-in | `HandoffClient.kt` | A key store or vault failure in `begin` ends that sign-in with a diagnostics line, mapped the way iOS maps it (`vault_locked`), instead of crashing. |
| Native window | `MachineViewActivity.kt` | An unreadable session record is treated as "sign in again", not a crash. |
| Key store | `AndroidKeyStoreBackend.kt` | Some StrongBox implementations fail with `ProviderException` rather than `StrongBoxUnavailableException`. Generation now falls back to the TEE in both cases. |
| Device testing | `mobile/android/app/src/debug/AndroidManifest.xml` | Debug builds only: MainActivity is `standard` and `resizeableActivity`, so each display gets its own instance. MachineViewActivity is `singleTop`, so it opens in the caller's task. Release keeps `singleTask` for both. |

## Regression checks

- `mobile/app/src/screens/machines/machines.test.tsx`
  - The `⋯` menu → Open path reaches `MachineView.open` with the org URL as `orgId`.
  - A native `invalid_arguments` rejection raises an error toast that names the code.
  - A failing last-machine write still opens the machine.
  - A rejected list call shows "Unlock the app, then try again.", and Retry then loads the list.
- `mobile/app/src/lib/openMachine.test.ts`: a native rejection becomes `native_refused` with a sanitized code.
- `mobile/app/src/lib/api.test.ts`: a rejected native call is a failure with a sentence, never a throw.
- `MachineWindowRobolectricTest.orgIdIsTheCanonicalOrgUrl` (machine-view, Android): the OrgUrl is accepted, and id-shaped and malformed org ids are refused. The other window tests now use a real OrgUrl.
- `BuildOutputsTest.launchModesAreStandardOnlyInDebug` (`:app`): checked against the `fossDebug` and `fossRelease` merged manifests.

## Checks run

- `mobile/app`: `tsc --noEmit`, `eslint`, `vitest run`: 30 files, 263 tests passed. `lingui extract` updated `messages.po` with the new sentences.
- `mobile/android` with JDK 21: `assembleFossDebug`, `testFossDebugUnitTest`, `:yaran-machine-view:testDebugUnitTest` (78 tests, 0 failures), `ktlintCheck`, `detekt`. All passed.
- `node tools/module-headers/bin/module-headers.mjs --check` and `--lines --check`: OK.
- Packaged APK checked with `aapt2`: package `<app-id>`, MainActivity launchMode `standard`, MachineViewActivity `singleTop`, and the bundled shell contains the open-failure handling.
- No Rust changed, so the cargo gates were not run.

Debug APK (not installed): `mobile/android/app/build/outputs/apk/foss/debug/app-foss-debug.apk`.
`publisherDomain` is empty, so this is a development build that uses the
`yaranapp://auth/callback` sign-in reply.

## Infrastructure observed (read-only)

- `GET https://<org-control-plane>/v1/meta` answers 200 with `setup: closed` and protocol 1..1.
- Credentialed org routes and `https://<machine-host>/__yaran/handoff` answer 302 to the
  team's Access login, as designed.
- The local yaran's Cloud Connect leg reports `ready`, and its credentials name a paired
  machine in that org. So the phone's path is a deployed control plane plus a live tunnel; no
  infrastructure is missing for a development build.

## Not yet proven on a device

- The steps after the window opens:
  - machine sign-in through the system browser and Access;
  - the consent page, then the `yaranapp://` reply;
  - `CF_Authorization` injection and the first load of the machine's web UI (gate G1);
  - expiry and renewal (G12).

  All of it is covered by unit tests only. The parent's device run should confirm it.
- A release build needs a real `publisherDomain`, Digital Asset Links on `<publisher-domain>`,
  and a Worker `APP_CALLBACK_URLS` that matches it. A development build does not.
- The agent experience inside the window is the machine's own yaran web UI (agents, tabs,
  terminals, compose bar). This ledger fixes the way in and adds nothing native on top. The
  feature gaps against T3 Code's app (pairing without Cloud Connect, several routes per
  machine, waking on a network change, push suppression, the share sheet, verified agent
  links) are listed in `t3-mobile-parity-investigation.md`. None of them is needed to fix the
  reported symptom, and none is implemented here.
- On a key store failure in `begin`, Android shows the same sentence iOS does ("Unlock the app
  to sign in."). The diagnostics line has the real exception class. Better wording needs a new
  `SignInOutcome` in the shared contract on both platforms.
- The two platforms spell the rejection code differently: Android uses `invalid_arguments`
  and iOS `invalid_argument`. The shell treats both the same way.
- The debug overlay changes task behaviour only in debug: a second Open while a machine window
  is in front stacks a second window instead of replacing the first.

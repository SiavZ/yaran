# Phase 15 — Mobile: `machine-view` native component and SSO/handoff client

**Track:** B (mobile) · **Parallel-safe with:** 04–14, 16–18 (Wave B; work item 1 lands first so 14 and 16 can code against it)
**Depends on:** 01 (header and 500-line gate), 02 (sealed envelope §8, handoff query and consent, redirect allowlist, URI schemes §10, UA token §11, error envelope, `Yaran-Refusal` and close code 4401 §13), 03 (G1, G6, G12, G13); code-level against Wave B peers developed to the 02 contract: 06 (control-plane handoff W16/W16b), 11 (machine handoff Y1/Y1b), 13 (UA recognition, `yaranapp://` control URLs, external-link contract), 14 (shell, `plugins/core`, flavors, publisher build config) · **Blocks:** 16 (tap → open agent; native org API client for push registration), 19 (Wave C)

## Goal

The phone opens one of the user's machines into the full yaran web UI. Three pieces make
that possible:

- **The machine view.** A hardened native WebView with **no JS bridge** (D9).
  - It is pinned to that machine's exact host.
  - It is authenticated by injecting the Access JWT as the `CF_Authorization` cookie (D8).
- **The sign-in client.** The phone gets that JWT through a **system-browser SSO plus sealed
  handoff**: ASWebAuthenticationSession on iOS, Android Auth Tab with a Custom Tab fallback.
  - It runs once for the control plane (Worker JWT) and once per machine.
  - Release builds return on the verified https callback `https://<publisher-domain>/auth/callback`
    (Android App Link, iOS `.https` callback, so the iOS minimum is 17.4). Only builds compiled
    without a publisher domain use `yaranapp://auth/callback`, declare `build=dev`, and show a
    visible warning (D8).
  - Each handoff page asks the person to confirm "Sign this device in to `host`?" with one tap
    before it seals (D8). The page is remembered per (host, device key) (D24): every request is
    signed with a per-org, non-exportable P-256 **device key** held in Android Keystore or the
    iOS Secure Enclave, so after one Continue a renewal from this phone skips the page.
- **Session upkeep and the org API client.** Per-host JWTs live in the device vault, never in
  JS (D22). The native org API client performs every Worker call the app makes, push
  registration and mutes included (Phase 16 orchestrates in JS and calls it). A renewal
  scheduler handles expiry. Every failure path ends in a sentence and an action.

Both platforms ship the same behaviour, decided by pure policy modules pinned by shared
fixtures.

## Evidence

All online sources were read on 2026-11-14.

**Auth model**

- Google blocks OAuth in embedded WebViews. Access redirects to the IdP, so an in-WebView Access
  login hits that block.
- Custom Tabs and ASWebAuthenticationSession never share cookies with app WebViews. Apple says:
  "There's no way to share cookies between the two."
- Sources: R5 §2 facts 1–3, 8 and 12, https://developer.apple.com/forums/thread/774380.

**Android: Auth Tab and Custom Tabs**

- Auth Tab needs androidx.browser 1.9.0+ and Chrome 137+. The current stable release is 1.10.0.
- `AuthTabIntent.registerActivityResultLauncher(activity, cb)` must be called before the
  activity is created. Then call `launch(launcher, uri, "yaranapp")`.
- Results:
  - `RESULT_OK` carries `resultUri`.
  - `RESULT_CANCELED` comes back as well. Where Auth Tab is unsupported, the browser falls back to
    a Custom Tab, so the redirect has to be handled through an intent too.
  - `RESULT_VERIFICATION_FAILED` and `RESULT_VERIFICATION_TIMED_OUT` apply to https redirects only.
- For an https redirect, `launch(launcher, uri, host, path)` returns only when the app's
  Digital Asset Links verification for that host passes.
- `CustomTabsClient.isAuthTabSupported()` checks support.
- Sources: https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab,
  https://developer.android.com/jetpack/androidx/releases/browser.
- Whether Auth Tab has an ephemeral mode is **UNVERIFIED**, and it is not used.

**iOS: ASWebAuthenticationSession**

- `init(url:callback:completionHandler:)` with `Callback.https(host:path:)` or
  `Callback.customScheme` requires iOS 17.4. The `.https` form needs the host in the app's
  associated domains (Phase 14 entitlement; Phase 21 AASA).
- `init(url:callbackURLScheme:)` (iOS 15–17.3) is not used: the deployment target is 17.4 (D8).
- `prefersEphemeralWebBrowserSession` defaults to false.
- Errors include `canceledLogin`.
- "Only the calling app's session receives the authentication callback, even when more than one
  app registers the same callback URL scheme."
- Source: https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession.

**Device key (D24)** (contract in 02 §8.1; platform facts below to re-check when work item 6 starts)

- Android: `KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN)` with `ECGenParameterSpec("secp256r1")`,
  `DIGEST_SHA256` and `setIsStrongBoxBacked(true)` (API 28) throws `StrongBoxUnavailableException`
  where there is no StrongBox; `KeyInfo.getSecurityLevel()` (API 31) reports StrongBox, TEE or
  software. `Signature("SHA256withECDSA")` returns DER. Keystore keys are never backed up and are
  deleted on uninstall.
- iOS: `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` (P-256 only) and
  `.ecdsaSignatureMessageX962SHA256` signing, which returns DER. Whether the Simulator offers a
  Secure Enclave is **UNVERIFIED**; the software fallback (02 Risks) covers it either way.
- iOS: a non-ephemeral `ASWebAuthenticationSession` shows the system alert "“yaran” Wants to Use
  “host” to Sign In" on every start, which no app can suppress; Android Auth Tab and Custom Tabs
  show no such prompt.
- Sources: https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder,
  https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave.

**Android WebView** (https://developer.android.com/reference/android/webkit/WebSettings,
`WebViewClient`, `WebChromeClient`, https://developer.android.com/develop/ui/views/layout/webapps/managing-webview)

- Settings defaults:
  - `allowFileAccess` defaults to false at target R and above.
  - `allowContentAccess` defaults to **true**, so it must be set off.
  - Safe Browsing is on by default.
  - Mixed content defaults to `NEVER_ALLOW`.
  - `setSupportMultipleWindows` defaults to false, so `window.open` and `_blank` load in the same
    WebView and pass through `shouldOverrideUrlLoading`.
- Client callbacks:
  - `shouldOverrideUrlLoading` is not called for `loadUrl` or for POST.
  - `onRenderProcessGone` must return true, and the WebView must then be destroyed.
  - `onReceivedSslError` must cancel and never prompt.
  - `onShowFileChooser` must call its callback exactly once.
  - `onPermissionRequest` denies the request if the method is not overridden.
- androidx.webkit is at 1.18.0. `WebViewCompat.saveState(view, bundle, maxBytes)` exists, and
  `saveState` keeps history, not live state.

**Android cookies and debugging**

- `CookieManager.setCookie(url, value, cb)` is asynchronous. `flush()` blocks.
- The value uses `Set-Cookie` syntax, and `Secure` requires an https URL.
- Whether `HttpOnly` is honored is **UNVERIFIED**. So is whether a cookie set before `loadUrl` is
  visible to that first request; the plan waits for the callback.
- Capacitor always registers `CapacitorCookies`. Its `load()` calls `removeSessionCookies()` on
  every bridge start (`CapacitorCookies.java`, Bridge.java 8.x source).
- Whether `setWebContentsDebuggingEnabled` defaults on for debuggable apps is **UNVERIFIED**, so it
  is set explicitly.

**Android insets and back** (https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/insets.md,
https://developer.android.com/about/versions/16/behavior-changes-16,
https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)

- At target 36, edge-to-edge cannot be opted out of.
- `SOFT_INPUT_ADJUST_RESIZE` has been deprecated since API 30.
- WebView exposes system-bar and cutout insets as `safe-area-inset-*` from M136 (fullscreen only)
  and from M144 (any size). IME insets resize the visual viewport from M139.
- Insets you pad yourself must be zeroed, never returned as `CONSUMED`.
- Predictive back is on by default at target 36. `onBackPressed` is not called, so use an
  `OnBackPressedCallback` enabled from UI state such as `canGoBack()`.

**iOS WKWebView** (https://developer.apple.com/documentation/webkit/, https://developer.apple.com/forums/thread/832538)

- Cookie store:
  - The `WKHTTPCookieStore.setCookie` completion means "stored", not persisted.
  - The first-request race is real (WebKit bug 198553 for ephemeral stores). Apple DTS recommends
    re-applying critical cookies before each load.
  - There is no public HttpOnly property key: `isHTTPOnly` is read-only, so an injected cookie may
    not be HttpOnly (**UNVERIFIED**).
- Data stores: `WKWebsiteDataStore(forIdentifier:)` (iOS 17) gives a per-identifier persistent
  store, and `nonPersistent()` keeps data in memory.
- Other defaults and hooks:
  - `isInspectable` defaults to false.
  - `applicationNameForUserAgent` appends to the user-agent string.
  - `targetFrame == nil` marks a new-window request.
  - `webViewWebContentProcessDidTerminate` reports a crashed content process.
  - `interactionState` exists from iOS 15.
- File input without a delegate before iOS 18.4 is **UNVERIFIED**; G6 checks it.
- WKAppBoundDomains allows at most 10 domains, so it is unusable here (R5 §5.9).

**Plugin hosting** (https://github.com/OutSystems/OSInAppBrowserLib-Android, `InAppBrowserPlugin.swift`)

- The official `@capacitor/inappbrowser` runs its WebView in a **separate Activity** with its own
  `OnBackPressedCallback`.
- On iOS it presents from `bridge.viewController`. That is the precedent followed here.
- Overlaying a view on the bridge WebView has no official example and is not used.

**Repo facts** (verified 2026-11-14)

- Hash routes:
  - `parseRoute` is at `crates/yaran-web/web/src/lib/store.ts:2312`.
  - The agent form is `#/agent/<sid>` with an optional `/tab/<tabId>` or `/terminal/<tid>`
    (:2122).
  - Segments are `[^/]+`, URI-encoded (:2128-2134, builder :2173-2198).
- The UI never triggers a download. The only `Content-Disposition: attachment` is on inline image
  previews (`crates/yaran-web/src/file_routes.rs:662`).
- There are no iframes.
- `window.open` is called at `ChangedFiles.tsx:771` (same-host standalone editor),
  `MarkdownPreview.tsx:68` and `terminal/linkPress.ts:88` (external links).
- The long-press callout is already suppressed in the page (`TerminalPane.tsx:1020`).
- `body` is `user-select: none` (`index.css:94`).

## In scope

- `mobile/plugins/machine-view/`: two Capacitor plugin classes, `MachineView` and `Session`, plus
  their native implementations on both platforms, including the callback intent filters and
  aliases (Android) that 14's placeholders switch on.
- The machine window:
  - hardening, exact-host allowlist, external links, `yaranapp://` control URLs;
  - cookie injection and clearing, UA token, file chooser, downloads policy, clipboard and
    permissions policy;
  - insets, IME and keyboard, back gesture, multi-window/iPad, screen privacy;
  - renderer-crash recovery, process-death restore, and the deep link to an agent or tab;
  - `Yaran-Refusal` handling on main-frame responses and the 4401 path (02 §13).
- The sealed-handoff client: ephemeral P-256 key, state, the release https / dev custom-scheme
  callback, system-browser launch, consent tap, callback validation, and envelope opening per
  Phase 02 §8.
- The per-org hardware-backed device key and the `dk`/`dts`/`dsig` request signature that lets a
  renewal skip a consent page already answered (02 §8.1, D24).
- Per-host JWT storage in the Phase 14 vault, the renewal scheduler, the native org API client
  (`Session.request`, `Session.meta`) for every Worker call (D22), the per-org `install_id`, and
  the full failure UX.
- Fallbacks for G1 (the `cookie` field, then the header/bearer path), G6, and G13's fragment
  switch.

## Out of scope

| Item | Owning phase |
|---|---|
| Envelope format, test vectors, handoff/redirect validation rules | 02 |
| Machine handoff route; control-plane handoff route | 11; 06 |
| The web UI's session-expiry probe, UA recognition, native menu entries | 13 |
| Shell screens that call these plugins, vault/app lock, flavors | 14 |
| Push tap routing into `MachineView.open` (16 calls the API defined here) | 16 |
| Publisher domain + AASA/assetlinks hosting for the release-build https callback | 21 (fingerprint check: 18) |
| Push orchestration and settings rows that call `Session.request` for device registration and mutes | 16 |
| Real-Cloudflare E2E of every flow | 19 |

## Design

### Plugin API (TypeScript, `mobile/plugins/machine-view/src/definitions.ts`)

```ts
MachineView.open({ orgId, machineId, host, route? }): Promise<void>  // route: "#/agent/<sid>[/tab/<id>]"
MachineView.close(): Promise<void>
MachineView.addListener("closed", { reason: "user" | "home" | "settings" | "signedOut" | "error", code? })
Session.meta({ orgUrl }): Promise<Meta>                               // public GET /v1/meta (W1)
Session.signIn({ orgId, target: "control-plane" | { machineHost } }): Promise<SignInOutcome>
Session.status({ host }): Promise<{ signedIn: boolean; expiresAt?: number }>
Session.request({ orgId, method, path, body? }): Promise<ApiResult>   // /v1/* on the org origin only
Session.installId({ orgId }): Promise<{ installId: string }>          // 02 InstallId; minted on first call, with the device key
Session.callbackMode(): Promise<{ mode: "https"; domain: string } | { mode: "dev" }>
Session.signOut({ orgId, hosts }): Promise<void>                      // vault + cookies + data stores + install_id + device key
```

**No method returns a JWT, cookie or key** (D22): the device private key never leaves native
code, and no method signs on JS's behalf. `install_id` is an identifier, not a credential,
so JS may read it to build Phase 16's `DeviceRegistration`. `SignInOutcome` and `ApiResult` are
exhaustive unions. `ApiResult` has these variants:

- `ok`
- `api_error` (the Phase 02 envelope)
- `session_expired`
- `device_revoked` (02 `403 device_revoked`: the native client has already deleted that org's
  sessions and `install_id`; 14 shows "this phone was removed")
- `offline`
- `tls_error`
- `refused` (a host, method or path rule failed)
- `protocol_unsupported` (02 §3; renamed from `protocol_mismatch` to match the registry)

### Sealed handoff (both targets, D8)

```text
1. kp = P-256 ephemeral keypair, held in memory only (02 §8 opener obligation 8);
   state = 32 random bytes (b64url, 43 chars)
   persist a key-free marker {state, host, target, createdAt} in vault ns "handoff" (TTL 10 min)
   so a callback after process death is recognised and explained, never completed
   dk = this org's device public key (DeviceKeyStore, below); dts = now in Unix seconds;
   dsig = DeviceKeyStore.sign(orgId, "yaran-handoff-device-v1\n<host>\n<pk>\n<state>\n<dts>\n")
   (02 §8.1: <host> = the host being opened, lowercase, no port; <pk> the 87-char query value)
2. redirect = callbackMode == https ? https://<publisher-domain>/auth/callback
                                    : yaranapp://auth/callback (and build=dev)
   URL = target == control-plane ? <orgUrl>/v1/handoff (W16) : https://<machineHost>/__yaran/handoff (Y1)
        ?v=1&pk=<P256Point>&state=<state>&redirect=<pct-encoded redirect>&device=<pct-encoded label>
        &dk=<P256Point>&dts=<unix s>&dsig=<EcdsaP256Sig>[&build=dev][&mode=fragment]
3. launch: iOS ASWebAuthenticationSession(callback .https(host: <publisher-domain>, path: "/auth/callback"),
           or .customScheme("yaranapp") in dev builds; non-ephemeral so IdP/passkey sessions are reused)
           Android AuthTabIntent when isAuthTabSupported (launch(launcher, uri, host, path) for https,
           launch(launcher, uri, "yaranapp") in dev builds), else CustomTabsIntent; any browser
           missing → refusal "No browser that supports secure sign-in is installed"
4. the person signs in if needed and taps Continue on the consent page (W16b / Y1b POST); when the
   browser holds this host's consent cookie for this dk and dsig verifies, the server skips the
   page and redirects at once (02 §8.1 skip rule); the client treats both paths alike
5. callback <redirect>?state=…&jwe=… (or #… with mode=fragment), or ?state=…&error=<code>[&min&max]:
   the callback must be the form this build sends (https in release, yaranapp in dev; the other
   form is refused); state must match the in-memory pending entry (single use, deleted on read),
   age ≤ TTL
6. open the JWE with the in-memory private key (02 §8; vectors in cloud/protocol/fixtures/jwe/)
7. HandoffPayload {v, kind, host, jwt, email, exp, iat, cookie?}: the JWT payload is decoded (not
   verified: it came sealed from the authenticated host) only to cross-check exp; store vault ns
   "session/<host>" = {orgId, jwt, cookie?, exp, email}, class "locked" when app lock is on
8. destroy the ephemeral key and the marker; return outcome
```

The device label sent as `device` (02 `HandoffQuery.device`, shown on the consent page) is the
same label Phase 16 registers: the OS device name, else the model, cut to 64 code points with
control and bidi characters removed (pure `DeviceLabel`, Kotlin and Swift twins, one fixture).

**Callback by build** (`CallbackMode`, decided at compile time from Phase 14's publisher build
config):

| Build | Redirect sent | Android delivery | iOS delivery |
|---|---|---|---|
| Release (publisher domain set) | `https://<publisher-domain>/auth/callback` | Auth Tab result after Digital Asset Links verification; the Custom Tab and plain `ACTION_VIEW` fallbacks reach the `AuthCallbackHttps` activity alias, whose `autoVerify` filter is enabled only in these builds | `ASWebAuthenticationSession` `.https` callback, delivered only to the calling session |
| Development (no publisher domain) | `yaranapp://auth/callback` with `build=dev` | Auth Tab result; fallbacks reach the `AuthCallbackDev` alias (custom-scheme filter, enabled only in these builds) | `.customScheme("yaranapp")` |

Both aliases target `AuthCallbackActivity`, which is `exported`, `noHistory`, finishes at once,
and forwards the URI to the in-process `HandoffClient`. Their `android:enabled` comes from
Phase 14's `publisherCallbackEnabled` / `devCallbackEnabled` placeholders, so a release build
declares no custom-scheme callback and a dev build claims no domain. The shell's `add-org`
filter (Phase 14) is a separate host, so the two never collide. A callback that arrives after
the process died finds the key-free marker but no key, and ends in the "interrupted" outcome
(the key never touched storage, per 02).

`mode=fragment` is sent only if G13 records that a browser strips or logs the query on the
App Link hop; `CallbackUrl` parses both forms either way.

**Device key** (`DeviceKeyStore`, 02 §8.1, D24). One P-256 signing key per org registration,
never per install, so two orgs cannot link the phone by its key; it is minted and deleted
together with that org's `InstallId`:

- **Android**: AndroidKeyStore alias `yaran.device.<orgId>`, `PURPOSE_SIGN`, `secp256r1`,
  `DIGEST_SHA256`, no user authentication (the consent page is the human check, not the key).
  Generation asks for StrongBox and on `StrongBoxUnavailableException` retries in the TEE.
- **iOS**: `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave`, permanent, application
  tag `yaran.device.<orgId>`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no access
  control flags beyond `.privateKeyUsage`.
- **No hardware** (Simulator, a device without StrongBox, TEE or Secure Enclave): a
  non-exportable software key in AndroidKeyStore or the Keychain, per 02 Risks. The security
  level (StrongBox, TEE, Secure Enclave, software) goes to diagnostics once at minting, with the
  key's `DeviceKeyFingerprint` (02 §8.1) and never the key.
- **Signing**: both platforms produce DER, converted to the 64-byte raw `r ‖ s` (each integer
  left-padded to 32 bytes) and base64url-encoded as `EcdsaP256Sig`, by the pure `HandoffSignature`
  twin, which also builds the canonical string.
- **One unit with the `InstallId`.** If either half is missing when the other is present (a
  Keystore wipe, an iOS reinstall that left Keychain items behind, an invalidated key), both are
  deleted and reminted, so the Worker never sees a new key under an old `install_id` (02 answers
  that with `409 conflict`). The new key has no remembered consent anywhere, so every host shows
  the consent page once more, and the old Worker device row stays until the user removes it.
  `Session.signOut`, the `device_revoked` wipe and org removal (14) delete the key with the
  `install_id`.
- **Registration.** 16's `DeviceRegistrar` reads the public key from this store and sends it as
  `DeviceRegistration.device_key` (W12); `OrgApiClient` refuses a registration body whose
  `device_key` differs from the stored one, as it does for `install_id`.

### Cookie injection and data isolation

The cookie is **injected as a session cookie** with no `Expires`:

```text
CF_Authorization=<value>; Path=/; Secure; HttpOnly; SameSite=Lax
```

`<value>` is the payload's `jwt`, or its `cookie` field when G1 adopts fallback rung 1 (Access
wants the cookie value it issued) and the field is present (02 §8).

It is host-only, with no `Domain`. Access only reads the value, so the attributes do not decide
whether it is accepted. Making it a session cookie keeps the JWT out of the WebView's on-disk
cookie database, so the vault stays the only place a JWT is stored at rest. The cookie is
re-injected **before every load and on every resume**. That covers the iOS first-request race,
Apple DTS guidance, and Capacitor wiping Android session cookies when the bridge starts.

- **Android**
  - Inject: `setCookie(url, value, cb)`, await `cb == true`, then `loadUrl`.
  - Clear: write an expired `CF_Authorization` for the host, plus `CF_AppSession`, then `flush()`.
    `flush()` runs on a background thread.
  - Storage is isolated by origin automatically, since each machine has its own host (D1).
- **iOS** (deployment target 17.4)
  - Each machine gets a persistent `WKWebsiteDataStore(forIdentifier:)` whose UUID is stored in
    the org record. This isolates machines and keeps the web UI's per-device `localStorage`
    choices, such as the typing surface and theater.
  - Inject: await `setCookie`, then confirm with `getAllCookies` that the cookie is present before
    `load`.
  - Clear: `remove(forIdentifier:)`.
  - HttpOnly cannot be set through public API (**UNVERIFIED**). The page that could read the
    cookie is the user's own yaran UI, which already has full API reach, so this adds no new
    capability. Recorded as threat-model row **T61**.

### Navigation policy (pure; Kotlin and Swift twins, one fixture table)

| Request | Decision |
|---|---|
| main or sub frame, `https://<host>` exact (case-folded host, default port), any path | allow |
| `about:blank`, `about:srcdoc`, `blob:`/`data:` subresources of the allowed host | allow (no navigation) |
| `https://<team>.cloudflareaccess.com/…` or any Access login redirect | **cancel** → reauth overlay (never render an IdP in the WebView, R5 §2) |
| `yaranapp://reauth?host=<h>` with `h == host` | reauth overlay; else ignore + diagnostics entry |
| `yaranapp://home` / `yaranapp://settings` | close with reason `home` / `settings` (shell routes) |
| other `yaranapp://` (`uri_invalid`) | ignore + diagnostics entry |
| `http(s)://` other host, `mailto:`, `tel:` | open in system browser (Custom Tab / `UIApplication.open`), only on a user gesture (Android `hasGesture()`, iOS `navigationType == .linkActivated` or a `window.open` from a click) |
| `intent:`, `file:`, `content:`, `javascript:` (as navigation), anything else | block + diagnostics entry |
| new-window request (`targetFrame == nil` / `_blank`) | same host → load in this view (history push; back returns; no stacked view, 13 §11 rule 2 agrees); off-host → system browser |
| response with `Content-Disposition: attachment` or a non-renderable MIME | cancel; snackbar "Downloads aren't supported in the app. Open it in the yaran web UI on your computer." (the UI never downloads, so no download machinery is built) |
| main-frame HTTP 530 or a Cloudflare 1033/1016-class error | offline overlay "<machine> is offline or its tunnel isn't connected" + Retry |
| main-frame response carrying `Yaran-Refusal` (02 §13), or a 401/403 without it | decided by the refusal table below |
| TLS error | cancel, overlay; never proceed (Android `onReceivedSslError` → cancel) |

The three `yaranapp://` control URLs stay on the custom scheme in every build. They never leave
this WebView: the policy runs before navigation (`shouldOverrideUrlLoading`,
`decidePolicyFor navigationAction`) and cancels them, so no other app can receive them (02 §10).

**Refusals on the main frame** (`RefusalPolicy`, Kotlin and Swift twins). Android reads the
headers in `onReceivedHttpError` for `request.isForMainFrame`; iOS reads
`HTTPURLResponse.value(forHTTPHeaderField: "Yaran-Refusal")` in
`decidePolicyFor navigationResponse` when `isForMainFrame`. Subresource and fetch refusals are
the page's own business (Phase 13's probe).

| Response | Decision |
|---|---|
| 401 or 403 **without** `Yaran-Refusal` | Access answered: reauth overlay |
| `access-not-owner` (403) | overlay naming the signed-in email from the session and saying the machine belongs to another owner; Back to machines |
| `access-keys-unavailable` (503) | overlay "yaran on `machine` can't reach Cloudflare's key service, so signing in again won't help. Try again in a minute." Retry |
| any other `access-*` | reauth overlay (renew through the handoff) |
| `host-*` | overlay "`machine` is no longer connected to the cloud. Check `yaran cloud status` on the machine." Retry, Back to machines |
| unknown code | by status: 401 → reauth overlay; 503 → the keys-unavailable face without naming the cause; else an overlay naming the code; plus a diagnostics entry |

**Close code 4401.** machine-view has no bridge, so it never sees a WebSocket close code. The
page handles it (Phase 13 §4): it reconnects, notes the expiry, probes, and in the app navigates
to `yaranapp://reauth?host=<host>`, which the table above turns into the reauth overlay. The
renewal policy below renews before `exp`, so with a fresh cookie the reconnect after a 4401
simply succeeds.

### WebView configuration

| Concern | Android | iOS |
|---|---|---|
| Bridge | none: no `addJavascriptInterface`, no `addWebMessageListener`, no document-start scripts | none: no `WKScriptMessageHandler`, no `WKUserScript` |
| Settings | JS on, DOM storage on, `allowFileAccess=false`, `allowContentAccess=false`, Safe Browsing on, mixed content NEVER, `setSupportMultipleWindows(false)`, `setGeolocationEnabled(false)`, `javaScriptCanOpenWindowsAutomatically=false`, debugging only when `FLAG_DEBUGGABLE` or `BuildConfig.E2E_WEBVIEW_DEBUG` (14's `e2e` build type, Phase 19 hook H4), never in a release variant | `isInspectable` only under `#if DEBUG || E2E` (14's E2E configuration, hook H4), `javaScriptCanOpenWindowsAutomatically=false`, `allowsLinkPreview=false`, `allowsBackForwardNavigationGestures=true` |
| UA | `settings.userAgentString = default + " " + token` | `applicationNameForUserAgent = token` |
| Token | `YaranApp/<versionName> (android; phone\|tablet)` (tablet when `smallestScreenWidthDp ≥ 600`), format owned by 02 §11, pinned by `fixtures/ua/` | `YaranApp/<CFBundleShortVersionString> (ios; phone\|tablet)` from `userInterfaceIdiom` |
| Permissions | `onPermissionRequest` → `deny()` for everything (yaran UI needs no camera, mic or MIDI) | `requestMediaCapturePermissionFor` → `.deny` |
| Clipboard | page writes work on a user gesture; no programmatic read is granted (the compose bar's paste event path is the supported one, R2 §7) | system Paste callout only |
| File input | `onShowFileChooser` → `FileChooserParams.createIntent()` through a launcher registered in `onCreate`; callback exactly once; result URIs restricted to `content://` | native picker; G6 confirms; if absent before 18.4, `runOpenPanelWith` cannot help, so the fallback is a `UIDocumentPickerViewController` driven through the same input's `accept` (G6 records) |
| Insets / IME | WebView ≥ M144: no padding, insets zeroed rather than consumed, so `env(safe-area-inset-*)` and the M139+ IME visual-viewport resize reach yaran's `viewport-fit=cover, interactive-widget=resizes-content` meta and its `keyboardLikelyOpen` heuristic (`lib/viewport.ts:7-14`). M139–M143: system-bar padding on the container, IME native. < M139: padding for system bars and `ime()` (adjust-resize behaviour). The mode is a pure function of the WebView major version (`WebViewCompat.getCurrentWebViewPackage`) | `contentInsetAdjustmentBehavior = .never`, so `env()` and the WebKit visual-viewport keyboard behaviour match iOS Safari, which the web heuristic was tuned for |
| Back | `OnBackPressedCallback` enabled while `canGoBack()` → `goBack()`; otherwise disabled so the system finishes the activity (predictive back animates) and emits `closed{user}` | swipe-back gestures in WebView history; a native close affordance in the overlays; `yaranapp://home` from the web menu (13) |
| Windowing | `MachineViewActivity`: `launchMode=singleTask` (one machine at a time; opening another replaces it), `configChanges` for size, orientation, uiMode and density so the page is never recreated by rotation or resize, resizeable (multi-window, desktop windowing) | full-screen presented `MachineViewController`; single scene (14); every iPad orientation, Split View and Stage Manager resize; trait changes need no reload |
| Screen privacy | `FLAG_SECURE` on this window when the setting is on (core `ScreenPrivacy`) | cover on resign-active, `sceneCaptureState` |
| App lock | on resume, if locked, a native cover hides the WebView until `AppLock` unlocks | same |
| Renderer crash | `onRenderProcessGone` → return true, remove and destroy the WebView, recreate it, re-inject, reload the last same-host URL, toast "The page crashed and was reloaded" | `webViewWebContentProcessDidTerminate` → re-inject, reload |
| Process death | `onSaveInstanceState` keeps `{orgId, machineId, host, lastUrl}` (same host only, under 1 KB); restore re-injects from the vault and loads `lastUrl`; yaran's URL is its position (CLAUDE.md "The URL is the source of truth") | cold start: the shell's "Reopen last machine on launch" (14, default on) reopens `{machine, lastUrl}`; Android uses the same record when a cold start finds no saved state |

### Renewal and failure UX

- **Renewal policy.** This is a pure function of `now`, `exp`, the margin, and whether the
  machine view is visible:
  - **Opening a machine, or resuming,** with `exp - now < 2 h` (or 25 % of the token's lifetime,
    whichever is shorter) runs the handoff *before* loading. A system-browser sheet is a visible
    user action, so it only happens around a user's gesture.
  - **While viewing,** at `exp - 10 min` a native top banner says "Your session for <machine> ends
    in 10 minutes" and offers **Renew**.
  - **At `exp`, or on `yaranapp://reauth`, or on an Access redirect,** a full-pane overlay reads
    "Sign-in needed for <machine>" with **Sign in** and **Back to machines**. This happens at
    `exp` even if the WebSocket is still open, which matters until G12 measures what Access does
    to an open socket after expiry.
  - **A successful renewal** re-injects the cookie and reloads the same URL.
  - **The control plane** follows the same rules, from the shell, through `session_expired`.
  - **A renewal skips the consent page once this phone has tapped Continue for that host**
    (D24): the request is signed with the same device key and the browser still holds the
    host's consent cookie. The first handoff per host, a reminted key (reinstall or key loss),
    a rotated consent key on the server (a new pairing, or `DATA_KEY` rotation for the control
    plane), a revoked device, and once every 400 days still show the page. The system browser
    itself still opens: on Android Auth Tab shows no prompt of its own, so a remembered renewal
    is an SSO pass and a redirect; on iOS `ASWebAuthenticationSession` still shows its system
    "wants to use … to sign in" confirmation on every start, which no app can suppress. Because
    a system sheet still appears, renewal never runs without a user gesture.

  The margins are constants in one module, chosen so a 24 h Access session renews at most about
  once a day.

- **Failure matrix.** Each row has one sentence and one action, on both platforms, built from one
  table (`HandoffOutcome` → strings in the Lingui/strings catalogs).

  | Failure | Message | Action |
  |---|---|---|
  | user cancelled the browser | "Sign-in was cancelled." | Try again |
  | Cancel on the consent page (`error=handoff_declined`) | "You chose Cancel on the sign-in page, so this phone wasn't signed in." | Try again |
  | app closed during the browser leg (marker found, no key) | "The app was closed while you were signing in, so that sign-in can't finish. Start it again." | Try again |
  | App Link verification failed or timed out (Auth Tab `RESULT_VERIFICATION_*`) | "This copy of the app couldn't prove it owns the sign-in link for `publisher-domain`. Install the app from an official channel, or try again later." | Try again |
  | `error=rate_limited` | "Too many sign-ins in a short time. Wait a minute and try again." | Try again |
  | `error=protocol_unsupported` (with `min`/`max`) | names which side to update, as 14's protocol screen does | Back |
  | `error=handoff_timestamp_skewed` (with `server_time`) | "This phone's clock is more than five minutes off from `host`, so the sign-in was refused. Set the clock automatically and try again." | Try again |
  | `error=handoff_device_key_invalid` or `error=handoff_signature_malformed` | the generic refusal sentence below, plus a diagnostics line with the key's security level | Back |
  | `error=handoff_request_invalid` or another code | "The sign-in page refused this request (`code`). Update the app." | Back |
  | no browser that supports Custom Tabs or Auth Tab | "Install or enable a browser (Chrome, Firefox, Brave, Vanadium…) to sign in." | Open settings |
  | state mismatch, expired pending, replayed callback, wrong callback form for this build, `jwe_state_mismatch` | "That sign-in reply didn't match a sign-in from this phone, so it was ignored." | Try again |
  | envelope fails to open or decode (`jwe_*` except the two below; the code goes to diagnostics) | "The sign-in reply couldn't be decrypted. Update the app and yaran on the machine." | Try again |
  | `jwe_expired` | "The sign-in reply had already expired. Check that this phone's clock is right, then try again." | Try again |
  | Access denied the identity (handoff never returns, or `Yaran-Refusal: access-not-owner`) | "<email> isn't the owner of <machine>." | Back to machines |
  | `device_revoked` from the org API | 14's phone-removed sentence | Add org |
  | network down, DNS failure | "No connection. Check your network and try again." | Retry |
  | TLS failure | "The connection to <host> isn't secure, so the app stopped." | Back |
  | machine offline (530/1033) | as in the navigation table | Retry |
  | `protocol_unsupported` from meta | handled by 14's screen | — |
  | vault locked or invalidated | 14's lock and wipe sentences | Unlock / Sign in |

### Fallbacks (complete designs; selected by Phase 03 outcomes)

- **G1, step 1** (Access needs the `CF_Authorization` value it issued, not the assertion): the
  servers already fill `HandoffPayload.cookie` with the raw cookie value the request carried
  (02 §8, Phase 11/06). The client injects `cookie` instead of `jwt` (Cookie injection above);
  a payload without `cookie` under this rung falls back to `jwt` and writes a diagnostics line.
  `SessionStore` keeps both fields, so adopting the rung is a constant change plus tests.
- **G1, step 2** (an injected cookie is not accepted, so a header or bearer path is used):
  - **Token.** Get an Access **Managed OAuth** token with PKCE through the same system-browser
    launcher. The callback follows the same build split as the handoff (02 §10):
    `https://<publisher-domain>/oauth/callback` in release builds, `yaranapp://oauth/callback`
    in dev builds, each the exact entry in the Access app's `allowed_uris` (03 G1, 05/07). Store
    `{access, refresh, exp}` per host in the vault, and refresh about 1 minute before the
    15-minute expiry.
  - **Android, primary within this step.** `androidx.webkit` `Profile` custom headers add the
    header on every request to the exact host, if G1 proves they cover the WebSocket upgrade:
    `Authorization: Bearer`, or `cf-access-token` if G1 shows Access wants that. This is
    **UNVERIFIED** and is the G1 measurement.
  - **Both platforms otherwise: a loopback proxy.** It listens on `127.0.0.1:<random>` only, via
    `ServerSocket` on Android and `NWListener` on iOS. The WebView loads
    `http://127.0.0.1:<port>/`. For each request the proxy:
    - requires a per-launch 32-byte secret cookie that only the app's own cookie store holds, which
      blocks other local apps;
    - rewrites `Host` and `Origin` to the machine host, so yaran's Origin==Host and D3 checks see
      the real hostname;
    - adds the bearer header and opens TLS to the host;
    - forces `Connection: close` per HTTP request, and for a `101` upgrade splices both directions
      until close.

    Budgets: `LoopbackProxy.kt` (450) plus `HttpHead.kt` (200); `LoopbackProxy.swift` (450) plus
    `HttpHead.swift` (200).

    The navigation policy then treats `http://127.0.0.1:<port>` as the pinned origin. Cleartext is
    allowed for that exact origin only, via a network security config `domain-config` for
    `127.0.0.1` and ATS `NSAllowsLocalNetworking`.

    Tests: head parsing and rewriting, the secret check, WebSocket splice against a local echo
    server, and rejection of a foreign Host. Threat-model row **T62** (conditional on this rung).
- **G6** (some piece of the separate WebView fails inside a Capacitor app): the native code here
  depends only on `plugins/core` and platform APIs, so it moves unchanged under Phase 14's native
  host (work item 15 there). Specific sub-failures have their own fallbacks:
  - file input: the iOS document-picker path above;
  - insets: forced padding mode;
  - cookie timing: an extra `getAllCookies` or `getCookie` poll, up to 500 ms, before load.
- **G13** (callback delivery per browser): the verified https callback is the release path, not
  a fallback (D8, Callback by build above). Phase 02's allowlist accepts exactly that URL for
  `build=release` and the custom scheme only for `build=dev`; 06 and 11 enforce it; Phase 21 hosts
  AASA and `assetlinks.json` on `<publisher-domain>` (T63), Phase 18 checks the fingerprint. G13's
  per-browser table becomes this phase's support matrix. If G13 shows a browser strips or logs the
  query on the App Link hop, the client sends `mode=fragment` (02 `HandoffQuery.mode`).

## Work items

Every created code file carries the 00-CONVENTIONS §2 header with generated trees: TS `/** */`,
Kotlin KDoc before `package`, Swift `///`. Budgets are planned maxima, all at or below 500 lines.
Android sources live in `mobile/plugins/machine-view/android/src/main/java/.../machineview/`, and
iOS sources in `mobile/plugins/machine-view/ios/Sources/MachineView/`.

1. **Package scaffold and TS contract (lands first).**

   Create:
   - `package.json` (`file:` dependency on `cloud/protocol`)
   - `src/definitions.ts` (200)
   - `src/index.ts` (40)
   - `src/web.ts` (60), which rejects with `unavailable` and is used by mocks only
   - `src/outcomes.ts` (120), the exhaustive unions with `assertNever` helpers
   - `android/build.gradle` (depends on `:yaran-core`, androidx.browser 1.10.x, androidx.webkit
     1.18.x)
   - `android/src/main/AndroidManifest.xml`: `AuthCallbackActivity` plus the `AuthCallbackHttps`
     alias (`autoVerify` filter for `https://${publisherDomain}/auth/callback` and
     `/oauth/callback`, `android:enabled="${publisherCallbackEnabled}"`) and the `AuthCallbackDev`
     alias (`yaranapp://auth/callback` and `yaranapp://oauth/callback`,
     `android:enabled="${devCallbackEnabled}"`), placeholders from Phase 14
   - `ios/Package.swift` (depends on `plugins/core` by path; platform `.iOS("17.4")`)

   Tests: type-level tests of the unions, and a contract test that 14's mocks satisfy the
   definitions. A Robolectric merged-manifest test: a release-config build enables only the https
   alias, a dev-config build only the custom-scheme alias.

2. **Pure policy twins.**

   Create:

   | Purpose | Kotlin (budget) | Swift (budget) |
   |---|---|---|
   | Navigation decisions (the table above) | `NavigationPolicy.kt` (250) | `NavigationPolicy.swift` (250) |
   | `yaranapp://` parsing and validation | `ControlUrl.kt` (120) | `ControlUrl.swift` (120) |
   | Agent route validation against the `store.ts:2122` grammar, accepting only `#/agent/<seg>` with an optional `/tab/<seg>`, segments `encodeURIComponent`-safe | `RouteFragment.kt` (100) | `RouteFragment.swift` (100) |
   | Renewal policy | `RenewalPolicy.kt` (120) | `RenewalPolicy.swift` (120) |
   | Insets mode (Android only) | `InsetsMode.kt` (80) | — |
   | Cookie string and attributes | `CookieSpec.kt` (80) | `CookieSpec.swift` (80) |
   | Callback URL parsing (query and fragment forms, `jwe` / `error` / `min` / `max`), build-form check and state check | `CallbackUrl.kt` (120) | `CallbackUrl.swift` (120) |
| Handoff URL building (02 §8 parameters, redirect per `CallbackMode`) | `HandoffUrl.kt` (100) | `HandoffUrl.swift` (100) |
| Main-frame refusal decisions (table above) | `RefusalPolicy.kt` (100) | `RefusalPolicy.swift` (100) |
| Device label for `device` | `DeviceLabel.kt` (60) | `DeviceLabel.swift` (60) |
| 02 §8.1 canonical string, DER → raw `r ‖ s`, `DeviceKeyFingerprint` (D24) | `HandoffSignature.kt` (120) | `HandoffSignature.swift` (120) |

   Shared fixtures in `mobile/plugins/machine-view/fixtures/`, which both suites read:
   - `navigation-cases.json`, at least 60 cases including homograph, port, case, userinfo and
     scheme tricks
   - no local control-URL table: both suites read 02's `cloud/protocol/fixtures/uri/control-urls.json`
     (`{uri, loaded_host, expect}`) so the web builders (13) and these decisions share one
     set of cases
   - `routes.json`
   - `renewal-cases.json`
   - `callback-cases.json` (https and dev forms, query and fragment, every callback `error`
     code, wrong form for the build)
   - `refusal-cases.json`
   - `device-labels.json`

   Tests: JUnit on the plain JVM, and XCTest. They also read 02's fixtures directly:
   - the redirect each `CallbackMode` builds is accepted by `cloud/protocol/fixtures/uri/handoff-redirect.json`
     for its `build`, and the other build's redirect is refused;
   - every code in `cloud/protocol/registry/refusals.json` gets a decision from `RefusalPolicy`
     (a new code without a decision fails the test);
   - the UA token matches `cloud/protocol/fixtures/ua/`;
   - every case in `cloud/protocol/fixtures/uri/control-urls.json` gets its expected decision;
   - D24: `HandoffSignature` builds canonical bytes equal to `fixtures/sig/handoff-device-signature.json`
     (text and hex), converts its DER cases to the committed raw form, and verifies the committed
     `dsig` with the fixture key (JCA / `SecKeyVerifySignature`); every fingerprint in
     `fixtures/sig/device-fingerprint.json` matches, display and `fp24` forms;
   - D24: `HandoffUrl` always emits `dk`, `dts` and `dsig`, `dts` as plain decimal.

3. **Sealed-envelope opener.**

   Create `SealedEnvelope.kt` (250, JCA: `KeyPairGenerator("EC")` with secp256r1,
   `KeyAgreement("ECDH")`, Concat KDF over SHA-256, `AES/GCM/NoPadding`) and `SealedEnvelope.swift`
   (250, CryptoKit `P256.KeyAgreement`, a manual Concat KDF of about 20 lines, `AES.GCM`). They
   implement exactly the Phase 02 §8 JWE profile (`yaran-handoff+jwe`: ECDH-ES with Concat KDF,
   A256GCM) and every opener obligation, including the explicit on-curve check and the in-memory
   key. If 02's final choice differs, only these two files change.

   Reuse: the vectors in `cloud/protocol/fixtures/jwe/` (`handoff-v1-valid-*.json`,
   `handoff-v1-invalid-*.json`, `kdf-rfc7518-appendix-c.json`), read by both suites (Gradle test
   resources `srcDir`, and an XCTest `#filePath`-relative path).

   Tests:
   - Every valid 02 vector opens to its `HandoffPayload`, and the KDF reproduces the RFC 7518
     Appendix C key.
   - Every invalid vector fails closed with the `jwe_*` code it names (tampered ciphertext or
     header, wrong `kid`, off-curve `epk`, 31-byte `x`, compressed point, wrong `alg`/`enc`,
     `apv` ≠ state, `apu` ≠ host, host and kind mismatch, expired, non-empty part 2, six parts).
   - Constant-shape errors carry no secret material in their messages.

4. **Android handoff client.**

   Create:
   - `HandoffClient.kt` (300), the steps 1–8 orchestrator: in-memory key and pending state, the
     key-free vault marker
   - `BrowserLauncher.kt` (220): decides between Auth Tab and Custom Tab, and handles a missing
     browser through `PackageManager` queries matching the `<queries>` that 14 declares. Both the
     plugin (on `BridgeActivity` at load) and `MachineViewActivity` (in `onCreate`) register their
     launcher before they start.
   - `AuthCallbackActivity.kt` (80)
   - a manifest fragment for the callback filter

   Tests:
   - Robolectric: Auth Tab is chosen when supported, the Custom Tab fallback otherwise, and the
     no-browser refusal when neither exists. A callback through the activity resumes a pending
     callback after a simulated process death ends in the "interrupted" outcome, and the vault
     holds no key material at any point (only the marker). A duplicate callback is refused. A
     callback in the other build's form is refused. A `RESULT_CANCELED` from Auth Tab with no
     redirect within 3 s of resume maps to `cancelled`; `RESULT_VERIFICATION_FAILED` and
     `RESULT_VERIFICATION_TIMED_OUT` map to the verification outcome; `error=handoff_declined`
     maps to `declined`; `error=handoff_timestamp_skewed` maps to the clock outcome. A redirect
     straight back with `jwe` and no consent step (remembered consent) completes like any other.

5. **iOS handoff client.**

   Create:
   - `HandoffClient.swift` (300)
   - `AuthSessionLauncher.swift` (180): builds the `Callback` from `CallbackMode` (`.https(host:path:)`
     in release builds, `.customScheme("yaranapp")` in dev builds), provides a
     `presentationContextProvider` anchored on the presenting window, non-ephemeral.

   Tests: XCTest with an injected launcher protocol, covering success on both callback forms,
   `canceledLogin`, `handoff_declined`, `handoff_timestamp_skewed`, state mismatch, wrong form for
   the build, TTL expiry and replay; the launcher is never ephemeral (02 UNVERIFIED-5 depends on
   it).

6. **Session store, org API client, and the `Session` plugin.**

   Create:

   | Purpose | Kotlin (budget) | Swift (budget) |
   |---|---|---|
   | Vault namespace `session/<host>` (`{orgId, jwt, cookie?, exp, email}`), exp decode, sign-out across hosts, wipe by org, cookie and data-store clearing | `SessionStore.kt` (200) | `SessionStore.swift` (200) |
   | Vault namespace `install/<orgId>`: `InstallId` minting (lowercase UUID v4), the registered flag, deletion | `InstallIdStore.kt` (80) | `InstallIdStore.swift` (80) |
| Device key (D24): mint with the `InstallId`, StrongBox → TEE → software, sign, public key, delete, the remint-both rule | `DeviceKeyStore.kt` (180, behind 14's `KeyProvider`-style seam so Robolectric gets a software key) | `DeviceKeyStore.swift` (180) |
   | Org API client (see below) | `OrgApiClient.kt` (250, `HttpURLConnection` on a background executor) | `OrgApiClient.swift` (250, `URLSession` with `httpShouldHandleCookies=false`) |
   | Plugin adapter | `SessionPlugin.kt` (220) | `SessionPlugin.swift` (220) |

   `OrgApiClient` is the only code in the app that talks to an org Worker (D22). The shell's
   screens and Phase 16's push orchestration (device registration W12, listing W13, removal W14,
   test push W15, mutes W31) all call it through `Session.request`. It enforces these rules:
   - Requests go to the org origin recorded at onboarding only, with path prefix `/v1/`.
   - Methods are limited to GET, POST, PATCH and DELETE (PATCH for W31 `DevicePatch`).
   - It sends the control-plane token as both `Cookie: CF_Authorization=<value>` and
     `cf-access-token: <jwt>` (02 §2), the UA token as the whole `User-Agent` (02 §11) and
     `Yaran-Protocol`.
   - It sends `Yaran-Install-Id: <InstallId>` on `POST /v1/me/devices` and on every call after
     that registration succeeds (02 §2). For `POST /v1/me/devices` it refuses (`refused`) a body
     whose `install_id` differs from the stored one, so JS cannot register under another id, or
     whose `device_key` differs from that org's `DeviceKeyStore` public key (D24).
   - `403 device_revoked` deletes that org's sessions (every `session/<host>` with that `orgId`),
     cookies, data stores, `install/<orgId>` and its device key, then returns `device_revoked`.
   - It never follows redirects. A 3xx toward Access, or a 401/403 without the 02 envelope, becomes
     `session_expired`.
   - Responses are JSON only and capped at 1 MiB, with a 15 s timeout.
   - Errors are sanitized through core before they reach diagnostics.

   `Session.installId` mints the org's `InstallId` on first call (02 §2: one per org
   registration on this install), in the `standard` class so background work can reach it.
   `Session.signOut({orgId})` deletes it with the sessions.

   `Session.meta` is the same client without a cookie. It accepts only `/v1/meta`.

   Tests:
   - JVM and XCTest against a local HTTPS test server (OkHttp MockWebServer with `HeldCertificate`
     as a test-only dependency; `URLProtocol` stubs on iOS).
   - Redirect refusal; each `ApiResult` variant from the 02 fixtures; the size cap; path, method
     and origin refusal; a sign-out that clears every host it is given and the `install_id`.
   - Both credential headers present; `Yaran-Install-Id` absent before registration and present
     on the registration call and after it; a registration body with a foreign `install_id` is
     refused without a request; a `device_revoked` response wipes exactly that org's entries and
     leaves another org's untouched; `install_id` values match the 02 `InstallId` pattern.
   - D24 `DeviceKeyStore`: two orgs get different keys; minting the `InstallId` mints the key and
     sign-out or `device_revoked` deletes both; a missing key with a present `InstallId` (and the
     reverse) remints both; a registration body with a foreign `device_key` is refused without a
     request; the security level reaches diagnostics and the key does not (sanitizer fixture).
   - D24 androidTest on a real Keystore: the key reports non-exportable (`KeyInfo`), StrongBox is
     requested and the TEE retry runs when it is unavailable, and a signature verifies against the
     public key through `HandoffSignature`. XCTest: the same round trip on the Simulator's path
     (Secure Enclave or software fallback, whichever it has).

7. **Android machine window.**

   Create:
   - `MachineViewPlugin.kt` (180): validates arguments, starts the activity, emits `closed`.
   - `MachineViewActivity.kt` (400): lifecycle, back callback, saved state, lock and privacy cover,
     banner and overlays host.
   - `MachineWebViewFactory.kt` (150): settings and UA.
   - `MachineWebViewClient.kt` (250): applies the policy; SSL cancel; HTTP errors become overlays
     through `RefusalPolicy` (`onReceivedHttpError` headers); `onRenderProcessGone`.
   - `MachineChromeClient.kt` (200): file chooser, permission deny, window policy.
   - `CookieInjector.kt` (150)
   - `InsetsController.kt` (180)
   - `OverlayView.kt` (300): native overlays and banner in the ui-kit colors that 14 exports.
   - `res/layout`-free views built in code.
   - The activity entry in the plugin manifest.

   Tests:
   - Robolectric: the factory asserts every setting in the table; the client returns the right
     decision for representative fixtures; a back callback is enabled exactly while `canGoBack`;
     the saved-state round trip; `FLAG_SECURE` follows the setting; the renderer-gone path
     recreates the WebView.
   - androidTest on an emulator, against MockWebServer with a test CA trusted through a
     debug-only network security config: the cookie is present on the first request and on a
     WebSocket upgrade after injection; a file chooser round trip; a 530 shows the offline overlay;
     a main-frame 403 with `Yaran-Refusal: access-not-owner` shows the owner overlay and one with
     `access-expired` the reauth overlay; inspection is on in the `e2e` build type only.

8. **iOS machine window.**

   Create:
   - `MachineViewPlugin.swift` (180)
   - `MachineViewController.swift` (400)
   - `WebViewFactory.swift` (150)
   - `NavigationDelegate.swift` (250): includes the `navigationResponse` refusal check
   - `UIDelegate.swift` (150)
   - `CookieInjector.swift` (150)
   - `DataStores.swift` (120): per-machine identifiers on 17+, cleanup on removal.
   - `OverlayView.swift` (300)

   Tests (XCTest on the simulator):
   - A local HTTPS stub via `URLProtocol` is not seen by WKWebView, so these tests use a loopback
     `NWListener` test server with a trusted test identity. They cover: the cookie present on the
     first load after inject-then-verify; new-window decisions; content-process termination
     reloads; data-store removal deletes the cookies; refusal-header overlays as on Android.

9. **Renewal and reauth wiring.**

   Create `RenewalCoordinator.kt` (200) and `RenewalCoordinator.swift` (200). They connect
   `RenewalPolicy` to visibility, foreground and resume, and the clock: an absolute `exp` checked
   against wall time on resume and on a one-shot timer, never a tick count. They also connect it to
   the banner and overlay, the control URL, Access-redirect interception, and re-inject-and-reload
   after success.

   Tests: policy-driven unit tests with an injected clock, covering pre-open renewal, the banner at
   `exp - 10 min`, the overlay at `exp` with the socket still open, a reauth from the control URL
   (the path Phase 13 takes after a 4401), and a renewal that fails, keeps the overlay and states
   the outcome.

10. **Shell integration.**

    Touch Phase 14's `mobile/app/src/screens/machines/MachineRow.tsx` (Open) and
    `src/lib/lifecycle.ts` (reopen last). Create `mobile/app/src/lib/openMachine.ts` (120). It
    resolves `{orgId, machineId}` to a host from the last authenticated machines list, so a host
    never comes from a deep link or push payload directly. It then calls `MachineView.open`,
    exported for Phase 16's notification tap as `openAgent(orgId, machineId, sid, tabId?)`. It also
    handles `closed{home|settings|signedOut}` routing.

    Tests: Vitest for host resolution and refusal of an unknown machine, route building validated
    against `routes.json`, and the closed-reason routing.

11. **Fallback implementations (conditional, per gate outcome).**

    These are the G1 step 1 (`cookie` field) and step 2, G6 sub-fallback and G13 `mode=fragment`
    items in Design, with the files and budgets listed there. Each is built only when Phase 03
    records that fallback as adopted, and each ships with the tests named in its paragraph.
    Nothing in work items 1–10 changes shape when one is adopted: the outcome unions and
    `SessionStore` already carry a `credentialKind` (`accessJwt | accessCookie | managedOAuth`).

12. **Diagnostics, threat model, docs inputs.**

    - Every policy block, refused callback, handoff outcome and render crash writes one sanitized
      diagnostics line through core, never a token or query string. A fixture test asserts this.
    - Threat-model rows (IDs allocated by Phase 17, T25–T64; each PR updates its own row per
      CLAUDE.md) cover:
      - the machine WebView (no bridge, allowlist, control URLs intercepted): **T38**;
      - callback interception: the verified https callback in release builds, the dev-build
        custom-scheme residual with its warning, the consent tap, state checking, a single-use
        TTL, the in-memory key and the sealed envelope: **T36**; the association files it relies
        on: **T63**;
      - cookie attributes on iOS: **T61**;
      - the loopback proxy, if G1 step 2 is adopted: **T62**;
      - JWT at rest, which is vault only: **T37**;
      - native-only Worker HTTP, so the shell holds no bearer credential: **T60**;
      - remembered consent and the hardware device key (D24) extend **T36**: a hijacker's flow
        cannot sign with this phone's key, so it always meets the consent page;
      - sanitized diagnostics lines: **T51**.
    - The consumer-visible failure sentences are handed to Phase 17 for the troubleshooting page.

## Acceptance

- [ ] `definitions.ts` merged first, and Phase 14's mocks compile against it.
- [ ] All shared fixture tables pass on both JVM and XCTest: navigation, control URLs, routes, renewal, callback, refusal and device label. The 02 JWE vectors (`fixtures/jwe/`), the redirect allowlist, the refusal registry, the UA fixtures and the D24 device fixtures (`fixtures/sig/device-fingerprint.json`, `fixtures/sig/handoff-device-signature.json`) pass on both platforms.
- [ ] On an Android emulator (API 36), an iOS 26 simulator, the GrapheneOS phone and an iPhone, all against a Phase 07 test org with a Phase 10/11 machine:
  - [ ] control-plane sign-in and machine sign-in complete through the system browser, with one Continue tap on the consent page, on the release https callback (App Link / `.https`) and, in a build without a publisher domain, on the custom scheme with the warning shown;
  - [ ] Cancel on the consent page shows the declined sentence; a release build refuses a custom-scheme callback;
  - [ ] D24: a second sign-in to the same host skips the consent page (on Android with no prompt at all; on iOS the system sign-in alert still appears and the consent page does not); removing and re-adding the org shows the consent page again; the result is handed to Phase 19 for 02's UNVERIFIED-5;
  - [ ] D24: the device key is StrongBox- or TEE-backed on the GrapheneOS phone and Secure Enclave-backed on the iPhone (diagnostics line), and `DeviceRegistration.device_key` matches it;
  - [ ] the machine UI loads with live terminal I/O over WebSocket;
  - [ ] a file upload works through the attach picker;
  - [ ] an off-host link opens in the system browser;
  - [ ] the same-host standalone editor opens in place and Back returns;
  - [ ] `yaranapp://home` and `yaranapp://settings` route to the shell.
- [ ] No JWT is reachable from JS on the shell page: a grep of the bridge traffic logs in debug and a review of `definitions.ts` both confirm it. The JWT is absent from the WebView cookie database on disk: inspect `app_webview/Default/Cookies` on Android and the website data on iOS.
- [ ] Expiry: a short Access session (15 min, set in a test org) produces the banner and then the overlay, and Renew restores the session without losing the URL. A `yaranapp://reauth` from Phase 13's probe (including after a 4401 close) produces the overlay. A main-frame `Yaran-Refusal` response shows the overlay its code selects.
- [ ] The org API client performs Phase 16's device registration and mute calls with `Yaran-Install-Id`; revoking the phone from the user console produces `device_revoked` and the phone-removed sentence.
- [ ] Every failure-matrix row is reproduced and shows its exact sentence.
- [ ] Rotation, multi-window resize, iPad Split View and Stage Manager do not reload the page. Process death restores the same URL on Android. A renderer crash recovers on both platforms.
- [ ] `FLAG_SECURE` blocks screenshots of the machine window when the setting is on. The app lock covers the machine window on resume.
- [ ] The G1, G6 and G13 outcomes are recorded from Phase 03. Each adopted fallback is implemented and passes its tests. For each one not adopted, its design is left here unchanged.
- [ ] `module-headers --check` passes, and every file has 500 lines or fewer.

## Validation

```bash
(cd mobile/plugins/machine-view && npm ci && npx tsc --noEmit && npm test)
(cd mobile/app && npm test && npm run build && npx cap sync)
(cd mobile/android && ./gradlew :yaran-machine-view:testDebugUnitTest \
   :yaran-machine-view:connectedDebugAndroidTest ktlintCheck detekt lint)
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
(cd mobile && swiftlint --strict)
# fixtures are the same bytes on both suites
git ls-files mobile/plugins/machine-view/fixtures cloud/protocol/fixtures/jwe | xargs sha256sum
tools/module-headers/module-headers --check   # command name as delivered by Phase 01
```

## Risks

| Risk | Mitigation |
|---|---|
| Access rejects the injected cookie, or the WS upgrade drops it (G1) | Fallback ladder fully designed (header via `Profile`, then loopback proxy). `credentialKind` already exists in the store. |
| The cookie is missing on the first request (iOS race, Android timing) | Await completion, verify presence, re-inject before every load and on resume. G6 measures it. |
| Capacitor's `removeSessionCookies()` at bridge start wipes the injected cookie | Re-inject on every machine-window resume and load. The cookie is never relied on to persist. |
| A callback is intercepted by another app (T36) | Release builds use the verified https callback, which the OS delivers only to the app `assetlinks.json` / AASA vouch for, and declare no custom-scheme callback. Dev builds keep the custom scheme, send `build=dev`, and show a warning in the app and on the consent page. In both, state and TTL are single use, the key stays in memory, and the envelope is sealed to it, so a hijacker gets ciphertext. |
| The association files are wrong, unreachable or the publisher domain lapses (T63) | Auth Tab reports verification failure and the app says so (failure matrix); Phase 21 hosts and monitors the files, Phase 18 checks the fingerprint. |
| The consent tap on every renewal annoys users | Resolved by D24: after one Continue per host, a renewal signed with the same device key skips the page. The page returns for a new key, a rotated server consent key, a revoked device, or after 400 days. |
| The consent cookie does not survive between system-browser sessions (02 UNVERIFIED-5) | The launcher is never ephemeral; Phase 19 records the result. If it does not survive, every handoff shows the page, the pre-D24 behaviour, with no client change. |
| No hardware-backed key store on a device | Non-exportable software key, logged at minting (02 Risks); the wire contract is unchanged and the consent page still guards the first handoff. |
| A process death during the browser leg loses the sign-in | Accepted: 02 keeps the key in memory only. The key-free marker turns it into a clear "start again" sentence. |
| The system-browser sheet on every renewal annoys users | Renewal happens only at open, at resume or from an explicit banner, and at most about once a day with a 24 h session. Non-ephemeral sessions make SSO a near-instant pass. iOS still shows its own sign-in alert each time (D24 cannot remove it); Android shows none. |
| iOS cannot mark the injected cookie HttpOnly | Session cookie only, never persisted. The readable page is the user's own UI. Threat-model row. |
| Below WebView M139, IME handling differs | Version-keyed insets mode with tests. Phase 19 covers an old-WebView device. |
| The renderer process is killed under memory pressure mid-session | Recreate, re-inject and reload the last same-host URL. yaran's URL holds the position and its reconnect logic restores the sockets. |
| Phase 02's envelope parameters change late | The opener is isolated to two files and driven by 02's vectors. |
| G12 shows open sockets survive expiry | The overlay at `exp` covers it regardless. If sockets die early (4401), Phase 13's reauth signal covers that. |

## References

- 00-README.md D1, D3, D8, D9, D10, D16, D17, D22, D24; flows 3, 4 and 5
- 00-CONVENTIONS.md §1–§4
- research/R5-mobile.md §1 (facts 5–7, 13–17), §2 (all), §5 (items 6, 7 and 9), §8
- research/R2-web-frontend.md §5 (lifecycle), §7 (WebView API table), Implications 3 and 6
- Phases 02 (§2, §3, §8, §8.1, §10, §11, §13), 03 (G1, G6, G12, G13), 06 (W16/W16b), 11 (Y1/Y1b), 13 (§2, §4, §5, §7), 14, 16, 17 (T36, T37, T38, T51, T60, T61, T62, T63), 18, 19 (hook H4), 21
- URLs listed in Evidence (read 2026-11-14)

## Reconciliation notes (2026-11-14)

- R20: Parallel-safe/Depends/Blocks lines name the waves; 01 added; 06/11/13/14 marked code-level Wave B peers; handoff routes named W16/W16b and Y1/Y1b.
- R2: release builds use `https://<publisher-domain>/auth/callback` (Auth Tab `launch(…, host, path)` / App Link alias; iOS `.https`), dev builds `yaranapp://auth/callback` with `build=dev` and 14's warning; new "Callback by build" table; G13 is now the support matrix plus the `mode=fragment` switch, no longer a fallback.
- R2/R21: iOS 15–17.3 `callbackURLScheme` path and iOS 15–16 data-store branches removed (minimum 17.4).
- R2: consent interstitial in the handoff steps, renewal policy, failure matrix (`handoff_declined`) and acceptance; control URLs stated to stay custom-scheme and be intercepted before navigation.
- R2: Android callback filters moved into enabled-by-placeholder aliases so release builds declare no custom-scheme callback; manifest test added.
- 02 §8 alignment: handoff query now `v`, `pk=<P256Point>`, `state`, `redirect`, `device`, `build`, `mode`; envelope parameter `jwe`; payload `HandoffPayload`; recipient key kept in memory only (opener obligation 8), so the vault keeps only a key-free marker and a process death ends in an "interrupted" outcome (test changed accordingly).
- R9: `install_id` minted per org by native `Session.installId` in vault ns `install/<orgId>`; `Yaran-Install-Id` sent on registration and after; foreign-id registration refused; `device_revoked` result wipes the org.
- R9: `Yaran-Refusal` main-frame handling (`RefusalPolicy`, registry-driven test); 4401 handled through Phase 13's `yaranapp://reauth`.
- R9: handoff `cookie` field used by G1 rung 1; `credentialKind` gains `accessCookie`.
- R12/D22: `OrgApiClient` is the only Worker client, serving Phase 16's device registration, listing, removal, test and mutes; PATCH allowed; sends both `Cookie` and `cf-access-token` per 02 §2.
- Names: `protocol_mismatch` → `protocol_unsupported`; `fixtures/sealed-envelope/` → `fixtures/jwe/`; `<publisher-callback-host>` → `<publisher-domain>`; jwe_* codes cited in the opener tests and failure matrix.
- R15/Phase 19 hook H4: WebView inspection enabled only in 14's `e2e` build type / `E2E` configuration (plus debug), never release.
- R14: threat-model placeholders replaced with T38, T36, T63, T61, T62, T37, T60, T51.
- D24: per-org non-exportable P-256 device key (`DeviceKeyStore`: Android Keystore StrongBox → TEE → software, iOS Secure Enclave → software), minted and deleted with the `InstallId` (missing half remints both); handoff URL adds `dk`/`dts`/`dsig` over 02 §8.1's canonical string; `HandoffSignature` twin (canonical bytes, DER → raw, fingerprint); `OrgApiClient` refuses a foreign `device_key` on W12, which 16 fills natively.
- D24: Goal, steps 1/2/4, renewal policy and Risks say a renewal skips the consent page after one Continue per host; iOS `ASWebAuthenticationSession` still shows its system sign-in alert, Android Auth Tab shows none; reinstall or key loss means the consent page again.
- D24: failure-matrix rows for `handoff_timestamp_skewed`, `handoff_device_key_invalid`, `handoff_signature_malformed`; tests read 02's `sig/device-fingerprint.json` and `sig/handoff-device-signature.json`; acceptance for the skip on devices, hardware backing, and UNVERIFIED-5 handed to 19; new risk rows for cookie persistence and missing hardware.

### Straggler pass (2026-11-14)

- Navigation policy: same-host new windows load in place (history push), confirmed as the one behaviour; 13 §11 rule 2 no longer says "stacked view". Reason: this phase owns machine-view navigation, it keeps Android's default single-window WebView, the URL is the source of truth so Back restores position, and its acceptance already tests it.
- Fixtures: the local `control-urls.json` is replaced by 02's `cloud/protocol/fixtures/uri/control-urls.json`, read by both suites (one home for the cases 13's builders also use).
- D24 (final pass): threat range reference T25–T63 → T25–T64 (17 appended T64, remembered-consent bypass).

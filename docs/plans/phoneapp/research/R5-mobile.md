# R5: Native Android and iOS apps for yaran (online research, 2026-11-14)

Method: six sub-agents researched the topic areas in parallel, using official docs first. Their findings are merged and cross-checked here. Anything not confirmed from a primary source is marked **UNVERIFIED**. Where two sub-agents disagreed, the conflict is called out (see "Cross-check notes").

---

## 0. Executive summary

- **Stack.** Use **Capacitor 8**, moving to 9 once it reaches GA. The WebView loads the org's yaran origin as the bridge's *app URL*, set at runtime. A small bundled native/HTML shell handles onboarding: QR code, org URL, and login.
  - Do not use `allowNavigation` for remote origins. On Android it does not get the bridge until Capacitor 10.
  - Keep a pair of thin native shells (Kotlin WebView and Swift WKWebView) as the documented fallback.
- **Auth.** Run the identity provider login in the **system browser**: Auth Tab or Custom Tab on Android, `ASWebAuthenticationSession` on iOS. Then hand the Access JWT back to the app and inject it as the `CF_Authorization` cookie into the WebView.
  - The handback is a one-time code with PKCE. The callback goes to a publisher-owned fixed https domain, or to a custom scheme as fallback.
  - Embedded WebView login is blocked by Google and discouraged by Entra and Okta.
- **Push.** Every org Worker speaks **one protocol: standard Web Push**, meaning RFC 8030, RFC 8291 encryption and RFC 8292 VAPID.
  - Android uses UnifiedPush: distributor apps on F-Droid and GitHub builds, and the embedded FCM distributor on Play builds.
  - iOS needs **one publisher-run relay**, a Worker that converts Web Push to APNs. Only that relay holds the APNs key. Payloads stay end-to-end encrypted and are decrypted in a Notification Service Extension.
- **Top store risks:**
  1. Apple 4.2.7(a) "LAN-only" remote-desktop wording.
  2. Apple 2.1 and Play app-access: reviewers need a working demo server.
  3. Google Android developer verification goes global in 2027 and covers GitHub APK and F-Droid installs.
  4. F-Droid build of an npm/Capacitor project (unproven).

---

## 1. Stack choice

### Facts

1. **Capacitor versions.**
   - Current stable is **8.6.2** (2026-11-12). Capacitor 8 went GA on 2025-12-08.
   - **9.0.0-rc.0** came out on 2026-11-12, and Ionic expects 9 "end of November 2026".
   - Capacitor 7 is in extended support until 2026-12-08.
   - Sources: https://github.com/ionic-team/capacitor/releases , https://capacitorjs.com/docs/main/reference/support-policy
2. **Capacitor 8 minimums.** iOS 15.0, Android API 24, compileSdk and targetSdk 36, Xcode 26+. Capacitor 9 keeps these. Source: https://capacitorjs.com/docs/main/reference/support-policy
3. **Licensing and vendor.** Capacitor is MIT-licensed and Ionic is owned by OutSystems (2022).
   - Ionic stopped selling new commercial products on 2025-02-11. That includes **Identity Vault**.
   - **Appflow, including Live Updates, shuts down 2027-12-31.**
   - Sources: https://ionic.io/blog/?p=6282 , https://ionic.zendesk.com/hc/en-us/articles/29907381079831
4. **`server.url` is documented for live reload.** The docs say "**not intended for use in production**" about `server.url`, `allowNavigation`, `cleartext` and `allowMixedContent`. Source: https://capacitorjs.com/docs/config
5. **Android bridge origins.** The bridge script is injected with `addDocumentStartJavaScript` **only for the appUrl origin**. Other `allowNavigation` origins get "not implemented" plugins.
   - The fix is deferred to **Capacitor 10**, because it is a breaking change.
   - iOS has no origin filter: the `WKUserScript` runs on every main-frame load.
   - Source: https://github.com/ionic-team/capacitor/issues/8661 (and `Bridge.java` 8.x)
6. **A runtime app URL is possible.**
   - Android: `CapConfig.Builder.setServerUrl()`, and the `protected CapConfig config` field on `BridgeActivity`.
   - iOS: `CAPBridgeViewController.instanceDescriptor()` is `open`, and `InstanceDescriptor.serverURL` can be set.
   - The APIs exist in the source, but the **end-to-end pattern is UNVERIFIED**. Source: Capacitor main-branch source (Bridge.java, CAPBridgeViewController.swift).
7. **The bridge does not check origins.**
   - On Android, the message handler checks `isMainFrame`, not the origin. Any origin in `server.url` or `allowNavigation` can call every installed plugin.
   - On iOS, the script message handler does not check `frameInfo`.
   - Sources: https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/MessageHandler.java , https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift
8. **Core Capacitor Android has no proprietary dependencies.** It uses AndroidX and `org.apache.cordova:framework`. Source: https://github.com/ionic-team/capacitor/blob/8.x/android/capacitor/build.gradle
9. **A Capacitor app already ships on F-Droid.** MapComplete (`org.mapcomplete`) is a Capacitor app in F-Droid, built reproducibly with `Binaries` and `AllowedAPKSigningKeys`. Source: https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata/org.mapcomplete.yml
10. **`@capacitor/push-notifications` pulls in Firebase.** It depends on `firebase-messaging:25.0.1`, so it is not F-Droid compatible. `@capacitor/local-notifications` is clean. Source: https://github.com/ionic-team/capacitor-plugins/blob/main/push-notifications/android/build.gradle
    - A `cap sync`-installed plugin appears in the generated `capacitor.build.gradle` for every product flavor. Excluding a plugin per flavor needs manual Gradle work (**UNVERIFIED** detail).
11. **F-Droid scanner patterns.** The scanner flags `com.google.android.gms`, `com.google.mlkit` and `firebase` as NonFree. Source: https://fdroid.gitlab.io/fdroid-suss/suss.json
12. **react-native-webview.** v17.1.0 (2026-11-04) supports the New Architecture only and needs RN ≥ 0.80. Injected JS works on any origin. Source: https://github.com/react-native-webview/react-native-webview
13. **xterm.js 6.0.0** (2025-12-22) removed the canvas renderer, leaving DOM and WebGL.
    - Open Android IME bugs:
      - #6259: an IME commit after keydown 229 is dropped in Android WebView.
      - #3600, #6289, #6012, #6045, #5887, #6078.
    - Open iOS/WKWebView bugs:
      - #6284: Korean IME edits are dropped.
      - #5894 and #6269: dead keys.
      - #6320, #5835.
      - #5847: WebGL ghosting.
    - Open WebGL context-loss bugs: #6257, #6258.
    - Sources: https://github.com/xtermjs/xterm.js/issues/6259 , https://github.com/xtermjs/xterm.js/issues/6284 , https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl
    - yaran's existing **compose bar** (a buffered textarea) already avoids most of these and carries over unchanged.
14. **Edge-to-edge.** Targeting SDK 35 forces edge-to-edge on Android 15. Targeting SDK 36 removes the `windowOptOutEdgeToEdgeEnforcement` opt-out on Android 16. Sources: https://developer.android.com/about/versions/15/behavior-changes-15 , https://developer.android.com/about/versions/16/behavior-changes-16
15. **WebView safe-area and IME insets.** Android WebView exposes system-bar and cutout insets as CSS `safe-area-inset-*` from **M136**. It resizes the visual viewport for `ime()` insets from **M139**, for every WebView from **M144**.
    - Caveat: the resize can clear page focus.
    - Source: https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/insets.md
16. **`interactive-widget=resizes-content`.** Chrome 108 changed the default to `resizes-visual`, and Google says that change "does not affect WebView". Whether WebView honours the meta tag is **UNVERIFIED**.
    - yaran's `index.html` viewport meta still needs testing inside WebView.
    - Source: https://developer.chrome.com/blog/viewport-resize-behavior
17. **Capacitor Keyboard plugin.** The `resize` modes are **iOS-only**; Android offers only `resizeOnFullScreen`. Capacitor 8 ships a built-in SystemBars plugin. Sources: https://capacitorjs.com/docs/apis/keyboard , https://ionic.io/blog/announcing-capacitor-8
18. **Trusted Web Activity is out.** Digital Asset Links need a fixed origin, so a TWA cannot serve per-org hosts (inference from https://developer.android.com/training/app-links/verify-android-applinks).

### Comparison

| Criterion | Capacitor 8/9 | React Native + react-native-webview | Native shells (Kotlin WebView + Swift WKWebView) |
|---|---|---|---|
| Reuse of the existing React UI | Full | Full | Full |
| Per-org remote origin with native APIs | iOS: works. Android: only as the runtime appUrl (`setServerUrl`); `allowNavigation` bridging waits for Cap 10 | Works (inject on any origin) | Works (own origin rules via `addWebMessageListener` / `WKScriptMessageHandler`) |
| Officially supported for remote content | No ("not intended for production") | Yes | Yes |
| Bridge origin enforcement | None; you must enforce it with a navigation allowlist | You write it | You write it |
| Edge-to-edge / IME | SystemBars built in; Keyboard resize iOS-only | Manual | Manual, full control |
| F-Droid | Clean core; avoid push-notifications and ML Kit plugins or use a `foss` flavor; npm build on F-Droid **UNVERIFIED** | Clean if no Google modules; Metro/Hermes build on F-Droid harder | Cleanest (no npm in the app build except the optional bundled shell) |
| Plugin ecosystem | Large (secure storage, biometrics, privacy-screen, local notifications) | Large | None; write each one |
| Extra toolchain | Node + Gradle/Xcode | Node + Metro + Hermes + Gradle/Xcode | Gradle/Xcode only |
| Maintenance risk | Vendor (OutSystems) stopped commercial products; OSS core active | Community | Yours |

### Recommendation

**Capacitor 8, then 9 at GA, with the yaran origin as the runtime appUrl.**

- **Bundle** only the onboarding and settings screen. The **remote** yaran UI is served by the user's own server, which keeps the server's same-origin check, Host allowlist, Access cookie scope and app/server version parity. A bundled UI would talk cross-origin to the tunnel and break all four.
- **Enforce a strict navigation allowlist.** Only the exact org host or hosts load in the WebView, and everything else opens in the system browser. This compensates for the bridge's missing origin check.
- **Install a minimal plugin set.** The remote origin can call every installed plugin. The remote origin is the user's own yaran server, which already has a shell on their machine, so this is not a privilege escalation as long as navigation is locked.
- **Spike first: prove the runtime `setServerUrl` / `instanceDescriptor` override end to end.** If it is fragile, switch to native shells. Each is small, and the cost is re-implementing SystemBars, file chooser and permissions.
- **Skip React Native.** It adds a second runtime to host one WebView.
- **Open design question.** If the app must move between several hostnames (a control-plane Worker plus a per-machine tunnel host), the Android bridge works only on the one appUrl origin. Either serve everything under one org origin (the control-plane Worker proxies per-machine paths), or recreate the bridge per host.

---

## 2. Auth into an Access-protected remote app

1. **Google's WebView ban.** Google says "A developer must not direct a Google OAuth 2.0 authorization request to an embedded user-agent under the developer's control." Source: https://developers.google.com/identity/protocols/oauth2/policies
2. **Google's dates and scope.**
   - Blocking of all embedded WebViews started 2021-09-30. It names Android WebView, WKWebView and UIWebView.
   - Adding `disallow_webview=true` to a request tests the block; the error is `disallowed_useragent`.
   - New clients were already blocked in 2017.
   - How Google detects a WebView (the `wv` token in the user agent, `X-Requested-With`) is **UNVERIFIED**. Spoofing the user agent is policy evasion.
   - Sources: https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html , https://auth0.com/blog/google-blocks-oauth-requests-from-embedded-browsers/
3. **Cloudflare Access does not avoid the ban.** Access redirects to the identity provider, so loading the Access login inside the app WebView puts Google's page in an embedded WebView, and Google blocks it.
4. **Microsoft Entra** discourages WebViews but does not ban them.
   - Device-based Conditional Access needs a broker (Authenticator or Company Portal) or the system browser.
   - Embedded WebViews fail compliant-device policies.
   - Sources: https://learn.microsoft.com/en-us/entra/msal/android/single-sign-on , https://learn.microsoft.com/en-us/entra/msal/dotnet/resources/known-issues
5. **Okta** says it "strongly advise[s] against using WebViews". FastPass is not supported in Android WebView. Sources: https://developer.okta.com/docs/guides/build-custom-ui-mobile/android/main/ , https://support.okta.com/help/s/question/0D54z0000AFr9WJCQZ/fastpass-for-android-native-webview-not-supported
6. **GitHub** has no documented WebView block (**UNVERIFIED**). It added PKCE in July 2025. Passkeys, which Access supports since 2026-11-06, generally fail in WebViews. Sources: https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/ , https://developers.cloudflare.com/cloudflare-one/changelog/access/
7. **RFC 8252.**
   - Apps MUST use an external user-agent (§5, §8.12).
   - Redirect options are a private-use scheme in reverse-DNS form (§7.1), a claimed https URL, which is preferred (§7.2), and loopback (§7.3).
   - PKCE is required (§8.1), with exact redirect matching and `state`.
   - Source: https://www.rfc-editor.org/rfc/rfc8252
8. **Custom Tabs** share Chrome's cookie jar. App WebViews **do not share** it. Ephemeral Custom Tabs need Chrome 136+. Sources: https://developer.chrome.com/docs/android/custom-tabs , https://developer.chrome.com/docs/android/custom-tabs/guide-ephemeral-tab
9. **Auth Tab** (`AuthTabIntent`, androidx.browser 1.9, Chrome 137+).
   - Supports custom-scheme redirects, and https redirects once Digital Asset Links verify.
   - Falls back to a Custom Tab where unsupported.
   - Source: https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab
10. **Android `CookieManager.setCookie(url, "Set-Cookie string")`.** It is shared by all of the app's WebViews and accepts attributes, so a native app can set HttpOnly and Secure cookies. Call `flush()` to persist. Source: https://developer.android.com/reference/android/webkit/CookieManager
11. **`ASWebAuthenticationSession`.**
    - It shares Safari cookies unless `prefersEphemeralWebBrowserSession` is set.
    - `Callback.https(host:path:)` needs **iOS 17.4+** and an associated domain. Earlier versions support a custom scheme only.
    - Sources: https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https(host:path:) , https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/prefersephemeralwebbrowsersession
12. **Apple confirms there is no cookie sharing** between `ASWebAuthenticationSession` and WKWebView: "There's no way to share cookies between the two." Bootstrap the WKWebView session with a token instead. Source: https://developer.apple.com/forums/thread/774380
13. **`WKHTTPCookieStore.setCookie`.** Wait for its completion handler before loading; sync bugs are widely reported. Sources: https://developer.apple.com/documentation/webkit/wkhttpcookiestore , https://developer.apple.com/forums/thread/97194
14. **`CF_Authorization` cookie.**
    - Holds the Access JWT and is HttpOnly by default. The app cookie defaults to 24h.
    - **Binding Cookie (`CF_Binding`) must be off** for non-browser use. It is also a known cause of WebSocket "bad handshake".
    - Sources: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/ , https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/
15. **The origin receives `Cf-Access-Jwt-Assertion`.** Token fields are `aud`, `email`, `exp`, `iat`, `iss` and `type`. Sources: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ , https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
16. **`cloudflared access login`.**
    - The token goes in the `cf-access-token` header (or the `token` query argument for `access curl`).
    - Internally, cloudflared opens `/cdn-cgi/access/cli?...edge_token_transfer=true`, long-polls `login.cloudflareaccess.org/transfer/<pubkey>`, and receives app and org tokens.
    - The app token is the `CF_Authorization` cookie value. This is undocumented and could change.
    - Sources: https://developers.cloudflare.com/cloudflare-one/tutorials/cli/ , https://github.com/cloudflare/cloudflared/blob/master/token/transfer.go
17. **Setting `CF_Authorization` manually in a WebView: UNVERIFIED but strongly implied.** cloudflared presents the token as that cookie. Conditions: Binding off, host = app hostname, `Secure`, `Path=/`, expiry = JWT `exp`.
18. **Access Managed OAuth** (2026-03-20). Access becomes an OAuth authorization server for self-hosted apps.
    - Custom-scheme redirects are allowed only as exact entries.
    - Tokens are **opaque** with a 15-minute default lifetime and refresh tokens.
    - It is not usable for WebView or WebSocket cookie auth: a browser cannot set headers on a WebSocket, and nothing says Access turns the token into a cookie (**UNVERIFIED**).
    - Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
19. **Service tokens** are shared machine secrets, wrong for a distributed app. Strict service-token mode (2026-10) issues no cookie. Source: https://developers.cloudflare.com/cloudflare-one/changelog/access/
20. **WebSockets through Access.**
    - Cloudflare Tunnel fully supports WebSockets. Source: https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
    - Worker-level Access policies 403 WebSocket upgrades, so use a hostname-based self-hosted Access app. Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
    - Whether an open socket survives JWT expiry is **UNVERIFIED**.
21. **Access session durations.** Global session 15 min to 1 month (default 24h); logout at `/cdn-cgi/access/logout`. Source: https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/
22. **Cloudflare documents no mobile-app pattern for Access** (searched the docs and changelog).
23. **Universal Links and App Links are build-time.**
    - The domains are listed in the entitlement or manifest, and each must serve AASA or `assetlinks.json` itself.
    - So **per-org hosts can never be verified callbacks**. Only a fixed publisher domain can be.
    - Sources: https://developer.apple.com/documentation/xcode/supporting-associated-domains , https://developer.android.com/training/app-links/verify-android-applinks
24. **Custom schemes can be hijacked.**
    - Apple: if multiple apps register the same scheme, "the app the system targets is undefined". Android lets any app declare a scheme.
    - Mitigations: PKCE, `state`, one-time short-TTL codes.
    - `ASWebAuthenticationSession` and Auth Tab return the callback to the app that started the session, not through system dispatch, which reduces the risk.
    - Sources: https://developer.apple.com/documentation/xcode/defining-a-custom-url-scheme-for-your-app , https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks

### Recommended flow

1. **Server side (yaran or the control-plane Worker).**
   - `GET /mobile/handoff`, behind Access: read `Cf-Access-Jwt-Assertion`, store `{code → JWT, code_challenge, ttl ≤ 60 s, single-use}`, and 302 to the callback with `code` and `state`.
   - `POST /mobile/exchange`, behind an Access **Bypass** path policy: verify PKCE, delete the code, and return the JWT and its `exp`.
2. **Onboarding.** A QR code or typed URL gives the org base URL, which the app pins as its sole allowed host.
3. **Login.** The app opens `https://<org>/mobile/handoff?code_challenge…&state…` in `ASWebAuthenticationSession` (non-ephemeral, so existing identity provider and passkey sessions work) or in an Auth Tab that falls back to a Custom Tab.
4. **Callback.** Prefer `https://<publisher-fixed-domain>/cb`, using iOS 17.4+ `.https` and Auth Tab with Digital Asset Links. Fall back to the custom scheme `<reverse-dns>:/cb`.
5. **Exchange and load.** Exchange the code, inject `CF_Authorization` (HttpOnly, Secure, `Path=/`, expiry = `exp`), wait for the completion handler or `flush()`, then load the origin.
6. **Renew.** Repeat silently before `exp`, or on a redirect to Access or a WebSocket close with 401/403.
7. **Org prerequisites,** shown during onboarding: Binding Cookie off, a hostname-based Access app, and the Bypass path policy for `/mobile/exchange`.
8. **Fallback** if an org refuses the Bypass path: copy cloudflared's `/cdn-cgi/access/cli` transfer flow. It needs no server change, but it is undocumented.

**Must verify first:** that `Cf-Access-Jwt-Assertion` equals the cookie JWT and that the injected cookie is accepted by Access, including on the WebSocket upgrade.

---

## 3. Push notifications

1. **APNs auth token.**
   - An ES256 JWT with `kid` (Key ID), `iss` (Team ID) and `iat`. Refresh it no more often than every 20 minutes and no less often than every 60. An old `iat` returns `ExpiredProviderToken` (403).
   - Team-scoped keys work for **all topics in the team**. Topic-specific keys also exist, but still let the holder push to every install of that bundle ID.
   - **So no key can be given to orgs.**
   - Source: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
2. **APNs requires HTTP/2 and TLS 1.2+.** Payload max is 4096 bytes, `apns-push-type` is required, background pushes use priority 5, and `apns-collapse-id` is at most 64 bytes. Source: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
3. **APNs from a deployed Worker works.**
   - Cloudflare's kentonv (workerd #4841, 2025-08-20): "workerd doesn't have HTTP/2 support, but in production it sends requests through Cloudflare's proxy stack". The reporter confirmed it works deployed and **fails under `wrangler dev`**.
   - Not documented as a guarantee (**UNVERIFIED**). A gotcha: use `redirect: 'manual'`.
   - Sources: https://github.com/cloudflare/workerd/issues/4841 , https://www.npmjs.com/package/@fivesheepco/cloudflare-apns2 , https://developers.cloudflare.com/workers/runtime-apis/fetch/
4. **Fallbacks if Worker HTTP/2 stops working.** Cloudflare Containers with outbound internet, or a small VM. TCP `connect()` with ALPN h2 is **UNVERIFIED**. Sources: https://developers.cloudflare.com/containers/platform-details/outbound-traffic/ , https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
5. **FCM HTTP v1.** Sign an RS256 service-account JWT and exchange it at `oauth2.googleapis.com/token` for a 1-hour access token. Workers WebCrypto supports RSASSA-PKCS1-v1_5, ECDSA, ECDH, AES-GCM and HKDF, which covers FCM, VAPID and RFC 8291. Sources: https://developers.google.com/identity/protocols/oauth2/service-account , https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
   - Avoid the `fcm-cloudflare-workers` npm package, which Socket flags for a supply-chain compromise. Write the roughly 30 lines yourself.
6. **The legacy FCM API was shut down from 2024-06-20.** Source: https://groups.google.com/g/firebase-talk/c/LgY3wx6ehS4
7. **FCM demotes silent high-priority pushes.** High-priority messages that don't show a notification get demoted, judged over 7 days. AndroidConfigV2 (preview) adds `mutable_content` with a 20-second window to rewrite the notification. Sources: https://firebase.google.com/docs/cloud-messaging/android-message-priority , https://firebase.google.com/docs/cloud-messaging/send/v2-api
8. **UnifiedPush spec AND_3.1.0.**
   - Messages MUST be RFC 8291-encrypted, with VAPID (RFC 8292) authentication.
   - Body 1–4096 bytes, cleartext at most 3993.
   - Distributors: ntfy, Sunup, NextPush, Conversations, gCompat-UP.
   - **No iOS support** "for the foreseeable future".
   - Sources: https://unifiedpush.org/developers/spec/android/ , https://unifiedpush.org/users/faq/
9. **Embedded FCM distributor for Play builds.**
   - FCM accepts VAPID-authorised Web Push directly, so the app server needs **no FCM service account**. A FOSS reimplementation of the distributor exists.
   - The app still embeds the publisher's Firebase app config.
   - Sources: https://unifiedpush.org/kdoc/embedded_fcm_distributor/ , https://unifiedpush.org/kdoc/foss_embedded_fcm_distributor , https://unifiedpush.org/news/20250131_push_for_decentralized/
10. **iOS Notification Service Extension.**
    - Runs only with `mutable-content: 1` and a visible alert. "Decrypt data sent in an encrypted format" is an Apple-listed use.
    - About 30 seconds before `serviceExtensionTimeWillExpire`. On failure the original alert text shows, so keep it generic.
    - Does not run if the user disabled alerts.
    - Source: https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
    - Memory limit about 24 MB: forums only, not Apple docs. Source: https://developer.apple.com/forums/thread/64634
11. **Minimal-payload precedents.**
    - Threema: empty FCM payload; encrypted APNs payload. Source: https://threema.com/faq/privacy_push
    - Matrix `event_id_only`. Source: https://spec.matrix.org/latest/push-gateway-api/
12. **Android 13+ needs the `POST_NOTIFICATIONS` runtime permission**, off by default. Source: https://developer.android.com/develop/ui/views/notifications/notification-permission
    - iOS `requestAuthorization` prompts once; `.provisional` delivers quietly. Source: https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications

### How self-hostable projects handle publisher-owned push credentials

| Project | Relay operator | Server→relay authentication | What the relay sees | Limits |
|---|---|---|---|---|
| Matrix/Element (Sygnal) | Element, at `matrix.org/_matrix/push/v1/notify`; holds the .p8 per `app_id` | **None** (spec: "Requires authentication: No"); addressed by `app_id` + pushkey | Event fields, or IDs only with `event_id_only` | Rejected pushkeys returned and deleted; rate limits UNVERIFIED |
| Mastodon | Community Web Push→APNs relays (mastodon/webpush-apn-relay, toot-relay) | Endpoint URL embeds device token; VAPID; standard RFC 8291 since 4.4 | Ciphertext only | None documented |
| ntfy | ntfy.sh as `upstream-base-url` for iOS | Optional `upstream-access-token` | Message ID + topic hash; text "New message"; app polls | Burst + daily, 429 |
| Home Assistant | Nabu Casa Firebase function | `push_url` + `push_token` from app registration | **Plaintext** | 500/device/day, 429 + `rateLimits` |
| Bitwarden | push.bitwarden.com / .eu | Per-install Installation ID + Key from bitwarden.com/host | Installation ID, sync triggers (UNVERIFIED) | UNVERIFIED |
| Nextcloud | push-notifications.nextcloud.com | Device RSA keys; server signs; proxy verifies SHA-512 signature | Subject encrypted to device key | "blocked because of spam", undocumented |
| Rocket.Chat | gateway.rocket.chat | Cloud workspace registration | Text unless premium "hide content" | ~10k/month free (UNVERIFIED) |

Sources:
- https://ems-docs.element.io/books/element-support/page/understanding-push-notifications/revisions/2291
- https://github.com/matrix-org/sygnal
- https://docs.joinmastodon.org/methods/push/
- https://github.com/mastodon/webpush-apn-relay
- https://docs.ntfy.sh/config/
- https://github.com/binwiederhier/ntfy/issues/1265
- https://contributors.home-assistant.io/companion/mobile-app-api/notifications/
- https://companion.home-assistant.io/docs/notifications/notification-details/
- https://bitwarden.com/help/configure-push-relay/
- https://bitwarden.com/help/hosting-faqs/
- https://github.com/nextcloud/notifications/blob/master/docs/push-v2.md
- https://docs.rocket.chat/use-rocket.chat/workspace-administration/settings/push

## Push architecture for a self-hostable app (recommendation)

**Principle: every org Worker sends standard Web Push only.** That means RFC 8030 delivery, RFC 8291 aes128gcm encryption and RFC 8292 VAPID signing, with one P-256 VAPID key per org stored as a Worker secret. The publisher holds the only APNs credential, and no org ever holds a publisher secret.

1. **Android, F-Droid and GitHub APK (`foss` flavor).**
   - The UnifiedPush connector registers with whichever distributor the user has (ntfy, Sunup, and so on). The app sends the endpoint plus its `p256dh` and `auth` keys to the org Worker.
   - The publisher runs nothing.
   - Without a distributor there is no push; show an in-app hint that links to ntfy.
2. **Android, Play (`play` flavor).**
   - Ship the **embedded FCM distributor**, preferring the FOSS one, so the org Worker sends VAPID Web Push straight to FCM's endpoint. The publisher runs nothing and holds no FCM server key.
   - **Prove this on a device.** Fallback: the publisher relay also holds an FCM service account.
3. **iOS: a publisher-run relay**, a Cloudflare Worker modelled on Mastodon's webpush-apn-relay.
   - **Registration.** The app gets its APNs token, generates a P-256 key and a 16-byte auth secret, and stores them in an App Group Keychain shared with the Notification Service Extension. It asks the relay for an endpoint: `https://push.<publisher>/w/<opaque>`, where the opaque part is the APNs token plus the org's VAPID public key, encrypted to the relay.
   - **Abuse control.** The relay accepts a push only when its VAPID JWT verifies against that exact public key. A leaked endpoint is useless without the org's private key, and the relay needs **no org registry**. It rate-limits per VAPID key and per device token, returns 429, and returns 410 when APNs reports Unregistered, so the org deletes the subscription (as Sygnal does with rejected pushkeys).
   - **Forwarding.** The relay sends the ciphertext as base64 in an `alert` push with `mutable-content: 1` and a generic body ("An agent needs you"). The Notification Service Extension decrypts it and rewrites the title and body.
   - **Credentials.** Use a topic-specific APNs key scoped to the bundle ID, kept in Worker secrets. Deploy and test the relay **in production, not under `wrangler dev`**, and keep it portable to a Container or VM.
4. **Payload.** Send only the agent ID, the tab ID, a short state word and the project name, under about 200 bytes. Base64 inflates the ciphertext by a third inside the 4 KB APNs limit. The app deep-links to `#/agent/<id>` on tap. Agent content never leaves the org's infrastructure in plaintext.
5. **The relay should be open source and optional.**
   - The relay URL is configurable: an org can run its own copy, but then it needs its own APNs key, which is only possible for its own build of the app.
   - Being FOSS keeps F-Droid from tagging the app NonFreeNet or TetheredNet for push.
6. **Disclosures.** The relay sees device tokens, timing and volume. Declare these in Play Data Safety, the Apple privacy labels and the privacy policy.

**Risks:**
- Undocumented Workers HTTP/2 to APNs.
- The publisher takes on uptime and abuse duty.
- The FCM direct-VAPID path for Play builds is unproven.
- FCM demotes silent pushes when decryption fails.
- On iOS, a Notification Service Extension crash or memory kill means the user sees only the generic text.

---

## 4. App store policies

### Apple (guidelines last updated 2026-10-16; https://developer.apple.com/app-store/review/guidelines/)

1. **4.2:** "elevate it beyond a repackaged website… If your app is not particularly useful, unique, or 'app-like,' it doesn't belong". **4.2.2** forbids "web clippings… collection of links". **4.2.3(i)** says an app should work without installing another app; software on the host computer does not appear to count, which is an inference.
2. **2.5.2:** an app may not "download, install, or execute code which introduces or changes features or functionality". The guideline has no explicit WebView carve-out. Remote web UI that changes with server updates is common practice but is a reviewer discretion risk.
3. **4.2.7 Remote Desktop Clients** applies when the app "acts as a mirror of specific software or services rather than a generic mirror of the host device".
   - (a) "must only connect to a user-owned host device… and both the host device and client must be connected on a local and LAN-based network".
   - (b) software "fully executed on the host".
   - (c) "All account creation and management must be initiated from the host device".
   - (e) "Thin clients for cloud-based apps are not appropriate".
   - **A tunnelled internet connection conflicts with (a)** if a reviewer classes the app as 4.2.7.
4. **2.1(a):** "include demo account info (and turn on your back-end service!)… a built-in demo mode in lieu of a demo account with prior approval".
5. **5.1.1(v):** account deletion is required only "If your app supports account creation". Accounts provisioned only by the identity provider through Access are likely out of scope. Linking out to sign-up is **UNVERIFIED**.
6. **4.8:** a Sign in with Apple-style alternative is not required for apps using "an existing education or enterprise account". Org SSO qualifies.
7. **2.5.6:** web browsing must use WebKit. WKWebView complies.
8. **Privacy manifest.** Required-reason APIs need an approved reason in the privacy manifest, including SDK use. Capacitor documents that `@capacitor/preferences` needs a UserDefaults declaration.
   - Sources: https://developer.apple.com/news/?id=r1henawx , https://capacitorjs.com/docs/ios/privacy-manifest
   - Exact error codes and reason codes are **UNVERIFIED**.
9. **Precedents.**
   - Terminal apps: Blink Shell, Termius, a-Shell, Prompt 3.
   - Self-hosted coding-agent remotes: "Spaces: Run Coding Agents" (QR pairing to the user's own Mac or Linux machine, https://apps.apple.com/app/id6791713994), CC Pocket (https://apps.apple.com/app/id6759188790), Tailscode, Leash.
   - Whether any of them are WebView shells is **UNVERIFIED**.
10. **Xcode and SDK.** Uploads need Xcode 26+ with the iOS 26 SDK since 2026-04-28. Source: https://developer.apple.com/news/upcoming-requirements/

### Google Play and Android

11. **Webview spam** forbids a "webview of a website without permission from the website owner". You own the UI, so this does not apply. Source: https://support.google.com/googleplay/android-developer/answer/9899034
12. **Device and Network Abuse** excludes "code that runs in a virtual machine or an interpreter… (such as JavaScript in a webview or browser)" from the remote-code ban, so a remote web UI is explicitly fine. It also says "may not modify, replace, or update itself using any method other than Google Play's update mechanism". Sources: https://support.google.com/googleplay/android-developer/answer/9888379 , https://support.google.com/googleplay/android-developer/answer/16559646
13. **Account deletion** applies when the app allows account creation, including directing users to an outside sign-up. Source: https://support.google.com/googleplay/android-developer/answer/13327111
14. **Data Safety** is mandatory even for apps that collect no data. Data sent from "a webview your app controls" counts. Push tokens sent to the publisher relay likely count as collection. Source: https://support.google.com/googleplay/android-developer/answer/10787469
15. **Target API.** Since **2026-08-31**, new apps and updates must target **API 36**. Source: https://developer.android.com/google/play/requirements/target-sdk
16. **Testing gate.** Personal accounts created after 2023-11-13 need **12 testers for 14 days** in a closed test. That organization accounts are exempt is **UNVERIFIED**. Source: https://support.google.com/googleplay/android-developer/answer/14151465
17. **App access for review** must be complete. Flag MFA and OTP. Up to 5 instruction sets. Source: https://support.google.com/googleplay/android-developer/answer/9859455
18. **`REQUEST_INSTALL_PACKAGES`** is restricted to core uses, so the self-updater belongs in the non-Play flavor only. Source: https://support.google.com/googleplay/android-developer/answer/12085295
19. **Android developer verification.**
    - 2026-09-30: enforced in Brazil, Indonesia, Singapore and Thailand.
    - **2027: global, for all apps on certified devices, including sideloaded ones.**
    - $25 account, and a D-U-N-S number for organizations (up to 28 days).
    - Play App Signing apps are auto-registered. Multiple signing keys per package are allowed.
    - Unregistered apps install only through ADB or the "advanced flow" (developer mode, a 24-hour wait, biometric confirmation).
    - Sources: https://developer.android.com/developer-verification , https://developer.android.com/developer-verification/guides/faq

### F-Droid

20. **FOSS only.** Play Services and Firebase are barred. Upstream needs "a FLOSS alternative or a build flavour" without them. Prebuilts must come only from trusted sources. The app must not download executables without consent. Source: https://f-droid.org/docs/Inclusion_Policy/
21. **Anti-features are labels, not bans:** Ads, Tracking, NonFreeNet, NonFreeDep, NonFreeAdd, TetheredNet, KnownVuln, NoSourceSince, NonFreeAssets, DisabledAlgorithm. Source: https://f-droid.org/docs/Anti-Features/
22. **Self-hosted FOSS server.** A self-hosted FOSS server is not NonFreeNet, and a user-chosen server avoids TetheredNet.
    - Whether Cloudflare Tunnel and Access (proprietary infrastructure on the user's side) trigger NonFreeNet is **UNVERIFIED**, and is the main tagging risk.
    - Precedent: the Home Assistant "minimal" flavor, a WebView shell around a self-hosted UI, has no anti-features. Source: https://f-droid.org/packages/io.homeassistant.companion.android.minimal/
23. **FCM library is forbidden.** The UnifiedPush FCM distributor carries NonFreeNet on IzzyOnDroid. Sources: https://f-droid.org/2022/12/18/unifiedpush.html , https://apt.izzysoft.de/fdroid/index/apk/org.unifiedpush.distributor.fcm
24. **Signing.** F-Droid signs by default. With `Binaries` and `AllowedAPKSigningKeys` it publishes the **developer-signed APK** when its rebuild matches, so one key can serve GitHub, Play and F-Droid. Source: https://f-droid.org/docs/Reproducible_Builds/
25. **Metadata.**
    - In-repo `fastlane/metadata/android/<locale>/`: `title.txt` (50 characters), `short_description.txt` (80), `full_description.txt` (4000), `changelogs/<versionCode>.txt` (500), plus `images/…`.
    - fdroiddata recipe fields: `prebuild`, `build`, `scandelete`, `srclibs`, `sudo`.
    - npm/Node inside a recipe is not addressed by the docs (**UNVERIFIED**; MapComplete is a precedent).
    - Sources: https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/ , https://f-droid.org/docs/Build_Metadata_Reference/
26. **F-Droid on Google verification:** "We unequivocally advise against signing up for this program, now or ever." (open letter, 2026-02-24). Source: https://f-droid.org/en/2026/02/24/open-letter-opposing-developer-verification.html

## Store-policy risks (ranked)

1. **HIGH: Apple 4.2.7(a), LAN-only.**
   - Position the app as a client for self-hosted server software (like the Home Assistant or Plex apps), with native terminal input, push, QR onboarding and biometric lock, never "remote desktop" or "mirror".
   - Account management stays on the host, which satisfies (c).
   - Cite Spaces and CC Pocket in the review notes.
   - Optionally note that LAN or Tailscale connections are also supported.
2. **HIGH: Apple 2.1 and Play app access.** Reviewers need a reachable server.
   - Run a permanent demo yaran behind Access, using a reviewer identity they can actually sign in with (a password provider, not email PIN), with seeded fake agents and the fake streaming provider from `tools/preview-env`.
   - Put a QR code and URL in the review notes. Or get Apple's prior approval for a demo mode.
3. **HIGH: Google developer verification, global in 2027.** It affects GitHub APK and F-Droid installs.
   - Register the package with the single app-signing key you hold yourself.
   - Start D-U-N-S now.
   - Expect friction with F-Droid's stance; ship F-Droid as developer-signed reproducible builds so the registered key is the same one.
4. **MEDIUM: Apple 4.2 and 2.5.2 (repackaged website, remote code).**
   - Ship real native value: APNs, QR scanning, biometrics, share sheet and attach, a native key bar.
   - Bundle the onboarding UI.
5. **MEDIUM: F-Droid build and tagging.**
   - npm/Capacitor builds on F-Droid infrastructure are unproven; run `fdroid build` locally early.
   - NonFreeNet or TetheredNet tagging over Cloudflare and the relay: keep Cloudflare optional (LAN or Tailscale also work), keep the relay FOSS and optional, and use a `foss` flavor with UnifiedPush.
6. **MEDIUM: Play 12-tester gate.** Use an organization account (exemption UNVERIFIED) or plan 14 days.
7. **LOW-MED: target API 36 and edge-to-edge** on Android 16 with no opt-out. Capacitor 8 defaults to 36.
8. **LOW: privacy disclosures.** Privacy manifest, nutrition labels, Data Safety and a privacy policy URL on both stores. Declare relay-held push tokens.
9. **LOW: account deletion and Sign in with Apple.** Avoided while the app never creates accounts and login is enterprise SSO only.

---

## 5. Security

1. **Jetpack `security-crypto` (EncryptedSharedPreferences) is deprecated.** 1.1.0-alpha07 (2025-04-09) "Deprecated all APIs in favour of existing platform APIs and direct use of Android Keystore". Stable 1.1.0 shipped 2025-07-30. Source: https://developer.android.com/jetpack/androidx/releases/security
2. **Android Keystore.** Keys are TEE-backed, or StrongBox-backed on Android 9+ ("for most apps, StrongBox is not necessary"). Check where a key lives with `KeyInfo.getSecurityLevel()`. Source: https://developer.android.com/privacy-and-security/keystore
3. **iOS Keychain access classes.** Use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, or the stricter `...WhenPasscodeSetThisDeviceOnly`. Neither migrates to a new device. Sources: https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly , https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id
   - Secure Enclave supports P-256 only, with non-exportable keys. Source: https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave
4. **Capacitor secure-storage plugins.**
   - capacitor-secure-storage-plugin: MIT, but its iOS default accessibility is weaker than ThisDeviceOnly and its web fallback is base64 in localStorage.
   - Capawesome secure-preferences: paid.
   - Identity Vault: no longer sold.
   - **Recommendation: write one small native plugin** (Keystore AES-GCM and Keychain ThisDeviceOnly).
   - Sources: https://github.com/martinkasa/capacitor-secure-storage-plugin , https://capawesome.io/plugins/secure-preferences/
5. **Biometric app lock.**
   - Android: `BiometricPrompt` with `BIOMETRIC_STRONG` and a `CryptoObject` on a Keystore key with `setUserAuthenticationRequired(true)`. Keys are invalidated when a new biometric is enrolled. Source: https://developer.android.com/identity/sign-in/biometric-auth
   - iOS: Keychain `SecAccessControl` with `.biometryCurrentSet` or `.userPresence`, plus `NSFaceIDUsageDescription`.
   - Never use a bare `evaluatePolicy` or `authenticate()` gate.
   - Plugin: @capgo/capacitor-native-biometric (MPL-2.0). It defaults to `AccessControl.NONE`, so set `BIOMETRY_CURRENT_SET` explicitly. Source: https://github.com/Cap-go/capacitor-native-biometric
6. **Certificate pinning: don't.**
   - Cloudflare does not support pinning Universal, Advanced or Custom Hostname edge certificates, because it "regularly rotates the edge certificates". It recommends Certificate Transparency monitoring. Source: https://developers.cloudflare.com/ssl/reference/certificate-pinning/
   - Android `<pin-set>` with `expiration` exists. Certificate Transparency is enforced by default from Android 17. Source: https://developer.android.com/privacy-and-security/security-config
   - Whether WebView honours `<pin-set>` is **UNVERIFIED**.
7. **Screenshot protection.**
   - Android: `FLAG_SECURE`, available through the official `@capacitor/privacy-screen`, which also blanks the recents thumbnail. Android 14 screenshot detection; Android 15 recording callback. Sources: https://capacitorjs.com/docs/apis/privacy-screen , https://developer.android.com/about/versions/14/features/screenshot-detection , https://developer.android.com/about/versions/15/features
   - iOS has no screenshot-blocking API. Cover the UI before the app-switcher snapshot, and watch `sceneCaptureState` (iOS 17+; `UIScreen.isCaptured` is deprecated in iOS 27). Sources: https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background , https://developer.apple.com/documentation/uikit/uitraitcollection/scenecapturestate
8. **Backups.**
   - Android: `allowBackup` defaults to true. Set `allowBackup="false"` plus `dataExtractionRules` (Android 12+, cloud and device-transfer) plus `fullBackupContent` (Android 11 and lower). Source: https://developer.android.com/identity/data/autobackup
   - iOS: Keychain ThisDeviceOnly items don't migrate. `isExcludedFromBackup` is for files only. Source: https://developer.apple.com/documentation/foundation/urlresourcevalues/isexcludedfrombackup
9. **WebView hardening.**
   - Turn off `allowFileAccess` and `allowContentAccess`, and use `WebViewAssetLoader`. Source: https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion
   - `addJavascriptInterface` injects into all frames, so use an HTTPS host allowlist. Source: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges
   - Keep Safe Browsing on and the mixed-content default of NEVER_ALLOW. Handle `onRenderProcessGone`. Source: https://developer.android.com/develop/ui/views/layout/webapps/managing-webview
   - WKAppBoundDomains allows at most 10 build-time domains, so it is unusable for per-org hosts. Source: https://webkit.org/blog/10882/app-bound-domains/
   - **Capacitor's bridge has no origin check (§1 fact 7), so the navigation allowlist is a must.**
10. **OWASP MASVS v2.**
    - Control groups: STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE, PRIVACY (24 controls).
    - Profiles: MAS-L1 (other apps are the adversary), MAS-L2 (OS untrusted, physical access), MAS-R (the user is the attacker), MAS-P (privacy).
    - **Target L2 + P, skip R** (anti-tamper does not fit a single-tenant tool).
    - Sources: https://mas.owasp.org/MASVS/ , https://mas.owasp.org/Profiles/ , https://github.com/OWASP/masvs/blob/master/OWASP_MASVS.yaml

### Baseline checklist

- **Network:** HTTPS and WSS only; no `cleartext` or `allowMixedContent`; no pinning; turn on Cloudflare CT monitoring.
- **Tokens:** Access JWT and refresh material in Keychain ThisDeviceOnly and a Keystore AES-GCM key. Nothing in localStorage. No EncryptedSharedPreferences.
- **App lock (optional, a user setting):** releases a secret only after `BIOMETRIC_STRONG` + `CryptoObject` on Android, or `SecAccessControl` on iOS.
- **Backups:** `allowBackup=false` plus `dataExtractionRules` plus `fullBackupContent`.
- **Screen:** `FLAG_SECURE` as a user setting (default on is debatable for a terminal, since screenshots are useful). iOS app-switcher cover.
- **WebView:** exact-host navigation allowlist, file and content access off, `webContentsDebuggingEnabled` off in release, minimal plugin set, Safe Browsing on.
- **Updates and dependencies:** enforce a minimum app and WebView version, scan dependencies, fill in privacy labels and Data Safety.

---

## 6. QR scanning without proprietary dependencies

1. **ZXing (Java)** is in maintenance mode (3.5.4, 2025-11). **zxing-android-embedded** last released 4.3.0 in 2021 and is dormant. Both are Apache-2.0. Sources: https://github.com/zxing/zxing , https://github.com/journeyapps/zxing-android-embedded
2. **zxing-cpp** is active (3.1.1, 2026-07, Apache-2.0) and has a CameraX `ImageProxy` wrapper, `io.github.zxing-cpp:android`.
   - It ships native `.so` files from Maven Central. Whether F-Droid accepts them is **UNVERIFIED**; Maven Central is a "trusted repo", but F-Droid may want them built from source.
   - Source: https://github.com/zxing-cpp/zxing-cpp/tree/master/wrappers/android
3. **ML Kit** is proprietary and flagged NonFree. Bundled `barcode-scanning:17.3.0` is about 2.4 MB; unbundled needs Play Services. Source: https://developers.google.com/ml-kit/vision/barcode-scanning/android
4. **Capacitor scanner plugins are all non-FOSS-clean.**
   - `@capacitor-mlkit/barcode-scanning` (Capawesome) pulls in ML Kit and `play-services-code-scanner`.
   - `@capacitor/barcode-scanner` (OutSystems) pulls in ZXing **and** ML Kit.
   - `capacitor-community/barcode-scanner` (ZXing) is archived.
   - Sources: https://github.com/capawesome-team/capacitor-mlkit , https://github.com/ionic-team/capacitor-barcode-scanner
5. **In-WebView scanning.** Use `getUserMedia` with a JS or WASM decoder (for example the zxing-cpp WASM build, or jsQR).
   - Needs no native code, works in the PWA too, and is F-Droid-clean.
   - Capacitor's `BridgeWebChromeClient` grants `VIDEO_CAPTURE` on Android. WKWebView has supported `getUserMedia` since iOS 14.3, with prompt quirks on custom schemes.
   - Source: https://developer.apple.com/forums/thread/670322
6. **iOS native options.** `AVCaptureMetadataOutput` (iOS 6+) and VisionKit `DataScannerViewController` (iOS 16+, A12+). Source: https://developer.apple.com/documentation/visionkit/datascannerviewcontroller

**Recommendation:** scan in the WebView with a WASM or JS decoder on the bundled onboarding page. It is one code path on Android, iOS and the PWA. If camera prompt quirks bite, fall back to a tiny native plugin: zxing-cpp + CameraX on Android, AVFoundation on iOS.

---

## 7. Release engineering

1. **fastlane** 2.241.2 (2026-10-26). It moved to the Mobile Native Foundation; the completion date is **UNVERIFIED**.
   - Android: `supply` / `upload_to_play_store` (tracks internal, alpha, beta, production).
   - iOS: `pilot` / `upload_to_testflight` and `app_store_connect_api_key` (Team key, `.p8`, no 2FA). Use `match` or cert+sigh for signing.
   - Sources: https://github.com/fastlane/fastlane/releases , https://docs.fastlane.tools/actions/upload_to_play_store/ , https://docs.fastlane.tools/actions/upload_to_testflight/ , https://docs.fastlane.tools/app-store-connect-api/ , https://docs.fastlane.tools/codesigning/getting-started/
2. **AAB and Play App Signing are mandatory for new apps** (since Aug 2021). Source: https://developer.android.com/guide/app-bundle
   - **To share one key across stores, "provide your own signing key when you configure Play App Signing"** (PEPK export) **before the first release**. Different keys mean users cannot upgrade across channels, and this cannot be fixed later. The key must stay valid past 2033; Google recommends 25+ years.
   - Source: https://developer.android.com/studio/publish/app-signing
3. **GitHub Actions secrets.** Store the keystore as a Base64 secret. Above 48 KB, commit a gpg-encrypted file and store only its passphrase as a secret. Source: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
4. **iOS build requirements.** Uploads need Xcode 26 and the iOS 26 SDK (since 2026-04-28) and a deployment target of iOS 13+ (since 2026-09-09). The GitHub `macos-26-arm64` image has Xcode 26.0.1–26.6.
   - Headless cloud signing with `xcodebuild -allowProvisioningUpdates -authenticationKey…` is forum-only (**UNVERIFIED** officially), so prefer match.
   - Sources: https://developer.apple.com/news/upcoming-requirements/ , https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md , https://developer.apple.com/forums/thread/764554
5. **Reproducible builds.** The usual sources of non-determinism:
   - baseline profiles: disable the ArtProfile tasks.
   - PNG crunching: set `cruncherEnabled=false` and pre-optimize images.
   - R8: version 8.6.33+ / 8.8+.
   - AGP 8.3+ `version-control-info.textproto`: build from a clean tree.
   - Signing: **use apksigner from build-tools 34**, because 35+ breaks apksigcopier.
   - Pin JDK, NDK and build-tools.
   - Source: https://f-droid.org/docs/Reproducible_Builds/
6. **Dependency-info block.** Set `dependenciesInfo { includeInApk = false }` for F-Droid, which flags the extra signing block; keep it in the bundle for Play. Sources: https://developer.android.com/reference/tools/gradle-api/com/android/build/api/dsl/DependenciesInfo , https://forum.f-droid.org/t/build-fails-with-found-extra-signing-block/29220
   - Node, npm and Vite output determinism under F-Droid is **UNVERIFIED**. Pin Node and the lockfile, and run CI that rebuilds twice and diffs the results.
7. **fdroiddata recipe.**
   - `UpdateCheckMode: Tags ^yaran-v\d+\.\d+\.\d+$` (the pattern is extrapolated from the documented syntax), `AutoUpdateMode: Version`, `Binaries: <GitHub APK URL with %v>`, `AllowedAPKSigningKeys: <sha256>`.
   - Update checks **scrape build files without running them**, so `versionCode` and `versionName` must be literals.
   - Builds run daily, so a release appears in "a few days".
   - Sources: https://f-droid.org/docs/Build_Metadata_Reference/ , https://f-droid.org/docs/FAQ_-_App_Developers/
8. **Versioning.**
   - Android `versionCode` must increase monotonically, is capped at 2100000000, and a used code cannot be reused. Proposed: `X*1000000 + Y*1000 + Z`.
   - iOS: `CFBundleShortVersionString` = `X.Y.Z`; `CFBundleVersion` = the same integer or `X.Y.Z.build`.
   - Write both literally in the release PR, so the `yaran-vX.Y.Z` tag points at a commit already holding them.
   - Sources: https://developer.android.com/studio/publish/versioning , https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring
9. **Sideload update check.**
   - The GitHub API allows **60 unauthenticated requests per hour per IP**, so poll `releases/latest` at most daily and cache it. Source: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
   - Keep `REQUEST_INSTALL_PACKAGES` and the installer in the GitHub flavor only. Play forbids self-updating, and F-Droid users update through F-Droid.
   - The Play In-App Updates API is Play-only and proprietary. Source: https://developer.android.com/guide/playcore/in-app-updates
   - **Simpler alternative: a "new version available" notice that links to the release page, plus Obtainium support.** Source: https://github.com/ImranR98/Obtainium

### Pipeline outline

1. **One-time setup.**
   - Generate a 25+ year app-signing key and upload it to Play via PEPK, plus a separate upload key.
   - Create an App Store Connect Team API key and a match repo.
   - Put the secrets in GitHub.
   - Start D-U-N-S and Android developer verification registration.
2. **Release PR.** It bumps the literal versions and adds `fastlane/metadata/android/en-US/changelogs/<code>.txt`.
3. **Android job (ubuntu)** on tag `yaran-v*`. Pin everything, then `npm ci && vite build && cap sync`.
   - `play` flavor: AAB (upload key), sent to the internal track with `supply`.
   - `foss` flavor: APK (app key, apksigner 34, no dependencies-info, deterministic), attached to the GitHub Release.
4. **iOS job (macos-26).** `app_store_connect_api_key`, then `match(readonly)`, `build_app`, `pilot`; later `deliver`.
5. **F-Droid.** Submit the recipe once; after that, releases are picked up automatically.

---

## 8. Accessibility, i18n, background behavior

1. **iOS backgrounding.** iOS suspends apps "briefly" after they leave the foreground. `beginBackgroundTask` gives a finite time, and the common "~30 s" figure is **UNVERIFIED**. WebSockets die, so treat that as normal: reconnect on resume, which yaran's web reconnect logic already does with visible-time clocks. Source: https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask(withname:expirationhandler:)
2. **Android Doze** suspends network access and defers jobs. Play forbids asking for a battery-optimisation exemption when FCM would do. Source: https://developer.android.com/training/monitoring-device-state/doze-standby
   - No Android 14+ foreground-service type fits holding a WebSocket open, so **push is mandatory** for "needs you". Source: https://developer.android.com/develop/background-work/services/fgs/service-types
3. **Cloudflare edge restarts terminate WebSockets**, so use keepalives and reconnect (yaran already does both). Source: https://developers.cloudflare.com/network/websockets/
4. **Local vs push notifications.**
   - Local notifications (`@capacitor/local-notifications`, FOSS-clean) only fire while the app runs, so they are useful only in the foreground.
   - Remote push covers the background.
   - In the foreground, suppress OS notifications for the agent on screen (yaran's existing attention model).
5. **xterm.js `screenReaderMode`** targets NVDA and macOS VoiceOver. TalkBack and iOS VoiceOver are **UNVERIFIED**. `minimumContrastRatio: 4.5` gives WCAG AA. Source: https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
6. **Android `WebSettings.setTextZoom`** defaults to 100. Whether WebView follows the system font scale is **UNVERIFIED**; test it. iOS Dynamic Type via `-apple-system-body` is **UNVERIFIED**. Source: https://developer.android.com/reference/android/webkit/WebSettings
7. **Localization.**
   - Android 13 per-app language: `LocaleManager` and AGP `generateLocaleConfig`. Source: https://developer.android.com/guide/topics/resources/app-languages
   - iOS: localize `CFBundleDisplayName` and every `*UsageDescription` (camera, Face ID). Source: https://developer.apple.com/documentation/bundleresources/managing-your-app-s-information-property-list
   - Push notification text is built on the device by the Notification Service Extension or the Android receiver, so it can be localized there and not by the Worker.

---

## Cross-check notes (where sub-agents disagreed)

- **Bundled vs remote UI.** The security sub-agent recommended bundling the UI to avoid giving a remote origin plugin access. The stack and auth sub-agents recommended loading the remote yaran origin, because the server's same-origin and Host guards and the Access cookie scope assume it.
  - **Resolution: load the remote origin.** It is the user's own trusted server, consistent with yaran's single-tenant trust model, and it already controls a shell. Compensate with an exact-host navigation allowlist and a minimal plugin set.
- **APNs from Workers.** No conflict. It works in production by staff statement, but is undocumented, so the relay is designed to be portable.
- **Capacitor `server.url` "not for production".** Every sub-agent noticed it. The spike in §1 decides between Capacitor and native shells.

## Open items needing hands-on verification

1. The runtime appUrl override in Capacitor 8/9, on both platforms.
2. Injected `CF_Authorization` accepted by Access, including on the WebSocket upgrade. `Cf-Access-Jwt-Assertion` equal to the cookie JWT.
3. Behaviour of an open WebSocket after JWT expiry.
4. Embedded FCM distributor with direct VAPID and no FCM server credentials (Play flavor).
5. Workers to APNs in production (deploy-test).
6. `fdroid build` of an npm, Vite and Capacitor project. zxing-cpp `.so` acceptance, if a native scanner is used.
7. WebView honouring yaran's viewport meta, IME insets on M139+, and text zoom and font scale.
8. Whether the Play org-account exemption from the 12-tester gate holds.

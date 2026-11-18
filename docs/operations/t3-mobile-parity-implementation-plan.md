# T3 mobile parity: implementation plan for G1, G2, G3, G5, G6 (and G4 interface notes)

Planning only. Nothing here is implemented, and nothing here is marked done. It builds on
`t3-mobile-parity-investigation.md` (the gap list) and `mobile-agent-connectivity-validation.md`
(the org open fix, under review). Date: 2026-11-17. Values someone else supplies are written as
`<publisher-domain>`, `<org-control-plane>` and `<machine-host>`.

G4 (no push for the agent on screen) is being implemented by a separate task that owns
`crates/yaran-core/src/cloud/push_*`, the attention code and `mobile/plugins/push`. This plan
does not duplicate it; section 6 only gives the interface that task may need from machine-view.

## 0. What must not change

- The agent experience stays the machine's own web UI in the bridge-less machine WebView: list,
  start, resume, stop, send, stream, terminals, files and the provider's own questions answered
  in the PTY. Nothing in this plan adds a native agent client or a protocol layer.
- Bearer material (Access JWTs, yaran session tokens, passwords) is handled natively only. The
  shell's JavaScript sees non-secret metadata (a host, a label, an instance id) and nothing else.
- No `addJavascriptInterface`, `addWebMessageListener`, document-start script or
  `evaluateJavaScript` into the machine page.
- Each window is pinned to one `https://<host>/` origin on the default port.
- The owner/auth model stays as it is: Cloudflare Access on the cloud hostname, `[server.auth]`
  (one password, `require` classes) everywhere else. Nothing assigns ownership silently.
- No hostnames are invented. The publisher domain comes from build config only.

## 1. Facts from the source that shape the design

| Fact | Where | Consequence |
|---|---|---|
| A browser session idles out after `session_idle_seconds`, default **60 s**, once no socket holds it. | `crates/yaran-core/src/config_auth.rs:82`, `auth/sessions.rs` | Capturing the web login cookie cannot give "sign in once" on a phone. Backgrounding parks the PTY socket, and a minute later the session is gone. |
| The command line's sign-in, `POST /api/v1/auth/cli-login`, issues a `SessionKind::Cli` token that idles after `cli_token_idle_days` (default 30). It uses the same password check, admission, rate limits and Argon2 slot as the web login. | `auth/routes.rs:247`, `config_auth.rs:83` | A native client can get a long-lived session through the **existing** password route. No new exchange endpoint. |
| The session layer does not care how a token travels. `SessionKind` only picks the idle limit. | `auth/sessions.rs:20-21, 62-66` | A Cli token sent as the session cookie should authenticate the page and its sockets. This is inferred from the code. Phase A1 adds a test to prove it before anything relies on it. |
| The session cookie is `yaran_session_<port>`: host-only, `HttpOnly`, `SameSite=Strict`, `Path=/`, with no expiry. | `auth/cookie.rs` | Native must know the port suffix to inject the cookie. The cli-login answer does not carry it today. |
| `GET /api/v1/auth/status` is public and answers `password_set`, `required_here`, `signed_in`, `client_class`, `transport_encrypted` and `instance`. | `auth/routes.rs:49`, `auth/mod.rs:684` | One cheap native probe says whether this is a yaran, whether a password is needed on this route, and which instance it is. |
| `/` and the UI assets are public. A deep link is a fragment, so the main frame is always `/`. | `auth/middleware.rs:33` | A direct machine with a password loads its login page with status 200. A 401 or 403 is never the main-frame answer except for the blocked page. |
| Under the default `require = "network"`, the tailnet needs no password. Through `tailscale serve`, yaran knows the route is HTTPS and marks the cookie `Secure`. | `config_auth.rs:22`, `auth/cookie.rs` | A phone on the tailnet that uses the machine's `tailscale serve` name needs no credential at all. |
| Android: one process-wide `CookieManager`, and Capacitor wipes session cookies when its bridge starts. iOS: one persistent `WKWebsiteDataStore` per host. | `CookieInjector.kt` header, `DataStores.swift` | Android isolates hosts only through host-only cookies. Both platforms must re-inject a session cookie before every load, as they already do for `CF_Authorization`. |
| The app is HTTPS-only: `usesCleartextTraffic="false"`, `MIXED_CONTENT_NEVER_ALLOW`, and the navigation policy blocks `http` to the loaded host. | app `AndroidManifest.xml`, `MachineWebViewFactory.kt`, `NavigationPolicy.kt` | A plain-HTTP machine is out of scope (D-resolved 3). |
| The web UI already wakes on `online`, `focus`, `pageshow` and `visibilitychange`. A 2 s beat with an answer deadline catches half-open sockets. | `web/src/lib/reconnectingSocket.ts:536`, `heartbeat.ts` | G3 needs the WebView to deliver `online`, not a new web code path. |
| Chromium WebView watches connectivity, and so sets `navigator.onLine` and fires `online`/`offline`, only when the app holds `ACCESS_NETWORK_STATE` (inferred from Chromium's registration policy). Neither manifest declares it. | `mobile/android/app/src/main/AndroidManifest.xml`, machine-view manifest | Probably the whole Android G3 fix. Verify on a device. |
| The push presenter already drops a push for `NotificationPresenter.visibleAgent`. The JS `setVisibleAgent` exists, but nothing in the shell calls it, and the shell cannot know the route the machine page shows. | `NotificationPresenter.kt:88`, `PushPlugin.kt:232` | G4's missing piece is a native feed from machine-view (section 6). |
| The web writes the slot tab as bare `#/agent/<sid>`, an extra tab as `/tab/<id>`, and a dock terminal as `/terminal/<id>`. | `web/src/lib/store.ts:3592` | `RouteFragment.isValid` already matches exactly "an agent tab is the main thing on screen". |
| This host has no Xcode, only the Command Line Tools. | `xcode-select -p` | iOS work cannot be built or checked here. iOS phases are gated (section 8). |

## 2. Decisions resolved here (ordinary details)

1. **A direct machine is HTTPS URL metadata plus, where needed, one password sign-in. There is
   no pairing protocol.** The machine already decides who gets in: the tailnet under Tailscale
   ACLs, otherwise the owner's password. A one-time pairing code would only stand in front of
   the password, so it adds a step and no security. The phone persists the record
   `{id, label, host, instance, addedAt}` in the vault through `SecureStore`, the same way
   `orgStore.ts` keeps orgs. None of it is secret.
2. **The phone signs in through the existing `cli-login` route, with the password typed into a
   native sheet.** The resulting token lives only in the vault and is injected natively as the
   `yaran_session_<port>` cookie. This is the "password once" outcome under a stock config, with
   no new auth route, no change to admission, and no ownership granted by anything but the
   password. Decision D1 asks the owner to confirm this over the alternative.
3. **HTTPS only, default port only, hostname only.** `http://`, IP literals (no certificate
   matches them) and non-443 ports are refused at entry with one sentence: "Reach this machine
   over HTTPS, for example with `tailscale serve`." No cleartext exception exists, so nothing in
   the network security config or the WebView settings weakens. Tailnet users get HTTPS from
   `tailscale serve`, which yaran already recognises.
4. **The same host is never both an org machine and a direct machine.** Org sign-out wipes a
   host's whole data store on iOS and the host's cookies on Android, so sharing a host would
   sign the other one out. Adding a direct machine is refused when the host is in any org's
   machine list or has a `session/<host>` vault entry. An Access login redirect seen on a direct
   machine shows: "This machine is behind Cloudflare Access. Add it through its organization."
5. **Direct machines have no push.** Push goes through Cloud Connect (the org Worker). The shell
   says so on the machine's `⋯` menu. T3 also needs its cloud for push.
6. **A route switch never happens under a live page** (G2). A new page load is a new driver id,
   and losing ownership is sticky (CLAUDE.md "Attaching never steals"). So the route is chosen
   at open, at resume after the sockets parked, and when the current route has failed (the
   offline overlay). There is no background re-probe of a healthy page.
7. **Routes are added by the user, and the machine does not advertise them.** That means no
   `serve_legs` advertisement and no new API surface. The machine's instance id groups routes,
   which the status doc allows as a consistency check, and every route still authenticates on
   its own.
8. **A share is file-only, at most 10 files, held in memory.** The shared URIs are not
   persisted. They are forgotten when they are delivered, when the window closes, or on Cancel.
   Text-only shares (no `EXTRA_STREAM`) are refused with a sentence. The size limit is the
   server's own upload limit.
9. **A verified link only opens a machine this phone already has.** It never adds an org or a
   machine. Adding always goes through the Confirm screens (threat T42).
10. **Remove a direct machine:** natively `POST /api/v1/auth/cli-logout` with the token (best
    effort), then delete the vault entry and the host's web data.

## 3. Decisions that need the owner

| ID | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How does a direct machine that needs a password stay signed in? | (a) A native password sheet calls the existing `cli-login`, and the token (30-day idle, revocable with `cli-logout` or a password change) is injected as the session cookie. (b) Use the web login page in the WebView and accept a sign-in after every minute away, or tell owners to raise `session_idle_seconds`. (c) A new `SessionKind::Device` with its own idle setting. That means a schema value, a config key and docs. | **(a).** It reuses the owner password and the existing route, and keeps the password out of JavaScript. The cost: the phone holds a long-lived bearer in the hardware-backed vault, and the web's Sign out ends it. |
| D2 | Does G6 include a producer, meaning a "Copy phone link" item in the web agent menu? | (a) Consumer only: the app opens `https://<publisher-domain>/open#…` links, but nothing in yaran makes them. (b) Also a producer. The machine does not know `<publisher-domain>` (it is the app's build config), so the org Worker would have to hand it over in `MachineConfig`, derived from `APP_CALLBACK_URLS`. That means a protocol field, a Worker change and a web menu item. (c) Drop G6. Push taps already open agents. | **(c) for now, or (a) if the parity checkbox matters.** Without a producer, a link has nowhere to come from. (b) touches three release trains for small gain. |
| D3 | iOS share sheet, if the iOS SDK offers no way to supply a file to the page's `<input type=file>` (open question U1, section 8). | (a) The share extension copies files into the app's Documents folder, exposed in Files as "yaran" (`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`). The user picks them in the page's own chooser. (b) No iOS share target. | **(b)** unless U1 resolves well. (a) exposes shared files in the Files app until they are cleaned up. |
| D4 | iOS network-change wake, if WKWebView does not fire `online` after a network returns (open question U2). | (a) Accept that the web's beat deadline and the foreground wake recover. (b) Call `evaluateJavaScript("dispatchEvent(new Event('online'))")`. This is one-way, but it is script into the machine origin, which the bridge tenet's spirit forbids. | **(a).** |

Nothing else in this plan waits on the owner.

## 4. G1: add a machine directly, without Cloud Connect

### Flow

1. **Entry.** Three ways in, all landing on Confirm machine:
   - Machines → Add → "Machine address": the typed HTTPS URL.
   - A QR scan or link `yaranapp://add-machine?u=https%3A%2F%2F<host>`.
   - The machine's own web UI, "Connect a phone…", when the page is on HTTPS.
2. **Native probe.** `Session.directProbe({host})` calls `GET https://<host>/api/v1/auth/status`
   with no credentials, a 15 s timeout, and the TLS defaults. It answers
   `{yaran: bool, instance, requiredHere, passwordSet, signedIn:false}`, or a failure kind
   (offline, TLS, not yaran, Access in front: a redirect to `*.cloudflareaccess.com`).
3. **Confirm machine** (shell) shows the host as a chip, the instance's short form, and one
   sentence that depends on the answer:
   - not required: "This machine lets this network in without a password."
   - required: "You'll sign in once with the machine's password."
   - required but no password set: "Set a password on the machine first (`yaran config set
     server.auth.password`)." No Add button.
4. **Add.** The shell saves the metadata record. If a password is required, it calls
   `Session.directSignIn({host})`. Native presents the password sheet (`FLAG_SECURE`, autofill
   allowed, a "Sign in to <host>" title), POSTs `cli-login` with
   `{"password": …, "label": "yaran phone (<device label>)"}`, stores
   `{token, cookieName, instance, issuedAt}` under the vault namespace `direct/<host>`, and
   answers `{outcome: 'signed_in' | 'wrong_password' | 'rate_limited' | 'refused', retryAfter?}`.
   The sentences come from the server's refusal bodies, relayed as they are.
5. **Open.** `MachineView.open({kind:'direct', host, route?})`. Before every load and on every
   resume, the window reads `direct/<host>`, injects
   `<cookieName>=<token>; Path=/; Secure; HttpOnly; SameSite=Strict` (host-only, no expiry, so it
   is never written to disk), and loads. With no record and no password required, it simply
   loads.
6. **Expiry or revocation.** On open and on resume, the window runs the status probe with the
   cookie. `required_here && !signed_in` shows the native sheet again, reusing the reauth
   overlay's slot. A 401 or 403 page from the machine is handled the same way instead of the
   org handoff. If the instance changed, the window shows an overlay: "A different yaran answers
   at <host>." It offers Remove machine and Keep. Keep updates the stored instance.

### Files

**Server (Rust) — track A**

- `crates/yaran-web/src/auth/routes.rs`: `cli_login` also answers `"cookie_name": cookie::name(port)`.
  This is an additive JSON field. Confirm that the CLI's parser (`crates/yaran/src/...`, the
  `cli-login` client) ignores unknown fields.
- `crates/yaran-web/src/auth/mod.rs` tests, or a new `auth/cookie_kind_tests.rs`: a Cli-kind token
  presented as the cookie authenticates an HTTP route, the events socket and a PTY socket. It
  idles by the CLI limit, not the browser one. A web `logout` that carries it ends it.
- `crates/yaran-web/src/cloud_phone_routes.rs`, or a sibling `phone_routes.rs`: new
  `GET /api/v1/phone/machine-qr`. It answers `{uri, svg}` for
  `yaranapp://add-machine?u=https://<Host>` only when the request is known to have arrived over
  HTTPS (`transport_encrypted`), and 409 with a sentence otherwise. It uses the shared QR encoder
  (`yaran_core::cloud::qr`).
- `crates/yaran-core/src/cloud/protocol/uri.rs`, `cloud/protocol/src/uri.ts` and the new fixture
  `cloud/protocol/fixtures/uri/add-machine.json`: an `add-machine` kind. `u` must be
  `https://<HOSTNAME_RE>` with no port, path, query or userinfo, and at most 512 characters.
  Both twins read the same fixture.
- `crates/yaran-web/web/src/`: the existing "Connect a phone…" dialog shows the machine QR when
  `/api/v1/phone/machine-qr` answers. Check with `grep -rn phone-qr web/src` for the dialog file.
- `SECURITY.md` and `docs/operations/threat-model.md`: a new appended row, "Phone-held yaran
  session token for a direct machine". Mitigations: vault storage under the app lock, never in
  JavaScript, a host-only session cookie, 30-day idle, ended by a password change or the web's
  Sign out. Status: not implemented yet.
- `website/docs/`: the phone pages get "Add a machine without Cloud Connect", including the
  HTTPS-only rule and `tailscale serve`. This is consumer copy only.

**Android machine-view — track B**

- `MachineState.kt`: add `sealed Target { Org(orgId, machineId), Direct }` and the intent extra
  `K_KIND`. `of()` validates either shape. `MachineViewPlugin.open` accepts `kind`.
- New `DirectSessionStore.kt`: vault namespace `direct/<host>` holding
  `{token, cookie_name, instance, issued_at}`, in the locked class when the app lock is on. It
  has `put/get/delete`. `toString` leaks nothing.
- New `DirectAuth.kt`: `probe(host, token?)`, `signIn(host, password)` and `signOut(host)`
  (cli-logout). Plain `HttpsURLConnection`, the way `OrgApiClient` does it, with a bounded body,
  no redirects followed (a redirect is classified), and the shared UA token.
- `CookieSpec.kt`: `yaranSessionCookie(name, value)`. The name must match
  `^yaran_session_[0-9]{1,5}$` and the value `^[A-Za-z0-9_-]{1,256}$` (the token is URL-safe
  base64). Clearing writes the same name already expired. `CookieInjector.inject` takes the full
  Set-Cookie line. Its poll checks the name it set rather than hard-coding `CF_Authorization`.
- `MachineViewActivity.kt`: branch on `Target` in `start`, `load` and `resumeSession`. Direct
  never constructs `RenewalCoordinator` or `SignInFlow`. Add the password sheet, either a small
  `PasswordSheet.kt` (a native dialog with an `EditText` of type `textPassword`) or a variant of
  `OverlayView`. The text field is cleared and its `CharArray` zeroed after the POST.
- `NavigationPolicy.kt` and `RefusalPolicy.kt`: a `direct` flag. Access paths become a new
  `NavAction.ACCESS_ON_DIRECT` overlay instead of `REAUTH`. A 401 or 403 with no refusal header
  becomes the direct sign-in, not the handoff. Pin both in `fixtures/` (new cases in
  `refusal-cases.json` and the navigation fixture), so the Swift twin reads the same rows.
- `SessionPlugin.kt`: `directProbe`, `directSignIn` and `directSignOut` run on the `machine-view-io`
  executor and reject with `native_error` on an unexpected exception, matching the validation
  ledger's fix.
- `Messages.kt` (and the shared messages fixture if there is one): the new sentences.

**Shell (TypeScript) — track C**

- `mobile/plugins/machine-view/src/definitions.ts`: `OpenOptions` becomes a union with
  `{kind:'direct'; host; route?}`, and the three direct calls are added to `SessionPlugin`. Also
  update `src/web.ts`, the refusing stub.
- New `mobile/app/src/lib/directMachinesStore.ts`, modelled on `orgStore.ts`: `SecureStore`
  namespace `direct` / key `list`. It provides `loadDirect`, `addDirect`, `removeDirect` and
  `findDirect`, plus a guard against hosts that belong to an org.
- `lib/openMachine.ts`: a new `openDirect(id, route?)` that returns the same result union.
- `lib/deepLinks.ts` and `lib/route.ts`: an `add-machine` case and a
  `{name:'confirm-machine', url}` route.
- New `screens/onboarding/ConfirmMachine.tsx`. `EnterUrl.tsx` accepts a machine URL beside an org
  URL: it tries the org `/v1/meta` first and the machine status second, or offers an explicit
  "Machine" toggle, whichever reads better in the existing screen. `ScanQr.tsx` already routes
  through `parseAppUri`.
- `screens/machines/MachineList.tsx` and `MachineRow.tsx`: a "Direct" section after the org
  sections. Its row `⋯` holds Open, Sign in again… and Remove…
  (`RemoveMachineDialog.tsx`, destructive, so it confirms).
- `lib/orgStore.ts` `eraseEverything`: also sign out of the direct machines (best effort) before
  `SecureStore.eraseAll()`.
- `locales/en/messages.po`: run `lingui extract`.

**Android app — track E**

- `mobile/android/app/src/main/AndroidManifest.xml`: a `yaranapp://add-machine` VIEW filter on
  MainActivity, beside `add-org`.

### Tests

- Rust: the cookie-kind test, the cli-login `cookie_name` test, the machine-qr route (HTTPS
  answers, plain HTTP gets 409), and the uri fixture (Rust and TS read the same file).
- Kotlin (Robolectric, `:yaran-machine-view:testDebugUnitTest`): a `Direct` intent validates; an
  `http://`, port or IP host is refused; the direct window never starts the handoff; the cookie
  line is exact; a 401 shows the password sheet; an Access redirect shows its overlay; the vault
  record round-trips and its `toString` leaks nothing; and `DirectAuth` maps 200/401/429/503
  from a `MockWebServer` (if it is already a test dependency, otherwise the fake-connection
  pattern in `Fakes.kt`).
- Vitest: `directMachinesStore` (a corrupt record is dropped loudly, an org host collision is
  refused); `deepLinks` `add-machine` is accepted and refused per the fixture; ConfirmMachine
  shows each of the three sentences; Remove calls `directSignOut` then deletes the record.
- Device (parent's phone, isolated `-PappIdOverride` build): add the tailnet `tailscale serve`
  name (no password), open it, list agents, send, stream; add a password-protected HTTPS host,
  sign in once, then confirm it opens with no sheet after a force-stop and relaunch.

## 5. G2: several routes to one machine

Built on G1. A route is either an org machine (`{kind:'org', orgId, machineId, host}`) or a
direct host (`{kind:'direct', host}`).

- **Model.** A direct machine record gains `routes: Route[]`, ordered by the user, where the
  first route is the record's own host. The user adds one with "Add another way to reach it…",
  which offers the org machines and a typed HTTPS URL. A route is accepted only if its status
  probe returns the same `instance`. For an org route, that probe goes through native with that
  host's injected `CF_Authorization`. The instance groups routes. It never authorizes anything:
  each route signs in on its own (Access for org, password or tailnet for direct).
- **Choice.** Native `RouteSelector.kt` (Swift twin `RouteSelector.swift`) probes routes in
  order, three at a time. The timeout is 3 s for a `*.ts.net` host and 8 s otherwise. It opens
  the first route that answers with the expected instance. It runs at open, at resume when the
  page has been hidden longer than the PTY socket's park, and from the offline overlay's new
  "Try another route" action. It never runs under a live, healthy page (decision 6).
- **Native shape.** `MachineView.open` takes `routes: Route[]` (at most 4) instead of a single
  target. The activity keeps a chosen-route index in `MachineState`, and the saved state keeps
  the chosen route. The window's pinned host is the chosen route's host. Switching routes
  destroys and recreates the WebView, through the same path as renderer recovery, so pinning
  stays a single host per WebView.
- **What the user sees.** The banner shows the route in use ("via tailnet" or "via Cloud
  Connect") as a chip. The page's address, drafts and the browser id are per origin, so another
  route is another browser to the machine. That is honest, and the docs say it.
- **Files.** Android `RouteSelector.kt`, `MachineState.kt`, `MachineViewActivity.kt`
  (`onLoadFailed`/offline overlay action) and `OverlayView.kt`; shell `directMachinesStore.ts`
  (`routes`), a new `screens/machines/MachineRoutes.tsx` (list, reorder by buttons, add, remove)
  and `openMachine.ts`; definitions `OpenOptions.routes`.
- **Tests.** A pure Kotlin `RouteSelector` test (order, instance mismatch skipped, all fail
  leads to offline, never switches when `live = true`); Vitest for reordering and the
  instance-mismatch refusal; a device check with Wi-Fi off and the tailnet route down, which
  should fall back to the Cloud Connect route.

## 6. G3 and G4

### G3: network-change wake

- **Android.** Add `<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>`
  to `mobile/plugins/machine-view/android/src/main/AndroidManifest.xml`. It is a normal
  permission with no prompt, it is fine for F-Droid, and it should be listed in the Play
  data-safety notes if those enumerate permissions. Update `ManifestTest.kt` and the
  `BuildOutputsTest` merged-manifest assertions if they pin the permission set.
  - **Device check:** in the machine window, airplane mode on then off should fire `online`, and
    a parked or given-up socket should reconnect at once. The parent can see it in the web's
    reconnect UI. No page inspection is needed.
  - **Only if the check fails:** in `MachineViewActivity`, a
    `ConnectivityManager.registerDefaultNetworkCallback` (registered in `onStart`, unregistered
    in `onStop`) calls `web?.setNetworkAvailable(false)` on `onLost` and `true` on `onAvailable`.
    That is the public WebView API that drives the same events. A seamless Wi-Fi to cellular
    handoff fires neither event, and the existing 2 s beat deadline recovers that case.
- **iOS.** No code. WebKit fires `online`/`offline` itself. Device check U2; D4 if it fails.
- **Web.** No change.

### G4 interface notes (implemented by the parallel task)

- The server already suppresses: an owner's visible pane sends `viewed` every 2 s
  (`VIEWED_PING_INTERVAL_MS`), inside the 3 s `ATTENTION_ENGAGED_WINDOW`, so a tab on screen
  never raises an edge. The native check only covers the race (a push already in flight) and a
  watcher.
- What the push side lacks is the feed. The shell cannot see the machine page's address, so the
  JS `setVisibleAgent` cannot be called correctly by anyone. Proposed seam, if that task wants
  it. Machine-view owns the publishing, so it needs this plan's track B or a small change agreed
  with that task:
  - machine-view: `public object MachineViewSignals { @Volatile var onVisibleRoute: ((orgId:
    String, machineId: String, agentId: String, tabId: String?) -> Unit)?; var onHidden: (() ->
    Unit)? }`. `MachineViewActivity.onHistoryChanged` publishes when the URL is on the pinned
    host and its fragment passes `RouteFragment.isValid` (bare `#/agent/<sid>` means
    `tabId = null`, which matches the push's slot-tab `tab_id = None`). Any other fragment
    (`/terminal/`, `/editor`, no agent) publishes hidden. `onResume` republishes the current
    URL, and `onPause`/`onDestroy` publish hidden. A new pure
    `RouteFragment.parse(route): Pair<String, String?>?` percent-decodes the segments.
  - app module (`YaranApplication`): wires `MachineViewSignals` to
    `NotificationPresenter.visibleAgent`, so neither library depends on the other.
  - Direct machines publish nothing, because they have no push.
  - iOS twin: `NavigationDelegate.didCommit` plus URL KVO in `MachineViewController`, and a
    static on the push side in place of the `PushPlugin.visible` instance variable.
  - With the native feed in place, the JS `setVisibleAgent` becomes dead API. Removing it from
    `plugins/push/src/definitions.ts`, `web.ts`, both natives and `pushTestKit.ts` belongs to
    the G4 task.

## 7. G5: share files into an agent (Android)

Goal: another app's share sheet, then yaran, then a machine the user picks, then the web's own
"Attach a file…" in the agent the user opens. The web then does the upload, the ownership
recheck, the typing-target binding and the one toast, exactly as it does for a picked file.

1. `mobile/android/app/src/main/AndroidManifest.xml`: MainActivity gets intent filters for
   `ACTION_SEND` and `ACTION_SEND_MULTIPLE`, `mimeType="*/*"`, category `DEFAULT`.
2. New `mobile/android/app/src/main/java/.../ShareIntake.kt`, called from
   `MainActivity.onCreate`/`onNewIntent`. It reads `EXTRA_STREAM` (single or list), keeps
   `content://` only, and caps at 10. It never opens a stream. It keeps the `Uri`s in a
   process-scoped holder and tells the shell, through a Capacitor event on an existing
   first-party plugin (MachineView: `shareReceived {count}`, never the URIs), to show the Share
   screen. A share with no stream gets the sentence "Share a file to yaran; text isn't
   supported yet." Under the app lock, the holder waits until unlock.
3. New shell screen `mobile/app/src/screens/share/ShareTarget.tsx`: "Send N files to…" lists the
   org and direct machines. Picking one calls `MachineView.open({…, share: true})`. Cancel calls
   `MachineView.discardShare()`.
4. `MachineViewPlugin.open` with `share: true` moves the held URIs into the activity intent as
   `ClipData` with `FLAG_GRANT_READ_URI_PERMISSION`. That re-grants read access to
   `MachineViewActivity`'s own permission owner, so the grant outlives MainActivity being
   recreated. The activity holds `pendingShare: List<Uri>` (not saved to a Bundle, so process
   death drops it, which is acceptable) and shows a banner: "N files ready. Open an agent and
   choose Attach a file." It has a Discard action.
5. `MachineChromeClient.onShowFileChooser`: when `pendingShare` is not empty, a native two-button
   sheet first asks "Attach the N shared files here?" with **Attach shared files** and **Choose
   other files**. Attach delivers the URIs through the same `once` callback:
   `contentOnly(uris)`, trimmed to one when `params.mode != MODE_OPEN_MULTIPLE` (and the sheet
   then says only the first is attached), then clears `pendingShare` and the banner. Choose other
   falls through to today's picker. The chooser only exists where the web offers "Attach a
   file…", so a non-owner never reaches it: the web shows that row only while this device drives
   the pane. Nothing is uploaded natively, and no path or credential goes into the page.
6. `MachineChromeClient` takes a `pendingShare` provider and a confirm callback through its
   constructor, so the class stays testable without an activity.

**Tests:** Robolectric. A SEND with two `content://` URIs and one `file://` keeps two. The
chooser with a pending share and Attach delivers exactly those URIs once and clears them. Choose
other launches the picker. Single mode trims to one. Close discards. The grant flag is present on
the forwarded intent. Vitest: ShareTarget lists both kinds and Cancel discards. Device: share two
photos from Files into an agent the phone drives. The web toast should name where the paths
landed. As a watcher, there should be no Attach row.

### iOS equivalent and build requirements

- Shared files can only reach yaran through a **Share Extension** target, or through document
  types ("Open in yaran", one file at a time, delivered to `scene(_:openURLContexts:)`). A share
  extension cannot open its host app through any supported API, so it copies the files into the
  existing app group container (`group.$(APP_ID)`, already in both entitlements) and tells the
  user to open yaran.
- Delivering them into the page needs a way to answer WKWebView's `<input type=file>` with
  chosen files. On macOS that is `WKUIDelegate runOpenPanelWith…`. **U1:** whether the iOS SDK
  shipped with the current Xcode exposes it for iOS. This host has no Xcode, so it could not be
  checked. If it exists, mirror the Android flow in `UIDelegate.swift`. If not, see D3.
- Build requirements: Xcode (not installed here), a new `ShareExtension` target with an
  `NSExtension` plist (`NSExtensionActivationRule` for files, max 10), the app-group entitlement,
  a provisioning profile for the extension's bundle id (Phase 18 profiles), and the extension's
  memory limit (stream-copy, never load whole files).

## 8. G6: verified links to an agent

Only after D2 says to build it.

- **Link shape:** `https://<publisher-domain>/open#o=<OrgUrl>&m=<machineId>&r=<route>`, or
  `#d=<host>&r=<route>` for a direct machine. The fragment keeps ids out of publisher logs. `r` is
  optional and passes `isAgentRoute`.
- **Protocol:** `cloud/protocol/src/uri.ts` gets `parseOpenLink(url)` and a fixture
  `fixtures/uri/open-link.json`. The Rust twin is needed only if D2(b) has the machine or Worker
  build these links.
- **Android:** a new `activity-alias` `.OpenLinkHttps` → MainActivity in the app manifest, with
  `autoVerify`, `https`, `${publisherDomain}` and `pathPrefix="/open"`. It is enabled by the same
  placeholder logic as `AuthCallbackHttps` (`publisherCallbackEnabled`), so a dev build has no
  https filter. The shell's `deepLinks.ts` routes it to `openMachine`/`openDirect` only for a
  machine already known. An unknown one gets the toast "That link is for a machine this phone
  hasn't added."
- **iOS:** the `com.apple.developer.associated-domains` entitlement `applinks:<publisher-domain>`
  from build config (`Publisher.xcconfig`), and `scene(_:continue:)` in `SceneDelegate.swift`
  forwarding to the same shell handler.
- **Publisher infrastructure (outside this repo, plan 21):** `/.well-known/assetlinks.json` must
  list the app id and signing digest, and `apple-app-site-association` must list `/open`. The
  validation ledger already notes that the release build needs Digital Asset Links.
- **Tests:** link fixture rows (valid, a bad route, an unknown machine, an http scheme, an extra
  parameter); a `BuildOutputsTest` row that the alias is enabled only when a publisher domain is
  set; Vitest for deepLinks routing.

## 9. Ownership split and phases

Each track can be one Opus implementer. A track does not edit another track's files. The shared
contract files (`plugins/machine-view/src/definitions.ts`, `cloud/protocol/src/uri.ts`) are
written first, in phase 0, by track C, and then only read.

| Phase | Track | Content | Gate to start |
|---|---|---|---|
| 0 | C | Contract only: `definitions.ts` unions and new calls, the `uri.ts` `add-machine` kind and its fixture, and stubs in `web.ts`. | Current Sol review of the validation fix done. |
| A1 | A (Rust) | The cookie-kind test (if it fails, stop: D1(a) is invalid, so report and pick (c)), the cli-login `cookie_name`, the uri.rs twin, machine-qr route, the web dialog, the threat row, the docs. | Phase 0. |
| B1 | B (Android machine-view) | G1 native: `Target`, `DirectSessionStore`, `DirectAuth`, `CookieSpec`, policy flags, password sheet, plugin calls. G3 permission. | Phase 0. Can run beside A1 against the documented contract. |
| C1 | C (shell) | G1 shell: store, ConfirmMachine, EnterUrl, deep link, list section, remove, erase. | Phase 0. |
| E1 | E (app manifests) | The `add-machine` filter, the share filters, and `ShareIntake.kt` in the app module. | B1 merged. |
| B2 + C2 | B, C | G5 Android: chooser delivery, banner, grant forwarding, ShareTarget screen. | E1. |
| B3 + C3 | B, C | G2: RouteSelector, the routes UI. | G1 proven on a device. |
| D1 | iOS | Twins of B1/B2/B3, plus G3 check U2 and share check U1. | Xcode available; D3 and D4 answered if U1/U2 go badly. |
| F | B, C, E, iOS | G6. | D2 answered; publisher assetlinks/AASA in place. |
| — | G4 task | As owned by that task, with section 6 as the interface. | Independent. |

Every phase ends with its own gates: `cargo fmt`, `cargo clippy --all-targets --all-features --
-D warnings` and `cargo test` for track A; `mobile/app` runs `tsc --noEmit`, `eslint`,
`vitest run` and `lingui extract`; `mobile/android` (JDK 21) runs `assembleFossDebug`,
`testFossDebugUnitTest`, `:yaran-machine-view:testDebugUnitTest`, `ktlintCheck` and `detekt`;
and every phase runs `node tools/module-headers/bin/module-headers.mjs --check` and
`--lines --check`. Android gates on this machine need
`ANDROID_HOME=/Users/siavash/Library/Android/sdk` and
`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`.

Device checks run on the parent's isolated `-PappIdOverride` build
(`<app-id>.connectivitytest`, installed beside `<app-id>` without uninstalling or
wiping it, because the original refuses an update with a mismatched signature). Status as of
writing: that build reached the org's SSO page. Machine consent, the cookie, the first load of
the machine UI and the agent list have **not** been observed, so none of this plan's device
checks may assume them.

## 10. Open questions and risks

- **U1** (iOS file input from native), **U2** (WKWebView `online`), and the Android
  `ACCESS_NETWORK_STATE` effect are unverified. Each one has a device or SDK check named above.
- The Cli-token-as-cookie path (D1a) is inferred from `sessions.rs`. Phase A1's test is its proof
  and its gate.
- A direct machine behind a user's own reverse proxy needs `allowed_hosts` and, so that the
  cookie is `Secure`, `cookie_secure = "always"`. The injected cookie is `Secure` either way;
  the docs page says so.
- Another route is another browser to the machine (separate drafts, browser id and ownership).
  Accepted and documented, never hidden.
- Not planned: learned routes, a native agent client, structured approvals, an offline cache,
  any agent text in push. The investigation's "Not recommended" list stands.

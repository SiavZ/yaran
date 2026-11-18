# T3 Code Android app: parity investigation for the Yaran phone app

Research only. No product code was changed. This report inventories what the
official T3 Code Android app does between the phone and a machine, separates what
was observed in the shipped APK from what was read in matching source and from
what is inferred, and maps every behavior onto Yaran's existing phone
architecture and its locked mobile tenets (`CLAUDE.md`, "Mobile apps" and
"Cloud Connect").

Date of investigation: 2026-11-17.

## 1. Artifact identity

The latest stable desktop release, `v0.1.10` (published 2026-11-17), ships
`.dmg`, `.exe`, `.deb`, `.AppImage`, `.zip` and `.tar.gz` assets and **no APK**.
The official Android builds are separate pre-releases in the same repository
under `android-beta-*` tags. Three exist: `android-beta-93` (2.0.0),
`android-beta-735` (2.2.0) and `android-beta-784` (2.3.0, newest). The newest was
analyzed.

| Field | Value |
|---|---|
| Release | `android-beta-784`, "Android beta 2.3.0 (784)", published 2026-11-10T05:26:16Z, pre-release |
| Release note | "T3 Code for Android beta, mirrored from Google Play closed testing." |
| Asset | `t3code-android-beta-2.3.0-784.apk`, 142,923,883 bytes |
| APK SHA-256 | `f5060a87457eed6d3700f5018a1f0546da5027554ca2fd20b0ca87caca983abe` (matches the digest GitHub publishes for the asset) |
| Package / version | `com.t3tools.t3code`, versionName `2.3.0`, versionCode `784`, minSdk 24, targetSdk 36 |
| Play stamp | `com.android.stamp.source=https://play.google.com/store`, `STAMP_TYPE_STANDALONE_APK` (a Play-generated universal APK) |
| Tag commit | `6c9adfb2739205244b84e607736f6fd8b4611e69` (2026-11-09) |
| JS bundle | `assets/index.android.bundle`, 20,771,112 bytes, SHA-256 `a73f1af0784172ac7b6ab5b6e13ed97bb55413c46ffb5972bbfd716a6f81445f`, Hermes bytecode (magic `c61fbc03c103191f`, header version field 99) |
| `assets/app.config` | SHA-256 `ac484ea097fe61a0981a3508b28e79b9afe7b788b8750836bacbe8e52639b90b` |
| `assets/app.manifest` | SHA-256 `8a50d083daf992449671e5f1ce78409af02f28d5b0b5309ff27ae188fda19dd9` |
| Expo fingerprint | `779720fb751d32f63e7ecb099fb6f058dd97b1f7` |

Source used for corroboration: `pingdotgg/t3code` at the tag commit above,
`apps/mobile` plus `packages/client-runtime`, `packages/shared` and
`packages/contracts`. `apps/mobile/app.config.ts` defaults the version to
`2.3.0`, matching the APK.

### REA Evidence

| Evidence ID | Operation | What it establishes |
|---|---|---|
| `ev_dd51ee72564bf22d105ef522ed6adeac12beabbd67ce9d7d0876cc09cbfa3197` | `inspect_artifact` (complete, retained) | Archive graph: 3,611 entries, 0 integrity contradictions, source complete |
| `ev_72bedb48e35bc52644942d2841d4e251aaf6684deee2426347c8fa72348d6397` | `inspect_analysis_view` summary of the above | Coverage 10,625/10,625 examined |
| `ev_23a46afac700802bc17030328f991b61caa00bafdfeb6975153c08e66511ec6b` | inventory Evidence | Central-directory inventory |
| `ev_fc6ec927795c3dd16a0fdbe0df26700aa7655e71f383712e0970134f0824d1b4` | inventory occurrences | `AndroidManifest.xml`, `assets/app.config`, `assets/index.android.bundle` (stored, uncompressed), `classes.dex`, `lib/arm64-v8a/libt3terminal.so` (ELF), each `hash_status: verified` |
| `ev_4b5c6ef13eecefad866747d685f99d00734e34403576428b6e06fa692299f99e` | `decode_android_resources` (Apktool 3.0.3) | Decoded manifest: permissions, components, intent filters, version facts |

Evidence collected outside REA (stated as such, not REA Evidence):

- `strings` over the Hermes bundle (68,188 strings) and `grep` for the protocol
  literals listed in section 3. Every literal checked was present (count shown
  in section 3).
- Byte search of `classes*.dex` for class descriptors:
  `expo/modules/t3agentnotifications/AgentMessagingService`,
  `expo/modules/t3terminal/T3TerminalView`, `.../GhosttyBridge`,
  `com/clerk/api/sso/SSOReceiverActivity` all present.
- `strings` over `libt3terminal.so`: exports `Java_expo_modules_t3terminal_GhosttyBridge_nativeCreate`
  and calls `ghostty_terminal_new`, `ghostty_render_state_*`.
- `assets/app.config` was read as JSON with key-like fields redacted.

## 2. Method, tool coverage and blockers

1. **REA Java decompilation was unavailable.** `inspect_android_package`
   returned `capability_unavailable`: the REA server needs `REA_JADX_MCP_JAR`
   pointing at a jadx-headless-mcp 0.7.1 JAR, and none is configured. The JADX
   CLI and Java 21 are installed, but the REA MCP server's environment cannot be
   changed from inside this session. So `search_android_classes`,
   `inspect_android_class`, `inspect_android_method` and
   `trace_android_references` were **not run**. Fixing this is a scoped
   configuration change for the owner (supply the JAR, set the variable, restart
   the REA server). It is not needed for the conclusions below, because the app's
   logic is in JavaScript, not in Java.
2. **The app logic is Hermes bytecode, not JavaScript.** REA has no Hermes
   decompiler. `analyze_javascript_application` does not apply. The string table
   was used to confirm that the protocol surface read in source ships in this
   build. Control flow was taken from source, never from the bytecode.
3. **Over-the-air updates mean the running JS can differ from the APK.** The
   manifest enables `expo.modules.updates` with `EXPO_UPDATES_CHECK_ON_LAUNCH=ALWAYS`
   and an `u.expo.dev` update URL on the `production` channel. A device can
   therefore run a newer JS bundle than the one analyzed. This is an unknown that
   static analysis cannot close.
4. **No runtime observation.** The phone was not driven (another task owns device
   validation). Nothing here claims observed execution.
5. `codebase-memory-mcp` failed to connect in this session, so Yaran was read with
   ordinary file tools.

Confidence labels used below:

- **O (observed):** present in the shipped APK (REA Evidence, or the non-REA
  byte checks listed above).
- **S (source):** read in the official source at the tag commit; the literal it
  depends on is confirmed in the bundle where noted.
- **I (inferred):** reasoning from O and S, not directly read.
- **U (unknown).**

## 3. Shipped architecture in one paragraph

T3 Code for Android is an Expo / React Native app (Hermes, `libreactnative.so`,
`libexpo-*.so`) that is a **native client of the machine's RPC**, not a
WebView of a machine-served UI. JavaScript holds the session tokens, opens an
authenticated WebSocket to `/ws` on each "environment" (T3's word for a machine),
and renders threads, approvals, diffs and pull requests with React Native
components. Terminals are drawn by a bundled native terminal emulator
(`libt3terminal.so` wrapping libghostty-vt) fed over the same RPC. Sign-in to the
optional cloud ("T3 Connect") uses Clerk; push comes from Firebase Cloud Messaging
data messages rendered by a native service. [O: manifest, native libs,
`app.config`; S: `apps/mobile/src`]

Protocol literals confirmed in the bundle string table (count of strings
containing each): `/oauth/token` 1, `/api/auth/session` 1,
`/api/auth/websocket-ticket` 1, `wsTicket` 1, `connectionMethod` 1,
`clientSurface` 1, `pairingUrl` 1, `t3code://pair` 1, `/v1/environments` 1,
`/v1/client/dpop-token` 1, `/v1/mobile/devices` 1, `/v1/mobile/agent-activity` 1,
`environment:connect` 1, `mobile:registration` 1, `t3-mobile` 1,
`urn:ietf:params:oauth:grant-type:token-exchange` 1,
`orchestration.dispatchCommand` 1, `orchestration.subscribeThread` 1,
`runtime-request.respond` 1, `thread.stop` 1, `run.interrupt` 1, `terminal.open` 1,
`terminal.attach` 1, `terminal.write` 1, `terminal.resize` 1,
`attachments.createUploadUrl` 1, `projects.readFile` 1, `projects.writeFile` 1,
`server.reportClientActivity` 1, `acceptForSession` 1,
`t3code.connection-catalog.v1` 1, `t3code.cloud.relay-access-tokens` 1,
`application-active-long` 1, `network-changed` 1, `cloudflare_tunnel` 1,
`t3_relay` 1, `Scanned QR code did not contain a pairing URL.` 1,
`Pairing URL is missing its token.` 1, `alert_path` 1, `DPoP` 13.

## 4. Behavior inventory

### 4.1 Pairing and adding a machine

- **QR scan with the camera** (`CAMERA` permission, ML Kit barcode models in
  `assets/mlkit_barcode_models/`, `libbarhopper_v3.so`; camera prompt text "scan
  pairing QR codes"). [O]
- **Accepted payloads** (`apps/mobile/src/features/connection/pairing.ts`,
  `packages/shared/src/remote.ts`): [S, literals O]
  - `t3code://pair?pairingUrl=<url>` (any `t3code-*` channel scheme); the app
    unwraps the inner URL. The desktop app shows this link as a QR.
  - A direct pairing URL: `<http|https|ws|wss>://host[:port]/#token=<one-time
    token>` (the query `?token=` is also read). The token rides in the fragment
    so it never reaches server logs.
  - A hosted pairing URL with `?host=<machine>&label=<name>` plus the token.
  - Manual entry: host plus pairing code. A bare IP literal defaults to `http`,
    a hostname to `https`.
- **Exchange:** the one-time pairing credential is posted to the machine's
  `POST /oauth/token` as an OAuth token exchange
  (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, subject token
  = pairing credential, optional DPoP proof header, client label, device type
  and OS). The answer is a bearer (or DPoP-bound) access token.
  (`packages/client-runtime/src/authorization/remote.ts`) [S, literals O]
- **Cloud-linked machines:** with T3 Connect (Clerk sign-in), the cloud relay
  lists the account's machines (`GET /v1/environments`) and links new ones by a
  challenge (`/v1/client/environment-link-challenges`,
  `/v1/client/environment-links`). [S, literals O]
- **No cloud is required.** A machine can be paired directly over LAN, tailnet or
  a public HTTPS hostname with only the pairing token. [S]

### 4.2 Transport and routing

- **One socket per machine:** WebSocket to `<wsBase>/ws?wsTicket=<ticket>` plus
  client metadata query parameters (`clientSurface`, `clientAppVersion`,
  `clientDeviceType`, `clientOs`, `connectionMethod`, hashed `clientOwner` /
  `clientDevice`). The ticket comes from
  `POST /api/auth/websocket-ticket/rpc` with `Authorization: Bearer` or
  `Authorization: DPoP` plus a proof; with DPoP the upgrade proof rides in a
  `dpop` query parameter. A 404 on the `/rpc` path falls back to the bare path
  for older servers. [S, literals O]
- **Several routes per machine, ordered and user-reorderable.** Route kinds:
  `relay`, `loopback`, `lan`, `tailnet`, `vpn`, `public`, `ssh`
  (`connection/routes.ts`). [S]
- **Learned routes:** the machine reports its advertised endpoints; the client
  adds them as extra routes, drops loopback, refuses plain `http` from an HTTPS
  context, marks tailnet origins, and **never sends a token paired over HTTPS,
  loopback or the tailnet to a plain-HTTP address outside the tailnet**
  (`sendsTokenInClear`, `usableRoutes`). [S]
- **Better-route switching:** every 60 s the supervisor probes routes ranked
  above the active one; a route that answers is switched to; a silent route backs
  off from 120 s doubling up to 30 min; a route that answered then failed to
  connect cools down 5 min. [S]
- **Relay "connect":** for a cloud-linked machine the client exchanges its Clerk
  token for a DPoP-bound relay access token (`POST /v1/client/dpop-token`, scopes
  `environment:connect`, `environment:status`, `mobile:registration`, client id
  `t3-mobile`), then `POST /v1/environments/:id/connect` mints a short-lived
  credential **bound to the phone's DPoP key thumbprint**. The machine's endpoint
  carries a provider kind `manual`, `cloudflare_tunnel` or `t3_relay`.
  [S, literals O]
- [I] For `cloudflare_tunnel` and `manual` the phone talks to the machine's
  endpoint directly; the cloud relay brokers credentials, not traffic. [U]
  Whether `t3_relay` endpoints carry traffic through T3's servers was not
  determined.

### 4.3 Authentication and session renewal

- **Credential types:** bearer access token for a direct pairing; DPoP-bound
  access token for cloud-linked machines and the relay; a per-connection
  WebSocket ticket. [S]
- **Where they live:** the connection catalog (routes, profiles and paired
  credentials) is one JSON document under `t3code.connection-catalog.v1` in
  Expo SecureStore; relay access tokens are cached under
  `t3code.cloud.relay-access-tokens`; the DPoP private key is a **JWK string**
  in SecureStore, generated by Expo crypto, read back into JavaScript to sign
  proofs (`apps/mobile/src/features/cloud/dpop.ts`). [S, the two storage keys O]
- [I] Every credential, including the DPoP private key, is readable by
  JavaScript. SecureStore encrypts at rest with a Keystore key, but the secret
  itself is handed to JS. This is the pattern Yaran forbids.
- **Renewal:** an expired session is re-established by exchanging the stored
  credential again; WebSocket tickets are re-issued per connection;
  `credentials-changed` is a supervisor wakeup. [S] Exact access-token lifetime
  on a direct pairing: [U].
- `allowBackup="true"` with `secure_store_backup_rules` and
  `secure_store_data_extraction_rules` excludes SecureStore from backup [O
  manifest attributes; rule contents U].

### 4.4 Machine discovery and persistence

- Machines are the union of directly paired entries and the cloud account's
  linked environments (`RelayEnvironmentDiscovery`, `/v1/environments`, status
  via `environment:status`). [S]
- Persisted: the catalog in SecureStore; per-machine shell, thread and pull
  request caches in SQLite (`expo-sqlite`, `connection/environment-cache-store.ts`,
  `pull-request-cache-store.ts`) so the app opens with data before reconnecting.
  [S, `libexpo-sqlite.so` O]
- Machines can be disabled without being removed (`disabledEnvironmentIds`). [S]

### 4.5 Connection, reconnect and background lifecycle

Constants from `packages/client-runtime/src/connection/supervisor.ts` [S]:

| Behavior | Value |
|---|---|
| Retry delay | jittered `[c/2, c]` with `c = min(300 s, 1 s · 2^(n+1))` |
| Backoff reset | after 30 s connected, and on foreground or network change |
| Connect timeout | 15 s; probe 15 s; quick probe 3 s on `loopback`/`lan` |
| Silent socket | checked after 500 ms, every 1 s; remote socket called silent after 2.5 s |
| Long resume | 1.5 s probe when the app returns after a long background |
| Session loss retry | 250 ms |

- **Wakeups:** `application-active`, `application-active-probe`,
  `application-active-long`, `credentials-changed`, `network-changed`; the
  first three also resubscribe streams. [S, two literals O]
- **Activity lease:** every 25 s (and on app-state change) the app calls
  `server.reportClientActivity` per machine with `visible`, `focused`,
  `appState`, retained "background scopes" and a 45 s TTL
  (`connection/background-activity.ts`). [S, literal O] [I] The server uses the
  lease to decide when a phone is looking, which lets it hold back pushes for a
  thread already on screen and keep selected subscriptions alive briefly.
- **No foreground service holds the socket.** The manifest declares no
  app-owned foreground service (only WorkManager's `SystemForegroundService`).
  [O] [I] In the background the socket dies with the process; push is the only
  background channel.

### 4.6 Agents ("threads"): list, start, resume, stop, send, stream

All over the one RPC socket (`packages/contracts/src/rpc.ts`,
`orchestrationDispatch.ts`, `orchestrationV2.ts`) [S, listed literals O]:

- **List / stream:** `orchestration.subscribeShell` (thread list),
  `orchestration.subscribeThread` (one thread's live projection),
  `getThreadProjection`, `getTurnItem`, `getTurnDiff`, `searchThreads`.
- **Start:** `orchestration.launchThread`, `thread.create`; message send is a
  `message.dispatch` command through `orchestration.dispatchCommand`; queued
  runs (`queued-run.*`, `queued-message.promote-to-steer`).
- **Resume:** `queue.resume`, `provider-session.*`, `thread.fork`.
- **Stop:** `run.interrupt`, `thread.stop`, `thread.interrupt.unresponsive`,
  `orchestration.forceStopThread`.
- Also: model and runtime-mode selection, archive/pin/snooze, checkpoints and
  rollback, pull-request linking.

### 4.7 Approvals and questions

- Providers raise "runtime requests" (tool approval, user input, secrets, links);
  the phone answers with `runtime-request.respond` carrying a
  `ProviderApprovalDecision` of `accept`, `acceptForSession`, `acceptAlways`,
  `decline` or `cancel`, with per-option labels and warnings; questions can be
  dismissed (`thread.user-input.dismiss`); secret requests use
  `secrets.answerRequest`. [S, `runtime-request.respond` and `acceptForSession`
  O]
- This depends on a structured agent protocol (ACP / Codex app-server
  adapters in `packages/provider-*`). [S]

### 4.8 Terminal

- `terminal.open`, `terminal.attach`, `terminal.observe`, `terminal.write`,
  `terminal.resize`, `terminal.clear`, `terminal.close`,
  `subscribeTerminalMetadata`. [S, four literals O]
- Rendering is native: `T3TerminalView` / `TerminalCanvasView` with a custom
  `TerminalInputConnection`, driving libghostty-vt through JNI
  (`GhosttyBridge.nativeCreate`). [O classes and exports; S Kotlin sources]

### 4.9 Files and attachments

- File browsing, reading and writing: `projects.listEntries`,
  `projects.readFile`, `projects.writeFile`, `projects.search*`,
  `filesystem.browse`. [S, two literals O]
- Attachments: `attachments.createUploadUrl` returns an upload URL the app
  `POST`s to; `assets.persistChatAttachments`; image picker, document picker,
  camera, clipboard file provider. [S, O for providers]
- **Share into T3:** `ACTION_SEND` and `ACTION_SEND_MULTIPLE` for `*/*` on
  `MainActivity`. [O]

### 4.10 Push, notifications and deep links

- **Registration:** the FCM device token is registered with the T3 relay
  (`POST /v1/mobile/devices`, scope `mobile:registration`); unregister by
  `DELETE /v1/mobile/devices/:deviceId`; agent-activity snapshot
  `GET /v1/mobile/agent-activity`. Push needs T3 Connect. [S, literals O]
- **Receipt:** `AgentMessagingService` (FCM `MESSAGING_EVENT`) posts the
  notification natively. It shows the alert only when the payload's
  `device_id` and `user_id` match the stored registration, `updated_at` is
  fresh, the alert id is unseen (bounded history of 64), and the thread is not
  already on screen. [O service; S Kotlin]
- **Payload content:** `alert_title` (up to 120 chars), `alert_body` (up to 608
  chars, grouped alerts list up to five thread titles), `alert_path`,
  `alert_group`. [S, `alert_path` O] Thread titles are generated from the
  conversation. [I]
- **Ongoing activity notification** with dismiss and expiry receivers. [O]
- **Deep links:** custom scheme `t3code://` (and `exp+t3-code`); verified
  App Link `https://app.t3.codes/threads/...`; notification paths
  `/threads/<environmentId>/<threadId>`; Clerk callbacks
  `clerk://com.t3tools.t3code.callback|oauth|hosted-callback`. [O manifest; S
  `notificationPayload.ts`]

### 4.11 Other shipped extras (out of the parity scope)

Voice input (`RECORD_AUDIO`), a subscription-usage home-screen widget, launcher
quick actions, a device preview stream WebView (`react-native-webview` file
provider present), Material You theming. [O]

## 5. Yaran today, for comparison

Yaran's phone app (`mobile/`) is a Capacitor shell plus first-party native
plugins. The shell is JavaScript; the machine is shown in a **native WebView of
the machine's own web UI** (`mobile/plugins/machine-view`). The locked tenets
that shape any parity work:

- Sign-in through the system browser and a sealed JWE handoff to an ephemeral
  P-256 key; no unauthenticated exchange endpoint
  (`HandoffClient.kt`, `SealedEnvelope.kt`, `crates/yaran-web/src/cloud_handoff.rs`).
- Verified https callback on `<publisher-domain>`; custom scheme only on builds
  without one (`mobile/plugins/machine-view/android/src/main/AndroidManifest.xml`).
- One-tap consent per host and hardware-held, non-exportable device key
  (`DeviceKeyStore.kt`, `AndroidKeyStoreBackend.kt`,
  `crates/yaran-web/src/handoff_consent_page.rs`).
- **No JS bridge in the machine WebView; bearer credentials never in JS**
  (`CookieInjector.kt`, `NativeOrgApi.kt`, `OrgApiClient.kt`).
- The remote UI is served by the machine, never bundled.
- Push carries ids, a label, a project and a state token, never agent output
  (`crates/yaran-core/src/cloud/push_emitter.rs`, `push_queue.rs`); Web Push to
  every device, UnifiedPush on `foss`, embedded FCM on `play`, APNs through the
  publisher relay (`mobile/plugins/push`).
- The PTY provider architecture is fixed: no protocol layer.

What already exists on the Yaran side: org pairing by QR or URL
(`ScanQr.tsx`, `EnterUrl.tsx`, `ConfirmOrg.tsx`), the org's machine list polled
every 30 s of visible time (`machinesStore.ts`), the machine WebView with
renewal (`RenewalCoordinator.kt`, `RenewalPolicy.kt`), push registration, tap to
open an agent route and "mute this machine" (`push/notificationTap.ts`), and
everything the web UI already does for agents, terminals, files and uploads.

## 6. Parity matrix

| Area | T3 Android (evidence) | Yaran today | Verdict |
|---|---|---|---|
| Add machine via cloud account | Clerk + relay list/link [S,O] | Org Worker pairing and machine list | **Parity** |
| Add machine **without cloud** (LAN / tailnet / own HTTPS) | QR or host+code, token exchange [S,O] | Not possible: every machine comes from an org | **Gap G1** |
| Several routes per machine, failover, learned endpoints | Yes, ranked, probed every 60 s [S] | One hostname per machine (Cloud Connect) | **Gap G2** |
| Never send a credential in clear | `sendsTokenInClear` [S] | HTTPS-only via Access; no plain-HTTP route exists | Parity now; must hold for G1/G2 |
| Credential custody | JWT and DPoP JWK readable by JS [S] | Native only, hardware key, cookies injected natively | **Yaran stronger; do not copy** |
| Session renewal | Re-exchange, per-connect ticket [S] | Native renewal coordinator, sealed handoff | Parity (different mechanism) |
| Reconnect / backoff | Jittered exponential, wake on foreground and network change [S] | Web UI's budgeted reconnect; resume handled in `MachineViewActivity.onResume` | **Partial, Gap G3** (no network-change wake) |
| Background lifecycle | Activity lease every 25 s / TTL 45 s [S] | PTY socket parks while hidden; events socket stays; viewed beat | Partial, see G4 |
| Offline cache | SQLite caches of threads and PRs [S] | Machine list memory-only; UI served live | Deliberate difference (tenet: served by the machine) |
| Agent list / start / stop / send / stream | Structured RPC [S,O] | Web UI over PTY | **Parity of outcome**; PTY stays |
| Resume | `queue.resume`, provider sessions [S] | Provider-native resume per tab (`Engine::tab_resume_decision`) | Parity |
| Approvals and questions | Structured `runtime-request.respond` [S,O] | Answered by typing into the CLI's own prompt in the PTY | **Out of scope** (needs a protocol layer) |
| Terminal | Native ghostty renderer [O] | xterm.js in the machine WebView | Parity of outcome |
| Files | Browse/read/write RPC [S] | Web editor and browse routes | Parity |
| Attachments from inside the app | Upload URL, pickers [S,O] | "Attach a file…", paste, drop | Parity |
| Share sheet into an agent | `SEND` / `SEND_MULTIPLE` `*/*` [O] | None | **Gap G5** |
| Push alert | FCM data, native render, on-screen suppression [O,S] | Web Push / UnifiedPush / FCM / APNs relay, native render | Parity |
| Push content | Thread titles in the body [S] | Ids, label, project, state token only | **Yaran stricter; keep** |
| Suppress push while the agent is on screen | Lease + `alert_path` check [S] | Attention is cleared by viewing (I); native check of "on screen" not found | **Gap G4 (verify first)** |
| Verified https link to one agent | `https://app.t3.codes/threads/...` [O] | `yaranapp://add-org` and push tap only | **Gap G6** |
| Connection diagnosis UI | Trace ids, diagnosis details [S] | Offline / Error / ProtocolMismatch screens | Minor gap, not proposed |
| Voice, widgets, quick actions | Present [O] | None | Not proposed |

## 7. Concrete gaps and recommendations

Each recommendation keeps the machine-served WebView, native-only credentials,
no WebView bridge and the PTY architecture. File names are where the work lands;
"new" means a file that does not exist yet.

### G1. Pair a machine directly, without Cloud Connect

T3 lets a phone pair to a machine on the LAN or tailnet by scanning a QR that
carries a one-time token. Yaran's phone can only reach machines through an org.

Recommended shape, which keeps every locked tenet:

- The machine shows a QR encoding a `yaranapp://` link (one-time, short-lived,
  single-use pairing code in the fragment, plus the machine's HTTPS or tailnet
  origin and the machine key fingerprint).
- The **native** plugin redeems the code with a signed request from the
  hardware device key, receives a session sealed to that key, and injects the
  cookie into the WebView exactly as the cloud handoff does. Nothing reaches JS.
- The machine refuses redemption over plain HTTP except on the tailnet, mirroring
  T3's `sendsTokenInClear` rule and Yaran's exposure gate.
- Paired-direct machines are a new machine kind in the shell, listed beside org
  machines, stored natively.

Files:

- `crates/yaran-web/src/auth/` (new `pairing.rs`; route registered in
  `auth/routes.rs`; accounting through `auth/admission.rs`, like a failed login).
- `crates/yaran-core/src/cloud/qr.rs` (reuse for the QR), plus a new
  `crates/yaran-core/src/phone_pairing.rs` for code minting and expiry.
- `cloud/protocol/src/uri.ts` (new `yaranapp://pair-machine` kind; shared fixture
  for both sides).
- `mobile/plugins/machine-view/android/.../HandoffClient.kt`,
  `CookieInjector.kt`, `DeviceKeyStore.kt` (redeem and inject), and the iOS
  twins.
- `mobile/app/src/lib/deepLinks.ts`, `screens/onboarding/ScanQr.tsx`, new
  `lib/directMachinesStore.ts` (non-secret metadata only).
- `SECURITY.md` and `docs/operations/threat-model.md`: a new threat row for the
  pairing route (append, never renumber).
- `website/docs/` phone pages.

Open decision for the owner: whether a directly paired phone counts as the
single password owner, or needs the password once in the WebView's login page.

### G2. More than one route per machine

T3 keeps ordered routes per machine and switches to the best one that answers.
For Yaran this means a machine paired through Cloud Connect could also be reached
on its tailnet address when the phone is on the tailnet.

Recommendation: only after G1 lands, and only between routes that each have their
own session (the Access cookie is per hostname, and Yaran's session cookie is per
origin). Probe and switch natively, never by script.

Files: `mobile/plugins/machine-view/android/.../ControlUrl.kt`,
`MachineState.kt`, `RouteFragment.kt`, new `RouteSelector.kt`;
`crates/yaran-web/src/serve_legs.rs` (advertise local legs to an authenticated
phone); `mobile/app/src/lib/machinesStore.ts`.

### G3. Wake the WebView on network change

T3 resets backoff and probes at once on a network change. Yaran's shell reacts to
resume (`MachineViewActivity.onResume`), but no `ConnectivityManager` network
callback was found in `mobile/plugins` or `mobile/android`.

Recommendation: register a `NetworkCallback` in the machine-view plugin and hand
the page the same signal a browser's `online` event gives. A page-level `online`
listener is not a bridge. The web side's budgeted reconnect tenet already says a
wake signal restarts a spent budget.

Files: `mobile/plugins/machine-view/android/.../MachineViewActivity.kt` (or a new
`NetworkWake.kt`), iOS `NWPathMonitor` twin; check
`crates/yaran-web/web/src/` for the existing wake path before adding one.

### G4. Do not push for an agent that is on screen (verify first)

T3 drops an alert when its thread is on screen. In Yaran, viewing clears
attention, so a rising edge is unlikely while a phone looks [I]. Not verified.

Recommendation: first add a test in `crates/yaran-core/src/cloud/push_emitter_tests.rs`
that holds a viewed terminal and asserts no edge. Only if it fails, add a native
"agent on screen" check in `mobile/plugins/push/android/.../NotificationPresenter.kt`
fed by the machine-view plugin's current route, never by page script.

### G5. Share sheet into an agent

T3 accepts `SEND` / `SEND_MULTIPLE` of any type. Yaran has no share target.

Recommendation: a share target that lets the user pick org, machine and agent,
then opens the machine view at that agent with the shared files handed to the
page's own "Attach a file…" journey (the WebView file chooser path), so the
upload, the input-ownership recheck and the one toast stay the web's. Do not
upload natively and inject a path: that would bypass the ownership gate.

Files: `mobile/android/app/src/main/AndroidManifest.xml`, new
`mobile/app/src/screens/share/`, `MachineChromeClient.kt` (file chooser),
iOS share extension.

### G6. Verified https link to an agent

T3 opens `https://app.t3.codes/threads/<env>/<thread>` straight into the app.
Yaran's push tap already builds `#/agent/<sid>[/tab/<tab>]`.

Recommendation: an App Link on `<publisher-domain>` for org, machine and agent,
routed through `parseAppUri` and `openMachine.ts`. The callback filter already
lives on that domain.

Files: `mobile/plugins/machine-view/android/src/main/AndroidManifest.xml` (or
the app manifest), `cloud/protocol/src/uri.ts`, `mobile/app/src/lib/deepLinks.ts`,
the publisher's `assetlinks.json` and apple-app-site-association
(publisher infrastructure, plan 21).

### Not recommended

- **Structured approvals and question answering** (T3 4.7). They need a
  structured agent protocol; Yaran's providers are CLIs in a PTY by tenet.
  Answering from a notification would also mean writing keystrokes into a PTY
  from outside the ownership gate.
- **Storing tokens or a DPoP key where JS can read them** (T3 4.3).
- **A bundled native client of the machine's API** (T3 section 3). It conflicts
  with "served by the machine, never bundled".
- **Thread titles or any agent text in push payloads** (T3 4.10).
- **An offline cache of agent state.** It conflicts with the served-UI tenet;
  caching the machine list alone is possible but low value.
- Voice input, widgets, Live Activities, quick actions: not part of the
  phone-to-machine experience requested.

## 8. Bounded completeness checklist

| Question | Status | Basis |
|---|---|---|
| Exact artifact identity and digests | Answered | REA `ev_dd51…`, `ev_fc6e…`, `ev_4b5c…`; GitHub digest |
| Pairing and add-machine flow | Answered | S + bundle literals |
| Direct and relay transport, routing | Answered for direct and credential brokering; `t3_relay` traffic path unknown | S + literals |
| Authentication and renewal | Answered except direct-pairing token lifetime | S |
| Discovery and persistence | Answered | S + `libexpo-sqlite.so` |
| Reconnect and background lifecycle | Answered | S + manifest (no app foreground service) |
| Agent list/start/resume/stop/send/stream | Answered | S + literals |
| Approvals and questions | Answered | S + literals |
| Terminal | Answered | O (classes, JNI exports) + S |
| Files and attachments | Answered | S + manifest providers |
| Push and deep links | Answered | O (manifest, service class) + S |
| Java/Kotlin decompilation via REA | **Not done** | JADX MCP JAR missing |
| Hermes control flow from the shipped bytecode | **Not done** | No Hermes decompiler in REA; source used instead |
| Behavior of a newer over-the-air JS bundle | **Unknown** | Expo updates enabled |
| Runtime confirmation on a device | **Not done** | Out of scope for this task |
| Yaran: push while viewed (G4) | **Unverified** | Proposed test |

Search bounds: Yaran was read in `mobile/app/src`, `mobile/plugins/*/android`,
`mobile/android/app/src/main`, `crates/yaran-web/src` (file listing and auth
directory), `crates/yaran-core/src/cloud` and `attention.rs`. A missing match
there (for example no `NetworkCallback`) is bounded to those paths.

## 9. Blockers

1. REA Android decompilation needs a jadx-headless-mcp 0.7.1 JAR configured as
   `REA_JADX_MCP_JAR` for the REA server, then a server restart.
2. The shipped JS is Hermes bytecode and can be replaced over the air; findings
   about JS behavior rest on the source at the tag commit, corroborated by the
   bundle's string table only.
3. Several Yaran mobile files were being modified by another task during this
   investigation (uncommitted changes in `mobile/app/src/lib/`,
   `mobile/plugins/machine-view/android/`). The file names above are stable, but
   line-level details should be re-read before implementation.

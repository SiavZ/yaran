# Phase 16 — Mobile: push clients (UnifiedPush, embedded FCM, APNs + NSE)

**Track:** B (parallel) · **Parallel-safe with:** 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 17, 18
**Depends on:** 02 (push payload schema, device API incl. `DevicePatch` mutes, relay mint contract, fixtures), 03 (G5; G4 indirectly through the relay), 14 (app shell, flavors, secure store, Settings screen), 15 (the `Session` plugin's native org API client and `MachineView.open`; coded against its TS definitions, which 15 lands first, as 14 does) · **Blocks:** 19, 21 (disclosure inputs)

## Goal

When an agent needs its owner, the phone shows a notification within seconds on every
distribution channel. The text is decrypted on the device, never in transit. A tap opens
that agent in `machine-view`. When the attention clears, the notification goes away
wherever the platform allows it. Permission, distributor, mute and failure states are all
shown to the user. The work covers three client paths behind one JS API: UnifiedPush on the
`foss` flavor, the embedded FCM distributor on the `play` flavor, and APNs through the
publisher relay with a Notification Service Extension (NSE) on iOS (D11).

## Evidence

All online sources were read on 2026-11-14. Repo citations were verified against the
current tree.

**Repo**

- **Hash grammar.** `crates/yaran-web/web/src/lib/store.ts:2123` matches
  `#/agent/<sid>(/tab|/terminal/<id>)?` and decodes each segment with
  `decodeURIComponent` (:2130). `selectionHash` (:2172) writes the main tab back as the
  bare `#/agent/<sid>` even when the URL spelled it `/tab/<sid>` (:2193-2197). So a tap can
  always emit `#/agent/<sid>/tab/<tabId>`, and the web UI normalizes it without the device
  knowing which tab is the first.
- **Notifications today.** The web UI raises OS notifications in
  `web/src/lib/agentNotifications.ts:146` (`new Notification(title, {body, tag})`). The
  `tag` is the per-agent collapse precedent this phase mirrors. There is no `PushManager`
  or push handler anywhere, and `public/sw.js` handles only install, activate and fetch
  (lines 14, 25, 36).
- **State words.** "Needs you", "Working" and "Idle" are web-side words
  (`web/src/lib/flatList.ts:183-194`). Core owns only `RowState` (`row_state.rs:18`). The
  push payload's `s` is a token (a RowState token or an `ending` token, 02 §9), never
  display text, so the phone maps it to its own localized words and shows the generic
  text for a token it does not know.
- **Source of truth.** The attention source is `apply_attention_decision`
  (`crates/yaran-core/src/engine/mod.rs:1302`), run on Phase 12's push-only set (D12).
  Phase 12 owns the emitter. Phase 08 sets the Web Push `Topic` to 02's `topic(m, a, t)`,
  one per agent tab (02 §9).

**Platform**

- **UnifiedPush connector.** `org.unifiedpush.android:connector` 3.3.5 (2026-08-22,
  https://repo1.maven.org/maven2/org/unifiedpush/android/connector/maven-metadata.xml).
  Reference: https://unifiedpush.org/kdoc/connector/.
  - `register(context, instance, messageForDistributor, vapid)` takes the VAPID public key
    at registration.
  - `PushService` callbacks are `onNewEndpoint(PushEndpoint, instance)`,
    `onMessage(PushMessage, instance)`, `onRegistrationFailed`, `onUnregistered` and
    `onTempUnavailable`.
  - `PushEndpoint.pubKeySet` carries the RFC 8291 `pubKey` and `auth`.
  - `PushMessage.content` arrives **already decrypted**, with a `decrypted` flag.
  - `DefaultKeyManager` keeps keys AES-GCM-wrapped by an Android Keystore key on API 23 and
    later.
  - External distributors are favoured over embedded ones (`tryUseCurrentOrDefaultDistributor`).
  - The docs ask apps to exclude the connector's database and shared preferences from
    Auto Backup.
- **Embedded FCM distributor.** `org.unifiedpush.android:embedded-fcm-distributor` 3.1.0
  (2026-06-23) has no Firebase SDK and needs no `google-services.json`. It registers over
  Play services directly, and the server sends standard VAPID Web Push to
  `https://fcm.googleapis.com/fcm/send/…`.
  - Source: https://unifiedpush.org/kdoc/embedded_fcm_distributor/.
  - The FOSS variant is deprecated at `1.0.1-deprecated`, which supersedes R5 §3.9's "prefer
    the FOSS one".
  - **UNVERIFIED** that FCM's Web Push endpoint survives long-term. Gate **G5** decides.
- **Capacitor.** `@capacitor/push-notifications` requires the Firebase Messaging SDK and
  `google-services.json` on Android (https://capacitorjs.com/docs/apis/push-notifications).
  F-Droid forbids that in `foss`, so a first-party plugin is required (D13). Current
  versions are `@capacitor/core` 8.6.2 (the pin) and `9.0.0-rc.0` (npm, 2026-11-12); the
  move to 9 at GA is Phase 14's work item, and this plugin follows it.
- **Android 13 and later.** `POST_NOTIFICATIONS` is off by default. An app targeting 33 or
  later decides when to prompt, and shows its own rationale only when
  `shouldShowRequestPermissionRationale()` is true. `NotificationManager.notify(tag, id)`
  replaces, and `cancel(tag, id)` removes.
  - Sources: https://developer.android.com/develop/ui/views/notifications/notification-permission
    and https://developer.android.com/reference/android/app/NotificationManager.
  - FCM demotes high-priority messages that produce no visible notification
    (https://firebase.google.com/docs/cloud-messaging/android-message-priority). Whether
    that also applies to Web Push through GMS is **UNVERIFIED**.
- **iOS NSE.** It runs only for `mutable-content: 1` with a visible alert, gets "about 30
  seconds", and shows the original content if it never calls the handler
  (https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications).
  The 24 MB memory figure comes from an Apple engineer on the forums, not from the docs
  (https://developer.apple.com/forums/thread/807554).
- **Keychain sharing.** App group names can serve as keychain access groups, and
  `kSecAttrAccessibleAfterFirstUnlock` suits background access
  (https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).
- **APNs collapse.** `apns-collapse-id` must be 64 bytes or less and becomes
  `UNNotificationRequest.identifier`. `removeDeliveredNotifications(withIdentifiers:)` is
  asynchronous.
- **iOS background pushes.** Pushes with `content-available` and priority 5 are throttled
  ("not more than two or three per hour"), and their delivery is not guaranteed
  (https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).
- **CryptoKit.** `P256.KeyAgreement` and `AES.GCM` are iOS 13+. The standalone `HKDF` is
  iOS 14+.
- **RFC 8291.** The worked example is in §5 and the intermediate values in Appendix A
  (https://www.rfc-editor.org/rfc/rfc8291.txt). The same vectors are pinned in 02's
  fixtures.
- **Research.** R5 §3 items 8-12 and the "Push architecture" section, R5 §4 items 14 and
  20-23 (Data Safety, F-Droid FCM ban), and R5 §5.

## In scope

- **First-party Capacitor plugin `mobile/plugins/push`.** One TS API with a Kotlin
  implementation (UnifiedPush and embedded FCM) and a Swift implementation (APNs and relay
  endpoint minting).
- **Shared Swift core.** RFC 8291 decryption, the App Group keychain subscription store,
  payload decoding and notification content, compiled into both the app and the NSE.
- **The NSE target** in `mobile/ios`.
- **`play`-flavor wiring.** The embedded distributor, plus the fully designed G5 fallback
  (relay-held FCM).
- **Shell-side orchestration in `mobile/app/src/push/`.**
  - Per-org registration with the Worker device API.
  - Reconciliation, endpoint-change sync, the permission flow, and tap routing into
    `machine-view`.
  - The notifications section that 14's Settings screen mounts.
- **Behaviour.**
  - Collapse per tab, and removal on `attention_cleared` where the platform allows.
  - Per-org and per-machine mute, enforced by the server and again on the device.
  - Categories and the one notification action.
  - Backup exclusions.
  - Tests, including 02's decryption vectors.

## Out of scope

| Item | Owner |
|---|---|
| Push payload schema, `Topic`/`Urgency` header rules, device-registration and mute fields, relay endpoint-minting contract, fixtures | 02 |
| Worker Web Push sender, fan-out, 404/410 handling (subscription cleared, device `gone`, row kept), relay Worker (Web Push → APNs, Topic → `apns-collapse-id`, Urgency → push type) | 08 |
| Attention emitter on the machine | 12 |
| App shell, router, flavors, secure-store plugin, Settings screen frame, i18n framework | 14 |
| `machine-view` open/navigate API, handoff, and the native `Session` plugin's org API client (`OrgApiClient`, `Session.request`, `Session.meta`) that performs every Worker call (D22) | 15 |
| Threat-model rows (T34, T39, T40, T41, T42, T60) and consumer docs page `push-notifications` | 17 |
| CI jobs that run these tests; signing; provisioning profiles for the NSE | 18 |
| End-to-end delivery on real devices, latency measurement | 19 |
| Data Safety, privacy nutrition labels, privacy manifest entries, Apple entitlement requests | 21 |

## Design

### One API, three transports

```text
mobile/app/src/push/ (TS, bridge-enabled shell only, D9): orchestration only (when, which
org, retries, row states, UI); never sees a JWT, an endpoint or a key (D22)
  pushRegistration.ts ──▶ @yaran/push plugin (native) ──┬─ Android foss: UnifiedPush connector ─▶ user's distributor
        │                     │                         ├─ Android play: connector + embedded FCM distributor
        │                     │                         │     (G5 fallback: Firebase Messaging + relay endpoint)
        │                     │                         └─ iOS: APNs token ─▶ relay endpoint minting (R2)
        │                     └─▶ native OrgApiClient (15) ─▶ Worker POST /v1/me/devices
        │                           (02 DeviceRegistration; the plugin fills `push` and `device_key` natively)
        └──▶ Session.request (15, native) ─▶ GET /v1/me/devices, PATCH/DELETE /v1/me/devices/{id}
```

- **One registration per org on every platform.** Each registration has its own
  `install_id` (02 `InstallId`, kept in 14's secure store, sent by 15's native client as
  `Yaran-Install-Id`) and its own relay `registration_id` (a `Uuid` minted with the
  subscription, sent only to the relay). Android uses UnifiedPush `instance = org id` with
  that org's `Meta.push.vapid_public_key` (read through `Session.meta`). iOS uses one P-256
  key and 16-byte `auth` per org, plus one relay endpoint per org. Orgs can therefore never
  decrypt or spoof each other's pushes, and removing an org deletes exactly its keys.
- **JS orchestrates; native performs every HTTP call and holds all key material (D22).**
  JS decides when to register, unregister, reconcile and mute, owns the row states and the
  error UX, and never holds a bearer credential, a push endpoint (02 treats it as a
  capability and never echoes it) or a key. Concretely:
  - `Push.registerDevice({orgId, installId, label, locale, mutes})`: native obtains or
    reuses the subscription (minting a relay endpoint where the channel needs one), builds
    02's `DeviceRegistration` with the `push` member filled in natively (`{kind: webpush,
    channel, distributor?, endpoint, keys: {p256dh, auth}}`, or `{kind: none}`) and
    `device_key` set to the org's device public key from 15's `DeviceKeyStore` (D24, 02
    §8.1; minted with the `install_id`, so it never changes for that id), sends it
    through 15's native `OrgApiClient` (W12, upsert by `install_id`) and returns the
    `Device` (which carries no endpoint) or the 02 error code.
  - `Push.localState({orgId})` returns only non-secret facts for reconciliation:
    `channel`, `endpoint_host`, the `vapid_public_key` the subscription was made with, the
    relay `kid`, and whether a subscription exists.
  - Mutes, listing and removal carry no key material, so JS sends them with
    `Session.request` (W31 `PATCH`, W13 `GET`, W14 `DELETE`).
  - The native push plugin reaches `OrgApiClient` through `mobile/plugins/core/` (shared
    native code). If 15 keeps the client inside its `Session` plugin module, it is
    extracted into `core` first (00-CONVENTIONS §1.2) rather than duplicated.
- **Endpoint changes while the WebView is not running** are queued natively, in
  `PendingRegistrationStore` on Android. On iOS the token is only delivered while the app
  runs. The queue is drained by JS on the next start (it calls `Push.registerDevice` per
  queued org).
  - If the change would leave the old endpoint dead (`onUnregistered` or a new endpoint),
    Android also posts one local notification: "Notifications for <org> need a refresh,
    open yaran". Pushes are never lost silently.
- **Reconciliation on every foreground.** `GET /v1/me/devices` (W13) is compared with
  `Push.localState`. The current device (`Device.current`) is re-registered when:
  `push_state` is `gone` (the push service said 404/410; the Worker cleared the
  subscription and kept the row, R11) or `auth_failed`; `Device.push.vapid_public_key`
  differs from `Meta.push.vapid_public_key` (a VAPID rotation, T41: UnifiedPush
  re-registers with the new `vapid`, iOS and `fcm_relay` re-mint); the relay's
  `RelayMeta.endpoint_key_id` differs from the stored `kid` (re-mint); or the endpoint
  host changed. `failing` is shown, not re-registered (the Worker keeps retrying). A
  `403 device_revoked` from any call means this phone was removed from the org: the org's
  local keys, `install_id` and mirrors are deleted and 15/14 say so.
- **Capability gate.** Push UI for an org appears only when `Meta.capabilities` contains
  `push.webpush`; `Meta.push.enabled = false` shows the org row as `org_disabled`.

### Android

- **Transport.** The plugin depends on the connector. The `play` flavor alone adds
  `playImplementation "org.unifiedpush.android:embedded-fcm-distributor:3.1.0"` and a
  subclass of `EmbeddedDistributorReceiver` in `app/src/play/`. Because the connector
  favours external distributors, a Play user with ntfy still gets UnifiedPush, and the
  embedded path is the default only when nothing else is installed.
- **Keys and decryption.** These are the connector's own `DefaultKeyManager`, which is
  Keystore-wrapped, and its RFC 8291 decryption. We write no Android crypto on the primary
  path. A `PushMessage` with `decrypted == false` is shown as the generic text and never
  parsed.
- **Distributors.**
  - Picker: `getDistributors` lists them and `saveDistributor` saves the choice. A change
    re-registers every org.
  - `foss` with no distributor: the org row reads "No UnifiedPush distributor installed",
    linking to `https://unifiedpush.org/users/distributors/` (ntfy is listed first there).
  - `play` without Play services: registration fails and the row says so, with the same
    link.
- **Presentation.**
  - Channels: `attention` (high importance, "Agents that need you") and `exits`
    (default importance, "Agents that stopped with an error").
  - Notifications are posted under tag = 02's `topic(m, a, t)` (computed on device from the
    payload's `m`, `a` and `t`, `t` empty for the slot tab; pinned by 02's
    `fixtures/push/payload-*` topic cases) with a fixed id, so a repeat replaces (collapse
    per agent tab, and two agents' slot tabs never share a tag) and `attention_cleared`
    calls `cancel(tag, id)`. The org is carried in the extras, not the tag.
  - 02 defines no Android group key, so grouping stays presentation: one group key per
    machine (`"<orgId>/<machineId>"`).
  - The content intent is an explicit `PendingIntent` (`FLAG_IMMUTABLE`) to `MainActivity`
    with extras, never an exported URI. The plugin forwards it with
    `notifyListeners("notificationTapped", data, true)`, which retains a cold-start tap until
    JS attaches.
- **Foreground suppression.** When the shell reports that `machine-view` is showing that
  exact agent and tab, the notification is not posted. Opening an agent cancels its tags.
- **Backup.** 14's `data_extraction_rules.xml` and `full_backup_content.xml` gain excludes
  for the connector's database and preferences and for this plugin's stores. Restored keys
  would be wrong keys.

### Android `play` fallback (G5 fails): relay-held FCM

Build property `yaran.playPushTransport = embedded-fcm | relay-fcm`. It lives in the
publisher build config that 14 defines (D16), and the default follows the G5 outcome. With
`relay-fcm`:

1. The `play` flavor adds `com.google.firebase:firebase-messaging`, using the publisher
   `google-services.json` injected at build time and never committed.
2. `FcmRelayMessagingService` (`FirebaseMessagingService`) receives FCM data messages.
3. Keys are generated and stored by `FcmRelayKeyStore`: a P-256 key and `auth`, wrapped
   with a Keystore AES key, following the connector's own scheme. Payloads are decrypted
   with Tink's `WebPushHybridDecrypt`; Tink is already on the classpath through the
   connector.
4. Native code (`RelayEndpointClient.kt`, inside `Push.registerDevice`) mints a relay
   endpoint exactly as iOS does, with 02's `EndpointMintRequest {kind: "fcm", app_id,
   fcm_token, vapid_public_key, registration_id}`, after checking that `RelayMeta.channels`
   contains `fcm`. The device channel is `fcm_relay`. The relay's FCM data message is
   02's `{data: {v: "1", r, y}}`; `r` selects the org subscription.
5. Presentation is shared with the primary path (`NotificationPresenter`). Only the
   transport differs.

### iOS

- **Registration.**
  - `registerForRemoteNotifications` returns the APNs token.
  - Per org, `PushSubscriptionStore` generates a `P256.KeyAgreement.PrivateKey`, 16 random
    bytes of `auth` and a `registration_id` (`Uuid`). It stores them with the endpoint and
    its `kid` in the App Group keychain (`kSecAttrAccessGroup` = the app group,
    `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so keys never migrate through a
    backup).
  - `RelayEndpointClient` reads `RelayMeta` (R1: `apps` must contain the bundle id,
    `channels` must contain `apns`) and mints `https://<publisher-relay>/w/v1.<kid>.<opaque>`
    with 02's `EndpointMintRequest {kind: "apns", app_id: <bundle id>, apns_token,
    apns_environment: production|sandbox, vapid_public_key, registration_id}`. The relay
    base URL is a build-time setting (D11, D16; Phase 19 hook H6 is 14's build config).
  - A token change re-mints every org's endpoint and re-registers with each Worker.
- **NSE (`NotificationService.swift`).** It loads no Capacitor and no third-party code,
  only CryptoKit and the shared core, so it stays far inside the about 24 MB forum figure.
  1. Read the relay's top-level `v` (must be 1), `r` (`registration_id`) and `y`
     (base64url ciphertext) from the APNs payload (02 §9).
  2. Select the org subscription whose `registration_id` equals `r` and decrypt with its
     keys; no match or a failed AES-GCM tag leaves the generic alert.
  3. Decode and validate the 02 payload.
  4. Check the local mute set (App Group `UserDefaults`).
  5. Build the content from the token `s` (localized words; unknown token → generic text):
     for `attention_raised`, title "<agent label> needs you" (or "An agent needs you" when
     `l` is absent, `push.detail = minimal`); for `agent_exited_badly`, the `ending`
     token's words ("<agent label> stopped with an error"); for `test`, "Test notification
     from <org>". Body "<project> · <machine name>" (or the machine name alone without
     `p`), where the machine name comes from the cached machine list in the App Group. The
     NSE sets `threadIdentifier` to `<orgId>/<machineId>` (02 §9: collapse per tab, group
     per machine; the relay's Topic `thread-id` is only the failed-decrypt fallback); category; `userInfo {org,
     machine, agent, tab}`; and `interruptionLevel .timeSensitive` for `attention_raised`
     when the entitlement is granted, `.active` otherwise.
  - On any failure, or in `serviceExtensionTimeWillExpire`, the relay's generic alert
    stays. Before the first unlock after a reboot the keychain is locked, so the user sees
    the generic text. This is accepted, and stated in docs.
  - The entitlement key `com.apple.developer.usernotifications.time-sensitive` comes from
    forums only. **UNVERIFIED**; 21 confirms it.
- **Collapse and grouping.** The relay maps the Web Push `Topic` (02's `topic(m, a, t)`)
  to `apns-collapse-id` and a fallback `thread-id` (02 §9, 08; the NSE overrides `threadIdentifier` to `<orgId>/<machineId>`), and iOS uses the collapse id as the
  notification identifier, so a repeat for an agent tab replaces the earlier one.
- **Clear on `attention_cleared`.** An NSE cannot drop an alert without the restricted
  filtering entitlement, so the primary path never sends cleared events as alerts.
  - 02 §9 and 08 send cleared events with `Urgency: very-low`, and the relay delivers
    those as APNs background pushes (`apns-push-type: background`, priority 5,
    `{"aps":{"content-available":1},"v","r","y"}`). Phase 12 notes that duplicates are
    harmless.
  - The app's background handler decrypts with the same shared core and calls
    `removeDeliveredNotifications` for the deliveries whose `userInfo` matches that agent
    and tab. Matching on `userInfo` (via `getDeliveredNotifications`) means the device
    never has to recompute the Topic format.
  - Background pushes are throttled, so this is best effort. Opening the app, or any agent,
    also removes that machine's or agent's stale deliveries.
  - **Defensive path:** if a cleared event ever reaches the NSE as an alert (an old relay),
    the NSE delivers a `.passive` replacement with `relevanceScore = 0` under the same
    identifier ("<agent> no longer needs you").
  - If 21 obtains `com.apple.developer.usernotifications.filtering` (**UNVERIFIED** that it
    will be granted), the NSE suppresses that alert entirely by returning empty content.
- **Taps.** The plugin registers with Capacitor's iOS `NotificationRouter`
  (`bridge.notificationRouter.pushNotificationHandler`) instead of replacing the
  `UNUserNotificationCenter` delegate, so it cannot fight other plugins. The router API
  name in Capacitor 8 is **UNVERIFIED** and must be checked against the installed version;
  if it differs, the fallback is a delegate proxy that forwards unknown calls.
  - `willPresent` returns `[]` when the shell reports that exact agent on screen, and
    `[.banner, .list, .sound]` otherwise.
  - `didReceive` emits `notificationTapped`, retained until consumed.

### Payload validation and tap routing (trust boundary)

The decrypted payload is authenticated only as "someone holding this org's VAPID key and
the device's `auth`", so it is still treated as input.

- Fields are length-capped per 02 and stripped of control and bidi characters before
  display. The Swift and Kotlin parsers share 02's fixtures.
- **Taps never navigate to a host taken from the payload** (T42).
  `notificationTap.ts` resolves `machineId` against the local paired-machine list of that
  org. Unknown means toast "That machine is no longer paired with this phone" and open the
  Machines list.
- It then calls 15's open API with the hash
  `#/agent/${encodeURIComponent(agent)}/tab/${encodeURIComponent(tab)}`, or the bare
  `#/agent/${encodeURIComponent(agent)}` when the payload omits `t` (the agent's first
  tab, 02 §9). The web UI's parser accepts both and normalizes the main tab
  (store.ts:2123, :2193-2197).

### Permission, mute and state UX

- **When to ask.** Only on an explicit "Turn on notifications" step after the first org
  is added (14's onboarding) or from Settings, never at launch.
  - Android 13 and later goes through Capacitor's permission API (plugin permission alias
    `notifications`), with a rationale sheet when `shouldShowRequestPermissionRationale`
    is true.
  - A permanent deny offers "Open system settings" via
    `Settings.ACTION_APP_NOTIFICATION_SETTINGS`.
  - Android 12 and lower checks `areNotificationsEnabled()` and channel importance.
  - iOS calls `requestAuthorization([.alert, .sound, .badge])`. A denial offers
    `UIApplication.openNotificationSettingsURLString` (always available, since the iOS
    minimum is 17.4).
- **Per-org row states.** One exhaustive union (`assertNever`):
  - `active`
  - `needs_permission`
  - `no_distributor`
  - `push_unavailable` (no Play services, or relay unreachable)
  - `registration_failed{reason}`, with the reason sanitized
  - `refresh_pending` (re-registering after `gone`, `auth_failed`, a VAPID rotation or a
    relay key change)
  - `delivery_failing` (`push_state: failing`: the push service keeps failing; the org
    keeps retrying)
  - `org_disabled` (`Meta.push.enabled` is false)
  - `muted`
  - `turned_off`
- **Mute.** Per org and per machine, exactly 02's fields: per-org is `mute_all`
  (indefinite) or `muted_until` (timed, a `Timestamp`), per-machine is
  `muted_machine_ids` (≤ 100). The source of truth is the device record on the Worker, set
  with W31 `PATCH /v1/me/devices/{id}` (`DevicePatch`) through `Session.request`, so muted
  pushes are never sent. A local mirror is used for enforcement on the device: Android does
  not post; iOS NSE delivers `.passive`, silent. The mirror covers the gap before a sync and
  a stale server.
- **Notification action.** One action, "Mute this machine", with the `.foreground` option
  on iOS and an activity intent on Android. It opens the app, which applies the mute on the
  Worker (W31 through the native client) and locally and confirms with a toast, as
  CLAUDE.md requires for a change that lands on a small indicator. It stays a foreground
  action, rather than a background native call, because the confirmation toast and 14's
  app lock both need the app in front.
- **Off switches.** "Turn off notifications for this org" re-registers that org's device
  with `push: {kind: none}` (W12 upsert by `install_id`) and deletes the local push keys;
  it does **not** delete the device, because a revoked device makes every later call from
  this install answer `403 device_revoked` and would remove the whole org from the phone.
  Removing an org (14) calls W14 `DELETE /v1/me/devices/{id}`, then deletes the keys and
  the `install_id`.

## Work items

Every new code file is planned at or under 500 lines and carries the 00-CONVENTIONS §2
header, with the generated `Uses` and `Used by` block checked by `module-headers --check`
(Phase 01). Kotlin, Swift and TS follow the exhaustiveness rule (§1.5).

1. **Plugin TS surface: `mobile/plugins/push/`.**
   - **Create:**
     - `package.json`
     - `src/definitions.ts` (the API: `checkPermission`, `requestPermission`,
       `listDistributors`, `selectDistributor`, `registerDevice({orgId, installId, label,
       locale?, mutes, pushOff?})` → `Device` or a 02 error code (native subscription,
       relay mint and W12 call; no endpoint or key crosses the bridge), `localState({orgId})`,
       `forgetOrg({orgId})` (local keys only), `setLocalMutes`, `cacheMachineNames`,
       `setVisibleAgent`, `clearDelivered({orgId, machineId, agentId?, tabId?})`; events
       `endpointChanged` (org id only), `registrationFailed`, `notificationTapped`,
       `pendingRegistrations`)
     - `src/index.ts`
     - `src/web.ts` (web stub that rejects with `unimplemented`)
   - **Reuse:** the plugin scaffold and naming from 14's `mobile/plugins/secure-store`, and
     the subscription and payload types from `cloud/protocol` (never redeclared, §1.4).
   - **Tests:** Vitest for the web stub and for the type guards on event payloads,
     including a guard that no plugin result or event type has an `endpoint`, `keys`,
     `auth` or JWT field (D22).
2. **Android plugin: `mobile/plugins/push/android/src/main/`.**
   - **Create** under `kotlin/…/push/`:
     - `PushPlugin.kt` (bridge, permission alias, retained tap events)
     - `UnifiedPushRegistrar.kt` (instance per org, VAPID at register, distributor
       list/select)
     - `DeviceRegistrar.kt` (builds 02's `DeviceRegistration` `push` member and `device_key` natively and
       sends W12 through 15's `OrgApiClient` from `mobile/plugins/core/`)
     - `YaranPushService.kt` (`PushService` callbacks into the presenter and the pending
       store)
     - `PushPayloadParser.kt` (sealed class mirroring 02's `k` values, `test` included, and
       an `Unknown` arm; `s` kept as a token)
     - `PushTopic.kt` (02's `topic(m, a, t)`)
     - `NotificationPresenter.kt` (channels, tag = Topic, cancel, group, action, foreground
       suppression, token → localized words)
     - `MuteStore.kt` and `PendingRegistrationStore.kt` (plain `SharedPreferences`; neither
       is secret)
     - `NotificationActionActivity.kt` (the "Mute this machine" trampoline into the app)
     - `AndroidManifest.xml` (non-exported service with the connector action,
       `POST_NOTIFICATIONS`)
   - **Touch:** 14's backup-rules XML (excludes only).
   - **Tests** (JUnit + Robolectric):
     - The parser against every 02 payload fixture, including the oversize (> 320 bytes)
       and control-character cases, every `s` token and an unknown token.
     - `PushTopic` against 02's topic fixture cases, including two agents' slot tabs on one
       machine producing different tags.
     - The presenter: tag format, replace and cancel, channel selection, `PendingIntent`
       immutability and extras.
     - `DeviceRegistrar` against a stubbed `OrgApiClient`: the request matches 02's
       `DeviceRegistration` schema; `device_key` equals the stub `DeviceKeyStore`'s public
       key for that org, including on the `{kind: none}` re-registration; `{kind: none}` for
       push off; `device_revoked` surfaced.
     - The mute filter.
     - `decrypted == false` producing the generic text.
     - The pending-registration queue surviving process death.
3. **`play` flavor: `mobile/android/app/src/play/`.**
   - **Create:**
     - `kotlin/…/EmbeddedDistributor.kt` (an `EmbeddedDistributorReceiver` subclass) and
       `AndroidManifest.xml`.
     - For the G5 fallback, `kotlin/…/FcmRelayMessagingService.kt`, `FcmRelayKeyStore.kt`
       and `RelayEndpointClient.kt` (02's `kind: "fcm"` mint, HTTPS-only relay base URL),
       compiled only when `yaran.playPushTransport=relay-fcm`.
   - **Touch:** `mobile/android/app/build.gradle(.kts)` (owned by 14): the
     `playImplementation` lines and the transport switch only.
   - **Tests:**
     - `FcmRelayKeyStore` round trip.
     - Tink decryption against 02's RFC 8291 vectors (Appendix A) and
       `fixtures/webpush/payload-vectors.json`; FCM data-message parsing against
       `fixtures/push/relay-wrapping.json`.
     - The mint body matches 02's `EndpointMintRequest` (`kind: "fcm"`).
     - A Gradle dependency assertion that `fossReleaseRuntimeClasspath` contains no
       `com.google.firebase`, `com.google.android.gms` or `embedded-fcm` artifact. The test
       lives here and Phase 18's CI runs it.
4. **Shared Swift core: `mobile/ios/Shared/YaranPushCore/`.** This is a local Swift package
   linked by the App target and the NSE.
   - **Create:**
     - `WebPushDecryptor.swift` (RFC 8291 `aes128gcm`: header parse, ECDH, the two HKDF
       stages, AES-GCM, padding strip; record size bounded)
     - `PushSubscriptionStore.swift` (App Group keychain CRUD per org, lookup by
       `registration_id`)
     - `PushPayload.swift` (Codable for 02, with caps and sanitization; `RelayWrapping`
       for the top-level `v`/`r`/`y`)
     - `PushTopic.swift` (02's `topic(m, a, t)`, used to match deliveries)
     - `NotificationContentBuilder.swift` (token → localized words)
     - `SharedPushState.swift` (App Group `UserDefaults`: mutes and machine-name cache)
     - `Package.swift`
   - **Reuse:** if 14's secure-store plugin already has a Keychain wrapper, extract it into
     this package first and have both use it (§1.2), rather than writing a second one.
   - **Tests** (XCTest, `Tests/YaranPushCoreTests/`):
     - RFC 8291 §5 and Appendix A vectors, `fixtures/webpush/payload-vectors.json`, the
       APNs alert and background bodies in `fixtures/push/relay-wrapping.json`, and every
       `fixtures/push/payload-*` case (tokens, omitted `p`/`l`, topic derivation).
     - Tampered tag, wrong key, truncated header and oversize record size.
     - Key selection by `r` across three org subscriptions; an unknown `r` keeps the
       generic alert.
     - Keychain access-group round trip in a test host.
     - `XCTMemoryMetric` on decrypt-and-build, staying below 8 MB peak.
5. **iOS plugin: `mobile/plugins/push/ios/Sources/PushPlugin/`.**
   - **Create:**
     - `PushPlugin.swift` (bridge)
     - `APNsRegistrar.swift` (authorization, token, environment from the `aps-environment`
       entitlement)
     - `RelayEndpointClient.swift`: `RelayMeta` (R1) and the 02 `kind: "apns"` mint (R2)
       to the publisher relay, which holds no user credential. It validates that the relay
       base URL is HTTPS.
     - `DeviceRegistrar.swift` (builds 02's `DeviceRegistration` `push` member and `device_key` natively and
       sends W12 through 15's `OrgApiClient` from `mobile/plugins/core/`; D22)
     - `NotificationRouter+Push.swift` (tap, `willPresent`, categories, background cleared
       handler)
   - **Touch:** the app's `Localizable.strings` (14's i18n home): add
     `PUSH_GENERIC_TITLE` and `PUSH_GENERIC_BODY`, the keys the relay's alert names (02
     §9), and verify on device that the generic alert resolves them (08 marks this
     UNVERIFIED).
   - **Tests:**
     - The endpoint client against a stub `URLProtocol`: success, 429 with `Retry-After`,
       5xx, `400 relay_app_unknown`, an `apps`/`channels` mismatch in `RelayMeta`, a mint
       body equal to 02's `EndpointMintRequest`, and a non-HTTPS refusal.
     - `DeviceRegistrar` against a stubbed `OrgApiClient`, as on Android.
     - Category registration.
     - `willPresent` suppression logic.
6. **NSE target: `mobile/ios/App/NotificationService/`.**
   - **Create:** `NotificationService.swift`, `Info.plist` and
     `NotificationService.entitlements` (app group, keychain access group, and the
     time-sensitive entitlement once confirmed).
   - **Touch:** the Xcode project (14): add the target and embed it. The bundle id is
     `<ios-bundle-id>.NotificationService` (D16 placeholder).
   - **Tests:** XCTest driving `didReceive` with fixture payloads and a stub content
     handler:
     - success content
     - decrypt failure keeping the generic content
     - expiry callback
     - muted machine giving `.passive`
     - a cleared event giving a `.passive` replacement
7. **Shell orchestration: `mobile/app/src/push/`.**
   - **Create:**
     - `pushRegistration.ts` (register, push-off, unregister and reconcile per org via
       `Push.registerDevice`, `Push.localState` and `Session.request`; drains
       `pendingRegistrations`; maps `push_state` and `device_revoked` to row states and
       actions)
     - `pushPermission.ts` (the permission state machine and the row-state union)
     - `notificationTap.ts` (validation against the machine list, hash building, the 15
       open call, clearing delivered notifications)
     - `NotificationSettingsSection.tsx` (rows, distributor picker, mute toggles, off
       switches, using 14's components and i18n keys)
     - `pushStrings.ts` (English baseline keys)
   - **Touch:** 14's Settings screen (mount the section), 14's org-removal flow (call
     unregister), and 14's app-foreground hook (call reconcile).
   - **Reuse:** 15's `Session` plugin (`Session.request`, `Session.meta`; D22: JS never
     holds a bearer credential) and 14's error envelope handling, 14's toast and confirm
     components (destructive "Turn off" confirms), and 02's generated types.
   - **Tests** (Vitest with a mocked plugin and `Session`):
     - Registration and reconcile: device missing, endpoint host changed, `push_state:
       gone` (subscription cleared, row kept) and `auth_failed` re-register,
       `Device.push.vapid_public_key` ≠ `Meta.push.vapid_public_key` re-registers, relay
       `endpoint_key_id` change re-mints, `failing` shows `delivery_failing` without
       re-registering, `device_revoked` forgets the org.
     - "Turn off" sends `{kind: none}` through `Push.registerDevice` and never W14; org
       removal sends W14.
     - No code path in `src/push/` reads a JWT or an endpoint (a lint rule over the
       module plus the plugin type guard).
     - Every row state rendering, exhaustive.
     - Tap with an unknown machine, a known machine, a payload without `t` (bare agent hash), and a malicious agent id containing
       `/` or `#`, which must be encoded.
     - Mute sync through W31 `DevicePatch` (`mute_all`, `muted_until`,
       `muted_machine_ids`), including offline then online.
8. **Disclosure input for 21.** Append a "Push data inventory" section to this phase's PR
   description, and hand it to 20 and 21. It lists what each party sees:
   - **Distributor or FCM:** endpoint, timing and size.
   - **Relay:** APNs token (or FCM token under the G5 fallback), the app id, the org VAPID
     public key, the per-org `registration_id`, timing and volume.
   - **Apple and Google:** the token and ciphertext.
   - **On device:** the decrypted payload, held in memory only.

## Acceptance

- [ ] `foss` APK: with ntfy installed, an `attention_raised` Web Push encrypted with 02's
      reference encoder to the registered endpoint shows "<agent> needs you" and
      "<project> · <machine>". A second push for the same tab replaces it, and
      `attention_cleared` removes it.
- [ ] `foss` APK without a distributor shows `no_distributor` with the distributors link.
      Its runtime classpath holds no Firebase, GMS or embedded-FCM artifact.
- [ ] `play` build with no external distributor receives through the embedded FCM
      distributor (or through the relay when G5 adopted the fallback). With ntfy installed
      it uses ntfy.
- [ ] iOS: an alert push through the relay is decrypted by the NSE. Corrupting the
      ciphertext shows the generic text. A cleared background push removes the delivery
      when iOS delivers it, and opening the agent always removes it.
- [ ] A tap on a cold-started app opens `machine-view` at `#/agent/<id>/tab/<tab>`. A tap for
      an unpaired machine never loads any host.
- [ ] Mute per machine and per org stops server sends, and is enforced locally while
      offline. The "Mute this machine" action confirms with a toast.
- [ ] No JWT, push endpoint or push key ever crosses the bridge into JS; every Worker call
      (registration, listing, mutes, removal) goes through 15's native client (D22).
- [ ] A device the org marked `gone` (404/410) or `auth_failed`, or whose
      `Device.push.vapid_public_key` no longer matches `Meta.push.vapid_public_key`, is
      re-registered on the next foreground, and its row was kept on the Worker throughout.
- [ ] Two agents on one machine raising from their first tabs produce two notifications
      (02's `topic(m, a, t)`), not one.
- [ ] The Android 13+ prompt appears only after the explicit step. Every permanent-deny
      path offers system settings.
- [ ] All Kotlin, Swift and TS tests pass, including RFC 8291 Appendix A and every 02 push
      fixture. `module-headers --check` and the 500-line gate pass for every new file.

## Validation

```bash
cd mobile && npm ci && npm run typecheck && npx vitest run src/push plugins/push
cd mobile/android && ./gradlew :push:testDebugUnitTest testFossDebugUnitTest testPlayDebugUnitTest \
  ktlintCheck detekt lintFossRelease lintPlayRelease
cd mobile/android && ./gradlew :app:dependencies --configuration fossReleaseRuntimeClasspath \
  | grep -Ei 'com\.google\.(firebase|android\.gms)|embedded-fcm' && exit 1 || true
cd mobile/ios/Shared/YaranPushCore && swift test
cd mobile/ios && xcodebuild test -project App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17' | xcbeautify  # project/scheme names per Phase 14
swiftlint --strict mobile/ios mobile/plugins/push/ios
node tools/module-headers/bin/module-headers.mjs --check   # entry point per Phase 01
```

## Risks

| Risk | Mitigation |
|---|---|
| FCM Web Push endpoint withdrawn or unproven (G5) | Relay-held FCM fallback fully specified; build switch; same presenter |
| NSE killed (memory/time) or keychain locked before first unlock | No third-party code in NSE; memory test; generic fallback text always meaningful; docs state it |
| iOS background pushes throttled, so cleared notifications linger | Foreground and agent-open clear; collapse per tab bounds the pile to one per tab; optional filtering entitlement |
| FCM demotes pushes that produce no notification (cleared events) | Cleared events use `Urgency: very-low` (02 §9, sent by 08); every raised event shows a notification |
| Capacitor `NotificationRouter` API differs in 8.x/9.x | Verify against the installed version; delegate-proxy fallback |
| Endpoint changes while the app is closed | Native pending queue plus local "refresh" notification; foreground reconcile |
| Payload abused to open a foreign host | Machine-list validation; hash segments encoded; hosts only from local store (T42) |
| Time-sensitive or filtering entitlement not granted | `.active` level and `.passive` replacement paths already specified |
| Distributor-less de-Googled `play` installs | Clear `push_unavailable` state linking to UnifiedPush distributors |

## References

- research/R5-mobile.md §3, "Push architecture for a self-hostable app", §4 (14, 20-23), §5
- 00-README.md D9, D11, D12, D13, D16, D22; 02-protocol-contract.md §2, §5 (W12–W15, W31, R1–R2), §6, §9; 12-yaran-attention-push-emitter.md; 15-mobile-machine-view-and-auth.md (`Session`, `OrgApiClient`); 17-docs-website-threat-model.md T34, T39, T40, T41, T42, T60
- `crates/yaran-web/web/src/lib/store.ts:2123, :2130, :2172, :2193-2197`; `web/src/lib/agentNotifications.ts:146`; `web/src/lib/flatList.ts:183-194`; `crates/yaran-core/src/engine/mod.rs:1302`
- https://unifiedpush.org/kdoc/connector/ ; https://unifiedpush.org/kdoc/embedded_fcm_distributor/ ; https://unifiedpush.org/developers/spec/android/ (read 2026-11-14)
- https://capacitorjs.com/docs/apis/push-notifications (2026-11-14)
- https://developer.android.com/develop/ui/views/notifications/notification-permission ; https://firebase.google.com/docs/cloud-messaging/android-message-priority
- https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications ; https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app ; https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps ; https://developer.apple.com/forums/thread/807554
- RFC 8291 §5 and Appendix A; RFC 8030 §5.3-5.4 (Urgency, Topic); RFC 8292

## Reconciliation notes (2026-11-14)

- R20: Depends-on adds 15 (`Session`/`OrgApiClient`, `MachineView.open`; coded against 15's TS definitions); 15 removed from Parallel-safe accordingly.
- R12/D22: "JS owns every HTTP call; native code makes none" replaced. JS orchestrates; native does every Worker call (registration through `Push.registerDevice` → 15's `OrgApiClient` via `mobile/plugins/core/`; listing, mutes and removal through `Session.request`) and holds all key material and endpoints. New design: `registerDevice`/`localState`/`forgetOrg` plugin API, `DeviceRegistrar.{kt,swift}`, D22 type-guard and lint tests, acceptance criterion.
- R9: per-device mutes are 02's `mute_all` / `muted_until` / `muted_machine_ids` via W31 `DevicePatch`; `install_id` per org registration; registration `channel` replaces "provider"; `Meta.push.vapid_public_key` via `Session.meta`; capability `push.webpush` gates the UI.
- R11: "a device the Worker deleted (after a 410)" → `push_state: gone`, subscription cleared, row kept; reconcile re-registers on `gone`/`auth_failed`/VAPID key mismatch/relay `kid` change; `failing` shown as new row state `delivery_failing`; `org_disabled` row state added.
- Correctness fix forced by 02's W14 semantics: "Turn off notifications" now re-registers with `push: {kind: none}` instead of deleting the device (a revoked device would answer `device_revoked` and remove the org); org removal still uses W14.
- R9 / 02 §9: cleared events' `very-low` + APNs background push stated as 02/08 behaviour (no longer a "requirement on 02/08"); risk row says `very-low`.
- 02 §9 grouping key: Android tag and iOS identifier/`thread-id` are 02's `topic(m, a, t)` (was `<orgId>/<machineId>/<tabId>` and `threadIdentifier = machineId`, which collided for slot tabs with `t` omitted); Android group key stays per machine because 02 defines none; `PushTopic.{kt,swift}` and tests added.
- 02: relay mint uses `EndpointMintRequest {kind: apns|fcm, app_id, apns_token|fcm_token, apns_environment, vapid_public_key, registration_id}` with `RelayMeta` checks; the `fcm_relay` mint moves from JS to native `RelayEndpointClient.kt`.
- 02: the NSE selects keys by the relay's `r` (`registration_id`) instead of trial decryption; reads top-level `v`/`r`/`y`; app ships `PUSH_GENERIC_TITLE`/`PUSH_GENERIC_BODY` localization keys.
- 02 §9: `s` is a token mapped to localized words (unknown → generic), not a word rendered verbatim; `test` kind and omitted `p`/`l` (`push.detail = minimal`) handled; tap with omitted `t` uses the bare agent hash.
- Fixtures renamed to `fixtures/webpush/payload-vectors.json` and `fixtures/push/relay-wrapping.json` (was "02 sealed-push fixture").
- R21: connector 3.3.5 and embedded-fcm-distributor 3.1.0 match Phase 03 G5; Capacitor 8.6.2 pin with the 9-at-GA move owned by 14; iOS minimum 17.4 removes the "below iOS 16" settings fallback.
- R14: threat references extended to T34 (mute API), T41 (VAPID rotation), T60 (D22 native HTTP) alongside T39, T40, T42.
- R15/R20: Phase 19 hook H6 (relay URL as build config) referenced as 14's build config consumed here.
- 02 §9 (final pass): the NSE now sets `threadIdentifier` to `<orgId>/<machineId>` (group per machine); the relay's Topic `thread-id` is only the failed-decrypt fallback.
- D24: `DeviceRegistrar` (both platforms) fills 02's required `DeviceRegistration.device_key` natively from 15's `DeviceKeyStore`; registrar test asserts it, push-off re-registration included. Key deletion on org removal and `device_revoked` rides 15's `Session.signOut` / wipe with the `install_id`.

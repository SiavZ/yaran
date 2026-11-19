# Phase 08 — Push delivery: org Web Push sender and publisher APNs relay

**Track:** B (cloud) · **Parallel-safe with:** 05, 07, 09–18
**Depends on:** 02 (push payload, `EventBatch`, `Device`/`DevicePatch`, `Settings.push`, relay schemas, error codes, fixtures), 03 (gates G4, G5), 04 (Worker scaffold, signed machine middleware, D1, settings with at-rest encryption, audit), 06 (device registration and listing) · **Blocks:** 19, 21 (relay deployment, disclosures). Phase 16 codes against 02's push and relay contract (§9), not against this phase, so it runs in parallel (Wave B).

## Goal

Every org Worker turns a machine's attention event into standard Web Push (RFC 8030,
RFC 8291 `aes128gcm`, RFC 8292 VAPID) to each of the owner's devices, with durable retries
and subscription clean-up. A publisher-run, open-source relay (`cloud/push-relay/`) turns
that Web Push into APNs for iOS (and into FCM if gate G5 fails), so no org ever holds a
publisher credential and nothing past the org's own Worker sees plaintext (D11).

## Evidence

All URLs accessed 2026-11-14.

- **Web Push encryption.** One record, last-record delimiter `0x02`, header = salt 16 +
  rs 4 + idlen 1 + keyid 65 = 86 bytes, plaintext ≤ 3993 for a 4096-byte body; keys from
  `HKDF(auth_secret, ecdh)` with `"WebPush: info\0" || ua_public || as_public`, then
  RFC 8188 CEK (16) and nonce (12). Appendix A has full intermediate test vectors.
  https://www.rfc-editor.org/rfc/rfc8291.html , https://www.rfc-editor.org/rfc/rfc8188.html
- **VAPID.** ES256 JWT, `aud` = push resource origin, `exp` ≤ 24 h, `sub` optional
  (`mailto:` or `https:`); `Authorization: vapid t=<jwt>, k=<b64url P-256 point>`; reuse of
  tokens encouraged; 401 absent / 403 invalid. https://www.rfc-editor.org/rfc/rfc8292.html
- **RFC 8030.** `TTL` required (400 without); `Urgency` `very-low|low|normal|high`;
  `Topic` ≤ 32 base64url chars and replaces an outstanding message with the same topic;
  404 = expired subscription; 429 SHOULD carry `Retry-After`; 413 not allowed at ≤ 4096
  bytes. 410 for unsubscribed endpoints is real-world practice, not RFC text (UNVERIFIED
  in the RFC; handled the same as 404). https://www.rfc-editor.org/rfc/rfc8030.html
- **APNs.** ES256 provider JWT (`kid`; `iss` Team ID, `iat`), refresh no more than every
  20 and no less than every 60 minutes (`TooManyProviderTokenUpdates` 429,
  `ExpiredProviderToken` 403); HTTP/2 `POST /3/device/<token>`; `apns-push-type`,
  `apns-topic`, `apns-priority` 10/5, `apns-expiration`, `apns-collapse-id` ≤ 64 bytes;
  payload ≤ 4096; 410 `Unregistered`/`ExpiredToken`; 400 `BadDeviceToken`,
  `DeviceTokenNotForTopic`. Since 2025-02-17 keys can be topic-specific and bound to one
  environment. https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns ,
  https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns ,
  https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns ,
  https://developer.apple.com/news/?id=wy4tb0uo
- **Notification Service Extension** runs only with `mutable-content: 1` and a visible
  alert; ~30 s; on failure the original alert shows.
  https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
- **HTTP/2 from a Worker.** workerd has none; deployed `fetch` is upgraded by Cloudflare's
  proxy stack and works against APNs, `wrangler dev` does not (kentonv, 2025-08-20,
  "(apparently)"). Not documented: **UNVERIFIED, gate G4.** Raw `connect()` sends no ALPN
  (workerd #8287, 2026-11-08), so h2 over sockets is not a fallback.
  https://github.com/cloudflare/workerd/issues/4841 ,
  https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- **FCM accepts VAPID Web Push directly** with no server credential (Chrome interop post;
  UnifiedPush embedded distributor registers with the VAPID key as sender, endpoint
  `https://fcm.googleapis.com/fcm/send/<token>`); Google does not document it for apps:
  **UNVERIFIED, gate G5.** HTTP v1 fallback: RS256 service-account JWT → OAuth token
  (≈ 3600 s), `POST /v1/projects/<id>/messages:send`, 600k/min per project, data ≤ 4096.
  https://developer.chrome.com/blog/web-push-interop-wins ,
  https://unifiedpush.org/kdoc/embedded_fcm_distributor/ ,
  https://unifiedpush.org/news/20250131_push_for_decentralized/ ,
  https://developers.google.com/identity/protocols/oauth2/service-account
- **UnifiedPush AND_3.1.0**: RFC 8291 required, body 1–4096, endpoint ≤ 1000 bytes, the
  app SHOULD send `vapid` at registration and a distributor may answer `VAPID_REQUIRED`.
  https://unifiedpush.org/developers/spec/android/
- **Mastodon webpush-apn-relay** (Go, public domain): `POST /relay-to/<env>/<hex token>/…`,
  **no VAPID check**, forwards the whole body in a custom key with a fixed alert and
  `mutable-content`, maps `TTL`→expiration, `Topic`→collapse id, low urgency→priority 5,
  replies 201 before APNs answers. We copy the shape and fix its two gaps (unauthenticated
  endpoints, lost 410s). https://github.com/mastodon/webpush-apn-relay
- **Workers limits.** Free: 10 ms CPU per request, 50 subrequests, `waitUntil` ≤ 30 s;
  Paid: 10,000 subrequests. https://developers.cloudflare.com/workers/platform/limits/
- **Queues** are on the Free plan since 2026-02-04 (10,000 operations/day, ≈ 3 per
  message); message 128 KB, batch ≤ 100, retries ≤ 100, `delaySeconds` ≤ 24 h, retention
  24 h on Free; without a DLQ an exhausted message is deleted; consumer CPU on Free
  "30 s" per the Queues page but blank on the Workers page (UNVERIFIED; measured in 19).
  The Deploy button provisions Queues. https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/ ,
  https://developers.cloudflare.com/queues/platform/limits/ ,
  https://developers.cloudflare.com/queues/configuration/batching-retries/ ,
  https://developers.cloudflare.com/workers/platform/deploy-buttons/
- **Rate Limiting binding** GA; `period` 10 or 60; per location, permissive; Wrangler
  ≥ 4.36. Deploy-button support for it is UNVERIFIED (nothing to provision; G11 covers the
  button). https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Web Crypto in Workers**: ECDH, ECDSA (raw `r||s`, i.e. JWS form), HKDF, AES-GCM,
  RSASSA-PKCS1-v1_5. https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- **Secrets**: a Worker cannot write its own secrets without an API token and a redeploy,
  so the org's generated VAPID private key is encrypted at rest in D1 (Phase 04's
  `DATA_KEY` scheme). https://developers.cloudflare.com/workers/configuration/secrets/
- Local research: `research/R5-mobile.md` §3 and "Push architecture"; `research/R4-cloudflare.md`
  ≈ lines 897–958, 1251–1267; `research/cloudflare-parts/05-workers.md` §3, §6–8.

## In scope

The Web Push codec (shared), the org Worker's events route, fan-out, queue consumer,
subscription health, endpoint policy for registration, push settings and mutes, the
publisher relay (APNs primary; FCM per G5; Container/VM runtime per G4), tests, the
disclosure list for 21 and threat facts for 17.

## Out of scope

- Device registration routes, device listing and the `PATCH` that sets mutes: **06**
  (calls this phase's endpoint policy and reads its columns).
- VAPID key generation at setup, admin console rendering of push settings, VAPID rotation
  UI: **07**. Signed machine middleware, D1 base schema, settings encryption, audit
  helper: **04**. Wire schemas: **02**.
- The machine-side emitter: **12**. Device-side keys, decryption, NSE, notification
  display and removal: **16**.
- Relay hosting account, APNs key creation, store disclosures: **21**. Pipelines: **18**.
  Consumer docs and threat-model rows: **17**.

## Design

### Shared codec in `cloud/protocol` (Phase 02's package)

`webpush/ece.ts` (encrypt and decrypt, RFC 8291 + 8188 single record, fresh ephemeral
key per message as RFC 8291 §3.1 requires) and `webpush/vapid.ts` (sign, parse header,
verify) live in the shared package because three suites use them: the Worker encrypts and
signs, the relay verifies, and every test suite (Worker, relay, Kotlin, Swift) decrypts the
shared vectors. Pinned by `fixtures/webpush/rfc8291-appendix-a.json` (the RFC's own
vectors) plus generated vectors for our payload sizes and for VAPID (valid, expired,
`exp` > 24 h, wrong `aud`, wrong `k`). Base64url and JSON helpers are 02's, reused.

### Org Worker: from event to push

```text
POST /v1/machine/events (W6, signed, 04 middleware ⇒ machine row, owner)
  ├─ RL MACHINE_EVENTS (60/60 s per machine id) ⇒ 429 rate_limited + Retry-After
  ├─ validate 02 `EventBatch` (always a batch, maxItems 16) ⇒ 400 validation_failed
  ├─ dedupe by event `id` (24 h, table event_ids) ⇒ split into accepted / duplicates
  ├─ Settings.push.enabled? else 202 EventBatchResult{accepted, duplicates, push_enabled:false}
  │   (nothing queued)
  ├─ select owner's devices: subscription present, push_state ∉ {gone, auth_failed, none},
  │   02's mute rule (!mute_all && (muted_until == null || now ≥ muted_until)),
  │   machine ∉ muted_machine_ids,
  │   relay channels only if Settings.push.relay_allowed (and origin in allowed_relays)
  └─ PUSH_QUEUE.sendBatch([{device_id, payload, urgency, topic, ttl, enqueued_at}])
       ⇒ 202 EventBatchResult{accepted, duplicates, push_enabled:true}
PUSH_QUEUE consumer (batch ≤ 10, max_retries 8)
  ├─ one D1 read for the batch's devices; re-check mute/state (it may have changed)
  ├─ ece.encrypt(payload, p256dh, auth); vapid JWT for endpoint origin (isolate cache)
  ├─ fetch(endpoint, POST, TTL/Urgency/Topic/Content-Encoding/Authorization,
  │        redirect:"manual", AbortSignal.timeout(10 s))
  └─ classify ⇒ ack | retry(delay) | mark gone | mark auth_failed | drop(bug)
```

- **Why Queues, not `waitUntil`.** `waitUntil` dies with the isolate after 30 s and cannot
  delay a retry by a `Retry-After`; Queues give durable retries with `delaySeconds`, a
  15-minute consumer wall clock, and are now on Free. Batch size 10 keeps a Free-plan
  consumer under 50 subrequests (10 pushes + internal D1 calls, which have their own
  1,000 cap). Free-plan budget is ≈ 3,300 pushes/day/account (10,000 operations ÷ 3); 17
  documents it and the admin console (07) shows the day's count from `push_stats`.
- **Payload.** 02's `PushPayload` (§9) built by 02's `src/push/payload.ts` from the `Event`
  plus the machine id, with `s` the event's token (never prose). The plaintext hard cap is
  **320 bytes** (02 §9, R3), which keeps the encrypted body ≤ 423 bytes, far inside every
  channel's limit and the relay's APNs budget below; an over-cap payload is a bug, logged
  and dropped. When `Settings.push.detail = minimal` the Worker omits `p` and `l` even if
  the event carried them (yaran already omits them per `MachineConfig.push.detail`; this is
  the server-side backstop for a stale machine config).
- **Headers.** `TTL` = `Settings.push.ttl_seconds` (default 3600; an `attention_cleared`
  uses the same TTL so it can replace a queued raise; the `test` push uses 300). `Topic` =
  02's `topic(m, a, t)` (`src/push/topic.ts`: first 32 chars of
  `base64url(SHA-256("yaran-topic-v1\n" + m + "\n" + a + "\n" + (t or "")))`): per-tab
  collapse that includes the agent id, so two agents' slot tabs (tab id omitted) never
  share a key, and opaque to every push service; the same value is the APNs collapse id,
  the APNs `thread-id` and the Android notification tag (02 §9, 16). `Urgency`: `high` for
  `attention_raised` and `agent_exited_badly`, `very-low` for `attention_cleared` (a
  cleared event shows nothing, FCM demotes silent high-priority messages, and the relay
  turns `very-low` into an APNs background push for 16's removal handler), `normal` for
  `test` (no `Topic`).
- **VAPID.** JWT `aud` = endpoint origin, `exp` = now + 12 h, `sub` = the Worker's own
  `https://` origin (no admin email leaves the org), cached per origin until `exp − 1 h`.
  The private key is decrypted once per isolate from 04's encrypted settings.
- **Response classification** (exhaustive union `SendOutcome`):

| Push service answer | Action |
|---|---|
| 200/201/202 | ack; `push_state = active` (written only on change); `last_push_ok_at` (served as `Device.push.last_success_at`) at most hourly (saves D1 writes on Free) |
| 404, 410 (including the relay's `410 push_endpoint_gone` and `404 relay_endpoint_invalid`) | clear the subscription fields, `push_state = gone`, **row kept**, audit `device.push_gone`, ack (R11) |
| 401, 403 (including the relay's `relay_vapid_invalid` / `relay_vapid_mismatch`) | `push_state = auth_failed` (VAPID key mismatch, e.g. after rotation), audit `device.push_auth_failed`, ack |
| 400, 413 | ack, `error` log with status and a sanitized body excerpt (a bug, never retried) |
| 429 | `retry({delaySeconds: clamp(Retry-After ?? 60, 10, 3600)})` |
| 5xx (including the relay's `502 relay_upstream_failed` and `503 unavailable`), network, timeout | `retry({delaySeconds: min(10·2^attempts, 900)})` |
| any retry past `max_retries` or past `enqueued_at + ttl` | ack, `consecutive_failures += 1`; at 5, `push_state = failing` and audit `device.push_failing` |

- **Gone means re-register, out loud.** Guidance said "delete device" on 404/410. This plan
  keeps the device row and clears only its subscription, because the row is also what the
  user and admin consoles list and revoke (06): the phone sees `push_state: gone` on its
  next `GET /v1/me/devices` and re-registers (16, W12 upsert by `install_id`), and the
  console says "push stopped: the subscription expired" instead of the device silently
  vanishing. A push answer never revokes or deletes a device (02 §9).
- **Duplicates are harmless**: the event `id` dedupe drops machine retries, Topic collapses
  queued duplicates, and devices key notifications by the same Topic (16).
- **Test push (W15, `POST /v1/me/devices/{id}/test`, capability `devices.test_push`).**
  The user's own device only (else `404 not_found`); `409 push_disabled` when
  `Settings.push.enabled` is false; otherwise one `k: test` payload through the same queue
  (Urgency `normal`, TTL 300, no Topic) and `202`; audit `device.test_push`.

### Endpoint policy (called by 06 at registration)

`push/endpoint_policy.ts` is the one answer to "may this Worker push to this URL":
`https:` only, no userinfo, port 443 or none, ≤ 2048 bytes (02's `DeviceRegistration`
bound; UnifiedPush endpoints are ≤ 1000), host not an IP literal and not under the org's
own `<zone>` (the Worker never pushes into its own machines; 04 also sets
`global_fetch_strictly_public`); channel coherence (`fcm_embedded` must be
`fcm.googleapis.com` under `/fcm/send/` or `/wp/`; `apns_relay` and `fcm_relay` must match
02's relay endpoint shape `https://<host>/w/v1.<kid>.<opaque>` and must not be
`fcm.googleapis.com`); `p256dh` must import as a P-256 ECDH public key (65 bytes, `0x04`,
on the curve); `auth` exactly 16 bytes. Refusals are `400 push_endpoint_invalid`. Relay
channels are refused with `409 push_relay_disallowed`, `details.reason: disabled` when
`Settings.push.relay_allowed` is false and `not_allowlisted` when
`Settings.push.allowed_relays` is non-empty and does not contain the endpoint's origin.
(The relay's `registration_id` is sent only to the relay at mint; the Worker never sees
or checks it.)

### Settings and mutes

Org settings are 02's `Settings.push` (04's table, rendered by 07, documented inline
there): `enabled` (default true), `detail` (`names` | `minimal`, default `names`),
`ttl_seconds` (default 3600, 60–86,400), `relay_allowed` (default true; an org that must
not let the publisher see device tokens turns it off and iOS users lose push, said plainly
in the console), `allowed_relays` (https origins; empty = any). Per device, 02's mute
fields: `mute_all` (per-org, indefinite), `muted_until` (per-org, timed: a `Timestamp` or
`null`, no sentinel values) and `muted_machine_ids` (per-machine, ≤ 100), stored as device
columns plus a `device_machine_mutes` table. One registration per org (16), so a per-org
mute is that registration's `mute_all`/`muted_until`; a per-machine mute is a row. The API
is 02's, implemented by 06 and enforced here at fan-out and again at send:
`PATCH /v1/me/devices/{id}` (W31, `DevicePatch {label?, mute_all?, muted_until?,
muted_machine_ids?}` → `Device`) and `GET /v1/me/devices` (W13), whose `Device` carries
`push_state` (`active | gone | auth_failed | failing | none`) and `push.vapid_public_key`
(the org key the subscription was registered against). The org's current key is
`Meta.push.vapid_public_key` (W1), which the app needs for UnifiedPush's `vapid`
parameter, the embedded FCM registration and relay minting, and compares with
`Device.push.vapid_public_key` to detect a rotation (16).

### The publisher relay (`cloud/push-relay/`)

Open source in this repo, optional per build: the relay origin is a build-time app
setting (`<publisher-relay>`, D16; Phase 19 hook H6, whose mobile half is 14's build
config). One deployment serves every org.

**Meta** — `GET /v1/meta` (R1) → `RelayMeta {service: "yaran-push-relay", protocol,
apps, channels, endpoint_key_id}`: `apps` from `APNS_TOPICS` (and the Play application id
when the G5 fallback is deployed), `channels` `[apns]` or `[apns, fcm]`, `endpoint_key_id`
the current `kid`.

**Mint** — `POST /v1/endpoints` (R2) from the app's native code, body 02's
`EndpointMintRequest`: `{kind:"apns", app_id, apns_token, apns_environment:
"production"|"sandbox", vapid_public_key, registration_id}` (or, under the G5 fallback,
`{kind:"fcm", app_id, fcm_token, vapid_public_key, registration_id}`) → `201
EndpointMintResponse {endpoint:"https://<publisher-relay>/w/v1.<kid>.<opaque>"}`.
`opaque` = `base64url(nonce12 ‖ AES-256-GCM(ENDPOINT_KEYS[kid], compactJSON{p,t,e,b,k,r},
aad="yaran-relay-endpoint-v1"))` (p kind, t token, e environment, b app id, k VAPID key,
r registration id; this inner format is 08's), about 350 characters. `app_id` must be in
`RelayMeta.apps`, else `400 relay_app_unknown`; an `fcm` mint while `fcm` is not in
`channels` is `400 validation_failed`. The relay stores nothing: no org registry, no device
table. Minting is rate-limited per client IP (the only key an anonymous call has; `429
rate_limited`). Key rotation: new `kid` becomes current; old kids stay decryptable until
every app version has re-minted. The app re-mints when its endpoint's `kid` differs from
`RelayMeta.endpoint_key_id`, or when the org reports `push_state: gone` for that device
(the relay's `410`/`404` reach the org Worker, never the app) (16).

**Receive** — `POST /w/<endpoint>` (R3) from any org Worker:

1. Parse and decrypt the endpoint (unknown kid or bad tag → `404 relay_endpoint_invalid`).
2. Require `Content-Encoding: aes128gcm` and `TTL` (`400 bad_request`), body ≤ 2,900
   bytes (`413 payload_too_large` above: the base64 body plus JSON must fit APNs' 4096;
   this is a documented deviation from RFC 8030's 4096 floor, since the relay only serves
   yaran payloads of ≤ 423 bytes).
3. VAPID: `k` must equal the embedded key (constant-time byte compare, else `403
   relay_vapid_mismatch`); JWT ES256 verifies against it; `aud` equals the relay's
   configured `PUBLIC_ORIGIN`; `exp` in the future and ≤ now + 24 h + 60 s skew (else
   `401 relay_vapid_invalid`). A leaked endpoint is useless without that org's VAPID
   private key.
4. Rate limits (bindings, 60 s): per `SHA-256(vapid_public_key)` (default 600) and per
   `SHA-256(device token)` (default 60) → 429 `Retry-After: 60`.
5. Build the APNs request (below) and wait for APNs' answer (unlike Mastodon's relay, so
   410s reach the org).

**APNs request** (02 §9 is normative; pinned by `fixtures/push/relay-wrapping.json`).
Host by `e`; `apns-topic` = `b` (the `app_id`); `apns-expiration` = now + TTL (0 stays 0);
`apns-collapse-id` = the `Topic` header when present; for `Urgency` `high`/`normal`:
`apns-push-type: alert`, priority 10 for `high` and 5 for `normal` (the `test` push),
body
`{"aps":{"alert":{"title-loc-key":"PUSH_GENERIC_TITLE","loc-key":"PUSH_GENERIC_BODY"},"mutable-content":1,"sound":"default","thread-id":"<Topic or 'yaran'>"},"v":1,"r":"<registration_id>","y":"<b64url body>"}`
(the localized generic text, from the app's own `Localizable.strings` keys that 16 ships,
is what shows if the NSE fails; `title-loc-key`/`loc-key` support is UNVERIFIED and
checked in 16 on device); for `low`/`very-low` (every `attention_cleared`):
`apns-push-type: background`, priority 5, `{"aps":{"content-available":1},"v":1,"r":…,"y":…}`
so the app can remove a delivered notification (best effort: iOS throttles background
pushes; 16 documents it). `r` tells the NSE which org registration's keys to use.

**Provider JWT.** `iat` is the start of the current 30-minute bucket, so every isolate
signs the same claims and a token is never older than 30 minutes; cached per isolate per
bucket. Whether concurrent isolates with distinct signatures trip
`TooManyProviderTokenUpdates` is **UNVERIFIED**; G4 runs a concurrency burst. Fallback:
a single Durable Object mints and hands out the token.

**Answer mapping** (02 error codes). APNs 200 → 201 Created. 410 → `410
push_endpoint_gone`. 400 `BadDeviceToken` / `DeviceTokenNotForTopic` → `410
push_endpoint_gone` (the endpoint can never work). Other 400 → `400 bad_request`. 413 →
`413 payload_too_large`. 429 → `429 rate_limited`, `Retry-After: 60`. 403 provider-token
errors → `502 relay_upstream_failed` and an `error` log naming the reason (publisher
misconfiguration). 5xx or network → `503 unavailable`, `Retry-After: 60`.

**Logging.** Never a token, endpoint, JWT or body. Fields: outcome, APNs status and reason,
`kid`, the first 8 hex of `SHA-256(vapid_public_key)`, environment. `observability` on with a
configurable head sampling rate.

**G4 fallback (APNs over Worker fetch fails).** The relay is written as a runtime-agnostic
core (`Request → Response`, Web Crypto only) behind an `ApnsTransport` interface. Primary
transport: Worker `fetch`. Fallback: `transport_http2.ts` on `node:http2` with a pooled
session per host, run by `src/runtime/node.ts` (Node 22) in `container/Dockerfile`,
deployed either on Cloudflare Containers behind the same Worker hostname (the Worker
forwards `/w/*` to the container) or on any VM behind the same DNS name. Endpoints do not
change, so no app update is needed. Rate limiting in the Node runtime is an in-process
token bucket behind the same `Limiter` interface (single instance, stated).

**G5 fallback (direct VAPID to FCM fails for Play builds).** The Play flavor mints a relay
endpoint with its FCM token (`kind: "fcm"` mint, device channel `fcm_relay`). The relay
holds an FCM service account (secret), mints an RS256 JWT, exchanges it for an access token
cached until `expires_in − 300 s`, and sends 02's data message
`{data:{v:"1", r:"<registration_id>", y:"<b64url body>"}, android:{priority: "high" for Urgency high else "normal", ttl:"<TTL>s", collapse_key: Topic}}`.
FCM `UNREGISTERED`/404 → `410 push_endpoint_gone`; 429 → `429 rate_limited`. The app
shows a notification for every high-priority message, so FCM does not demote it (cleared
events are `very-low`, so they go as `normal`).

**Configuration** (`wrangler.jsonc`, every key commented inline): vars `PUBLIC_ORIGIN`,
`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_TOPICS`, `ALLOWED_ENVIRONMENTS`, `FCM_PROJECT_ID`
(fallback only); secrets `APNS_P8`, `ENDPOINT_KEYS` (JSON `{current, keys:{kid:b64}}`),
`FCM_SERVICE_ACCOUNT` (fallback only); rate-limit bindings `MINT_RL`, `KEY_RL`,
`DEVICE_RL`. `workers_dev = false`, `preview_urls = false` (the relay is the publisher's
own Worker; D19's `workers.dev` bootstrap applies only to the org Worker). A `staging`
environment block (own `PUBLIC_ORIGIN`, sandbox APNs key) is what Phase 19 deploys and
points test builds at (H6). The APNs key is topic-specific
and bound to one environment per Apple's 2025 key types (production key for store builds;
a second relay deployment, or a sandbox key, for development builds).

**Disclosures for 21** (Play Data Safety, Apple privacy labels, privacy policy, F-Droid
anti-features review): the relay sees the APNs or FCM device token, the build environment,
the org's VAPID public key (which lets the publisher group devices by org,
pseudonymously), the org Worker's egress IP (Cloudflare's), timing, volume, coarse urgency
(alert or background) and an opaque per-tab collapse id. It never sees payload plaintext,
user identity, machine names or agent names. Apple sees the same through APNs; Google sees
the same for FCM channels; a UnifiedPush distributor sees its own endpoint traffic. The
`foss` flavor never touches the relay.

## Work items

Every file below starts with the 00-CONVENTIONS §2 header (title, responsibilities,
generated `Uses`/`Used by` trees) and is planned ≤ 500 lines.

1. **Web Push codec in `cloud/protocol`.**
   - Create `cloud/protocol/src/webpush/ece.ts` (~220): `encrypt(plaintext, uaPublic,
     authSecret, {rs, salt?, asKeyPair?})`, `decrypt(...)` (tests and tooling). Uses 02's
     base64url; Used by `cloud/worker/src/push/send.ts`, relay tests, protocol tests.
   - Create `cloud/protocol/src/webpush/vapid.ts` (~200): `signVapid`, `parseVapidHeader`,
     `verifyVapid`. Used by `push/send.ts`, `push-relay/src/core/receive.ts`.
   - Create `cloud/protocol/fixtures/webpush/{rfc8291-appendix-a,payload-vectors,vapid-vectors}.json`
     (generated, marked generated) and the generator `cloud/protocol/scripts/gen-webpush-vectors.ts` (~150).
   - Tests: `cloud/protocol/test/webpush.test.ts`: Appendix A byte-exact (CEK, nonce, body);
     round trip at 1 and 3993 bytes; 3994 refused; tampered tag fails; delimiter ≠ `0x02`
     fails; VAPID valid/expired/`exp` > 24 h/wrong aud/wrong k.
2. **D1 migration and push settings.**
   - Create `cloud/worker/migrations/<next>_push.sql` (numbered after 04/06's): device
     columns `push_state` (CHECK `active|gone|auth_failed|failing|none`; 04 may already
     own the column, then this migration only adds what is missing), `last_push_ok_at`,
     `consecutive_failures`, `mute_all`, `muted_until`; tables
     `device_machine_mutes(device_id, machine_id, PRIMARY KEY(...))`,
     `event_ids(id PRIMARY KEY, machine_id, seen_at)` (24 h dedupe, purged by the
     consumer's scheduled sweep), `push_stats(day, accepted, delivered, failed, gone)`.
   - Create `cloud/worker/src/push/settings.ts` (~100): typed accessors over 04's settings
     for 02's `Settings.push` (defaults, bounds). Uses 04's settings module.
   - Tests: migration applies on an empty and on a 06-populated database; bounds.
3. **Endpoint policy.** Create `cloud/worker/src/push/endpoint_policy.ts` (~160), used by
   06's device routes. Tests: table of accepted/refused URLs and keys, including an IP host,
   port 8443, userinfo, own-zone host, 2049-byte URL, a 64-byte `p256dh`, an off-curve
   point, a relay channel whose URL lacks the `/w/v1.<kid>.<opaque>` shape, relay channels
   while `Settings.push.relay_allowed = false` (`push_relay_disallowed`, reason
   `disabled`) and a relay origin outside a non-empty `allowed_relays` (reason
   `not_allowlisted`).
4. **Events route and fan-out.**
   - Create `cloud/worker/src/push/events_route.ts` (~180): W6 handler registered on 04's
     router behind the signed-machine middleware; `EventBatch` validation with 02's
     validator; `id` dedupe; `EventBatchResult`.
   - Create `cloud/worker/src/push/test_route.ts` (~80): W15 test push.
   - Create `cloud/worker/src/push/fanout.ts` (~200): device selection SQL, 02's mute rule,
     Topic via 02's `topic()`, payload via 02's `payload.ts` (with the `detail = minimal`
     strip), `sendBatch` in chunks of 100.
   - Touch `cloud/worker/wrangler.jsonc` (04's): queue producer/consumer `PUSH_QUEUE`
     (`max_batch_size: 10`, `max_retries: 8`, `max_batch_timeout: 5`, commented), rate
     limit `MACHINE_EVENTS`. Touch 04's router file: two route lines, one `queue` export.
   - Tests (`@cloudflare/vitest-pool-workers`): unsigned/revoked machine refused (04's
     middleware, asserted here end to end); `mute_all`, an unexpired and an expired
     `muted_until`, and a muted machine each behave per 02's rule; `Settings.push.enabled =
     false` → 202 `push_enabled: false` and nothing queued; a repeated event `id` lands in
     `duplicates` and queues nothing; relay devices skipped when disallowed; `detail =
     minimal` strips `p`/`l`; rate limit → 429; a 17-event batch → 400
     `validation_failed`; owner with no devices → 202 with the ids in `accepted`; W15 on
     another user's device → 404, with push off → `409 push_disabled`.
5. **Consumer and sender.**
   - Create `cloud/worker/src/push/send.ts` (~200): request builder, VAPID cache,
     `SendOutcome` classifier (exhaustive, `assertNever`).
   - Create `cloud/worker/src/push/consumer.ts` (~240): batch device read, re-checks,
     ack/retry/state writes, `push_stats`, audit via 04's helper.
   - Tests with Miniflare outbound fetch mocks: every row of the classification table;
     `Retry-After` honoured and clamped; TTL expiry acks; state written only on change;
     plaintext never appears in a log line (spy on `console`); the request decrypts with
     the device's keys using `ece.decrypt` (round trip against the real codec).
6. **Relay core and APNs.**
   - Create under `cloud/push-relay/`: `package.json`, `tsconfig.json` (strict),
     `wrangler.jsonc`; `src/core/handler.ts` (~150, routes), `src/core/endpoint_codec.ts`
     (~150), `src/core/mint.ts` (~160), `src/core/receive.ts` (~240), `src/core/limits.ts`
     (~120, `Limiter` interface + binding and in-memory implementations),
     `src/apns/jwt.ts` (~100), `src/apns/payload.ts` (~120), `src/apns/client.ts` (~180,
     answer mapping), `src/apns/transport.ts` (~60, interface + fetch transport),
     `src/runtime/worker.ts` (~80, entry point).
   - Tests: `RelayMeta` shape; mint → receive round trip for both `EndpointMintRequest`
     kinds; unknown `app_id` → `400 relay_app_unknown`; unknown kid/bad tag → `404
     relay_endpoint_invalid`; `k` mismatch → `403 relay_vapid_mismatch`; wrong aud, expired
     JWT → `401 relay_vapid_invalid`; 2,901-byte body → 413; missing TTL → 400; payload ≤
     4096 at the maximum body; every APNs answer mapping; alert priority 10 for `high` and 5
     for `normal`; background for `low`/`very-low`; bodies byte-equal to
     `fixtures/push/relay-wrapping.json`; collapse id and `thread-id` from Topic; token,
     endpoint and JWT absent from logs; 30-minute `iat` buckets.
7. **Fallback runtimes (fully built, not stubs).**
   - Create `cloud/push-relay/src/apns/transport_http2.ts` (~160),
     `src/runtime/node.ts` (~150), `container/Dockerfile`, and
     `src/fcm/{oauth.ts (~120), client.ts (~200)}`.
   - Tests: the core suite runs a second time against the Node runtime with a local
     `node:http2` mock APNs server; FCM OAuth exchange and send against a mock, including
     `UNREGISTERED` → 410 and token caching.
   - Which runtime is deployed and whether `fcm_relay` is offered is decided by G4/G5 and
     recorded in 21; both paths ship in every release.
8. **Hand-offs.** Facts for 17's threat model, under 17's IDs: relay endpoint abuse
   (mitigated by VAPID binding and rate limits) → **T40**; Worker as an SSRF client
   (endpoint policy, strictly-public fetch) → **T57**; metadata disclosure to relay/Apple/
   Google/distributors → **T39**, and event metadata in plaintext at the org Worker and D1
   → **T59**; org VAPID key compromise (rotate in 07; devices go `auth_failed` and
   re-register) → **T41**; publisher APNs key compromise (revoke in Apple's console; relay
   redeploy) → **T40**; cross-user device mute/`push_state` access → **T34**; push columns
   and `event_ids` in D1 → **T55**; sanitized upstream bodies in logs → **T53**.
   Disclosure list above for 21. Free-plan push budget for 17's docs. The relay's `staging`
   environment and `PUBLIC_ORIGIN` for 19 (H6, with 14's mobile build config).

## Acceptance

- [ ] RFC 8291 Appendix A vectors pass byte for byte in the TS suite; 16's Kotlin and
      Swift suites read the same fixture files.
- [ ] A signed event for a machine with an Android `foss` device, a Play device and an iOS
      device yields three pushes; each decrypts on its device (verified in 19).
- [ ] 404/410 clears the subscription, marks the device `gone` and keeps its row, and the
      phone re-registers on its next refresh; 401/403 marks `auth_failed`; 429 and 5xx
      retry with the documented delays.
- [ ] Mutes (`mute_all`, `muted_until`, `muted_machine_ids`), `Settings.push.enabled`,
      `relay_allowed` and `allowed_relays` are honoured at fan-out and re-checked at send.
- [ ] `attention_cleared` goes out with `Urgency: very-low` and reaches iOS as an APNs
      background push; every Topic equals 02's `topic(m, a, t)` fixture value.
- [ ] The relay rejects any push whose VAPID JWT does not verify against the key embedded
      in its endpoint, and propagates APNs 410 as 410.
- [ ] No log line in the Worker or the relay contains a device token, endpoint, JWT, key
      or payload plaintext (asserted in tests, spot-checked in Workers Logs in 19).
- [ ] G4 and G5 outcomes recorded; the chosen runtime and channel set are deployed; the
      fallback paths' test suites pass regardless.
- [ ] Every new file ≤ 500 lines with a passing `module-headers --check`.

## Validation

```bash
cd /Users/siavash/Projects/yaran
# package manager per Phase 02's choice; npm shown
npm --prefix cloud/protocol run typecheck && npm --prefix cloud/protocol test
npm --prefix cloud/worker run typecheck && npm --prefix cloud/worker test -- push
npm --prefix cloud/push-relay run typecheck && npm --prefix cloud/push-relay test
npm --prefix cloud/push-relay run test:node      # fallback runtime suite
npx --prefix cloud/worker wrangler d1 migrations apply DB --local
node tools/module-headers/bin/module-headers.mjs --check cloud/protocol cloud/worker cloud/push-relay
node tools/module-headers/bin/module-headers.mjs --lines --check
find cloud/protocol/src/webpush cloud/worker/src/push cloud/push-relay/src -name '*.ts' \
  -exec wc -l {} + | sort -n | tail -5
# live (Phase 19 / G4): deployed relay against api.sandbox.push.apple.com
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Worker `fetch` stops reaching APNs over HTTP/2 (undocumented) | Medium | iOS push down | G4; Node/Container transport built and tested; endpoints unchanged |
| Direct VAPID to FCM unsupported or withdrawn | Medium | Play push down | G5; `fcm_relay` path built and tested |
| Free-plan Queue budget (≈ 3,300 pushes/day) exhausted | Low–Medium | Pushes delayed/dropped | Documented; `push_stats` in the admin console; Paid removes it |
| Free-plan consumer CPU lower than the Queues page states | Medium | Retries | Measured in 19; batch size is config |
| Concurrent isolates trip `TooManyProviderTokenUpdates` | Low | Relay 502s | 30-minute `iat` buckets; DO token holder fallback |
| Anonymous minting used to spam a known device token | Low | Generic-text spam | Token is secret to device and relay; per-device and per-key limits; NSE drops undecryptable pushes (16) |
| Background "cleared" pushes throttled by iOS | High | Stale notification | Collapse id replaces it on the next event; phone shows age (16) |
| VAPID rotation breaks every subscription at once | Certain on rotation | Push gap | `auth_failed` state drives re-registration; 07 warns before rotating |

## References

- 00-README.md D11, D16, D17, flow 5; 00-CONVENTIONS.md; phase-guidance §08.
- `research/R5-mobile.md` §3, "Push architecture"; `research/R4-cloudflare.md`;
  `research/cloudflare-parts/05-workers.md`.
- RFC 8030, 8188, 8291, 8292; Apple APNs and NSE docs; FCM HTTP v1 and Google OAuth service
  accounts; UnifiedPush AND_3.1.0; mastodon/webpush-apn-relay; workerd #4841 and #8287;
  Cloudflare Workers limits, Queues, Rate Limiting, Web Crypto, Deploy buttons (all URLs in
  Evidence, accessed 2026-11-14).
- Phases 02, 03 (G4, G5), 04, 06, 07, 12, 16, 17, 18, 19, 21.

## Reconciliation notes (2026-11-14)

- R20: header no longer lists 16 under Blocks (16 codes against 02 §9 in parallel, Wave B); Depends-on names 02's schemas.
- R9: events route validates 02's batched `EventBatch` (maxItems 16), dedupes by event `id` for 24 h (new `event_ids` table) and answers `EventBatchResult {accepted, duplicates, push_enabled}` (replaces `{accepted:0, reason:"push_disabled"}`).
- R3: payload hard cap 320 bytes stated (≤ 423 B ciphertext), replacing "≤ ~400 bytes"; `Settings.push.detail = minimal` strips `p`/`l` server-side.
- 02 §9: Topic is `topic(m, a, t)` (adds the agent id; the old `machine_id ‖ 0x00 ‖ tab_id` collapsed two agents' slot tabs); same value is the APNs collapse id, `thread-id` and Android tag.
- R9: `attention_cleared` now `Urgency: very-low` (was `low`) and relayed as an APNs background push; `test` push is `normal`, TTL 300, no Topic; APNs alert priority 10 only for `high`, 5 for `normal`.
- R9/R11: `push_state = ok` → `active`; 404/410 (incl. relay `push_endpoint_gone`, `relay_endpoint_invalid`) clear the subscription, mark `gone`, keep the row; audits `device.push_auth_failed`, `device.push_failing` named.
- R9: settings renamed to `Settings.push.{enabled, detail, ttl_seconds, relay_allowed, allowed_relays}`; per-device mutes are 02's `mute_all` / `muted_until` (Timestamp or null, `-1` sentinel removed) / `muted_machine_ids` via W31 `DevicePatch`; "For 02/06" request replaced by the 02 API it became; `vapid_public_key` from `Meta.push` and `Device.push`.
- 02: endpoint policy drops the `rid` check (the Worker never sees `registration_id`), uses 02's 2048-byte bound (test 1001 → 2049 bytes), checks the relay endpoint shape, and refuses relays with `push_relay_disallowed` `details.reason: disabled|not_allowlisted`.
- 02: relay mint uses `EndpointMintRequest {kind: apns|fcm, app_id, apns_token|fcm_token, apns_environment, vapid_public_key, registration_id}`; `RelayMeta` (R1) described; re-mint triggers are `endpoint_key_id` change or `push_state: gone` (the app never sees relay 410s).
- 02: APNs body uses `title-loc-key PUSH_GENERIC_TITLE` / `loc-key PUSH_GENERIC_BODY` and `thread-id` (was `YARAN_PUSH_GENERIC`); relay answers named with 02 codes (`relay_vapid_invalid`, `relay_vapid_mismatch`, `relay_endpoint_invalid`, `relay_app_unknown`, `push_endpoint_gone`, `relay_upstream_failed`, `unavailable`).
- 02: G5 channel `relay_fcm` → `fcm_relay`; FCM data message `{v:"1", r, y}`.
- 02 W15: added the test-push route (`test_route.ts`) this phase owns per 02's endpoint inventory, with tests.
- R14: hand-off threat facts mapped to T34, T39, T40, T41, T53, T55, T57, T59 (replacing "append from T25").
- R15/R20: Phase 19 hook H6 (relay URL as build config) covered by the relay's `staging` environment and `PUBLIC_ORIGIN`; mobile half stays with 14.

### Straggler pass (2026-11-14)

- Straggler pass: Validation uses 01's real CLI (`node tools/module-headers/bin/module-headers.mjs --check <paths>` and `--lines --check`) (R20). H6 work item verified (R15).

# Phase 02 — Protocol contract and shared `cloud/protocol` package

**Track:** Wave A (foundation) · **Parallel-safe with:** 01, 03
**Depends on:** nothing · **Blocks:** 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16 (all of them code against this document)

## Goal

Define, once and completely, every byte that crosses a process boundary between the org Worker,
the publisher push relay, a developer's yaran, and the phone apps, and ship it as code:

- a TypeScript package `cloud/protocol/` (JSON Schemas as the source of truth, OpenAPI 3.1
  documents, generated types, runtime validators, the sealed-envelope and signature codecs,
  push payload, URI and UA helpers, error registry);
- a Rust module `yaran_core::cloud::protocol` that implements the machine side (types, request
  signing, envelope sealing, UA parsing) and is tested against the **same fixtures**;
- `cloud/protocol/fixtures/`, the platform-neutral test vectors every suite (Rust, Worker,
  relay, Capacitor shell, Kotlin, Swift) must pass.

This document is the contract. A Wave B phase that needs a change edits the schema, the
fixtures and this document in the same PR (the same rule `00-README.md` applies to decisions).

## Evidence

Current tree (re-read 2026-11-14):

- **No cloud code exists**: no `cloud` module in `crates/` (`crates/yaran-core/src/lib.rs`, 128
  lines, declares none) and no top-level `cloud/` directory.
- **Crypto already compiled in, but only transitively.** `ring` 0.17.14 arrives via
  `ureq 3.3.0` (`crates/yaran-core/Cargo.toml:49`) → `rustls` 0.23.46; `base64` 0.22.1 via
  axum/ureq. Making both **direct** dependencies of `yaran-core` adds no new crate to
  `Cargo.lock`. `p256`, `aes-gcm`, `ed25519-dalek`, `hkdf`, `jsonschema`, `schemars` and
  `typify` are not in the lockfile. `deny.toml:70-96` allows MIT/Apache-2.0/ISC/BSD, which
  covers `p256` 0.14 and `aes-gcm` 0.11 (dev-only here).
- **Shared fixture precedent.** `crates/yaran-core/src/prose.rs:339-349` reads
  `tests/fixtures/prose_cross_language.json` at test time through
  `Path::new(env!("CARGO_MANIFEST_DIR")).join(...)`, and
  `crates/yaran-web/web/src/lib/prose.test.tsx:74-80` reads the same file with `readFileSync`.
  This phase copies that pattern with `cloud/protocol/fixtures/`.
- **yaran-web errors are plain text** (`(StatusCode, String)`, e.g.
  `crates/yaran-web/src/rest_common.rs:257`, `crates/yaran-web/src/host_guard.rs:262`). The
  JSON error envelope below is **scoped to the cloud protocol** (Worker, relay, and yaran's
  `/__yaran/handoff`); existing `/api/v1/*` routes keep text bodies.
- **Serde house style** is `snake_case` fields and internally tagged enums
  (`crates/yaran-core/src/wire.rs:55`, `:913-969`; `viewmodel.rs:470` uses
  `#[serde(tag = "kind", rename_all = "snake_case")]`). The wire format below follows it:
  snake_case keys, `kind` discriminators.
- **Ids.** Session and tab ids are UUID v4 strings, in-engine typed as `SessionId`/`TabId`
  (`crates/yaran-core/src/ids.rs:224-225`), plain strings on every wire (`ids.rs:12-13`), at
  most `MAX_ID_LEN = 128` (`crates/yaran-web/src/rest_common.rs:44`).
- **Deep links.** The web hash grammar is `#/agent/<sid>` and `#/agent/<sid>/tab/<tid>`
  (`crates/yaran-web/web/src/store.ts:2109`); the writer emits the first (slot) tab as the bare
  `#/agent/<sid>` (`store.ts:2172`, `:2193-2198`). So push payloads omit the tab id for the
  slot tab.
- **Attention and verdicts.** `apply_attention_decision` (`crates/yaran-core/src/engine/mod.rs:1302`)
  over `needs_attention: HashSet<TabId>` (`:610`); row states
  `RowState { NeedsAttention, Typing, Busy, Idle, Detached, Exited }`
  (`crates/yaran-core/src/row_state.rs:18`); bad-exit endings with wire kinds
  `launch_failed | exited | exited_unknown | rapid_clean_exit`
  (`crates/yaran-core/src/tab_verdict.rs:35`, `:54`).
- **Server identity** is `GET /api/v1/build → { version, process }`
  (`crates/yaran-web/src/build_routes.rs:34-47`); there is no `/__yaran` route today
  (`crates/yaran-web/src/server.rs:776-814`).
- **Device labels** parse UA strings in two mirrored places: `short_device_label`
  (`crates/yaran-core/src/device_label.rs:109`, cap `SHORT_LABEL_MAX_CHARS = 24` at `:27`) and
  `deviceLabel` (`crates/yaran-web/web/src/lib/deviceLabel.ts:43`).

Research and primary sources (dates are when read):

- Access JWT: RS256 only; claims `aud` (array), `email`, `exp`, `iat`, `nbf`, `iss`
  (`https://<team>.cloudflareaccess.com`), `type`, `identity_nonce`, `sub`, `country`; service
  tokens carry `common_name` and `sub: ""` with no email; JWKS at
  `/cdn-cgi/access/certs`, rotated every 6 weeks with 7 days overlap; validate the
  `Cf-Access-Jwt-Assertion` header, not the cookie (research/cloudflare-parts/03-jwt-native.md:34-79).
- Native clients may present the app token as `CF_Authorization` cookie or `cf-access-token`
  header (research/cloudflare-parts/03-jwt-native.md:194-200); acceptance of an injected token
  is UNVERIFIED and is gate G1 (Phase 03).
- Public path overrides: `{"behavior":"public","path_pattern":...}`, no subpath coverage
  (research/cloudflare-parts/02-access.md:69-72); gate G8.
- JWE ECDH-ES (RFC 7518 §4.6, https://www.rfc-editor.org/rfc/rfc7518.html): Concat KDF,
  `K = SHA-256(0x00000001 ‖ Z ‖ OtherInfo)` for 256-bit keys; Appendix C vector reproduced on
  2026-11-14 with Node WebCrypto (`K = VqqN6vgjbSBcIijNcacQGg`, A128GCM).
- Platform feasibility (all verified 2026-11-14, sources in References):
  - **Workers WebCrypto**: ECDH, AES-GCM, SHA-256, HKDF, Ed25519 (`{name:"Ed25519"}`), no
    eval/`new Function`. (HKDF is used only by RFC 8291 push encryption, Phase 08; the
    handoff envelope uses the JWE Concat KDF, never HKDF.)
  - **jose 6.2.17** (MIT, 2026-11-09, `workerd` export): `CompactEncrypt` with
    `ECDH-ES`/`A256GCM`, `setKeyManagementParameters({apu, apv, epk})` (epk and
    `setInitializationVector` are test-only, deprecated), deterministic output with a fixed
    epk and IV; `compactDecrypt` returns the protected header; off-curve epk rejected by
    WebCrypto import.
  - **ring 0.17.14**: `agreement::ECDH_P256` with `EphemeralPrivateKey` only (can seal,
    cannot open), validates peer points, uncompressed SEC1; `aead::AES_256_GCM` with explicit
    nonce; `Ed25519KeyPair` (deterministic RFC 8032 signatures).
  - **CryptoKit**: `P256.KeyAgreement`, `SharedSecret: ContiguousBytes` (raw Z available),
    `AES.GCM`; `x963DerivedSymmetricKey` is **not** Concat KDF (counter position differs);
    on-curve validation undocumented.
  - **Android JCA**: `KeyAgreement "ECDH"` (API 11+), `AES/GCM/NoPadding` with `updateAAD`
    (API 19+); Keystore `PURPOSE_AGREE_KEY` needs API 31; on-curve validation undocumented.
- Push limits: Web Push bodies ≤ 4096 bytes, plaintext ≤ 3993 (RFC 8291); `Topic` ≤ 32
  base64url chars, `Urgency` `very-low|low|normal|high`, `TTL` required (RFC 8030); APNs
  payload ≤ 4096 bytes, `apns-collapse-id` ≤ 64 bytes, NSE needs `mutable-content: 1` and an
  alert; FCM ≤ 4096; UnifiedPush AND_3.1.0 1–4096 bytes, RFC 8291 required.
- Schema tooling: `@cfworker/json-schema` 4.1.6 (draft 2020-12, no eval, MIT);
  `json-schema-to-typescript` 16.0.0 (ignores `prefixItems`, treats `oneOf` as union);
  `@redocly/cli` 2.78.0; `typify` 0.8.0 lags at draft-07 and calls its `anyOf` output weak.
- URI schemes: `yaranapp` is valid RFC 3986 syntax; RFC 8252 §7.1 requires reverse-DNS schemes
  for **OAuth** redirects and prefers claimed https redirects (§7.2). Release builds therefore
  return on a verified https callback on `<publisher-domain>` (D8); `yaranapp` remains for
  dev builds and for in-WebView control URLs (Design §10).

## In scope

The full wire contract (Design §1–§13), the `cloud/protocol` package, the Rust
`yaran_core::cloud::protocol` module, fixtures and vectors, and CI for both.

## Out of scope

- Implementing endpoints: Worker foundation and auth (04), provisioning (05), pairing, sessions,
  handoff and devices (06), setup, admin and consoles (07), push sender and relay (08).
- yaran consumers: credentials and CLI (09), cloudflared leg (10), JWT verifier and the
  `/__yaran/handoff` route (11), emitter (12), web UI native integration and device labels (13).
- Mobile openers and decrypters in Kotlin/Swift (15, 16) and the shell app (14); they pass the
  fixtures defined here.
- Live proofs of Access behaviour (03: G1, G3, G8, G12, G13) and of push transports (G4, G5).

## Design

### 1. Package layout, source of truth, and codegen

```text
cloud/protocol/
├── package.json            private "@yaran/protocol", type: module, engines node >=22.12
├── tsconfig.json  vitest.config.ts  redocly.yaml
├── schemas/                JSON Schema draft 2020-12, the source of truth (one file per area)
│   common  meta  pairing  machine  me  devices  handoff  admin  push  relay  error
│   release-manifest        (Phase 07's update manifest, one home here)
├── openapi/                OpenAPI 3.1 documents that $ref the schemas
│   worker.openapi.yaml  yaran-machine.openapi.yaml  relay.openapi.yaml
├── registry/               data registries read by every language
│   errors.json  capabilities.json  audit-actions.json  refusals.json  close-codes.json
├── src/
│   ├── generated/types.ts  @generated by scripts/gen-types.mjs (json-schema-to-typescript)
│   ├── index.ts  version.ts  errors.ts  validate.ts  b64url.ts
│   ├── jwe/  ec.ts  kdf.ts  handoff.ts
│   ├── sig/  canonical.ts  verify.ts  sign.ts  fingerprint.ts  device.ts
│   ├── push/ payload.ts  topic.ts  apns.ts
│   ├── webpush/ ece.ts  vapid.ts   (RFC 8291/8292 codec; code owned by Phase 08, lives here)
│   ├── uri.ts  ua.ts  redirect.ts  consent.ts
├── scripts/  gen-types.mjs  gen-vectors.mjs   (both support --check)
├── fixtures/ api/  jwe/  sig/  handoff/  push/  webpush/  uri/  ua/  version/
└── test/     one *.test.ts per src module + schemas.test.ts + registry.test.ts
```

Choices (justified by the Evidence):

- **JSON Schema 2020-12 is canonical**; OpenAPI 3.1 is a superset that references it, linted
  with `@redocly/cli` (`recommended-strict`).
- **TS types are generated** with `json-schema-to-typescript` 16.0.0. Schemas therefore avoid
  `prefixItems`, rely on `kind` const discriminators for unions, and never depend on `oneOf`
  exclusivity for typing (the runtime validator enforces it).
- **Runtime validation** uses `@cfworker/json-schema` 4.1.6 in the Worker, the relay and the
  shell (Ajv's runtime compile is blocked in Workers).
- **Rust types are hand-written serde** (no codegen: typify lags at draft-07). Drift is caught
  by fixtures: every `valid` fixture must deserialize and re-serialize to an equal
  `serde_json::Value`, every `invalid` fixture must fail to deserialize or fail the type's
  `validate()` method. The TS suite proves the fixtures match the schemas, so the two are tied
  through the fixtures.
- **Kotlin and Swift** (phases 15/16) need only the envelope opener, the push decrypter and the
  payload/URI parsers; they read the same fixture files (Gradle test resources pointed at
  `cloud/protocol/fixtures`, an Xcode test bundle copy phase).

### 2. Wire conventions

- **Encoding.** `application/json; charset=utf-8`, UTF-8, snake_case keys. Request bodies
  ≤ 64 KiB (else `payload_too_large`).
- **Forward compatibility.** Request schemas set `additionalProperties: false` (servers reject
  unknown fields). Response schemas do not (clients ignore unknown fields). Response enums are
  **open**: clients map unknown values to an `unknown` arm (Rust `#[serde(other)] Unknown`,
  TS `assertNever` after an explicit unknown branch). Request enums are closed.
- **Types** (`schemas/common.schema.json` `$defs`):

| Name | Format |
|---|---|
| `Uuid` | lowercase UUID v4, `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (Worker-minted ids) |
| `YaranId` | opaque yaran id, 1–128 printable ASCII `^[\x21-\x7e]{1,128}$` (agent/tab ids, today UUIDs) |
| `Timestamp` | RFC 3339 UTC with `Z`, seconds precision (`2026-11-14T12:00:00Z`) |
| `B64url` | base64url, no padding, `^[A-Za-z0-9_-]*$` |
| `P256Point` | `B64url` of a 65-byte uncompressed SEC1 point (`0x04‖x‖y`), exactly 87 chars |
| `Ed25519PublicKey` | `B64url` of 32 raw bytes, exactly 43 chars |
| `Email` | `format: email`, ≤ 254 chars, compared lowercase |
| `OrgUrl` | `^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$` (origin only: no port, path, query) |
| `Hostname` | lowercase DNS name, labels `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` |
| `MachineName` | `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` (≤ 32, so `<machine>-<user>` fits one 63-char label with a ≤ 30-char user slug; Phase 05 owns slugging) |
| `SemVer` | `^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$` |
| `OriginPort` | integer 1–65535, the machine's loopback yaran port (`[server] port`, default 3890) |
| `MachineKeyFingerprint` | `^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$` (29 chars), derived from an `Ed25519PublicKey` per §7.1 |
| `DeviceKeyFingerprint` | same pattern as `MachineKeyFingerprint`, derived from a device key `P256Point` per §8.1 (D24) |
| `EcdsaP256Sig` | `B64url` of a 64-byte raw `r ‖ s` ECDSA P-256 signature (JWS `ES256` form), exactly 86 chars (§8.1) |
| `RequestId` | `^[A-Za-z0-9-]{1,64}$`; the Worker uses the `CF-Ray` value when present, else 16 random bytes as hex |
| `InstallId` | a `Uuid` the app mints once per **org registration** on this install (kept in the secure store, discarded when the org is removed or the device revoked), so two orgs cannot correlate one phone |
| `Page<T>` | `{ "items": [T], "next_cursor": B64url ≤ 256 | null }`; query `limit` 1–100 (default 50), `cursor` |

- **Headers every protocol client sends**: `Yaran-Protocol: <int>` (§3), `User-Agent`
  (`yaran/<version> (<os>; <arch>)` from yaran; the app's native HTTP and WebView UA carry the
  §11 token). The app's native org API client (D22) also sends `Yaran-Install-Id: <InstallId>`
  on every Worker call once it has registered with that org; the Worker uses it to stamp the
  device's `last_seen_at` and answers `403 device_revoked` when that install's device was
  revoked (Phase 06). Every Worker and relay response carries `Yaran-Protocol` (the version
  served) and `Yaran-Request-Id: <RequestId>` (the same value as the envelope's `request_id`);
  `/v1/*` responses are `Cache-Control: no-store` except `/v1/meta` (`public, max-age=60`).
- **How a phone authenticates to the Worker API.** Native HTTP (never cross-origin `fetch`
  from the shell WebView) sends the control-plane app token as **both**
  `Cookie: CF_Authorization=<jwt>` and `cf-access-token: <jwt>`; Access validates whichever it
  honours (G1/G3 record which). The Worker **only** trusts the `Cf-Access-Jwt-Assertion`
  header Access adds, verified per Phase 04 (iss, aud, exp, non-empty email, not a service
  token). The API sends no CORS headers.
- **CSRF for browser consoles.** Mutating `/v1/me/*` and `/v1/admin/*` requests must carry
  `Content-Type: application/json` (DELETE may have no body); if `Origin` is present it must
  equal the control-plane origin, else `origin_mismatch`. The two HTML form posts in this
  contract (W3 pairing confirm, W16b/Y1b handoff consent) carry a server-minted `csrf` field
  and pass the same `Origin` rule.

### 3. Protocol versioning and negotiation

- `PROTOCOL` is an integer; this document defines **1**. The `/v1` path prefix is not the
  protocol version and never changes.
- Servers advertise `{min, max}` (`/v1/meta` for the Worker, relay `/v1/meta`; yaran puts its
  range in handoff error redirects). Clients compiled with `[cmin, cmax]` pick
  `n = min(cmax, smax)` and require `n ≥ max(cmin, smin)`, else stop with
  `protocol_unsupported` and a message naming which side to update.
- Clients send `Yaran-Protocol: n` on every request (browser navigations use the `v=n` query
  parameter). A server receiving no header (except on `/v1/meta`) or one outside its range
  answers `400 protocol_unsupported` with `details: {min, max}`.
- **What bumps the version**: removing or renaming a field, changing a field's meaning, adding
  a required request field, changing any crypto or canonicalization, changing a status code's
  meaning. **What does not**: a new optional response field, a new endpoint, a new capability,
  a new open-enum value, a new error code (clients handle unknown codes by HTTP status class).
- **Window (D15).** A server keeps serving `n-1` for at least 12 months after `n` ships in a
  `yaran-cloud-v*` release, and lists the end date in `/v1/meta` `deprecations`. Each client
  release supports `[n-1, n]`. A server never raises `min` past a version some supported
  client release still needs. Clients surface a deprecation warning when their chosen `n`
  appears in `deprecations`.
- **Capabilities** (`registry/capabilities.json`, open enum): `pairing.v1`, `handoff.v1`,
  `push.webpush`, `devices.test_push`, `admin.audit`, `admin.reconcile`. Clients gate optional
  UI on them, never on the Worker version.
- Fixtures `fixtures/version/negotiate.json` pin the decision table (overlap, client newer,
  server newer, disjoint, deprecated).

### 4. Error envelope and code registry

Every non-2xx JSON response (Worker, relay, and yaran `/__yaran/handoff` when not redirecting):

```json
{ "error": { "code": "signature_expired",
             "message": "The request timestamp is 412 s away from the server clock; check the machine's clock.",
             "retryable": false,
             "details": { "server_time": "2026-11-14T12:00:00Z" } },
  "request_id": "8d1f2c3b4a5e6f70-LHR" }
```

`code` is the stable contract; `message` is human text (English, sanitized, never contains
secrets or upstream bodies verbatim); `details` is code-specific and optional. Codes are
snake_case, never reused, and live in `registry/errors.json` with `{code, status, retryable,
emitted_by, summary, reserved?}`. Clients act on `code`; an unknown code falls back to its status class.
`429` and `503` carry `Retry-After`. A code marked **reserved** is never emitted and exists only
so it is never reused. Worker HTML routes (W2, W3, W16, W16b, W29, W30) render the same code
on an accessible error page instead of JSON. yaran's own refusals outside `/__yaran/handoff`
are plain text with a `Yaran-Refusal` header, not this envelope (§13).

| Code | Status | Retry | Emitted by · meaning |
|---|---|---|---|
| `bad_request` | 400 | no | any · malformed request |
| `validation_failed` | 400 | no | any · schema failure; `details.errors: [{path, message}]` (≤ 20) |
| `protocol_unsupported` | 400 | no | any · `details: {min, max}` |
| `unauthenticated` | 401 | no | Worker · Access assertion missing/invalid |
| `service_token_rejected` | 403 | no | Worker · service-token JWT on a user route (yaran refuses the same case with `Yaran-Refusal: access-service-token`, §13) |
| `forbidden` | 403 | no | Worker · role does not allow it |
| `user_disabled` | 403 | no | Worker · the signed-in user's row is `disabled` |
| `device_revoked` | 403 | no | Worker · the request's `Yaran-Install-Id` names a revoked device; the app wipes that org's data and says so |
| `origin_mismatch` | 403 | no | Worker · CSRF rule (§2) |
| `misdirected_host` | 421 | no | Worker · after setup, any Host other than the recorded control-plane host (workers.dev included); the body names no other host |
| `not_found` | 404 | no | any |
| `method_not_allowed` | 405 | no | any |
| `conflict` | 409 | no | any · generic state conflict |
| `payload_too_large` | 413 | no | any |
| `unsupported_media_type` | 415 | no | any |
| `rate_limited` | 429 | yes | any |
| `internal` | 500 | yes | any |
| `cloudflare_api_failed` | 502 | yes | Worker · `details.cf_errors: [{code, message}]` sanitized |
| `cloudflare_unavailable` | 502 | yes | Worker · Cloudflare API 5xx or network failure (05) |
| `cloudflare_rate_limited` | 503 | yes | Worker · Cloudflare API budget or 429 (05); carries `Retry-After` |
| `cloudflare_permission_denied` | 502 | no | Worker · the API token lacks a permission; `details.permission` names it (05, 07) |
| `unavailable` | 503 | yes | any |
| `identity_unavailable` | 503 | yes | Worker · Access JWKS unreachable; fails closed, never a pass (04) |
| `setup_incomplete` | 503 | no | Worker · setup wizard not finished |
| `setup_closed` | 410 | no | Worker · `/setup*` after setup completed |
| `setup_code_invalid` | 401 | no | Worker (setup HTML) · wrong setup code (07) |
| `setup_locked` | 403 | no | Worker (setup HTML) · too many wrong codes; locked until `SETUP_CODE` changes (07) |
| `setup_claim_invalid` | 403 | no | Worker (setup HTML) · admin claim link unknown, used, expired, or the JWT email is not the typed admin email (07) |
| `signature_missing` | 401 | no | Worker · machine headers absent/malformed |
| `signature_invalid` | 401 | no | Worker · Ed25519 check or body hash failed |
| `signature_expired` | 401 | no | Worker · timestamp outside ±300 s; `details.server_time` |
| `nonce_replayed` | 401 | no | Worker |
| `machine_unknown` | 401 | no | Worker |
| `machine_revoked` | 410 | no | Worker · yaran stops the cloud leg out loud |
| `machine_not_ready` | 409 | yes | Worker · machine `provisioning` or `failed` on a non-claim machine route (04) |
| `pairing_not_allowed` | 403 | no | Worker · admin pairing policy excludes the user |
| `pair_request_invalid` | 400 | no | Worker · authorize parameters |
| `pair_callback_invalid` | 400 | no | Worker · callback not `http://127.0.0.1:<port>/callback` |
| `pair_denied` | 403 | no | Worker · user pressed Deny |
| `pair_request_expired` | 410 | no | Worker |
| `pair_code_invalid` | 400 | no | Worker · unknown, used or expired code |
| `pkce_mismatch` | 400 | no | Worker |
| `machine_name_invalid` | 400 | no | Worker |
| `machine_cap_reached` | 409 | no | Worker · `details: {limit}` |
| `account_quota_reached` | 409 | no | Worker · `details: {resource: access_apps|access_policies|tunnels, used, limit}` (05's quota guard) |
| `hostname_conflict` | 409 | no | Worker · the derived hostname is taken by a DNS record or Access app yaran does not own (05) |
| `provisioning_in_progress` | 409 | yes | Worker · another op is live for this machine (05) |
| `provisioning_failed` | 502 | yes | Worker · saga failed and compensated |
| `tunnel_delete_blocked` | 502 | yes | Worker · teardown could not delete the tunnel; admin retry (05, 07) |
| `origin_port_invalid` | 400 | no | Worker · `origin_port` outside 1–65535 |
| `handoff_request_invalid` | 400 | no | Worker, yaran · bad `pk`/`state`/`redirect`/`build`/`mode`/`device`/`csrf`/`v`; also sent as `error=` on a valid redirect |
| `handoff_declined` | — | no | Worker, yaran · callback `error=` only: the person pressed Cancel on the consent page |
| `handoff_device_key_invalid` | 400 | no | Worker, yaran · `dk` missing, not a `P256Point`, or off P-256 (§8.1); also sent as `error=` on a valid redirect |
| `handoff_signature_malformed` | 400 | no | Worker, yaran · `dts` or `dsig` missing or malformed (not decimal, not 86-char base64url, `r` or `s` outside `1..n−1`, DER) (§8.1); also sent as `error=`. A well-formed signature that does not verify is not an error: it gets the consent page |
| `handoff_timestamp_skewed` | 400 | no | Worker, yaran · `dts` outside ±300 s of the server clock (§8.1); `details.server_time`, or `&server_time=<unix s>` on the error redirect |
| `handoff_jwt_missing` | 401 | no | reserved · superseded by `Yaran-Refusal: access-missing` (§13) |
| `handoff_owner_mismatch` | 403 | no | reserved · superseded by `Yaran-Refusal: access-not-owner` (§13) |
| `device_cap_reached` | 409 | no | Worker · `details: {limit}` |
| `push_endpoint_invalid` | 400 | no | Worker |
| `push_relay_disallowed` | 409 | no | Worker · relay channel refused: `details.reason: disabled|not_allowlisted` (`push.relay_allowed` off, or the endpoint origin is not in `push.allowed_relays`) |
| `push_disabled` | 409 | no | Worker · org push off |
| `last_admin` | 409 | no | Worker · cannot demote/delete the last admin |
| `relay_app_unknown` | 400 | no | relay · app id not served |
| `relay_vapid_invalid` | 401 | no | relay · VAPID header missing, JWT bad, wrong `aud`, expired or `exp` > 24 h |
| `relay_vapid_mismatch` | 403 | no | relay · VAPID `k` differs from the key bound at mint |
| `relay_endpoint_invalid` | 404 | no | relay · unknown key id or bad tag |
| `relay_upstream_failed` | 502 | no | relay · APNs/FCM refused the relay's own credentials (publisher misconfiguration) |
| `push_endpoint_gone` | 410 | no | relay · APNs/FCM said unregistered; the org clears the subscription and marks the device `gone` (row kept, §9) |

Local codes (no HTTP; used by openers/decoders for logging and UX, same registry):
`jwe_malformed`, `jwe_unsupported`, `jwe_kid_mismatch`, `jwe_point_invalid`,
`jwe_decrypt_failed`, `jwe_state_mismatch`, `jwe_host_mismatch`, `jwe_kind_mismatch`,
`jwe_expired`, `push_payload_invalid`, `push_decrypt_failed`, `uri_invalid`.

Phase-local state names are not registry codes and stay in their phases: Phase 13's
`signin_needed`/`server_problem` faces, Phase 15's handoff outcomes (`api_error`,
`session_expired`, `tls_error`, `refused`; its `protocol_mismatch` outcome is renamed
`protocol_unsupported` to match this registry), and Phase 16's registration states.

### 5. Endpoint inventory

Auth classes: **PUBLIC** (Access public override, G8; Worker does its own checks),
**SIG** (§7 machine signature, also under the public override), **USER** (Access-protected,
user JWT), **ADMIN** (USER + `role = admin`), **OWNER** (machine Access app + yaran's JWT
verifier with `email == paired owner`, Phase 11), **NAV** (browser navigation behind Access,
HTML), **SETUP** (setup code, before Access exists), **VAPID** (RFC 8292).

| # | Method · path | Auth | Request → response | Owner |
|---|---|---|---|---|
| W1 | `GET /v1/meta` | PUBLIC | — → `Meta` (200 before and after setup, D19) | 06 |
| W2 | `GET /v1/pair/authorize` | NAV | query `PairAuthorizeQuery` → confirm page, or 302 to callback with `error` | 06 |
| W3 | `POST /v1/pair/authorize` | NAV | form `PairConsent` (`request_id`, `csrf`, `decision=approve|deny`, optional `replace_machine_id`) → 302 callback `?code&state` or `?error&state` | 06 |
| W4 | `POST /v1/machine/claim` | SIG (key bound by code) | `ClaimRequest` → `ClaimResponse` | 06 |
| W5 | `GET /v1/machine/config` | SIG | — → `MachineConfig` | 06 |
| W6 | `POST /v1/machine/events` | SIG | `EventBatch` → 202 `EventBatchResult` | 08 (accept: 06) |
| W7 | `POST /v1/machine/rotate` | SIG | `RotateRequest` → `RotateResponse` | 05/06 |
| W8 | `POST /v1/machine/unpair` | SIG | empty body → 202 `TeardownStarted` (replaces `DELETE /v1/machine`, so the one `/v1/machine/*` override covers every machine route) | 05/06 |
| W9 | `GET /v1/me` | USER | — → `Me` | 06 |
| W10 | `GET /v1/me/machines` | USER | `limit, cursor` → `Page<MachineSummary>` | 06 |
| W11 | `DELETE /v1/me/machines/{id}` | USER | — → 202 `TeardownStarted` | 05/06 |
| W12 | `POST /v1/me/devices` | USER | `DeviceRegistration` (upsert by `install_id`) → 200/201 `Device` | 06 |
| W13 | `GET /v1/me/devices` | USER | `limit, cursor` → `Page<Device>` | 06 |
| W14 | `DELETE /v1/me/devices/{id}` | USER | query `sign_out_everywhere=1` optional → 204 (clears the subscription, marks the device revoked; with the flag also revokes the user's Access sessions, Phase 06) | 06 |
| W15 | `POST /v1/me/devices/{id}/test` | USER | — → 202 (sends a `test` push) | 08 |
| W16 | `GET /v1/handoff` | NAV (USER JWT) | query `HandoffQuery` → 200 consent page (§8), or 302 callback `?error` | 06 |
| W16b | `POST /v1/handoff` | NAV (USER JWT) | form `HandoffConsent` → 303 callback `?state&jwe` or `?state&error=handoff_declined` | 06 |
| W17 | `GET /v1/admin/users` | ADMIN | `limit, cursor, q` → `Page<AdminUser>` | 07 |
| W18 | `PATCH /v1/admin/users/{id}` | ADMIN | `AdminUserPatch` → `AdminUser` | 07 |
| W19 | `DELETE /v1/admin/users/{id}` | ADMIN | — → 202 (revokes their machines and devices) | 07 |
| W20 | `GET /v1/admin/machines` | ADMIN | `limit, cursor, owner` → `Page<AdminMachine>` | 07 |
| W21 | `DELETE /v1/admin/machines/{id}` | ADMIN | — → 202 `TeardownStarted` | 07 |
| W22 | `POST /v1/admin/machines/{id}/rotate` | ADMIN | `{kill_connections: bool}` → 202 | 05/07 |
| W23 | `GET /v1/admin/devices` | ADMIN | `limit, cursor, owner` → `Page<AdminDevice>` | 07 |
| W24 | `DELETE /v1/admin/devices/{id}` | ADMIN | — → 204 | 07 |
| W25 | `GET /v1/admin/audit` | ADMIN | `limit, cursor, actor, action, target, since, until` → `Page<AuditEntry>` | 04/07 |
| W26 | `GET /v1/admin/settings` · `PUT /v1/admin/settings` | ADMIN | `Settings` ↔ `Settings` | 07 |
| W27 | `GET /v1/admin/update-status` | ADMIN | — → `UpdateStatus` | 07 |
| W28 | `POST /v1/admin/reconcile` | ADMIN | — → 202 | 05 |
| W29 | `/setup/*` | SETUP | HTML wizard; not a JSON contract | 07 |
| W30 | `/console/*`, `/admin/*` | NAV | HTML consoles over W9–W28; not a JSON contract | 07 |
| W31 | `PATCH /v1/me/devices/{id}` | USER | `DevicePatch` (mutes, label) → `Device` | 06 (mute enforcement: 08) |
| W32 | `PUT /v1/machine/origin` | SIG | `OriginUpdate` → 202 `OriginUpdateResult` | 05/06 |
| Y1 | `GET /__yaran/handoff` (machine hostname) | OWNER | query `HandoffQuery` → 200 consent page (§8), or 302 callback `?error` | 11 |
| Y1b | `POST /__yaran/handoff` (machine hostname) | OWNER | form `HandoffConsent` → 303 callback `?state&jwe` or `?state&error=handoff_declined` | 11 |
| Y2 | `GET /__yaran/signed-in` (machine hostname) | OWNER | — → 200 script-free HTML "this browser is signed in", `no-store` (Phase 13's browser re-sign-in landing) | 11 |
| R1 | `GET /v1/meta` (relay) | public | — → `RelayMeta` | 08 |
| R2 | `POST /v1/endpoints` (relay) | public, rate-limited | `EndpointMintRequest` → 201 `EndpointMintResponse` | 08 |
| R3 | `POST /w/{opaque}` (relay) | VAPID | RFC 8030 push message → 201 | 08 |

Rename of a machine is deliberately absent: the name is part of the hostname, Access app and
DNS record, so renaming is "unpair and pair again". Phase 07's console says so.

Every other `/__yaran/*` path answers 404, and both Y routes answer 404 to any Host that is not
the bound cloud hostname, so loopback can never mint an envelope (Phase 11). The machine paths
W4–W8 and W32 all match `^/v1/machine/[a-z]+$`, which is exactly what the single Access public
override `/v1/machine/*` covers (G8); no override for a bare `/v1/machine` exists or is needed.

### 6. Schemas (OpenAPI 3.1 component excerpts)

These are normative. The repo files hold the same definitions with `$id`s and descriptions.

```yaml
Meta:                                   # W1; served before and after setup (D19)
  type: object
  required: [service, protocol, worker, setup]
  # setup = closed additionally requires [org, access, capabilities, push] (if/then in the schema file)
  properties:
    service: { const: yaran-cloud }
    protocol: { $ref: '#/ProtocolRange' }          # {min: int>=1, max: int>=min}
    setup: { enum: [open, closed] }                # open: only the setup wizard works; clients other than
                                                   # the wizard and 07's update job stop with setup_incomplete
    deprecations: { type: array, items: { type: object, required: [protocol, after],
                    properties: { protocol: { type: integer }, after: { type: string, format: date } } } }
    org: { type: object, required: [name, url],
           properties: { name: { type: string, minLength: 1, maxLength: 80 }, url: { $ref: OrgUrl } } }
    access: { type: object, required: [team_domain],
              properties: { team_domain: { $ref: Hostname } } }   # <team>.cloudflareaccess.com
    worker: { type: object, required: [version], properties: { version: { $ref: SemVer } } }
    capabilities: { type: array, items: { type: string, pattern: '^[a-z_]+(\.[a-z0-9_]+)*$' } }
    push: { type: object, required: [enabled, vapid_public_key],
            properties: { enabled: { type: boolean },
                          vapid_public_key: { oneOf: [ { $ref: P256Point }, { type: 'null' } ] } } }
    # vapid_public_key is the org's VAPID key (65-byte raw point): the app passes it to the
    # UnifiedPush `vapid` parameter, the embedded FCM registration and relay minting (Phase 16).

PairAuthorizeQuery:                     # W2 query string
  required: [v, state, code_challenge, code_challenge_method, machine_pubkey, machine_name, callback, yaran_version]
  properties:
    v: { type: integer }
    state: { type: string, pattern: '^[A-Za-z0-9_-]{22,128}$' }
    code_challenge: { type: string, pattern: '^[A-Za-z0-9_-]{43}$' }  # base64url(SHA-256(verifier)), RFC 7636
    code_challenge_method: { const: S256 }
    machine_pubkey: { $ref: Ed25519PublicKey }
    machine_name: { $ref: MachineName }
    callback: { type: string, pattern: '^http://127\.0\.0\.1:([1-9][0-9]{3,4})/callback$' }  # port 1024–65535 checked in code
    yaran_version: { type: string, maxLength: 40 }
    origin_port: { $ref: OriginPort }     # optional, default 3890; lets 05 provision the ingress at authorize
# The confirm page shows machine_pubkey's MachineKeyFingerprint (§7.1); the CLI prints the same string.
# W2/W3 redirect to callback: ?code=<B64url 43 = 32 random bytes>&state=<state>
#                       or    ?error=<code>&state=<state>
# pair request lifetime 10 min; code lifetime 120 s, single use

PairConsent:                            # W3 (POST form from the confirm page)
  additionalProperties: false
  required: [request_id, csrf, decision]
  properties:
    request_id: { $ref: Uuid }            # the pair request id the GET rendered
    csrf: { type: string, pattern: '^[A-Za-z0-9_-]{22,128}$' }   # minted by the GET, single use
    decision: { enum: [approve, deny] }
    replace_machine_id: { $ref: Uuid }    # only with approve, and only on the same-name branch:
    # present = Replace (must name the caller's own active machine whose name equals machine_name;
    # it is torn down only after the new claim succeeds, audit machine.replaced); absent = Pair as
    # the next free name from 05. Any other value, or the field with decision=deny, is
    # pair_request_invalid on the error page.

ClaimRequest:                           # W4 (signed with the key from machine_pubkey)
  additionalProperties: false
  required: [code, code_verifier, yaran_version, origin_port]
  properties:
    code: { type: string, pattern: '^[A-Za-z0-9_-]{43}$' }
    code_verifier: { type: string, pattern: '^[A-Za-z0-9._~-]{43,128}$' }
    yaran_version: { type: string, maxLength: 40 }
    origin_port: { $ref: OriginPort }     # authoritative: if it differs from the port provisioned at
                                          # authorize, the Worker calls 05 setOriginPort before answering

ClaimResponse:                          # W4; contains a secret (tunnel token)
  required: [machine_id, machine_name, hostname, url, origin_port, tunnel, access, owner_email, user_slug, org, protocol]
  properties:
    machine_id: { $ref: Uuid }
    machine_name: { $ref: MachineName }
    hostname: { $ref: Hostname }          # <machine>-<user>.<zone>, one label under the zone
    url: { type: string }                 # https://<hostname>
    origin_port: { $ref: OriginPort }     # the port the ingress targets (echo of the claim)
    tunnel: { $ref: TunnelCredentials }   # {id: Uuid, token: string 1..4096, token_version: int>=1}
    access: { $ref: MachineAccess }       # {team_domain: Hostname, aud: string ^[0-9a-f]{64}$}
    owner_email: { $ref: Email }          # D3: the only email yaran's JWT verifier accepts (Phase 09 stores it)
    user_slug: { type: string, pattern: '^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$' }
    org: { type: object, required: [name, url], properties: { name: { type: string }, url: { $ref: OrgUrl } } }
    protocol: { type: integer }

MachineConfig:                          # W5; never contains the token
  required: [machine_id, hostname, url, origin_port, access, tunnel, owner_email, push, events, server_time]
  properties:
    machine_id: { $ref: Uuid }
    hostname: { $ref: Hostname }
    url: { type: string }
    origin_port: { $ref: OriginPort }     # yaran calls W32 when its serving port differs
    access: { $ref: MachineAccess }
    tunnel: { type: object, required: [id, token_version],
              properties: { id: { $ref: Uuid }, token_version: { type: integer, minimum: 1 } } }
    owner_email: { $ref: Email }
    push: { type: object, required: [enabled, detail],
            properties: { enabled: { type: boolean }, detail: { enum: [names, minimal] } } }
    events: { type: object, required: [max_batch, min_interval_ms],
              properties: { max_batch: { type: integer, minimum: 1, maximum: 16 },
                            min_interval_ms: { type: integer, minimum: 0 } } }
    server_time: { $ref: Timestamp }
# yaran compares tunnel.token_version with its stored version; if higher, it calls W7 with reason "sync".

EventBatch:                             # W6; the body is always a batch, even of one event
  additionalProperties: false
  required: [events]
  properties:
    events: { type: array, minItems: 1, maxItems: 16, items: { $ref: Event } }
Event:
  oneOf:
    - title: AttentionEvent
      additionalProperties: false
      required: [id, kind, ts, agent_id, state]
      properties:
        id: { $ref: Uuid }                # idempotency key; the Worker dedupes for 24 h
        kind: { enum: [attention_raised, attention_cleared] }
        ts: { $ref: Timestamp }
        agent_id: { $ref: YaranId }
        tab_id: { $ref: YaranId }         # omitted for the agent's first (slot) tab
        state: { enum: [needs_attention, typing, busy, idle, detached, exited] }   # RowState token, never prose
        # attention_raised carries needs_attention; attention_cleared carries the tab's RowState after
        # the clear (idle when the emitter cannot tell). The phone words the token (Phase 16).
        project: { type: string, maxLength: 64 }   # project name, or a standalone agent's folder name; omitted when push.detail = minimal
        label: { type: string, maxLength: 64 }     # agent display name (display_label()); omitted when minimal
    - title: ExitEvent
      additionalProperties: false
      required: [id, kind, ts, agent_id, ending]
      properties:
        id: { $ref: Uuid }
        kind: { const: agent_exited_badly }
        ts: { $ref: Timestamp }
        agent_id: { $ref: YaranId }
        tab_id: { $ref: YaranId }
        ending: { enum: [launch_failed, exited, exited_unknown, rapid_clean_exit] }  # TabRunEnding wire kinds
        exit_status: { type: integer }    # the process exit status when known; never in the push payload
        project: { type: string, maxLength: 64 }
        label: { type: string, maxLength: 64 }
EventBatchResult:                       # 202
  required: [accepted, duplicates, push_enabled]
  properties:
    accepted: { type: array, items: { $ref: Uuid } }
    duplicates: { type: array, items: { $ref: Uuid } }
    push_enabled: { type: boolean }       # false: yaran may stop sending until config says otherwise
# Org push off (Settings.push.enabled = false) is still 202, never 409 push_disabled: the batch is
# validated and deduped as usual, every new id is recorded for the 24 h dedupe and listed in
# `accepted`, repeats in `duplicates`, nothing is queued, and push_enabled is false. There is no
# per-machine push switch: a machine muted on every device (muted_machine_ids) still gets
# push_enabled: true, because mutes are per device and decided at send time (08).

RotateRequest:                          # W7
  additionalProperties: false
  required: [known_token_version, reason]
  properties:
    known_token_version: { type: integer, minimum: 1 }
    reason: { enum: [user, sync] }        # user: rotate now; sync: fetch the current token if newer
RotateResponse:
  required: [tunnel, rotated]
  properties: { tunnel: { $ref: TunnelCredentials }, rotated: { type: boolean } }

TeardownStarted: { required: [machine_id, state], properties: { machine_id: { $ref: Uuid }, state: { const: tearing_down } } }
# W8 (POST /v1/machine/unpair) on an already-revoked machine → 410 machine_revoked.
# yaran deletes its credentials on 202 or 410.

OriginUpdate:                           # W32 (signed); sent when yaran's serving port changes
  additionalProperties: false
  required: [origin_port]
  properties: { origin_port: { $ref: OriginPort } }
OriginUpdateResult:                     # 202; the ingress repair (05 setOriginPort, step P4 only) runs async
  required: [origin_port, changed]
  properties: { origin_port: { $ref: OriginPort }, changed: { type: boolean } }   # false: already that port

Me:                                     # W9
  required: [email, role, user_slug, org, limits, counts, session_exp]
  properties:
    email: { $ref: Email }
    session_exp: { $ref: Timestamp }      # the verified control-plane JWT's exp; the app schedules renewal from it
    role: { enum: [user, admin] }
    user_slug: { type: string }
    org: { type: object, required: [name, url], properties: { name: { type: string }, url: { $ref: OrgUrl } } }
    limits: { type: object, required: [machines, devices],
              properties: { machines: { type: integer }, devices: { type: integer } } }
    counts: { type: object, required: [machines, devices],
              properties: { machines: { type: integer }, devices: { type: integer } } }

MachineSummary:                         # W10
  required: [id, name, hostname, url, status, status_checked_at, paired_at]
  properties:
    id: { $ref: Uuid }
    name: { $ref: MachineName }
    hostname: { $ref: Hostname }
    url: { type: string }
    status: { enum: [online, degraded, offline, never_connected, provisioning, tearing_down, unknown] }   # open enum
    # 06's view model maps Cloudflare tunnel health: healthy→online, degraded→degraded,
    # down or inactive-after-connecting→offline, inactive-never-connected→never_connected.
    reported_protocol: { oneOf: [ { type: integer }, { type: 'null' } ] }   # last Yaran-Protocol seen from the machine
    status_checked_at: { $ref: Timestamp }
    last_seen_at: { oneOf: [ { $ref: Timestamp }, { type: 'null' } ] }
    paired_at: { $ref: Timestamp }
    yaran_version: { oneOf: [ { type: string, maxLength: 40 }, { type: 'null' } ] }
    # No connector count: Cloudflare removed `connections` from the tunnel list and get responses
    # (2026-10-05, 05 Evidence), and the per-tunnel connections endpoint would cost one API call
    # per machine per reconcile. No phase reads a count; liveness is `status` from the list.

DeviceRegistration:                     # W12; request header Yaran-Install-Id must equal install_id
  additionalProperties: false
  required: [install_id, device_key, platform, flavor, form_factor, app_version, label, push, mute_all, muted_until, muted_machine_ids]
  properties:
    install_id: { $ref: InstallId }       # one per org registration on this install (§2), kept in the secure store
    device_key: { $ref: P256Point }       # §8.1 device key, minted with install_id; fixed for that install_id (a different
                                          # key on upsert is 409 conflict); lets the Worker refuse remembered consent once revoked
    platform: { enum: [android, ios] }
    flavor: { enum: [foss, play, appstore, dev] }
    form_factor: { enum: [phone, tablet] }
    app_version: { $ref: SemVer }
    label: { type: string, minLength: 1, maxLength: 64 }
    locale: { type: string, pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$' }
    push:
      oneOf:
        - { additionalProperties: false, required: [kind], properties: { kind: { const: none } } }
        - additionalProperties: false
          required: [kind, channel, endpoint, keys]
          properties:
            kind: { const: webpush }
            channel: { enum: [unifiedpush, fcm_embedded, apns_relay, fcm_relay] }   # fcm_relay: G5 fallback (08)
            distributor: { type: string, maxLength: 128 }       # UnifiedPush distributor package, informational
            endpoint: { type: string, maxLength: 2048, pattern: '^https://' }   # public host only (checked in code)
            keys: { type: object, additionalProperties: false, required: [p256dh, auth],
                    properties: { p256dh: { $ref: P256Point },
                                  auth: { type: string, pattern: '^[A-Za-z0-9_-]{22}$' } } }   # 16 bytes
    mute_all: { type: boolean }                                    # per-org mute, indefinite
    muted_until: { oneOf: [ { $ref: Timestamp }, { type: 'null' } ] }   # per-org mute, timed
    muted_machine_ids: { type: array, maxItems: 100, uniqueItems: true, items: { $ref: Uuid } }   # per-machine mutes
# One registration per org Worker (Phase 16), so a per-org mute is this registration's mute_all or
# muted_until, and a per-machine mute is an entry in muted_machine_ids. A push is sent only when
# !mute_all && (muted_until == null || now >= muted_until) && machine ∉ muted_machine_ids (08).

DevicePatch:                            # W31; changes only the fields present
  additionalProperties: false
  minProperties: 1
  properties:
    label: { type: string, minLength: 1, maxLength: 64 }
    mute_all: { type: boolean }
    muted_until: { oneOf: [ { $ref: Timestamp }, { type: 'null' } ] }
    muted_machine_ids: { type: array, maxItems: 100, uniqueItems: true, items: { $ref: Uuid } }   # replaces the list

Device:                                 # W12–W14, W31; the endpoint itself is never echoed (it is a capability)
  required: [id, install_id, device_key_fingerprint, platform, flavor, form_factor, app_version, label, push, push_state, mute_all,
             muted_until, muted_machine_ids, created_at, last_seen_at, current]
  properties:
    id: { $ref: Uuid }
    install_id: { $ref: InstallId }
    device_key_fingerprint: { $ref: DeviceKeyFingerprint }   # §8.1; the key itself is not echoed
    platform: { enum: [android, ios] }
    flavor: { enum: [foss, play, appstore, dev] }
    form_factor: { enum: [phone, tablet] }
    app_version: { $ref: SemVer }
    label: { type: string }
    push: { type: object, required: [kind],
            properties: { kind: { enum: [none, webpush] }, channel: { enum: [unifiedpush, fcm_embedded, apns_relay, fcm_relay] },
                          endpoint_host: { $ref: Hostname }, last_success_at: { oneOf: [ { $ref: Timestamp }, { type: 'null' } ] },
                          last_error_code: { oneOf: [ { type: string }, { type: 'null' } ] },
                          vapid_public_key: { oneOf: [ { $ref: P256Point }, { type: 'null' } ] } } }   # the org key this subscription was registered against
    push_state: { enum: [active, gone, auth_failed, failing, none] }   # open enum; see §9 "Delivery outcomes"
    mute_all: { type: boolean }
    muted_until: { oneOf: [ { $ref: Timestamp }, { type: 'null' } ] }
    muted_machine_ids: { type: array, items: { $ref: Uuid } }
    created_at: { $ref: Timestamp }
    last_seen_at: { $ref: Timestamp }
    current: { type: boolean }            # true when install_id == request's Yaran-Install-Id
# push_state: active (last send succeeded or none attempted); gone (the push service said 404/410:
# subscription cleared, row kept, the app re-registers when it sees this); auth_failed (401/403,
# e.g. after VAPID rotation, or push.vapid_public_key ≠ Meta.push.vapid_public_key: re-register);
# failing (5 consecutive exhausted retries); none (push.kind = none).

HandoffQuery:                           # W16 and Y1 (GET, renders the consent page)
  required: [v, pk, state, redirect, device, dk, dts, dsig]
  properties:
    v: { type: integer }
    pk: { $ref: P256Point }               # the phone's ephemeral recipient key (raw point, never a JWK)
    state: { type: string, pattern: '^[A-Za-z0-9_-]{22,128}$' }
    redirect: { type: string, maxLength: 256 }   # checked against the redirect allowlist (§8), byte for byte
    build: { enum: [release, dev] }       # default release; dev is the only way to ask for the custom scheme
    mode: { enum: [query, fragment] }     # default query; fragment puts state/jwe/error after '#' (G13)
    device: { type: string, minLength: 1, maxLength: 64 }   # the app's device label, shown on the consent page
    dk: { $ref: P256Point }               # the long-lived device public key (§8.1, D24), never the ephemeral pk
    dts: { type: string, pattern: '^(0|[1-9][0-9]{0,11})$' }   # Unix seconds as signed, decimal, within ±300 s
    dsig: { $ref: EcdsaP256Sig }          # ES256 over the §8.1 canonical string
HandoffConsent:                         # W16b and Y1b (POST form from the consent page)
  additionalProperties: false
  required: [v, pk, state, redirect, device, dk, csrf, decision]
  properties:                           # v, pk, state, redirect, build, mode, device, dk: as HandoffQuery, re-validated
    csrf: { type: string, pattern: '^[A-Za-z0-9_-]{22,128}$' }   # minted by the GET, bound to (state, pk, dk) plus the GET's
                                          # signature verdict (§8.1), single use, 10 min; dts/dsig are not re-sent
    decision: { enum: [continue, cancel] }

AdminUser:
  required: [id, email, role, disabled, created_at, last_seen_at, machines, devices]
  properties: { id: { $ref: Uuid }, email: { $ref: Email }, role: { enum: [user, admin] },
                disabled: { type: boolean }, created_at: { $ref: Timestamp },
                last_seen_at: { $ref: Timestamp }, machines: { type: integer }, devices: { type: integer } }
AdminUserPatch:
  additionalProperties: false
  minProperties: 1
  properties: { role: { enum: [user, admin] }, disabled: { type: boolean },
                revoke_all: { type: boolean } }   # only with disabled: true; tears down their machines,
                                                  # revokes their devices and their Access sessions (07)
AdminMachine:                           # MachineSummary plus operator fields
  allOf: [ { $ref: MachineSummary } ]
  required: [owner_email, tunnel_id, access_app_id, token_version, provisioning, key_fingerprint, origin_port]
  properties:
    owner_email: { $ref: Email }
    key_fingerprint: { $ref: MachineKeyFingerprint }
    origin_port: { $ref: OriginPort }
    tunnel_id: { $ref: Uuid }
    access_app_id: { type: string }
    token_version: { type: integer }
    provisioning: { type: object, required: [state],
                    properties: { state: { enum: [complete, in_progress, failed, compensating] },
                                  last_error_code: { oneOf: [ { type: string }, { type: 'null' } ] } } }
AdminDevice:
  allOf: [ { $ref: Device } ]
  required: [owner_email]
  properties: { owner_email: { $ref: Email } }

AuditEntry:
  required: [id, ts, actor, action, target, result]
  properties:
    id: { $ref: Uuid }
    ts: { $ref: Timestamp }
    actor: { type: object, required: [kind],
             properties: { kind: { enum: [user, machine, system] }, id: { type: string }, email: { $ref: Email } } }
    action: { type: string }              # open enum from registry/audit-actions.json
    target: { type: object, required: [kind],
              properties: { kind: { enum: [org, user, machine, device, settings] }, id: { type: string } } }
    result: { enum: [ok, error] }
    error_code: { type: string }
    country: { type: string, pattern: '^[A-Z]{2}$' }

Settings:                               # W26 (PUT replaces the whole object); 07 renders the console form from it
  additionalProperties: false
  required: [org_name, session_duration, pairing_policy, machine_cap_per_user, device_cap_per_user, push,
             stale_machine_policy, audit_retention_days, quota_limits, orphan_cleanup, deployer_repo_url]
  properties:
    org_name: { type: string, minLength: 1, maxLength: 80 }        # Meta.org.name, page titles
    session_duration: { type: string, pattern: '^[1-9][0-9]{0,3}(m|h)$' }   # Access format, 15m–720h; applied to the
                                                                  # control-plane app and every machine app (05)
    pairing_policy: { type: object, additionalProperties: false, required: [mode, emails, domains, access_group_ids],
                      properties: { mode: { enum: [everyone, allowlist] },
                                    emails: { type: array, maxItems: 500, items: { $ref: Email } },
                                    domains: { type: array, maxItems: 100, items: { $ref: Hostname } },
                                    access_group_ids: { type: array, maxItems: 100, items: { type: string, maxLength: 64 } } } }   # Access group ids (G10)
    machine_cap_per_user: { type: integer, minimum: 1, maximum: 50 }   # default 10
    device_cap_per_user: { type: integer, minimum: 1, maximum: 20 }    # default 10
    push: { type: object, additionalProperties: false,
            required: [enabled, detail, ttl_seconds, relay_allowed, allowed_relays],
            properties: { enabled: { type: boolean }, detail: { enum: [names, minimal] },
                          ttl_seconds: { type: integer, minimum: 60, maximum: 86400 },     # default 3600 (§9)
                          relay_allowed: { type: boolean },                                # default true; false: iOS push off
                          allowed_relays: { type: array, maxItems: 20, items: { $ref: OrgUrl } } } }   # empty = any https relay
    stale_machine_policy: { type: object, additionalProperties: false, required: [notify_after_days, revoke_after_days],
                            properties: { notify_after_days: { oneOf: [ { type: integer, minimum: 1, maximum: 365 }, { type: 'null' } ] },   # default 30
                                          revoke_after_days: { oneOf: [ { type: integer, minimum: 1, maximum: 365 }, { type: 'null' } ] } } }  # default null (off)
    audit_retention_days: { type: integer, minimum: 30, maximum: 3650 }   # default 365
    quota_limits: { type: object, additionalProperties: false, required: [access_apps, access_policies, tunnels],
                    properties: { access_apps: { type: integer, minimum: 1 }, access_policies: { type: integer, minimum: 1 },
                                  tunnels: { type: integer, minimum: 1 } } }   # defaults 500/500/1000 (05)
    orphan_cleanup: { enum: [delete, report] }                    # default delete (05)
    deployer_repo_url: { oneOf: [ { type: string, maxLength: 512, pattern: '^https://' }, { type: 'null' } ] }
# Operational knobs with no admin UI (04's jwt_clock_tolerance_s, 05's drift and budget settings) are
# Worker-internal settings rows, not part of this contract. That includes the reconciliation
# interval: Phase 19's hook H5 forces a reconcile with W28 instead of shortening the cron cadence.

UpdateStatus:
  required: [current, latest, update_available, security, checked_at, error]
  properties: { current: { $ref: SemVer }, latest: { oneOf: [ { $ref: SemVer }, { type: 'null' } ] },
                notes_url: { oneOf: [ { type: string }, { type: 'null' } ] },
                update_available: { type: boolean }, security: { type: boolean },
                checked_at: { $ref: Timestamp },
                error: { oneOf: [ { type: string, maxLength: 200 }, { type: 'null' } ] } }   # "couldn't check", never "up to date"

ReleaseManifest:                        # schemas/release-manifest.schema.json; cloud-deploy:worker/release.json (07, 18)
  required: [train, version, tag, released_at, protocol, min_update_from, security, notes_url, tarball]
  properties: { train: { const: yaran-cloud }, version: { $ref: SemVer },
                tag: { type: string, pattern: '^yaran-cloud-v\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$' },
                released_at: { $ref: Timestamp }, protocol: { $ref: '#/ProtocolRange' },
                min_update_from: { $ref: SemVer }, security: { type: boolean }, notes_url: { type: string },
                tarball: { type: object, required: [url, sha256],
                           properties: { url: { type: string, pattern: '^https://' }, sha256: { type: string, pattern: '^[0-9a-f]{64}$' } } } }

RelayMeta:
  required: [service, protocol, apps, channels, endpoint_key_id]
  properties: { service: { const: yaran-push-relay }, protocol: { $ref: '#/ProtocolRange' },
                apps: { type: array, items: { type: string } },        # served bundle ids / Android application ids
                channels: { type: array, items: { enum: [apns, fcm] } },   # fcm only when the G5 fallback is deployed
                endpoint_key_id: { type: string, pattern: '^[A-Za-z0-9_-]{1,16}$' } }   # current kid; the app re-mints when its endpoint's kid differs
EndpointMintRequest:                    # R2; the relay stores nothing (the endpoint is self-describing)
  oneOf:
    - additionalProperties: false
      required: [kind, app_id, apns_token, apns_environment, vapid_public_key, registration_id]
      properties:
        kind: { const: apns }
        app_id: { type: string, maxLength: 155 }                   # bundle id = apns-topic, must be in RelayMeta.apps
        apns_token: { type: string, pattern: '^[0-9a-f]{64,200}$' }
        apns_environment: { enum: [production, sandbox] }
        vapid_public_key: { $ref: P256Point }                      # the org's key, from Meta.push
        registration_id: { $ref: Uuid }                            # echoed as `r` so the NSE picks the right keys
    - additionalProperties: false                                  # G5 fallback only (channel fcm_relay)
      required: [kind, app_id, fcm_token, vapid_public_key, registration_id]
      properties:
        kind: { const: fcm }
        app_id: { type: string, maxLength: 155 }                   # Android applicationId, must be in RelayMeta.apps
        fcm_token: { type: string, minLength: 1, maxLength: 4096 }
        vapid_public_key: { $ref: P256Point }
        registration_id: { $ref: Uuid }
EndpointMintResponse:
  required: [endpoint]
  properties: { endpoint: { type: string, pattern: '^https://[^/]+/w/v1\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16,1024}$' } }
  # https://<publisher-relay>/w/v1.<kid>.<opaque>; opaque = AES-256-GCM sealed {token, environment,
  # app, vapid key, registration_id} under the relay's ENDPOINT_KEYS[kid] (format owned by 08)
```

Audit actions (initial `registry/audit-actions.json`; dotted `<subject>.<verb>`, and 04's
`audit/actions.ts` catalogue is generated from this file): `setup.completed`, `settings.updated`,
`user.role_changed`, `user.disabled`, `user.enabled`, `user.deleted`, `pair.requested`,
`pair.approved`, `pair.denied`, `pair.refused`, `pair.expired`, `pair.provision_failed`,
`machine.claimed`, `machine.replaced`, `machine.unpaired`, `machine.revoked`,
`machine.rotated`, `machine.reconciled`, `machine.origin_changed`, `device.registered`,
`device.updated`, `device.revoked`, `device.cap_refused`, `device.test_push`,
`device.push_gone`, `device.push_auth_failed`, `device.push_failing`, `sessions.revoked`,
`handoff.issued`, `handoff.declined`, `quota.refused`, `provision.step`, `provision.done`,
`provision.failed`, `teardown.step`, `teardown.done`, `teardown.failed`, `drift.repaired`,
`orphan.found`, `orphan.deleted`, `cloudflare.rate_limited`. (`push.endpoint_removed` from the
first draft is replaced by `device.push_gone`; no build ever emitted it.)

### 7. Machine request signing (SIG)

Keys: Ed25519 (RFC 8032, pure, not pre-hashed). yaran generates the key pair at pairing (ring
`Ed25519KeyPair::generate_pkcs8`; PKCS#8 v2 stored in the credentials file, Phase 09) and
sends the 32-byte public key as `machine_pubkey` in W2.

Headers on every SIG request:

| Header | Value |
|---|---|
| `Yaran-Protocol` | negotiated integer |
| `Yaran-Machine-Id` | `Uuid`; **absent on W4** (the key is resolved through the pair code) |
| `Yaran-Timestamp` | Unix seconds, decimal, no leading zeros |
| `Yaran-Nonce` | 16 CSPRNG bytes, base64url (22 chars) |
| `Yaran-Signature` | base64url of the 64-byte signature (86 chars) |

Canonical string (UTF-8, lines joined with `\n`, no trailing newline):

```text
yaran-machine-sig-v1
<METHOD, uppercase>
<request target: path exactly as sent; machine paths match ^/v1/machine/[a-z]+$ and carry no query>
<Host, lowercase, port removed>
<Yaran-Protocol value>
<Yaran-Machine-Id value, or "-" when absent>
<Yaran-Timestamp value>
<Yaran-Nonce value>
<lowercase hex SHA-256 of the exact body bytes; e3b0c442…b855 for an empty body>
```

Restricting machine paths to `[a-z/]` with no query removes every percent-encoding and
normalization ambiguity between ureq and the Workers URL parser.

Verification order (Phase 04 implements; each step's failure code in brackets):

1. All headers present and well-formed [`signature_missing`]; protocol in range
   [`protocol_unsupported`]; body ≤ 64 KiB [`payload_too_large`].
2. `|server_now − timestamp| ≤ 300 s` [`signature_expired`, with `details.server_time` and a
   `Date` header so yaran can say "your clock is off by N s"].
3. Resolve the public key: by machine id (revoked machines keep their key) or, for W4, by the
   pair code's recorded `machine_pubkey`; unknown → [`machine_unknown`] / [`pair_code_invalid`].
4. Recompute the body hash from the received bytes and verify the signature over the canonical
   string [`signature_invalid`].
5. Machine revoked → [`machine_revoked`] (only after a valid signature, so revocation status is
   not disclosed to strangers).
6. Record `(machine_id or "claim:"+code, nonce)` until `timestamp + 600 s`; an existing record →
   [`nonce_replayed`].

Phase 04's draft names map onto these codes: `bad_signature` is `signature_invalid`,
`clock_skew` is `signature_expired`, `replayed_nonce` is `nonce_replayed`. The canonical string
above (with Host, protocol and machine id, without any query) is the only one; no phase builds
its own.

#### 7.1 Machine key fingerprint

The string a person compares on the pairing confirm page (W2) against what yaran printed:

```text
digest      = SHA-256( UTF-8 "yaran-machine-key-v1\n" ‖ the 32 raw public-key bytes )
fingerprint = RFC 4648 base32 (alphabet A–Z 2–7, no padding) of digest[0..15]   → 24 chars
display     = the 24 chars in six groups of four joined by "-"                   → 29 chars
example     = "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E" (shape only; the fixture holds real values)
```

- 120 bits: a crafted pairing link cannot be matched by a key search, and the base32 alphabet
  has no `0`/`1`/`8`/`9` to confuse with letters.
- Rendered as a monospace chip (06 confirm page, 07 admin machines, and 09's CLI, TUI and web
  "Yaran Cloud…" login dialog; Phase 13 builds no login surface) and compared
  case-insensitively if a person types it.
- Implemented once per language: TS `src/sig/fingerprint.ts` `machineKeyFingerprint(pub)`,
  Rust `cloud::protocol::fingerprint::machine_key_fingerprint(&[u8; 32])`; pinned by
  `fixtures/sig/fingerprint.json` (several keys, digest hex, fingerprint).
- The handoff device key (D24) reuses this construction with its own tag,
  `"yaran-device-key-v1\n"`, over the 65-byte uncompressed point: `DeviceKeyFingerprint`, §8.1.

### 8. Sealed envelope (handoff) — JWE profile `yaran-handoff+jwe`, v1

Purpose (D8): Y1/Y1b and W16/W16b run behind Access, so Access has attached the app token
(`Cf-Access-Jwt-Assertion`). After the person confirms on a consent page, the endpoint seals
that token to the phone's ephemeral key and redirects to the app's callback. A hijacked
redirect yields only ciphertext.

**Redirect allowlist** (`src/redirect.ts`, Rust `uri.rs` `redirect_allowed`; one rule, both
servers):

| `build` | `redirect` must equal, byte for byte | Notes |
|---|---|---|
| `release` (default) | one of the configured https callbacks, by default exactly `https://<publisher-domain>/auth/callback` | Android App Link (Auth Tab / Custom Tab) and iOS `ASWebAuthenticationSession` `.https` callback (iOS 17.4+); the OS delivers it only to the app the domain's `assetlinks.json` / `apple-app-site-association` vouch for (hosted by Phase 21) |
| `dev` | `yaranapp://auth/callback` | only builds compiled without a publisher domain send this, and they show a visible warning in the app (D8) |

Anything else, including a `release` request naming the custom scheme or a `dev` request naming
an https URL, is `400 handoff_request_invalid` and is never redirected to. The configured list
is `APP_CALLBACK_URLS` in the Worker's deploy config (Phase 07; set by the `yaran-cloud-v*`
release build from the maintainer's publisher domain, D16) and `[cloud] app_callback_urls` in
yaran's config (Phase 09 renders it, Phase 11 enforces it; the compiled-in default is the same
release value). A fork that publishes its own app adds its own https callback to both lists.

**Request.** `GET https://<host>/__yaran/handoff?v=1&pk=<P256Point>&state=<state>&redirect=<pct-encoded callback>&device=<pct-encoded label>&dk=<P256Point>&dts=<unix s>&dsig=<EcdsaP256Sig>[&build=dev][&mode=fragment]`
(W16: `https://<org-control-plane>/v1/handoff?…`). The server validates, in order: `v` in range,
`build` and `redirect` against the allowlist, `state` pattern, `mode`, `device` (1–64 chars,
control and bidi characters refused), `pk` decodes to 65 bytes starting `0x04` and lies on
P-256, then `dk`, `dts` and `dsig` per §8.1 (form and freshness only), a verified Access JWT is
present (Y1: Phase 11 verifier with owner check; W16: Phase 04 verifier, user JWT), and finally
the §8.1 signature check and remembered-consent skip rule.

**Consent interstitial** (the GET's success answer). `200 text/html`, `no-store`, the strict
CSP of the serving side, no script needed. It names, as chips: the `device` label, the platform,
the host being signed in to, and the signed-in email, and asks "Sign this device in to `<host>`?" with **Continue** (primary) and **Cancel**. For
`build=dev` it adds a warning that the request comes from a development build of the app and
should be continued only by someone who built or installed that build. Both buttons submit
`HandoffConsent` as a form `POST` to the same path. Copy belongs to 06 (Worker) and 11 (yaran),
in the house voice. This is what stops a silent SSO auto-approve from completing a handoff the
person did not start. The page is skipped only under §8.1's remembered-consent rule (D24), which
needs a prior explicit Continue from the same device key.

The page runs in the system browser (Android Auth Tab / Custom Tab, iOS
`ASWebAuthenticationSession`), so the request carries the browser's User-Agent and never the
§11 app token. The platform is therefore read from the browser UA (yaran: `short_device_label`;
Worker: the OS token, Android or iOS/iPadOS), shown only when recognised, and the `device`
query field is the app's own name for the phone. A §11 token, if one is ever present, wins.

Both consent pages (W16, Y1), and the W2 pairing confirm page for the same reasons, MUST send:
- `Referrer-Policy: same-origin`, never `no-referrer`: a document under `no-referrer` sends
  `Origin: null` on its own form POST (Fetch "append a request Origin header"), which the §2
  Origin rule refuses;
- a CSP whose `form-action` is `'self'` plus the origin of the redirect target the POST answers
  with (the configured https callback's origin, or `yaranapp:` for `build=dev`; for W2, the
  exact `http://127.0.0.1:<port>` of the validated callback), because CSP Level 3 checks
  `form-action` on the redirect that follows a submission; plus `frame-ancestors 'none'`.
The 303/302 redirect responses themselves keep `Referrer-Policy: no-referrer` (below).
WebKit's `form-action`-on-redirect behaviour is UNVERIFIED (owner: Phase 19's end-to-end run
in Auth Tab, Custom Tab and `ASWebAuthenticationSession`; fallback in Phase 11's Risks).

**Consent POST** (W16b/Y1b). Re-validates every field exactly as the GET did, checks `csrf`
(minted by that GET, bound to `state` and `pk`, single use, 10 minutes; each server mints and
checks its own) and the `Origin` rule (§2), then:
- `decision=cancel` → `303` to the callback with `error=handoff_declined`;
- `decision=continue` → rate limit (Worker: 20 per minute per JWT `sub`, Phase 06; yaran:
  process-wide `[cloud] handoff_requests_per_minute`, default 12, Phase 11), seal, `303`, plus
  the §8.1 consent cookie when the GET's signature verdict was `verified`.

**Success response.** `303 Location: <redirect>?state=<state>&jwe=<compact JWE>` (with
`mode=fragment`: `<redirect>#state=<state>&jwe=<compact JWE>`), with `Cache-Control: no-store`,
`Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and no
body beyond a one-line fallback link.

**Error response.** If `build`, `redirect` and `state` are valid: `302` (from the GET) or `303`
(from the POST) to `<redirect>?state=<state>&error=<code>` (fragment form likewise; plus
`&min=<n>&max=<n>` for `protocol_unsupported`; `rate_limited` also sets `Retry-After`).
Otherwise `400` with the §4 code (JSON envelope; both servers serve a minimal HTML page with the
same code to browser navigations).

**JWE.** Compact serialization (RFC 7516) with five parts; the encrypted-key part is empty.

```json
{ "alg": "ECDH-ES", "enc": "A256GCM",
  "typ": "yaran-handoff+jwe", "cty": "yaran-handoff+json",
  "kid": "<RFC 7638 SHA-256 thumbprint of the recipient pk, base64url>",
  "epk": { "kty": "EC", "crv": "P-256", "x": "<43>", "y": "<43>" },
  "apu": "<base64url(UTF-8 sealer host)>",
  "apv": "<base64url(UTF-8 state)>" }
```

- `Z` = the 32-byte ECDH x-coordinate. `CEK = SHA-256(00 00 00 01 ‖ Z ‖ OtherInfo)`, with
  `OtherInfo = len32("A256GCM") ‖ "A256GCM" ‖ len32(apu_raw) ‖ apu_raw ‖ len32(apv_raw) ‖
  apv_raw ‖ 00 00 01 00` (keydatalen 256; `len32` is a 32-bit big-endian length; RFC 7518
  §4.6.2). `apu` ≠ `apv` always holds (a host is never a 22+ char base64url state).
- IV: 12 random bytes. Tag: 16 bytes. AAD: the ASCII bytes of the base64url protected header
  as transmitted.
- Thumbprint (RFC 7638): SHA-256 over `{"crv":"P-256","kty":"EC","x":"…","y":"…"}`, exactly
  that member order, no whitespace.
- Plaintext (`cty`), UTF-8 JSON, ≤ 6 KiB:

```json
{ "v": 1, "kind": "machine", "host": "laptop-ada.<zone>",
  "jwt": "<Access app token>", "email": "ada@example.org",
  "exp": 1731657600, "iat": 1731571200,
  "cookie": "<raw CF_Authorization cookie value, optional>" }
```

Schema name `HandoffPayload`. `kind` is `machine` (Y1b) or `control_plane` (W16b); `jwt` is the
`Cf-Access-Jwt-Assertion` value exactly as Access attached it; `exp` is copied from the JWT;
`email` lets the app show who signed in. `cookie` is present only when the request carried a
`CF_Authorization` cookie (its raw value, verbatim); it feeds G1's first fallback rung
(Phase 15 injects it instead of `jwt` when G1 shows Access needs the cookie value). No other
fields (`aud` and `state` are bound by the JWT and `apv`). Whole `jwe` parameter ≤ 8192 chars,
so with `cookie` the plaintext cap stays 6 KiB.

**Opener obligations** (Phase 15; every MUST has a negative vector):

1. Exactly five parts, part 2 empty, header is JSON [`jwe_malformed`].
2. `alg`, `enc`, `typ`, `cty` exactly as above [`jwe_unsupported`].
3. `kid` equals the thumbprint of the key the app generated for this handoff [`jwe_kid_mismatch`].
4. `epk.crv == "P-256"`, `x` and `y` each decode to exactly 32 bytes, and the point satisfies
   `y² = x³ − 3x + b (mod p)`. **Check explicitly** on CryptoKit and JCA, where import-time
   validation is undocumented [`jwe_point_invalid`].
5. `apv` decodes to the state this app stored (constant-time compare) [`jwe_state_mismatch`];
   `apu` decodes to the host the app opened [`jwe_host_mismatch`].
6. Decrypt with the AAD rule [`jwe_decrypt_failed`].
7. Plaintext `host` equals the expected host [`jwe_host_mismatch`], `kind` matches
   [`jwe_kind_mismatch`], `exp > now + 60 s` [`jwe_expired`].
8. The recipient key is ephemeral: in memory only, one handoff, destroyed after open or after
   10 minutes. That makes any envelope single-use and removes any need for Keystore ECDH
   (so Android's API 31 limit does not apply).

**Residual risk (documented, not designed away).** Direct ECDH-ES does not authenticate the
sender. On release builds the verified https callback reaches only our app, so nobody else sees
`pk` and `state`. On a dev build (custom scheme), an app that hijacks `yaranapp` sees `pk` and
`state` and could hand our app an envelope sealing *its own* org JWT. For W16 the phone would
then act as the attacker's account in that same org (the token's `aud` is the org's
control-plane app); for Y1 the machine rejects any non-owner JWT. A hostile app that starts its
own flow still has to get the person through the consent page, which names the device and, for
dev builds, warns; remembered consent (§8.1) cannot skip it, because that flow cannot sign with
our device key. Mitigations: release builds never use the custom scheme, dev builds warn on
screen and on the consent page, the app shows the signed-in `email` after onboarding, and the
threat is recorded in Phase 17's threat model (T36, T63).

**Implementations.**
- TS (Worker sealer, shell and test opener): `jose` 6.2.17 `CompactEncrypt` /
  `compactDecrypt` plus the profile checks in `src/jwe/handoff.ts`; `src/jwe/kdf.ts` exists
  only to pin the RFC 7518 Appendix C vector and to prove jose's KDF against ours.
- Rust (yaran sealer, Y1): ring ECDH (ephemeral generate → `agree_ephemeral` with the phone's
  point) → Concat KDF via `ring::digest::SHA256` → `aead::AES_256_GCM` with a random nonce.
  Split as `seal_with_secret(z, epk, iv, header, plaintext)` so fixtures (which give `z`)
  test it deterministically; ECDH itself is tested by round-trip through a dev-only
  `p256` 0.14 + `aes-gcm` 0.11 opener.
- Kotlin and Swift openers: hand-written Concat KDF over `SHA-256` (never CryptoKit's X9.63
  helper), `AES/GCM/NoPadding` / `AES.GCM.open`.

#### 8.1 Device key, request signature and remembered consent (D24)

Consent on every renewal is unusable and consent never is unsafe (R2), so the consent page is
remembered per (host, device key), and only a request that proves possession of that key can
use the memory.

**Device key.** When the app adds an org it mints, beside that org's `InstallId` (§2), a P-256
signing key that never leaves hardware-backed storage: Android Keystore (`PURPOSE_SIGN`,
`DIGEST_SHA256`, StrongBox when present, else TEE) or the iOS Secure Enclave
(`kSecAttrTokenIDSecureEnclave`, `…AfterFirstUnlockThisDeviceOnly`). Both make it
non-exportable. There is one key per org registration rather than per install, for the same
no-correlation reason as `InstallId`: the public key goes to that org's Worker and to every
machine in it. It signs every W16 and Y1 request for that org, is discarded with the
`InstallId` (org removed, `device_revoked`), and is separate from the ephemeral recipient key
`pk` (opener obligation 8). Signing needs no user presence: the consent page, not the key, is the
human check. The app registers it with the Worker as `DeviceRegistration.device_key` (W12).

**Request fields** (`HandoffQuery`, both GETs; all three required):

| Field | Type | Meaning |
|---|---|---|
| `dk` | `P256Point` | the device public key |
| `dts` | decimal Unix seconds, no sign or leading zeros | when the app signed |
| `dsig` | `EcdsaP256Sig` | signature over the canonical string below |

**Canonical string** (ASCII, five lines, each ending in LF, nothing else):

```text
yaran-handoff-device-v1\n
<host>\n
<pk>\n
<state>\n
<dts>\n
```

- `host`: the server's own served hostname, lowercase, no port, no trailing dot (Y1: the bound
  cloud hostname the request arrived on; W16: the recorded control-plane host), never a value
  from the query. It equals the envelope's `apu` and the host the app opened.
- `pk` and `state`: the query values exactly as sent (`pk` as its 87-char string; signing the
  encoded form keeps every language byte-identical). `dts`: the same decimal string as sent.

**Signature.** ECDSA P-256 with SHA-256 over those bytes (JWS `ES256`, RFC 7518 §3.4): `dsig`
is base64url, no padding, of `r ‖ s`, each a 32-byte big-endian integer (86 chars). Android
Keystore (`SHA256withECDSA`) and `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` return
DER, so the app converts DER to raw (left-padding each integer to 32 bytes); CryptoKit's
`rawRepresentation` is already raw. Verifiers: WebCrypto `{name:"ECDSA", hash:"SHA-256"}` (raw
`r ‖ s` natively) and ring `ECDSA_P256_SHA256_FIXED`. A DER value is malformed, never sniffed.
High-s signatures verify (both libraries accept them, and nothing here keys on the signature
bytes).

**Checks, in §8's validation order after `pk` and before the Access JWT.** `dk` decodes to 65
bytes starting `0x04` and lies on P-256 [`handoff_device_key_invalid`]; `dts` is decimal and
`dsig` is 86 base64url chars decoding to 64 bytes with `0 < r, s < n`
[`handoff_signature_malformed`]; `|server_now − dts| ≤ 300 s` [`handoff_timestamp_skewed`, the
error redirect adding `&server_time=<unix s>`, the JSON envelope `details.server_time`]. A missing
field fails as a malformed one. After the Access JWT checks the server verifies `dsig`: a
well-formed signature that does not verify is **not an error**; it yields `verified = false` and
the consent page. A replay inside the 300 s window gains nothing, since the envelope is sealed to
`pk`, which only the original app can open.

**Device key fingerprint.** §7.1's construction with the tag `"yaran-device-key-v1\n"` over the
65 raw point bytes: type `DeviceKeyFingerprint` (29-char display form); the cookie carries the
24-char form without dashes (`fp24`). TS `deviceKeyFingerprint(pub)` in `src/sig/device.ts`,
Rust `cloud::protocol::handoff_consent::device_key_fingerprint(&[u8; 65])`.

**Consent cookie** (one name on both servers; host-only, so they never meet):

```text
name    __Secure-yaran-handoff-consent
attrs   Path=<handoff path>; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax   (no Domain)
        <handoff path> = /__yaran/handoff (Y1b) or /v1/handoff (W16b)
value   v1.<kv>.<fp24>.<iat>.<mac>
mac_in  "yaran-handoff-consent-v1\n" ‖ host ‖ "\n" ‖ fp24 ‖ "\n" ‖ iat ‖ "\n" ‖ kv ‖ "\n"   (ASCII)
mac     base64url( HMAC-SHA256( consent_key[kv], mac_in ) )   → 43 chars, compared in constant time
```

- `kv`: decimal key version ≥ 1. `iat`: decimal Unix seconds at issue. `host`: as in the
  canonical string; bound by the MAC, not carried in the value.
- Max-Age 34,560,000 s is 400 days, the browser cap. The server also requires
  `now − 34560000 ≤ iat ≤ now + 300`, because Max-Age is the browser's promise, not the server's.
  A skip does not refresh the cookie, so an active device meets the page about once in 400 days.
- `SameSite=Lax` suffices: the GET is a top-level navigation opened by the app.
- **Worker key**: `HKDF-SHA256(DATA_KEY, salt = "yaran-cloud", info = "v1/handoff_consent")`,
  Phase 04's per-purpose scheme with the new purpose `handoff_consent` (its one MAC key). `kv` is
  04's current `DATA_KEY` key version, and only that version verifies (`DATA_KEY_PREVIOUS` never
  does), so rotating `DATA_KEY` forgets every remembered consent.
- **yaran key**: `handoff_consent_key` (32 random bytes, `B64url`) and
  `handoff_consent_key_version` (integer) in Phase 09's credentials file, minted on each
  successful claim with the version incremented, kept across tunnel-token rotation, deleted with
  the credentials. Only the current version verifies.

**Skip rule** (GET only, evaluated after every §8 and device check and the Access JWT checks have
passed). The consent page is skipped only when **all** hold:

1. the cookie is present and well-formed, its `kv` is current, its `mac` verifies, and its `iat`
   is in range;
2. its `fp24` equals the fingerprint of the request's `dk`;
3. `dsig` verifies (`verified = true`);
4. `dts` is fresh (already enforced above);
5. Worker only: no revoked device row (Phase 06, `revoked_at` set) carries that
   `device_key_fingerprint`.

A skip answers exactly as Continue would: rate limit, seal, `302` with §8's success headers. The
Worker's `handoff.issued` audit records `details.consent: "remembered"` or `"explicit"`. When any
rule fails the consent page is shown; a failing cookie is ignored, never an error, and never
cleared.

**Setting the cookie.** The GET records `dk`'s fingerprint and the `verified` verdict with the
`csrf` it mints. `HandoffConsent` carries `dk`, which must equal the recorded key
[`handoff_request_invalid`]; `dts` and `dsig` are not re-sent, because the csrf's 10 minutes
outlive the 300 s window and the GET already decided. The `303` for `decision=continue` carries
`Set-Cookie` only when `verified` was true. Cancel neither sets nor clears it. Nothing sets the
cookie without an explicit Continue.

**Invalidation.** Worker: revoking a device (W14, W24) stops its skips at once through rule 5;
rotating `DATA_KEY` drops them all. yaran: a new claim or deleted credentials drop them all.
yaran never learns of a Worker device revocation; see Risks.

**Dev builds (`build=dev`).** Remembered consent applies. The dev residual risk above is a
hijacker relaying an envelope from a flow it started; that flow carries the hijacker's key,
cannot produce our `dsig`, and therefore always meets the consent page and its dev warning.
Skipping our own renewals drops only a repeat of a warning the person already accepted for this
key. A dev and a release install on one phone hold different keys and overwrite each other's
cookie on a shared host; each then meets the page once.

### 9. Push

**Event to push.** The Worker turns each accepted `Event` (W6) into one Web Push message per
eligible device (org `push.enabled`, `push_state` not `gone`/`auth_failed`, device not muted per
the `DeviceRegistration` mute rule, machine not in `muted_machine_ids`, relay channels only when
`push.relay_allowed`). Phase 08 implements RFC 8291 `aes128gcm` and RFC 8292 VAPID (ES256,
`aud` = push service origin, `exp` ≤ 24 h, `sub` = the control-plane URL) in
`src/webpush/ece.ts` and `src/webpush/vapid.ts` of this package.

**Plaintext payload v1** (`schemas/push.schema.json`, schema name `PushPayload`, the only thing
inside the encryption):

```json
{ "v": 1, "k": "attention_raised", "m": "<machine Uuid>", "a": "<agent YaranId>",
  "t": "<tab YaranId, omitted for the slot tab>", "s": "needs_attention",
  "p": "<project ≤ 24 bytes, optional>", "l": "<label ≤ 24 bytes, optional>", "ts": 1731571200 }
```

- `k`: `attention_raised | attention_cleared | agent_exited_badly | test` (open enum).
  `s` is a token, never display text: the event's RowState token (`state`) for attention kinds
  and the `ending` token for `agent_exited_badly`; the device maps it to localized words
  (Phase 16) and treats an unknown token as the generic text. `test` carries only `v`, `k`,
  `ts`. `ts` is Unix seconds (the event's `Timestamp`), to save bytes.
- `p` and `l` are truncated on a UTF-8 character boundary to at most 21 bytes plus `…`
  (3 bytes) when longer than 24 bytes, and omitted when the event omitted them.
- **Hard cap: 320 bytes** of serialized UTF-8 JSON (worst case with three 36-char ids and both
  strings at 24 bytes is about 265). Rationale: the iOS relay re-wraps the ciphertext as
  base64url inside an APNs payload; 320 B plaintext gives ≤ 423 B ciphertext and ≤ 564 chars
  of base64url, far inside APNs' 4096. RFC 8291's 3993-byte ceiling never comes into play.
- The device resolves `m` to a machine name from its cached `/v1/me/machines` list and builds
  localized text itself (Phase 16 owns the copy). A tap opens `https://<host>/#/agent/<a>` or
  `#/agent/<a>/tab/<t>` in `machine-view`.

**Web Push headers** (`TTL` from the org setting `push.ttl_seconds`, default 3600):

| `k` | `Urgency` | `TTL` (s) | `Topic` | Delivered as |
|---|---|---|---|---|
| `attention_raised` | `high` | `push.ttl_seconds` | topic(m, a, t) | visible notification |
| `attention_cleared` | `very-low` | `push.ttl_seconds` | topic(m, a, t) (replaces an undelivered raise) | background/data message that removes the notification; never shows anything |
| `agent_exited_badly` | `high` | `push.ttl_seconds` | topic(m, a, t) | visible notification (replaces the attention one) |
| `test` | `normal` | 300 | none | visible notification |

`very-low` for cleared events keeps FCM and APNs from demoting the app for high-priority pushes
that show nothing (Phase 16); the relay maps it to an APNs background push (below).

`topic(m, a, t) = first 32 chars of base64url(SHA-256("yaran-topic-v1\n" + m + "\n" + a + "\n" + (t or "")))`,
which fits RFC 8030's 32-character base64url rule and is also used as `apns-collapse-id` and as
the Android notification tag.

**Relay → APNs** (R3; Phase 08 sends, Phase 16's NSE and background handler read). The three
relay fields sit at the top level, the same names as the FCM data message below:
`v` (relay wrapping version, 1), `r` (`registration_id`), `y` (base64url of the full
`aes128gcm` body).

`Urgency` `high` or `normal` (an alert the NSE rewrites):

```json
{ "aps": { "alert": { "title-loc-key": "PUSH_GENERIC_TITLE", "loc-key": "PUSH_GENERIC_BODY" },
           "mutable-content": 1, "sound": "default", "thread-id": "<Topic or 'yaran'>" },
  "v": 1, "r": "<registration_id>", "y": "<base64url of the full aes128gcm body>" }
```

`Urgency` `low` or `very-low` (a background push; best effort, iOS throttles these):

```json
{ "aps": { "content-available": 1 }, "v": 1, "r": "<registration_id>", "y": "<base64url …>" }
```

Headers: `apns-push-type: alert` with `apns-priority: 10` for `high` and `5` for `normal`;
`apns-push-type: background` with `apns-priority: 5` for `low`/`very-low`;
`apns-expiration: now + TTL` (TTL 0 stays 0), `apns-collapse-id: <Topic>` when present,
`apns-topic: <app_id>`. The NSE picks keys by `r`, decrypts `y` per RFC 8291, and on any
failure leaves the generic localized alert in place.

**Grouping vs collapse.** Collapse is per agent tab: Topic is the `apns-collapse-id` and the
Android tag, so a repeat replaces. Grouping is per machine on both platforms: the Android group
key is `"<orgId>/<machineId>"` (16), and the NSE, once it has decrypted `m`, sets
`threadIdentifier` to the same `"<orgId>/<machineId>"`. The relay cannot see `m`, so the
`thread-id` it sends (Topic, or `yaran` for `test`) is only the fallback a failed decrypt leaves
in place; a per-tab thread would be a group of one, because the collapse id already keeps one
notification per tab.

**Relay → FCM** (G5 fallback only, channel `fcm_relay`): a data message
`{ "data": { "v": "1", "r": "<registration_id>", "y": "<base64url …>" },
"android": { "priority": "high" for Urgency high, else "normal", "ttl": "<TTL>s",
"collapse_key": "<Topic>" } }`.

**R3 answers.** RFC 8030 `201 Created` on success. The relay requires
`Content-Encoding: aes128gcm` and `TTL` and refuses bodies above 2,900 bytes with `413`
(so the base64url body plus JSON fits APNs' 4,096; yaran payloads are ≤ 423 bytes). `401
relay_vapid_invalid`; `403 relay_vapid_mismatch` when the VAPID `k` differs from the key bound
at mint; `404 relay_endpoint_invalid` for an unknown kid or bad tag; `410 push_endpoint_gone`
when APNs (unregistered, `BadDeviceToken`, `DeviceTokenNotForTopic`) or FCM (`UNREGISTERED`)
says the token can never work; `429` with `Retry-After`; `502 relay_upstream_failed` for the
relay's own credential errors; `503 unavailable` with `Retry-After` for upstream 5xx.

**Delivery outcomes at the org Worker** (Phase 08 implements; `push_state` in `Device`):

| Push service answer | Device record |
|---|---|
| 2xx | `push_state = active` |
| 404 or 410 (including the relay's `push_endpoint_gone`) | subscription fields cleared, `push_state = gone`, **row kept**, audit `device.push_gone`; the app sees `gone` on its next `GET /v1/me/devices` and re-registers (Phase 16); consoles say "push stopped: the subscription expired" |
| 401 or 403 | `push_state = auth_failed`, audit `device.push_auth_failed`; the app re-registers with the current `Meta.push.vapid_public_key` |
| 429, 5xx, network | retried by Phase 08's queue; after 5 consecutive exhausted retries `push_state = failing`, audit `device.push_failing` |
| 400, 413 | dropped and logged (a bug, never retried) |

A device is marked revoked only by W14 or W24, and removed only with its user (W19); a push
answer never does either.

### 10. URI schemes

| URI | Produced by | Consumed by | Rules |
|---|---|---|---|
| `yaranapp://add-org?u=<pct-encoded OrgUrl>` | QR from CLI/TUI/web/consoles (09, 13, 07, built by 06's `phoneQrPayload` and Rust `add_org_uri`) | app (14) | `u` must match `OrgUrl`; total ≤ 512 chars; pinned by `fixtures/uri/add-org.json` |
| `https://<publisher-domain>/auth/callback?state=…&jwe=…` / `…&error=<code>[&min&max]` (or the same after `#` with `mode=fragment`) | W16b, Y1b (W16, Y1 for errors) | app (15), release builds | verified App Link / Universal Link; `state` must match a pending handoff; the only callback a release build sends |
| `yaranapp://auth/callback?…` (same parameters) | W16b, Y1b, only for `build=dev` | app (15), builds without a publisher domain | `state` must match a pending handoff; such builds show a visible warning |
| `https://<publisher-domain>/oauth/callback` · `yaranapp://oauth/callback` (dev) | Access Managed OAuth (G1 step 2 only) | app (15) | release vs dev split exactly as the handoff callback; registered in the Access app's `allowed_uris` (03 G1, 05/07) |
| `yaranapp://reauth?host=<Hostname>` | web UI inside machine-view (13) | machine-view (15) | in-WebView control URL; honoured only when `host` is the host currently loaded |
| `yaranapp://home` | web UI app menu (13) | machine-view (15) | in-WebView control URL; no parameters |
| `yaranapp://settings` | web UI app menu (13) | machine-view (15) | in-WebView control URL; no parameters |

The three control URLs stay on the custom scheme in every build: they never leave the app's own
WebView, because machine-view intercepts them before navigation, so no other app can receive
them.

Parsing rules (`src/uri.ts`, mirrored in Rust `uri.rs` for the builders yaran needs): compare
the scheme case-insensitively, treat the authority as the command, reject duplicate
parameters, ignore unknown parameters, log unknown commands as `uri_invalid` and do nothing.

**Why release builds use https and `yaranapp` remains at all.** RFC 8252 §7.1 mandates
reverse-DNS schemes for OAuth redirects and §7.2 prefers claimed https redirects. The handoff is
not an OAuth authorization-server redirect, but a custom scheme can be registered by any app,
so release builds return on the verified https callback on `<publisher-domain>` (D8), which the
maintainers supply through build config (D16; Phase 21 hosts the association files). Builds
compiled without a publisher domain (forks, local development) cannot claim an https callback,
so they keep `yaranapp://auth/callback`, declare `build=dev`, and say so on screen; the
handoff endpoints validate the exact redirect string, and a hijack yields only ciphertext.
A reverse-DNS scheme would need a domain the project controls and D16 forbids inventing one,
so the custom scheme stays `yaranapp`. Phase 17 records the dev-build residual (§8, T36).

### 11. UA token

```abnf
yaran-app-token = "YaranApp/" app-version " (" os "; " form ")"
app-version     = 1*4DIGIT "." 1*4DIGIT "." 1*4DIGIT [ "-" 1*32( ALPHA / DIGIT / "." / "-" ) ]
os              = "android" / "ios"
form            = "phone" / "tablet"
```

The app appends the token, after one space, to the platform WebView's default UA in
machine-view (so `Chrome/` and `Safari/` tokens remain) and sends it as the whole UA on its
native HTTP calls. Parsers match
`(?:^| )YaranApp/(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?) \((android|ios); (phone|tablet)\)(?= |$)`.
Rust `ua.rs` and TS `ua.ts` return `{version, os, form}` and are pinned by `fixtures/ua/`. The
visible label wording (which must fit `SHORT_LABEL_MAX_CHARS = 24`) belongs to Phase 13.

### 12. Fixtures and test vectors

| Directory | Contents | Consumers |
|---|---|---|
| `fixtures/api/<Schema>/{valid,invalid}/*.json` | ≥ 1 valid and ≥ 1 invalid per constraint class for every schema in §6; each invalid file names the failing keyword | TS schemas test; Rust round-trip; Worker (04, 06, 07); relay (08) |
| `fixtures/jwe/kdf-rfc7518-appendix-c.json` | RFC 7518 App. C inputs, Z, OtherInfo hex, K (`VqqN6vgjbSBcIijNcacQGg`, keydatalen 128) | TS, Rust, Kotlin, Swift KDF tests |
| `fixtures/jwe/kdf-rfc7520-5.5.json` | RFC 7520 §5.5 (ECDH-ES direct, P-256) inputs verbatim: recipient and ephemeral JWKs with `d`, protected header, compact JWE, plaintext; plus derived `z_hex`, OtherInfo hex and `cek_hex` (`enc` A128CBC-HS256, keydatalen 256); `gen-vectors.mjs` proves the CEK by opening the RFC's JWE with jose | TS, Rust (`concat_kdf.rs`, Phase 11's KDF case), Kotlin and Swift KDF tests |
| `fixtures/jwe/handoff-v1-valid-{machine,control-plane}.json` | recipient JWK with `d`, ephemeral JWK with `d`, IV, plaintext, protected header, `z_hex`, `cek_hex`, compact JWE, expected host/state/kind | TS (seal deterministic via test-only epk/IV), Rust (`seal_with_secret`), openers |
| `fixtures/jwe/handoff-v1-invalid-*.json` | tampered ciphertext, tampered header, wrong kid, off-curve epk, 31-byte x, compressed point, `alg` RSA-OAEP, `enc` A128GCM, apv≠state, apu≠host, plaintext host mismatch, kind mismatch, expired, non-empty part 2, six parts; each names its `jwe_*` code | all openers |
| `fixtures/sig/*.json` | Ed25519 seed and PKCS#8, public key, request (method, path, host, protocol, machine id, timestamp, nonce, body), canonical string, body hash, signature (deterministic); negatives: wrong host, body tampered, skewed timestamp, replayed nonce sequence, query present, bare `/v1/machine` path | Rust signer, TS verifier, Worker (04) |
| `fixtures/sig/fingerprint.json` | public keys, digest hex, `MachineKeyFingerprint` (§7.1) | Rust (09), TS (06, 07), web login dialog (09) |
| `fixtures/sig/device-fingerprint.json` | device public keys (`P256Point`), digest hex, `DeviceKeyFingerprint` and its 24-char cookie form (§8.1) | TS (06), Rust (11), Kotlin and Swift (15) |
| `fixtures/sig/handoff-device-signature.json` | fixed device key (JWK with `d`), host, `pk`, `state`, `dts`, canonical string (text and hex), `dsig`; **ECDSA is randomized, so `dsig` is committed once and `--check` verifies it rather than regenerating it**. Negatives: wrong host, wrong `pk`, wrong `state`, `dts` ±1, other key's signature (each `verified: false`, consent page); DER signature, 85/87 chars, `r = 0`, `s = n` (`handoff_signature_malformed`); compressed or off-curve `dk` (`handoff_device_key_invalid`); `dts` at ±300 s accepted and ±301 s refused (`handoff_timestamp_skewed`) | TS verifier (06), Rust verifier (11), Kotlin and Swift signers (15: canonical bytes equal, sign → verify round-trip, DER → raw conversion) |
| `fixtures/handoff/consent-cookie.json` | HMAC key hex, host, `fp24`, `iat`, `kv`, `mac_in` (text and hex), `mac`, full cookie value and `Set-Cookie` line for both paths; the Worker key derivation (`DATA_KEY` → `info = "v1/handoff_consent"` → key hex); negatives: tampered `mac`, other host, stale `kv`, `iat` > now + 300, `iat` < now − 34560000, five-part violations, `fp24` with dashes or lowercase | TS (06), Rust (11) |
| `fixtures/handoff/remembered-consent.json` | the skip decision table (§8.1): inputs `{cookie, dk, verified, dts_fresh, device_revoked, side}`, expected `skip` or `consent_page` and whether Continue sets the cookie; covers every rule failing alone, no cookie, `build=dev`, and Worker-only rule 5 ignored on yaran | TS (06), Rust (11) |
| `fixtures/push/payload-*.json` | events → payload, truncation (ASCII, CJK, emoji at the boundary), omitted slot tab, size cap rejection, topic derivation, every `s` token | TS, Worker (08), Kotlin and Swift decoders (16) |
| `fixtures/push/relay-wrapping.json` | the APNs alert and background bodies and the FCM data message for one ciphertext (§9) | relay (08), NSE and Android (16) |
| `fixtures/webpush/rfc8291-appendix-a.json` | the RFC 8291 vector verbatim | Worker encrypt (08), Android and NSE decrypt (16) |
| `fixtures/webpush/payload-vectors.json` | v1 payloads (1 byte, 320 bytes, 3993 bytes, 3994 refused) encrypted with fixed `ua`/`as` keys, salt and auth secret | 08, 16 |
| `fixtures/webpush/vapid-vectors.json` | VAPID valid, expired, `exp` > 24 h, wrong `aud`, wrong `k` | 08 |
| `fixtures/access-jwt/` | `generate.mjs` plus committed `jwks.json`, `jwks-rotated.json`, `tokens.json` (Phase 11 owns the cases) | Rust verifier (11), Worker verifier (04) |
| `fixtures/uri/*.json` (incl. `add-org.json`, `handoff-redirect.json` for the §8 allowlist), `fixtures/ua/*.json`, `fixtures/version/negotiate.json` | valid and invalid cases | TS, Rust, apps, Worker (06), yaran (11) |
| `fixtures/uri/control-urls.json` | the three in-WebView control URLs (§10): cases `{uri, loaded_host, expect}` for `yaranapp://reauth?host=` (equal host honoured; other host, missing, duplicate or non-`Hostname` `host`, port suffix ignored), `yaranapp://home` and `yaranapp://settings` (extra parameters ignored), scheme case, unknown command (`uri_invalid`) | web builders (13, `reauthUrl`), machine-view decisions (15) |

`scripts/gen-vectors.mjs` regenerates every derived value from the fixed inputs with Node
WebCrypto and jose; `--check` must reproduce the committed files byte for byte (no randomness:
every key, IV, salt and nonce in a vector is fixed).

### 13. yaran machine-side signals (refusal header, close codes, routes)

These cross the boundary between yaran (Phase 11) and the web UI it serves (Phase 13) and the
app's machine-view (Phase 15). yaran's existing `/api/v1/*` refusals stay plain text; the
contract is the header, never the body.

**`Yaran-Refusal` response header** on every refusal yaran itself makes for a cloud-hostname
request (`registry/refusals.json`, `{code, status, meaning}`; kebab-case, never reused). A 401
or 403 **without** this header came from Access, not yaran.

| Code | Status | Meaning |
|---|---|---|
| `access-missing` | 401 | no `Cf-Access-Jwt-Assertion` |
| `access-malformed` | 401 | not a 3-segment JWT, bad base64url or JSON, or over 8 KiB |
| `access-bad-algorithm` | 401 | `alg` is not exactly `RS256`, or no `kid` |
| `access-unknown-kid` | 401 | `kid` absent from the JWKS after one refetch |
| `access-bad-signature` | 401 | signature does not verify |
| `access-wrong-issuer` | 401 | `iss` ≠ the team domain |
| `access-wrong-audience` | 401 | `aud` lacks the machine app's AUD |
| `access-expired` | 401 | `exp` past (with skew) |
| `access-not-yet-valid` | 401 | `nbf` in the future (with skew) |
| `access-not-app-token` | 401 | `type` ≠ `app` |
| `access-service-token` | 401 | service-token JWT (no email, empty `sub`, or `common_name`) |
| `access-not-owner` | 403 | email ≠ `owner_email` |
| `access-keys-unavailable` | 503 | JWKS unreachable and nothing cached; signing in will not help |
| `host-not-served` | 403 | Host not bound (cloudflared outlived its binding) |
| `host-missing` | 403 | no Host header |

D24's device-key failures on Y1 are §4 codes (`handoff_device_key_invalid`,
`handoff_signature_malformed`, `handoff_timestamp_skewed`), never refusals: `/__yaran/handoff`
already answers in the §4 envelope or by redirect.

Clients act on prefixes: `access-keys-unavailable` is a server problem; any other `access-*`
means sign in again; `host-*` means the machine is no longer connected to the cloud. An unknown
code falls back to the status (Phase 13).

Rust (11) and web (13) tests read `registry/refusals.json` directly and assert their code
lists equal it.

**WebSocket close codes** (`registry/close-codes.json`):

| Code | Reason text | Sent by · when |
|---|---|---|
| `4001` | (existing) | yaran · provider gone; unchanged, listed so cloud codes never collide |
| `4401` | `access session expired` | yaran · on PTY and events sockets of a cloud-hostname connection at the Access JWT's `exp + skew`, when `[cloud] close_sockets_at_access_expiry` is on (default true); clients reconnect like any retry and note the expiry (13), machine-view renews first (15) |

Rust exposes `SESSION_EXPIRED_CLOSE_CODE: u16 = 4401` from `yaran_core::cloud::protocol`;
the web UI's `ACCESS_SESSION_EXPIRED_CLOSE` mirrors it with a test (Phase 13).

**Routes on the machine hostname**: Y1/Y1b (`/__yaran/handoff`, §8) and Y2
(`GET /__yaran/signed-in`, a script-free "this browser is signed in, you can close this tab"
page that Phase 13 opens in a new tab so Access's login lands somewhere harmless). Both answer
404 off the cloud hostname.

## Work items

All new code files are planned ≤ 500 lines and carry the `00-CONVENTIONS.md` §2 header with
the generated block (Phase 01's tool; if Phase 01 has not landed, write the block by hand and
let `--check` confirm it later). Schema and fixture JSON are data, not code, but each schema
file stays ≤ 500 lines by area split.

1. **Package scaffold.** Create `cloud/protocol/package.json` (private `@yaran/protocol`,
   `engines.node >=22.12`, scripts `gen`, `gen:check`, `test`, `typecheck`, `lint:openapi`),
   `package-lock.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`),
   `vitest.config.ts`, `redocly.yaml` (`recommended-strict`). Pinned deps: `jose@6.2.17`,
   `@cfworker/json-schema@4.1.6`; dev: `typescript@6.0.3`, `vitest@4.1.8` (matches
   `crates/yaran-web/web/package.json`), `json-schema-to-typescript@16.0.0`,
   `@redocly/cli@2.78.0`. Consumers depend on it with `"@yaran/protocol": "file:../protocol"`
   (mobile: `file:../../cloud/protocol`). Reuse: npm lockfile v3 convention
   (research/R3-repo-process.md:12).
2. **Schemas and OpenAPI.** Create the twelve `schemas/*.schema.json` files (the eleven areas
   plus `release-manifest`) and the three `openapi/*.openapi.yaml` documents exactly as §5–§6,
   plus `registry/errors.json`, `registry/capabilities.json`, `registry/audit-actions.json`,
   `registry/refusals.json` and `registry/close-codes.json` (§13). Tests: `test/schemas.test.ts`
   (every schema compiles under `@cfworker/json-schema` draft 2020-12; every fixture behaves as
   its directory says; every schema has fixtures; `Meta` with `setup: closed` and no `org` is
   invalid); `test/registry.test.ts` (codes unique, snake_case, status in range or `null` for
   callback-only codes such as `handoff_declined`, every code named in an OpenAPI response
   exists in the registry, every registry code is referenced somewhere or marked local or
   reserved; refusal codes unique, kebab-case, `access-`/`host-` prefixed; audit actions match
   `^[a-z]+\.[a-z_]+$`); `npm run lint:openapi`.
3. **Codegen.** Create `scripts/gen-types.mjs` (writes `src/generated/types.ts` with an
   `@generated` first line so Phase 01's line gate exempts it; `--check` diffs). Test: CI runs
   `gen:check`.
4. **Core helpers.** Create `src/b64url.ts`, `src/version.ts` (negotiate, deprecation check),
   `src/errors.ts` (typed codes from the registry, envelope builder and parser, status-class
   fallback), `src/validate.ts` (one cached validator per schema), `src/index.ts`. Tests:
   `test/version.test.ts` (reads `fixtures/version/negotiate.json`), `test/errors.test.ts`.
5. **Envelope.** Create `src/jwe/ec.ts` (raw point ↔ JWK, explicit on-curve check, RFC 7638
   thumbprint), `src/jwe/kdf.ts` (Concat KDF), `src/jwe/handoff.ts` (`sealHandoff`,
   `openHandoff` implementing §8 obligations in order, returning registry codes). Tests:
   `test/jwe.test.ts` over every `fixtures/jwe/*` file, plus a property test that seal→open
   round-trips for random keys.
6. **Signatures.** Create `src/sig/canonical.ts` (canonical string, path rule),
   `src/sig/verify.ts` (WebCrypto `{name:"Ed25519"}` raw import; header parsing; the §7 order
   minus storage, which takes a nonce-store interface the Worker implements in 04),
   `src/sig/sign.ts` (for the Worker's tests and a mock machine), `src/sig/fingerprint.ts`
   (§7.1). Tests: `test/sig.test.ts` over `fixtures/sig/*`, `test/fingerprint.test.ts` over
   `fixtures/sig/fingerprint.json`. Note UNVERIFIED-1 below.
7. **Push.** Create `src/push/payload.ts` (event → payload, truncation, size cap, parse),
   `src/push/topic.ts`, `src/push/apns.ts` (relay APNs JSON build/parse). Tests:
   `test/push.test.ts` over `fixtures/push/payload-*` and `fixtures/push/relay-wrapping.json`
   (alert, background and FCM forms). (RFC 8291 encryption and VAPID are Phase 08 code in
   `src/webpush/`; this phase ships their vectors under `fixtures/webpush/`.)
8. **URI, redirect and UA.** Create `src/uri.ts`, `src/redirect.ts` (`redirectAllowed(redirect,
   build, configured)`, §8 allowlist) and `src/ua.ts`. Tests: `test/uri.test.ts`,
   `test/redirect.test.ts` over `fixtures/uri/handoff-redirect.json` (release + configured
   https accepted; release + custom scheme refused; dev + custom scheme accepted; dev + https
   refused; trailing slash, case change, extra query, userinfo and `http:` all refused),
   `test/ua.test.ts`.
9. **Vectors.** Create `scripts/gen-vectors.mjs` and every fixture in §12. Test: CI runs
   `node scripts/gen-vectors.mjs --check`.
10. **Rust module.** Create `crates/yaran-core/src/cloud/mod.rs` (`pub mod protocol;` only;
    Phase 09 adds siblings) and `crates/yaran-core/src/cloud/protocol/`:
    `mod.rs` (`PROTOCOL_MIN`, `PROTOCOL_MAX`, `negotiate`, re-exports), `meta.rs`,
    `machine.rs` (claim, config, events, rotate, teardown types with `validate()`),
    `errors.rs` (exhaustive `ErrorCode` with `#[serde(other)] Unknown` for decoding,
    `ErrorEnvelope`, `is_retryable`), `signing.rs` (canonical string; `sign(&Ed25519KeyPair,
    …) -> SignedHeaders`), `fingerprint.rs` (`machine_key_fingerprint`), `concat_kdf.rs`,
    `handoff.rs` (`parse_recipient_point`, `thumbprint`, `seal` with ring, `seal_with_secret`,
    `HandoffPayload` with optional `cookie`), `ua.rs`, `uri.rs` (`add_org_uri`,
    `DEV_HANDOFF_REDIRECT`, `redirect_allowed`), `signals.rs` (`SESSION_EXPIRED_CLOSE_CODE`,
    the `Yaran-Refusal` header name and code strings Phase 11's `AccessRejection::code()`
    returns), and `test_fixtures.rs` (`#[cfg(test)]` reader resolving
    `CARGO_MANIFEST_DIR/../../cloud/protocol/fixtures`, the prose.rs:339-349 pattern). Touch
    `crates/yaran-core/src/lib.rs` (one `pub mod cloud;` line) and
    `crates/yaran-core/Cargo.toml` (`ring = "0.17.14"`, `base64 = "0.22.1"` under
    `[dependencies]`; `p256 = { version = "0.14", features = ["ecdh"] }`, `aes-gcm = "0.11"`
    under `[dev-dependencies]`). Tests, in each file: round-trip every `fixtures/api/*/valid`
    file for the types this module owns, reject every `invalid` one; signature vectors
    reproduced byte for byte; `seal_with_secret` reproduces the handoff vectors; ring seal →
    p256/aes-gcm open round-trip; KDF Appendix C vector; UA and URI fixtures; a test that the
    `ErrorCode` variant set equals `registry/errors.json` (minus local `jwe_*`/`push_*` codes,
    which Rust never decodes); the fingerprint fixture; the redirect allowlist fixture; the
    refusal code strings equal `registry/refusals.json`. Reuse: `serde`/`serde_json` (`Cargo.toml:30`), `uuid`
    (`Cargo.toml:32`), `chrono` with serde (`Cargo.toml:25`) for `Timestamp`.
11. **CI wiring.** Create `.github/workflows/cloud-protocol.yml` as a reusable workflow
    (`on: workflow_call`) running `npm ci`, `gen:check`, `typecheck`, `test`, `lint:openapi`,
    and `gen-vectors --check` in `cloud/protocol` (Node 22, `cache: npm`, SHA-pinned actions,
    `permissions: contents: read`). Touch Phase 01's `.github/workflows/gates.yml` to call it
    when `cloud/protocol/**` or `crates/yaran-core/src/cloud/**` change (the Rust tests already
    run in `pr.yml`'s `Test` jobs, which are unfiltered). Touch `.github/dependabot.yml` (npm
    entry for `/cloud/protocol`) and `.github/CODEOWNERS` (`cloud/protocol/` with the
    supply-chain block). Touch `deny.toml` only if `cargo deny check` flags the new dev
    dependencies (it should not; all are MIT/Apache-2.0).
12. **Remembered consent (D24).** Create `src/sig/device.ts` (`handoffDeviceCanonical`,
    `verifyHandoffDeviceSig` via WebCrypto `{name:"ECDSA", hash:"SHA-256"}`,
    `deviceKeyFingerprint`, form checks returning the three §8.1 codes) and `src/consent.ts`
    (`buildConsentCookie`, `parseConsentCookie`, `consentMac` via WebCrypto HMAC,
    `decideRemembered(input) -> "skip" | "consent_page"`). Rust: create
    `crates/yaran-core/src/cloud/protocol/handoff_consent.rs` with the same functions over
    ring (`ECDSA_P256_SHA256_FIXED`, `hmac::HMAC_SHA256`, constant-time compare) and
    `device_key_fingerprint(&[u8; 65])`; no new crate. Add the three codes to
    `registry/errors.json`. Tests: `test/device.test.ts` and `test/consent.test.ts` over
    `fixtures/sig/device-fingerprint.json`, `fixtures/sig/handoff-device-signature.json`,
    `fixtures/handoff/*.json`; the same fixtures in `handoff_consent.rs`.

## Acceptance

- [ ] Every endpoint in §5 appears in an OpenAPI document with request, response and error
      schemas, and `redocly lint` passes `recommended-strict`.
- [ ] Every schema in §6 has valid and invalid fixtures; `test/schemas.test.ts` passes.
- [ ] `src/generated/types.ts` is reproducible (`gen:check` clean) and starts with `@generated`.
- [ ] The RFC 7518 Appendix C KDF vector passes in TS and Rust.
- [ ] Handoff vectors: TS seals deterministically to the committed compact JWE; Rust
      `seal_with_secret` reproduces it; TS opens it; every invalid vector fails with its
      named code; Rust ring seal round-trips through the p256 opener.
- [ ] Signature vectors: Rust produces the committed signatures byte for byte; TS verifies
      them; every negative fails with its named code.
- [ ] Push payload fixtures, including truncation at multi-byte boundaries and the 320-byte
      cap, pass in TS.
- [ ] `ErrorCode` (Rust) and `registry/errors.json` agree, enforced by a test.
- [ ] The machine key fingerprint fixture passes in TS and Rust, and the confirm page (06) and
      CLI (09) consume the same function.
- [ ] The redirect allowlist fixture passes in TS and Rust: release builds accept only the
      configured https callback, the custom scheme only with `build=dev`.
- [ ] Every code in every other phase's text appears in `registry/errors.json`,
      `registry/refusals.json` or `registry/close-codes.json` (a grep of
      `docs/plans/phoneapp/*.md` against the registries, run once before Wave B merges).
- [ ] D24: the device-signature fixture verifies in TS and Rust, every negative yields its
      named code or `verified: false`, and Kotlin and Swift reproduce the canonical bytes and
      round-trip a signature through the TS verifier's raw `r ‖ s` form (Phase 15 runs them).
- [ ] D24: the consent-cookie fixture (MAC, value, `Set-Cookie` attributes, Worker HKDF purpose)
      reproduces byte for byte in TS and Rust, and every negative is ignored rather than raised.
- [ ] D24: TS `decideRemembered` and Rust agree on every row of
      `fixtures/handoff/remembered-consent.json`; no row skips without a verifying signature,
      and no row sets the cookie without `decision=continue` and `verified: true`.
- [ ] D24: `HandoffQuery` requires `dk`, `dts`, `dsig`; `HandoffConsent` requires `dk`;
      `DeviceRegistration` requires `device_key`; `Device` carries `device_key_fingerprint`;
      each has valid and invalid fixtures.
- [ ] `yaran-core` gains exactly two direct dependencies (`ring`, `base64`) and `Cargo.lock`
      gains no new non-dev crate (`git diff Cargo.lock` shows only dev additions).
- [ ] `cargo fmt`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`,
      `cargo deny check` pass.
- [ ] `module-headers --check` passes for every new code file (once Phase 01 has landed).

## Validation

```bash
cd cloud/protocol
npm ci
npm run gen:check
npm run typecheck
npm test
npm run lint:openapi
node scripts/gen-vectors.mjs --check
cd ../..
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p yaran-core cloud::protocol
cargo deny check
git diff --stat Cargo.lock      # only dev-dependency crates (p256, aes-gcm and their deps) added
node tools/module-headers/bin/module-headers.mjs --check
```

## Risks

| Risk | Mitigation |
|---|---|
| UNVERIFIED-1: Workers' raw import of a 32-byte Ed25519 public key under `{name:"Ed25519"}` | `test/sig.test.ts` runs under `@cloudflare/vitest-pool-workers` in Phase 04's suite as well as Node; fallback is importing as JWK (`{kty:"OKP",crv:"Ed25519",x}`), which the spec requires. No protocol change either way. |
| UNVERIFIED-2: G1 (Access accepting an injected token) and G3 (which header/cookie Access honours) | §2 sends both cookie and header, and the Worker trusts only Access's assertion header, so the wire contract does not change with either gate outcome. A G1 failure changes how machine-view authenticates (Phase 15 fallback ladder), not this protocol. |
| UNVERIFIED-3: on-curve validation in CryptoKit and JCA | The opener obligation is an explicit check, with an off-curve negative vector both platforms must reject. |
| UNVERIFIED-4: `crypto.subtle` availability in the iOS Capacitor WebView (`capacitor://` secure context) | Openers run natively (Phase 15); the TS opener is for tests and the Android shell. Phase 03's G6 records `isSecureContext`. |
| jose's test-only `epk`/IV setters are deprecated | Used only in `gen-vectors.mjs` and tests; if removed in a future major, `src/jwe/kdf.ts` plus WebCrypto already reproduce the vector path and become the generator. |
| Custom scheme hijack (`yaranapp`) | Release builds never use it (verified https callback, §8 allowlist); dev builds declare `build=dev` and warn. Hijacker gets ciphertext only; the session-fixation residual is in §8 and goes to Phase 17's threat model (T36). |
| The consent interstitial turns every renewal into a tap (machine-view used to renew silently) | **Resolved by D24** (§8.1): consent is remembered per (host, device key) in a MACed, host-only, HttpOnly cookie set only by an explicit Continue, and a renewal skips the page only when it also proves possession of that hardware-held key, so the silent path R2 closed stays closed for any other app or flow. The first handoff per host, any failed check, and once per 400 days still show the page; on iOS the system's own sign-in sheet still appears on every session. |
| UNVERIFIED-5: the consent cookie may not persist between system-browser sessions (iOS `ASWebAuthenticationSession` shares Safari cookies only with `prefersEphemeralWebBrowserSession = false`; Android Auth Tab / Custom Tab cookie-jar behaviour) | Phase 15 never uses the ephemeral session; Phase 19's end-to-end run records whether a second handoff skips. If it does not, every handoff shows the page (the pre-D24 behaviour); no protocol change. |
| Hardware key storage unavailable (simulators, devices without Secure Enclave or a TEE) | The app falls back to a non-exportable software key in Keychain / Keystore and says so in its diagnostics (15); the wire contract is the same, and the consent page still guards the first handoff. |
| yaran cannot see a Worker device revocation, so a revoked phone keeps its remembered consent on machines | A Y1 skip still needs a verified owner Access JWT, which `sign_out_everywhere` revokes (06); without D24 the same phone's holder could tap Continue anyway, so the skip adds no reach. Re-pairing mints a new yaran consent key. Recorded for Phase 17's threat model. |
| Publisher domain lost or association files wrong, so no app receives the https callback | Phase 21 hosts and monitors `assetlinks.json` / AASA (T63); the configured list is a list, so a replacement domain can be added to Worker and yaran config without a protocol change. |
| An https callback URL with a trailing slash, different case or extra query slips past a lenient matcher | The allowlist is an exact byte compare with a fixture of near-miss negatives (work item 8). |
| Push payload reveals project and agent names to the org Worker and Cloudflare | `push.detail = minimal` (org setting, machine config) omits `p`/`l`; D17 disclosure in docs (17). |
| Protocol drift between Rust and TS | Shared fixtures, the registry equality test, and the rule that contract changes edit schema, fixtures and this document in one PR. |
| Clock skew makes every signed call fail | `signature_expired` carries `server_time`; Phase 10 surfaces "clock off by N s" as a keyed status. |

## References

- `00-README.md` D3, D5, D6, D7, D8, D11, D12, D15, D16, D17, D19, D22, D24; flows 2–6
- research/cloudflare-parts/03-jwt-native.md:34-79, :194-205; research/cloudflare-parts/02-access.md:47, :69-72, :128; research/R5-mobile.md:176-187, :198-222, :258-272; research/R1-server-core-cli.md:396-406, :599-605; research/R2-web-frontend.md:116-121, :233
- `crates/yaran-core/src/prose.rs:339-349`; `crates/yaran-web/web/src/lib/prose.test.tsx:74-80`; `crates/yaran-core/src/ids.rs:12-13, :224-225`; `crates/yaran-web/src/rest_common.rs:44, :257`; `crates/yaran-web/web/src/store.ts:2109, :2172, :2193-2198`; `crates/yaran-core/src/engine/mod.rs:610, :1302`; `crates/yaran-core/src/row_state.rs:18`; `crates/yaran-core/src/tab_verdict.rs:35, :54`; `crates/yaran-web/src/build_routes.rs:34-47`; `crates/yaran-web/src/server.rs:776-814`; `crates/yaran-core/src/device_label.rs:27, :109`; `crates/yaran-web/web/src/lib/deviceLabel.ts:43`; `crates/yaran-core/src/wire.rs:55, :913-969`; `crates/yaran-core/Cargo.toml:49`; `Cargo.toml:25, :30, :32`; `deny.toml:70-96`
- RFC 7516, RFC 7518 §4.6 and Appendix C, RFC 7638 — https://www.rfc-editor.org/rfc/rfc7518.html (read 2026-11-14)
- RFC 8030, RFC 8188, RFC 8291 (Appendix A), RFC 8292 — https://www.rfc-editor.org/rfc/rfc8291.html (2026-11-14)
- RFC 8032 (Ed25519), RFC 7636 (PKCE), RFC 8252 §7.1 and §7.2, RFC 3986 §3.1, RFC 4648 §6 (base32)
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (modified 2026-09-30); https://developers.cloudflare.com/workers/runtime-apis/web-standards/ (2026-11-14); https://developers.cloudflare.com/workers/platform/limits/ (2026-11-14)
- https://www.npmjs.com/package/jose (6.2.17, 2026-11-09); https://github.com/cfworker/cfworker (json-schema 4.1.6, 2026-11-04); https://github.com/bcherny/json-schema-to-typescript (16.0.0, 2026-08-28); https://redocly.com/docs/cli/commands/lint (2.78.0, 2026-11-12); https://github.com/oxidecomputer/typify (0.8.0)
- https://docs.rs/ring/0.17.14/ring/ ; https://docs.rs/p256/0.14.0 ; https://docs.rs/aes-gcm/0.11.1
- https://developer.apple.com/documentation/cryptokit/sharedsecret ; https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification ; https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications (2026-11-14)
- https://developer.android.com/reference/android/security/keystore/KeyProperties ; https://developer.android.com/reference/javax/crypto/KeyAgreement (2026-11-14)
- https://unifiedpush.org/developers/spec/android/ (AND_3.1.0); https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type (2026-11-14)
- https://spec.openapis.org/oas/v3.1.0.html

## Reconciliation notes (2026-11-14)

Applied from the plan lead's rulings R1–R21; one line per change.

- R1: envelope stays JWE ECDH-ES (Concat KDF) + A256GCM; Evidence now says HKDF is only RFC 8291's, never the envelope's.
- R2: §8 gains the redirect allowlist (configured https callback `https://<publisher-domain>/auth/callback` for release builds, `yaranapp://auth/callback` only with `build=dev`), `APP_CALLBACK_URLS` / `[cloud] app_callback_urls`, and `HandoffQuery.build`.
- R2: W16/Y1 now render a one-tap consent interstitial; sealing moved to the new form posts W16b/Y1b (`HandoffConsent` with `csrf`, `decision`), answering 303; `HandoffQuery.device` names the device on that page.
- R2: new callback-only code `handoff_declined` for Cancel; audit action `handoff.declined`.
- R2: §10 table splits the release https callback from the dev custom scheme, adds the Managed OAuth callback pair for G1 step 2, and states the three control URLs stay on `yaranapp` because they never leave machine-view; the "why yaranapp" paragraph is rewritten accordingly.
- R2: residual risk (§8) and the custom-scheme Risks row scoped to dev builds; three new risks (consent tap on renewal, publisher domain loss, lenient matching).
- R3: 320-byte push plaintext cap kept unchanged.
- R8: W8 is `POST /v1/machine/unpair` (was `DELETE /v1/machine`); machine paths tightened to `^/v1/machine/[a-z]+$` so one `/v1/machine/*` override covers all of them (06's `/v1/machine/self` idea and 07's second override are unnecessary).
- R9: `origin_port` added to `ClaimRequest` (required, authoritative), `PairAuthorizeQuery` (optional, so 05 can provision at authorize), `ClaimResponse`, `MachineConfig` and `AdminMachine`; new signed `PUT /v1/machine/origin` (W32, `OriginUpdate`/`OriginUpdateResult`); new type `OriginPort`, code `origin_port_invalid`, audit `machine.origin_changed`.
- R9: `ClaimResponse.owner` object replaced by flat `owner_email` + `user_slug`, the names 06, 09 and 11 already use.
- R9: `installation_id` renamed `install_id` (type `InstallId`, minted per org registration) and header `Yaran-Installation-Id` renamed `Yaran-Install-Id`, now sent on every native Worker call; new code `device_revoked`.
- R9: new §7.1 machine key fingerprint (SHA-256 with a domain tag, first 120 bits, base32, six groups of four) with type `MachineKeyFingerprint`, fixture, TS and Rust functions, and `AdminMachine.key_fingerprint`; 06 and 09 asked for a format and had none.
- R9: events body confirmed batched; batch maximum lowered from 20 to 16 (08 and 12 both use 16).
- R9: `Event.state` and push `s` documented as tokens, with the raise/clear mapping; `ExitEvent.exit_status` added for 12's exit status; `project` documented as covering standalone folders.
- R9: `vapid_public_key` stays in `Meta.push` and is added to `Device.push` so the app can detect a key rotation.
- R9: `Device.push_state` (`active | gone | auth_failed | failing | none`, open enum) and per-org (`mute_all`, new `muted_until`) and per-machine (`muted_machine_ids`) mutes; new `PATCH /v1/me/devices/{id}` (W31, `DevicePatch`) is the mute API 08 asked for.
- R9: `HandoffPayload` named, gains optional `cookie` (G1 fallback rung 1), and is pinned to `jwt`, not 11's `assertion`; 06's extra `aud`/`state` plaintext fields rejected.
- R9: new §13 with the `Yaran-Refusal` header and its 15 codes (`registry/refusals.json`), close code 4401 (`registry/close-codes.json`, `SESSION_EXPIRED_CLOSE_CODE`) and the `GET /__yaran/signed-in` route (Y2).
- R9: cleared events now `Urgency: very-low` and relayed to APNs as background pushes; `agent_exited_badly` raised to `high`; all event TTLs follow the new `push.ttl_seconds` setting (08's design).
- R9: 04's codes added (`user_disabled`, `identity_unavailable`, `misdirected_host`, `machine_not_ready`) and its three signature codes mapped to the existing names.
- R9: 05's codes added (`hostname_conflict`, `provisioning_in_progress`, `cloudflare_rate_limited`, `cloudflare_unavailable`, `cloudflare_permission_denied`, `tunnel_delete_blocked`); its `quota_exceeded` maps to `account_quota_reached`.
- R9: 07's setup outcomes added (`setup_code_invalid`, `setup_locked`, `setup_claim_invalid`); 08's added (`push_relay_disallowed`, `relay_vapid_invalid`, `relay_upstream_failed`); 11's `invalid_pk` maps to `handoff_request_invalid`; `handoff_jwt_missing`/`handoff_owner_mismatch` marked reserved (superseded by refusal codes).
- R9: `service_token_rejected` scoped to the Worker; yaran uses `access-service-token`.
- R11: §9 "Delivery outcomes" table: 404/410 clears the subscription, marks the device `gone`, keeps the row; the relay's `push_endpoint_gone` text no longer says the org deletes the device.
- D19: `Meta` is served before setup with a new `setup: open|closed` field (07's update job reads it); `org`, `access`, `capabilities`, `push` required only once closed.
- 07: `Settings` reshaped to 07's admin settings (`org_name`, `pairing_policy.access_group_ids`, `push.{ttl_seconds, relay_allowed, allowed_relays}`, `stale_machine_policy`, `audit_retention_days`, `deployer_repo_url`) plus 05's `quota_limits` and `orphan_cleanup`; `stale_machine_days` and `idp_groups` replaced.
- 07: `ReleaseManifest` schema added (07 said it lives in this package); `UpdateStatus` gains `security`, `error`, and `release_url` becomes `notes_url`.
- 07: `AdminUserPatch.revoke_all` for disable-and-revoke.
- 06: `Me.session_exp`, `MachineSummary.status` gains `never_connected`, `reported_protocol` added; `DELETE /v1/me/devices/{id}?sign_out_everywhere=1` documented.
- 08: relay mint is a `kind: apns|fcm` union (G5 fallback channel `fcm_relay`), stateless `w/v1.<kid>.<opaque>` endpoints, `RelayMeta.channels`/`endpoint_key_id`; the APNs body puts `v`, `r`, `y` at top level (matching the FCM data message); relay body cap 2,900 bytes.
- 08: Web Push codec lives in this package as `src/webpush/` with vectors under `fixtures/webpush/` (the RFC 8291 vector moved there from `fixtures/push/`).
- 04: `request_id` / `Yaran-Request-Id` are a `RequestId` (CF-Ray when present), no longer a UUID.
- Audit actions extended with 05's and 06's events in dotted form; `push.endpoint_removed` replaced by `device.push_gone`.
- Fixtures: `sig/fingerprint.json`, `push/relay-wrapping.json`, `uri/add-org.json`, `uri/handoff-redirect.json`, `access-jwt/` (11) listed; work items, acceptance and Rust module list extended to match.

### Straggler pass (2026-11-14)

- W3 form is now the `PairConsent` schema with optional `replace_machine_id` (the name 06 already used) for the Replace / Pair-as choice; misuse is `pair_request_invalid`.
- H5 (19): no reconciliation-interval field added to `Settings`; the note under `Settings` records that 19 forces a reconcile with W28 and the cadence stays Worker-internal.
- `EventBatchResult`: defined the org-push-off answer (202, ids still deduped and listed in `accepted`, nothing queued, `push_enabled: false`, never 409 on W6) and that no per-machine push switch exists (matches 08 and 12).
- §8: the consent page's platform comes from the system browser's UA plus the `device` field, never the §11 app token (11's finding).
- §8: consent pages (and the W2 confirm page) must send `Referrer-Policy: same-origin` and a CSP `form-action` listing the redirect target's origin, plus `frame-ancestors 'none'`; WebKit behaviour UNVERIFIED, owner 19 (11's finding; 07's default CSP and referrer policy would otherwise break the POST and its redirect).
- §7.1 and §12: the web fingerprint surface is 09's "Yaran Cloud…" dialog, not 13 (13 Out of scope assigns it to 09).
- §12: added `fixtures/uri/control-urls.json` (13 builders, 15 decisions) and `fixtures/jwe/kdf-rfc7520-5.5.json` (11's KDF case moves here).
- `MachineSummary.connections` removed: Cloudflare dropped the field from the tunnel list (05 Evidence), the connections endpoint costs a call per machine, and no phase reads it.
- §9: grouping made explicit: collapse per tab (Topic), grouping per machine (`<orgId>/<machineId>`, the NSE sets `threadIdentifier` after decrypting); the relay's Topic `thread-id` is only the failed-decrypt fallback. 16's iOS "thread-id kept, not overridden" line needs to follow (not in this pass's files).
- D24: new §8.1: per-org-registration hardware P-256 device key; `HandoffQuery` gains required `dk`, `dts`, `dsig` (ES256 raw `r ‖ s` over `yaran-handoff-device-v1\n<host>\n<pk>\n<state>\n<dts>\n`, ±300 s); `HandoffConsent` gains `dk`, with the csrf bound to it and to the GET's signature verdict.
- D24: types `DeviceKeyFingerprint` (§7.1 construction, tag `yaran-device-key-v1\n`) and `EcdsaP256Sig`; `DeviceRegistration.device_key` and `Device.device_key_fingerprint` so the Worker can refuse remembered consent for a revoked device.
- D24: consent cookie `__Secure-yaran-handoff-consent` (host-only, HttpOnly, Secure, Lax, Path = the handoff path, Max-Age 400 days), value `v1.<kv>.<fp24>.<iat>.<mac>`, HMAC-SHA256; Worker key from `DATA_KEY` with HKDF purpose `handoff_consent`, yaran key `handoff_consent_key` + `handoff_consent_key_version` in 09's credentials; skip rule with five conditions, set only on an explicit Continue with a verified signature; applies to `build=dev`.
- D24: codes `handoff_device_key_invalid`, `handoff_signature_malformed`, `handoff_timestamp_skewed`; a well-formed but non-verifying signature gets the consent page, not an error; no new `Yaran-Refusal` codes (§13 note).
- D24: fixtures `sig/device-fingerprint.json`, `sig/handoff-device-signature.json`, `handoff/consent-cookie.json`, `handoff/remembered-consent.json`; work item 12, four acceptance items.
- D24: the consent-tap Risks row is resolved; new rows UNVERIFIED-5 (cookie persistence in the system browser), hardware key unavailable, and yaran not seeing Worker device revocation.

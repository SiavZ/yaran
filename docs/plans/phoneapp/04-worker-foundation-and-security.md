# Phase 04 — Org Worker: foundation, Access JWT, signed machine API, D1, audit

**Track:** Wave B (org control plane) · **Parallel-safe with:** 05, 06, 07, 08, 09–18 (05–07 build on this phase's seams; until it lands they code against the interfaces fixed below)
**Depends on:** 02 (wire contract: error envelope and code registry, machine-signature canonical string, JSON Schemas, `@yaran/protocol` package), 01 (module-header gate, 500-line gate), 03 (G8 path probes, G11 deploy and migrations, G14 workers.dev handling; primary and fallback both specified here) · **Blocks:** 05, 06, 07, 08 (code level), 19

## Goal

Create `cloud/worker/`, the org control-plane Worker that every later Worker phase
extends. It must give them, ready to use and tested:

- one way to route a request, and every route declaring who may call it;
- the Access JWT check (D3 applied to the Worker itself);
- the Ed25519 signed machine API with replay protection (D6);
- the D1 schema with its migrations;
- encryption at rest for any secret the Worker generates;
- rate limiting, structured logging that never leaks a secret, and the audit log;
- the one cron dispatcher that 05, 07 and 08 plug tasks into.

The Worker fails closed. A request it cannot attribute to an identity reaches nothing
except `/v1/meta` and the setup routes (and the setup routes only while setup is open).

## Evidence

Repository (verified 2026-11-14 against `main` at `ba9e61b9`):

- No `cloud/` and no `tools/module-headers/` exist yet. `tools/` holds only
  `preview-env/` and `reload-live-check*.sh`.
- Every package in the repo uses npm with `package-lock.json` lockfileVersion 3:
  - `crates/yaran-web/web/package-lock.json:4`
  - `website/package-lock.json:4`
- Toolchain precedents in `crates/yaran-web/web/package.json`:
  - TypeScript `~6.0.2` (:58), Vitest `^4.1.8` (:61), ESLint `^10.3.0` (:53),
    typescript-eslint `^8.59.2` (:59).
  - `"type": "module"` (:5). ESLint uses the flat `eslint.config.js`.
- Node version:
  - `CONTRIBUTING.md:12` says "Node 22.12 or newer".
  - No `.nvmrc` or `.node-version` exists anywhere.
  - CI mixes Node 22 (`pr.yml:104-106`) and Node 24 (`website-ci.yml:56-58`).
- The root `.gitignore:10` ignores `node_modules/`. Nothing ignores `.dev.vars` or
  `.wrangler`.
- Cross-language fixture precedent: `crates/yaran-core/tests/fixtures/prose_cross_language.json`.
  - Rust reads it at `crates/yaran-core/src/prose.rs:339-343`.
  - TypeScript reads it at `crates/yaran-web/web/src/lib/prose.test.tsx:75-82`.
- `yaran_core::sanitize::for_terminal` (`crates/yaran-core/src/sanitize.rs:21-33`) keeps
  `\n` and `\t` and turns every other control character (C0, DEL, C1, CSI `\x9b`) into
  `\xNN`. The Worker's sanitizer mirrors this exactly, so a log line reads the same on
  both sides.
- Threat model: the highest ID is T24 (`docs/operations/threat-model.md:1076`). The
  STRIDE table header is at `SECURITY.md:50`.

Cloudflare platform (all fetched 2026-11-14; dates are each page's "last updated"):

- **Test harness.** `@cloudflare/vitest-pool-workers` is deprecated. It was renamed
  `@cloudflare/vitest-plugin`, now at 1.8.2, with peer dependency `vitest ^4.1 || ^5`.
  - Configuration uses the `cloudflareTest()` plugin in `vitest/config`.
  - D1 migrations: `readD1Migrations` plus `applyD1Migrations`.
  - Storage is isolated per test file.
  - `fetchMock` was removed; outbound calls are mocked with `msw@^3` plus `@msw/cloudflare`.
  - Scheduled handlers are tested with `createScheduledController`.
  - Sources: https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ (2026-08-19);
    …/workers/testing/vitest-integration/configuration/ (2026-11-13);
    …/mock-outbound-requests/ (2026-10-08); …/test-apis/ (2026-11-12);
    …/isolation-and-concurrency/ (2026-11-12).
- **Wrangler 4.162.0.** Confirmed key names: `workers_dev`, `preview_urls`,
  `routes[].custom_domain`, `d1_databases[].migrations_dir`, `triggers.crons`,
  `observability`, `limits`, `ratelimits` (needs ≥ 4.36.0).
  - Sources: https://developers.cloudflare.com/workers/wrangler/configuration/ (2026-11-12);
    …/runtime-apis/bindings/rate-limit/ (2026-11-12).
  - With a compatibility date of 2026-08-04 or later, `nodejs_compat` is on by default.
    `global_fetch_strictly_public` exists (…/configuration/compatibility-flags/, 2026-09-18).
  - Disabling workers.dev does not disable preview URLs, so both must be set explicitly
    (R4 Part 5 §1.4–1.5).
- **D1.**
  - `batch()` runs as one SQL transaction and counts as one query against the
    per-invocation cap (50 on Free, 1,000 on Paid).
  - Per-query limits: 100 bound parameters, 100 KB statement length.
  - Foreign keys are enforced by default.
  - Read replication is opt-in; without the Sessions API every query hits the primary.
  - Sources: …/d1/worker-api/d1-database/ (2026-06-22); …/d1/platform/limits/ (2026-10-30);
    …/d1/sql-api/foreign-keys/ (2026-11-10); …/d1/best-practices/read-replication/ (2026-08-10).
- **WebCrypto** supports Ed25519 (sign, verify, import), ECDH, HKDF, AES-GCM and HMAC, plus the
  non-standard `crypto.subtle.timingSafeEqual` (…/runtime-apis/web-crypto/, 2026-09-30).
  `URLPattern` is a runtime global, standard-compliant by default since 2025-05-01
  (…/runtime-apis/web-standards/, 2026-04-23).
- **jose 6.2.17** has zero dependencies and lists Workers as a supported runtime.
  `createRemoteJWKSet` defaults: cache 10 min, cooldown 30 s, timeout 5 s
  (https://github.com/panva/jose, docs/jwks/remote/interfaces/RemoteJWKSetOptions.md).
- **Access JWT** (R4 Part 3 §1–4):
  - The JWT arrives in the `Cf-Access-Jwt-Assertion` header; validate the header, not the
    cookie.
  - RS256 only. JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
    matched by `kid`.
  - Required claims: `iss` equals the team domain with `https://`, `aud` contains the
    app's AUD, plus `exp` and `nbf`.
  - A service-token JWT has `sub: ""`, carries `common_name`, and has no `email`.
- **Worker secrets.** A Worker can write its own secrets via
  `PUT /accounts/{id}/workers/scripts/{name}/secrets`. That needs Workers Scripts Write, and
  every write creates and deploys a new Worker version (cloudflare/api-schemas
  `openapi.json`, commit 2026-11-13; …/workers/configuration/secrets/, 2026-10-15).
  This plan rejects that route; see Design §7.
- **Limits** (…/workers/platform/limits/, 2026-11-13):
  - Free plan: 10 ms CPU per request and per cron run (I/O wait excluded), 50 external
    subrequests, 5 cron triggers per account.
  - Paid plan: 30 s CPU.
- **Rate Limiting binding.**
  - Periods are 10 or 60 s. Counts are per location, eventually consistent and permissive.
    `limit({key})` returns `{success}`.
  - Plan availability is not stated anywhere: **UNVERIFIED** (Design §8).
- **Workers Logs** index the fields of logged objects. Retention is 3 days on Free and
  7 days on Paid (…/observability/logs/workers-logs/, 2026-11-12).
- **Deploy button** (…/workers/platform/deploy-buttons/, 2026-10-12; R4 Part 4 §4–5):
  - The app must be fully isolated inside its subdirectory, dependencies included.
  - Secrets are declared in `.dev.vars.example`. No secret is auto-generated; the
    documented pattern is a description telling the user to run `openssl rand -hex 32`.

## In scope

- The `cloud/worker/` package, its toolchain, its configuration, and its dependency on
  `cloud/protocol` as a local workspace package (D18).
- The HTTP core: entry point, router, request context, responses, body limits, host guard
  and security headers.
- Identity:
  - Access JWT verification;
  - user resolution and roles;
  - route auth classes;
  - machine-signature verification and the nonce store.
- The D1 schema (migration `0001_init.sql`) for every table named in the plan guidance,
  plus the D1 helpers and the `settings`, `users`, `machines` and `audit` repositories.
- Secrets validation, encryption at rest with `DATA_KEY`, rate limiting, structured
  logging, and the sanitizer.
- The cron dispatcher and the purge tasks.
- The authorization-matrix test, the secret-leak test, and the threat-model rows for this
  surface.

## Out of scope

- The Cloudflare API client, provisioning, reconciliation and quota guard: **05**.
- Pairing, claim, phone sessions, sealed handoff, `/v1/meta`, device routes, and the
  repositories for `pair_requests` and `devices`: **06**.
- The Deploy button, binding descriptions, setup wizard, admin and user consoles, update
  checker, and the *values* of settings: **07**. This phase defines the settings schema
  and defaults.
- The Web Push sender and the relay: **08**.
- The CI workflow `cloud-ci`, dependabot, CODEOWNERS and the `release-cloud` workflow that
  publishes the generated `cloud-deploy` branch: **18**. The deploy-tree assembler: **07**.
  This phase ships the npm scripts those jobs call.
- Consumer docs and the threat-model consolidation: **17**.

## Design

### 1. Package shape and the Deploy-button isolation rule

The Deploy button clones one subdirectory, and the app must be "fully isolated within that
subdirectory, including any dependencies" (R4 Part 4 §4). Publishing an npm package is
out: D16 and the CLAUDE.md product-identity rule forbid inventing one.

The decision (D18):

- **On `main`, no vendored copy.** `cloud/worker/package.json` depends on
  `"@yaran/protocol": "file:../protocol"`, the local workspace package exactly as 02 work
  item 1 specifies. The Worker imports schemas, codecs, the error and audit registries and
  fixtures from `@yaran/protocol`, and nowhere else. There is no `vendor/` directory, no
  sync script and no drift check on `main`: there is nothing to drift from.
- **The Deploy button targets the generated `cloud-deploy` branch.** For every
  `yaran-cloud-vX.Y.Z` tag, Phase 18's `release-cloud` workflow runs Phase 07's
  `assemble-deploy-tree.ts`, which builds `cloud/protocol` and bundles it into a
  self-contained tree (its own `package.json` pointing at the bundled copy, its own
  lockfile) and pushes that tree to branch `cloud-deploy`. The bundled copy exists only on
  that generated branch, so it is a build artefact, never a second source.
- **What this phase guarantees the assembler.** The one `@yaran/protocol` line in
  `package.json` is the only reference from `cloud/worker/` to anything outside it, so the
  assembler rewrites exactly one dependency and copies the rest verbatim. A test enforces
  this (work item 2).
- Phase 08's relay depends on `@yaran/protocol` the same way.

### 2. Router: first-party, table-driven, built on `URLPattern`

Every route is one row in `http/routes.ts`:

```ts
{ method, path, auth, kind, handler, rateLimit, bodyLimit }
```

- `auth` is the exhaustive union below.
- `kind` is `"json" | "html"` and decides the shape of an error.

Why first-party rather than Hono or itty-router (both have zero dependencies; Hono is
4.13.18, itty-router is 5.0.24):

- The security property this phase needs is "a route cannot exist without an auth class",
  and a typed table makes that a compile error.
- The authorization-matrix test iterates the same table, so a new route is in the matrix
  the moment it is added.
- A framework's middleware chain makes the auth step something a route can forget.
- `URLPattern` is a runtime global, so routing costs about 80 lines and no dependency.

Auth classes:

```ts
type RouteAuth =
  | { kind: "public" }                                  // W1 /v1/meta only (06)
  | { kind: "setup" }                                   // W29 /setup*, served only while setup is open (07)
  | { kind: "machine"; key: "registered" | "pair_request" } // Ed25519 (W4 claim uses pair_request)
  | { kind: "user" }                                    // valid Access JWT, active user
  | { kind: "admin" };                                  // as user, plus role = admin
```

`authorize.ts` is the single `switch` over `kind`, ending in `assertNever`. Order of
evaluation for every request:

1. Host guard (§3).
2. Canonical-path check, then route match. A path that is not already canonical
   (uppercase letters in a `/v1/` path, percent-encoded characters in a `/v1/machine/`
   path, `.` or `..` segments, an encoded `/`, a doubled `/`) is `404` before any route is
   matched, so G8's normalisation probes (`/v1/MACHINE/claim`, `/v1/machine/%2e%2e/me`) can
   never reach a protected route through the public override. An unknown route is `404`
   without touching auth, which leaks nothing, because the public route table is in an
   open-source repo anyway.
3. Rate limit (§8).
4. Protocol (02 §3). Every JSON `/v1/*` route except `/v1/meta` requires a
   `Yaran-Protocol` header inside the supported range, else `400 protocol_unsupported`
   with `details: {min, max}`. HTML navigations that 02 gives a `v` parameter (W2/W3,
   W16/W16b) check `v` the same way; setup and console pages do not negotiate.
5. Body size and content type, plus the CSRF rule of 02 §2: a mutating `/v1/me/*` or
   `/v1/admin/*` request must be `application/json` (a bodyless `DELETE` excepted), and an
   `Origin` header, when present, must equal the control-plane origin, else
   `403 origin_mismatch`. The two HTML form posts (W3, W16b) pass the same `Origin` rule;
   their `csrf` field is checked by 06.
6. Auth class.
7. Handler.

Every response carries `Yaran-Protocol` (the version served) and
`Yaran-Request-Id: <RequestId>` (02 §2), the same value as the envelope's `request_id`.

### 3. Host guard and setup state

`workers.dev` exists only to bootstrap setup (D19, G14 primary). The deploy config leaves
it enabled (§14) and writes no custom domain, so the first run is reached on the Worker's
`*.workers.dev` URL; the wizard (07) then attaches the custom domain by API and disables
the workers.dev subdomain by API. The code does not rely on that API call:

- `settings.setup_state` is either `open` or `closed` (served as `Meta.setup`).
  - **While open:** only `/setup*` (`setup` routes) and `/v1/meta` (`public`) are served,
    on any Host: the workers.dev host during first run, and the custom domain once the
    wizard has attached it and redirected to `https://<cp-host>/setup/continue`. Every
    `user`, `admin` and `machine` route answers `503 setup_incomplete`, so workers.dev
    exposes nothing but the setup wizard (gated by `SETUP_CODE` and the strict limiter)
    and the metadata.
  - **Once closed:** 07 closes setup in the same D1 batch that records the admin
    (`setup.completed`). On the control-plane host, `/setup*` answers `410 setup_closed`
    forever.
- After setup, the Worker serves only the recorded `settings.control_plane_host`. Any
  other `Host`, every `*.workers.dev` host included, gets `421 misdirected_host` with a
  body that names no other host.
  - This holds even if a route, workers.dev or preview URLs come back later: a Workers
    Builds redeploy with `workers_dev: true` re-enables the subdomain (G14 step 7), and the
    code refusal is what keeps it inert.
- Every response carries:
  - `Strict-Transport-Security: max-age=31536000`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store` (JSON; `/v1/meta` alone is `public, max-age=60`, 02 §2)
  - `Cross-Origin-Opener-Policy: same-origin`
  - `X-Frame-Options: DENY`
- HTML responses also get a strict CSP with no remote script sources. 07 renders pages
  through `responses.html()` so it cannot omit any of them; their look comes from
  `packages/ui-kit/` tokens through 07 (R18), never from this phase.

### 4. Access JWT verification (D3 applied to the control plane)

`auth/access-jwt.ts`:

- **Header only.** It reads only `Cf-Access-Jwt-Assertion`, never the cookie. The app's
  native org API client (D22) sends the control-plane token as both
  `Cookie: CF_Authorization=<jwt>` and `cf-access-token: <jwt>` (02 §2); Access validates
  whichever it honours and forwards the header (G1/G3 record which).
- **JWKS cache.** It keeps a module-scope `Map<teamDomain, JWKS>` of `createRemoteJWKSet`
  instances, so the jose cache survives across requests in one isolate.
  - The team domain must match `^[a-z0-9-]+\.(fed\.)?cloudflareaccess\.com$`. This is the
    same rule cloudflared applies, which stops a poisoned setting from pointing the JWKS
    fetch elsewhere.
- **`jwtVerify` options:**
  - `algorithms: ["RS256"]`
  - `issuer: "https://" + team` (exact)
  - `audience: settings.control_plane_aud`
  - `clockTolerance: 60` seconds (configurable setting `jwt_clock_tolerance_s`)
- **Checks after verification:** each failure has its own code.
  - `type === "app"`;
  - `email` is a non-empty string;
  - `sub` is non-empty;
  - no `common_name`. A service-token JWT is rejected with `403 service_token_rejected`.
- **Fail closed when the JWKS is unreachable:** `503 identity_unavailable`, never a pass.
- **No JWT at all** (Access misconfigured or removed): `401 unauthenticated`. The request
  is logged at warn level with the route and the CF-Ray header, because it means the
  control-plane Access app is not in front of a route it should cover.

`auth/identity.ts`:

- Maps the verified email (trimmed, lowercased) to a `users` row.
- **First sight:** if no row exists and setup is closed, it creates `role = user`,
  `status = active`, with a unique slug (05's `naming.ts` supplies the slug function;
  until 05 lands, a local stub with the same signature).
- **Disabled user:** `403 user_disabled`.
- **Last seen:** `last_seen_at` is written at most once per 5 minutes per user, to protect
  the D1 write budget.
- **Role:** comes only from D1. There is no claim-based admin, because Access custom claims
  are trimmed past about 1,000 bytes (R4 Part 3 §3).

### 5. Signed machine API (D6)

`auth/machine-signature.ts` implements the Phase 02 §7 scheme and nothing else.

- **Headers:** `Yaran-Protocol`, `Yaran-Machine-Id` (absent on W4, where the key is
  resolved through the pair code), `Yaran-Timestamp`, `Yaran-Nonce`, `Yaran-Signature`.
- **Canonical string:** 02 §7's nine lines (`yaran-machine-sig-v1`, method, path with no
  query, lowercase Host without port, protocol, machine id or `-`, timestamp, nonce, body
  SHA-256 hex). It is built by `@yaran/protocol`'s `sig/canonical.ts`; the Worker never
  re-implements it. The router has already refused any machine path that does not match
  `^/v1/machine/[a-z]+$` or carries a query.

Check order is 02 §7's, cheap first; nothing that writes runs before the signature
verifies:

1. **Header syntax.** All headers present and well formed: machine id a lowercase `Uuid`
   (or absent on W4 only), timestamp decimal Unix seconds with no leading zeros, nonce
   exactly 16 bytes as base64url (22 chars), signature 64 bytes as base64url (86 chars).
   Else `401 signature_missing`. Protocol out of range: `400 protocol_unsupported`. Body
   over 64 KiB: `413 payload_too_large`.
2. **Clock window.** `|now − ts| ≤ 300` s, else `401 signature_expired` with
   `details.server_time` and a `Date` header, so yaran can say "your clock is off by N s".
3. **Resolve the public key** through a resolver chosen by the route:
   - `registered`: the `machines` row by `Yaran-Machine-Id` (revoked machines keep their
     key); an unknown id is `401 machine_unknown`;
   - `pair_request`: supplied by 06 for W4 (the pair code's recorded `machine_pubkey`); an
     unknown, used or expired code is 06's `400 pair_code_invalid`.
4. **Verify.** Hash the raw body bytes read once, rebuild the canonical string, verify
   Ed25519 (`crypto.subtle.importKey("raw", key, {name: "Ed25519"})`). Failure, including a
   body-hash mismatch, is `401 signature_invalid`.
5. **Machine status**, checked only after a valid signature, so revocation status is never
   disclosed to strangers:
   - `revoking`/`revoked` (wire `tearing_down`/revoked): `410 machine_revoked`. This is how
     yaran learns to stop its leg out loud (README flow 6), and it is why W8 on an
     already-revoked machine answers `410`.
   - `provisioning`/`failed` on a non-claim route: `409 machine_not_ready` (retryable).
6. **Nonce.** `INSERT OR IGNORE INTO machine_nonces` keyed `(machine_id or "claim:"+code,
   nonce)`. Zero rows changed means `401 nonce_replayed`. Rows expire at `ts + 600` s and
   are purged by cron.
   - D1 without read replication runs every query on the single primary, so the uniqueness
     check is strongly consistent. The data layer must never enable the Sessions API for
     this table.
7. `last_seen_at` and `reported_protocol` (the verified `Yaran-Protocol`, shown as
   `MachineSummary.reported_protocol`) are updated at most once per minute.

02 gives an unknown machine id its own code (`machine_unknown`), so an unknown id and a bad
signature share a status (401) but not a body code. Machine ids are random v4 UUIDs, so
naming the case discloses nothing guessable.

### 6. Error envelope

All errors go through `responses.error(code, …)`:

- It uses the Phase 02 envelope and code registry (`registry/errors.json`) from
  `@yaran/protocol`.
- It maps each code to its HTTP status from that registry.
- It attaches `request_id` (02 type `RequestId`): the CF-Ray header when present, else 16
  random bytes as hex. `Yaran-Request-Id` carries the same value.
- It sets `Retry-After` on every `429` and `503`.

**Codes this phase emits, all present in 02's registry (§4):** `bad_request`,
`validation_failed`, `protocol_unsupported`, `unauthenticated`, `service_token_rejected`,
`forbidden`, `user_disabled`, `origin_mismatch`, `misdirected_host`, `not_found`,
`method_not_allowed`, `conflict`, `payload_too_large`, `unsupported_media_type`,
`rate_limited`, `internal`, `unavailable`, `identity_unavailable`, `setup_incomplete`,
`setup_closed`, `signature_missing`, `signature_invalid`, `signature_expired`,
`nonce_replayed`, `machine_unknown`, `machine_revoked`, `machine_not_ready`.

- 02 is the only home of these names; a test asserts every code this phase emits exists in
  the registry with the status this phase sends.
- `kind: "html"` routes render the same code as an accessible error page (07 styles it
  with `packages/ui-kit/` tokens).
- An unexpected exception becomes `500 internal` with a request id. The exception text
  goes only to the log, sanitized.

### 7. Secrets and encryption at rest

The Worker reads the three Deploy-time secrets of D20: `CF_API_TOKEN`, `SETUP_CODE` and
`DATA_KEY`, all prompted for at deploy (07 writes their `.dev.vars.example` descriptions).
`security/secrets.ts` validates each on first use and refuses to serve any route but
`/v1/meta` when one is missing or malformed. The refusal is `503 unavailable` with
`Retry-After`, plus an admin-actionable log line naming the secret, never its value.

| Secret | Purpose | Validation |
|---|---|---|
| `CF_API_TOKEN` | Cloudflare API calls (05) | Non-empty; verified live by 07 via `GET /accounts/{id}/tokens/verify` |
| `SETUP_CODE` | First-run gate (07) | At least 12 characters. Compared in constant time: SHA-256 both sides, then `timingSafeEqual` |
| `DATA_KEY` | Root of encryption at rest | base64 that decodes to at least 32 bytes |

**Why not let the Worker write its own secrets** (for example a VAPID private key)?

- It would need Workers Scripts Write on `CF_API_TOKEN`. A stolen token could then
  rewrite the Worker's code.
- Every write redeploys the Worker.

So secrets the Worker generates live in D1, sealed by `security/data-key.ts`:

- **Key:** `HKDF-SHA256(DATA_KEY, salt = "yaran-cloud", info = "v1/<purpose>")` gives a
  256-bit key per purpose. Purposes are a TS union: `vapid`, `device_endpoint`,
  `device_auth`, `handoff_consent`, `key_check`, plus purposes added by later phases.
  `handoff_consent` is the one MAC key, not a sealing key: the HMAC-SHA256 key of 02 §8.1's
  remembered-consent cookie (D24), exposed as `macKey("handoff_consent") → { kv, key }`
  and used only by 06. `key_check` derives the key-identity check below and nothing else.
  This key derivation is for encryption and MACs at rest only; the sealed handoff envelope
  is 02's JWE ECDH-ES with Concat KDF and A256GCM (D8, R1), never HKDF, and this module is
  not used for it.
- **Cipher:** AES-256-GCM with a random 96-bit IV.
- **AAD:** `"<table>.<column>:<row id>"`, so a ciphertext copied into another row or
  column fails to open.
- **Stored form:** `k<version>.<b64url iv>.<b64url ct>`.
- **Key version.** A secret value cannot carry its own version, so the Worker records one:
  the internal settings row `data_key_state = { version, check, previous_check }`, where
  `version` is a decimal integer ≥ 1 and `check` is the first 16 bytes of the `key_check`
  purpose key, base64url (one-way, so it reveals nothing about `DATA_KEY`). On first use per
  isolate the module computes the check of `DATA_KEY`. No row: write `version = 1` (first
  boot, before setup). Equal to `check`: that row's `version` is current. Different: the key
  was rotated (or replaced after a loss), so one conditional `UPDATE … WHERE version = ? AND
  check = ?` writes `version + 1`, the new `check` and `previous_check = <old check>`; a
  losing isolate re-reads. `DATA_KEY_PREVIOUS` opens `k<version − 1>` only while its check
  equals `previous_check`, and is otherwise ignored with an admin log line naming it. Any
  other version fails to open, loudly, naming the purpose. The current `version` is the
  `kv` of every MAC from `macKey`, and only the current key ever verifies a MAC
  (`DATA_KEY_PREVIOUS` never does), so rotating `DATA_KEY` forgets every remembered handoff
  consent (02 §8.1).
- **Rotation:** an optional `DATA_KEY_PREVIOUS` secret is accepted for opening only. A
  dispatcher task re-seals rows under the current key, then logs "safe to remove
  `DATA_KEY_PREVIOUS`". The procedure is documented by 17 and 22, and says that a rotation
  makes every phone meet the handoff consent page once more.

Tunnel tokens are **never stored**. 05 fetches them from the API at claim and at
rotation time. Pairing codes and states are stored as SHA-256 hashes (06).

Resolved by D20: `DATA_KEY` is the third Deploy-time secret, with the documented
`openssl rand -hex 32` description pattern. The rejected alternatives were deriving the key
from `SETUP_CODE` (a short human-chosen value) and granting Workers Scripts Write on the
API token (a privilege escalation).

### 8. Rate limiting

`security/rate-limit.ts` has two tiers.

**Tier 1: the Rate Limiting binding.** Three `ratelimits` bindings:

| Binding | Key | Limit |
|---|---|---|
| `RL_IP` | client IP (`CF-Connecting-IP`) | 300 per 60 s |
| `RL_AUTH` | IP; covers setup, authorize and handoff routes | 20 per 60 s |
| `RL_MACHINE` | machine id | 120 per 60 s |

Each route row names its bucket.

**Tier 2: strict counters in D1** (`rate_counters`, fixed window). For limits that must
hold globally rather than per location:

- setup-code attempts: 5 per 15 min per IP, and 30 per day overall, after which setup
  locks until the admin redeploys with a new `SETUP_CODE`;
- the per-user pairing attempts 06 declares.

**UNVERIFIED: plan availability of the binding.** No Cloudflare page states it. The
limiter therefore treats a missing binding as "use tier 2 for that bucket" rather than
failing, and the `ratelimits` block is documented as removable. The Phase 19 Free-plan
deploy confirms which path production takes.

Binding `namespace_id`s are configuration values (`"7701"`–`"7703"` by default),
documented in `wrangler.jsonc`, because bindings that share a namespace share counters.

### 9. Logging and sanitizing

- `log/logger.ts` emits one JSON object per line via `console.log`. Workers Logs index
  these fields.
- Fields: `level`, `event`, `request_id`, `route`, `actor_kind`, `actor_id`, plus extra
  fields.
- Every string goes through `security/sanitize.ts`, the TS twin of
  `sanitize.rs:21-33`. It is pinned by a shared fixture in `cloud/protocol/fixtures/` that
  the Rust test also reads.
- A deny-list of keys is replaced with `"[redacted]"` before serialization, and a test
  enforces it: `token`, `jwt`, `cookie`, `authorization`, `signature`, `secret`,
  `private_key`, `endpoint`, `p256dh`, `auth`, `code`, `code_verifier`, `state`.
- Request and response bodies are never logged.

### 10. Audit log

`audit/audit.ts` exposes one call:

```ts
record(ctx, { action, target, outcome, detail })
```

- `action` is a closed TS union generated from 02's
  `cloud/protocol/registry/audit-actions.json` (dotted `<subject>.<verb>`). Phases add
  actions to that registry file and nowhere else; `audit/actions.ts` re-exports the
  generated union and never hand-writes a member.
- `detail` is sanitized JSON capped at 2 KiB.
- **Actor** comes from the request context: `user`, `admin`, `machine`, `system` (cron)
  or `setup`.
- **Wire mapping for W25 (`AuditEntry`, 02 §6).** `actor.kind`: `user` and `admin` →
  `user`, `machine` → `machine`, `system` and `setup` → `system`. `result`: `ok` → `ok`,
  `denied` and `failed` → `error` with `error_code`. `target.kind` is one of 02's
  `org | user | machine | device | settings`. `country` comes from `request.cf.country`.
  The IP stays in D1 for incident response and is not part of `AuditEntry`.
- **Denied attempts** are audited only for `admin` routes, and for revoked-machine calls.
  They are coalesced to one row per (actor, action) per minute, so a hostile client
  cannot spend the D1 write budget (Free: 100k rows written per day).
- **IP:** stored as given, because admins need it for incident response, and kept for
  `audit_retention_days`, default 365, configurable. Disclosed by 17.

### 11. Cron dispatcher

The Free plan allows only 5 cron triggers per *account*, so the Worker declares exactly
**one** expression, `* * * * *`.

- `scheduled/dispatcher.ts` reads `scheduled_tasks` (task, next_run_at, interval, lease)
  and runs due tasks in priority order.
- Each run has a per-run budget: wall time 20 s, D1 queries 40, external subrequests 40.
  This keeps the Free plan's 50-query and 50-subrequest caps safe.
- CPU is the tightest Free limit (10 ms). Each task must be chunked so one run does a
  bounded slice; 05's tasks are designed that way.
- Tasks register in `scheduled/tasks.ts`, a typed registry. This phase registers:
  - `purge_nonces` (every 10 min);
  - `purge_pair_requests` (every 10 min; 06 owns the semantics, the query lives here);
  - `purge_audit` (daily);
  - `purge_rate_counters` (hourly);
  - `reseal_data` (hourly, a no-op unless `DATA_KEY_PREVIOUS` is set).
- 05 registers reconciliation tasks and 08 registers push retries.

### 12. D1 schema (`migrations/0001_init.sql`)

Migration rules:

- `0001` may be edited until the first `yaran-cloud-v*` tag. After that, migrations are
  append-only and immutable, mirroring `docs/contributing/schema-policy.md`.
- Later phases append `000N_*.sql`.

Schema conventions:

- Timestamps are Unix seconds as `INTEGER`; the API boundary renders them as 02's
  `Timestamp` (RFC 3339 UTC).
- Ids are lowercase UUID v4 text from `crypto.randomUUID()`, generated in code.
- Internal names map to 02's wire names at the API boundary, in one mapper per entity:
  `machines.status` `revoking` → `tearing_down` (`MachineSummary.status`, which 06 derives
  together with the Cloudflare health columns), `tunnel_secret_generation` →
  `token_version`.
- The data layer avoids `RETURNING` and `ON CONFLICT DO UPDATE`, because D1's SQLite
  version is undocumented (UNVERIFIED). It uses `INSERT OR IGNORE`, conditional `UPDATE`
  and `meta.changes`, which work on any SQLite version.

```sql
-- Settings: one row per key, value is validated JSON (schema in src/db/settings.ts).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value       TEXT NOT NULL CHECK (json_valid(value)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
  slug          TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 24 AND slug NOT GLOB '*[^a-z0-9-]*'),
  role          TEXT NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  access_sub    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE machines (
  id                        TEXT PRIMARY KEY,
  instance_id               TEXT NOT NULL,          -- settings.instance_id at creation (05 resource markers)
  owner_user_id             TEXT NOT NULL REFERENCES users(id),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),  -- 02 MachineName (full pattern checked in code)
  slug                      TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 32 AND slug NOT GLOB '*[^a-z0-9-]*'),
  hostname                  TEXT UNIQUE,            -- NULL once released after revoke
  public_key                BLOB NOT NULL CHECK (length(public_key) = 32),
  origin_port               INTEGER NOT NULL DEFAULT 3890 CHECK (origin_port BETWEEN 1 AND 65535),  -- desired (02 OriginPort)
  ingress_origin_port       INTEGER CHECK (ingress_origin_port BETWEEN 1 AND 65535),             -- port the live ingress targets (05 P4)
  yaran_version             TEXT CHECK (length(yaran_version) <= 40),                            -- from W4 claim (06)
  reported_protocol         INTEGER,                                                             -- last verified Yaran-Protocol (§5)
  status                    TEXT NOT NULL CHECK (status IN
                              ('provisioning','awaiting_claim','active','revoking','revoked','failed')),
  access_policy_id          TEXT,
  access_app_id             TEXT,
  access_app_aud            TEXT,
  tunnel_id                 TEXT UNIQUE,
  dns_record_id             TEXT,
  tunnel_secret_generation  INTEGER NOT NULL DEFAULT 1,
  ingress_version           INTEGER,
  cf_status                 TEXT CHECK (cf_status IN ('inactive','degraded','healthy','down','unknown')),
  cf_status_at              INTEGER,
  conns_active_at           TEXT,
  conns_inactive_at         TEXT,
  created_at                INTEGER NOT NULL,
  claimed_at                INTEGER,
  last_seen_at              INTEGER,
  revoked_at                INTEGER,
  revoked_by                TEXT,                   -- user id, 'system', or 'machine'
  revoke_reason             TEXT CHECK (revoke_reason IN
                              ('user_unpair','admin_revoke','machine_logout','user_disabled','stale','provision_failed'))
);
CREATE INDEX machines_by_owner  ON machines(owner_user_id, status);
CREATE INDEX machines_by_status ON machines(status);

-- Column semantics owned by 06; 06 may amend via a new migration before the first release.
CREATE TABLE pair_requests (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  state_hash          BLOB NOT NULL CHECK (length(state_hash) = 32),
  code_hash           BLOB UNIQUE CHECK (code_hash IS NULL OR length(code_hash) = 32),
  code_challenge      TEXT NOT NULL CHECK (length(code_challenge) = 43),
  machine_public_key  BLOB NOT NULL CHECK (length(machine_public_key) = 32),
  machine_name        TEXT NOT NULL CHECK (length(machine_name) BETWEEN 1 AND 32),   -- 02 MachineName
  callback_port       INTEGER NOT NULL CHECK (callback_port BETWEEN 1024 AND 65535),
  origin_port         INTEGER NOT NULL DEFAULT 3890 CHECK (origin_port BETWEEN 1 AND 65535),  -- PairAuthorizeQuery.origin_port
  machine_id          TEXT REFERENCES machines(id),
  status              TEXT NOT NULL CHECK (status IN ('pending','confirmed','claimed','expired','cancelled')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  claimed_at          INTEGER
);
CREATE INDEX pair_requests_by_expiry ON pair_requests(status, expires_at);

-- Column semantics owned by 06 (registration, 02 DeviceRegistration) and 08 (delivery).
-- push_kind 'none' is wire push.kind = none; any other value is push.kind = webpush with that channel.
-- Delivery state (push_state, last success, failure counter) and mutes (mute_all, muted_until,
-- per-machine mutes) are added by 08's push migration, which owns their semantics.
CREATE TABLE devices (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id),
  install_id             TEXT NOT NULL,   -- 02 InstallId; equals the Yaran-Install-Id header (W12)
  platform               TEXT NOT NULL CHECK (platform IN ('android','ios')),
  flavor                 TEXT NOT NULL CHECK (flavor IN ('foss','play','appstore','dev')),
  form_factor            TEXT NOT NULL CHECK (form_factor IN ('phone','tablet')),
  locale                 TEXT CHECK (locale IS NULL OR length(locale) <= 35),
  push_kind              TEXT NOT NULL CHECK (push_kind IN ('unifiedpush','fcm_embedded','apns_relay','fcm_relay','none')),
  push_distributor       TEXT CHECK (push_distributor IS NULL OR length(push_distributor) <= 128),
  endpoint_enc           TEXT,            -- data-key sealed (capability URL)
  endpoint_host          TEXT,            -- plain host for Device.push.endpoint_host
  p256dh                 BLOB,            -- public, stored plain
  auth_enc               TEXT,            -- data-key sealed
  push_vapid_public_key  BLOB CHECK (push_vapid_public_key IS NULL OR length(push_vapid_public_key) = 65),  -- org key at registration
  device_key             BLOB NOT NULL CHECK (length(device_key) = 65),   -- 02 §8.1 device key (public), fixed per install_id (D24)
  device_key_fingerprint TEXT NOT NULL CHECK (length(device_key_fingerprint) = 29),   -- 02 DeviceKeyFingerprint, kept after revocation
  app_version            TEXT NOT NULL CHECK (length(app_version) <= 48),   -- 02 SemVer
  label                  TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at             INTEGER NOT NULL,
  last_seen_at           INTEGER,
  revoked_at             INTEGER,
  revoked_by             TEXT,
  UNIQUE (user_id, install_id)
);
CREATE INDEX devices_by_user ON devices(user_id, revoked_at);
CREATE INDEX devices_revoked_by_key ON devices(device_key_fingerprint) WHERE revoked_at IS NOT NULL;   -- 06 skip rule 5

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,         -- Uuid (AuditEntry.id); pages ordered by (at, id)
  at           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user','admin','machine','system','setup')),
  actor_id     TEXT,
  action       TEXT NOT NULL,            -- registry/audit-actions.json
  target_kind  TEXT CHECK (target_kind IS NULL OR target_kind IN ('org','user','machine','device','settings')),
  target_id    TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  error_code   TEXT,                     -- registry code when outcome <> 'ok'
  request_id   TEXT,
  ip           TEXT,
  country      TEXT CHECK (country IS NULL OR length(country) = 2),
  detail       TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 2048))
);
CREATE INDEX audit_by_time   ON audit_log(at);
CREATE INDEX audit_by_target ON audit_log(target_kind, target_id, at);
CREATE INDEX audit_by_actor  ON audit_log(actor_kind, actor_id, at);

CREATE TABLE machine_nonces (
  machine_id  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (machine_id, nonce)
) WITHOUT ROWID;
CREATE INDEX machine_nonces_by_expiry ON machine_nonces(expires_at);

-- Saga state (05). At most one live op per machine, enforced by the partial unique index.
CREATE TABLE provisioning_ops (
  id               TEXT PRIMARY KEY,
  machine_id       TEXT NOT NULL REFERENCES machines(id),
  kind             TEXT NOT NULL CHECK (kind IN ('provision','teardown','rotate','repair')),
  state            TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','compensating','compensated')),
  step             TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  params           TEXT CHECK (params IS NULL OR json_valid(params)),
  lease_owner      TEXT,
  lease_until      INTEGER,
  next_attempt_at  INTEGER NOT NULL,
  last_error_code  TEXT,
  last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  requested_by     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX provisioning_ops_one_live ON provisioning_ops(machine_id)
  WHERE state IN ('pending','running','compensating');
CREATE INDEX provisioning_ops_due ON provisioning_ops(state, next_attempt_at);

-- Resources carrying this instance's marker but owned by no live machine (05).
CREATE TABLE cf_orphans (
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('tunnel','dns_record','access_app','access_policy')),
  resource_id    TEXT NOT NULL,
  marker         TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (resource_kind, resource_id)
) WITHOUT ROWID;

-- Last observed Cloudflare API budget (05), single row.
CREATE TABLE cf_api_budget (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  remaining      INTEGER,
  reset_at       INTEGER,
  blocked_until  INTEGER,
  observed_at    INTEGER NOT NULL
);

CREATE TABLE scheduled_tasks (
  task          TEXT PRIMARY KEY,
  next_run_at   INTEGER NOT NULL,
  cursor        TEXT,
  lease_until   INTEGER,
  last_ok_at    INTEGER,
  last_error    TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024)
);

CREATE TABLE rate_counters (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;
```

**No `handoffs` table.** The sealed handoff (D8) is stateless:

- the JWT is sealed to the phone's ephemeral key and returned in a redirect;
- a replayed redirect yields only ciphertext the attacker cannot open.

06 adds a table by migration if its design needs single-use state.

**Settings schema** (`db/settings.ts`): the key, its type, default, validator and owning
phase.

- **Contract keys.** Every top-level key of 02's `Settings` object (W26: `org_name`,
  `session_duration`, `pairing_policy`, `machine_cap_per_user`, `device_cap_per_user`,
  `push`, `stale_machine_policy`, `audit_retention_days`, `quota_limits`,
  `orphan_cleanup`, `deployer_repo_url`) is one row with that exact name, validated by 02's
  schema through `@yaran/protocol`, with 02's defaults. 07 renders and writes them.
- **Internal keys.** Everything else below is a Worker-internal row with no admin API
  (02 §6 note): setup state, Cloudflare identifiers, generated keys and operational knobs.

| Key | Type | Default | Owner |
|---|---|---|---|
| `setup_state` | enum | `"open"` | 04 / 07 |
| `instance_id` | 8 random hex chars | generated at setup | 07, used by 05 |
| `account_id` | string | none | 07 |
| `zone_id` | string | none | 07 |
| `zone_name` | string | none | 07 |
| `control_plane_host` | string | none | 07 |
| `team_domain` | string | none | 07 |
| `control_plane_app_id` | string | none | 07 |
| `control_plane_aud` | string | none | 07 |
| `jwt_clock_tolerance_s` | int | 60 | 04 |
| `session_duration` (contract) | Access duration `^[1-9][0-9]{0,3}(m\|h)$` | `"24h"` | 07; applied by 05 to every machine app |
| `audit_retention_days` (contract) | int 30–3650 | 365 | 04 |
| `quota_limits` (contract) | `{access_apps, access_policies, tunnels}` | `{500, 500, 1000}` | 05 |
| `orphan_grace_minutes` | int | 120 | 05 |
| `vapid_public_key` | string | none | 08 |
| `vapid_private_key_enc` | string | none | 08 |
| `data_key_state` | `{version: int ≥ 1, check: B64url 22, previous_check: B64url 22 \| null}` | written on first use (§7) | 04; `version` is 06's consent-cookie `kv` |

A missing key falls back to its default. An invalid stored value is a loud error, never a
silent default.

### 13. Module tree (`cloud/worker/`)

Every code file is at most 500 lines and starts with the CONVENTIONS §2 header, whose
generated block is checked by `tools/module-headers --check`. Planned sizes are in
brackets.

```text
cloud/worker/
├── package.json             scripts, deps (jose, "@yaran/protocol": "file:../protocol"), devDeps; "engines": {"node": ">=22.12"}
├── package-lock.json        lockfileVersion 3 (generated)
├── .node-version            22 (Workers Builds reads it; matches CONTRIBUTING.md:12)
├── .gitignore               .wrangler/, .dev.vars, dist/  (local: the Deploy clone has no root .gitignore)
├── .dev.vars.example        CF_API_TOKEN, SETUP_CODE, DATA_KEY (descriptions refined by 07)
├── wrangler.jsonc           commented; see §14
├── worker-configuration.d.ts  generated by `wrangler types` (generated marker)
├── tsconfig.json            strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, types: [worker-configuration]
├── eslint.config.js         flat config mirroring crates/yaran-web/web/eslint.config.js
├── vitest.config.ts         cloudflareTest({ wrangler: { configPath } }), readD1Migrations
├── migrations/0001_init.sql
├── src/
│   ├── index.ts                    entry: fetch → http/pipeline, scheduled → dispatcher [~60]
│   ├── env.ts                      Env augmentation (Cloudflare.Env), binding presence checks [~80]
│   ├── http/
│   │   ├── pipeline.ts             ordered request pipeline (§2): guard → match → limit → body → auth → handler [~180]
│   │   ├── router.ts               URLPattern compile + match, 405 vs 404 [~110]
│   │   ├── routes.ts               THE route table; each phase appends rows [~150, grows per phase, split by area if >400]
│   │   ├── context.ts              RequestContext (env, ctx, db, log, request_id, identity) [~90]
│   │   ├── responses.ts            json(), html(), error(), security headers, CSP [~200]
│   │   ├── body.ts                 size-capped raw/JSON read, content-type check, schema validate via @yaran/protocol [~120]
│   │   └── host-guard.ts           setup state, workers.dev and control_plane_host enforcement [~80]
│   ├── auth/
│   │   ├── authorize.ts            exhaustive RouteAuth switch [~120]
│   │   ├── access-jwt.ts           jose verify, module-scope JWKS cache, claim checks [~160]
│   │   ├── identity.ts             email → users row, first-sight provisioning, roles [~150]
│   │   ├── machine-signature.ts    header parse, window, key resolvers, Ed25519 verify [~220]
│   │   └── nonce-store.ts          INSERT OR IGNORE, purge query [~60]
│   ├── security/
│   │   ├── secrets.ts              secret presence/shape validation, constant-time compare [~110]
│   │   ├── data-key.ts             HKDF per purpose, AES-GCM seal/open with AAD, key versions [~180]
│   │   ├── rate-limit.ts           binding tier + D1 strict tier, bucket registry [~200]
│   │   └── sanitize.ts             mirror of sanitize.rs::for_terminal [~50]
│   ├── log/logger.ts               structured JSON, key deny-list redaction [~120]
│   ├── audit/
│   │   ├── actions.ts              re-exports the AuditAction union generated from registry/audit-actions.json [~30]
│   │   └── audit.ts                record(), coalescing of denied rows, retention purge [~150]
│   ├── db/
│   │   ├── client.ts               one/all/run/batch helpers, changes(), typed row mappers [~140]
│   │   ├── migrate-runtime.ts      G11 fallback L1 only: schema_migrations table + ordered batches [~150]
│   │   ├── settings.ts             settings schema, defaults, validated get/set [~220]
│   │   ├── users.ts                users repository [~150]
│   │   └── machines.ts             machines repository (reads + status transitions; 05 adds CF columns writes) [~250]
│   └── scheduled/
│       ├── dispatcher.ts           due-task selection, leases, per-run budgets [~200]
│       ├── tasks.ts                typed task registry (04 rows; 05/08 append) [~80]
│       └── purge.ts                nonce/pair_request/audit/rate_counter purges, reseal [~120]
└── test/
    ├── setup.ts                    applyD1Migrations, msw network enable/reset, console capture [~80]
    ├── env.d.ts                    TEST_MIGRATIONS binding typing [~20]
    ├── helpers/
    │   ├── access.ts               RSA keypair, JWKS msw handler, JWT minting (user/admin/service/expired/wrong aud) [~180]
    │   ├── machine.ts              Ed25519 keypair, signed request builder via @yaran/protocol sig/sign.ts [~140]
    │   └── seed.ts                 settings/users/machines seeders [~120]
    ├── router.test.ts  responses.test.ts  host-guard.test.ts  body.test.ts
    ├── access-jwt.test.ts  identity.test.ts  machine-signature.test.ts  nonce-store.test.ts
    ├── data-key.test.ts  secrets.test.ts  rate-limit.test.ts  sanitize.test.ts  logger.test.ts
    ├── audit.test.ts  settings.test.ts  dispatcher.test.ts  purge.test.ts  migrations.test.ts
    ├── authz-matrix.test.ts        every route row × every identity kind
    ├── protocol-boundary.test.ts   no import or path outside cloud/worker except @yaran/protocol (assembler contract)
    ├── error-codes.test.ts         every emitted code exists in registry/errors.json with the sent status
    └── no-secret-leak.test.ts      runs the suite's request corpus, asserts no secret in captured logs/responses
```

### 14. `wrangler.jsonc` (key fields; every field commented in the file)

```jsonc
{
  "name": "yaran-cloud",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",          // bumped deliberately, never "today" in CI
  "compatibility_flags": ["global_fetch_strictly_public"],
  "workers_dev": true,                         // D19: setup bootstrap only; code serves /setup* and /v1/meta here
                                               // while setup is open and refuses every workers.dev Host after (§3)
  "preview_urls": false,                       // always off; disabling workers.dev does not disable previews
  "routes": [],                                // never a custom_domain here: a CI deploy would overwrite the
                                               // deployer's DNS; 07 attaches the custom domain by API (G14)
  "d1_databases": [{ "binding": "DB", "database_name": "yaran-cloud", "database_id": "<filled by deploy>", "migrations_dir": "migrations" }],
  "triggers": { "crons": ["* * * * *"] },
  "ratelimits": [
    { "name": "RL_IP",      "namespace_id": "7701", "simple": { "limit": 300, "period": 60 } },
    { "name": "RL_AUTH",    "namespace_id": "7702", "simple": { "limit": 20,  "period": 60 } },
    { "name": "RL_MACHINE", "namespace_id": "7703", "simple": { "limit": 120, "period": 60 } }
  ],
  "observability": { "enabled": true },
  "keep_vars": false
}
```

- **`global_fetch_strictly_public`:** any `fetch` to a hostname in the Worker's own zone
  goes through Cloudflare's front door, Access included. A same-zone fetch to a machine
  hostname can therefore never bypass Access (R4 Part 5 §2.3–2.5). D1 already forbids
  proxying; this flag is defence in depth.
- **`database_id`:** the docs disagree on whether it can be omitted for a button deploy
  (UNVERIFIED). 07's G11 gate settles the placeholder strategy; 04 keeps the binding name
  `DB` stable either way.

## Work items

1. **Scaffold and toolchain.**
   - Create: `package.json`, `package-lock.json`, `.node-version`, `.gitignore`,
     `.dev.vars.example`, `wrangler.jsonc`, `tsconfig.json`, `eslint.config.js`,
     `vitest.config.ts`, `test/setup.ts`, `test/env.d.ts`, and `src/index.ts` (a stub
     returning `404` for every path).
   - Pins:
     - dependencies `jose@^6.2.17` and `"@yaran/protocol": "file:../protocol"` (02 work
       item 1);
     - devDependencies `wrangler@^4.162.0`, `@cloudflare/vitest-plugin@^1.8.2`,
       `vitest@^4.1.8`, `msw@^3.0.5`, `@msw/cloudflare@^0.2.0`,
       `typescript@6.0.3` (exact: the plan-wide pin of Phase 01/02, R21), `eslint@^10.3.0`,
       `typescript-eslint@^8.59.2`.
   - Scripts: `types` (`wrangler types`), `types:check` (`wrangler types --check`),
     `typecheck` (`tsc --noEmit`), `lint`, `test` (`vitest run`),
     `db:migrations:apply` (`wrangler d1 migrations apply DB --remote`),
     `db:migrations:local`, `build`
     (`wrangler deploy --dry-run --outdir dist`), `deploy` (07 finalizes:
     migrations, then `wrangler deploy`).
   - Reuse: version pins from `crates/yaran-web/web/package.json:53-61`; the eslint flat
     config shape from `crates/yaran-web/web/eslint.config.js`.
   - Tests: `migrations.test.ts`:
     - all migrations apply on an empty database;
     - each CHECK constraint rejects a bad row (one case per constraint);
     - the `provisioning_ops_one_live` partial index rejects a second live op;
     - foreign keys are enforced.

2. **Protocol dependency (D18).**
   - Wire `@yaran/protocol` as the one external first-party dependency (§1). No vendored
     copy, sync script or drift check exists on `main`; Phase 07's assembler and Phase 18's
     `release-cloud` workflow produce the self-contained `cloud-deploy` tree from a tag.
   - Reuse: the shared-fixture loading pattern of `prose.test.tsx:75-82`, resolving
     fixtures through the `@yaran/protocol` package rather than a relative path.
   - Tests: `protocol-boundary.test.ts` walks `cloud/worker/` (sources, tests, configs) and
     fails on any import specifier or relative path that leaves the package other than
     `@yaran/protocol`, so the assembler's one-line rewrite stays sufficient;
     `error-codes.test.ts` asserts every code in §6 exists in `registry/errors.json` with
     the status this phase sends.

3. **HTTP core.**
   - Create `http/pipeline.ts`, `router.ts`, `routes.ts`, `context.ts`, `responses.ts`,
     `body.ts` and `host-guard.ts`.
   - Tests:
     - router: 404 vs 405, path params, no trailing-slash ambiguity; G8's normalisation
       probe set as fixtures (`/v1/MACHINE/claim`, `/v1/machine/%2e%2e/me`,
       `/v1/machine/a/b`, `//v1/me`, an encoded `/`) all `404` without reaching auth, while
       `/v1/machine/claim`, `/v1/machine/unpair` and `/v1/machine/origin` route;
     - protocol: missing or out-of-range `Yaran-Protocol` on a JSON route gives
       `400 protocol_unsupported` with `{min, max}`; `/v1/meta` needs no header; every
       response carries `Yaran-Protocol` and `Yaran-Request-Id`;
     - CSRF: a mutating `/v1/me/*` or `/v1/admin/*` request with a foreign `Origin`, or a
       non-JSON content type, is refused (`origin_mismatch`, `unsupported_media_type`);
     - responses: every code maps to its 02 status; HTML vs JSON error shapes; security
       headers on every response, errors included; the CSP has no remote script source;
     - body: 413 over the cap, 415 for a wrong content type, a 02-schema validation
       failure gives `validation_failed` with a pointer;
     - host guard: open vs closed setup × control-plane host vs `*.workers.dev` vs other
       Host. While open, `/setup*` and `/v1/meta` are served on workers.dev and every other
       route is `503 setup_incomplete`; once closed, workers.dev and any other Host get
       `421 misdirected_host` with no host named in the body, and `/setup*` on the
       control-plane host is `410 setup_closed`.

4. **Logging and sanitize.**
   - Create `log/logger.ts` and `security/sanitize.ts`. Add the shared fixture
     `cloud/protocol/fixtures/sanitize_cross_language.json`, coordinated with 02. Its Rust
     reader is an in-module test next to `sanitize.rs:21-33`, in a 02/09 PR.
   - Tests: fixture parity; deny-listed keys redacted at any depth; ANSI, OSC and C1 in
     values escaped.

5. **D1 layer and repositories.**
   - Create `migrations/0001_init.sql` (§12), plus `db/client.ts`, `settings.ts`,
     `users.ts` and `machines.ts`.
   - `machines.ts` exposes status transitions as named functions with guarded `UPDATE …
     WHERE status IN (…)`. Each returns whether it applied, so concurrent transitions
     cannot both win.
   - Tests:
     - every repository function, against a real Miniflare D1;
     - transition guards (two racing `revoke` calls: exactly one applies);
     - settings: defaults, an invalid stored value is a loud error, an unknown key is
       refused.

6. **Access JWT, identity, authorization.**
   - Create `auth/access-jwt.ts`, `identity.ts` and `authorize.ts`.
   - Tests use JWTs minted in-test against a JWKS served by msw at
     `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`:
     - valid user;
     - wrong `aud`, wrong `iss` (including a trailing slash), expired, `nbf` in the future;
     - `alg` set to HS256 or none;
     - unknown `kid`, which triggers a refetch and then rejection;
     - a service-token-shaped token gets `service_token_rejected`;
     - a missing email;
     - an unreachable JWKS gets `503`, never a pass;
     - team-domain validator rejections;
     - first-sight user creation; disabled user; email case folding;
     - the `last_seen_at` throttle.

7. **Machine signature and nonce store.**
   - Create `auth/machine-signature.ts` and `nonce-store.ts`.
   - Tests:
     - the 02 signature fixtures (`fixtures/sig/*.json`: valid and every invalid vector,
       wrong host, query present, bare `/v1/machine` path included) all pass through
       `@yaran/protocol`'s codec;
     - clock skew at both edges (±300 s passes, ±301 s fails with `signature_expired`,
       `details.server_time` and a `Date` header);
     - a malformed or missing header, a 15- or 17-byte nonce, gives `signature_missing`;
     - replayed nonce;
     - a nonce is not consumed when the signature is bad;
     - revoked machine gets `410` only after a valid signature;
     - an unknown machine id gives `401 machine_unknown` and a bad signature
       `401 signature_invalid` (same status, distinct codes, as 02 §7 defines);
     - W4 (no `Yaran-Machine-Id`) resolves through the `pair_request` resolver and keys its
       nonce `claim:<code>`;
     - a body-hash mismatch;
     - the `pair_request` resolver seam.

8. **Secrets and encryption at rest.**
   - Create `security/secrets.ts` and `data-key.ts`.
   - Tests:
     - seal/open round trip;
     - AAD mismatch (other row, other column) fails;
     - a tampered IV or ciphertext fails;
     - `DATA_KEY_PREVIOUS` opens and the reseal task migrates the row;
     - key version: the first boot writes `version = 1`; a new `DATA_KEY` bumps it exactly
       once when two isolates race (conditional `UPDATE`); `DATA_KEY_PREVIOUS` opens
       `k<version − 1>` only while its check equals `previous_check`; a stored `k<n>` of
       any other version fails loudly naming the purpose; the row never holds key material;
     - `macKey("handoff_consent")` reproduces the key hex in 02's
       `fixtures/handoff/consent-cookie.json` and returns the current `version` as `kv`;
       after a rotation the old `kv`'s MAC no longer verifies, even with
       `DATA_KEY_PREVIOUS` set;
     - a missing `CF_API_TOKEN`, `SETUP_CODE` or `DATA_KEY`, or a short or invalid
       `DATA_KEY`, refuses service with `503 unavailable` (only `/v1/meta` still answers)
       and a log line naming the secret, never its value;
     - setup-code comparison is constant time (same code path for any length).

9. **Rate limiting.**
   - Create `security/rate-limit.ts`.
   - Tests:
     - binding tier (miniflare simulates `ratelimits`);
     - the fallback to D1 when a binding is absent;
     - strict tier window rollover;
     - setup lockout after the daily cap;
     - `Retry-After` present.

10. **Audit log.**
    - Create `audit/actions.ts` and `audit/audit.ts`.
    - Tests: row shape; detail cap and sanitization; denied-row coalescing; retention
      purge; the action union is generated from `registry/audit-actions.json` and every
      action this phase records is in it (a compile-time `satisfies` test); the W25
      `AuditEntry` mapping (actor kinds, `ok`/`error`, `error_code`, `country`).

11. **Cron dispatcher.**
    - Create `scheduled/dispatcher.ts`, `tasks.ts` and `purge.ts`.
    - Tests via `createScheduledController`:
      - due-task selection and priority;
      - lease prevents double runs in overlapping invocations;
      - budget exhaustion defers the remaining tasks to the next run;
      - a throwing task records `last_error` and does not block the others;
      - each purge task deletes only expired rows.

12. **Authorization matrix and leak test.**
    - `authz-matrix.test.ts` iterates `routes.ts` (so routes 05–08 add are covered
      automatically). The identity kinds:
      - none;
      - user JWT;
      - admin JWT;
      - disabled user;
      - service-token JWT;
      - JWT for a different AUD (for example a machine app's);
      - valid machine signature;
      - revoked-machine signature;
      - unknown machine id;
      - replayed nonce;
      - skewed clock;
      - each of the above on a `*.workers.dev` Host, before and after setup closes.
    - Each route's expected outcome is derived from its declared `auth`. A route added
      without a matrix expectation fails the test.
    - `no-secret-leak.test.ts`:
      - seeds recognizable sentinel values for `CF_API_TOKEN`, `DATA_KEY`, a JWT, a
        signature and a device endpoint;
      - replays every matrix request;
      - asserts that no sentinel appears in captured console output or in any response
        body or header.

13. **Threat-model rows.**
    - Append sections and `SECURITY.md:50` STRIDE rows using the IDs allocated in Phase 17's
      table (T25–T64); this phase writes the mitigation text for:
      - **T54** control-plane Worker reached without valid identity: Access
        misconfiguration and service-token impersonation, mitigated by in-Worker JWT
        verification, `service_token_rejected` and `user_disabled`;
      - **T28** machine-signature replay and clock attacks on `/v1/machine/*` (W4–W8, W32,
        `POST /v1/machine/unpair` and `PUT /v1/machine/origin` included): ±300 s window,
        single-use nonces, canonical paths only;
      - **T55** D1 data exposure: data-key sealing, hashes for codes, no tunnel tokens;
      - **T41** org VAPID private key stored only data-key sealed in D1;
      - **T47** Deploy-secret leak (`CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY`): validation
        without echo, log redaction, the no-secret-leak test;
      - **T31** and **T33** host confusion and the workers.dev setup window: only `/setup*`
        and `/v1/meta` served there while setup is open, `421 misdirected_host` for every
        non-control-plane Host after;
      - **T32** same-zone fetch bypassing Access: `global_fetch_strictly_public`;
      - **T34** cross-user authorization: the route-table auth classes and the authz matrix;
      - **T48** audit tampering and repudiation: append-only writer, coalesced denials,
        retention;
      - **T49** D1 write-budget exhaustion: nonce rows only after a valid signature,
        throttled `last_seen`, rate limits.

14. **Runtime migrator (G11 fallback L1, only if G11 records that migrations in the deploy
    script fail on the first build).**
    - Create `db/migrate-runtime.ts`: a `schema_migrations(version, applied_at)` table and
      ordered `env.DB.batch` statements generated at build time from the same
      `migrations/*.sql` files, applied on the first request or cron run of a new version
      under a D1 lease row, before any route is served. The deploy script still tries
      `wrangler d1 migrations apply` first; the runtime path skips versions already applied.
    - Tests: an empty database is migrated on first request; a second concurrent invocation
      waits on the lease and does not double-apply; a database already migrated by
      wrangler is left unchanged; a failing statement leaves the version unrecorded and
      serves `503 unavailable` with a log line.

## Acceptance

- [ ] `cloud/worker/` builds, typechecks under `strict`, lints, and `wrangler deploy --dry-run` succeeds with no network.
- [ ] Every route row declares an `auth` class; adding a row without one fails `tsc`; the authorization matrix covers every row and passes.
- [ ] Access JWTs are verified from the header only. RS256 is pinned, `iss`/`aud`/`exp`/`nbf` are enforced, service-token JWTs are rejected, and an unreachable JWKS fails closed.
- [ ] Machine requests are verified per 02 §7 and its fixtures: the canonical string comes from `@yaran/protocol`, clock window ±300 s, 16-byte nonces single use, revoked machines get `410` only after a valid signature, unknown ids get `401 machine_unknown`, and every code emitted is in 02's registry.
- [ ] `0001_init.sql` applies on an empty D1. Every CHECK, the foreign keys and the one-live-op index are proven by tests.
- [ ] Worker-generated secrets are stored only data-key sealed with row-bound AAD. Tunnel tokens are never written to D1.
- [ ] D24: `handoff_consent` is a `data-key.ts` purpose whose key matches 02's consent-cookie fixture; the `DATA_KEY` version is recorded in `data_key_state`, bumps once per new key, and only the current version verifies a MAC.
- [ ] No secret sentinel appears in any log line or response across the whole request corpus.
- [ ] While setup is open, only `/setup*` and `/v1/meta` are served on any Host, workers.dev included. After setup, only `control_plane_host` is served: every other Host (workers.dev included) gets `421 misdirected_host`, and `/setup*` answers `410 setup_closed`.
- [ ] `wrangler.jsonc` ships `workers_dev: true`, `preview_urls: false` and no custom-domain route.
- [ ] Non-canonical paths (G8 probe set) never reach a route; `Yaran-Protocol`, `Yaran-Request-Id` and the CSRF `Origin` rule follow 02 §2–§3.
- [ ] Exactly one cron expression is declared. The dispatcher respects its per-run budgets and leases.
- [ ] `main` holds no vendored protocol copy: the Worker depends on `@yaran/protocol` (`file:../protocol`) and `protocol-boundary.test.ts` proves nothing else leaves the package, so 07's assembler can build the `cloud-deploy` tree from it.
- [ ] Every code file is at most 500 lines and its module-header block passes `tools/module-headers --check`.
- [ ] Threat-model sections and STRIDE rows for this surface are merged.

## Validation

```bash
cd cloud/worker
npm ci                             # installs @yaran/protocol from ../protocol (file: dependency)
npm run types:check
npm run typecheck
npm run lint
npm test
npm run db:migrations:local
npm run build                      # wrangler deploy --dry-run --outdir dist
cd ../.. && node tools/module-headers/bin/module-headers.mjs --check cloud/worker   # CLI path per Phase 01
test ! -e cloud/worker/vendor      # no vendored protocol copy on main (D18)
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rate Limiting binding unavailable on Workers Free (UNVERIFIED) | Medium | Deploy fails or limits are missing | A missing binding falls back to the D1 strict tier; the `ratelimits` block is documented as removable; Phase 19 deploys on a Free account |
| workers.dev stays reachable (the wizard's disable call fails, or a Workers Builds redeploy with `workers_dev: true` re-enables it, G14 step 7) | Medium | A second hostname for the control plane | D19: the code serves only `/setup*` and `/v1/meta` there while setup is open (gated by `SETUP_CODE` and the strict limiter) and answers `421 misdirected_host` to every non-control-plane Host afterwards, whatever the subdomain setting |
| Setup takeover during the workers.dev window (T33) | Low | An attacker becomes admin | `SETUP_CODE` is a Deploy-time secret (D20) compared in constant time; tier-2 limiter with a daily lockout; the window closes the moment 07 records the admin |
| Free-plan 10 ms CPU exceeded by JWT verify plus D1 work | Low | 1102 errors | WebCrypto verify is sub-millisecond, and the JWKS fetch is I/O, not CPU; Phase 19 measures with Workers Logs CPU fields; Paid is documented as recommended for large orgs |
| D1 write budget (Free 100k/day) exhausted by nonces or abuse | Low | API errors until 00:00 UTC | Nonce rows only after a valid signature; `last_seen` throttles; audit coalescing; per-machine limiter |
| `DATA_KEY` lost or rotated without `DATA_KEY_PREVIOUS` | Low | VAPID key and device endpoints unreadable; every remembered handoff consent is forgotten (D24), so each phone meets the consent page once | Seal-time key version recorded in `data_key_state`; reseal task; documented rotation runbook (17, 22); a failed open is a loud error naming the purpose, and the recovery is re-running VAPID generation and device re-registration |
| `@cloudflare/vitest-plugin` and Vitest churn (renamed 2026-08) | Medium | Test harness breaks on upgrade | Versions pinned; dependabot entry (18); the harness is confined to `vitest.config.ts` and `test/setup.ts` |
| The generated `cloud-deploy` tree diverges from `main` | Low | Deployers run code that differs from the tagged source | The tree is generated, never edited: 18's `release-cloud` runs 07's assembler on the tagged commit; `protocol-boundary.test.ts` keeps the one-line rewrite sufficient; G11 proves the button against that tree |
| Access forwards no header for phone cookie requests (G1/G3 pending) | Low | Phone API calls 401 | 06 owns the client shape; the verifier is source-agnostic, and if G1 forces a bearer variant it is a new input path into the same `verifyAccessJwt` |

## References

- `docs/plans/phoneapp/00-README.md` (D2, D3, D5, D6, D8, D16, D18, D19, D20; flows 1, 2, 6)
- `docs/plans/phoneapp/02-protocol-contract.md` §1 (package), §2–§4 (conventions, versioning, error registry), §5 (W1–W32), §6 (`Settings`, `Device`, `AuditEntry`), §7 (signing)
- `docs/plans/phoneapp/03-platform-verification-gates.md` G8, G11, G14
- `docs/plans/phoneapp/00-CONVENTIONS.md` §1–§6
- `docs/plans/phoneapp/research/R4-cloudflare.md`: Part 2 §1–3, Part 3 §1–4, Part 4 §4–5, Part 5 §1–3, §6–7, §9; Hard constraints 3, 6
- `docs/plans/phoneapp/research/R3-repo-process.md`: §1, §8, Implications 1–4, 8
- https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ (2026-11-13)
- https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/ (2026-10-08)
- https://developers.cloudflare.com/workers/wrangler/configuration/ (2026-11-12)
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ (2026-11-12)
- https://developers.cloudflare.com/d1/worker-api/d1-database/ (2026-06-22), https://developers.cloudflare.com/d1/platform/limits/ (2026-10-30), https://developers.cloudflare.com/d1/sql-api/foreign-keys/ (2026-11-10)
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (2026-09-30)
- https://developers.cloudflare.com/workers/platform/limits/ (2026-11-13)
- https://developers.cloudflare.com/workers/platform/deploy-buttons/ (2026-10-12)
- https://developers.cloudflare.com/workers/configuration/secrets/ (2026-10-15)
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (2026-11-02)
- https://github.com/panva/jose (6.2.17, 2026-11-09)
- https://github.com/cloudflare/api-schemas `openapi.json` (commit 2026-11-13)

## Reconciliation notes (2026-11-14)

- R4/D18: removed the vendored protocol copy, `protocol-sync.mjs`, `protocol:sync`/`protocol:check` and the vendor drift check; the Worker depends on `@yaran/protocol` via `file:../protocol` (02 work item 1); `cloud-deploy` is generated by 07's assembler in 18's `yaran-cloud-v*` workflow; new `protocol-boundary.test.ts` keeps that rewrite one line; risk row and validation updated.
- R5/D19: `wrangler.jsonc` now `workers_dev: true`, `preview_urls: false`, no custom domain; §3 host guard serves only `/setup*` and `/v1/meta` while setup is open and answers `421 misdirected_host` to every non-control-plane Host (workers.dev included) after; tests, acceptance and risks updated.
- 02 §4 / canonical names: setup routes after close answer `410 setup_closed` (was 404).
- R6/D20: the three Deploy-time secrets named; "Decision tension" block replaced by the D20 resolution; a missing secret answers `503 unavailable`.
- R1: kept HKDF for at-rest key derivation only and stated that the handoff envelope is JWE Concat KDF, never this module.
- 02 §7: signature section rewritten to 02's canonical string, headers (machine id absent on W4), fixed 16-byte nonce, check order and codes (`signature_missing`, `signature_invalid`, `signature_expired`, `nonce_replayed`, `machine_unknown`); unknown-id test changed from "indistinguishable" to 02's distinct `machine_unknown` (same 401).
- 02 §4: error-code list replaced by the registry names this phase emits; `error-codes.test.ts` added.
- 02 §2/§3 (no other phase owned them): `Yaran-Protocol` check and response header, `Yaran-Request-Id`, `/v1/meta` cache header, CSRF `Origin` rule (`origin_mismatch`) added to the pipeline.
- G8 (R20): canonical-path rejection before routing, tested with G8's probe set; `/v1/machine/unpair` and `/v1/machine/origin` route (R8).
- G11 (R20): work item 14 adds the fallback-L1 runtime migrator that 03 assigns to this phase.
- R9 / 02 §6: `machines` gains `ingress_origin_port` (05 port-change handling), `yaran_version`, `reported_protocol`; `name`/`slug` follow `MachineName` (≤ 32); `pair_requests.origin_port` defaults to 3890; `devices` gains `install_id` with `UNIQUE(user_id, install_id)`, `form_factor`, `locale`, `push_distributor`, `endpoint_host`, `push_vapid_public_key`, flavor `dev`, push_kind `fcm_embedded`/`fcm_relay`; `push_state` and mutes left to 08's migration (08 already plans them).
- 02 §6 `AuditEntry`: `audit_log.id` is a Uuid, `error_code` and `country` added, actor/result mapping stated; audit actions generated from `registry/audit-actions.json`.
- 02 §6 `Settings`: contract keys stored under 02's names; `machine_session_duration` → `session_duration`; `quota_limits` → `{access_apps, access_policies, tunnels}`; internal keys marked.
- Internal-to-wire mappings stated (`revoking` → `tearing_down`, `tunnel_secret_generation` → `token_version`, `RequestId`).
- R14: threat-model work item now cites T54, T28, T55, T41, T47, T31, T33, T32, T34, T48, T49.
- R18: HTML error pages styled by 07 from `packages/ui-kit/`.
- R20: Depends on adds 03 (G8, G11, G14); Out of scope names 07's assembler and 18's `release-cloud`.
- R21: TypeScript pinned to exactly `typescript@6.0.3` (was `~6.0.2`), matching Phase 01/02.
- D24: §7 adds the HKDF purpose `handoff_consent` (the one MAC key, 02 §8.1, `macKey(…) → { kv, key }`) and `key_check`.
- D24: §7 defines the `DATA_KEY` version 02 §8.1 calls `kv`: settings row `data_key_state { version, check, previous_check }`, bumped once per new key by a conditional `UPDATE`; `DATA_KEY_PREVIOUS` opens only `k<version − 1>` and never verifies a MAC, so rotation forgets remembered consent; rotation runbook says so.
- D24: `devices` gains `device_key` and `device_key_fingerprint` (02 `DeviceRegistration.device_key`, `Device.device_key_fingerprint`) and the partial index `devices_revoked_by_key` for 06's skip rule 5; work item 8 tests, one acceptance item, the `DATA_KEY` risk row's impact updated.

- D24 (final pass): threat range reference T25–T63 → T25–T64 (17 appended T64, remembered-consent bypass).

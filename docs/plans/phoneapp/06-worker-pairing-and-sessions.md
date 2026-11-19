# Phase 06 — Org Worker: machine pairing, phone sessions, sealed handoff, devices

**Track:** B (org control plane) · **Parallel-safe with:** 04, 05, 07–18 (codes against the Phase 02 contract and against mocks of 04/05)
**Depends on:** 02 (contract, codecs, fixtures); code-level 04 (auth, signatures, D1, audit) and 05 (provisioning saga, status cache); 07 work item 1 (console UI kit) for the HTML pages; gates G1 (what the handoff seals), G8 (public overrides), G13 (callback length) · **Blocks:** 07 (user console reuses the view models here), 09 (CLI login drives this flow), 14/15 (phone onboarding), 16 (device registration), 19

## Goal

Implement everything in the org Worker that turns a signed-in person into a paired
machine or a signed-in phone, and keeps a registry of both:

1. **Machine pairing** per D7: the browser confirm page at `GET /v1/pair/authorize`
   (behind the control-plane Access app), PKCE S256 and `state`, an idempotent
   provisioning call into Phase 05, a one-time code redirected to
   `http://127.0.0.1:<port>/callback`, and the Ed25519-signed `POST /v1/machine/claim`
   that returns 02's `ClaimResponse` (tunnel credentials, hostname, origin port, Access team
   domain and AUD, `owner_email`, `user_slug`, org and machine id).
2. The rest of the **machine API** that pairing creates: `GET /v1/machine/config` (W5),
   `POST /v1/machine/rotate` (W7), `POST /v1/machine/unpair` (W8, R8) and
   `PUT /v1/machine/origin` (W32, R9). Every machine route matches `^/v1/machine/[a-z]+$`,
   so the single `/v1/machine/*` public override covers all of them.
3. **Phone sessions** per D8: `GET /v1/meta` (W1, public) and the control-plane handoff
   (behind Access): `GET /v1/handoff` (W16) validates the request against 02's redirect
   allowlist and renders a one-tap **consent interstitial** naming the device and host,
   skipped only under 02 §8.1's remembered-consent rule (D24: a consent cookie for this
   device key plus a verifying device signature, and the device not revoked);
   `POST /v1/handoff` (W16b) seals the control-plane Access JWT to the phone's ephemeral
   P-256 key as 02's JWE (ECDH-ES with Concat KDF, A256GCM) and answers `303` to the app's
   callback: the configured https callback on `<publisher-domain>` for release builds, or
   `yaranapp://auth/callback` only when the request declares `build=dev`.
4. The **user API** the phone and the consoles read: `GET /v1/me` (W9),
   `GET /v1/me/machines` (W10), `DELETE /v1/me/machines/{id}` (W11), and the **device
   registry** `POST/GET /v1/me/devices` (W12, W13), `PATCH /v1/me/devices/{id}` (W31, mutes
   and label) and `DELETE /v1/me/devices/{id}` (W14), including each device's `push_state`.
5. The **phone QR payload** (`yaranapp://add-org?u=<org url>`) as data and as SVG for the
   consoles, and an **audit event** for every state change above.

## Evidence

- Pairing pattern and reuse on the yaran side (loopback redirect, `browser::open_url`,
  `ureq`): `research/R1-server-core-cli.md` §6 and §Implications 7. The CLI half is
  Phase 09.
- Access JWT: validate the `Cf-Access-Jwt-Assertion` header, not the cookie ("the cookie
  is not guaranteed to be passed"); RS256 only; `iss` = `https://<team>.cloudflareaccess.com`;
  `aud` is an array; service-token JWTs carry no `email`, `sub:""` and `common_name`
  (`research/cloudflare-parts/03-jwt-native.md:34-79`).
- A non-browser client can present the app JWT either as the `cf-access-token` header or as
  the `CF_Authorization` cookie (unless the binding cookie is on); Access then attaches
  `Cf-Access-Jwt-Assertion` for the origin (`03-jwt-native.md:194-200`). **Consequence for
  this phase:** the Worker always verifies the header Access attaches, so it doesn't matter
  which form the phone uses. That choice is Phase 14/15's, and nothing on the Worker side
  depends on G1.
- Orgs created on or after 2026-10-05 are forced into strict service-token mode.
  Unauthenticated or expired requests then get 401/403 with no cookie, instead of a 302
  (`02-access.md:128`, `03-jwt-native.md:279-284`). Access answers these before the
  Worker runs. The Worker therefore can't shape the expiry response; it can only publish
  `exp` so the client renews first (`GET /v1/me`, below).
- The app JWT lifetime follows the policy session duration (24 h by default, up to 1 month).
  When the global session is still valid, Access re-issues the token silently
  (`03-jwt-native.md:201-204`). G12 measures the exact behaviour.
- A native app cannot read cookies from ASWebAuthenticationSession or Custom Tabs, and
  Access has no redirect-to-app hook (`03-jwt-native.md:257-261`, `R5-mobile.md:139`).
  That is why D8 seals the JWT behind Access instead of offering an unauthenticated
  exchange endpoint (R5's `POST /mobile/exchange` design, `R5-mobile.md:174-185`, is
  superseded by D8).
- Tunnel liveness comes from `GET /accounts/{id}/cfd_tunnel`, which returns `status`
  (`inactive|degraded|healthy|down`) plus `conns_active_at` / `conns_inactive_at`. The
  `connections` array is deprecated and returns empty
  (https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/,
  checked 2026-11-14; `R4-cloudflare.md:83-84,146-150`). The rate limit is 1,200 requests
  per 5 minutes per token (`04-token-deploy.md` §3). **Consequence:** a machine list never
  calls the Cloudflare API per request. It reads the Phase 05 reconciliation cache.
- Access path overrides don't cover the bare prefix: `/v1/machine/*` doesn't match
  `/v1/machine` (`02-access.md:76`, confirmed on the API reference above, checked
  2026-11-14). **Consequence:** unpair is `POST /v1/machine/unpair` (02 W8, R8), not
  `DELETE /v1/machine`, so no route lives at the bare prefix and the one `/v1/machine/*`
  override (07, G8) covers every machine route.
- Per-account caps (500 Access apps, 500 reusable policies, 1,000 tunnels) limit how many
  machines an org can pair (`02-access.md:119`). Phase 05 enforces them and this phase
  surfaces the refusal.
- QR rendering: there is no QR code anywhere in the repo today (no `qr` crate in
  `Cargo.lock`, no JS library in `crates/yaran-web/web/package.json`). The Worker uses
  `uqr` 0.1.3 (MIT, zero dependencies, `renderSVG(text)` returns a string, no DOM;
  https://registry.npmjs.org/uqr, checked 2026-11-14).

## In scope

The routes, services, D1 access, validation, pages and audit events listed under Goal,
plus the pair-request expiry sweep and Access session revocation for "remove this phone
and sign out everywhere".

## Out of scope

- Access JWT middleware, machine signature verification primitive, nonce store, D1 schema
  baseline, audit writer, rate-limit wrapper, error envelope: **04**.
- Cloudflare API client, tunnel/DNS/Access provisioning saga, teardown, token rotation,
  naming and slug rules, quotas, tunnel-status reconciliation cache: **05**.
- Console UI kit, admin and user consoles, setup wizard, the `Settings` this phase reads
  (`machine_cap_per_user`, `device_cap_per_user`, `pairing_policy`, `push.relay_allowed`,
  `push.allowed_relays`), the `APP_CALLBACK_URLS` deploy variable, the control-plane Access
  app and its public overrides: **07**.
- `POST /v1/machine/events` intake, Web Push fan-out, mute enforcement and the delivery
  outcomes that set `push_state` (`gone`, `auth_failed`, `failing`): **08** (through this
  phase's devices repository).
- The machine-hostname handoff `GET`/`POST /__yaran/handoff` (Y1/Y1b, served by yaran): **11**.
- CLI loopback listener, PKCE verifier and key generation, terminal QR: **09**.
- Phone-side envelope opening, key generation, renewal scheduling, which JWT presentation
  form the app uses: **14/15**. Push key generation and registration calls: **16**.
- Envelope format, canonical signature string, schemas, error code registry: **02**.

## Design

### Seams consumed (names as planned; reconcile with the landed 04/05/02 code)

| From | Seam | Used for |
|---|---|---|
| 02 | `cloud/protocol` generated types and validators for every request and response here; `src/jwe/handoff.ts` `sealHandoff` (§8); `src/redirect.ts` `redirectAllowed` (§8 allowlist); `src/sig/fingerprint.ts` `machineKeyFingerprint` (§7.1); `src/sig/device.ts` (`handoffDeviceCanonical`, `verifyHandoffDeviceSig`, `deviceKeyFingerprint`, the three §8.1 form checks) and `src/consent.ts` (`buildConsentCookie`, `parseConsentCookie`, `consentMac`, `decideRemembered`) (§8.1, D24); `src/ua.ts` (§11 UA token); `registry/errors.json` and `registry/audit-actions.json`; fixtures | All routes; handoff; confirm page |
| 04 | `requireUser` middleware → `{ email, sub, exp, role, status }` (rejects service-token JWTs and disabled users) | `/v1/pair/*`, `/v1/handoff`, `/v1/me/*` |
| 04 | `verifyMachineRequest(req, publicKey)` (02 §7 canonical string, ±300 s window, nonce consumption) and `requireMachine` (registry lookup by `Yaran-Machine-Id`) | Machine API |
| 04 | `audit.write({ actor, action, target, detail })` (actions from the registry), `rateLimit(bucket, key)`, `apiError(code, …)`, `db`, `DATA_KEY` sealing helper, and `macKey("handoff_consent") → { kv, key }` (04 §7, D24) | Everywhere; the consent cookie |
| 05 | facade `src/provisioning/index.ts`: `deriveUserSlug`/`deriveHostname`, `startProvision(ctx, machineId)` (idempotent saga), `startTeardown(ctx, machineId, reason)`, `rotateTunnelSecret(ctx, machineId, {evict})`, `fetchTunnelToken(ctx, machineId)`, `setOriginPort(ctx, machineId, port)`, `getOp`/`driveOp`; the quota guard's refusal (wire code `account_quota_reached`); tunnel status columns on `machines` (`cf_status`, `cf_status_at`, `conns_active_at`, `conns_inactive_at`) kept fresh by 05's reconciliation | Pairing, unpair, rotate, origin, lists |
| 05 | Cloudflare client (`src/cloudflare/client.ts`, budget, retries); this phase adds one endpoint module beside 05's (work item 9) | Session revocation |
| 07 | Console UI kit (`console/ui/*`: page shell, chip, buttons, notice, CSP/CSRF wiring), `settings.read()` returning 02's `Settings`, and the `APP_CALLBACK_URLS` var | The HTML pages; caps; pairing policy; relay rules; redirect allowlist |

### Pairing state machine

`pair_requests.status` uses 04's baseline values: `pending → confirmed → claimed`, with
`pending → cancelled` (Deny) and `pending | confirmed → expired`. Every transition is a
single conditional `UPDATE … WHERE status = <expected> RETURNING`, so two claims racing
for one code can't both win.

```text
GET  /v1/pair/authorize (W2) ── validate PairAuthorizeQuery ── user active? policy? cap? same-name? ──▶
        insert pair_request{status=pending, ttl 10 min, csrf}; audit pair.requested ──▶ confirm page
        (bad callback/state → 400 page; other refusals → 302 <callback>?error=<code>&state=<state>)
POST /v1/pair/authorize (W3, form PairConsent: request_id + csrf + decision [+ replace_machine_id]) ──
        decision=deny    ─▶ pending→cancelled, audit pair.denied, 302 <callback>?error=pair_denied&state=…
        decision=approve ─▶ same validation ── allocate machine id + hostname ──▶ 05 startProvision
        │                       (saga keyed by machine id; safe to retry from the error page)
        ├─ ok ─▶ pending→confirmed, code_hash set (code lifetime 120 s), audit pair.approved
        │        302 http://127.0.0.1:<port>/callback?code=<43-char b64url of 32 bytes>&state=<state>
        └─ err ─▶ error page with the 02 code (quota: names the cap; Cloudflare error: sanitized, Retry button)
POST /v1/machine/claim (W4, ClaimRequest) ── find by sha256(code) ── signature with pair_request key ── PKCE S256 ──▶
        origin_port differs from authorize? ─▶ 05 setOriginPort before answering
        status confirmed→claimed, machine awaiting_claim→active, (replace flow: teardown old machine)
        200 ClaimResponse { machine_id, machine_name, hostname, url, origin_port, tunnel{id,token,token_version},
                            access{team_domain,aud}, owner_email, user_slug, org{name,url}, protocol }
sweep (scheduled, 1 min) ── pending/confirmed past ttl → expired, audit pair.expired; their machines → 05 startTeardown
```

Rules:

- **Callback**: exactly `http://127.0.0.1:<port>/callback`, port 1024–65535 (02
  `PairAuthorizeQuery.callback`; refusal `pair_callback_invalid`). `localhost`, IPv6
  literals, other paths, query strings and fragments are refused. The IP literal follows
  RFC 8252 §7.3 and avoids resolver games.
- **Query validation** (02 `PairAuthorizeQuery`; refusal `pair_request_invalid` unless a
  more specific code is listed):
  - `v` in the served protocol range (`protocol_unsupported`).
  - `state`: 22–128 chars of base64url.
  - `code_challenge`: exactly 43 base64url chars, and `code_challenge_method` must be
    `S256` (plain is refused).
  - `machine_pubkey`: base64url of exactly 32 bytes, importable as Ed25519 via WebCrypto.
  - `machine_name`: 02 `MachineName` (`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`); yaran
    slugifies before sending, so anything else is `machine_name_invalid`.
  - `origin_port`: optional, 1–65535, default 3890 (`origin_port_invalid`); 05 provisions
    the ingress for it at authorize.
  - `yaran_version`: ≤ 40 chars, recorded on the machine row.

  Each rule is one pure function with a table test.
- **Fingerprint** (T35): the confirm page shows `machineKeyFingerprint(machine_pubkey)` from
  02 §7.1 (29 chars, six base32 groups of four, e.g. the shape `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`)
  as a monospace chip, and asks the person to check it against what `yaran cloud login`
  printed (09 prints the same string). This cheaply defeats a pairing link crafted by
  someone else. The page test reads `cloud/protocol/fixtures/sig/fingerprint.json`.
- **The person** (T54): `requireUser` gives a JWT that is valid for the control-plane AUD,
  not a service token, and belongs to a user who isn't disabled. With
  `pairing_policy.mode = allowlist`, the Worker also refuses an email that matches neither
  `pairing_policy.emails` nor `pairing_policy.domains` with `pairing_not_allowed` (audit
  `pair.refused`, reason `policy`). Access group membership (`access_group_ids`) is decided
  by the Access policy (07). The Worker doesn't re-evaluate groups it can't see, and the
  threat model says so (T54).
- **Per-user machine cap** (`Settings.machine_cap_per_user`, default 10): checked at GET
  and again atomically at POST, counting machines in `provisioning`, `awaiting_claim` and
  `active`. Refusal `machine_cap_reached` with `details.limit`.
- **Same machine name already active for this user**: the confirm page offers two
  distinct actions (not a confirm pair):
  - **Replace** `<name>`: the new machine reuses the slug, and the old machine is torn down
    only *after* the new claim succeeds, so a failed re-pair never strands the person.
  - **Pair as** `<name>-2`: uses the next free slug from 05.

  Replace is the default focus because it is the common case: the same laptop paired again.
  Both submit `decision=approve`; the choice rides in 02's `PairConsent.replace_machine_id`
  (present = Replace, absent = Pair as). It must name the caller's own active machine whose
  name equals the request's `machine_name`; anything else, or the field with
  `decision=deny`, is `pair_request_invalid`.
- **Provisioning happens at authorize**, as the README flow says, so the claim
  response is immediate. An abandoned pairing leaves an `awaiting_claim` machine. The sweep
  expires it and calls `startTeardown` (05's ordered teardown, D21). Nothing is ever exposed
  without its Access app, because 05's saga creates the policy and app before the tunnel
  route and DNS record (D21). Saga refusals surface as 02 codes on the error page:
  `account_quota_reached` (T49), `hostname_conflict`, `provisioning_in_progress`,
  `provisioning_failed`, `cloudflare_rate_limited`, `cloudflare_permission_denied`.
- **Code**: 32 random bytes, sent as 43 base64url chars. Only `sha256(code)` is stored. The
  pair request lives 10 minutes; the code lives 120 seconds from issue and is single use
  (02 W2/W3). The claim response carries `Cache-Control: no-store`.
- **Claim signature**: the machine has no registered id before the claim, so the claim is
  verified against the public key stored on the pair request that the code selects. The
  header `Yaran-Machine-Id` carries the machine id that the claim *returns*. It is
  absent on the request, as 02 §7 defines. The nonce is still consumed through 04's store
  (record key `claim:<code>`). Refusals: `pair_code_invalid`, `pkce_mismatch`,
  `signature_invalid`, `signature_expired`, `nonce_replayed`, `origin_port_invalid`.

### Machine API after pairing

All four routes are SIG (02 §7, T28) and live under the one `/v1/machine/*` override.

- `GET /v1/machine/config` (W5):
  - Returns 02's `MachineConfig` (`machine_id`, `hostname`, `url`, `origin_port`,
    `access{team_domain,aud}`, `tunnel{id,token_version}`, `owner_email`,
    `push{enabled,detail}`, `events{max_batch,min_interval_ms}`, `server_time`; never the
    token). `tunnel.token_version` is 05's `tunnel_secret_generation` column, mapped at
    this boundary. It updates `machines.last_seen_at` (throttled to one write per 5
    minutes) and `reported_protocol` from `Yaran-Protocol`.
  - A revoked machine gets `410 machine_revoked` (after a valid signature, 02 §7 step 5),
    an unknown one `401 machine_unknown`. That's how yaran learns to stop its leg out loud
    (Phase 10).
- `POST /v1/machine/rotate` (W7, `RotateRequest {known_token_version, reason}`):
  `reason=user` calls 05 `rotateTunnelSecret(ctx, id, {evict:false})`; `reason=sync`
  returns the current token through `fetchTunnelToken` when `known_token_version` is
  behind, else `rotated:false`. Answers `RotateResponse`; audit `machine.rotated` (actor
  machine) when a rotation happened.
- `POST /v1/machine/unpair` (W8, empty body): `startTeardown(ctx, id, "machine_logout")`,
  then `202 TeardownStarted {machine_id, state:"tearing_down"}`. Idempotent: a second call
  answers `410 machine_revoked`; yaran deletes its credentials on 202 or 410. Audit
  `machine.unpaired` (actor machine).
- `PUT /v1/machine/origin` (W32, `OriginUpdate {origin_port}`): yaran sends it when its
  serving port differs from `MachineConfig.origin_port` (Phase 10 calls it before starting
  the leg). Same port → `202 {origin_port, changed:false}`; otherwise the row is updated,
  05 `setOriginPort` repairs the ingress (step P4 only, async) and the answer is
  `202 {origin_port, changed:true}`, audit `machine.origin_changed`. Out of range →
  `origin_port_invalid`; a machine with a live op → `409 provisioning_in_progress`.

### Phone session handoff (control plane)

Implements 02 §8 for the Worker side (W16/W16b); yaran's Y1/Y1b (Phase 11) follow the same
rules. Threat T36.

**`GET /v1/handoff?v=1&pk=<P256Point>&state=<state>&redirect=<callback>&device=<label>&dk=<P256Point>&dts=<unix s>&dsig=<EcdsaP256Sig>[&build=dev][&mode=fragment]`** (W16):

1. Access has authenticated the browser session (no override on this path), so
   `requireUser` passes with the control-plane app JWT.
2. Validate, in 02's order:
   - `v` in range;
   - `build` (`release` default, or `dev`) and `redirect` against the **redirect allowlist**
     with 02's `redirectAllowed`: `build=release` → `redirect` must equal, byte for byte,
     one entry of the deploy variable `APP_CALLBACK_URLS` (07; by default exactly
     `https://<publisher-domain>/auth/callback`); `build=dev` → `redirect` must equal
     `yaranapp://auth/callback`. A `release` request naming the custom scheme or a `dev`
     request naming an https URL is refused;
   - `state` is 22–128 base64url chars;
   - `mode` is `query` (default) or `fragment`;
   - `device` is 1–64 chars with control and bidi characters refused;
   - `pk` decodes to exactly 65 bytes starting `0x04` and lies on P-256 (WebCrypto raw
     import plus 02's explicit on-curve check);
   - D24, form and freshness only, through 02's `src/sig/device.ts`: `dk` is a 65-byte
     on-curve P-256 point (`handoff_device_key_invalid`); `dts` is decimal and `dsig` is 86
     base64url chars decoding to 64 bytes with `0 < r, s < n`, a DER value never sniffed
     (`handoff_signature_malformed`); `|now − dts| ≤ 300 s` (`handoff_timestamp_skewed`,
     the error redirect adding `&server_time=<unix s>`). A missing field fails as a
     malformed one.
   Then `requireUser`'s JWT checks, then the device signature: `verifyHandoffDeviceSig`
   over 02 §8.1's canonical string, built with the recorded `control_plane_host` (never a
   query or Host value), `pk`, `state` and `dts` exactly as sent. A well-formed signature
   that does not verify is **not an error**: it sets `verified = false` and the consent
   page follows.
   **Remembered consent (D24, 02 §8.1).** The page is skipped only when `decideRemembered`
   answers `skip`, which needs all five rules: the `__Secure-yaran-handoff-consent` cookie
   parses, its `kv` is `macKey`'s current `kv`, its MAC verifies under that key and its
   `iat` is within `now − 34560000 … now + 300`; its `fp24` equals `deviceKeyFingerprint(dk)`
   without dashes; `verified` is true; `dts` is fresh; and no `devices` row with `revoked_at`
   set carries that `device_key_fingerprint` (one indexed lookup on 04's
   `devices_revoked_by_key`, across all users). A skip answers exactly as Continue would
   (rate limit, seal, success headers) with `302` instead of `303`, mints no `csrf`, does
   not refresh the cookie, and audits `handoff.issued` with `details.consent: "remembered"`.
   A cookie that fails any rule is ignored, never an error and never cleared.
3. Otherwise, answer `200 text/html` with the **consent interstitial**: it names, as chips,
   the `device` label, the platform (from the system browser's User-Agent, because the page
   runs in an Auth Tab, Custom Tab or `ASWebAuthenticationSession` that never carries the
   02 §11 app token: `Android` or `iOS`/`iPadOS` from the UA's OS token, omitted when
   unrecognised; a §11 token wins if one is ever present), the control-plane host and the
   signed-in email, and asks "Sign this device in to
   `<host>`?" with **Continue** (primary, explicit focus) and **Cancel**. For `build=dev`
   it adds a warning that the request comes from a development build of the app and should
   be continued only by someone who built or installed that build. Both buttons submit
   `HandoffConsent` as a form `POST` to `/v1/handoff`, carrying every query field plus a
   `csrf` token minted by this GET: 128 random bits, stored hashed with its `state`, `pk`
   and `dk` binding plus `dk`'s fingerprint and the `verified` verdict, single use,
   10 minutes. `dts` and `dsig` are not carried into the form. The page is `no-store` and needs no script. Copy
   lives in this phase, in the house voice. It overrides two of 07's defaults (02 §8):
   `Referrer-Policy: same-origin`, because under 07's `no-referrer` the browser sends
   `Origin: null` on the Continue POST and the 02 §2 Origin rule refuses it; and
   `form-action 'self' <origin of the validated redirect, or yaranapp: for build=dev>`,
   because CSP checks `form-action` on the 303 that follows the POST. The rest of 07's
   strict CSP stays, `frame-ancestors 'none'` included. The W2 confirm page gets the same two
   overrides with the validated `http://127.0.0.1:<port>` as its `form-action` target.

**`POST /v1/handoff`** (W16b, form `HandoffConsent`):

1. Re-validate every field exactly as the GET did (`dk` included, with the same
   `handoff_device_key_invalid` check), check `csrf` (exists, unused, unexpired, bound to
   this `state`, `pk` and `dk`, a different `dk` being `handoff_request_invalid`; consumed by
   one conditional `UPDATE`) and 02 §2's `Origin` rule (`origin_mismatch`).
2. `decision=cancel` → `303 <redirect>?state=<state>&error=handoff_declined`; audit
   `handoff.declined`. Cancel neither sets nor clears the consent cookie.
3. `decision=continue` → `rateLimit("handoff", sub)` at 20 per minute per JWT `sub`; build
   02's `HandoffPayload`:
   `{v:1, kind:"control_plane", host:<control-plane host>, jwt:<Cf-Access-Jwt-Assertion
   exactly as Access attached it>, email, exp:<JWT exp>, iat:<now>, cookie?}`. `cookie` is
   the raw `CF_Authorization` value from the request's `Cookie` header, present only when
   the request carried one (G1 fallback rung L1). If G1 adopts L1, the route also refuses
   (`unauthenticated`) when that cookie is missing or its `sub`, `email` or `aud` differ
   from the verified assertion. Then `sealHandoff` (02: JWE compact, `alg: ECDH-ES` with
   the RFC 7518 Concat KDF, `enc: A256GCM`, `apu` = host, `apv` = state).
4. `303 Location: <redirect>?state=<state>&jwe=<compact>` (with `mode=fragment`:
   `<redirect>#state=<state>&jwe=<compact>`), with `Cache-Control: no-store`,
   `Pragma: no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
   and no body beyond a one-line fallback link. Audit `handoff.issued` with the hashed
   `pk` thumbprint and `details.consent: "explicit"`, never the JWT.
5. When the csrf row's `verified` is true, the `303` also carries
   `Set-Cookie: __Secure-yaran-handoff-consent=v1.<kv>.<fp24>.<iat>.<mac>; Path=/v1/handoff;
   Max-Age=34560000; Secure; HttpOnly; SameSite=Lax` (no `Domain`), built by 02's
   `buildConsentCookie` with `macKey`'s current `kv` and key, the recorded `fp24` and
   `iat = now`. With `verified` false, no cookie. This explicit Continue is the only path
   that sets it.

**Errors.** When `build`, `redirect` and `state` are valid, every other refusal redirects:
`302` (GET) or `303` (POST) to `<redirect>?state=<state>&error=<code>` (fragment form
likewise; `&min=<n>&max=<n>` for `protocol_unsupported`; `rate_limited` also sets
`Retry-After`; `handoff_timestamp_skewed` adds `&server_time=<unix s>`, and its JSON
envelope `details.server_time`). Otherwise the answer is the 02 §4 envelope with its code
(`handoff_request_invalid`, or one of the three §8.1 codes),
or a minimal HTML page with the same code for a browser navigation, and nothing is ever
redirected to an unlisted URL.

A hijacked redirect yields only ciphertext (D8); on release builds the verified https
callback reaches only our app (Phase 21 hosts the association files), and the dev-build
custom-scheme residual is 02 §8's documented risk (T36). The `jwe` parameter is at most
8,192 chars; for a 2 KB JWT the URL is about 3 KB. G13 records the callback length limits on
both platforms. If a platform caps below that, the fallback is 02's fragment form
(`HandoffQuery.mode = fragment`), which needs no new route.

`GET /v1/me` (W9) returns 02's `Me {email, role, user_slug, org{name,url}, limits{machines,
devices}, counts{machines, devices}, session_exp}`, where `session_exp` is the verified JWT
`exp`. Phase 15 schedules renewal from it, because an expired call is answered by Access,
not by the Worker (Evidence).

`GET /v1/meta` (W1, public override, 07) returns 02's `Meta` with
`Cache-Control: public, max-age=60`, before and after setup (D19): always `service`,
`protocol{min,max}`, `setup` (`open|closed`), `worker{version}` and any `deprecations`; once
`setup = closed` also `org{name,url}`, `access{team_domain}`, `capabilities[]` and
`push{enabled, vapid_public_key}`. It never reveals user, machine or settings detail beyond
those fields.

### Machines list and view model

`machine-view-model.ts` is the one place that merges a D1 machine row, 05's tunnel status
columns on that row (`cf_status`, `conns_active_at`, `conns_inactive_at`, `cf_status_at`)
and `last_seen_at`. It produces 02's `MachineSummary`:

```text
{ id, name, hostname, url,
  status: online|degraded|offline|never_connected|provisioning|tearing_down|unknown,
  status_checked_at, last_seen_at, reported_protocol, paired_at, yaran_version }
```

The lifecycle comes first: row `provisioning` or `awaiting_claim` → `provisioning`;
`revoking` → `tearing_down`; `failed` → `unknown` (admins see the detail in
`AdminMachine.provisioning`); `revoked` rows are never listed. For `active` rows the tunnel
health decides: `online` = `healthy`; `degraded` = `degraded`; `offline` = `down`, or
`inactive` with `conns_inactive_at` set; `never_connected` = `inactive` with both
timestamps null; no observation yet → `unknown`. `paired_at` is `claimed_at`. The mapping is
an exhaustive `switch` with `assertNever`. The user API, both consoles (07) and the admin
API (`AdminMachine`, which adds `key_fingerprint` via `machineKeyFingerprint`,
`origin_port`, `owner_email` and operator fields) reuse this module.

`GET /v1/me/machines` (W10) returns `Page<MachineSummary>` (`limit`, `cursor`) of the
caller's machines only. `DELETE /v1/me/machines/{id}` (W11) checks ownership (404 for
another user's id, never 403, so ids can't be probed, T34), calls `startTeardown(ctx, id,
"user_unpair")` and answers `202 TeardownStarted {machine_id, state:"tearing_down"}`.

### Device registry

`POST /v1/me/devices` (W12) upserts on `(user_id, install_id)` and answers the full 02
`Device` (`201` on create, `200` on update). The body is 02's `DeviceRegistration`:
`install_id, device_key, platform (android|ios), flavor (foss|play|appstore|dev), form_factor
(phone|tablet), app_version, label, locale?, push ({kind:"none"} or {kind:"webpush",
channel (unifiedpush|fcm_embedded|apns_relay|fcm_relay), distributor?, endpoint,
keys{p256dh, auth}}), mute_all, muted_until, muted_machine_ids`. The request header
`Yaran-Install-Id` must equal `install_id` (`bad_request` otherwise).

Validation is security-relevant. The endpoint is a URL the Worker will later `fetch`
(08), so it is an SSRF and abuse surface (T57):

- **endpoint** (refusal `push_endpoint_invalid` unless noted):
  - `https:` only, port 443 or none, no userinfo, length ≤ 2048 (02's limit).
  - No IP literals, no `localhost`, and no `*.internal`, `*.local` or `*.arpa` hosts.
  - The host must not be the control-plane hostname, any `*.<zone>` machine hostname, or
    `*.workers.dev`.
  - Relay channels (`apns_relay`, `fcm_relay`): refused with `409 push_relay_disallowed`
    and `details.reason: disabled` when `Settings.push.relay_allowed` is off, and with
    `details.reason: not_allowlisted` when `Settings.push.allowed_relays` is non-empty and
    the endpoint's origin is not in it.
  - `kind: none` carries no other push field (the schema enforces it).
- **device_key** (D24, 02 §8.1): 02 `P256Point` on P-256 (`validation_failed` otherwise).
  The Worker stores it and `device_key_fingerprint = deviceKeyFingerprint(device_key)`;
  the response's `Device.device_key_fingerprint` carries the fingerprint and never the key.
  It is fixed for an `install_id`: an upsert naming a different key is `409 conflict`.
- **keys.p256dh**: 02 `P256Point` (65-byte uncompressed point) that imports as ECDH P-256.
- **keys.auth**: base64url of exactly 16 bytes (22 chars).
- **label**: 1–64 chars, sanitized. **app_version**: 02 `SemVer`.
- **mutes**: `muted_machine_ids` ≤ 100 unique `Uuid`s; ids the caller does not own are
  refused (`validation_failed`), so a mute list cannot probe other users' machines (T34).
- The Worker also enforces the device cap (`Settings.device_cap_per_user`, default 10):
  `409 device_cap_reached` with `details.limit`, audit `device.cap_refused`.

On write, the Worker records `push.vapid_public_key` as the org's current
`Meta.push.vapid_public_key` and sets `push_state` to `active` (or `none` for
`kind: none`). Re-registration on an endpoint change sends the same `install_id` and
replaces the push fields; it also returns a `gone` or `auth_failed` device to `active`.
Audit `device.registered` / `device.updated`. The endpoint and `auth` are stored sealed with
04's `DATA_KEY` helper (T55). `GET /v1/me/devices` (W13) returns `Page<Device>` with label,
platform, flavor, form factor, push kind and channel, `endpoint_host`, `last_success_at`,
`last_error_code`, `vapid_public_key`, `push_state`, mutes, app version, created and last
seen, and `current` (true for the caller's own `Yaran-Install-Id`); never endpoints or keys,
and never revoked devices.

**Mutes** (`PATCH /v1/me/devices/{id}`, W31): body 02 `DevicePatch {label?, mute_all?,
muted_until?, muted_machine_ids?}` (at least one field; `muted_machine_ids` replaces the
list, validated as above). Ownership is checked (404 for another user's id, T34); answers
the updated `Device`; audit `device.updated`. A per-org mute is `mute_all` (indefinite) or
`muted_until` (timed); a per-machine mute is an entry in `muted_machine_ids`. Phase 08
enforces them at send time with 02's rule.

**Delivery health** (R11). `devices-repo.ts` exposes `setPushOutcome(deviceId, outcome)`,
which Phase 08 calls with 02 §9's outcomes: a push service `404`/`410` (including the
relay's `push_endpoint_gone`) clears the subscription fields, sets `push_state = gone` and
**keeps the row**; `401`/`403` sets `auth_failed`; five exhausted retries set `failing`; a
`2xx` sets `active`. A push answer never deletes or revokes a device; only W14/W24 revoke
and only a user deletion (W19) removes the row. The app sees `gone` or `auth_failed` on its
next `GET /v1/me/devices` and re-registers (16); the consoles say "push stopped: the
subscription expired" for `gone` (07).

`last_seen_at` updates at most hourly. The update happens on the device's own
authenticated calls, identified by the `Yaran-Install-Id` header the native org API client
sends on every Worker call once registered (02 §2, D22).

**Revocation, stated honestly.** `DELETE /v1/me/devices/{id}` (W14), also reached by the
admin route W24:

1. Clears the push subscription right away, so no more notifications reach the phone.
2. Sets `revoked_at` (internal; revoked devices leave every list). Any request carrying
   that `Yaran-Install-Id` then gets `403 device_revoked`, which is what makes an honest
   app wipe its org data and say "This phone was removed from <org>". The row keeps its
   `device_key_fingerprint`, so from that moment the W16 skip rule 5 refuses remembered
   consent for that device key (02 §8.1), whether or not the app honours `device_revoked`.
3. With `?sign_out_everywhere=1`, it also revokes every Access session of that email
   through `revokeUserSessions` (work item 9, endpoint
   `POST /accounts/{id}/access/organizations/revoke_user`; **UNVERIFIED** shape, verified
   in work item 9's live test); audit `sessions.revoked`.

A stolen phone that drops the header keeps a valid Access JWT until the policy session
expires. Access offers no per-device session revocation. The UI says so next to the
checkbox and the threat model records it (T45, T37). Fallback if `revoke_user` fails: the
refusal names the dashboard path (Zero Trust → Users → the person → Revoke sessions).

### Phone QR payload

`qr.ts` exports `phoneQrPayload(orgUrl)`, which returns `yaranapp://add-org?u=<encodeURIComponent(orgUrl)>`
exactly per 02 §10 (`u` matches `OrgUrl`, total ≤ 512 chars) and is pinned by
`cloud/protocol/fixtures/uri/add-org.json`, which the Rust (09) and web (13) renderers also
read. The app treats a scanned payload as untrusted input (T42). It also exports `phoneQrSvg(orgUrl)`, which uses `uqr.renderSVG` with error-correction
level M. The output passes a test asserting it contains no `style=` attribute and no
`<script`, so it fits 07's CSP (`style-src 'self'`). The org URL is the canonical
`https://<control-plane-host>` from settings, never the request's Host.

### D1 columns this phase requires

04 owns the baseline migration and its column names; this phase owns the semantics of
`pair_requests` and `devices` registration (04 says so on those tables). It checks the
baseline for these columns and appends an idempotent migration
(`cloud/worker/migrations/0006_pairing.sql`) only for any that are missing:

- `pair_requests(id, user_id, state_hash, code_hash UNIQUE, code_challenge,
  machine_public_key, machine_name, callback_port, origin_port, yaran_version, machine_id,
  replaces_machine_id, csrf_hash, status ∈ {pending, confirmed, claimed, expired,
  cancelled}, created_at, expires_at, code_expires_at, claimed_at)`
- `machines(…, public_key, status, origin_port, last_seen_at, reported_protocol,
  yaran_version, replaced_by)` (status values are 04's: `provisioning`, `awaiting_claim`,
  `active`, `revoking`, `revoked`, `failed`)
- `devices(id, user_id, install_id, platform, flavor ∈ {foss, play, appstore, dev},
  form_factor, locale, push_kind ∈ {none, unifiedpush, fcm_embedded, apns_relay,
  fcm_relay}, distributor, endpoint_enc, p256dh, auth_enc, push_vapid_public_key,
  push_state ∈ {active, gone, auth_failed, failing, none}, push_last_success_at,
  push_last_error_code, mute_all, muted_until, muted_machine_ids (JSON), app_version, label,
  device_key, device_key_fingerprint, created_at, last_seen_at, revoked_at, revoked_by)` with
  `UNIQUE(user_id, install_id)` and 04's `devices_revoked_by_key` index (D24).
  `push_kind` holds the channel, or `none`, and maps to `Device.push.kind`/`channel` at
  the API boundary.
- `handoff_csrf(token_hash PRIMARY KEY, state_hash, pk_thumbprint, dk_fingerprint,
  verified, user_id, expires_at, used_at)`, swept with expired pair requests
  (`dk_fingerprint` and `verified` are D24's binding).

### Audit events (actions from `cloud/protocol/registry/audit-actions.json`)

`pair.requested`, `pair.approved`, `pair.denied`, `pair.refused` (reason: cap, disabled,
policy, quota, invalid), `pair.expired`, `pair.provision_failed`, `machine.claimed`,
`machine.replaced`, `machine.rotated`, `machine.origin_changed`, `machine.unpaired` (actor:
machine | user | admin), `handoff.issued`, `handoff.declined`, `device.registered`,
`device.updated`, `device.revoked` (actor, sign_out_everywhere), `device.cap_refused`,
`sessions.revoked`. 04's catalogue is generated from the registry, so no action is
declared here. Detail fields never include tokens, JWTs, codes, endpoints or keys. A test
walks every route and asserts on that.

## Work items

Every file below starts with the 00-CONVENTIONS §2 header and has its `<module-headers>`
block generated by Phase 01's tool. Each is planned at ≤ 500 lines (estimates in
parentheses). Tests run under `@cloudflare/vitest-pool-workers` (04's harness) with 05's
recorded Cloudflare fixtures and 02's protocol fixtures.

1. **Request validators** (pure, no I/O).
   - Create `cloud/worker/src/pairing/authorize-params.ts` (~170): callback, state,
     challenge, pubkey, `MachineName`, origin port, version.
   - Create `cloud/worker/src/sessions/handoff-params.ts` (~140): `v`, `P256Point` with the
     on-curve check, state, `build` plus `redirect` through 02's `redirectAllowed` over
     `APP_CALLBACK_URLS`, `mode`, `device`, `dk`/`dts`/`dsig` form and freshness through 02's
     `src/sig/device.ts` (D24), and the `HandoffConsent` extras (`dk`, `csrf`, `decision`).
   - Create `cloud/worker/src/devices/device-params.ts` (~200): the endpoint SSRF rules,
     key checks and label.
   - Reuse 02's generated types and validators. Nothing is re-declared.
   - Tests:
     - `test/pairing/authorize-params.test.ts` and `test/devices/device-params.test.ts`:
       accept/refuse tables, including `localhost`, `[::1]`, `127.0.0.1:80`, uppercase
       scheme, userinfo, IDN hosts, 1025-byte URL and off-curve point.
     - `test/sessions/handoff-params.test.ts` reads `cloud/protocol/fixtures/uri/handoff-redirect.json`:
       the configured https callback is accepted for `release`, `yaranapp://auth/callback`
       only for `build=dev`; a `release` request naming the custom scheme, a `dev` request
       naming https, a trailing slash, a different case and an extra query are refused;
       off-curve and 64-byte points, a 21-char state and a bidi character in `device` are
       refused.
     - D24, the same file reads `cloud/protocol/fixtures/sig/handoff-device-signature.json`:
       a compressed or off-curve `dk` is `handoff_device_key_invalid`; a DER `dsig`, 85 and
       87 chars, `r = 0` and `s = n`, a signed or zero-led `dts`, and each field missing are
       `handoff_signature_malformed`; `dts` at ±300 s passes and ±301 s is
       `handoff_timestamp_skewed` with `server_time` (injected clock).

2. **PKCE and code primitives**: create `cloud/worker/src/pairing/pkce.ts` (~70) with
   S256 verification by constant-time compare, code generation and `sha256` hashing.
   Tests use RFC 7636 Appendix B vectors and 02 fixtures.

3. **Pair-request repository and sweep.**
   - Create `cloud/worker/src/pairing/pair-requests.ts` (~200): create (`pending`),
     approve (`confirmed`, code issued), deny (`cancelled`), conditional claim transition,
     expire, and find by code hash.
   - Create `cloud/worker/src/pairing/sweep.ts` (~90): registered with the scheduled
     dispatcher (04/05) on the existing one-minute cron, so no new cron slot is used.
   - Create the migration `cloud/worker/migrations/0006_pairing.sql`, only if needed (see
     Design).
   - Tests: two concurrent claims result in one winner; a code older than 120 s and a pair
     request older than 10 minutes are refused (injected clock); the sweep tears down
     `awaiting_claim` machines through a 05 mock, purges expired `handoff_csrf` rows and
     audits `pair.expired`.

4. **Authorize route and confirm page.**
   - Create `cloud/worker/src/pairing/authorize-route.ts` (~260) for GET/POST (W2/W3),
     orchestration, Approve/Deny, the replace/new-name branch, the pairing-policy check,
     and the 302 to the callback (with `error=` for refusals once the callback is valid).
   - Create `cloud/worker/src/pairing/authorize-page.tsx` (~200) for the confirm, error
     and quota pages, built from 07's UI kit:
     - Machine and email render as chips.
     - The fingerprint is `machineKeyFingerprint(machine_pubkey)` in a mono chip; the test
       reads `fixtures/sig/fingerprint.json` and asserts the rendered string.
     - The primary action has explicit focus.
     - Error text is sanitized and actionable, for example "This org has used 500 of 500
       Access applications. Ask an admin to remove unused machines".
   - Reuse 04 `requireUser`, `rateLimit("pair", email)`, 05
     `deriveHostname`/`startProvision`, and 07's CSRF middleware on POST.
   - Tests:
     - Authz matrix: no JWT, service-token JWT, disabled user, other AUD.
     - Pairing policy: an allowlisted email and domain pass; others get
       `pairing_not_allowed`.
     - Cap reached (`machine_cap_reached`); same-name branch; Deny redirects with
       `error=pair_denied`.
     - The provisioning failure renders a retry that reuses the same machine id
       (idempotency).
     - The 302 `Location` is exactly the validated callback.
     - `replace_machine_id` naming the caller's same-name machine replaces it; another
       user's machine, a different name, or the field with `decision=deny` is
       `pair_request_invalid`.
     - The confirm page carries `Referrer-Policy: same-origin` and `form-action 'self'
       http://127.0.0.1:<port>` for the validated callback port.
     - An HTML snapshot test checks the accessibility attributes (labels, focus, `lang`).

5. **Machine API.**
   - Create `cloud/worker/src/machine-api/claim.ts` (~200),
     `cloud/worker/src/machine-api/config.ts` (~120),
     `cloud/worker/src/machine-api/rotate.ts` (~90),
     `cloud/worker/src/machine-api/unpair.ts` (~90) for `POST /v1/machine/unpair`, and
     `cloud/worker/src/machine-api/origin.ts` (~90) for `PUT /v1/machine/origin`.
   - Reuse 04 `verifyMachineRequest` and `requireMachine`, and 05 `rotateTunnelSecret`,
     `fetchTunnelToken`, `startTeardown` and `setOriginPort`.
   - Tests:
     - The claim succeeds only with a correct signature, verifier and nonce.
     - Replayed nonces (`nonce_replayed`), a skewed timestamp (`signature_expired`), a wrong
       key (`signature_invalid`), a reused code and an expired code (`pair_code_invalid`)
       and a wrong verifier (`pkce_mismatch`) are each refused with that 02 code.
     - The claim response validates against 02's `ClaimResponse` schema; a claim whose
       `origin_port` differs from authorize calls `setOriginPort` before answering.
     - The replace flow tears down the old machine after the claim, not before.
     - `config` on a revoked machine returns `410 machine_revoked` and validates against
       `MachineConfig`.
     - Unpair answers `202 TeardownStarted`, then `410 machine_revoked` on repeat.
     - Origin: same port → `changed:false` with no 05 call; new port → `changed:true`,
       `setOriginPort` called, `machine.origin_changed` audited; port 0 →
       `origin_port_invalid`.
     - Integration: a full authorize→claim round trip against Miniflare with 05 mocked,
       driven by a fixture "machine" that uses 02's TS signing codec. The same
       canonical-string vectors drive the Rust tests in Phase 09.

6. **Handoff, `/v1/me` and `/v1/meta`.**
   - Create `cloud/worker/src/sessions/handoff-route.ts` (~200, GET and POST),
     `cloud/worker/src/sessions/handoff-page.tsx` (~150, consent and error pages from 07's
     kit), `cloud/worker/src/sessions/handoff-csrf.ts` (~90, mint, bind, consume),
     `cloud/worker/src/sessions/handoff-remembered.ts` (~120, D24: signature verdict,
     cookie read and issue, the revoked-key lookup, and the call to 02's
     `decideRemembered`),
     `cloud/worker/src/me/me-route.ts` (~80) and `cloud/worker/src/routes/meta.ts` (~90).
   - Reuse 02 `sealHandoff`, `redirectAllowed`, the UA token parser, `src/sig/device.ts`
     and `src/consent.ts`, 04 `requireUser` and `macKey("handoff_consent")`, and 07
     `settings.read()`.
   - Tests:
     - A round trip: the test generates a P-256 key, GETs the consent page with a fixture
       JWT, POSTs Continue with the minted `csrf`, and opens the JWE from the `303` with 02's
       TS `openHandoff`; the plaintext must be a valid `HandoffPayload` with
       `kind: control_plane`, the input JWT and its `exp`, and no `aud` or `state`.
     - The consent page names the device, platform, host and email as chips, focuses
       Continue, carries the dev warning only for `build=dev`, and passes 07's CSP test.
     - Cancel answers `303 …&error=handoff_declined` and audits `handoff.declined`.
     - A reused, expired or differently bound `csrf`, and a cross-origin POST, are refused.
     - `cookie` is present only when the request carried `CF_Authorization`.
     - A bad redirect, a `release` request naming `yaranapp://auth/callback` and a bad
       point are each `400 handoff_request_invalid` with no `Location`; a missing JWT is
       refused.
     - `mode=fragment` puts `state` and `jwe` after `#`.
     - Headers include `no-store`, `Pragma: no-cache`, `no-referrer` and `nosniff` on the
       303.
     - The consent page carries `Referrer-Policy: same-origin`, `frame-ancestors 'none'` and
       a `form-action` of exactly `'self'` plus the redirect's origin (`yaranapp:` for
       `build=dev`); a Continue POST sent with the page's own Origin passes while
       `Origin: null` is refused (`origin_mismatch`), which pins why `no-referrer` must not
       be used on the page.
     - The platform chip reads Android or iOS from a Chrome-on-Android and a Safari-on-iOS
       browser UA, and is omitted for an unrecognised UA.
     - D24 remembered consent (`test/sessions/handoff-remembered.test.ts`; the test holds a
       device key, signs each GET with 02's canonical string, and injects the clock):
       - First handoff: no cookie → consent page; Continue answers `303` with exactly 02's
         `Set-Cookie` line (attributes, `Path=/v1/handoff`, no `Domain`) and audits
         `consent: "explicit"`. Cancel sets no cookie and does not clear an existing one.
       - Second handoff with that cookie and a fresh signature from the same key → no page,
         `302` with a JWE that opens, no new `Set-Cookie`, audit `consent: "remembered"`.
       - A foreign app's signature (another key's `dsig` over the same `dk`), or a
         signature over another host, `pk`, `state` or `dts`, sent with a valid cookie →
         consent page, `verified = false`, and its Continue sets no cookie.
       - Revoked device: revoke the device (W14, and W24 through 07's route) whose
         `device_key_fingerprint` is the cookie's → consent page, with cookie and signature
         both valid; an unrevoked row for another user with the same key does not skip either.
       - A cookie for another fingerprint (the device key changed) → consent page, and its
         Continue replaces the cookie.
       - Stale `dts` (±301 s) → `302 …&error=handoff_timestamp_skewed&server_time=…`, even
         with a valid cookie.
       - Malformed `dk` or `dsig` → `handoff_device_key_invalid` /
         `handoff_signature_malformed` (redirect when `redirect` and `state` are valid,
         `400` envelope otherwise), even with a valid cookie.
       - The cookie is ignored (consent page, no error, not cleared) when its MAC is
         tampered, its `kv` is stale (after a `DATA_KEY` rotation through 04's
         `data_key_state`), its `iat` is beyond `now + 300` or before `now − 34560000`, or it
         violates the five-part form: each row of `fixtures/handoff/consent-cookie.json`.
       - Every row of `fixtures/handoff/remembered-consent.json` with `side: worker` gives its
         expected answer and cookie behaviour, `build=dev` included (remembered there too).
       - A POST whose `dk` differs from the csrf's binding is `handoff_request_invalid`; a
         POST carrying `dts`/`dsig` gains nothing (the GET's verdict decides).
     - The `/v1/meta` shape is validated against the 02 schema in both setup states, and
       the response leaks no settings beyond the documented fields. `/v1/me` validates
       against `Me`.

7. **Machines view model and user machine routes.**
   - Create `cloud/worker/src/machines/machine-view-model.ts` (~150) and
     `cloud/worker/src/me/machines-route.ts` (~150).
   - Tests: exhaustive state mapping (one row per lifecycle status × tunnel status ×
     timestamp combination) against 02's `MachineSummary.status`; ownership 404; the delete
     answers `202 TeardownStarted` with `state: tearing_down` and audits `machine.unpaired`.

8. **Device registry.**
   - Create `cloud/worker/src/devices/devices-repo.ts` (~200) and
     `cloud/worker/src/me/devices-route.ts` (~200).
     The route module covers W12, W13, W14 and W31.
   - Tests:
     - Upsert by `install_id`, a header/body `install_id` mismatch is refused, and the cap
       is enforced (`device_cap_reached`).
     - D24: `device_key` is stored with its fingerprint matching
       `fixtures/sig/device-fingerprint.json`; the response carries
       `device_key_fingerprint` and never the key; an off-curve `device_key` is
       `validation_failed`; an upsert with a different key for the same `install_id` is
       `409 conflict` and changes nothing.
     - Relay channels: `push_relay_disallowed` with `reason: disabled` and
       `reason: not_allowlisted`.
     - Responses validate against 02's `Device`; the list never contains endpoints or keys
       or revoked devices, and marks `current`.
     - `PATCH` with each `DevicePatch` field, an empty body refused, another user's id → 404,
       a foreign machine id in `muted_machine_ids` refused.
     - `setPushOutcome`: `404`/`410` clears the subscription, sets `gone`, keeps the row;
       `401`/`403` sets `auth_failed`; re-registration restores `active`.
     - Revoke clears the push fields, and a later request with that `Yaran-Install-Id`
       gets `403 device_revoked`; the revoked row keeps `device_key_fingerprint`.
     - `sign_out_everywhere` calls `revokeUserSessions` and audits `sessions.revoked`.
     - `last_seen_at` throttling is checked with an injected clock.

9. **Session revocation.**
   - Create `cloud/worker/src/cloudflare/access-sessions.ts` (~60), one endpoint module
     beside 05's (`revokeUserSessions(email)` over 05's client, budget and retries), and
     `cloud/worker/src/sessions/revoke-sessions.ts` (~80), a thin service with the
     dashboard-path fallback message. 07's disable-and-revoke reuses the service.
   - Tests: unit tests with a recorded fixture. Add a live check to Phase 03's tooling
     (`tools/cloud-gates/`, procedure appended under G10's org fixture) that verifies the
     `revoke_user` request shape and records evidence; until it passes, the endpoint stays
     UNVERIFIED in the PR.

10. **QR payload.**
    - Create `cloud/worker/src/pairing/qr.ts` (~70) and add the dependency `uqr@0.1.3`
      (exact pin) to `cloud/worker/package.json`.
    - Tests: the payload matches `cloud/protocol/fixtures/uri/add-org.json`; the SVG contains no
      `style=` or `<script`; it decodes back to the payload in a test that uses a JS
      decoder dev-dependency, the same decoder Phase 14 ships (D13).

11. **Audit coverage test.** Create `cloud/worker/test/pairing/audit-coverage.test.ts`.
    It drives every route in this phase and asserts that each state change wrote exactly
    the listed event, with no secret material in any `detail` (a regex sweep for JWT,
    base64url ≥ 40 chars and `https://` endpoints).

12. **Route registration.** Touch `cloud/worker/src/router.ts` (04's root). Wiring only:
    one `mount` call per module.

## Acceptance

- [ ] `GET /v1/pair/authorize` renders the confirm page only for a valid, non-service,
      non-disabled control-plane JWT, and refuses every malformed parameter with the 02
      error code.
- [ ] Authorize → claim round trip returns a schema-valid `ClaimResponse` (tunnel
      credentials, hostname, origin port, team domain, AUD, `owner_email`, `user_slug`, org,
      machine id). The confirm page shows the 02 §7.1 fingerprint. The code is single use,
      expires 120 s after issue (the pair request after 10 minutes), and only its hash is
      stored. Deny redirects with `pair_denied`.
- [ ] A claim with a wrong signature, wrong verifier, replayed nonce or skewed clock is
      refused. Concurrent claims of one code yield exactly one success.
- [ ] Re-pairing the same name offers Replace and Pair-as-new. The replaced machine is torn
      down only after the new claim succeeds.
- [ ] Per-user machine cap and device cap are enforced at both check points.
- [ ] Abandoned pairings expire and their `awaiting_claim` machines are torn down by the
      sweep.
- [ ] `GET /v1/machine/config` on a revoked machine returns `410 machine_revoked`.
      Rotate, `POST /v1/machine/unpair` (202, then 410) and `PUT /v1/machine/origin` work
      and are audited; no route exists at the bare `/v1/machine`.
- [ ] `GET /v1/handoff` accepts only the configured https callback (release) or
      `yaranapp://auth/callback` with `build=dev`, and renders the consent interstitial
      naming device and host; `POST /v1/handoff` with Continue answers `303` to that exact
      callback with a JWE (ECDH-ES Concat KDF, A256GCM) that 02's opener decrypts to a
      valid `HandoffPayload`, and with Cancel answers `error=handoff_declined`. Responses
      are `no-store` and `no-referrer`.
- [ ] D24: `GET /v1/handoff` requires `dk`, `dts`, `dsig` and answers the three §8.1 codes
      for malformed or stale ones; the consent page is skipped only when the consent cookie,
      the device signature, freshness and the not-revoked check all pass, and every
      `side: worker` row of `fixtures/handoff/remembered-consent.json` holds; a foreign
      app's signature, a revoked device, or a cookie for another fingerprint meets the page.
- [ ] D24: the consent cookie is set only by an explicit Continue whose GET verified the
      signature, byte for byte as `fixtures/handoff/consent-cookie.json`, MACed with 04's
      `handoff_consent` key at the current `kv`; `DATA_KEY` rotation or device revocation
      ends its skips.
- [ ] D24: device registration stores `device_key` and `device_key_fingerprint`, refuses a
      changed key for an `install_id` with `409 conflict`, and never echoes the key.
- [ ] `GET /v1/me` exposes `session_exp`. `GET /v1/meta` matches the 02 schema and leaks
      nothing else.
- [ ] The machines list comes only from D1 plus the 05 cache (asserted: zero Cloudflare API
      calls per list request), and the state mapping is exhaustive.
- [ ] Device registration refuses every SSRF-class endpoint in the test table and enforces
      the relay rules. Lists never expose endpoints or keys and carry `push_state`. Mutes
      are set through `PATCH /v1/me/devices/{id}`. A push `404`/`410` marks the device
      `gone` with the row kept. Revocation stops push immediately and makes the app receive
      `device_revoked`.
- [ ] QR payload matches the shared 02 fixture. The SVG is CSP-clean and decodes back to
      the payload.
- [ ] Every state change writes its audit event, and no audit detail contains secret
      material.
- [ ] All new files are ≤ 500 lines with generated headers. `module-headers --check`
      passes.

## Validation

```bash
cd cloud/worker
npm ci
npm run typecheck                        # tsc --noEmit, strict
npm test -- test/pairing test/sessions test/devices test/me test/machine-api
npm test                                 # full Worker suite stays green
cd ../.. && node tools/module-headers/bin/module-headers.mjs --check cloud/worker
node tools/module-headers/bin/module-headers.mjs --lines --check cloud/worker
# live (Phase 03 org fixture, maintainer credentials):
tools/cloud-gates/run.sh revoke-user-sessions
```

## Risks

| Risk | Mitigation |
|---|---|
| A machine route outside `/v1/machine/*` would sit behind Access and break signed calls (the bare `/v1/machine` is not covered: no subpath matching) | Resolved by R8: unpair is `POST /v1/machine/unpair` and every machine route matches `^/v1/machine/[a-z]+$` (02 §5), so the single override covers all of them. A router test asserts every SIG route matches that pattern; G8 probes `/v1/machine/unpair` and `/v1/machine/origin`; 07's Health page checks the override |
| Access JWT for the control plane can't be revoked per phone | Revoking a device stops push and makes the honest app wipe itself. The optional sign-out-everywhere calls Access `revoke_user`. The residual window (session duration) is shown in the UI and recorded in the threat model (T45) |
| `revoke_user` request shape UNVERIFIED | Work item 9's live check. Until it passes, the fallback message names the dashboard path |
| Callback URL too long for a ~3 KB JWE on some platform (https App Link / Universal Link, or the dev custom scheme) | G13 measures it. The fragment mode (`HandoffQuery.mode = fragment`) is already specified and needs no new route |
| The consent tap on every handoff (renewals included) adds friction | Resolved by D24: consent is remembered per device key in a MACed host-only cookie set only by an explicit Continue, and a renewal skips the page only with a verifying device signature from a non-revoked device, so D8/R2's guard against a silent SSO auto-approve still holds for any other app or flow. The first handoff, any failed check, a `DATA_KEY` rotation and once per 400 days still cost one tap, Continue focused |
| The consent cookie does not persist between system-browser sessions (02 UNVERIFIED-5) | Every handoff then shows the page, which is the pre-D24 behaviour; no Worker change. Phase 19 records whether a second handoff skips |
| `APP_CALLBACK_URLS` misconfigured in a fork (no https entry) | Release-build requests are refused with `handoff_request_invalid` and the error page says which variable to set (07's deploy template documents it inline) |
| Provisioning at authorize spends Cloudflare API budget for pairings that are never claimed | Per-user `pair` rate limit; the 10-minute TTL sweep tears them down; 05's budget guard refuses before the 1,200/5 min limit |
| Device push endpoint as SSRF vector (T57) | Validation table plus `global_fetch_strictly_public` (04). 08 revalidates before each send |
| 02 lacked `install_id`, the fingerprint format, or the fragment mode | Resolved: 02 now defines `InstallId`/`Yaran-Install-Id` (§2), `MachineKeyFingerprint` (§7.1) and `HandoffQuery.mode` (§8). This phase uses them and declares nothing locally (one home per concept). W3's `replace_machine_id` is now 02's `PairConsent` field |
| 07's UI kit not yet landed when this phase starts | The pages depend only on the kit's public components. Until it merges, a stub kit in `test/` renders the same props, and the snapshot tests are re-recorded once against the real kit |

## References

- `00-README.md` D1, D3, D6, D7, D8, D9, D11, D16, D19, D21, D22, D24, flows 2–4 and 6
- `02-protocol-contract.md` §2 (types, headers), §4 (codes), §5 (W1–W16b, W31, W32), §6,
  §7 and §7.1 (signing, fingerprint), §8 (allowlist, consent, JWE), §8.1 (device key,
  signature, remembered consent), §9 (delivery outcomes), §10 (URIs); 04 §7 (`handoff_consent`
  purpose, `data_key_state`); `03-platform-verification-gates.md` G1, G8, G13; threat IDs T28, T34, T35,
  T36, T37, T42, T45, T49, T54, T55, T57 (`17-docs-website-threat-model.md`)
- `00-CONVENTIONS.md` §1–§5
- `research/cloudflare-parts/02-access.md` §1, §5, §6; `03-jwt-native.md` Part A and
  the native-auth sections; `04-token-deploy.md` §3; `R4-cloudflare.md` §1.1, §1.5;
  `R5-mobile.md` §2; `R1-server-core-cli.md` §6
- RFC 7636 (PKCE), RFC 8252 §7.3 (loopback redirect), RFC 7516/7518 (JWE, ECDH-ES)
- Cloudflare API reference, tunnels list, Access apps create, checked 2026-11-14 (URLs in
  Evidence)
- `uqr`: https://github.com/unjs/uqr (MIT), checked 2026-11-14

## Reconciliation notes (2026-11-14)

- Header: Depends on now names gates G1, G8, G13 (R20); wave placement unchanged (Wave B).
- R8: unpair is `POST /v1/machine/unpair` (W8, `202 TeardownStarted`, repeat `410`); Evidence consequence, machine API, work item 5, acceptance and the first Risks row rewritten; the second `/v1/machine` override and `/v1/machine/self` alternative removed.
- R9: `PUT /v1/machine/origin` (W32) added to the machine API, work item 5 and acceptance; `origin_port` added to authorize validation, claim and D1 columns.
- R9: claim answer is 02's `ClaimResponse` (`tunnel{id,token,token_version}`, `access{team_domain,aud}`, `owner_email`, `user_slug`, `org{name,url}`); config is `MachineConfig`; `token_version` mapped from 05's `tunnel_secret_generation`.
- R9: confirm page shows 02 §7.1 `MachineKeyFingerprint` via `machineKeyFingerprint`, pinned by `fixtures/sig/fingerprint.json`; "if 02 doesn't define it" text removed.
- R9: `Yaran-Device-Id` → `Yaran-Install-Id`; device body is `DeviceRegistration` (form factor, `webpush` channels incl. `fcm_relay`, `dev` flavor, mutes); response is the full `Device`; `push_state`, `PATCH /v1/me/devices/{id}` (W31, `DevicePatch`) mute API added.
- R9: handoff plaintext is `HandoffPayload {v, kind, host, jwt, email, exp, iat, cookie?}` (no `aud`/`state`); optional `cookie` filled from `CF_Authorization` (G1 L1).
- R2: redirect allowlist via 02 `redirectAllowed` over `APP_CALLBACK_URLS` (https callback on `<publisher-domain>` for release; `yaranapp://auth/callback` only with `build=dev`); GET renders the one-tap consent interstitial (device, platform, host, email; dev warning); POST (W16b, `HandoffConsent` + `csrf`) seals and answers `303`; Cancel → `handoff_declined`; new `handoff-page.tsx`, `handoff-csrf.ts`, `handoff_csrf` table, tests and acceptance.
- R1: envelope wording is JWE ECDH-ES with the RFC 7518 Concat KDF + A256GCM via 02 `sealHandoff` (no HKDF anywhere in this file); `sealJwe`/JWK `pk` replaced by `P256Point`; `state` 22–128.
- R11: `setPushOutcome` in the devices repo: 404/410 clears the subscription, marks `gone`, keeps the row; 401/403 `auth_failed`; re-registration restores `active`.
- Canonical names: `Me`, `Meta` (nested `org`, `access`, `worker`, `push.vapid_public_key`; served before setup, D19), `MachineSummary.status` (`provisioning`, `tearing_down`, `unknown`; field `status`, `paired_at`), `TeardownStarted`, `Page<>`, `MachineName`, wire code `account_quota_reached`, `push_relay_disallowed` with `details.reason`, endpoint cap 2048.
- Pairing aligned to 02/04: code lifetime 120 s (pair request 10 min), Deny → `pair_denied`, `pairing_policy` allowlist check → `pairing_not_allowed`, 04's `pair_requests`/`machines` status values and column names, `user_id` keys; every refusal names its 02 code.
- Audit actions renamed to the registry (`pair.approved`, `machine.claimed`, `handoff.issued`; added `pair.requested`, `pair.denied`, `machine.origin_changed`, `handoff.declined`); catalogue generated from `registry/audit-actions.json`.
- Seams renamed to 05's facade (`startProvision`, `startTeardown`, `rotateTunnelSecret`, `fetchTunnelToken`, `setOriginPort`, `deriveHostname`); `revokeUserSessions` lives in a new `src/cloudflare/access-sessions.ts` (05 has no such endpoint).
- Fixture path `qr-add-org.json` → `cloud/protocol/fixtures/uri/add-org.json`; handoff tests read `fixtures/uri/handoff-redirect.json`.
- R14: threat IDs added (T28, T34, T35, T36, T37, T42, T45, T49, T54, T55, T57); "(17)" placeholders replaced.
- Open item for 02: W3's form lacks the Replace/Pair-as choice; this phase documents `replace_machine_id` pending 02.

### Straggler pass (2026-11-14)

- W3: `replace_machine_id` is now 02's `PairConsent` field; the "pending 02" wording and the Risks row updated, validation rule and tests added (work item 4).
- W16 consent page: platform from the system browser UA plus `device`, not the §11 app token (02 §8, 11's finding); test added.
- W16 and W2 pages: `Referrer-Policy: same-origin` and `form-action` listing the redirect origin override 07's defaults (02 §8); tests added in work items 4 and 6.
- View model: `connections` dropped from `MachineSummary` (02: Cloudflare removed the field from the tunnel list).
- Validation: header tool invoked as 01 defines it (`node tools/module-headers/bin/module-headers.mjs --check cloud/worker`, `--lines --check`); `dist/cli.js` and `--max-lines` do not exist.
- D24: W16 takes `dk`, `dts`, `dsig` (02 §8.1): form and freshness checks after `pk` with codes `handoff_device_key_invalid`, `handoff_signature_malformed`, `handoff_timestamp_skewed`; signature verified after the JWT, a non-verifying one gets the consent page.
- D24: skip rule (cookie MAC at current `kv`, `fp24` = `dk` fingerprint, `verified`, fresh `dts`, no revoked row with that fingerprint); a skip seals and answers `302`, audit `consent: remembered`/`explicit`; new `handoff-remembered.ts`.
- D24: csrf bound to (`state`, `pk`, `dk`) plus the verdict (`handoff_csrf.dk_fingerprint`, `verified`); W16b re-sends only `dk`; Continue sets `__Secure-yaran-handoff-consent` (Path `/v1/handoff`) only when verified, with 04's `macKey("handoff_consent")`.
- D24: W12 stores `device_key` and `device_key_fingerprint`, a changed key is `409 conflict`; W14/W24 revocation keeps the fingerprint so rule 5 ends remembered consent at once.
- D24: work items 1, 6 and 8 gain tests (foreign signature, revoked device, other fingerprint, stale `dts`, malformed fields, cookie and decision-table fixtures); three acceptance items; the consent-tap risk row is resolved and a cookie-persistence row added.

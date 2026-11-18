# Phase 11 — yaran: tunnel ingress security, Access JWT verification, sealed handoff route

**Track:** B (yaran server) · **Parallel-safe with:** 04–10, 12–18
**Depends on:** 02 (contract: Y1/Y1b/Y2, `HandoffQuery`/`HandoffConsent`/`HandoffPayload`, redirect allowlist, the Rust sealer in `yaran_core::cloud::protocol`, `ring`/`base64` in yaran-core, error and refusal registries, close code 4401), 03 (gates G1, G2, G3, G12, G13), 09 (credentials store incl. `owner_email` and the D24 `handoff_consent_key` with its reader, `[cloud]` config section incl. `app_callback_urls`) · **Blocks:** 10 (needs the live host-rule seam defined here), 13 (consumes `Yaran-Refusal`, close code 4401, `/__yaran/signed-in`), 15 (consumes `/__yaran/handoff`), 19

## Goal

Make a yaran server reached through its Cloudflare tunnel hostname **fail closed** and
**owner-only**, independently of Cloudflare's own enforcement (D2, D3):

1. The tunnel hostname becomes a **live** Host-guard rule, set and cleared by the cloud leg at
   runtime, never a restart-bound `allowed_hosts` entry (D4).
2. Same-origin checks stop failing on harmless spelling differences (case, default ports)
   without accepting anything cross-origin they reject today.
3. Every HTTP request and WebSocket upgrade whose Host is the cloud hostname must carry a valid
   Cloudflare Access application JWT (RS256, team JWKS, `iss`, `aud`, `exp`, `nbf`) whose
   `email` is the paired owner. Service-token JWTs are rejected. If the signing keys cannot be
   fetched, the request is refused (503), never let through.
4. A WebSocket opened under a JWT closes when that JWT expires, so revoking a user takes effect
   within one token lifetime even for a shell that stays open.
5. `GET /__yaran/handoff` (Y1) shows a one-tap consent page naming the device and this host.
   Only its **Continue** form post (`POST /__yaran/handoff`, Y1b), or the remembered-consent skip
   below, seals the verified JWT to the
   phone's ephemeral P-256 key (D8) and redirects, and only to a callback Phase 02's allowlist
   accepts: a configured https callback for release builds, `yaranapp://auth/callback` only for
   a request that declares `build=dev`. Consent is remembered per device (D24, 02 §8.1): after
   an explicit Continue the route sets a MACed consent cookie, and a later GET that proves
   possession of the same device key skips the page. `GET /__yaran/signed-in` (Y2) gives
   browsers a way to sign in again without reloading the page (Phase 13).
6. A written decision on what "remote" may see (`/api/v1/config/raw`, bootstrap `[env]`).

Loopback, LAN and Tailscale Hosts behave exactly as today (D3).

## Evidence

All line numbers re-verified against the tree on 2026-11-14.

**Host guard** (`crates/yaran-web/src/host_guard.rs`, 535 lines, already over the ceiling):
- `HostAllowlist` struct is at `:129-144`. Its fields are `bound_ips`, `has_unspecified`,
  `configured` (pre-normalized) and `tailscale_literals`.
- Constructors: `new` at `:173-185` and `with_live_tailscale_literals(Arc<AtomicBool>)` at `:190-196`.
- `normalize_host_for_match` (`:78-91`) trims, strips the port with `strip_host_port`
  (`:55-73`, IPv6-aware), lowercases ASCII and drops one trailing dot.
- `allows_host` (`:202-237`): hostnames match only `configured.contains` (rule 4). IP literals
  go through the loopback, unspecified, bound-IP and Tailscale-range rules.
- `TailscaleLiterals::{Fixed(bool), Live(Arc<AtomicBool>)}` (`:152-164`) is read with SeqCst.
- The live cell is created at `lib.rs:489-493` (`yaran server`) and `lib.rs:1552-1556`
  (`ServeCore::start`, used by background mode and the flip). It is handed to
  `TailscaleModeControl::new` (`serve_legs.rs:727-741`). **Its only writer** is
  `lib.rs:1110` (`ModeStep::SetHostLiterals`). This is the pattern the cloud rule copies.
- The middleware is `host_allowlist_middleware(State<Arc<HostAllowlist>>, …)` at `:246-264`.
  It answers 403 with two distinct bodies. It is installed by `host_allowlist_layer`
  (`:271-287`) via `from_fn_with_state`. Tests are at `:290-535`.

**Router** (`crates/yaran-web/src/server.rs`, 6604 lines):
- `AppState` is at `:35-154` and `RouterParams` at `:249-366`. `with_host_allowlist` is at
  `:544` and `with_live_tailscale_host_literals` at `:579`.
- `build_app` (`:609-847`) maps params to state at `:710-772`. Routes are at `:776-814`, with
  the `static_handler` fallback at `:814`.
- Layers, innermost first: `rest_mutation_origin_check` at `:821`, `access_log` at `:830`,
  `.with_state` at `:831`, then the host guard at `:836-846`. The guard is attached **only when
  `bound_ips` or `configured_hosts` is non-empty**.
- `same_origin_allowed` (`:914-926`) compares the raw strings `origin_host(origin) == Host`.
  `origin_host` (`:941-953`) drops the scheme and cuts at `/?#`. Its callers are
  `rest_mutation_origin_check` (`:970-980`) and the six upgrade handlers' origin checks at
  `:1281, 1338, 1395, 1453, 1562` (PTY kinds) and `:2587` (events).
- The five PTY handlers funnel through `upgrade_pty_socket` (`:1234`), then
  `handle_pty_socket` (`:1664`), then `AttachedPtySocket` (`:1910`). Their single
  `tokio::select!` is at `:1938-1948`.
- Events: `handle_events_socket` (`:2641`), then `EventsSocketLoop` (`:2769`), whose `select!`
  is at `:2816-2827`. Its inputs are the `EventsLoopInput` enum (`:2788`).
- Handlers take `WebSocketUpgrade, State, ConnectInfo, HeaderMap`. **No request extension is
  used anywhere in yaran-web today.**
- The only custom close code is `PROVIDER_GONE_CLOSE_CODE = 4001` (`:1018`), mirrored at
  `web/src/lib/ptySocket.ts:41`.
- Existing tests: host guard at `:5847, 5900, 5940`; REST origin at `:5994, 6024, 6054`;
  WebSocket origin at `:6106-6144`.

**Other server facts:**
- `access_log` logs the path only and drops the query on purpose (`server.rs:874-898`, see
  `:888-892`). Requests the guard rejects are never logged.
- No rate limiter exists anywhere in yaran-web or yaran-core. The only semaphores are the
  socket and worker caps (`server.rs:86-102`).
- No-store is written inline at `build_routes.rs:69`.
- The SPA fallback answers any unknown path, `/__yaran/*` included, with 200 `index.html`
  (`web_assets.rs:189-207`). The new routes must therefore be registered explicitly.
- `GET /api/v1/config/raw` is `read_raw_config` (`config_routes.rs:415-420`). Bootstrap
  `global_env` is declared at `viewmodel.rs:196` and projected at `:1476`.
- `rest_mutation_origin_check` (`server.rs:970-980`) refuses every POST, PATCH, PUT and DELETE
  whose `Origin` fails `same_origin_allowed`, `Origin: null` included, with 403
  `cross-origin request rejected`. The consent post passes through it, so 02 §2's Origin rule
  for form posts is already enforced.
- `short_device_label` (`crates/yaran-core/src/device_label.rs:109`) turns a browser UA into
  "Chrome on Android"-style labels of at most `SHORT_LABEL_MAX_CHARS` (`:27`, 24).

**Browser facts for the consent page** (read 2026-11-14):
- Fetch standard, "append a request `Origin` header" (<https://fetch.spec.whatwg.org/>): a
  non-GET request from a document whose referrer policy is `no-referrer` is sent with
  `Origin: null`. A consent page served with `Referrer-Policy: no-referrer` would therefore have
  its own Continue post refused by `rest_mutation_origin_check`.
- CSP Level 3 (<https://www.w3.org/TR/CSP3/>) checks `form-action` on the redirects that follow
  a form submission, and Chromium enforces this. The page's `form-action` must list the callback
  target. WebKit's behaviour is UNVERIFIED; Phase 19's end-to-end run covers both engines.
- The consent page is shown in a Custom Tab, Auth Tab or `ASWebAuthenticationSession`, whose
  User-Agent is the system browser's. The app's §11 UA token (Phase 02) is not present there.

**Crypto dependencies** (Cargo.lock, deny.toml):
- `ring` 0.17.14 is the only version in the tree. It arrives through rustls 0.23.46 with the
  `ring` provider, via `ureq = "3.3.0"` at `crates/yaran-core/Cargo.toml:49`.
- Its license is `Apache-2.0 AND ISC`, and both are on the allowlist (`deny.toml:72, 76`).
  Bans are `multiple-versions = "warn"` and `deny = []` (`deny.toml:43, 51`).
- Making `ring` a direct dependency of yaran-core adds no new version, license or advisory.
  `base64` 0.22.1 and `sha2` are transitive only. Phase 02 work item 10 makes `ring = "0.17.14"`
  and `base64 = "0.22.1"` direct dependencies of yaran-core; this phase adds none.
- `p256`, `jsonwebtoken`, `josekit`, `rsa`, `aes-gcm` and `arc-swap` are absent.
- ring 0.17.14 APIs (read from the locked source):
  - `signature::RsaPublicKeyComponents { n, e }.verify(&RSA_PKCS1_2048_8192_SHA256, msg, sig)`.
    `n` and `e` must be big-endian without leading zeros.
  - `agreement::{EphemeralPrivateKey::generate, compute_public_key, UnparsedPublicKey, agree_ephemeral}`.
    Peer keys are accepted only as 65-byte uncompressed points; coordinates are range-checked
    and the point is checked to lie on the curve.
  - `aead::LessSafeKey` with `AES_256_GCM` and a 96-bit nonce; `digest::SHA256`; `rand::SystemRandom`.
  - There is **no public import of a fixed P-256 private scalar**. The deprecated, doc-hidden
    `ring::test::rand::FixedSliceRandom` is the only way to produce deterministic ECDH, and it is
    test-only. Phase 02 avoids it: `seal_with_secret` takes Z from the fixtures, and ECDH is
    proven by a round trip through a dev-only `p256` opener.

**Cloudflare Access facts** (fetched 2026-11-14):
- The JWT reaches the origin as the `Cf-Access-Jwt-Assertion` header on every L7 request.
  Cloudflare says to validate the header, not the cookie ("the cookie is not guaranteed to be
  passed"). Sources:
  [origin parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/)
  (updated Apr 17, 2026) and
  [validating JSON](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
  (Nov 2, 2026).
- JWKS lives at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. `keys[]` holds RSA
  JWKs (`kid`, `alg: RS256`, `use: sig`, `n`, `e`). Keys rotate every 6 weeks, and the previous
  key stays valid for 7 days. Match on `kid` and never read `public_cert` (validating JSON).
- The live endpoint returned `cache-control: public, max-age=14400` (observed, not documented).
- cloudflared accepts only auth domains ending in `.cloudflareaccess.com`
  (`.fed.cloudflareaccess.com` for FedRAMP). Source: `research/cloudflare-parts/03-jwt-native.md` §2, [jwks.go].
- Claims (`research/cloudflare-parts/03-jwt-native.md` §3):
  - Identity tokens carry `email`, a non-empty `sub`, `type: "app"`, and an array `aud`.
  - Service-token JWTs have **no `email`**, `sub: ""` and a `common_name`.
- cloudflared `originRequest.access` answers 403 for a missing token or a mismatched `aud`, and
  502 for a bad signature, expiry or wrong issuer. It checks WebSocket upgrades too
  ([jwtvalidator.go](https://github.com/cloudflare/cloudflared/blob/master/ingress/middleware/jwtvalidator.go),
  [proxy.go](https://github.com/cloudflare/cloudflared/blob/master/proxy/proxy.go), master
  read 2026-11-14).
- Whether Access closes an already-open WebSocket when the session ends is **undocumented**
  (G12). That `exp` equals the session expiry is implied but not stated, so it is UNVERIFIED (G12).
- JWE: RFC 7518 §4.6.2 Concat KDF and RFC 7516 §5.1 compact serialization (the encrypted key is
  empty for ECDH-ES direct). Vectors: RFC 7518 Appendix C (KDF only, A128GCM) and RFC 7520 §5.5
  (ECDH-ES, P-256, with fixed recipient and ephemeral keys).

**Research:** `research/R1-server-core-cli.md` §3–§4 and Implications 5;
`research/R4-cloudflare.md` Hard constraints 3, 6, 14;
`research/cloudflare-parts/03-jwt-native.md` Part A.

## In scope

- The live cloud-hostname rule (`CloudIngress` handle) and the seam Phase 10 writes to.
- The origin/host canonicalisation fix and its tests.
- A pure Access JWT verifier and JWKS parser in yaran-core.
- An async JWKS cache with single-flight fetch, `kid`-rotation awareness, a cooldown and
  pre-warming in yaran-web.
- The ingress middleware and its placement in all three serving modes.
- Closing WebSockets at JWT expiry (close code 4401).
- The `Yaran-Refusal` response header on yaran's own refusals (Phase 02 §13 codes).
- `GET /__yaran/handoff` (Y1, consent page), `POST /__yaran/handoff` (Y1b, seal and redirect)
  and `GET /__yaran/signed-in` (Y2), with the redirect allowlist, a CSRF store and a
  process-wide rate limiter.
- Remembered consent on Y1/Y1b (D24): the `dk`/`dts`/`dsig` checks, the skip rule and the
  consent cookie, through 02's `handoff_consent` functions and 09's consent key.
- Sealing through Phase 02's Rust sealer (JWE ECDH-ES with Concat KDF, A256GCM).
- Fixture JWKS and JWTs.
- The `[cloud]` config keys this phase needs.
- The remote-exposure decision record.

## Out of scope

| Item | Owner |
|---|---|
| Credentials file, machine identity, `[cloud]` section scaffolding and the `app_callback_urls` key's renderer comment | 09 |
| `ring`/`base64` as yaran-core dependencies, the Rust sealer, Concat KDF, redirect allowlist, refusal and close-code constants | 02 (work item 10) |
| Starting/stopping cloudflared, deciding *when* the rule is bound, keyed statuses for leg state, bootstrap `cloud` projection | 10 |
| Tunnel ingress `originRequest.access` and Access app/policy provisioning | 05 |
| Envelope format, handoff query/consent/payload schemas, error-code and refusal registries, shared vectors, the device-signature, consent-cookie and skip-rule functions (`cloud::protocol::handoff_consent`) | 02 (this phase consumes them; Design §8 lists what it uses) |
| The consent key's generation, storage and rotation command | 09 |
| Web UI reactions (sign-in face, 4401 handling, refusal codes) | 13 |
| Phone-side handoff client, key generation (ephemeral and the D24 device key), request signing, JWE open, renewal | 15 |
| Threat-model rows T25, T26, T36, T44, T45, T58 and SECURITY.md STRIDE rows for this surface; consumer docs | 17 |
| Hosting `assetlinks.json` and `apple-app-site-association` for the https callback | 21 |
| CSP/HSTS and other response-header hardening | 20 |

## Design

### 1. One handle: `CloudIngress`

`CloudIngress` (new, `crates/yaran-web/src/cloud_ingress.rs`) is an `Arc` around:

- `RwLock<Option<Arc<CloudBinding>>>`. `CloudBinding { hostname (normalized with
  normalize_host_for_match), team: TeamDomain, aud: String, owner_email: String }`.
- `RwLock<IngressSettings>`. `IngressSettings { clock_skew, jwks_refresh_ceiling,
  jwks_retry_cooldown, handoff_per_minute, close_sockets_at_access_expiry,
  app_callback_urls }`.
- The JWKS cache (§4), the handoff rate window and the handoff CSRF store (§7).
- The `CloudPaths` (09), set at creation, so §7 can read the D24 consent key per request.

It is created **unconditionally** in both serve constructors, next to the Tailscale cell
(`lib.rs:489-493` and `:1552-1556`). From there it is handed to `RouterParams` through a new
`with_cloud_ingress` and to Phase 10's `CloudModeControl::new`. Following the Tailscale
precedent, the serve loop is the only writer. The seam Phase 10 calls:

```rust
impl CloudIngress {
    /// Bind after cloudflared reports /ready. Validates inputs, swaps the binding in, and
    /// pre-warms the JWKS on a blocking task; `report` receives the outcome for a keyed status.
    pub fn bind(&self, b: CloudBindingInput, report: Box<dyn FnOnce(JwksOutcome) + Send>)
        -> Result<(), BindRefusal>;
    /// Clear on leg stop, credential revocation, or mode `no`. Idempotent.
    pub fn unbind(&self);
    /// Called by both reload owners when `[cloud]` keys change (live, no restart).
    pub fn update_settings(&self, s: IngressSettings);
}
```

- `BindRefusal` is an exhaustive enum: `InvalidHostname`, `InvalidTeamDomain`, `EmptyAud`,
  `EmptyOwnerEmail`. Each variant has a `.sentence()` that Phase 10 shows on both surfaces.
- `CloudBindingInput` comes from Phase 09's credentials. **It needs `owner_email`**, which the
  Phase 02 claim response must return and Phase 09 must store (see Design §8).

### 2. Live Host-guard rule

- `HostAllowlist` gains `cloud: Option<CloudIngress>` and a builder `with_cloud_ingress`.
- In the hostname branch of `allows_host` (`:202-237`), rule 4 becomes
  `configured.contains(&host) || cloud.is_some_and(|c| c.is_bound_host(&host))`.
  `is_bound_host` takes a read lock and compares against the normalized hostname.
- When nothing is bound, the hostname is just an unknown host and gets 403, so a cloudflared
  that outlives its binding cannot reach anything.
- `build_app` must install the host guard when **either** the existing condition holds or a
  `CloudIngress` is present. The `:836` condition gains one `|| cloud.is_some()`.
- The host guard's two 403 responses gain a `Yaran-Refusal: host-not-served` or
  `host-missing` header (two lines). Phase 13 tells yaran's own refusals apart from Access
  answers by this header, never by parsing the body.

Through the tunnel, the Host is always the cloud hostname. The tunnel's ingress routes only that
hostname and ends in `http_status:404` (R4 Hard constraint 1), and cloudflared preserves Host
(D4, G2). A local process that sends that Host to loopback gets exactly the same JWT
requirement, which fails closed.

### 3. Origin canonicalisation (`crates/yaran-web/src/origin_match.rs`)

`same_origin_allowed` (`server.rs:914-926`) keeps its contract: no `Origin` is allowed, and a
`null` or scheme-less origin is a mismatch. Its body becomes a call to
`origin_match::same_origin(origin, host)`, which compares **canonical authorities**:

- The host part is ASCII-lowercased, has one trailing dot removed, and keeps IPv6 brackets.
- The port is kept unless it is the default for the **Origin's scheme** (`https` 443,
  `http` 80, `wss` 443, `ws` 80). The Host header's port is dropped under the same rule,
  judged against the Origin's scheme.
- Ports are never stripped otherwise. `localhost:8000` versus Host `localhost:3890` stays a
  mismatch, so a page on another local port still cannot mutate yaran. That is why
  `normalize_host_for_match`, which strips every port, is **not** reused here.
- Malformed authorities (unbalanced brackets, non-numeric port, userinfo `@`) are a mismatch.

Tests go in `origin_match.rs`, plus one end-to-end case in the existing WebSocket-origin family
(`server.rs:6106-6144`):

- **Equal:** `https://Alice.Zone` vs `alice.zone:443`.
- **Mismatch:** `https://alice.zone:8443` vs `alice.zone`.
- **Mismatch:** `http://localhost:8000` vs `localhost:3890`.
- **Bracket rules:** `http://[::1]:3890` vs `[::1]:3890`.
- **Trailing dot:** treated as equal.
- **Mismatch:** userinfo, `null`, an empty Origin.

### 4. JWT verification

**Pure core** (`crates/yaran-core/src/cloud/access_jwt.rs`):

```rust
pub fn verify(token: &str, keys: &Jwks, expect: &Expectations, now: SystemTime)
    -> Result<VerifiedAccess, AccessRejection>;
```

The checks run in this order, and the first failure decides the result:

1. Length is at most 8 KiB, and there are exactly 3 segments.
2. The header decodes as base64url and parses as JSON. `alg == "RS256"` exactly, so `none`,
   `HS256` and `PS256` are all rejected. `kid` must be present.
3. `kid` must be in `keys`; otherwise the result is `UnknownKid`, and the cache decides whether
   to refetch.
4. The RSA PKCS#1 v1.5 SHA-256 signature over `header.payload` verifies with ring.
5. Claims:
   - `iss == expect.team.issuer()` exactly (`https://<team>.cloudflareaccess.com`, no trailing slash).
   - `aud` (string or array) contains `expect.aud`.
   - `exp > now - skew` and `nbf <= now + skew`; a missing `nbf` is allowed.
   - `type == "app"`.
6. Service tokens are rejected when `email` is absent or empty, when `sub` is empty, or when
   `common_name` is present (R4 Hard constraint 6).
7. Owner: `email`, ASCII-lowercased, must equal `owner_email`, ASCII-lowercased. A failure here
   is `NotOwner`.

`AccessRejection` is an exhaustive enum: `Missing`, `Malformed`, `BadAlgorithm`, `UnknownKid`,
`BadSignature`, `WrongIssuer`, `WrongAudience`, `Expired`, `NotYetValid`, `NotAppToken`,
`ServiceToken`, `NotOwner`. Each variant's `code()` returns its string from Phase 02's
`cloud::protocol::signals` (`access-missing`, `access-malformed`, `access-bad-algorithm`,
`access-unknown-kid`, `access-bad-signature`, `access-wrong-issuer`, `access-wrong-audience`,
`access-expired`, `access-not-yet-valid`, `access-not-app-token`, `access-service-token`,
`access-not-owner`; 02 §13), never a local spelling, for logs and the `Yaran-Refusal` header.
Its HTTP status is 401 for everything except `NotOwner`, which is 403.

`VerifiedAccess { email, sub, aud, exp: SystemTime, jwt: String }` is the request extension that
handlers read (`jwt` is the header value verbatim, named as in 02's `HandoffPayload`; `sub` and
`aud` are kept only for the handoff's cookie comparison, §7).

Two things the verifier deliberately does not check:
- **`sub`.** It changes when a user is removed and re-added to the account
  (`03-jwt-native.md` §3), which would lock the legitimate owner out until they pair again.
- **Case-sensitive email.** IdPs differ in casing, and the owner email came from the same
  Access identity at pairing.

**JWKS parsing and fetch** (`crates/yaran-core/src/cloud/access_jwks.rs`):

- `TeamDomain::parse` accepts only `https://<label>.cloudflareaccess.com` or
  `https://<label>.fed.cloudflareaccess.com`, the same rule cloudflared applies. This keeps a
  bad credentials file from pointing the fetch anywhere else.
- `Jwks::parse` keeps entries with `kty == "RSA"`, `alg` absent or `RS256`, and `use` absent
  or `sig`. It strips leading zeros from `n` and `e` and requires a modulus of at least 2048
  bits. Anything else is skipped with a debug log, and an empty result is an error.
- `fetch_jwks(team, timeout)` makes one blocking `ureq` GET of `/cdn-cgi/access/certs` and
  returns `(Jwks, Option<Duration>)`, the second part parsed from `Cache-Control: max-age`.
  Errors are sanitized with `yaran_core::sanitize::for_terminal` before logging.

**Async cache** (`crates/yaran-web/src/cloud_jwks_cache.rs`):

- `tokio::sync::Mutex<CacheState>` provides single-flight fetching. The fetch runs in
  `tokio::task::spawn_blocking`, so a blocking call never runs on a reactor thread (CLAUDE.md:
  blocking work stays off the request path).
- The cache refreshes at `min(max-age, jwks_refresh_ceiling)`, with a 300 s floor.
- On `UnknownKid` it refetches, at most once per `jwks_retry_cooldown`. This matches jose's
  cooldown behaviour and covers rotation, which keeps the old key for 7 days.
- `bind` pre-warms the cache.
- A `JwksSource` trait (a ureq implementation and a fixture implementation) makes the cache
  testable without a network.

**Refusals:**
- No usable keys, with a fetch failing or still in cooldown and nothing cached: **503**
  `yaran could not fetch the Cloudflare Access signing keys for <team>; refusing the request
  until it can` with `Yaran-Refusal: access-keys-unavailable`.
- Stale cached keys are still used for signature checks until the refresh succeeds. A key that
  rotated out simply stops matching.

### 5. Middleware placement

`cloud_access_middleware(State<CloudIngress>, mut req, next)` behaves as follows:

1. If nothing is bound, or the normalized Host is not the bound hostname, pass through
   untouched. Loopback, LAN and Tailscale are unaffected (D3).
2. Otherwise, read `Cf-Access-Jwt-Assertion`. The `CF_Authorization` cookie is never used for
   authorization (Cloudflare guidance).
3. Verify the token, with one refetch on `UnknownKid`.
4. On success, insert `VerifiedAccess` into `req.extensions_mut()` and continue.
5. On failure, return a plain-text refusal with `Cache-Control: no-store` and
   `Yaran-Refusal: <code>`. Log it at `warn!(target: "yaran::cloud::ingress", code = …)` with
   the email ASCII-sanitized when present, and **never the token**.

It is installed in `build_app` right after `.with_state(state)` (`:831`) and before the host
guard, so the outermost-first order becomes:

**host guard → cloud access → access_log → origin check → handlers**

The guard still rejects unknown Hosts first. The access log, which drops query strings, never
sees unauthenticated cloud requests. Because WebSocket upgrades are ordinary GETs through the
same stack, all six upgrade routes are covered without touching their handlers' checks.

### 6. Closing sockets at expiry (close code 4401)

- `upgrade_pty_socket` (`:1234`) and `ws_events_upgrade` (`:2581`) gain the extractor
  `Option<Extension<VerifiedAccess>>`. They pass `deadline = exp + skew` down when
  `close_sockets_at_access_expiry` is on.
- Each `select!` (`:1938-1948` and `:2816-2827`) gets one arm, built from the shared helper
  `cloud_ingress::session_deadline(Option<SystemTime>)`, which is a never-resolving future
  when `None`. The events loop gets one new `EventsLoopInput::SessionExpired` variant.
- When the deadline fires, the server sends Close with code **4401** and reason
  `access session expired` (`yaran_core::cloud::protocol::SESSION_EXPIRED_CLOSE_CODE`, Phase 02
  `signals.rs`; yaran-web defines no copy), then breaks the loop
  through the existing teardown, so ownership guards release as usual.
- **Why:** a user removed from the policy would otherwise keep a live shell indefinitely, and
  G12 says Cloudflare documents no teardown.
- **Cost:** a native shell that renewed its cookie early (Phase 15) sees one transparent
  reconnect with replay. A browser whose cookie also expired gets the sign-in face (Phase 13).

### 7. Handoff and sign-in routes (`crates/yaran-web/src/cloud_handoff.rs`)

All three routes (Y1, Y1b, Y2) are registered by `cloud_routes()`, merged in `build_app` (one
`.merge` line). They **exist only behind Access**: with no `VerifiedAccess` extension (any
non-cloud Host) they answer 404, so loopback can never mint an envelope. A missing or
non-owner JWT never reaches them: the middleware (§5) already refused it with
`access-missing` / `access-not-owner`, so the reserved codes `handoff_jwt_missing` and
`handoff_owner_mismatch` are never emitted (02 §4).

**Redirect allowlist** (02 §8, one rule for both servers). `redirect` is checked byte for byte
with `cloud::protocol::uri::redirect_allowed(redirect, build, &settings.app_callback_urls)`:

| `build` | `redirect` must equal | Otherwise |
|---|---|---|
| `release` (default) | one entry of `[cloud] app_callback_urls`, by default exactly `https://<publisher_domain>/auth/callback`, compiled in from the repo-root `publisher.json` (18 is its one home; 09 derives the default) | `400 handoff_request_invalid`, never redirected to |
| `dev` | exactly `yaranapp://auth/callback` (`DEV_HANDOFF_REDIRECT`) | `400 handoff_request_invalid`, never redirected to |

A `release` request naming the custom scheme, a `dev` request naming an https URL, a trailing
slash, a case change, an extra query, userinfo and `http:` are all refused
(`fixtures/uri/handoff-redirect.json`).

**`GET /__yaran/handoff?v=&pk=&state=&redirect=&device=&dk=&dts=&dsig=[&build=dev][&mode=fragment]`** (Y1,
query `HandoffQuery`, 02 §8):

1. Validate in 02's order: `v` in `PROTOCOL_MIN..=PROTOCOL_MAX`; `build` and `redirect` against
   the allowlist; `state` against `^[A-Za-z0-9_-]{22,128}$`; `mode`; `device` (1–64 chars,
   control and bidi characters refused); `pk` with 02's `handoff::parse_recipient_point` (a
   `P256Point`: 65 bytes, leading `0x04`, on the curve); then, with 02's
   `handoff_consent` form checks (02 §8.1, form and freshness only): `dk`
   [`handoff_device_key_invalid`], `dts` and `dsig` [`handoff_signature_malformed`, a missing
   field included], `|now − dts| ≤ 300 s` [`handoff_timestamp_skewed`].
2. If `build`, `redirect` or `state` is invalid: `400` with code `handoff_request_invalid`, as
   the §4 JSON envelope, or a minimal HTML page with the same code when `Accept` prefers
   `text/html`. Nothing is ever redirected to an unvalidated target.
3. Any later failure: `302` to `<redirect>?state=<state>&error=<code>` (after `#` with
   `mode=fragment`): `protocol_unsupported` with `&min=&max=` for `v`; the three D24 codes
   above (`handoff_timestamp_skewed` adding `&server_time=<unix s>`, the JSON form
   `details.server_time`); otherwise `handoff_request_invalid` (this replaces the former local
   `invalid_pk`). These are §4 codes, never `Yaran-Refusal` values (02 §13).
4. **Device signature and remembered consent (D24, 02 §8.1).** The middleware has already
   verified the owner JWT. Verify `dsig` with 02's `verify_handoff_device_sig` over the canonical
   string built with `host` = the bound hostname (`CloudBinding.hostname`, never a query value)
   and `pk`, `state`, `dts` as sent. A well-formed signature that does not verify is not an
   error: `verified = false`, and the consent page follows.
   - When the request carries `__Secure-yaran-handoff-consent` and `verified` is true, read the
     consent key with 09's `read_handoff_consent_key` on `spawn_blocking` (never cached, so a
     rotation applies to the next request) and ask 02's `decide_remembered` with `side =
     yaran` (rule 5, Worker device revocation, does not apply here). No cookie, no key
     (unpaired or unreadable credentials, logged as a warning), or a failing cookie means the
     consent page; a failing cookie is ignored, never an error, never cleared.
   - **Skip:** answer exactly as a Continue would (step 4 of the POST): rate limit, seal, `302`
     to the callback with the success headers; no `Set-Cookie`, because a skip does not refresh
     the cookie. `build=dev` skips under the same rule (02).
5. Otherwise: `200 text/html`, the **consent page**. It never contains a JWE.
   - It mints a `csrf` (32 bytes from `ring::rand::SystemRandom`, base64url, 43 chars) into the
     CSRF store (`handoff_csrf.rs`): bound to `(state, SHA-256(pk))` plus `dk`'s
     `DeviceKeyFingerprint` and the `verified` verdict (02 §8.1), single use, valid
     10 minutes, at most 64 pending with the oldest evicted. Only the verified owner can mint.
   - It names, as chips: the `device` label; the platform (the 02 §11 UA token through
     `cloud::protocol::ua` when present, otherwise `short_device_label(User-Agent)`, because a
     Custom Tab or `ASWebAuthenticationSession` sends the browser's UA (Evidence); omitted when
     neither recognises it); the bound hostname; the verified `email`. It asks "Sign this device
     in to `<host>`?" with **Continue** (primary) and **Cancel**. Both submit `HandoffConsent`
     as a form POST to the same path, every query field carried in hidden inputs.
   - With `build=dev` it adds 02's warning: the request comes from a development build of the
     app, so continue only if you built or installed that build yourself.
   - It is script-free, and every interpolated value is HTML-escaped. Styling is Phase 14's
     `packages/ui-kit/src/tokens.css` (plain custom properties, embedded with `include_str!`,
     R18; the page sets `class="dark"` as the dark-only web does) plus one short page
     stylesheet; no colour is hard-coded. Buttons meet the 40 px floor and
     are separated by misclick-safe spacing.
   - Headers: `Cache-Control: no-store`; `Content-Security-Policy: default-src 'none';
     style-src 'sha256-<hash of the one style element>'; form-action 'self' <the callback's
     origin, or yaranapp: for build=dev>; frame-ancestors 'none'; base-uri 'none'`;
     `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; and
     `Referrer-Policy: same-origin`, not `no-referrer`, which would make the browser send
     `Origin: null` on the Continue post (Evidence). `frame-ancestors` stops another page
     framing the Continue button. The style hash is computed once (`OnceLock`).

**`POST /__yaran/handoff`** (Y1b, form `HandoffConsent`, `application/x-www-form-urlencoded`):

1. `rest_mutation_origin_check` already refuses a cross-origin or `null` Origin (02 §2).
2. Re-validate every field exactly as the GET did, with the same 400 / error-redirect split.
   Then take the `csrf` out of the store (single use) and require its bound `state` and `pk`
   hash to match, and `dk`'s fingerprint to equal the recorded one (`dts` and `dsig` are not
   re-sent; the GET decided). A missing, expired, reused or mismatched `csrf`, or a different
   `dk`, gives `303` with `error=handoff_request_invalid`.
3. `decision=cancel`: `303` to the callback with `error=handoff_declined`, logged as
   `info!(target: "yaran::cloud::handoff", "handoff declined")`.
4. `decision=continue`:
   - **Rate limit:** a process-wide fixed window (`rate_window.rs`, new and reusable; no limiter
     exists today) of `handoff_requests_per_minute`, default 12. Over the limit: `303` with
     `error=rate_limited` and `Retry-After`. Per-IP limiting is impossible because every tunnel
     request comes from loopback (R1 §3b).
   - **`cookie` (G1 fallback L1, 03):** when the request carries a `CF_Authorization` cookie,
     its value is verified with the same verifier and keys, and it is sealed only when it
     verifies and its `sub`, `email` and `aud` equal the header token's. A cookie that is
     present but fails gives `error=handoff_request_invalid`, with the rejection code logged. An
     absent cookie is simply omitted. If G1 records L1, the PR that records it flips the
     constant `COOKIE_REQUIRED` in `cloud_handoff.rs`, so an absent cookie is refused too (03
     G1 L1: refuse when either is missing). The cookie is never used for authorization (§5).
   - **Payload** (`HandoffPayload`, 02 §8): `v: 1`, `kind: "machine"`, `host` (the bound
     hostname), `jwt` (the verified `Cf-Access-Jwt-Assertion` value, verbatim), `email`, `exp`
     (from the JWT), `iat`, and the optional `cookie`. No other fields.
   - **Seal** with 02's `cloud::protocol::handoff::seal` (§8) and answer
     `303 Location: <redirect>?state=<state>&jwe=<compact>` (`#` form with `mode=fragment`),
     with `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`,
     `X-Content-Type-Options: nosniff`, and a one-line fallback link as the only body.
   - **Consent cookie (D24):** when the csrf's recorded verdict is `verified`, the `303` also
     carries `Set-Cookie` from 02's `build_consent_cookie` with the current consent key and
     version read through `read_handoff_consent_key`, `fp24` from the recorded fingerprint,
     `iat` = now, `host` = the bound hostname: `__Secure-yaran-handoff-consent=v1.<kv>.<fp24>.<iat>.<mac>;
     Path=/__yaran/handoff; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax`, no `Domain`.
     Not verified, or no key readable: no cookie, and the handoff still succeeds. Cancel
     neither sets nor clears it. Nothing else sets it.
   - Log `info!(target: "yaran::cloud::handoff", consent = "explicit" | "remembered", "handoff
     issued")` (the skip path logs `remembered`) with no token, key, state, csrf, cookie,
     `dk` or `dsig`.

The first handoff from a device, and any handoff failing a skip condition, shows the consent
page; that tap is what stops a silent SSO auto-approve from completing a handoff the person did
not start. A renewal from the same app install skips it (D24), because another app or flow
cannot produce that install's `dsig`. Rotating the consent key (09, `yaran cloud rotate
--consent-key`), re-pairing or logging out makes every cookie fail rule 1, so each phone taps
once more. yaran never learns that the Worker revoked a device (02 Risks): a revoked phone keeps
skipping here until the key rotates, and still needs an owner Access JWT to reach this route.

**`GET /__yaran/signed-in`** (Y2) returns a self-contained, script-free HTML page that says, in
the app's voice, that this browser is signed in to the machine and the tab can be closed. It
sends `no-store` and uses the same ui-kit token styling as the consent page.

Phase 13 opens it in a new tab when a browser session has expired. Access intercepts the
navigation, the user signs in, Access lands them here, and the original tab reconnects by
itself. That avoids a page reload, which matters because CLAUDE.md allows only the
server-run-change reload.

### 8. Sealing and the contract

Phase 02 ships the sealer this phase uses: `yaran_core::cloud::protocol::handoff`
(`parse_recipient_point`, `thumbprint`, `seal`, `seal_with_secret`, `HandoffPayload`) and
`concat_kdf.rs` (02 work item 10). It implements 02 §8 exactly: a standard JWE, ECDH-ES with
the RFC 7518 §4.6.2 Concat KDF and A256GCM (no HKDF anywhere):
- Protected header `{alg: "ECDH-ES", enc: "A256GCM", typ, cty, kid, epk, apu: b64u(host),
  apv: b64u(state)}`.
- Z comes from `agree_ephemeral` with a fresh `EphemeralPrivateKey`.
- AES-256-GCM with a random 96-bit IV; the AAD is the ASCII of the encoded protected header.
- Compact output with the encrypted-key segment empty.

This phase creates no `seal.rs` (one home, `00-CONVENTIONS.md` §1.4). The RFC 7518 Appendix C
KDF vector, the handoff vectors and the ring-seal to `p256`-open round trip are 02's tests. The
RFC 7520 §5.5 case (fixed P-256 keys, ECDH-ES direct) that this phase used to carry is not in
02's fixture list; this phase's PR adds it to `cloud/protocol/fixtures/jwe/` as a KDF case
(Z and CEK hex), which needs no `FixedSliceRandom`.

Everything this phase needs is already in Phase 02, so it adds nothing to the contract:
- `HandoffQuery`, `HandoffConsent`, `HandoffPayload` with the optional `cookie`, and the
  `apu`/`apv` binding to host and state (§6, §8).
- The redirect allowlist, `DEV_HANDOFF_REDIRECT`, `APP_CALLBACK_URLS` / `[cloud]
  app_callback_urls` and `fixtures/uri/handoff-redirect.json` (§8, §12).
- Error codes `handoff_request_invalid`, `handoff_declined`, `rate_limited` and
  `protocol_unsupported` (§4).
- Close code 4401 and the 15 `Yaran-Refusal` codes (§13).
- The claim response's `owner_email`, which Phase 09 stores.
- D24 (02 §8.1): `HandoffQuery.dk`/`dts`/`dsig`, `HandoffConsent.dk`, the codes
  `handoff_device_key_invalid`, `handoff_signature_malformed`, `handoff_timestamp_skewed`, and
  `cloud::protocol::handoff_consent` (`verify_handoff_device_sig`, `device_key_fingerprint`,
  `build_consent_cookie`, `parse_consent_cookie`, `decide_remembered`) with the fixtures
  `sig/device-fingerprint.json`, `sig/handoff-device-signature.json`,
  `handoff/consent-cookie.json` and `handoff/remembered-consent.json`. The consent key itself
  comes from 09.

A gap found during implementation is added to 02 in the same PR, never declared locally.

### 9. Config keys (added under Phase 09's `[cloud]` checklist)

All keys are live: both reload owners call `CloudIngress::update_settings`. These are the
`run_engine_loop` reload arm (`engine_actor.rs:2845-2914`) and the TUI's
`apply_reloaded_config` (`app/mod.rs:6020-6120`). Each key gets an inline comment in the
canonical renderer.

| Key | Default | Why it is a setting |
|---|---|---|
| `access_clock_skew_seconds` | 30 | Machines with poor NTP |
| `access_jwks_refresh_seconds` | 14400 | Upper bound on key-cache age; matches the observed `max-age` |
| `access_jwks_retry_cooldown_seconds` | 30 | Refetch throttle on an unknown `kid` |
| `handoff_requests_per_minute` | 12 | Shared phones or households renewing at once |
| `close_sockets_at_access_expiry` | true | G12 fallback lever (see Risks) |
| `app_callback_urls` (key and renderer comment owned by 09; read live and enforced here) | the compiled-in release callback `https://<publisher_domain>/auth/callback`, derived by 09 from `publisher.json` at build time (the Worker's `APP_CALLBACK_URLS` comes from the same file, 07/18); empty in builds without a publisher domain | A fork that publishes its own app adds its own https callback (02 §8) |

### 10. Decision record: what a remote owner may see

**Context:**
- Every `/api/v1/*` route is unauthenticated by design (`server.rs:6-7`).
- `GET /api/v1/config/raw` returns the whole `config.toml` (`config_routes.rs:415-420`).
- Bootstrap ships `global_env` to every page (`viewmodel.rs:1476`).

**Decision:** after this phase, the only remote principal is the **paired owner**, verified on
every request (§4–§5). That is the same person who can read these files on the machine. Remote
access therefore equals owner access, and no route is restricted by origin. Secrets yaran itself
holds never enter `config.toml` or `[env]` (D5), so neither route exposes the tunnel token or
the machine key.

**Consequence stated plainly:** values a user puts in `[env]` cross Cloudflare's edge in
plaintext on every page load through the tunnel, as does any file read in the editor (D17).
Phase 17 adds this to the threat model (T44), SECURITY.md and the "Security & privacy" docs
page, with the advice to keep real secrets out of `[env]` when using Cloud Connect.

**Rejected:**
- *Redact `global_env` on the cloud Host.* The environment editor needs the values, and the
  owner is the reader.
- *Block `config/raw` remotely.* It breaks the raw config editor on the phone and protects
  nobody the owner check doesn't already protect.

This text also goes, condensed, into the header comment of `cloud_ingress.rs`, so the reasoning
lives next to the code.

## Work items

Every new file starts with the `00-CONVENTIONS.md` §2 header, and its `Uses` / `Used by` block
is generated by `tools/module-headers`. Planned sizes are ceilings.

1. **Contract conformance.** Phase 02 already defines everything this phase uses (§8), so
   nothing is added to the contract except the RFC 7520 §5.5 KDF case in
   `cloud/protocol/fixtures/jwe/` (§8). *Tests:* every `Yaran-Refusal` code yaran can emit (the
   12 `AccessRejection` codes, `access-keys-unavailable`, `host-not-served`, `host-missing`)
   equals `registry/refusals.json` exactly; every handoff `error=` and 400 code this phase
   emits is in `registry/errors.json`; `redirect_allowed` is exercised through the route over
   every case in `fixtures/uri/handoff-redirect.json`.
2. **Access fixtures.**
   - Create `cloud/protocol/fixtures/access-jwt/` containing:
     - `generate.mjs` (≤200 lines; Node WebCrypto RSA-2048; deterministic claims, fixed
       `iat`/`exp`);
     - the committed outputs: `jwks.json` (current + previous key), `jwks-rotated.json`, and
       `tokens.json`.
   - `tokens.json` holds these named cases: valid; aud as string; expired; nbf in the future;
     wrong aud; wrong iss; service token; other email; uppercase email; alg none; alg HS256;
     unknown kid; signature flipped; previous key; oversized.
   - Phase 04's Worker tests read the same files.
3. **`crates/yaran-core/src/cloud/access_jwks.rs`** (create, ≤300). `TeamDomain`, `Jwks`,
   `fetch_jwks`. Reuses `ureq` (`yaran-core/Cargo.toml:49`), `base64` (made direct alongside
   `ring` if Phase 09 has not), and `sanitize::for_terminal`.
   *Tests:* team-domain accept/reject table (`.fed.` accepted, `evil.com/x.cloudflareaccess.com`
   and `http://` rejected), JWKS parse (skips EC/HS keys, strips leading zeros, rejects
   <2048-bit), `max-age` parsing.
4. **`crates/yaran-core/src/cloud/access_jwt.rs`** (create, ≤400). `verify`, `Expectations`,
   `VerifiedAccess`, `AccessRejection`.
   *Tests:* one per `tokens.json` case with an injected `now`; skew boundaries at ±1 s; a
   property-style test that every `AccessRejection` has a unique `code()`.
5. **No `seal.rs`.** Sealing uses Phase 02's `cloud::protocol::handoff` (§8). *Tests:*
   - The RFC 7518 Appendix C KDF vector, Phase 02's handoff vectors and the seal round trip
     run in 02 (02 work item 10); the RFC 7520 §5.5 case is added there (item 1).
   - In this phase, every envelope the route issues is opened by a `#[cfg(test)]` opener in
     `cloud_ingress_tests.rs`: the test generates the recipient with ring's
     `EphemeralPrivateKey`, sends its public point as `pk`, derives Z with
     `agree_ephemeral(recipient, epk)`, then opens with 02's `concat_kdf` and `ring::aead`, and
     compares `jwt`, `kind`, `host` and `cookie`.
   - Point rejection through the route: off-curve point, compressed point, 64- and 66-byte
     points, and a JWK instead of a `P256Point`.
6. **`crates/yaran-core/src/cloud/mod.rs`** (touch, created by 02, extended by 09): two
   `pub mod` lines (`access_jwks`, `access_jwt`). `crates/yaran-core/Cargo.toml` is not touched:
   02 work item 10 adds `ring` and `base64`.
7. **`crates/yaran-web/src/origin_match.rs`** (create, ≤200) and **`server.rs`** (touch: the
   body of `same_origin_allowed` becomes one call). *Tests:* the §3 table, plus one
   WebSocket-origin integration case.
8. **`crates/yaran-web/src/cloud_jwks_cache.rs`** (create, ≤300). Single-flight cache,
   cooldown, ceiling, pre-warm, `JwksSource`. *Tests (tokio):*
   - 50 concurrent misses cause exactly one fetch.
   - Unknown-kid refetches stop at the cooldown.
   - Stale keys are served while a refresh fails.
   - An empty cache plus a failed fetch gives `Unavailable`.
9. **`crates/yaran-web/src/cloud_ingress.rs`** (create, ≤400). `CloudIngress`, `CloudBinding`,
   `BindRefusal`, `IngressSettings`, the middleware, `session_deadline` (using 02's
   `SESSION_EXPIRED_CLOSE_CODE`), and the decision-record header. *Tests:* bind/unbind/rebind,
   `BindRefusal` sentences, Host matching (case, port, trailing dot).
10. **`crates/yaran-web/src/rate_window.rs`** (create, ≤120). A fixed-window counter with an
    injected clock. *Tests:* window roll-over, exact limit, and `Retry-After` value.
11. **Handoff routes** (§7):
    - `crates/yaran-web/src/cloud_handoff.rs` (create, ≤400): `cloud_routes()`, the Y1, Y1b
      and Y2 handlers, `HandoffQuery`/`HandoffConsent` validation in 02's order, the cookie
      check and `COOKIE_REQUIRED`, payload assembly, the 400 / error-redirect split and the
      redirect builder (query and fragment forms), and the D24 path: `dk`/`dts`/`dsig` form
      checks, signature verdict, consent-key read, skip and `Set-Cookie`, with the seal-and-
      redirect step shared by the skip and Continue. Reuses 02's `redirect_allowed`,
      `parse_recipient_point`, `ua`, `seal`, `HandoffPayload` and `handoff_consent`, 09's
      `read_handoff_consent_key`, plus `rate_window`.
    - `crates/yaran-web/src/handoff_consent_page.rs` (create, ≤200): the consent and signed-in
      HTML, escaping, the ui-kit token stylesheet, the CSP with its style hash and callback
      `form-action`. Reuses `device_label::short_device_label`.
    - `crates/yaran-web/src/handoff_csrf.rs` (create, ≤150): mint, bind (state, pk hash,
      device-key fingerprint, signature verdict), single-use take, 10-minute expiry, 64-entry
      cap, injected clock.
    - *Tests:* CSRF single use, expiry at 10 minutes, eviction at 64, `state`, `pk` or `dk`
      mismatch refused, the verdict returned as recorded; page escaping (a `<script>` device label renders inert), chips for
      device, platform, host and email, the dev warning only with `build=dev`, `form-action`
      naming the configured callback origin and `yaranapp:` only with `build=dev`,
      `Referrer-Policy: same-origin` and `frame-ancestors 'none'`; platform from the UA token,
      from a browser UA, and omitted.
    - *Tests (D24, route level):* every case of `fixtures/sig/handoff-device-signature.json`
      through Y1 (verifying → eligible to skip; wrong host, `pk`, `state`, `dts` or key →
      consent page; malformed → its 302 code; ±300 s accepted, ±301 s refused with
      `server_time`); every yaran row of `fixtures/handoff/remembered-consent.json` through
      Y1/Y1b (skip vs consent page, and whether Continue sets the cookie); the `Set-Cookie`
      line equals `fixtures/handoff/consent-cookie.json`'s for the same inputs.
12. **Wiring (minimal):**
    - `host_guard.rs`: field, builder, one condition, two `Yaran-Refusal` headers.
    - `server.rs`:
      - the `RouterParams`/`AppState` field and `with_cloud_ingress`;
      - the layer line after `:831`, and the `:836` condition;
      - the `.merge(cloud_routes())`;
      - the extractor and `deadline` parameter on `upgrade_pty_socket` and
        `ws_events_upgrade`, plus one `select!` arm each and one `EventsLoopInput` variant.
    - `lib.rs`: create the handle at `:489-493` and `:1552-1556` with the `CloudPaths` (D24
      key reads) and pass it to `RouterParams` and to Phase 10's `CloudModeControl::new`.
    - `lib.rs` (crate root): `mod` lines.
    - Config: the §9 keys via Phase 09's `[cloud]` checklist (core config struct, TUI schema,
      canonical commented renderer, `config_write` patch list, diff exhaustiveness test, and
      an `upgrade_config` test), plus `update_settings` calls in both reload owners, which
      also carry Phase 09's `app_callback_urls`.
13. **Integration tests:** `crates/yaran-web/src/cloud_ingress_tests.rs` (create, ≤500,
    `#[cfg(test)]`). It drives `build_app` exactly as the host-guard tests at `server.rs:5847`
    do, with a fixture `JwksSource`. Cases, with Host = the bound hostname unless stated:

    | Case | Expected |
    |---|---|
    | No assertion | 401 with `Yaran-Refusal: access-missing` |
    | Valid token | 200 on `/healthz`, `/api/v1/build` and a POST |
    | Expired, wrong aud, service token | 401 |
    | Other email | 403 |
    | JWKS unavailable | 503 |
    | Host `localhost` without a token | 200 (unchanged) |
    | Unbound hostname | 403 `host-not-served` |
    | WebSocket upgrade without a token | 401 before the origin check |
    | WebSocket with a token expiring in 1 s, `close_sockets_at_access_expiry` on | Close 4401 (paused tokio clock) |
    | Same, with the setting off | Stays open |
    | Handoff GET: valid | 200 consent page naming device, host and email as chips, carrying a `csrf`; no `jwe` in the body or any header |
    | Handoff POST `continue` with that `csrf` | 303 to the configured callback with `state` and `jwe`, decrypted in-test to the original `jwt` with `kind: "machine"`; `cookie` carried when it verifies and matches |
    | Handoff POST with `mode=fragment` | 303 with `#state=…&jwe=…` |
    | Handoff POST `cancel` | 303 with `error=handoff_declined`, no `jwe` |
    | Handoff POST with a reused, expired or other-`state`/`pk` `csrf` | 303 with `error=handoff_request_invalid`, no `jwe` |
    | Handoff POST without a GET (no `csrf`) | 303 with `error=handoff_request_invalid` |
    | Handoff POST with `Origin: https://evil.example` or `Origin: null` | 403 (existing origin check) |
    | Handoff: every refused case in `fixtures/uri/handoff-redirect.json` (release naming `yaranapp://`, dev naming https, trailing slash, case change, extra query, userinfo, `http:`) | 400 `handoff_request_invalid`, no `Location` header |
    | Handoff: `build=dev` with `yaranapp://auth/callback` | 200 consent page with the dev warning |
    | Handoff: bad pk (off-curve, compressed, wrong length, JWK) | 302 with `error=handoff_request_invalid` |
    | Handoff: `v` out of range | 302 with `error=protocol_unsupported&min=…&max=…` |
    | Handoff: `CF_Authorization` cookie for another email | 303 with `error=handoff_request_invalid` |
    | Handoff: 13th `continue` in a minute | 303 with `error=rate_limited` and `Retry-After` |
    | D24: GET verifying, no cookie → POST `continue` | 303 with `jwe` and a `Set-Cookie` matching the consent-cookie fixture's attributes (host-only, HttpOnly, Secure, Lax, `Path=/__yaran/handoff`, `Max-Age=34560000`) |
    | D24: then a fresh GET, same `dk`, new `pk`/`state`, valid `dsig`, with that cookie | 302 with `state` and `jwe`, no consent page, no `Set-Cookie`; log line `consent=remembered` |
    | D24: foreign app: same cookie, a different `dk` with its own valid `dsig` | 200 consent page (rule 2), no `jwe` |
    | D24: wrong fingerprint: cookie whose `fp24` is another key's, valid `dsig` | 200 consent page |
    | D24: cookie and `dk` match, `dsig` well-formed but over another `state` or host | 200 consent page; a `continue` from it sets no cookie |
    | D24: after `yaran cloud rotate --consent-key` (09 test helper rewrites the credentials) | the old cookie gets the 200 consent page; a new `continue` sets a cookie with the new `kv` |
    | D24: cookie with tampered `mac`, `iat` > now + 300 or older than 34560000 s | 200 consent page; the cookie is not cleared |
    | D24: `dts` 301 s old, or 301 s ahead | 302 with `error=handoff_timestamp_skewed&server_time=…` |
    | D24: `dsig` DER, 85 or 87 chars, `r = 0`, `s = n`, or missing | 302 with `error=handoff_signature_malformed` |
    | D24: `dk` compressed, off-curve, or missing | 302 with `error=handoff_device_key_invalid` |
    | D24: POST with a `dk` other than the GET's | 303 with `error=handoff_request_invalid`, no cookie |
    | D24: `cancel` from a verifying GET | 303 `error=handoff_declined`, no `Set-Cookie` |
    | D24: `build=dev`, cookie and `dsig` valid | 302 skip, as release |
    | Handoff GET or POST on loopback | 404 |
    | `/__yaran/signed-in` on loopback / cloud Host | 404 / 200 HTML with `no-store` |
    | Unknown `/__yaran/x` | Still the SPA fallback (unchanged) |

14. **Handoff to Phase 17:** confirm that 17's allocation table carries the threat rows this
    phase creates, and that the code comments cite them: ingress bypass via a mis-set policy
    (T25); Access JWT forgery and JWKS outage (T26); handoff interception and abuse, including
    the dev-build custom-scheme residual and the consent interstitial (T36); `[env]` and
    `config/raw` crossing the edge (T44); revocation lag and 4401 (T45); and the rate limiter's
    global scope (T58).

## Acceptance

- [ ] With the cloud leg bound, every request and WebSocket upgrade to the tunnel hostname
      without a valid owner JWT is refused (401, 403 or 503 with `Yaran-Refusal`), proven by
      `cloud_ingress_tests.rs`.
- [ ] Loopback, LAN and Tailscale requests are byte-for-byte unaffected, and every existing
      host-guard and origin test still passes.
- [ ] Unbinding immediately turns the hostname into an unknown host (403).
- [ ] `https://Host` against `host:443` passes the origin check; a different port, scheme
      default aside, still fails.
- [ ] JWKS fetches are single-flight, cooldown-limited, cached no longer than the configured
      ceiling, and an outage fails closed.
- [ ] Service-token JWTs, `alg` other than RS256, unknown `kid` after refetch, wrong
      `iss`/`aud`, expired and not-yet-valid tokens are all rejected, each with a distinct code.
- [ ] Every `Yaran-Refusal` code yaran emits is one of Phase 02's 15 codes, and the set equals
      `registry/refusals.json` (test).
- [ ] Open sockets close with 4401 (02's `SESSION_EXPIRED_CLOSE_CODE`) at `exp + skew` when
      the setting is on.
- [ ] No envelope is sealed or redirected without the person's consent: the GET only ever
      answers the consent page (naming device, host and email) or an error, and a JWE is
      issued only by a `continue` POST carrying a valid, unexpired, single-use `csrf` bound to
      that `state` and `pk`. Cancel yields `error=handoff_declined` and no JWE. The one
      exception is D24's remembered-consent skip, which needs a cookie set by an earlier
      explicit Continue, a matching device-key fingerprint, a verifying `dsig` and a fresh
      `dts` (02 §8.1).
- [ ] D24: the consent cookie is set only by a `continue` whose GET verified `dsig`, with the
      exact fixture attributes and a MAC from 09's current consent key; a foreign app (other
      `dk`), a mismatched fingerprint, a non-verifying signature or a rotated consent key gets
      the consent page; malformed or stale `dk`/`dts`/`dsig` get `handoff_device_key_invalid`,
      `handoff_signature_malformed` or `handoff_timestamp_skewed`; all proven over 02's four
      D24 fixtures and the integration rows.
- [ ] The handoff seals to the given key, and the in-test decrypt recovers the exact `jwt`.
- [ ] It redirects only to a target 02's allowlist accepts: exactly one configured
      `[cloud] app_callback_urls` https callback for `build=release`, and exactly
      `yaranapp://auth/callback` only for `build=dev`. Every other target, including a release
      request naming the custom scheme and a dev request naming https, gets
      `400 handoff_request_invalid` with no `Location`, proven over every case in
      `fixtures/uri/handoff-redirect.json`.
- [ ] The handoff answers 404 off the cloud Host and is rate limited.
- [ ] No token, key (the consent key included), state, csrf or cookie value appears in `yaran.log` (a test captures the
      tracing output).
- [ ] All new files are ≤500 lines with generated headers, `module-headers --check` passes,
      and touched oversize files gained wiring only.
- [ ] The §9 keys appear in the canonical config with inline comments and are reported by
      `yaran config diff`.

## Validation

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p yaran-core cloud::
cargo test -p yaran-web origin_match cloud_ jwks rate_window handoff_
cargo test -p yaran-web host_guard same_origin cross_origin
cargo deny check && cargo audit --deny warnings
node cloud/protocol/fixtures/access-jwt/generate.mjs --check   # fixtures reproducible
node tools/module-headers/bin/module-headers.mjs --check crates/yaran-core/src/cloud crates/yaran-web/src
node tools/module-headers/bin/module-headers.mjs --lines --check
grep -rn "Cf-Access-Jwt-Assertion\|CF_Authorization" crates/ | grep -v test   # only cloud_ingress/cloud_handoff
```

## Risks

| Risk | Mitigation |
|---|---|
| G2 shows cloudflared rewriting Host or speaking HTTP/2 to the origin | Primary: rely on cloudflared defaults (D4). Fallback: Phase 05 sets `originRequest.httpHostHeader` to the **same** public hostname and `http2Origin: false` explicitly. Nothing in this phase changes, because the Host still equals the bound hostname. |
| G1: the injected header JWT is not accepted as a cookie by Access | `cookie` is already in the payload (03 G1 fallback L1), checked against the header token, and `COOKIE_REQUIRED` makes it mandatory if G1 records L1. L2 (managed OAuth bearer via a native loopback proxy, Phase 15) still produces a `Cf-Access-Jwt-Assertion` at the origin, but its claim set is UNVERIFIED (`03-jwt-native.md` UNVERIFIED #2). If it lacks `email`, L2 owner matching falls back to `sub` recorded at pairing, a decision to be made only if G1 lands on L2. |
| G12: `exp` is much shorter than the session, so 4401 closes cause reconnect churn | Reconnects are cheap (replay plus attach epoch). If G12 measures churn below ~15 min, flip the `close_sockets_at_access_expiry` default to false and document that revocation then waits for the socket to drop. |
| G3/G13 change error presentation | The handoff's error redirect codes are Phase 02 registry entries, so new cases are additive. |
| A malicious app on the same phone registers `yaranapp://` and runs the handoff with its own key while the user's SSO session auto-approves | Release builds never use the custom scheme: the allowlist accepts only the configured https callback, which the OS delivers only to the app the publisher domain's association files vouch for (D8; Phase 21 hosts them). The custom scheme is accepted only when the request declares `build=dev`, and the consent page then warns. A hostile app that starts its own flow still has to get the person to press Continue on a page naming the device and host, so a silent SSO auto-approve can no longer complete it. Hijacking a legitimate flow yields ciphertext, and Phase 15 rejects callbacks whose `state` it did not issue. The dev-build residual is T36 (association files T63), reviewed in Phase 20. |
| The consent page's `form-action` blocks the 303 to the callback in some engine, or WebKit treats it differently | The page lists the exact callback origin (or `yaranapp:` for dev). Phase 19 runs the flow in Custom Tab, Auth Tab and `ASWebAuthenticationSession`. If an engine still blocks, `form-action` is dropped from that page and the decision recorded in 19's evidence; `frame-ancestors 'none'` keeps the clickjacking defence either way. |
| The consent tap on every renewal annoys people | **Resolved by D24** (02 §8.1): consent is remembered per (host, device key); a renewal skips the page only with a matching cookie and a verifying signature from the phone's hardware key, so the silent path stays closed for any other app. If the system browser does not keep the cookie (02 UNVERIFIED-5, measured in Phase 19), every handoff shows the page as before. |
| yaran never learns that the Worker revoked a device, so a revoked phone keeps its remembered consent on this machine | Accepted (02 Risks). A skip still needs a verified owner Access JWT, which the Worker's `sign_out_everywhere` revokes (06), and without D24 the same holder could tap Continue anyway, so the skip adds no reach. `yaran cloud rotate --consent-key` or a re-pair (09) drops every remembered consent here. Recorded for Phase 17's T36. |
| The process-wide rate limit lets one noisy phone starve another | Default 12/min against an expected ~1/day/phone. The key is configurable. |
| `ring::test::rand::FixedSliceRandom` is deprecated and may be removed | No longer used: Phase 02's `seal_with_secret` takes Z from the fixtures, the RFC 7520 §5.5 case is a Z/CEK fixture, and the route round trip uses ring's ordinary ECDH. |
| The Access login HTML or a 502 body reaches the web UI as an error toast | Handled by Phase 13's `jsonRequest` fixes, keyed off `Yaran-Refusal`. |
| Clock drift on the machine rejects valid tokens | Configurable skew (default 30 s). The refusal code `access-expired`/`access-not-yet-valid` is logged, and the troubleshooting doc names NTP (Phase 17). |
| JWKS endpoint outage | Fails closed with an explicit 503 sentence. The pre-warm outcome is reported by Phase 10 as a keyed warning on both surfaces. |

## References

- `00-README.md` D2, D3, D4, D5, D8, D17, D24; flows 2 and 4.
- `research/R1-server-core-cli.md` §3a–§3c, §4a–§4c, §8, Implications 5 and 6.
- `research/R4-cloudflare.md` Hard constraints 1, 3, 6, 14.
- `research/cloudflare-parts/03-jwt-native.md` §1–§3, §7, UNVERIFIED #2.
- RFC 7516 §5.1, RFC 7518 §4.6 and Appendix C, RFC 7520 §5.5.
- `02-protocol-contract.md` §2 (form-post CSRF and Origin rule), §4 (error registry), §6
  (`HandoffQuery`, `HandoffConsent`), §8 (allowlist, consent interstitial, JWE profile,
  `HandoffPayload`), §8.1 (device key, signature, consent cookie, skip rule), §11 (UA token), §12 (fixtures), §13 (`Yaran-Refusal`, 4401, Y2).
- WHATWG Fetch (append a request `Origin` header) and W3C CSP Level 3 (`form-action`), read
  2026-11-14.
- Cloudflare docs (validating JSON, origin parameters, session management), all fetched 2026-11-14.
- cloudflared `ingress/middleware/jwtvalidator.go` and `proxy/proxy.go` (master, 2026-11-14).
- CLAUDE.md: "Prefer explicit failure", "Sanitize attacker-controlled text", "Update the
  threat model when you add attack surface", "All settings are configurable", "A reconnect
  onto a different run … is the only reload in the app".

## Reconciliation notes (2026-11-14)

- R2: Goal 5, In scope and §7 rewritten for 02's Y1 (GET → consent interstitial naming device, platform, host and email) and Y1b (POST `HandoffConsent` with `csrf` → seal → 303); new CSRF store and consent-page modules (work item 11); cancel → `handoff_declined`.
- R2: redirect allowlist adopted (configured https callback for `build=release`, `yaranapp://auth/callback` only for `build=dev`); `app_callback_urls` read live (§1, §9); the acceptance line "never redirects anywhere but `yaranapp://auth/callback`" replaced by an allowlist criterion plus a consent criterion, both proven over `fixtures/uri/handoff-redirect.json` and new integration rows (not weakened).
- R2 (new design): consent page uses `Referrer-Policy: same-origin` (a `no-referrer` page sends `Origin: null` and its own POST would hit the existing origin check), `form-action` listing the callback, `frame-ancestors 'none'`; platform falls back to `short_device_label` because the system browser carries no app UA token; two Risks rows added.
- R1: §8 now uses 02's Rust sealer (`cloud::protocol::handoff`, `concat_kdf.rs`); `seal.rs` and `FixedSliceRandom` dropped; KDF/vector tests live in 02, route-level open and point-rejection tests stay here; RFC 7520 §5.5 case moved into 02's `fixtures/jwe/` (work item 1).
- R9: payload is `HandoffPayload` (`jwt` not `assertion`, `kind: "machine"`, optional `cookie`); `VerifiedAccess.assertion` → `jwt`; cookie checked against the header token per 03 G1 L1, `COOKIE_REQUIRED` constant for the L1 outcome.
- R9 / canonical names: `pk` is a `P256Point` (not a JWK), `state` 22–128, `invalid_pk` → `handoff_request_invalid`, bad redirect → 400 §4 envelope/HTML, `protocol_unsupported` for `v`; `AccessRejection::code()` uses 02's `signals.rs` strings; `SESSION_EXPIRED_CLOSE_CODE` from `yaran_core::cloud::protocol`; `close_sockets_at_expiry` → `close_sockets_at_access_expiry`; §8 "contract additions" replaced by a list of what 02 already defines; work item 1 became a conformance test.
- R20: Depends on line names what 02 now owns (`ring`/`base64` via 02 work item 10, not 09); Out of scope rows updated (02, 21); G1 "rung 1/3" → L1/L2 per 03.
- R14: T-IDs filled in (Out of scope, §10, work item 14, Risks): T25, T26, T36, T44, T45, T58 (T63 for association files).

### Straggler pass (2026-11-14)

- Straggler pass: redirect allowlist and the `app_callback_urls` row now name `publisher.json` as the compiled-in default's source (via 09), shared with the Worker's `APP_CALLBACK_URLS` (07/18).
- Straggler pass: Validation uses 01's real CLI (`node tools/module-headers/bin/module-headers.mjs`) (R20).
- D24: Y1 validates `dk`/`dts`/`dsig` after `pk` (codes `handoff_device_key_invalid`, `handoff_signature_malformed`, `handoff_timestamp_skewed`, never refusals), verifies `dsig` over 02's canonical string with the bound hostname, and skips the consent page under 02's rule (rules 1–4; Worker-only rule 5 n/a) with the same seal-and-302 as Continue.
- D24: csrf now binds `dk`'s fingerprint and the signature verdict; Y1b requires the same `dk` and sets `__Secure-yaran-handoff-consent` only after an explicit Continue on a verified GET, MACed with 09's `handoff_consent_key` read per request, so a rotation (`yaran cloud rotate --consent-key`) or re-pair invalidates at once.
- D24: the "renewals always tap" paragraph and Risks row replaced (resolved); new Risks row for the accepted gap that yaran never learns of Worker device revocation; 13 integration rows, a route-level fixture test, one acceptance item, and the consent acceptance gained the skip exception without dropping its criterion.

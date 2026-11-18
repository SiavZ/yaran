# Phase 03 — Platform verification gates

**Track:** Wave A (parallel, no dependencies) · **Parallel-safe with:** 01, 02
**Depends on:** nothing (a maintainer staging Cloudflare account, an Apple developer account and test devices, listed in §Prerequisites) · **Blocks:** the gate-dependent choices in 05, 06, 07, 08, 10, 11, 13, 14, 15, 16, 18; Phase 19 cannot start until every gate is closed

## Goal

Prove or disprove, on live Cloudflare accounts and real devices, every external platform
fact the product depends on that the research could not confirm from documentation. Each
gate ends in one recorded verdict: **PASS** (the primary path in the affected phases
stands) or **FALLBACK ADOPTED** (the fully designed fallback written below, and already
specified in the affected phase, becomes the path). Nothing in Wave B waits on this phase
to start coding: every affected phase builds against both outcomes. This phase decides
which one ships.

The procedures are committed scripts and committed evidence, not one-off console sessions,
so that any maintainer can re-run a gate when Cloudflare, Android, iOS or a browser changes
underneath us. Phase 19 re-runs the HTTP-level gates nightly as drift checks (19 §WI-9).

## Evidence

Research state each gate starts from. All URLs were read on 2026-11-14 unless stated otherwise.

- **Header vs cookie (G1).** "Requests made through a browser will also pass the token as a
  `CF_Authorization` cookie" (validating-json, updated 2026-11-02). This implies the same
  token, but no page says the two values are byte-identical. No page documents setting the
  cookie yourself.
- **What cloudflared does (G1).** On a redirect to `/cdn-cgi/access/login`, cloudflared presents the
  org token as the `CF_Authorization` cookie (cloudflared `token/token.go`, `exchangeOrgToken`).
  It also defines a `Cf-Access-Token` header (`carrier/carrier.go`). On a WebSocket upgrade it
  treats a 302 to `/cdn-cgi/access/login` as "needs a token" (`carrier/websocket.go`). That
  means Access evaluates the upgrade request, so the cookie should count there too, but this
  is UNVERIFIED. R5 §2 items 14 and 16–17; cloudflare-parts/03 §1 and §6.
- **Managed OAuth (G1 fallback).** `oauth_configuration` on self-hosted apps: dynamic client
  registration, PKCE S256, exact-match custom-scheme redirects, opaque `oauth:` bearer tokens
  (15 min default) with refresh. The origin still receives `Cf-Access-Jwt-Assertion`. The docs
  page says "Use this flow for MCP servers" (managed-oauth, updated 2026-11-03). The launch
  changelog says it works on "any self-hosted Access application" (2026-03-20), and the SDK
  marks the field Beta (`cloudflare@7.3.0`). Whether a bearer token works on a WebSocket
  upgrade is UNVERIFIED. A WebView cannot add an `Authorization` header to a navigation or a
  WebSocket, which is why the fallback needs a native loopback proxy (§G1 fallback L2).
- **Origin hop (G2), read from cloudflared source at tag 2026.11.0.**
  - The incoming Host is copied through (`connection/quic_connection.go:364,372`).
    `httpHostHeader` moves the original to `X-Forwarded-Host` (`ingress/origin_proxy.go:47-52`).
  - The origin transport only attempts HTTP/2 over TLS (`ingress/origin_service.go:346-357`),
    so an `http://` origin always gets HTTP/1.1.
  - WebSockets go out as an HTTP/1.1 Upgrade (`proxy/proxy.go:250-322`).
  - **`originRequest.access` is attached only from each ingress rule's own `originRequest`,
    never from the tunnel-wide block** (`ingress/ingress.go:429-437`).
  - Responses: a missing JWT gets 403 with an empty body; a wrong `aud` gets 403; a bad
    signature or an expired token yields an origin error that is likely a 502
    (`proxy/proxy.go:88-101`, `connection/http2.go:337-350`).
  - Release 2026.11.0 fixed an Access bypass via matrix parameters (VULN-170057), so the pin
    floor is ≥ 2026.11.0. R4 Hard constraint 13.
- **Access responses (G3).**
  - A navigation gets a 302 to `<team>.cloudflareaccess.com/cdn-cgi/access/login…`.
  - A CORS preflight gets a 403 unless `options_preflight_bypass` or `cors_headers` is set (cors doc).
  - No documented `Accept` or `X-Requested-With` switch exists.
  - Strict service-token mode (changelog 2026-10-02; on and permanent for orgs created on or
    after 2026-10-05) changes only requests that carry service-token headers. It does not
    change the identity/cookie flow.
  - With Managed OAuth on, non-browser clients get a 401 with `WWW-Authenticate`.
- **APNs from a Worker (G4).** Apple requires HTTP/2. workerd has no HTTP/2, but "in production
  it sends requests through Cloudflare's proxy stack, which (apparently) upgrades to HTTP/2"
  (Kenton Varda, workerd #4841, still open). Local `wrangler dev` fails. Cloudflare Containers
  have been GA since 2026-04-13, need Workers Paid, and allow any outbound host with
  `enableInternet`. R4 Hard constraint 12.
- **Embedded FCM distributor (G5).** `org.unifiedpush.android:embedded-fcm-distributor` 3.1.0
  (Maven Central, 2026-06-23).
  - Its POM pulls no `firebase-messaging`. It registers with Google Play Services directly,
    passing the app server's VAPID public key, and builds a `https://fcm.googleapis.com/fcm/send/<id>`
    endpoint (`Constants.kt`, `c2m/C2mRequests.kt`).
  - That path is reverse-engineered from microG's notes and not documented by Google.
  - `connector` latest is 3.3.5.
- **Second WebView without a bridge (G6).** Capacitor latest is 8.6.2; 9.0.0-rc.0 shipped on 2026-11-12.
  - `@capacitor/inappbrowser` 4.1.0 `openInWebView` already runs a native WebView with no JS
    interface (`OSIABWebViewActivity.kt`). On Android 9+ it defaults to a separate process
    (`isIsolated`), where `CookieManager` is a different singleton, so D9's own plugin must run
    in-process.
  - On Android WebView, M139 shrinks the visual viewport for the IME, and that applies to all
    WebViews from M144 (chromium `android_webview/docs/insets.md`).
  - Whether `interactive-widget` works in WebView is UNVERIFIED. Chrome's own note says the
    resize change does "not affect WebView".
  - iOS enables file uploads by default when `runOpenPanelWith` is not implemented.
- **F-Droid (G7).** fdroiddata's React Native template runs `npm install` and
  `scandelete: node_modules`. The Capacitor app MapComplete avoids npm by committing the built
  bundle and the vendored `@capacitor/android`, and ships with `Binaries:` and
  `AllowedAPKSigningKeys`. When a developer-signed build does not reproduce, "F-Droid will skip
  publishing this version" (Reproducible_Builds). Verification requires apksigner from
  build-tools 34.
- **Public paths (G8).**
  - `destinations[].overrides[] {behavior:"public", path_pattern}` exists only in the API
    schema (SDK `SelfHostedApplication.PublicDestination.Override`). No prose page documents it.
  - The documented alternative is a path-scoped app with a Bypass policy, where "the more
    specific rule takes precedence" (app-paths, updated 2026-04-17). Bypass requests are not logged.
- **Token template (G9).** The account-owned template URL form and the
  `GET /accounts/{id}/tokens/permission_groups` listing are documented
  (account-owned-token-template). Only DNS Read, Zone Read and Workers Scripts Write have IDs in
  the official docs. The rest of cloudflare-parts/04 §2's table comes from a datamine and is UNVERIFIED.
- **Identity providers (G10).** Since 2026-06-18 a fresh org defaults to the Cloudflare IdP
  (`type:"cloudflare"`, account members only), and One-time PIN is "not added automatically".
  It is added with `POST /accounts/{id}/access/identity_providers {"type":"onetimepin"}`. The
  Free plan still needs a payment method. The SDK and the API reference disagree on whether
  `auth_domain` and `name` are required to create the org.
- **Deploy button (G11).** The subdirectory must be "fully isolated … including any
  dependencies", and monorepo support is described as partial (deploy-buttons, updated
  2026-10-12). Secrets are prompted from `.dev.vars.example`. D1 is provisioned and its ID is
  written into the clone. Migrations run only through the `deploy` script. No sync mechanism exists.
- **Session expiry (G12).** App token lifetime is taken from the policy, then the app, then 24h.
  `exp = iat + duration` is inferred, not documented. An open WebSocket after expiry is not
  documented. The network drops WebSockets on code releases.
- **System-browser auth (G13).**
  - iOS: `ASWebAuthenticationSession.Callback.https(host:path:)` and `.customScheme` need iOS
    17.4+, which is the app's minimum (D8), so the older `init(url:callbackURLScheme:completionHandler:)`
    path is not used. Whether `.https` also needs the host in the app's associated domains
    (`webcredentials:`), as the Apple sample suggests, is UNVERIFIED.
  - Android: Auth Tab needs androidx.browser 1.9.0+ (1.10.0 is stable) and Chrome 137+. It
    falls back to a Custom Tab on its own, with the result arriving through the manifest
    intent-filter. Auth Tab's https-redirect form (verified through Digital Asset Links, which a
    release build uses for `https://<publisher-domain>/auth/callback`, D8) and Auth Tab support
    outside Chrome (Vanadium, Firefox, Brave, Samsung) are UNVERIFIED. How App Link
    verification behaves on GrapheneOS (no Google verifier) is UNVERIFIED.
- **Custom domain (G14).** `PUT /accounts/{id}/workers/domains {hostname, service, zone_id}`
  lists Workers Scripts Write as its only permission. Whether zone permissions are also
  required is UNVERIFIED. Wrangler does not use this endpoint: in a non-TTY build (Workers
  Builds included) it sets `override_existing_dns_record` to true
  (workers-sdk `packages/deploy-helpers/src/triggers/publish-routes.ts`). A `custom_domain` route
  in a shipped wrangler config could therefore silently replace a deployer's DNS record.
- **Repo facts.**
  - No `tools/cloud-gates/` and no `docs/plans/phoneapp/evidence/` exist yet.
  - Tool scripts in `tools/` are bash or POSIX sh with a `#` prose header after the shebang and
    `set -euo pipefail` (`tools/preview-env/up.sh:1-20`, `tools/reload-live-check.sh:1-12`).
  - The yaran default port is 3890 (`crates/yaran-core/src/config.rs:2242`).
  - The repository `SiavZ/yaran` is public (`gh api repos/SiavZ/yaran --jq .visibility`, read
    2026-11-14), so a Deploy-button URL can point at a branch subdirectory of it.

## In scope

- `tools/cloud-gates/`: shared libraries, one script per gate, an echo origin, gate probe Workers, and one
  mobile spike app (Capacitor 8.6.2, the pin in 14 and 16, with in-repo spike plugins) that serves G1, G3, G5, G6 and G13.
- `docs/plans/phoneapp/evidence/`: a result record per gate, redacted raw output, and a redaction check.
- The gate-tracking table (§Tracking), kept current in this file. A gate closes in a PR that
  also edits every affected phase file named in its row. When a fallback departs from a decision
  D1–D23, that PR also edits `00-README.md` (the README's own rule).

## Out of scope

- Production implementations of the paths being proven: the provisioning client (05), the
  handoff endpoints (06, 11), machine-view (15), push senders and clients (08, 16), and the
  release pipelines (18). The gate code here is a probe that produces evidence, not a library
  those phases import. Phase 15 may lift spike code into a real plugin, rewritten to that
  phase's standards.
- The recurring E2E suite (19), which reuses `tools/cloud-gates/lib/` and the HTTP-level gate scripts.
- The publisher production relay and accounts (21).

## Design

### Prerequisites (the maintainer provides these; procedures refer to them by placeholder)

| Name | What | Used by |
|---|---|---|
| Staging account A | Cloudflare account with Zero Trust enabled after 2026-10-05 (so strict service-token mode is on), Workers Paid (Containers and the 30 s CPU limit), a payment method, and one zone `<staging-zone>` | all CF gates |
| Staging account B | Any account whose Zero Trust org predates 2026-10-05. Optional: when none exists, G3 records "not available" and the doc-based expectation, and phase 13 handles both behaviours | G3 |
| Scratch account C | Fresh account with no Zero Trust org | G10 |
| Gate runner token | Account-owned token covering the union of permissions in §G9, held only in the operator's environment | scripts |
| Apple developer account | APNs auth key (.p8), a test bundle ID with Push, App Groups and Associated Domains (`applinks:` and `webcredentials:` for `<gate-callback-host>`) | G4, G13 |
| Devices | Apple-silicon Mac (macOS 13+) with Xcode 26.x; iOS 17.4 (the app's minimum, D8) and latest iOS simulators; at least one physical iPhone; the shared physical Pixel 8a on GrapheneOS (reached through the repo user's phone-testing workflow, with sandboxed Google Play installed for G5); an Android emulator with a `google_apis_playstore` image; a stock-Android device with Google Play where available | G1, G3, G5, G6, G13 |
| Test identity | A sign-in the operator can complete by hand. One-time PIN to a maintainer mailbox is enough for gates; Phase 19 automates sign-in with its own test IdP | G1, G3, G8, G12 |

Placeholders follow D16: `<staging-zone>`, `<team>`, `<machine-host>` (for example
`gate-m1.<staging-zone>`), `<cp-host>` (for example `gate-cp.<staging-zone>`) and
`<gate-callback-host>` (for example `gate-cb.<staging-zone>`, standing in for
`<publisher-domain>` in G13). No real publisher value appears in the repo.

### Directory layout

```text
tools/cloud-gates/
├── README.md                    how to run a gate, prerequisites, env vars, evidence rules
├── env.example                  every variable a script reads, commented; never real values
├── run.sh                       `run.sh G02` dispatcher + `run.sh --recheck` (HTTP-level gates only, used by 19)
├── lib/
│   ├── common.sh                env checks, logging, evidence dir, `record` (tee through redact)
│   ├── cf.sh                    curl wrapper for api.cloudflare.com: auth header, error envelope, jq
│   ├── jwt.sh                   decode JWT header/claims without verifying (base64url + jq)
│   ├── redact.sh                masks JWTs, oauth: tokens, tunnel tokens, API tokens, device tokens
│   └── access.sh                create/delete test Access apps, reusable policies, tunnels, DNS (tagged gate-<run>)
├── origin/
│   ├── package.json             pins `ws` only; Node from the repo's CI pin (22)
│   └── echo-origin.mjs          HTTP + WebSocket echo: request line, HTTP version, all headers, upgrade headers
├── workers/
│   ├── apns-probe/              G4: minimal Worker, ES256 JWT via WebCrypto, POST to APNs sandbox
│   ├── public-path-probe/       G8: Worker on <cp-host> echoing path + whether Cf-Access-Jwt-Assertion arrived
│   ├── domain-probe/            G14: Worker that attaches its own custom domain with a supplied token
│   ├── deploy-probe/            G11: isolated subdir app (own lockfile, D1 binding without id, migrations, .dev.vars.example)
│   └── callback-probe/          G13: Worker on <gate-callback-host> serving assetlinks.json, apple-app-site-association, a consent page and /auth/callback
├── spikes/mobile/               Capacitor 8.6.2 app + spike plugins (Kotlin, Swift), flavors foss/play, e2e-free
├── g01-cookie-injection.sh  …  g14-custom-domain.sh   one per gate (HTTP/API halves; device halves are checklists in the script output)
└── tests/
    ├── redact_test.sh           fixtures with planted secrets; asserts every one is masked
    └── lib_test.sh              jwt.sh decoding, cf.sh error envelope parsing against canned responses

docs/plans/phoneapp/evidence/
├── README.md                    evidence rules: redaction, what to commit, naming
├── check-evidence.sh            CI check: no unredacted secret patterns under evidence/
└── G01-cookie-injection/ … G14-custom-domain/
    ├── RESULT.md                verdict record (template below)
    └── run-YYYY-MM-DD/          redacted logs, screenshots, HAR excerpts
```

Every code file above carries the 00-CONVENTIONS §2 header with the
`<module-headers:begin/end>` block. Shell scripts use a `#` block after the shebang, matching
the existing tools style (`tools/preview-env/up.sh:1-20`). `.mjs`, `.ts`, `.kt` and `.swift`
files use their language's form. Each file is planned at or below 500 lines. The largest are
`spikes/mobile/android/.../MachineViewSpike.kt` (~350) and `g01-cookie-injection.sh` (~300).
`tools/cloud-gates/**` and `docs/plans/phoneapp/evidence/check-evidence.sh` join the Phase 01
opt-in manifest.

**Why bash plus Node.** The repo's tools precedent is shell (above). The gates are mostly
`curl`/`jq` against the Cloudflare API, which shell expresses with the least code. Node is
used only where a protocol library is needed: WebSocket in the echo origin, and `web-push` in
G5 via `npx web-push@3.6.7`, run from `tools/cloud-gates/origin/package.json` scripts. Node is
already a CI dependency (`pr.yml` setup-node 22). Python is not introduced.

### Secrets and evidence rules

- Secrets are read only from the environment or from stdin prompts (`read -rs`), never from
  argv, matching D5's spirit for test tooling.
- Every line a script records passes through `lib/redact.sh`. It masks:
  - JWTs (`eyJ…\.eyJ…\.[A-Za-z0-9_-]+`, keeping the decoded non-secret claims `aud`, `exp`,
    `iat`, `iss`, `type`, with `email` replaced by `<owner>`);
  - `oauth:` tokens, Cloudflare API tokens, tunnel tokens (base64 JSON with `a`/`t`/`s` keys),
    APNs/FCM device tokens, and VAPID private keys.
- `check-evidence.sh` greps `docs/plans/phoneapp/evidence/` for the same patterns and fails CI.
  Phase 18 wires it into the always-reporting aggregator.
- Test resources are named `gate-<gate>-<run-id>` and deleted by each script's `trap` cleanup.
  `lib/access.sh sweep` deletes anything tagged `gate-` older than 24h, for the case where a run died.

### RESULT.md template (every gate)

```text
# G<NN> <title>: <PASS | FALLBACK ADOPTED (level) | OPEN>
Date / operator role / commit of tools/cloud-gates used
Versions: cloudflared, wrangler, Capacitor, Android (API, WebView M-version, browser + version),
          iOS + Xcode, account org creation date (strict mode yes/no)
Procedure: `tools/cloud-gates/run.sh G<NN>` + device checklist steps performed
Observations: table of each pass criterion → observed value → met?
Verdict and decision owner sign-off; affected-phase PRs updated (links)
Re-run triggers: what upstream change should make someone run this again
```

### Gate closure rule

1. Each gate has a **decision owner**: the lead of its primary affected phase. The
   **maintainer** signs off every verdict, because some fallbacks touch publisher
   infrastructure or decisions.
2. A gate closes only with a committed `RESULT.md` and a verdict: PASS, or FALLBACK ADOPTED
   with its level named.
3. The closing PR edits every affected phase file so that it states which path is now the path
   and marks the other as the documented alternative. When a fallback contradicts a decision
   D1–D23, the same PR amends `00-README.md`. Fallbacks that would do so are flagged
   **[changes Dn]** below.
4. **Phase 19 cannot start until all fourteen gates are closed.** A gate stuck on missing
   prerequisites past its target week becomes FALLBACK ADOPTED by default, on the maintainer's
   sign-off, because every fallback is fully designed.
5. Order (target weeks from phase start):
   - Week 1: G9, G10, G14, G11 (the setup path; G9's token also runs the other gates), G2, G8
   - Week 2: G1, G3, G12, G4
   - Week 3: G5, G6, G7, G13

---

## Gates

Each gate lists its question, its procedure (script plus device checklist), its pass
criteria, the phases it affects, the primary path, the fallback, and its decision owner.

### G1 — An injected `CF_Authorization` cookie is accepted by Access for HTTP and WebSocket in Android WebView and WKWebView

**Procedure.**

`g01-cookie-injection.sh` covers the HTTP half:
1. Provision a tunnel, a proxied CNAME and a self-hosted Access app on `<machine-host>` with
   binding cookie off and an owner-only reusable policy. Use the per-rule
   `originRequest.access {required, teamName, audTag}` from G2.
2. Run `cloudflared tunnel run --no-autoupdate` with `TUNNEL_TOKEN` in the environment,
   pointing at `origin/echo-origin.mjs` on 127.0.0.1:3890.
3. Prompt the operator to sign in on `https://<machine-host>/echo` in a desktop browser. The
   echo page shows both the `Cf-Access-Jwt-Assertion` header value and the `CF_Authorization`
   cookie value as received by the origin. The script compares their SHA-256 values locally;
   the operator pastes them on stdin.
4. Record the `Set-Cookie` attributes from the `/cdn-cgi/access/authorized` hop (HAR excerpt,
   redacted): Secure, HttpOnly, SameSite, Domain present or host-only, Path, Expires.
5. With `curl`, record status codes for `GET /` and for a WebSocket upgrade on `/ws`
   (`--http1.1` with `Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Version: 13`,
   random key) in each of these cases:
   - no credentials;
   - `Cookie: CF_Authorization=<header JWT>`;
   - `Cookie: CF_Authorization=<cookie JWT>`;
   - `cf-access-token: <JWT>`;
   - binding cookie switched on.
6. Repeat step 5 against the real yaran UI: the preview-env container on Linux, with
   cloudflared started by hand, and the tunnel hostname added through `--bind`/`allowed_hosts`
   for the gate only. Exercise `/api/v1/bootstrap`, `/ws/events` and `/ws/sessions/{id}/pty`
   (routes at `crates/yaran-web/src/server.rs:776-814`).

`spikes/mobile` covers the device half (checklist printed by the script):
1. The spike's in-process machine-view (Kotlin Activity in the main process; Swift
   `UIViewController` with its own `WKWebView`, no Capacitor bridge) asks for a JWT on stdin
   through a debug screen.
2. It sets the cookie with the attributes from step 4. On Android it uses
   `CookieManager.setCookie(url, value, callback)` then `flush()`. On iOS it uses
   `WKHTTPCookieStore.setCookie` and loads only in the completion handler.
3. It loads `https://<machine-host>/`, the yaran UI behind the gate tunnel, and records:
   - the first-request `Cookie` seen by the echo log;
   - whether the HTML navigation returned 200;
   - whether `fetch('/api/v1/bootstrap')` returned 200;
   - whether `/ws/events` and the PTY socket reached `101` and streamed.
4. Run on: an Android 15 or 16 emulator (WebView ≥ M144), the GrapheneOS Pixel (Vanadium
   WebView), iOS 17.4 and latest iOS simulators, and a physical iPhone.

**Pass criteria.**
- Header and cookie hashes are equal, or step 5 shows both values accepted.
- On every device: injected cookie → navigation 200, XHR 200, events socket 101, PTY socket
  101 with output streaming.
- With no cookie → 302 to `<team>.cloudflareaccess.com`.
- With binding cookie on, the injected cookie is rejected (this confirms D2's "binding off" is load-bearing).

**Affects.** 15 (cookie injection), 06 and 11 (what the handoff seals), 05 (Access app
settings), 13 (expiry detection). **Owner:** Phase 15 lead.

**Primary path (L0).** The handoff seals the `Cf-Access-Jwt-Assertion` value (D8), and
machine-view injects it as a host-only `CF_Authorization` cookie for `<machine-host>`. The
attributes copy what Access itself set (step 4), `Path=/`, and `Expires` equals the JWT `exp`.

**Fallback ladder.**
- **L1: the header and cookie differ, and only the cookie value is accepted.** The sealed
  `HandoffPayload` already carries the optional `cookie` field (02 §8): the raw
  `CF_Authorization` value from the consent POST's own `Cookie` header (Y1b `POST
  /__yaran/handoff`, W16b `POST /v1/handoff`), next to `jwt`. The system-browser request
  carries the cookie Access just set on that host; G1 step 1 records whether it reaches the origin.
  - Phase 11 and Phase 06 fill `cookie` from `Cookie` → `CF_Authorization`. They still require a
    verified `Cf-Access-Jwt-Assertion` on the same request (D3). Once L1 is adopted they refuse
    to seal when the cookie is missing or its `sub`/`email`/`aud` differ from the verified
    assertion, and Phase 15 injects `cookie` instead of `jwt`.
  - No wire change and no other phase changes. This stays within D8.
- **L2: no injected cookie is accepted on the WebSocket upgrade, or anywhere.**
  **[changes D8 for machine hosts]** This uses Managed OAuth bearer tokens through a native
  loopback proxy:
  - **Provisioning (05).** Each machine Access app gets `oauth_configuration
    {enabled:true, dynamic_client_registration:{enabled:true, allowed_uris:["https://<publisher-domain>/oauth/callback"],
    allow_any_on_localhost:false, allow_any_on_loopback:false}, grant:{access_token_lifetime:"15m",
    session_duration:<settings>}}`. Builds compiled without a publisher domain register
    `yaranapp://oauth/callback` instead (02 §10, the same release/dev split as the handoff callback).
  - **Auth (15).** Discovery runs from the 401 `WWW-Authenticate resource_metadata`. The app
    registers once per machine host (`token_endpoint_auth_method:"none"`, RFC 8707 `resource`),
    then runs authorization-code + PKCE in ASWebAuthenticationSession / Auth Tab (G13).
    Refresh tokens are stored in the secure store (14).
  - **Proxy (15, new module per platform, each ≤500 lines).** It binds `127.0.0.1` on a port
    that is stable per machine and stored in preferences, so the WebView origin (and its
    localStorage) survives restarts; when that port is busy it moves and documents the loss.
    - machine-view loads `http://127.0.0.1:<port>/`.
    - Per request, the proxy requires a 256-bit session cookie the app set on
      `http://127.0.0.1:<port>` before loading, because other apps on the device can reach loopback.
    - It rewrites `Host` to `<machine-host>` and `Origin` from `http://127.0.0.1:<port>` to
      `https://<machine-host>`, which keeps yaran's exact Origin==Host check (D4) intact.
    - It strips its own cookie, adds `Authorization: Bearer oauth:…`, and forwards over TLS
      with the platform's trust store.
    - For an Upgrade it forwards the handshake with the same rewrites, then pipes bytes both
      ways. It rewrites `Location` headers that point at `<machine-host>`.
    - It refreshes the token ahead of `expires_in` and on a 401. A refresh failure surfaces the
      same "Sign-in needed" state as Phase 13.
  - **Platform config (15).** Android: a network security config permitting cleartext to
    `127.0.0.1` only. iOS: `NSAllowsLocalNetworking`.
  - **Checks (15).** G1-L2 verifies `window.isSecureContext === true` on `http://127.0.0.1` in
    both WebViews (clipboard and other APIs need it) and verifies a bearer-authenticated
    WebSocket returns `101`.
  - **D3 still holds.** The origin receives `Cf-Access-Jwt-Assertion` from Access.
  - **L2 fails if** Managed OAuth rejects bearer tokens on the WebSocket upgrade. Then the
    proxy speaks HTTP to the origin through Access and WebSockets are unusable through Access,
    so the gate escalates to the maintainer as a product blocker. There is no silent degradation.

### G2 — cloudflared preserves Host, speaks HTTP/1.1 to the origin with WebSockets, and per-rule `access.required` + `audTag` rejects a missing or invalid JWT

**Procedure.** `g02-cloudflared-origin.sh`:
1. Create a tunnel (`config_src:"cloudflare"`) and `PUT .../configurations` with a single
   rule: `{hostname:<machine-host>, service:"http://127.0.0.1:3890"}` (05's shape, with 02's default `origin_port`) followed by
   `{service:"http_status:404"}`.
2. Start the echo origin on 3890. Run cloudflared at the pinned floor (≥ 2026.11.0) with
   `--no-autoupdate --loglevel debug`.
3. `curl -v https://<machine-host>/echo`. Assert the echo shows `GET /echo HTTP/1.1` and
   `Host: <machine-host>`, and record every `Cf-*` and `X-Forwarded-*` header.
4. Set `httpHostHeader:"localhost:3890"` and assert the override arrives along with
   `X-Forwarded-Host`. This shows the field must stay unset (D4).
5. Set `http2Origin:true` and assert the origin still sees HTTP/1.1.
6. Upgrade on `/ws` with `websocat`. Assert the echo origin logs `Upgrade: websocket` and
   frames round-trip.
7. Add **per-rule** `originRequest.access {required:true, teamName:<team>, audTag:[<aud>]}`
   with an Access app on the hostname. Record the status and body for:
   - a direct request with no JWT;
   - `Cf-Access-Jwt-Assertion: garbage`;
   - a valid JWT from a different app (wrong `aud`);
   - an expired JWT.
8. Move `access` to the tunnel-level `originRequest` only and repeat step 7, to confirm that
   tunnel-level does **not** enforce.
9. Run the same Host and Origin check against yaran in preview-env, to confirm yaran's
   same-origin check accepts `Origin: https://<machine-host>` with the live host rule (Phase 11).

**Origin address.** Production ingress is `http://127.0.0.1:<origin_port>` (05 §3, 09/10,
Phase 19 hook H2), and steps 1–8 use exactly that service string, so the gate measures the
shape that ships; it does not need a second run against `localhost`, which no phase writes.
Step 4's `localhost:3890` is a deliberate `httpHostHeader` override probe, not the service
address. Any earlier evidence recorded with `service: "http://localhost:<port>"` is re-run
with `127.0.0.1` before G2 can be marked PASS.

**Pass criteria.**
- Host is preserved.
- The origin sees HTTP/1.1 in all configurations.
- WebSockets work with no extra option.
- With per-rule access: missing JWT → 403; wrong aud → 403; bad or expired JWT → refused
  (status recorded, expected 502).
- Tunnel-level-only access does not enforce (if it does enforce, record it; the design keeps
  per-rule access either way).

**Affects.** 05 (ingress body), 10 (version floor), 11 (host rule, Origin check). **Owner:** Phase 05 lead.

**Primary.** Per-tunnel-route `originRequest.access {required, teamName, audTag}` in every
machine's own ingress rule (never only the tunnel-wide `originRequest`, which step 8 shows
cloudflared ignores), no `httpHostHeader`, `http://127.0.0.1:<origin_port>`, and a **minimum
cloudflared of 2026.11.0**. Phase 05's ingress body states the per-route placement and Phase 10
pins cloudflared and refuses to start a leg on a binary older than the minimum (R16). **Fallback** (Host is rewritten, or
HTTP/2 or h2c turns out to be negotiated): set `httpHostHeader:"<machine-host>"` explicitly,
which is an equivalent value, and have yaran's live host rule also accept
`X-Forwarded-Host == <machine-host>` only when the peer is loopback and the JWT verifies. If
the origin sees HTTP/2, it has to come in over TLS, which our `http://` service never offers,
so no fallback is needed for that case. If `access.required` does not enforce at all, D3's
yaran-side JWT verification becomes the only origin-side check. Phase 11 then makes JWT
verification unconditional on the cloud hostname, which it already is, and Phase 17 records
the reduced defence in depth under T25 (the tunnel-exposure threat's residual risk).

### G3 — Access responses for unauthenticated and expired requests, by request kind and org age

**Procedure.** `g03-access-responses.sh` builds a matrix:
- **Credential:** none, expired JWT, garbage JWT, revoked JWT (after `revoke_tokens`).
- **Request kind:**
  - navigation (browser `User-Agent`, `Accept: text/html`);
  - fetch (`Accept: application/json`);
  - XHR (`X-Requested-With: XMLHttpRequest`);
  - WebSocket upgrade;
  - CORS preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`);
  - each with and without a service-token header pair.
- Record status, `Location` host and path, `WWW-Authenticate`, the body content type, and the first 200 bytes.

Run it on account A (strict), account B (older; if B is missing, record "not available"), and
on account A with `oauth_configuration.enabled=true`.

The device half runs the spike page inside machine-view after the cookie expires (G12 makes a
short-lived token). Record what `fetch(url, {redirect:"manual"})` resolves to (expected
`type:"opaqueredirect"`, `status:0`) and what a `WebSocket` reports (`onerror` and close code)
in Android WebView and WKWebView.

**Pass criteria.** Not pass/fail. The gate passes when the matrix is complete and committed,
because Phase 13's probe classifier is written from it.

**Affects.** 13 (session-expiry probe: opaqueredirect / non-JSON / 401 / 403), 15 (renewal
triggers on navigation to `*.cloudflareaccess.com`), 04 (the Worker's own API under strict
mode). **Owner:** Phase 13 lead.

**Primary.** Phase 13 treats each of these as "Sign-in needed": an opaqueredirect, a non-JSON
200, a 401, a 403, and a socket that fails right after a successful attach. **Fallback**
(responses vary by org age or by request header): the classifier keys on the union of
observed responses. Phase 13 adds one fixture per recorded row, so the classifier is
table-driven from this evidence and any new row is a fixture, not a code path.

### G4 — A deployed Worker sends to APNs over HTTP/2

**Procedure.** `workers/apns-probe/` (TypeScript, one file ≤200 lines, secrets `P8`, `KID`,
`TEAM`, `TOPIC`):
1. Import the key with `crypto.subtle.importKey('pkcs8', …, {name:'ECDSA', namedCurve:'P-256'})`.
2. Sign the ES256 provider JWT.
3. `POST https://api.sandbox.push.apple.com/3/device/<token>` with `apns-topic`,
   `apns-push-type: alert`, `apns-priority: 10`, and a body with `mutable-content: 1`.
4. Return the status, the `apns-id` header and the body.

`g04-apns.sh`:
1. `wrangler deploy`.
2. Send a push to a token logged by `spikes/mobile` on an iOS 17.4+ simulator on the Apple-silicon Mac.
3. Send to a physical iPhone token.
4. Send a garbage token (negative control).
5. Send 50 sequential pushes.
6. Repeat under `wrangler dev` and `wrangler dev --remote`.

**Pass criteria.**
- The deployed Worker gets 200 with an `apns-id` and the notification shows on the simulator and the device.
- The garbage token gets 400 `{"reason":"BadDeviceToken"}`, which proves APNs answered over HTTP/2.
- 50 sends complete with no connection errors.
- The local `wrangler dev` failure is recorded so Phase 08's docs can warn about it.

**Affects.** 08 (relay transport), 16 (none if PASS), 21 (relay hosting cost). **Owner:** Phase 08 lead.

**Primary.** The relay Worker calls APNs with `fetch`.

**Fallback.** An APNs sender container. Phase 08 keeps the relay Worker for everything except the final hop:
- **The relay Worker keeps:** endpoint minting, VAPID verification, rate limits and 410 handling.
- **It hands the container only** `{device_token, apns_headers, ciphertext_body}`, through a
  Containers binding (`getContainer`, `enableInternet:true`, smallest "lite" instance).
- **The container image** is a Node `http2` sender (one file ≤300 lines in
  `cloud/push-relay/apns-sender/`, plus a Dockerfile). It holds the `.p8` in container secrets,
  caches the provider JWT for under 60 min, keeps one HTTP/2 session, and runs no logging of tokens.
- **The same image runs on a small VM** behind a Cloudflare Tunnel with Access service auth
  between relay and VM. That is the second-level fallback when Containers are unavailable on
  the publisher's plan.

Phase 21 provisions whichever level the verdict names.

### G5 — The Play build's embedded FCM distributor accepts standard VAPID Web Push with no publisher FCM credentials

**Procedure.**
- **Spike setup.** The `spikes/mobile` play flavor depends on
  `org.unifiedpush.android:connector:3.3.5` and `embedded-fcm-distributor:3.1.0`, and has no
  `google-services.json`. Run `npx web-push generate-vapid-keys`, register with the public key,
  and show the endpoint, `p256dh` and `auth` on a debug screen. No secrets are involved, but the
  values are redacted in evidence anyway.
- **`g05-embedded-fcm.sh`.**
  1. `npx web-push send-notification --endpoint … --key … --auth … --vapid-subject mailto:gate@example.invalid --vapid-pubkey … --vapid-pvtkey … --urgency high --payload '{"t":"gate"}'`.
  2. Sign with a different VAPID key (negative control).
  3. Doze: `adb shell dumpsys deviceidle force-idle`, then a high-urgency send.
  4. `am force-stop`, then a send. Expect no delivery, and record it.
- **Devices.** The `google_apis_playstore` emulator, the GrapheneOS Pixel with sandboxed Play,
  and a device with no Play Services, which should fail registration cleanly.

**Pass criteria.**
- Send returns 201 and the payload is decrypted in the app's `onMessage` on the Play emulator
  and on sandboxed Play.
- The wrong key gets a 4xx (code recorded).
- With no Play Services, registration reports a clear error.

**Affects.** 16 (play flavor), 08 (relay FCM path), 18 (play flavor dependencies). **Owner:** Phase 16 lead.

**Primary.** Play flavor: the UnifiedPush connector plus the embedded distributor. The org
Worker sends standard Web Push to the `fcm.googleapis.com` endpoint (D11).

**Fallback (relay holds an FCM service account).** The play flavor obtains an FCM registration
token through `firebase-messaging` with the publisher's Firebase project config, injected by
build config (D16). This mirrors iOS:
- **App (Phase 16).** It mints a relay endpoint holding `{kind:"fcm", fcm_token, org VAPID
  pubkey}`, encrypted to the relay.
- **Org Worker.** It still sends plain Web Push, now to the relay URL.
- **Relay (Phase 08).** It verifies the VAPID JWT against the bound key and forwards the
  unchanged aes128gcm ciphertext as an FCM HTTP v1 data message (HTTP/1.1, service-account JWT
  via WebCrypto). The app decrypts it in its `FirebaseMessagingService`.
- **Shared path.** Relay rate limits and 404/410 propagation are the same as for APNs.
- **Leaving the foss flavor untouched.** Phase 18 adds the Firebase dependency to `play` only,
  and Phase 21 adds the Firebase project to the publisher's disclosures.

Even on PASS, the fallback stays implemented behind a remote-config-free build flag. The
primary path rests on an undocumented Play Services interface (Risks), and a Play Services
update could break it after launch.

### G6 — A Capacitor app hosts a separate in-process native WebView with no bridge, with cookie injection, file chooser, IME and insets, and keyboard

**Procedure.** `spikes/mobile`:
- **Plugin.** `MachineViewSpike` opens a same-process Activity (Android) or a modally
  presented `UIViewController` (iOS). Its WebView has JavaScript enabled, no
  `addJavascriptInterface`, and no `WKScriptMessageHandler`.
- **Test page (`origin/echo-origin.mjs` serves `/g6`).** It shows:
  - `typeof Capacitor` and `typeof androidBridge`, expected `undefined`;
  - the cookie echo;
  - `<input type=file multiple>` and `<input type=file accept="image/*" capture>`;
  - a bottom-anchored textarea;
  - a log of `visualViewport.height`, `innerHeight` and `env(safe-area-inset-*)` on resize;
  - yaran's own viewport meta;
  - a second page variant with `interactive-widget=resizes-content`.
- **Devices.** Android 15/16 at targetSdk 36 with WebView ≥ M144, one WebView at M13x
  (`adb shell dumpsys webviewupdate`), the GrapheneOS Pixel, iOS 17.4, 18 and 26, and iPad
  split view.
- **Then the real yaran UI**, loaded the same way: the compose bar with the soft keyboard,
  terminal-key row visibility, and rotation.

**Pass criteria.**
- The bridge is absent.
- The cookie is present on the first request.
- Both pickers open and upload through yaran's `/api/v1/file-drop`.
- The textarea and yaran's compose bar stay visible above the keyboard on every device.
- Safe-area insets are non-zero where the device has them.
- No focus is lost on the first tap (the M139 caveat).

**Affects.** 14, 15. **Owner:** Phase 15 lead.

**Primary.** machine-view is a same-process Activity / view controller hosting a plain
WebView, with platform-default IME and viewport behaviour honouring yaran's viewport meta.

**Fallbacks, per sub-item, all inside D9 and D13:**
- **Android IME.** If the visual viewport does not shrink, the plugin applies
  `WindowInsetsCompat.Type.ime()` itself by resizing the WebView frame and returning `CONSUMED`.
- **iOS keyboard.** If the WKWebView does not resize correctly, the plugin constrains the
  web view to `keyboardLayoutGuide` (iOS 15+).
- **Android file chooser.** If uploads fail, implement `onShowFileChooser` with
  `ActivityResultContracts.OpenMultipleDocuments`, plus camera capture when `accept` asks for it.
- **Cookies not visible to the second WebView.** Make the Activity non-isolated. This is the
  root cause the evidence names.

If Capacitor's lifecycle interferes with a second Activity (for example back-stack or
process-death restore), machine-view becomes the plugin's own task-affine Activity, launched
with an explicit intent and restored from saved state by Phase 15's restore logic.

### G7 — A reproducible `fdroid build` of the foss flavor

**Procedure.** `g07-fdroid.sh`, in Docker `registry.gitlab.com/fdroid/fdroidserver:buildserver`:
1. Build the `spikes/mobile` foss release APK twice in clean containers with Node pinned,
   `npm ci`, the lockfile, baseline-profile tasks disabled and
   `dependenciesInfo { includeInApk = false }`. Run `diffoscope` on the two.
2. Sign one copy with apksigner from build-tools 34.
3. Write a draft `metadata/<applicationId>.yml` in a local fdroiddata checkout, in two variants:
   - **A (npm in the recipe):** `sudo: apt-get install npm`, `init: npm ci`, `scandelete: node_modules`.
   - **B (MapComplete style):** a release-tag tree with the built shell bundle and vendored
     `@capacitor/android` committed.
   Both variants set `Binaries:` and `AllowedAPKSigningKeys:`.
4. Run `fdroid readmeta`, `fdroid lint`, `fdroid build`, then `fdroid publish` against the
   Binaries URL. Then run `apksigcopier compare`.

**Pass criteria.**
- Variant A builds and `fdroid publish` reports the developer-signed APK verified.
- `fdroid lint` is clean.
- The F-Droid scanner raises no non-free dependency in foss. That confirms the foss flavor
  excludes the embedded FCM distributor and Firebase (D13).

**Affects.** 18 (F-Droid job and reproducibility check), 21 (metadata MR), 14 (build settings).
**Owner:** Phase 18 lead.

**Primary.** Variant A with developer-signed reproducible builds (D14).

**Fallback L1.** Variant B. The `release-mobile` workflow (18) commits the built shell bundle
to a `fdroid/<version>` tag tree that F-Droid builds with `gradle: yes` only. The bundle is
reproducible from source in CI, and the tag records the source commit.

**Fallback L2 [changes D14 for F-Droid].** F-Droid signs with its own key. The consequence is
that F-Droid installs cannot upgrade to or from Play or GitHub installs, because Android
rejects a different signer. Mitigations:
- The app shows its signing channel in About (14).
- Docs (17) tell users to pick one channel and how to migrate (export app settings, uninstall,
  reinstall). Org/machine data lives server-side, so only local preferences and keystore tokens
  are lost, and those are re-obtained by SSO.
- The fdroiddata listing says so.
- Reproducibility fixes stay on the 18 backlog until L0/L1 is restored.

### G8 — Public path overrides for `/v1/meta` and `/v1/machine/*` on the Worker's Access-protected hostname, and precedence

**Procedure.** `g08-public-paths.sh`:
1. Deploy `workers/public-path-probe` on `<cp-host>` (custom domain from G14). It echoes the
   path and whether `Cf-Access-Jwt-Assertion` arrived.
2. Create the control-plane-style self-hosted app on `<cp-host>`, using the documented `PUT
   /accounts/{id}/access/apps/{app_id}` with `destinations:[{type:"public", uri:"<cp-host>",
   overrides:[{behavior:"public", path_pattern:"/v1/meta"}, {behavior:"public",
   path_pattern:"/v1/machine/*"}]}]`.
3. `curl` each of these and record status and JWT presence:
   - `/v1/meta` (expect origin 200);
   - `/v1/meta/x` (expect 302);
   - `/v1/machine` (expect 302; no bare `/v1/machine` route exists, this is a probe only);
   - `/v1/machine/claim` (expect 200);
   - `POST /v1/machine/unpair` and `PUT /v1/machine/origin` (expect 200 from the probe: 02's
     W8 and W32, which must sit under the same single `/v1/machine/*` override, R8);
   - `/v1/machine/a/b` (record; the pattern has one `*` per segment);
   - `/v1/me` (expect 302);
   - `/v1/MACHINE/claim` and `/v1/machine/%2e%2e/me` (normalisation probes: these must not reach a protected route).
4. Try `path_pattern` without the leading slash and record whether the API accepts it.
5. Check the Access logs.
6. Remove the overrides and build Option B: path apps `<cp-host>/v1/meta` and
   `<cp-host>/v1/machine/` with a reusable Bypass policy `{decision:"bypass",
   include:[{everyone:{}}]}`. Repeat step 3.

**Pass criteria.**
- The override variant matches the expected statuses exactly.
- No normalisation probe reaches a protected path unauthenticated.
- The API round-trips the override config.

**Affects.** 04 (signature auth is the only gate on these paths), 07 (wizard creates the app),
06, 05. **Owner:** Phase 07 lead.

**Primary.** `destinations[].overrides` with `behavior:"public"` (D6): exactly two
overrides, `/v1/meta` and `/v1/machine/*`; every machine route (02 W4–W8 and W32, all matching
`^/v1/machine/[a-z]+$`) sits under the second, so no override for a bare `/v1/machine` exists.
**Fallback:** Option B
path apps with a Bypass policy (documented; most-specific path wins). It costs two apps on
the control plane only, against the 500-app cap that Phase 05 already counts.

Either way:
- Bypassed requests are not logged by Access. Phase 04's own audit and request log covers
  `/v1/machine/*`.
- The Worker's router rejects non-canonical paths (case, encoded dots) before routing, which
  Phase 04 implements and tests with the step-3 probe set as fixtures.

### G9 — The account-owned API token template URL, with permission group IDs resolved by API

**Procedure.** `g09-token-template.sh`:
1. With an admin token, for each name run `GET
   /accounts/{id}/tokens/permission_groups?name=<n>` and record `{id, name, scopes,
   is_selectable}`. The names:
   - "Cloudflare Tunnel Write"
   - "Access: Apps and Policies Write"
   - "Access: Organizations, Identity Providers, and Groups Read"
   - "Access: Organizations, Identity Providers, and Groups Write" (for the G10 OTP creation)
   - "Account Settings Read"
   - "Zone Read"
   - "DNS Write"
   - "Workers Scripts Write"
   - "Workers Routes Write" (if G14 needs it)
2. Diff the result against cloudflare-parts/04 §2.
3. Build `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<urlencoded
   [{"key":"<id>"}…]>&name=yaran%20control%20plane`. The operator opens it and confirms every
   row pre-fills with no "unresolved" notice, scopes one zone, and creates the token.
4. `GET /accounts/{id}/tokens/verify` → `status:"active"`. Try `/user/tokens/verify` and record the result.
5. Exercise each permission with the token: one call per permission, listing tunnels, apps,
   IdPs, zones and DNS records, plus a dry-run custom-domain attach.
6. Repeat with each permission removed, to record the exact error per missing permission.

**Pass criteria.**
- Every ID resolves.
- The URL pre-fills with no notices.
- The created token passes all step-5 calls.
- Every step-6 removal produces a distinguishable error.

**Affects.** 07 (template link, wizard token verification by probing each permission), 17
(admin docs list each permission's purpose). **Owner:** Phase 07 lead.

**Primary.** The account-owned template URL with resolved IDs, committed in
`cloud/worker/src/setup/token-template.ts` (07) with this evidence as its source.
**Fallback** (the URL does not pre-fill, or some IDs cannot be resolved): the wizard shows a
step-by-step "Create token" screen listing exact permission names and scopes. Verification is
unchanged, because it probes each permission (step 5), so a hand-made token is accepted
exactly when it is sufficient. The step-6 error mapping drives the wizard's "missing
permission X" message.

### G10 — IdP detection and One-time PIN creation through the API in a fresh org

**Procedure.** `g10-idp.sh`:
1. **Account A, Read token:** run `GET /access/organizations`, recording `auth_domain` and
   `strict_service_token_auth`, then `GET /access/identity_providers`. Expect a single
   `type:"cloudflare"` entry with `restrict_to_account_members:true`.
2. **Write token:** `POST /access/identity_providers {"name":"One-time PIN login","type":"onetimepin","config":{}}`.
   Reference its id in a test app's `allowed_idps`, and confirm a non-member email receives a
   PIN only when a policy allows it.
3. **Account C (no Zero Trust):** run `GET /access/organizations`, then `POST
   /access/organizations` with no body, then with `{auth_domain, name}`. Record each response,
   including any payment-method or onboarding error.
4. Run every call with a token missing the permission and record the error codes.

**Pass criteria.**
- Step 1 detects the Cloudflare-only IdP state.
- Step 2 creates OTP and a non-member can sign in through it.
- Step 3's outcome is recorded either way: it decides the wizard's no-org branch.

**Affects.** 07. **Owner:** Phase 07 lead.

**Primary.** The wizard detects the IdP state and offers to add OTP through the API, plus
links for GitHub and Google.

**Fallback (OTP creation refused).** The wizard deep-links the admin to the dashboard's
IdP page and polls `GET identity_providers` every 5 s until a non-`cloudflare` IdP exists.

**No-org branch.** If org creation through the API is refused (expected: onboarding needs a
payment method), the wizard stops with an actionable message: "Complete Zero Trust onboarding
(Free plan, payment method required)", with a link and a recheck button that polls
`GET organizations`. Either way setup never proceeds into an org that only account members can use.

### G11 — Deploy button from a branch subdirectory (the generated `cloud-deploy` layout), with D1 migrations in the deploy script and secret prompts

**Procedure.**
- **Probe app.** `workers/deploy-probe/` is an isolated app with:
  - its own `package.json` and lockfile, with no `workspace:*` dependency;
  - a `wrangler.jsonc` D1 binding `DB` with no `database_id`;
  - `migrations/0001_init.sql`;
  - `"deploy": "npm run db:migrations:apply && wrangler deploy"`;
  - `.dev.vars.example` with `CF_API_TOKEN=`, `SETUP_CODE=` and `DATA_KEY=` and comments (the
    three Deploy-time secrets, D20);
  - a `vendor/` directory holding a small pre-built package that `src/` imports by relative
    path, mirroring how the generated deploy tree bundles `cloud/protocol` (07, D18);
  - `package.json` → `cloudflare.bindings` descriptions;
  - a route `/v1/meta` that reads D1.
- **`g11-deploy-button.sh`** pushes the probe as the only content of an orphan gate branch in
  `SiavZ/yaran` (public), `cloud-gates/deploy-probe`, under `worker/`, the same layout the
  generated `cloud-deploy` branch uses (07). It then prints the URL
  `https://deploy.workers.cloudflare.com/?url=https://github.com/SiavZ/yaran/tree/<gate-branch>/worker`.
- **The operator, on account A, records:**
  - that the clone root is the subdirectory;
  - that the cloned `wrangler.jsonc` contains a `database_id`;
  - that the build log shows migrations applied;
  - whether a blank secret is accepted;
  - the binding-description rendering;
  - that a push to the clone redeploys and applies a new `0002` migration.
- **Two variants:**
  - Add a `workspace:*` dependency on a sibling package (expect failure; this proves why the
    Deploy button cannot target `cloud/worker` on `main` and must target the generated,
    self-contained `cloud-deploy` branch, D18).
  - Use plain-wrangler reproduction (`wrangler d1 create`, `migrations apply --remote`,
    `wrangler deploy --secrets-file`). Phase 19 reuses this as its non-interactive org provisioning.

**Pass criteria.**
- The button deploys from the subdirectory.
- D1 is provisioned and migrated by the deploy script.
- Secrets are prompted with descriptions.
- A redeploy applies new migrations.

**Affects.** 07, 04, 02 and 18. Under the isolation rule the Deploy button cannot build
`cloud/worker` on `main`, which imports `cloud/protocol` as a workspace package (02). So the
button targets the generated, self-contained `cloud-deploy` branch (D18): Phase 07's assembler
bundles `cloud/protocol` into the tree, and Phase 18's `yaran-cloud-v*` release workflow
(`release-cloud`) runs it and publishes the branch. No vendored copy lives on `main` and no
drift check exists or is needed. **Owner:** Phase 07 lead.

**Primary.** The Deploy button at `/tree/cloud-deploy/worker` with the deploy script running
migrations. **Fallback L1** (migrations in the deploy script fail on the first build): the
Worker applies its own schema at runtime through a `schema_migrations` table and ordered
`env.DB.batch` statements generated from the same `migrations/` files at build time (04). The
deploy script still tries first. **Fallback L2** (the button cannot deploy our layout at
all, including from the root of 07's `cloud-deploy-root` branch, which is 07's first answer
when only the subdirectory form fails): the documented path becomes "Use this template" on GitHub, then Workers Builds connect
in the dashboard, plus `cloud/worker/scripts/deploy.sh` for CLI deploys with the same steps as
the plain-wrangler variant. 07 and 17 document both. The README badge is shown only when L0 or L1 holds.

### G12 — Access `session_duration` versus JWT `exp`, and an open WebSocket after expiry

**Procedure.** `g12-session-expiry.sh`, on the G1 machine app:
1. Set the app `session_duration:"5m"` and the policy's to `"3m"`. Sign in, then decode with
   `lib/jwt.sh` and record `exp - iat` (expect 180).
2. Use the spike machine-view with an injected cookie (G1 L0, or the L1/L2 credential if
   adopted). Open yaran's events and PTY sockets with the existing client heartbeat
   (`config.server.heartbeat_seconds`, `crates/yaran-web/web/src/lib/bootstrapApi.ts:182-187`) and keep them open 15 min past `exp`. Record the close time, close code and
   reason, and whether data flowed after `exp`.
3. Reconnect after `exp` (expect 302 on the upgrade, which shows the probe must fire) and fetch
   `/cdn-cgi/access/get-identity` before and after.
4. `curl https://<machine-host>/cdn-cgi/access/logout`, wait 30 s, then replay the old JWT as a
   cookie and as `cf-access-token` (expect 302).
5. `POST /access/apps/{id}/revoke_tokens` and replay again.
6. `POST /access/organizations/revoke_user {email}` and replay again.

**Pass criteria.**
- `exp - iat` matches the effective session duration.
- The open-socket behaviour is observed and recorded, whichever it is.
- Revoked tokens are refused within 60 s on both new requests and new upgrades.

**Affects.** 15 (renewal scheduler margin), 11 (whether yaran closes cloud sockets at JWT
`exp`), 07 (session duration setting bounds), 13. **Owner:** Phase 15 lead.

**Primary (sockets survive `exp`).** Renewal at `exp − max(5 min, 10% of lifetime)` and on any
reauth signal from Phase 13. Phase 11 additionally closes cloud-host sockets at the verified
JWT's `exp`, with a distinct close reason that the web UI maps to "Sign-in needed". That makes
revocation bounded by `exp` even when Cloudflare keeps the socket open. **Fallback (Cloudflare
closes sockets at or near `exp`):** the same renewal schedule, with the margin raised so that
renewal completes before `exp`. machine-view swaps the cookie in place, so a new upgrade
carries the fresh JWT, and the web UI's reconnect path attaches again (no new mechanism). The
admin's minimum session duration in 07 is raised to 15 min, so renewals stay rare enough to be invisible.

### G13 — Verified https callback (ASWebAuthenticationSession `.https`, Android App Link with Auth Tab / Custom Tab), and the dev-build custom scheme

**Procedure.**
- **Callback host.** `workers/callback-probe` runs on `<gate-callback-host>` (the stand-in for
  `<publisher-domain>`, D16). It serves `/.well-known/assetlinks.json` (the spike's package and
  debug signing-certificate SHA-256) and `/.well-known/apple-app-site-association` (`applinks`
  and `webcredentials` for the spike's team and bundle ID, covering `/auth/callback` and
  `/oauth/callback`), the shapes Phase 21 hosts for real.
- **Spike flows.** `spikes/mobile` runs both flows against `https://<cp-host>/v1/handoff`-shaped
  probe pages that render a one-tap consent page (device label and host as in 02 §8) and, on
  its form `POST`, answer `303` to the callback with `?state=…&jwe=…` (02's parameter names).
  The release-shaped run uses `https://<gate-callback-host>/auth/callback`; the dev-shaped run
  (`build=dev`) uses the custom scheme, with the spike's scheme `yaranapp-gate` so it cannot
  collide with a real install of `yaranapp`.
- **iOS (17.4, the minimum, and the latest release).** `ASWebAuthenticationSession` with
  `Callback.https(host:path:)` for the release-shaped run and `Callback.customScheme` for the
  dev-shaped run. Record:
  - the completion URL received;
  - whether `.https` needs the associated-domains entitlement (run once without
    `webcredentials:` and record the error);
  - the cancel path (`canceledLogin`);
  - with `prefersEphemeralWebBrowserSession` false, that a second run reuses the IdP session,
    and with it true, that it does not;
  - the error when `presentationContextProvider` is nil.
- **Android.** Install the spike with `autoVerify` App Link intent-filters for
  `https://<gate-callback-host>/auth/callback` and record `pm get-app-links <package>` (the
  verification state) on the emulator, the GrapheneOS Pixel and a stock-Android device. For
  each default browser, log `CustomTabsClient.isAuthTabSupported()`: Chrome ≥ 137 on the
  emulator, Vanadium and Chrome on the GrapheneOS Pixel, and Firefox. Launch `AuthTabIntent`
  with the https redirect (host and path), and separately with `redirectScheme` for the
  dev-shaped run; record whether the result arrived as `RESULT_OK` or through the App Link /
  intent-filter Activity (`singleTask`). Repeat with `setEphemeralBrowsingEnabled(true)`.
- **Hijack probe.** A second spike APK declares the same https host and path without being
  listed in `assetlinks.json`, and the same `yaranapp-gate` scheme. Record which app receives
  the callback in each mode. Expected: the verified https callback reaches only the listed app
  in every mode; on the custom scheme, Auth Tab and `ASWebAuthenticationSession` return to the
  caller while the Custom Tab fallback goes through system dispatch.

**Pass criteria.**
- The release-shaped https callback arrives in the starting app on every platform and browser
  listed, and the hijack APK never receives it.
- Android reports the App Link as verified on the emulator and on stock Android; the GrapheneOS
  state is recorded either way.
- Cancel is detectable, and the consent page's Cancel yields `error=handoff_declined`.
- The dev-shaped custom-scheme path works, and its exposure on the Custom Tab fallback is
  recorded. D8's sealing is what makes that exposure harmless, and only builds compiled
  without a publisher domain use it.

**Affects.** 15 (auth client and support matrix), 14 (App Link intent-filter, associated
domains), 21 (association files on `<publisher-domain>`), 06 and 11 (consent page,
redirect allowlist), 17 (troubleshooting page). **Owner:** Phase 15 lead.

**Primary.** Release builds: iOS `Callback.https` on 17.4+, non-ephemeral; Android Auth Tab
with the https redirect where supported, otherwise a Custom Tab returning through the verified
App Link. Builds compiled without a publisher domain: the `yaranapp://auth/callback` custom
scheme with `build=dev` and a visible warning (02 §8, §10).

**Fallback.**
- **Android without Auth Tab, or Auth Tab without https redirects:** a Custom Tab plus the
  verified App Link Activity, with `state` checking and the sealed payload (D8). Where there is
  no Custom Tabs browser at all, a plain `ACTION_VIEW` returns through the same App Link.
- **App Link not verified on a device** (for example a ROM without a verifier): the app shows
  the system "Open supported links" screen (`Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS`),
  starts no handoff until `DomainVerificationManager` reports the domain verified or selected,
  and never falls back to the custom scheme in a release build.
- **iOS `.https` callback unusable:** no fallback keeps D8 in release builds (the custom scheme
  is dev-only), so the gate escalates to the maintainer as a product blocker **[changes D8]**.

Phase 15 implements every Android rung. The spike's per-browser table becomes Phase 15's
support matrix and Phase 17's troubleshooting page.

### G14 — Attaching a Worker custom domain through the API from the setup wizard, and the permission it needs

**Procedure.** `g14-custom-domain.sh`:
1. Deploy `workers/domain-probe` with the shipped deploy tree's settings (D19):
   `workers_dev: true`, `preview_urls: false`, and no routes or custom domain in the wrangler config.
2. Mint token A (Workers Scripts Write only) and token B (A plus Zone Read, DNS Write and
   Workers Routes Write on `<staging-zone>`).
3. From inside the deployed Worker (`POST /attach` with the token pasted into a form, so it is
   never in argv), call `PUT /accounts/{id}/workers/domains
   {"hostname":"<cp-host>","service":"<script>","zone_id":"…"}` with A, then with B. Record each response.
4. Time from 200 until `curl -sv https://<cp-host>` presents a valid certificate, and poll
   `GET /zones/{z}/ssl/certificate_packs` for the `cert_id`.
5. Pre-create a CNAME at the hostname and attach again (expect a refusal; record it). Repeat with an A record.
6. From the Worker, call `POST /accounts/{id}/workers/scripts/<script>/subdomain
   {"enabled":false,"previews_enabled":false}`, then curl the `workers.dev` URL.
7. Trigger a redeploy through Workers Builds, once with the shipped config (`workers_dev: true`)
   and once with `workers_dev` unset, and record whether `workers.dev` comes back after step 6
   disabled it. Phase 07's update workflow (07 §2) rewrites `workers_dev` to `false` in the
   deployer's config once `/v1/meta` reports `setup: "closed"`; the shipped tree keeps
   `workers_dev: true` (D19, R5). This step measures the window that rewrite closes.
8. Probe the host lock the probe implements as 04/07 will: before its simulated setup close,
   every path on `workers.dev` except `/setup*` and `/v1/meta` is refused; after it, every
   Host other than `<cp-host>` gets `421 misdirected_host` with a body naming no host (02 §4).

**Pass criteria.**
- Some token from the G9 set attaches the domain from inside the Worker.
- The certificate is valid within a recorded time.
- Conflicts are refused, not overwritten.
- The Worker can disable its own `workers.dev` route.
- The step-8 host lock holds on every probe, whatever step 7 records.

**Affects.** 07 (wizard domain step, first-run reachability, host lock), 04 (host checks, the
deploy tree's `workers_dev: true` and `preview_urls: false`), 18 (the generated
`cloud-deploy` tree's wrangler config), 17 (token permissions in the admin docs). **Owner:**
Phase 07 lead.

**Primary.**
- **First run.** The shipped `wrangler.jsonc` sets `workers_dev: true` and `preview_urls:
  false` and contains **no `custom_domain` route**, because a CI deploy would override the
  deployer's DNS records (D19). The first run is reached on the Worker's `workers.dev` URL,
  where, until setup closes, the Worker answers only `/setup*` and `/v1/meta`.
- **Wizard domain step.** The wizard attaches `<cp-host>` with the user's token, waits for the
  certificate, creates the control-plane Access app (G8), disables `workers.dev` through the
  subdomain API, and redirects to `https://<cp-host>/setup/continue`.
- **Host refusal in code.** Regardless of the step-7 result, once setup is closed the Worker
  refuses every request whose Host is not the recorded custom domain, `*.workers.dev`
  included, with `421 misdirected_host` (04, 07; 02 §4).

**Fallback** (the API attach is refused even with B's permissions): the wizard shows dashboard
steps for adding the custom domain and polls `GET /accounts/{id}/workers/domains` (needs
Workers Scripts Read, added to G9's set) until the hostname appears with an active
certificate. Setup then continues identically. A token missing zone permissions is caught by
G9's per-permission probe before the domain step starts.

---

## Tracking

Status is updated in the PR that closes each gate. Phase 19 cannot start until every row
reads PASS or FALLBACK ADOPTED.

| Gate | Question (short) | Affects | Primary | Fallback (level) | Decision owner | Target wk | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| G1 | Injected cookie accepted (HTTP + WS), both WebViews | 15, 11, 06, 05, 13 | L0 seal header JWT → cookie | L1 seal cookie value; L2 Managed OAuth + loopback proxy **[changes D8]** | Phase 15 lead | 2 | OPEN | `evidence/G01-cookie-injection/` |
| G2 | Host preserved, HTTP/1.1, per-rule access enforces | 05, 10, 11 | per-rule access, no httpHostHeader, cloudflared ≥ 2026.11.0 | explicit httpHostHeader + XFH rule; yaran JWT check sole origin gate | Phase 05 lead | 1 | OPEN | `evidence/G02-cloudflared-origin/` |
| G3 | Unauth/expired responses by kind and org age | 13, 15, 04 | classifier from matrix | table-driven union of observed rows | Phase 13 lead | 2 | OPEN | `evidence/G03-access-responses/` |
| G4 | Worker → APNs HTTP/2 | 08, 21 | relay Worker `fetch` | APNs sender container (L1), same image on VM (L2) | Phase 08 lead | 2 | OPEN | `evidence/G04-apns/` |
| G5 | Embedded FCM + direct VAPID, no publisher creds | 16, 08, 18 | embedded distributor | relay FCM HTTP v1 (kept built either way) | Phase 16 lead | 3 | OPEN | `evidence/G05-embedded-fcm/` |
| G6 | Second in-process WebView: cookies, files, IME, keyboard | 14, 15 | plain in-process WebView, platform defaults | per-item native insets/keyboard/file chooser | Phase 15 lead | 3 | OPEN | `evidence/G06-machine-view/` |
| G7 | Reproducible `fdroid build` | 18, 21, 14 | variant A, developer-signed | L1 committed bundle tag; L2 F-Droid-signed **[changes D14]** | Phase 18 lead | 3 | OPEN | `evidence/G07-fdroid/` |
| G8 | Public path overrides + precedence | 04, 07, 06, 05 | `destinations[].overrides` | path apps + Bypass policy | Phase 07 lead | 1 | OPEN | `evidence/G08-public-paths/` |
| G9 | Token template URL + resolved IDs | 07, 17 | account-owned template URL | guided manual token, same probe verification | Phase 07 lead | 1 | OPEN | `evidence/G09-token-template/` |
| G10 | IdP detection + OTP via API, fresh org | 07 | API-created OTP | dashboard deep link + poll; no-org stop | Phase 07 lead | 1 | OPEN | `evidence/G10-idp/` |
| G11 | Deploy button from the generated `cloud-deploy` branch subdir + D1 migrations + three secrets | 07, 04, 02, 18 | button at `/tree/cloud-deploy/worker` + deploy-script migrations | L1 runtime migrator; L2 template + CLI script (07's `cloud-deploy-root` tried first) | Phase 07 lead | 1 | OPEN | `evidence/G11-deploy-button/` |
| G12 | session_duration vs exp; open WS after exp | 15, 11, 07, 13 | renew at exp − margin; yaran closes at exp | larger margin, in-place cookie swap, 15 min floor | Phase 15 lead | 2 | OPEN | `evidence/G12-session-expiry/` |
| G13 | Verified https callback (iOS `.https`, App Link + Auth Tab); dev custom scheme | 15, 14, 21, 06, 11, 17 | iOS `.https` 17.4+; Auth Tab https / Custom Tab via verified App Link | Custom Tab + App Link; ACTION_VIEW; unverified link → system settings; iOS failure **[changes D8]** | Phase 15 lead | 3 | OPEN | `evidence/G13-system-browser-auth/` |
| G14 | Custom domain attach via API + permission; workers.dev host lock | 07, 04, 18, 17 | `workers_dev: true` + `preview_urls: false`, wizard API attach from workers.dev, then disable workers.dev; `421` for any other Host after setup | dashboard steps + poll | Phase 07 lead | 1 | OPEN | `evidence/G14-custom-domain/` |

## Work items

1. **Gate tooling foundation.**
   - **Create:** `tools/cloud-gates/README.md`, `env.example`, `run.sh` (≤150 lines), and in
     `lib/` `common.sh` (≤200), `cf.sh` (≤200), `jwt.sh` (≤80), `redact.sh` (≤150) and
     `access.sh` (≤300); plus `tests/redact_test.sh` (≤200) and `tests/lib_test.sh` (≤200)
     with canned API responses under `tests/fixtures/`; plus
     `docs/plans/phoneapp/evidence/README.md` and `check-evidence.sh` (≤120). Each code file
     gets its header with a module-headers block (the scripts `source` each other, so the
     trees are real).
   - **Reuse:** the shell header and `set -euo pipefail` style of `tools/preview-env/up.sh:1-20`.
     No existing Cloudflare client exists in the repo; Phase 05's TypeScript client comes later
     and is not a dependency.
   - **Tests:** `redact_test.sh` plants one of every secret shape and asserts zero survive.
     `lib_test.sh` covers JWT decoding and error-envelope parsing. `check-evidence.sh` runs
     on a fixture tree with one planted JWT and must fail.
2. **Echo origin.**
   - **Create:** `tools/cloud-gates/origin/echo-origin.mjs` (≤300) and `package.json` (pins `ws`
     and `web-push`).
   - **Behaviour:** routes `/echo`, `/ws`, `/g6` and `/expiry` echo the request line, the HTTP
     version (`req.httpVersion`), headers and cookies. The WebSocket echo includes the upgrade
     request headers. It never logs secrets unredacted; it prints hashes and the operator
     reads values on their own screen.
   - **Tests:** a `node --test` file (≤150) asserting the HTTP version and header echo against a local client.
3. **Probe Workers.**
   - **Create:** `workers/apns-probe/{src/index.ts,wrangler.jsonc,package.json}`,
     `workers/public-path-probe/…`, `workers/domain-probe/…`, `workers/deploy-probe/…` and
     `workers/callback-probe/…` (each `src/index.ts` ≤250; `deploy-probe` adds
     `migrations/0001_init.sql`, `0002_gate.sql`, `.dev.vars.example` with the three secrets,
     a `vendor/` package and `cloudflare.bindings`; `callback-probe` adds the two association
     files generated from env so no real team ID or certificate is committed). All are TypeScript
     strict with `workers_dev`/`preview_urls` set explicitly per gate.
   - **Tests:** a Vitest test that `callback-probe`'s association files are valid JSON with
     the expected keys and paths, and one for the domain probe's host lock (step 8).
   - **Tests:** a Vitest unit test for the APNs JWT signer (header and claims shape, r‖s length
     64), and a Vitest test for the path echo's normalisation.
4. **Mobile spike app.**
   - **Create:** `tools/cloud-gates/spikes/mobile/` as a Capacitor 8.6.2 project with flavors
     `foss`/`play` and a minimal React shell (≤200 lines per file).
   - **Android (Kotlin), each ≤500:** `MachineViewSpike.kt` (in-process Activity, cookie inject
     and flush, file chooser, insets logging), `AuthSpike.kt` (Auth Tab and Custom Tab fallback,
     intent-filter Activity) and `PushSpike.kt` (play flavor embedded FCM registration; foss
     flavor UnifiedPush connector).
   - **iOS (Swift), each ≤500:** `MachineViewSpike.swift`, `AuthSpike.swift` and
     `PushSpike.swift` (APNs token logging).
   - **Second module:** a "hijack" Android app module (≤100 lines) for G13, declaring the same
     https host and path (not in `assetlinks.json`) and the same `yaranapp-gate` scheme.
   - **Rules:** debug screens accept secrets only through a paste field, never deep-link
     parameters. No bridge methods expose cookies to JavaScript.
   - **Reuse:** `@capacitor/inappbrowser`'s `OSIABWebViewActivity.kt` is a reference only (Apache-2.0; no copy).
   - **Tests:** a JUnit test for cookie-string building (attributes from G1 step 4) and an
     XCTest for the same. A JUnit test that the machine-view Activity's manifest entry has no
     `android:process` (in-process requirement).
5. **One script per gate:** `g01-…sh` through `g14-…sh`, each ≤500 lines (estimates: G1 300,
   G3 280, G2 220, G8 200, the others ≤180), implementing the procedures above. Each:
   - prints its device checklist;
   - writes `run-YYYY-MM-DD/` through `record`;
   - cleans up with `trap`;
   - exits non-zero on any unmet pass criterion, so `run.sh --recheck` can drive Phase 19's drift check.
6. **Run the gates and commit the evidence** in the week order above. One PR per gate (or per
   small group). Each PR edits this file's Tracking row and every affected phase file's
   gate-dependent section, and `00-README.md` for a **[changes Dn]** fallback.
7. **Drift-check entry point.** `run.sh --recheck` runs the API/HTTP halves of G2, G3, G8, G9
   (ID resolution only), G12 (steps 1 and 3–6 with a curl client) and G14 (step 6 only) with no
   operator interaction, using Phase 19's automated identity. It returns a JSON summary that
   Phase 19 publishes (19 §WI-9).

## Acceptance

- [ ] `tools/cloud-gates/` and `docs/plans/phoneapp/evidence/` exist as laid out, every code
      file has a passing module-headers block, and no file exceeds 500 lines.
- [ ] `tests/redact_test.sh`, `tests/lib_test.sh`, the echo origin `node --test`, the Worker
      Vitest suites, and the spike JUnit/XCTest suites pass.
- [ ] `check-evidence.sh` passes on the committed evidence and fails on the planted-secret fixture.
- [ ] Every gate G1–G14 has a committed `RESULT.md` whose verdict is PASS or FALLBACK ADOPTED
      (level named), signed off by its decision owner and the maintainer.
- [ ] For every FALLBACK ADOPTED, the affected phase files state the adopted path. For every
      **[changes Dn]** fallback, `00-README.md` is amended in the same PR.
- [ ] The Tracking table shows no OPEN row.
- [ ] `run.sh --recheck` runs unattended against staging account A and exits 0.
- [ ] No test resource tagged `gate-` remains in staging accounts (`lib/access.sh sweep --dry-run` prints nothing).

## Validation

```bash
cd tools/cloud-gates
bash tests/redact_test.sh && bash tests/lib_test.sh
(cd origin && npm ci && node --test)
for w in workers/*/; do (cd "$w" && npm ci && npx tsc --noEmit && npx vitest run); done
bash ../../docs/plans/phoneapp/evidence/check-evidence.sh
(cd spikes/mobile/android && ./gradlew testFossDebugUnitTest testPlayDebugUnitTest)
(cd spikes/mobile/ios && xcodebuild test -scheme GateSpike -destination 'platform=iOS Simulator,name=iPhone 16')
set -a; . ./.env.local; set +a          # operator's untracked env, from env.example
./run.sh G02                            # any single gate
./run.sh --recheck                      # unattended HTTP-level drift check
./lib/access.sh sweep --dry-run         # nothing left behind
grep -c 'OPEN' ../../docs/plans/phoneapp/03-platform-verification-gates.md   # 0 in the Tracking table before Phase 19 starts
```

## Risks

| Risk | Mitigation |
|---|---|
| G5's primary path rests on an undocumented Play Services interface (reverse-engineered by microG), so it can break after launch even if it passes today | Keep the relay-FCM fallback built and switchable by build flag; Phase 19 runs the drift check nightly on the play emulator; Phase 22 runbook covers switching |
| Managed OAuth (G1 L2) is beta and documented "for MCP servers" | L2 is the second fallback, not the primary; if adopted, the README amendment records the dependency and Phase 22 monitors the Access changelog |
| `destinations[].overrides` (G8) is schema-only and could change | Fallback is the documented path-app + Bypass form; the drift check re-runs G8 nightly |
| Gate evidence leaks a token or JWT into git | `redact.sh` on every recorded line, `check-evidence.sh` in CI, secrets only via env or stdin |
| Staging resources left behind consume the 500-app/policy caps or cost money | `gate-` tags, `trap` cleanup, `sweep` for anything older than 24h |
| No pre-2026-10-05 org available for G3 | G3 records "not available" and Phase 13's classifier already handles both behaviours from the documented difference (service-token headers only) |
| APNs to simulator does not work in CI or virtualised Macs | G4 runs on a physical Apple-silicon Mac; Phase 19 uses `simctl push` for decrypt-path tests in hosted CI and real APNs on device/nightly |
| A device OS or WebView update changes G1/G6/G13 behaviour after closure | The spike app is kept as the re-run harness; RESULT.md names re-run triggers (new major WebView, iOS major, Chrome Auth Tab change) |
| App Link verification behaves differently on a ROM without Google's verifier (GrapheneOS), so the release https callback does not open the app | G13 records `pm get-app-links` per device; the designed rung sends the person to "Open supported links" and never falls back to the custom scheme in a release build |
| A gate stalls for lack of a prerequisite and blocks Phase 19 | Closure rule 4: the maintainer adopts the designed fallback by default at the target week |

## References

- `00-README.md` D1–D23, flows 1–6; `00-CONVENTIONS.md` §2, §4
- `research/R4-cloudflare.md` Hard constraints 3–14, Recommendations; `research/cloudflare-parts/01`–`06`
- `research/R5-mobile.md` §2 (auth), §3 (push), §6 (QR), Open items 1–8
- Repo: `tools/preview-env/up.sh:1-20`, `:72-76`; `tools/reload-live-check.sh:1-12`; `crates/yaran-core/src/config.rs:2242`; `crates/yaran-web/src/server.rs:776-814`; `crates/yaran-web/src/file_drop_routes.rs:129-130`
- Cloudflare (read 2026-11-14):
  - https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
  - https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
  - https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/
  - https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
  - https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/
  - https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/
  - https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
  - https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
  - https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
  - https://developers.cloudflare.com/changelog/post/2026-06-18-cloudflare-idp-default/
  - https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
  - https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/list/
  - https://developers.cloudflare.com/workers/platform/deploy-buttons/
  - https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
  - https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  - https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
  - https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Source (read 2026-11-14):
  - cloudflared tag 2026.11.0: `ingress/ingress.go`, `ingress/origin_proxy.go`, `ingress/origin_service.go`, `proxy/proxy.go`, `connection/quic_connection.go`, `carrier/websocket.go`, `token/token.go`
  - workers-sdk main 81e56dd: `packages/deploy-helpers/src/triggers/publish-routes.ts`
  - SDK `cloudflare@7.3.0`
  - https://github.com/cloudflare/workerd/issues/4841
  - https://codeberg.org/UnifiedPush/android-embedded_fcm_distributor
- Apple, Google, F-Droid (read 2026-11-14):
  - https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
  - https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes
  - https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/customscheme(_:)
  - https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab
  - https://chromium.googlesource.com/chromium/src/+/main/android_webview/docs/insets.md
  - https://capacitorjs.com/docs/apis/inappbrowser
  - https://f-droid.org/docs/Reproducible_Builds/
  - https://gitlab.com/fdroid/fdroiddata/-/raw/master/metadata/org.mapcomplete.yml

## Reconciliation notes (2026-11-14)

- Header references to decisions now read D1–D23 (In scope, closure rule 3, References), per 00-README's amended decision table (R20).
- G1 L1 uses 02's `HandoffPayload.cookie` field filled by the consent POSTs (Y1b, W16b) instead of a re-sealed cookie; Phase 15 injects it (R9, R2).
- G1 L2 `allowed_uris` is the https `https://<publisher-domain>/oauth/callback`; `yaranapp://oauth/callback` only for dev builds (R2, 02 §10).
- G1, G4, G6, G13 and the Prerequisites drop iOS 16; iOS 17.4 is the minimum (R2, R21). Spike pinned to Capacitor 8.6.2 (R21).
- G2: ingress service is `http://127.0.0.1:<origin_port>` (05, 02 `origin_port`); primary states per-tunnel-route `originRequest.access` and minimum cloudflared 2026.11.0 owned by 05 and 10 (R16); the reduced-defence row is T25 (threat-ids).
- G8 probes `POST /v1/machine/unpair` and `PUT /v1/machine/origin` under the single `/v1/machine/*` override; `/v1/machine` stays a probe, not a route (R8, R9).
- G11: removed "vendored copy into `cloud/worker/src/protocol/` + drift check on main"; the button targets the generated `cloud-deploy` branch at `/tree/cloud-deploy/worker`, the probe mirrors that layout and bundles a `vendor/` package, `.dev.vars.example` lists `CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY`; 07's `cloud-deploy-root` noted ahead of L2 (R4, R6, D18, D20).
- G13 rewritten for the verified https callback (iOS `.https`, Android App Link with Auth Tab / Custom Tab), consent page with `jwe=` and `handoff_declined`, a `callback-probe` Worker serving `assetlinks.json` and AASA on `<gate-callback-host>`, unverified-link fallback, iOS failure flagged **[changes D8]**; custom scheme is the dev-build path (R2, 02 §8, §10).
- G14: `workers_dev: true` + `preview_urls: false` at deploy, host lock (only `/setup*` and `/v1/meta` before close; `421 misdirected_host` for any non-custom-domain Host after), redeploy check with the shipped config; Affects drops 09 (no token-permission role) and adds 18 (R5, D19).
- Tracking rows G11, G13, G14 and work items 3–4 updated to match; one Risks row added for App Link verification on GrapheneOS.
- Hooks H1–H7 live in Phase 19 (§Hooks this phase needs from Wave B), not in this file; their owners are reconciled there (R15).

### Straggler pass (2026-11-14)

- Straggler pass: G14 step 7 now says 07's update workflow rewrites `workers_dev` to `false` only once `/v1/meta` reports setup closed, while the shipped tree keeps `workers_dev: true` (R5, D19), matching 07 §2.
- Straggler pass: G2 gains an "Origin address" note: production ingress is `http://127.0.0.1:<origin_port>` (H2), the procedure already uses it, `localhost` evidence must be re-run; gate not weakened (R16, R20).
- Straggler pass: G14's Affects list already excludes 09 (no token-permission role), and 09 has nothing to change; verified, no edit (R5).

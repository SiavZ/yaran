# yaran Mobile + Cloud Connect: phase plan

This directory is the complete plan for a **production** product: native Android and iOS
apps that manage a developer's yaran sessions, reached through a **self-deployable
Cloudflare control plane** that any org or individual sets up with one Deploy button,
after which every developer and every phone connects with **SSO only**.

This is not an MVP plan. Every phase below is part of the definition of "done", and nothing
that contributes to that definition is deferred. Where an external platform fact is still
unproven, Phase 03 proves it, and the affected phase already specifies both the primary path
and the fully designed fallback, so no proof outcome can leave a gap.

Read [`00-CONVENTIONS.md`](00-CONVENTIONS.md) before any phase. It is binding on every phase.

## Scope decisions made by the owner (2026-11-14)

| Question | Decision |
|---|---|
| Platforms | **Android + iOS, both native apps** |
| Android distribution | **Google Play, signed APK on GitHub Releases, and F-Droid** |
| iOS distribution | App Store (and TestFlight for beta) |
| Transports the app supports | **Cloudflare only** (Tailscale stays as it is for browsers; the app does not speak it) |
| Setup model | The repo ships a **Deploy to Cloudflare** setup any org or individual can run on their own Cloudflare account; afterwards each user only signs in with SSO |
| Quality bar | Full product, production ready, iron clad; modular, reusable code; 500-line file ceiling; header comment with module trees on every code file |

## What "done" means

1. An admin clicks **Deploy to Cloudflare**, supplies one pre-scoped API token (created
   from a pre-filled link), a setup code and a data key at the deploy prompt, opens the
   setup page, and has a working org control plane on their own domain. Everything else
   (Access apps, policies, identity-provider check, VAPID keys, database) is created by code.
2. A developer runs `yaran cloud login https://<their-org-control-plane>` (or uses the TUI
   palette / web app menu), signs in with SSO in the browser, and their machine is
   reachable at its own hostname behind an owner-only Access policy, with yaran supervising
   `cloudflared`. Nothing else is configured by hand.
3. The developer scans a QR code (shown by the CLI, the TUI, the web UI and the admin
   console) or types the org URL in the phone app, signs in with SSO, sees their machines
   with live online status, and opens any of them into the full yaran web UI.
4. When an agent needs them, the phone gets a push notification (Android: UnifiedPush on
   F-Droid/GitHub builds, embedded FCM distributor on Play builds; iOS: APNs through the
   publisher relay), end-to-end encrypted past the org's own Worker, and tapping it opens
   that agent.
5. Unpairing, revoking a phone, revoking a machine (by the user or an admin), rotating a
   tunnel token, session expiry, and every failure path are handled out loud on every
   surface, with an audit trail.
6. All of it is tested (unit, integration, end-to-end on real Cloudflare and real devices),
   threat-modelled, documented for consumers, released through automated pipelines on all
   four distribution channels, and operable (runbooks, monitoring, update path).

## Architecture

```text
                         ┌──────────────────────── org's Cloudflare account ───────────────────────┐
                         │                                                                         │
  admin browser ──SSO──▶ │  Access app "control plane"  ──▶  org Worker (cloud/worker)  ──▶ D1      │
                         │   (hostname: cp.<zone>)            • setup wizard + admin console        │
  phone app ─────SSO───▶ │   public overrides:                • pairing, sessions, sealed handoff   │
   (system browser)      │   /v1/meta, /v1/machine/*          • Cloudflare provisioning engine ───┐ │
                         │   (Ed25519-signed machine API)     • Web Push sender (VAPID) ──────┐   │ │
                         │                                                                    │   │ │
                         │  per machine: Access app "m-<id>" (owner-only reusable policy)     │   │ │
  phone MachineView ───▶ │   hostname <machine>-<user>.<zone>  ──▶  Tunnel <id>  ◀── CF API ──┼───┘ │
   (CF_Authorization     │   originRequest.access.required + audTag                           │     │
    cookie injected)     └────────────────────────────────────┬───────────────────────────────┼─────┘
                                                              │ outbound QUIC                  │ Web Push (RFC 8030/8291/8292)
                         developer machine                    ▼                                ▼
                         ┌──────────────────────────────────────────────┐   ┌─────────────────────────────────┐
                         │ cloudflared (child, supervised, --no-autoupdate, │ Android: UnifiedPush distributor │
                         │   TUNNEL_TOKEN via env/--token-file)          │   │   (foss) / embedded FCM (play)   │
                         │        │ http://127.0.0.1:3890 (Host preserved)│   │ iOS: publisher push relay Worker │
                         │        ▼                                      │   │   (cloud/push-relay) ──▶ APNs    │
                         │ yaran web server (loopback only)              │   └─────────────────────────────────┘
                         │   • live cloud-hostname host-guard rule       │
                         │   • Access JWT verification + owner check     │
                         │   • sealed handoff endpoint for the phone     │
                         │ yaran core: cloud leg, credentials, emitter ──┼──▶ POST /v1/machine/events (signed)
                         └──────────────────────────────────────────────┘
```

### Repository layout this plan creates

```text
yaran/
├── crates/yaran-core/src/cloud/        Rust: cloud leg, credentials, machine identity, emitter, supervisor
├── crates/yaran-web/src/cloud_*.rs      Rust: ingress identity check, sealed handoff route, cloud mode route
├── crates/yaran-web/web/src/lib/native/ TS: native-shell detection, session-expiry probe, native menu items
├── cloud/
│   ├── protocol/      TS package: JSON Schemas, generated types, sealed-envelope codec, shared test vectors
│   ├── worker/        org control-plane Worker (Deploy to Cloudflare button target)
│   └── push-relay/    publisher-run Web Push → APNs relay Worker (open source, optional per build)
├── packages/
│   └── ui-kit/        shared design tokens + components used by the web UI, the app shell and the Worker console
├── mobile/
│   ├── app/           Capacitor app: bundled shell UI (onboarding, orgs, machines, settings)
│   ├── plugins/       first-party Capacitor plugins (machine-view incl. native Session, secure-store, push, qr)
│   │   └── core/      shared native code (not a plugin)
│   ├── android/       Gradle project, flavors `foss` and `play`
│   ├── ios/           Xcode project, Notification Service Extension
│   └── fastlane/      lanes + iOS metadata
├── fastlane/metadata/android/  Android store metadata at the path F-Droid reads (Phase 18)
└── tools/
    ├── module-headers/  header/module-tree generator + checker, 500-line gate (Phase 01)
    └── cloud-gates/     Phase 03 verification scripts (evidence in docs/plans/phoneapp/evidence/)
```

## Architecture decisions

Each decision cites the research that forced it (`research/…`). Phases implement these; a
phase that wants to change one must change this file in the same PR.

| # | Decision | Why |
|---|---|---|
| D1 | **One hostname per machine** (`<machine>-<user>.<zone>`, one label deep), never Worker path-proxying | Same-origin, Host guard and Access cookie scope work unchanged; avoids the same-zone `fetch` Access bypass, WS drops on Worker runtime updates and DO billing. R2 §Implications, R4 §Recommendations, cloudflare-parts/01 §2.5 (Universal SSL depth) |
| D2 | **One Access app + one reusable owner-only policy per machine**, created by code with `binding cookie` off, plus `originRequest.access {required, teamName, audTag}` in the tunnel ingress | Access must fail closed: it is the only gate in front of an unauthenticated API with shell/filesystem reach. Caps (500 apps/policies per account) documented and enforced. R4 Hard constraint 3 |
| D3 | **yaran verifies the Access JWT itself** for every request whose Host is the machine's cloud hostname (RS256, team JWKS, `iss`, `aud`, `exp`, `email == paired owner`, service-token JWTs rejected) | Defence in depth against a mis-set policy or a disabled `access.required`; loopback/LAN Hosts are unaffected. R4 Hard constraint 6 |
| D4 | **cloudflared preserves Host and speaks HTTP/1.1 to the origin**; no `httpHostHeader`; the tunnel hostname is a **live** host-guard rule, never a restart-bound `allowed_hosts` entry | Exact-string Origin==Host check; axum has no http2 feature. R1 §3, §Implications 5 |
| D5 | **Secrets never enter `config.toml` or `[env]`**: tunnel token, machine private key and Worker session live in an owner-only credentials file under the config root (`file_modes.rs`); token reaches cloudflared via `--token-file`/`TUNNEL_TOKEN`, never argv | `GET /api/v1/config/raw`, bootstrap `[env]` and `config diff --raw` would leak them. R1 §8, R3 §5 |
| D6 | **Machine → Worker calls are Ed25519-signed** (machine key generated by yaran at pairing, public key registered), served under an Access `public` path override `/v1/machine/*`; 50-service-token cap rules out service tokens | R4 Hard constraint 3, cloudflare-parts/02 §1 (`overrides`) |
| D7 | **Pairing uses a loopback redirect** (`gh auth login` style): browser SSO at the Worker, one-time code + PKCE back to `127.0.0.1:<port>`, claimed by a signed request | Existing `browser::open_url` + `ureq`. R1 §6, §Implications 7 |
| D8 | **Phone auth = system-browser SSO + sealed handoff.** The phone generates an ephemeral P-256 key; the handoff endpoint (served behind the target Access app, so Access attaches that app's JWT) seals the JWT to that key as a standard **JWE (ECDH-ES with Concat KDF, A256GCM; RFC 7516/7518; format and vectors in Phase 02)** and redirects to the app's callback. No unauthenticated exchange endpoint exists. Machine handoff is served by **yaran** on the machine hostname; the control-plane handoff by the **Worker**. **The callback is a verified https link** (Android App Link / iOS Universal Link on the publisher callback domain `<publisher-domain>`, D16; ASWebAuthenticationSession `.https` callback, so iOS minimum is 17.4) so no other app can receive it; the custom scheme `yaranapp://auth/callback` is accepted only by builds compiled without a publisher domain (forks, development), and those builds say so on screen. Every handoff page shows a one-tap consent interstitial naming the device and host | Google blocks embedded-WebView OAuth; cookies never cross from Custom Tabs/ASWebAuthenticationSession; strict service-token mode in new orgs; a hijacked custom-scheme redirect lets a malicious app run the handoff with its own key (Phase 02 §residual risk, Phase 11). R5 §2, cloudflare-parts/03 |
| D9 | **The app's WebView for a machine is a first-party native component (`machine-view` plugin) with no JS bridge**; the bundled Capacitor shell UI is the only bridge-enabled page | Capacitor's bridge does not check the caller's origin; remote content must never reach plugins. R5 §1 Recommendation |
| D10 | **The remote yaran UI is served by the machine, never bundled** | Keeps server-run identity reload tenet, same-origin, version parity. R2 Model A |
| D11 | **Push: every org Worker sends standard Web Push only**; Android `foss` flavor uses UnifiedPush, `play` flavor embeds the FCM distributor; iOS uses one open-source publisher relay that converts Web Push to APNs and is the only holder of the APNs key; payloads are E2E encrypted to the device and decrypted on device (iOS Notification Service Extension) | Self-hosted orgs cannot hold the publisher's APNs/FCM credentials. R5 §Push architecture |
| D12 | **The push hook is the rising edge of the attention decision, computed on a push-only set** that runs the same decision function with the same inputs at the same call site as `needs_attention`, so it is decoupled from `ui.attention_indicator` (with the indicator off, `needs_attention` is cleared every tick and never has an edge). Edges are handed off over a channel (engine is `!Send`, tick must not block) | R1 §5e, Phase 12 Evidence (`engine/mod.rs` gating) |
| D13 | **Capacitor** (8.x, upgrading to 9 when GA) for the shell; first-party plugins for machine-view, secure storage, push and QR (JS/WASM decoder, no ML Kit) | Reuse of React/Vite/Tailwind skills and components; F-Droid forbids ML Kit/Firebase in `foss`. R5 §1, §6 |
| D14 | **One app-signing key held by the maintainers for all Android channels** (uploaded to Play App Signing before the first release; F-Droid ships developer-signed reproducible builds) | Otherwise Play/GitHub/F-Droid installs can never upgrade each other. R5 Store-policy risks |
| D15 | **Release trains**: yaran binary keeps `yaran-vX.Y.Z`; new trains `yaran-cloud-vX.Y.Z` (protocol + Worker + relay) and `yaran-mobile-vX.Y.Z` (apps), each with its own workflow; compatibility by **protocol version negotiation** (Phase 02), never by lockstep releases. CLAUDE.md "Product identity" is updated to name them (Phase 17) | release.yml hard-codes 4 checksums and owns the binary pipeline. R3 §Implications 3 |
| D16 | **No invented domains.** Docs and code use `<zone>`, `<org-control-plane>` and `<publisher-relay>` placeholders; the maintainer supplies real publisher values via build config | CLAUDE.md product identity rule |
| D17 | **Cloudflare decrypts traffic at its edge**, and this is stated plainly in docs, threat model and onboarding | R4 Hard constraint 14 |
| D18 | **The Deploy button targets a generated, self-contained `cloud-deploy` branch** of `SiavZ/yaran`, published by the `yaran-cloud-v*` release workflow with `cloud/protocol` bundled in. On `main`, `cloud/worker` imports `cloud/protocol` as a workspace package; no vendored copy lives on `main`. The update checker reads the release manifest from that branch | A Deploy-button subdirectory must be self-contained (Phase 03 G11, Phase 07) |
| D19 | **`workers.dev` exists only to bootstrap setup.** It is enabled at deploy; until setup closes the Worker refuses every route on it except `/setup*` and `/v1/meta`. The wizard then attaches the custom domain by API and disables the `workers.dev` subdomain by API, and the Worker refuses any non-custom-domain Host from then on. `preview_urls` is always off; no custom domain is written into the wrangler config (CI deploys would overwrite the deployer's DNS) | Phase 03 G14, Phase 07 |
| D20 | **Three Deploy-time secrets**: `CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY` (encrypts secrets the Worker generates and stores in D1, such as the VAPID private key; a Worker cannot write its own secrets) | Phase 04 |
| D21 | **Provisioning order is policy → Access app → tunnel → ingress → DNS; teardown is DNS → tunnel connections → tunnel → Access app → policy**, so a hostname is never routable without its Access app | Cloudflare warns an unprotected routed hostname is reachable by anyone (Phase 05) |
| D22 | **Bearer credentials never enter JavaScript in the app.** The handoff client, envelope opener, per-host session store and the org API client (every Worker call, push registration included) are native, exposed to the shell as a plugin; JS orchestrates, native performs HTTP | Phase 15; Phase 16 aligns to it |
| D24 | **Handoff consent is remembered per (host, device key).** Each app install holds a long-lived, non-exportable P-256 **device key** in hardware-backed storage (Android Keystore / iOS Secure Enclave), separate from the per-handoff ephemeral sealing key. Every handoff request carries the device public key and a signature over (ephemeral key, state, host, timestamp). After the user consents once, the handoff endpoint sets a long-lived, host-only, HttpOnly, Secure consent cookie in the system browser binding the device-key fingerprint, MACed with a server-held key (yaran: a consent key in the Phase 09 credentials file; Worker: derived from `DATA_KEY`). A later handoff skips the consent page only when the cookie's fingerprint matches **and** the request signature verifies; a different app cannot produce that signature, so it always meets the consent page. Revoking a device (Phase 06) or rotating the consent key invalidates remembered consent | Consent on every renewal is unusable; consent never is unsafe (R2 residual risk) |
| D23 | **The Android app-signing key is generated and enrolled in Play App Signing in Phase 18, before any upload to Play** (internal tracks included) | Play keeps whichever key the first upload sets (Phase 21 risk) |

## End-to-end flows (contract details in Phase 02)

1. **Org setup**: Deploy button (D18: the `cloud-deploy` branch) → Workers Builds deploys the
   Worker, provisions D1, prompts for `CF_API_TOKEN` (from the pre-filled account-owned template
   link), `SETUP_CODE` and `DATA_KEY` (D20) → admin opens `https://<worker>.workers.dev/setup`
   (D19), enters the setup code → wizard attaches the custom domain and disables `workers.dev`
   → Worker verifies
   token permissions, selects zone, creates the control-plane Access app (with public overrides),
   checks identity providers (offers One-time PIN / GitHub / Google when only the Cloudflare
   account IdP exists), generates VAPID keys, records the admin, closes setup for good.
2. **Machine pairing**: `yaran cloud login <url>` → `GET /v1/meta` (protocol check) → generate
   Ed25519 machine key + PKCE verifier → open browser to `/v1/pair/authorize` (behind Access) →
   Worker shows the confirm page, provisions tunnel + DNS + machine Access app + policy
   idempotently, redirects to `http://127.0.0.1:<port>/callback?code&state` → yaran
   `POST /v1/machine/claim` (signed, PKCE) → receives tunnel token, hostname, team domain, AUD
   → writes credentials file → cloud leg starts cloudflared → `/ready` → live host rule set →
   both surfaces say so, and show the phone QR.
3. **Phone onboarding**: scan QR (`yaranapp://add-org?u=<org url>`) or type URL → `GET /v1/meta`
   → system-browser sealed handoff for the control plane → Worker JWT stored in the keystore →
   `GET /v1/me/machines` (status from the Cloudflare tunnel list API) → push registration
   (`POST /v1/me/devices`).
4. **Open a machine**: sealed handoff against `https://<machine-host>/__yaran/handoff` → JWT
   injected as the `CF_Authorization` cookie into `machine-view` → load `https://<machine-host>/`
   → renew before expiry or when the UI's session-expiry probe fires. **Consent is remembered
   per device (D24)**: the first handoff for a host shows the consent page; a renewal that proves
   possession of the same device key skips it. On iOS the system's own sign-in confirmation
   still appears on every ASWebAuthenticationSession, which no app can suppress.
5. **Push**: attention rising edge → yaran emitter → signed `POST /v1/machine/events` → Worker
   looks up the owner's devices → Web Push per device (UnifiedPush endpoint, FCM endpoint, or
   relay endpoint for iOS) → device decrypts → notification → tap deep-links to `#/agent/<id>`
   (and tab) on that machine.
6. **Unpair / revoke / rotate**: `yaran cloud logout`, the user's own console, or the admin
   console → ordered teardown (D21: DNS → tunnel connections → tunnel → Access app → policy) →
   machine's yaran learns on its next signed call and stops the leg out loud; phones see the
   machine vanish; token rotation patches `tunnel_secret` and re-delivers the token.

## Phases

The list is ordered as the owner asked: **phases that can run in parallel first, phases that
must run alone last.** Within Wave B every phase codes against the Phase 02 contract (fully
specified in that document, so implementation can start on day one) and against the Phase 03
gate outcomes (each affected phase already specifies primary and fallback).

### Wave A — parallel, no dependencies (start immediately)

| Phase | Title |
|---|---|
| [01](01-conventions-and-enforcement-tooling.md) | Conventions and enforcement tooling (module-header trees, 500-line gate, CI aggregator) |
| [02](02-protocol-contract.md) | Protocol contract and shared `cloud/protocol` package |
| [03](03-platform-verification-gates.md) | Platform verification gates (live proofs of every unproven external fact) |

### Wave B — parallel with each other (code against 02; consume 03 outcomes)

| Phase | Title |
|---|---|
| [04](04-worker-foundation-and-security.md) | Org Worker: foundation, Access JWT, signed machine API, D1, audit |
| [05](05-worker-provisioning-engine.md) | Org Worker: Cloudflare provisioning engine and reconciliation |
| [06](06-worker-pairing-and-sessions.md) | Org Worker: machine pairing, phone sessions, sealed handoff, devices |
| [07](07-worker-setup-admin-and-deploy.md) | Org Worker: Deploy button, setup wizard, admin and user console, updates |
| [08](08-push-delivery-and-relay.md) | Push delivery: org Web Push sender and publisher APNs relay |
| [09](09-yaran-cloud-identity-and-cli.md) | yaran: cloud config, credentials store, machine identity, `yaran cloud` CLI |
| [10](10-yaran-cloudflared-leg.md) | yaran: cloudflared acquisition, supervisor leg, control lane, surfaces |
| [11](11-yaran-ingress-security-and-handoff.md) | yaran: tunnel ingress security, Access JWT verification, sealed handoff route |
| [12](12-yaran-attention-push-emitter.md) | yaran: attention event emitter to the control plane |
| [13](13-web-ui-native-integration.md) | Web UI: native-shell integration and Access-session UX |
| [14](14-mobile-app-foundation.md) | Mobile: Capacitor app foundation and bundled shell UI |
| [15](15-mobile-machine-view-and-auth.md) | Mobile: `machine-view` native component and SSO/handoff client |
| [16](16-mobile-push-clients.md) | Mobile: push clients (UnifiedPush, embedded FCM, APNs + NSE) |
| [17](17-docs-website-threat-model.md) | Docs, website, threat model, SECURITY.md, product identity |
| [18](18-build-ci-and-release-pipelines.md) | Build, CI and release pipelines for all trains and channels |

### Wave C — sequential, in this order

| Phase | Title |
|---|---|
| [19](19-integration-and-end-to-end-verification.md) | Integration and end-to-end verification on real Cloudflare and devices |
| [20](20-security-review-and-hardening.md) | Security review, penetration test, MASVS audit, hardening |
| [21](21-publisher-infrastructure-and-store-readiness.md) | Publisher infrastructure and store readiness |
| [22](22-launch-and-operations.md) | Launch, staged rollout and operations |

### Dependency edges

```text
02 ──contract──▶ 04 05 06 07 08 09 10 11 12 13 14 15 16
03 ──gates────▶ 06 08 10 11 13 15 16 18      (each names its primary/fallback)
01 ──gate─────▶ every PR from Wave B onward must pass `module-headers --check`
04 ─▶ 05 ─▶ 06 ─▶ 07   (code-level; may be developed concurrently against mocks)
09 ─▶ 10, 11, 12       (credentials store is the shared seam)
14 ─▶ 15, 16
all of Wave B ─▶ 19 ─▶ 20 ─▶ 21 ─▶ 22
```

## Research

Primary evidence, copied here so it outlives any session (cite it, then re-verify against
the live code before acting, per `00-CONVENTIONS.md` §Research protocol):

- [`research/R1-server-core-cli.md`](research/R1-server-core-cli.md): serving modes, Tailscale leg, host guard, routes, attention, CLI, processes, secrets, statusline
- [`research/R2-web-frontend.md`](research/R2-web-frontend.md): build/embedding, base paths, PWA, connection lifecycle, WebView differences
- [`research/R3-repo-process.md`](research/R3-repo-process.md): repo layout, CI/release, config checklist, docs, security docs, plan format
- [`research/R4-cloudflare.md`](research/R4-cloudflare.md) and [`research/cloudflare-parts/`](research/cloudflare-parts/): Tunnel, DNS, Access, JWT, native auth, token templates, Deploy button, Workers limits, cloudflared
- [`research/R5-mobile.md`](research/R5-mobile.md): stack, auth, push, store policies, security, QR, release engineering

# Phase 17 — Docs, website, threat model, SECURITY.md, product identity

**Track:** B (parallel) · **Parallel-safe with:** 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 18
**Depends on:** 02 (names of commands, settings, surfaces), 01 (header gate for the code files this phase creates) · **Blocks:** 19 (docs are walked as part of the scenario matrix), 20 (threat model is the review baseline), 21 (store copy, privacy wording), 22

## Goal

When Cloud Connect and the phone apps ship, every page a user reads already tells the truth
about them, and nothing that used to be true is now false. That covers:

- the consumer docs and the marketing site;
- the threat model and `SECURITY.md`, with one numbered threat for every new surface;
- `CLAUDE.md`, so later contributors keep D1–D24 without having to rediscover them;
- attribution for the third-party software we now depend on;
- screenshots that the existing screenshot test pins.

The phase lands in two steps:

1. **First PR, in week one of Wave B.** The threat entries T25–T64 and their STRIDE rows go
   in as a **design-stage draft**. That way every implementing phase can follow
   00-CONVENTIONS §5 ("new attack surface updates the threat model in the same change") by
   **editing its own row** rather than inventing an ID.
2. **The rest.** It lands as each surface becomes real.

## Evidence

All repo citations were re-verified against the tree on 2026-11-14.

**Threat model and SECURITY.md**

- `docs/operations/threat-model.md` is 1131 lines.
  - Each section uses the heading `## T<n> — <title>`, followed by the four bold paragraphs `**Attack scenario.**`, `**Mitigation in code.**`, `**Residual risk.**` and `**Detection.**`. Sections are separated by `---` (T24 is at :1076-1114).
  - The last ID is **T24** (:1076).
  - The counts are stale in three places: "For each row **T1–T20**" (:3-9), "The IDs `T1`–`T23` are stable" (:1125), and the append example at :1125-1131 names `T23`, which is already used.
  - The maintenance rules are at :1118-1131: append only, strike through retired IDs, and add a `Status:` line for accepted risks.
  - Nothing in the file models the web server, the no-login surface, Tailscale, tunnels or cloudflared. A grep for those terms finds nothing.
  - T5 (:225-250) says "We do not encrypt secrets at the application layer" (:242-244).
- `SECURITY.md` is 168 lines.
  - Reporting is at :8-13 (email, 72 h acknowledgement).
  - Scope is at :15-29. The out-of-scope list (:28-29) covers upstream binaries, `amq`, cloud IAM and the kernel.
  - The trust model is "single-user, single-Linux-account" (:31-40).
  - The STRIDE table header is at :50, with columns `# | Threat | STRIDE | Asset | Mitigation | Phase`. Rows run from T1 (:52) to T24 (:75).
  - The in-scope and accepted-risk lists are at :77-124.
  - "Same PR" rule for new egress or attack surface: :158-162.
  - `scripts/validate-threat-model.sh` is described as planned (:164-168) and does not exist.

**Product identity and pages that become false**

- `CLAUDE.md:3-9` covers product identity: `yaran-vX.Y.Z` tags only, no invented domain, and so on.
- `README.md:72-84` ("Release binaries") and `docs/operations/rebranding.md:37` say releases use `yaran-vX.Y.Z` tags and that `install.sh` installs from them. Both stay true for the binary but say nothing about the two new trains (D15).
- `CLAUDE.md` "Important Constraints" describes the web server as "single-tenant / trusted-access … There is no login", with access delegated to "loopback scope, Tailscale ACLs, or an upstream proxy". It also says "Target platforms are macOS and Linux only."
- Pages that become false or incomplete:
  - `website/docs/server-mode.md`: :3, :187, :190-192, :200-210, :213-218, :220, :258-259. The `[server]` key table is at :232-331 and "Where to go next" at :353-366.
  - `website/docs/public-hosting.md`: :9-10, :16, :20-23, :288, :328-331, the cloudflared caution at :333-338, and :421-423.
  - `website/docs/tailscale.md`: :13, :46, :167, :204, :226, and "Where to go next" at :280-287.
  - `README.md`: :37, :108, :315-337 (Server Mode; "**And there is no login.**" at :331), and the Documentation list at :97-108.
  - `website/src/components/ServerMode.astro`: :2-7, :65-72 ("There is no authentication layer in yaran at all, and none is planned"), and the CTAs at :164-174.

**Website structure**

- The docs frontmatter schema is in `website/src/content.config.ts:8-21`: `title`, `description`, `group` (default "Guides") and `order` (default 100).
- `DocsSidebar.astro:12-32` sorts pages by order, then title. Groups sort by their lowest order.
- Orders currently in use: Getting started 1-3, Guides 10-50, Web UI 60-67, Reference 90-100. **68-89 are free.**
- Admonitions use the `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` syntax (`website/src/lib/remark-admonitions.mjs:10-21`).
- The feature tiles are in `website/src/components/FeatureGrid.astro`. Tiles run :51-536; the phone tile is at :447. The tone is wry and first-person (:20).
- The site has a blog collection in `website/blog/` (`content.config.ts:23-52`).

**Screenshot pipeline**

- `website/src/lib/docs-screenshots.test.ts` requires every `public/screens/*.png` to have a scene `<stem>.js` in `tools/preview-env/screens/scenes/` and the reverse (:148-162). It checks that `mod.file` matches (:164-172) and enforces the scene shape (:176-196): a TUI scene needs `cols`, `rows` and `theme`; a browser scene needs `viewport` and `shoot`.
- Browser scenes must call an `expect*` guard (:202-218). Every PNG must be referenced by a docs page (:291-295), and the allowlist is empty (:18, :297-299).
- The phone preset is `PHONE = {390, 844}` (`tools/preview-env/screens/lib.js:21`), and `run.js:125` applies it when `viewport === "phone"`.
- `reshoot.sh` sets `YARAN_SCREENS=1` (:21-30) and runs `seed.js` and `run.js` (:171-174).
- The repo has **no native mobile screenshot tooling** (no fastlane, Maestro, simctl or screengrab).

**Licensing**

- `LICENSE` is MIT. There is no NOTICE, THIRD_PARTY or COPYING file.
- cloudflared is Apache-2.0 (R4 Hard constraint 13). `deny.toml` covers cargo only (R3 §9).

**Research**

- R3 §6-§7 and §Implications 7-8, R1 §8 and §Implications 12, and R4 Hard constraint 14 (Cloudflare decrypts at its edge; D17).

## In scope

- New consumer docs pages and edits to every page listed in Evidence.
- `website/` marketing copy.
- `README.md` and `CONTRIBUTING.md`.
- `docs/operations/threat-model.md`, sections T25–T64, plus the stale-count fixes.
- `SECURITY.md`: scope, trust model, STRIDE rows and accepted risks.
- Root `NOTICE`.
- `CLAUDE.md`: product identity, constraints, and the new tenet sections.
- New screenshot scenes, plus a shell-UI capture path that reuses the existing pipeline.
- One new docs guard test.

## Out of scope

| Item | Owner |
|---|---|
| The Deploy to Cloudflare README badge | 07 |
| Tag-protection and branch-protection edits for the new trains | 18 |
| Generated license inventories for npm, Gradle and SwiftPM | 18 |
| In-app licenses screen | 14 (screen) and 21 (content check) |
| `PRIVACY.md` and the data inventory | 20 (inventory) and 21 (policy) |
| Store listings and store screenshots | 21 |
| Launch blog post and real store links in docs | 22 |
| `docs/operations/` runbooks and key-compromise playbooks | 20 and 22 |
| Mitigation **code** for each threat | The phase named in the threat's row |

## Design

### Honest framing (applies to every page)

The headline stays: **yaran still has no login of its own.** Cloud Connect puts Cloudflare
Access, the org's SSO, in front of one hostname per machine. yaran then checks the Access
token itself for requests on that hostname (D2, D3).

Every page that currently says "there is no login" gets a sentence of this form, never a
removal:

> yaran has no login of its own. If you use Cloud Connect, Cloudflare Access is the login
> for that one hostname, and yaran double-checks it.

Every Cloud Connect page carries a `> [!WARNING]` that says Cloudflare terminates TLS and
can read terminal traffic and file contents (D17). The docs never use a real hostname
(D16): they use `<zone>`, `<org-control-plane>`, `<publisher-relay>` and
`<publisher-domain>` (the callback domain, D8). A guard test (work item 9) enforces this.

### New docs group: "Cloud Connect" (orders 70-77, between Web UI and Reference)

The pages are added through frontmatter only.

| File | Order | Audience | Content (consumer facts only; no routes, wire or engine internals) |
|---|---|---|---|
| `website/docs/cloud-connect.md` | 70 | everyone | What it is. How it compares to Tailscale and to `public-hosting`. The D17 WARNING. What each party can see (summary table). Prerequisites: a Cloudflare account, a zone, a Zero Trust org (the Free plan still needs a payment method, R4 HC4). Limits: about 500 machines per account (D2). |
| `website/docs/cloud-admin-setup.md` | 71 | org admin | The Deploy button, which deploys the self-contained `cloud-deploy` branch of `SiavZ/yaran` that every `yaran-cloud-v*` release regenerates (D18). The **three values the deploy asks for** (D20): the pre-scoped API token (from the pre-filled template link, with what each permission is for), the setup code, and the data key (what it protects, a generator one-liner, and that losing it makes the stored secrets unreadable; how to rotate it, and that a rotation makes every phone meet the sign-in confirmation page once more, D24). Opening `/setup` on the Worker's `workers.dev` address, which answers nothing but the setup page and the service-info check until setup finishes. Choosing a zone and the custom domain: the wizard attaches it and turns the `workers.dev` address off, and from then on only the custom domain answers (D19). Identity providers (One-time PIN, GitHub, Google offer). The admin console: users, machines, phones, audit, and settings (session length, who may pair, machine cap, push on/off, stale-machine policy). Updating a cloned deployment from a newer `cloud-deploy` release. Removing everything, and the order it happens in (D21). |
| `website/docs/cloud-connect-machine.md` | 72 | developer | `yaran cloud login <url>`, `logout`, `status`, `rotate` and `pair-phone`. The TUI palette and web app-menu equivalents (named per surface; never conflated, per CLAUDE.md). Comparing the **machine key fingerprint** on the browser's confirm page with the one the terminal prints before confirming (format from 02). What `logout` does: the machine's hostname, tunnel and Access app are removed on the Cloudflare side, then the local credentials (R8). What yaran downloads (pinned cloudflared) or how to point at your own. The **`[cloud]` config keys table** (exactly the keys Phase 09 renders, with defaults). What happens when the machine is revoked. Where credentials live (owner-only file, never in `config.toml`). |
| `website/docs/mobile-apps.md` | 73 | developer | The four install channels and how they differ: Play, GitHub APK, F-Droid, App Store. Why a Play install and a GitHub or F-Droid install can upgrade each other (one signing key, D14). Onboarding by QR or by typing the org URL. **Signing in** (D8): the system browser runs the org's SSO, then a confirmation page naming this phone and the host asks for one tap (Continue or Cancel) the first time this phone signs in to each host (the control plane and every machine). Later sign-ins and renewals on the same phone skip that page (D24); it comes back after the phone is removed or revoked, the app is reinstalled or the org re-added, the machine is re-paired, the admin rotates the data key, the browser's cookies are cleared, or about once every 400 days. On iOS the system's own sign-in confirmation still appears on every sign-in, renewals included, and no app can suppress it. The browser then hands back to the app through a link the publisher's domain vouches for, so no other app can receive it. iOS 17.4 or newer. A `> [!WARNING]` for builds made without a publisher domain (forks, development builds): they hand back through a custom link that any installed app can claim, and the app shows a warning saying so. Machines list and status. Opening a machine. Biometric lock. Screenshot protection. Signing out and removing a device. Store links are added by 22. |
| `website/docs/push-notifications.md` | 74 | developer | When a push fires (an agent needs you, or a tab ended badly). What a notification contains: label, project and state word, never agent output. End-to-end encryption past the org Worker. Per channel: UnifiedPush plus choosing a distributor (with ntfy as an example) on F-Droid and GitHub builds; Google's service on Play builds; Apple's service via the publisher relay on iOS. Muting per org and per machine. "Push stopped": when a push service reports a phone's subscription gone, the phone stays listed but receives nothing until the app registers again, and the consoles say so (R11). The `[cloud] push_notifications` key. |
| `website/docs/cloud-security-privacy.md` | 75 | admin and security reviewer | The trust model: remote identity equals the paired owner. A table of who can see what: Cloudflare (everything at the edge), the org Worker (metadata, no terminal data), the publisher relay (APNs device token, org push public key, ciphertext), Apple, Google and the distributor (ciphertext and timing). Revocation and how fast it takes effect (from G12). Why a machine's hostname is never reachable before its Access app protects it (created policy first and DNS last, removed DNS first; D21). Why the first phone sign-in to each host shows a confirmation page, why later renewals on that phone do not (the page is remembered only for a request that proves it comes from this install, which no other app can do), and what makes it come back (D8, D24). That a revoked phone loses this memory on the control plane at once but keeps it on machines until the machine is re-paired or logged out, which still requires that person's valid sign-in (accepted risk). What stays on the phone. Links to `SECURITY.md` and the privacy policy (21). |
| `website/docs/cloud-troubleshooting.md` | 76 | everyone | One subsection per message the surfaces print: protocol mismatch, setup closed, quota reached, cloudflared not ready, machine revoked, the expired Access sign-in cover, sign-in cancelled on the confirmation page, the confirmation page showing on every renewal (the browser is not keeping its cookies; per-browser notes from Phase 19's run), sign-in that never returns to the app (per-browser table from G13), the `workers.dev` address refusing requests after setup, push not arriving per channel (including "push stopped"), and phone shows a machine offline. Each message is quoted exactly as the code emits it, so its wording is pinned by the code phase. |
| `website/docs/operating-your-control-plane.md` | 77 | org admin | **Reserved here; written by 22.** |

Implementation note: each page's message list and keys table is copied from the merged
code, never from this plan. The PR that lands a page cites the commit it was written
against.

### Edits to pages that become false

| File:lines | Change |
|---|---|
| `server-mode.md:3,187-192` | Keep "no login of its own". Add the Cloud Connect sentence and a link. |
| `server-mode.md:200-210` | Add a fourth bullet. Cloud Connect adds **no listener**: a supervised `cloudflared` dials out to yaran's loopback address (R1 §Implications). That is why it is not a fourth way to serve. |
| `server-mode.md:213-220` | Name Cloud Connect beside the proxy and Tailscale. Rewrite :220 ("about browser attacks, not user authentication") to say that on the cloud hostname yaran also verifies the Access token. |
| `server-mode.md:258-259`, `:328-331`, `:353-366` | Point to the `[cloud]` table in `cloud-connect-machine.md`, and add Cloud Connect to "Where to go next". |
| `public-hosting.md:9-23` | Keep the recipe. Add a TIP naming Cloud Connect as the packaged alternative. |
| `public-hosting.md:328-331, 421-423` | Add the one exception: on the cloud hostname, yaran reads the identity from the Access token for its owner check. It still reads no `X-Forwarded-*`. Wording is subject to 11's decision on logging the identity. |
| `public-hosting.md:333-338` | Keep the warning against unauthenticated tunnels. Add "the authenticated way to use cloudflared is Cloud Connect", with a link. |
| `tailscale.md:13, 46, 204, 226` | Scope each "no login" to the tailnet leg. |
| `tailscale.md:167` | Name Cloudflare's edge as another TLS terminator. |
| `tailscale.md:280-287` | Present Cloud Connect as the third answer. |
| `README.md:72-84` ("Release binaries") | Name the three trains (D15). The `yaran` binary archives ship only on `yaran-v*` releases. `install.sh` with no version installs the newest `yaran-v*` release even when a `yaran-cloud-v*` or `yaran-mobile-v*` release is newer, because new-train releases are never marked latest (`--latest=false`) and the installer filters on the `yaran-v` prefix. Both mechanisms are Phase 18's edits; this row only documents them. |
| `docs/operations/rebranding.md:37` | Add one sentence: the cloud and mobile trains use `yaran-cloud-vX.Y.Z` and `yaran-mobile-vX.Y.Z`, never a `dux-` name, and do not change binary release naming. |
| `README.md:37, 97-108, 315-337` | Same framing. Add Documentation bullets for the new pages and a short "Phone app and Cloud Connect" subsection after Server Mode. The badge is not included (07 owns it). |
| `website/docs/faq.md` | Add entries: "Do I need Cloudflare to use the phone app?" (yes; the app speaks Cloudflare only). "Does Cloudflare see my code?" (yes, D17). "Can I self-host the push relay?" (Android needs none; iOS needs the publisher relay, which is open source). |
| `ServerMode.astro:2-7, 65-72, 109-114, 164-174` | Rewrite "none is planned" so it stays true: "yaran has no login of its own, and Cloud Connect borrows your org's". Add a CTA, "Connect through Cloudflare →". |
| `FeatureGrid.astro`, new tile before `:537` | Phone-app tile, in the site's voice, for example "Your agents, in your pocket. Ask nicely and they'll even buzz." Add `data-surface="both"` and no feature counts. |

### Threat model: draft entries T25–T64

These are the design-stage drafts landed in the first PR.

- The **owning phase** writes the final `Mitigation in code.` text, with symbols, in its own
  PR. Phase 20 verifies every row against the implementation.
- Every section has the four bold paragraphs. Detection names a log target, audit event or
  alert.
- The `Phase` column in `SECURITY.md` cites `phoneapp NN`.

| ID | Threat | STRIDE | Asset | Mitigation (design) | Owner |
|---|---|---|---|---|---|
| T25 | yaran's unauthenticated web API reachable from the internet via the tunnel if the Access app or policy is missing, mis-scoped or deleted, or DNS is published before the app protects it | S, E | Whole workspace: PTY input, filesystem, config rewrite | One app and an owner-only reusable policy per machine, created by code (D2) in the order policy → app → tunnel → ingress → DNS and torn down DNS → connections → tunnel → app → policy (D21), so no DNS record ever points at an unprotected tunnel. Per-tunnel-route `originRequest.access` (`required` plus `audTag`) on every machine ingress rule, with cloudflared ≥ 2026.11.0 (G2), so cloudflared rejects a request with no valid JWT. yaran verifies the JWT itself (D3). Reconciliation detects drift. **Residual risk:** if G2 shows per-rule `access.required` does not enforce, yaran's JWT check is the only origin-side gate; this row then records the reduced defence in depth. | 05, 10, 11 |
| T26 | Access JWT forgery, confusion or replay at yaran: wrong `aud`, wrong team, expired, a service-token JWT, another user's email, or JWKS unavailable | S | Workspace | RS256 against the team JWKS, cached by `kid`. Checks on `iss`, `aud`, `exp` and `nbf`. `email ==` paired owner. Service-token JWTs rejected. Fails closed when JWKS is unavailable. Applies to every HTTP request and WebSocket upgrade on the cloud Host. | 11 |
| T27 | Tunnel token stolen from the developer machine (file read, argv, `ps`, backups, `config/raw`, `[env]`) lets an attacker run a rogue connector and take traffic | S, I | Tunnel identity and the requests it carries | Owner-only credentials file under the 0700 config root (D5, `file_modes.rs`). Never in config or `[env]`. Passed by `--token-file` or env, never argv. `yaran cloud rotate` patches `tunnel_secret` and kills connections. | 09, 10, 05 |
| T28 | Machine Ed25519 key theft or signed-request replay against `/v1/machine/*` (events, config fetch, `PUT /v1/machine/origin`, `POST /v1/machine/unpair`) | S, R, T | Machine identity: events, config fetch, origin port, unpair | Key stored in the credentials file. Signature covers 02's canonical string (method, path, Host, protocol version, machine id, timestamp, nonce, body hash). Nonce store plus a ±300 s timestamp window. Revoking the machine invalidates the key. `PUT /v1/machine/origin` is signed like every machine route, because a forged one would retarget the tunnel's ingress to another local port. | 09, 04, 05 |
| T29 | cloudflared supply chain: tampered download, stale pin with a known CVE, or self-update replacing the binary | T, E | Code running as the developer | Pinned version with a SHA-256 table compiled into yaran; fails closed. A minimum version (2026.11.0, G2) is checked for a user-supplied binary too. `--no-autoupdate`. Owner-only storage. A pin-bump process. A user-supplied path is the user's responsibility and is documented. | 10, 18 |
| T30 | cloudflared's unauthenticated metrics endpoint (config, pprof) reached by another local user or a browser page | I | Tunnel config | `--metrics 127.0.0.1:<port>` set explicitly. Port configurable. Documented. | 10 |
| T31 | Org Worker compromise or a malicious change in the deployer's `cloud-deploy` branch; the Worker holds `CF_API_TOKEN` (Tunnel, Access, DNS edit) | E, T | The org's Cloudflare account and every machine policy | Least-privilege token template (G9), each permission's blast radius documented. workers.dev answers only `/setup*` and `/v1/meta` until setup closes, then the wizard disables it by API and non-custom-domain Hosts are refused (D19). `preview_urls=false`; no custom domain in the wrangler config. Admin UI behind Access. No third-party scripts in the console. An update checker that verifies release tags. Audit log. | 04, 05, 07 |
| T32 | Same-zone `fetch` from the Worker bypassing Access on machine hostnames | E | Machine origins | No Worker proxying (D1). `global_fetch_strictly_public`. cloudflared `access.required` as the second gate. | 04, 05 |
| T33 | Setup takeover before setup closes (setup-code guessing over the restricted workers.dev window, a race between two admins) | E | Org control plane | `SETUP_CODE` (≥ 24 characters) is a deploy-time Worker secret (D20). Rate-limited with lockout, constant-time compare. Only `/setup*` and `/v1/meta` answer on workers.dev in that window (D19). Setup closes permanently in one D1 transaction, after which `/setup*` answers `410 setup_closed` and workers.dev is disabled. Audit event. | 04, 07 |
| T34 | Cross-user authorization flaws in the Worker: IDOR on machine or device ids (including per-device mute settings and `push_state`), role escalation to admin | E, I | Other users' machines and phones | Every query is scoped by the authenticated email. Role comes from D1 settings only. An authz matrix test covers every route × role × owner, the device mute API included. | 04, 06, 08 |
| T35 | Pairing hijack: forged authorize request (CSRF), stolen loopback code, code injection into another machine's callback, a pairing link crafted by someone else | S | Machine enrolment | PKCE plus `state`. The authorize page shows the machine name and the machine key fingerprint (format defined in 02; the terminal prints the same string) and needs a confirm. A one-time code with a short TTL. The claim needs the machine signature and the PKCE verifier. | 06, 09 |
| T36 | Sealed-handoff interception: another app receives the callback, `state` is replayed, the redirect parameter is abused, or a forged handoff rides the user's live SSO session | S, I | Access JWTs (and the optional `cookie`) for the control plane and machines | Handoff payload (JWT plus optional `cookie`, the G1 fallback) sealed as JWE ECDH-ES + A256GCM to an ephemeral P-256 key held only by the app (D8). Release builds return on the verified https callback on `<publisher-domain>` (Android App Link via Auth Tab or Custom Tab; iOS `ASWebAuthenticationSession` `.https`, iOS ≥ 17.4), which the OS delivers only to the app the domain vouches for (see T63). The 02 redirect allowlist accepts exactly that callback, and `yaranapp://auth/callback` only when the request declares a dev build. Worker `/v1/handoff` and yaran `/__yaran/handoff` show a one-tap consent interstitial naming the device and host before sealing, so a silent SSO auto-approve cannot complete a handoff the user did not start. The interstitial is remembered per (host, device key) after an explicit Continue (D24, 02 §8.1): a later handoff skips it only when the request carries a verifying ES256 `dsig` from this install's hardware-held device key (`dk`, `dts`, `dsig`) and the MACed consent cookie names that key's fingerprint, so a flow started by any other app, or by a dev-build hijacker, cannot sign and always meets the page. The skip surface itself is T64. `state` single-use with a short TTL. No unauthenticated exchange endpoint. `no-store` headers. **Residual risk:** a build compiled without a publisher domain uses the custom scheme, which any app on the phone can register; such builds show a visible warning in the app. A hijacked flow the user started yields only ciphertext; a hostile app that starts its own flow still needs the user to tap through the interstitial, and remembered consent does not change that, because the hostile flow cannot produce this install's device signature. | 02, 06, 11, 14, 15 |
| T37 | Phone token theft at rest or on device loss: secure store, backups, logs, diagnostics export | I, S | Control-plane and machine JWTs, push keys | Keychain `ThisDeviceOnly` and an Android Keystore AES-GCM key. `allowBackup=false` plus extraction rules. Diagnostics redact tokens. Optional biometric lock with `CryptoObject` or `SecAccessControl`. Device revoke from the console. | 14, 15, 06 |
| T38 | `machine-view` WebView escape: remote content reaches a native bridge, navigates to a foreign origin, reads local files | E | Phone and app secrets | No JS bridge in `machine-view` (D9). Exact-host navigation allowlist. File and content access off. External links go to the system browser. Debugging off in release. | 15 |
| T39 | Push content exposed to Google, Apple, the distributor or the relay | I | Agent labels and project names | RFC 8291 end-to-end encryption to device keys. Minimal payload (D11, 02). Generic visible fallback text. Decrypted on device (NSE). | 08, 12, 16 |
| T40 | Publisher relay abused (minting endpoints, push floods, cost) or compromised (holds the APNs key) | D, S, E | APNs key; every iOS user's notifications | Endpoint bound to the org VAPID key. The VAPID JWT is verified against that exact key. Per-key and per-device rate limits. No token logging. APNs key held only in the relay environment. Key-compromise playbook (20). | 08, 21 |
| T41 | Org VAPID private key compromise lets an attacker spoof pushes to the org's devices | S | Notification integrity | Generated by 07 and encrypted at rest with `DATA_KEY`. Rotation (07) re-registers devices. Payload is still end-to-end encrypted to device keys, so a VAPID key alone cannot produce a readable notification. | 04, 07, 08 |
| T42 | Malicious deep links or QR codes: a `yaranapp://add-org` link or QR pointing at an attacker's org, or a notification tap opening a foreign host | S, T | User's SSO credentials, trust in the app | Adding an org shows the org name and domain from `/v1/meta` and needs a confirm before SSO. The genuine QR payload is built only from the canonical control-plane host, never the request's Host (06). Deep links only open hosts of already-paired orgs. Notification taps are validated against the machine list. | 06, 14, 15, 16 |
| T43 | Cloudflare sees all tunneled traffic in plaintext at its edge | I | Terminal I/O, file contents | **Accepted risk** (`Status:` line). Stated in docs, onboarding and the store listing (D17). Layer-4 alternatives would break the HTTPS hostname model. | 17 |
| T44 | `/api/v1/config/raw` and bootstrap `[env]` reachable remotely by the authenticated owner; a stolen phone session reads secrets in `[env]` | I | Env secrets, config | Decision record in 11: remote identity equals the owner. Mitigated by T26/T37 controls and session duration. Documented. | 11 |
| T45 | Revocation lag: a revoked device or machine keeps working until JWT expiry, or an open WebSocket survives expiry | E | Workspace | Short Access session duration (configurable). Teardown removes DNS first (D21) and invalidates the tunnel secret before deleting connections (05). Token rotation plus a connection kill. yaran re-checks the JWT on reconnect and closes open sockets with 4401 at `exp + skew` (setting per G12). Optional sign-out-everywhere via Access `revoke_user` (06). **Residual risk:** Access has no per-device revocation, so a stolen phone keeps a control-plane JWT for the session duration; the UI says so beside the revoke action. | 05, 06, 11 |
| T46 | Android signing key or App Store credentials compromised, allowing a malicious update on every channel | T, E | Every installed app | One app-signing key under maintainer custody (D14). Play App Signing plus a separate upload key. Protected GitHub environments. CODEOWNERS on release workflows. Playbook (20). | 18, 21 |
| T47 | Deploy secrets (`CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY`; D20) leaked through Workers Builds logs, `.dev.vars` or the admin UI | I, E | Org Cloudflare account; every `DATA_KEY`-sealed secret | Prompted as secrets at deploy and never echoed. `.dev.vars` gitignored. The console never displays them. The secret-leak sentinel test covers logs and responses (04). A rotation procedure is documented for each. | 04, 07 |
| T48 | Repudiation or tampering of admin actions (revoking machines, changing policy) | R | Audit trail | Append-only `audit_log` in D1 for every mutating route. Exportable from the console. | 04 |
| T49 | Quota or budget exhaustion: one user pairs many machines, or API calls exhaust the 1200/5 min budget, the 500-app cap or the D1 write budget | D | Org's ability to pair | Per-user machine cap. Quota guard with clear errors. Rate-limit binding. Reconciliation uses list calls. Cron dispatcher per-run budgets. | 04, 05, 06 |
| T50 | Spoofed update notice in the GitHub flavor leading users to a malicious APK | T | Phone | The notice links only to `github.com/SiavZ/yaran` releases. No in-app installer. Checksums and provenance on the release (18). | 14, 18 |
| T51 | Diagnostics or crash logs leak tokens or hostnames when shared for support | I | Tokens, infrastructure names | Local-only diagnostics. Redaction tested with fixtures. Export needs an explicit user action. No third-party crash SDK. | 14 |
| T52 | Malicious upstream `yaran-cloud-v*` release pulled into an org's deployment | T | Org control plane | The Deploy button and updates consume the generated, self-contained `cloud-deploy` branch built by the `yaran-cloud-v*` release workflow (D18). Signed tags and provenance attestations. The update procedure has the admin review the diff and changelog before merging into their clone. | 07, 18 |
| T53 | Attacker-controlled text (Cloudflare API errors, cloudflared stderr, push provider responses) injects terminal escapes into logs or the status line | T | Operator terminal, logs | `yaran_core::sanitize::for_terminal` before logging or showing. Worker escapes output in console HTML. | 05, 08, 10 |
| T54 | Control-plane Worker reached without a valid identity: control-plane Access app missing or mis-scoped, a service-token JWT, wrong `aud`, a disabled user | S, E | Org control plane; every user's machines and phones | The Worker verifies the Access JWT from the header on every non-public route (RS256 pinned, `iss`/`aud`/`exp`/`nbf`), rejects service-token JWTs and disabled users, and fails closed when JWKS is unavailable. Every route row declares an `auth` class or `tsc` fails. Access group membership is decided by the Access policy (07); the Worker does not re-evaluate groups it cannot see. | 04, 06, 07 |
| T55 | D1 contents exposed (account-level read, export or backup) | I | Sealed secrets, pairing codes, device push keys and endpoints, user emails | Worker-generated secrets stored only `DATA_KEY`-sealed with row-bound AAD. One-time codes stored as hashes. Tunnel tokens never written to D1 (a full-table scan test proves it). Emails and machine metadata remain readable to whoever can read the account's D1. | 04, 05, 06, 08 |
| T56 | Control plane acts on Cloudflare resources it does not own: confusion between two deployments in one account, or orphan cleanup deleting a foreign resource | T, D | Other deployments' and the account's own tunnels, apps, policies and DNS | Instance marker on every created resource. Orphan cleanup acts only on marked resources past a grace period. Never undocumented `cascade`. | 05 |
| T57 | Device-supplied push endpoint turns the org Worker into a fetch (SSRF) client | E, I | Same-zone or internal services; Worker egress budget | Endpoint policy defined by 08 and enforced at device registration (06). `global_fetch_strictly_public`. A 404 or 410 clears the subscription and marks the device `gone`. | 06, 08 |
| T58 | yaran's process-wide handoff rate limit lets one client starve another phone's sign-in | D | Phone sign-in availability | Default 12/min against an expected ~1/day/phone. The limit and its key are configurable. | 11 |
| T59 | Attention-event metadata (agent label, project, state token) visible in plaintext to the org Worker and D1 | I | Agent labels and project names | **Accepted risk** (`Status:` line): the org's own infrastructure (D11, D17). Events are batched and minimal; `state` is a token, never free text; no agent output leaves the machine. Push payloads past the Worker stay end-to-end encrypted (T39). | 12, 08 |
| T60 | Shell WebView compromise: injected or remote script in the bundled shell UI drives native plugins | E, I | Vault contents, sessions, push keys | The shell loads only bundled assets under a strict CSP; plugin surface is narrow. JS never holds bearer credentials (D22): every Worker call, push registration included, goes through the native Session/org API client (15), so script that reaches the bridge cannot read a token. | 14, 15, 16 |
| T61 | iOS `machine-view` session cookie readable by page script (HttpOnly cannot be set through public API) | I | Machine Access JWT | Session cookie only, never persisted; per-org data store. The only page that can read it is the user's own yaran UI, which already has full API reach. **Residual risk**, stated in the row. | 15 |
| T62 | Native loopback proxy (only if G1 lands on rung 3) reachable by other apps or pages on the phone | S, E | Machine access via the managed OAuth bearer | Conditional row: 15 writes the mitigation if rung 3 is adopted; otherwise the ID is struck through as retired, per the maintenance rule. | 15 |
| T63 | Publisher-domain association files (`assetlinks.json`, `apple-app-site-association`) tampered, carrying a wrong fingerprint, or lost with the domain, so another app receives (or no app receives) the verified https callback | S, T, D | Sealed handoffs (ciphertext only), sign-in availability | Hosted by 21 on `<publisher-domain>` from files committed in the repo. The `assetlinks.json` fingerprint is the D14 app-signing certificate that 18 checks (`app-signing-cert.sha256`). Domain and DNS under maintainer custody with renewal monitored (22). The envelope stays sealed to the app's ephemeral key, so a hijacked callback yields ciphertext only (T36). | 21, 18, 14, 15 |
| T64 | Remembered-consent bypass (D24): the consent cookie is stolen, replayed or forged, the consent key leaks, the device key is extracted or made to sign by something other than the app, or remembered consent outlives the device's revocation, so a handoff the user did not start skips the consent page | S, E | Access JWTs for the control plane and machines (the T36 asset); the consent page as the human check | Skip only under 02 §8.1's rule, all of: cookie `__Secure-yaran-handoff-consent` well-formed, its `kv` current, its HMAC-SHA256 verified in constant time, its `iat` within 400 days; its `fp24` equal to the request `dk`'s `DeviceKeyFingerprint`; `dsig` a verifying ES256 signature over `yaran-handoff-device-v1\n<host>\n<pk>\n<state>\n<dts>\n`, with `host` the server's own and never a query value; `dts` within ±300 s; on the Worker, no revoked device row carries that fingerprint. The cookie is worthless without a fresh signature, and the signature without the cookie. A replay inside the window yields an envelope sealed to the original `pk`. Cookie: host-only, HttpOnly, Secure, SameSite=Lax, Path scoped to the handoff path, set only by an explicit Continue after a GET whose signature verified, never refreshed by a skip, never set on Cancel. Device key: P-256 in Android Keystore (StrongBox, else TEE) or the Secure Enclave, non-exportable and `ThisDeviceOnly`; one key per org registration, so two orgs cannot link a phone; discarded with the `InstallId`. Consent key: on the Worker, HKDF purpose `handoff_consent` from `DATA_KEY` (only the current version verifies); on yaran, `handoff_consent_key` in the owner-only credentials file (T5), minted on every claim. Invalidation: revoking a device (W14, W24) stops its Worker skips at once; rotating `DATA_KEY`, re-pairing or `yaran cloud logout` drops every memory on that side. **Residual risk:** code running as the app, or as root, on an unlocked phone can ask the keystore to sign, since signing needs no user presence, and, with the system browser's cookie, skip the page for a flow it started; that attacker already holds the app's live sessions (T37, T60). yaran never learns of a Worker device revocation, so a revoked phone keeps remembered consent on machines until re-pair, logout or the 400-day cap. A Y1 skip still needs a verified owner Access JWT, which `sign_out_everywhere` revokes (06), and without D24 the same holder could tap Continue anyway (accepted; 02 Risks). **Detection:** the Worker's `handoff.issued` audit records `details.consent: "remembered"` or `"explicit"`; yaran logs the same verdict for Y1 (11). | 02, 06, 11, 15 |

The same edit also does the following:

- Removes the counts at `threat-model.md:3-9` and `:1125-1131`, replacing them with wording
  that cannot go stale ("for every row"; "append the next free ID").
- Adds "Accepted risks" bullets for T43 and T59, and one for T64's revocation gap (yaran never learns of a Worker device revocation), at `SECURITY.md:89-124`.
- Extends the scope: the in-scope list (:15-27) gains `cloud/worker`, `cloud/push-relay`,
  `mobile/` and cloudflared supervision; out of scope (:28-29) gains the Cloudflare
  platform, Apple and Google push services, UnifiedPush distributors and the org's IdP.
- Adds a "Cloud Connect" paragraph to the trust model (:31-40). The workspace is still
  single-tenant. The org admin is trusted with the org's Cloudflare account. The publisher
  relay is trusted only for availability, never for content.

### CLAUDE.md edits

1. **Product identity (:3-9).**
   - Add the release trains `yaran-cloud-vX.Y.Z` (protocol, Worker, relay, and the generated
     `cloud-deploy` branch) and `yaran-mobile-vX.Y.Z` (apps), with compatibility by protocol
     negotiation (D15). State the rule that keeps the binary install working: new-train
     releases are created with `--latest=false`, `release.yml` skips non-`yaran-v` tags, and
     `install.sh` resolves only `yaran-v*` tags (Phase 18 owns all three edits).
   - Add the placeholders `<zone>`, `<org-control-plane>`, `<publisher-relay>` and
     `<publisher-domain>`. The publisher values come from build config and never appear in
     the repo (D16).
2. **Important Constraints.**
   - Single-tenant paragraph: add "or Cloudflare Access via Cloud Connect, which yaran also
     verifies on the cloud hostname".
   - Platform rule: "the `yaran` binary targets macOS and Linux only; the phone apps under
     `mobile/` target Android and iOS".
3. **Serving modes tenet.** Cloud Connect is a supervised outbound leg, not a fourth way to
   serve. It never binds a listener.
4. **New sections.** Add `### Cloud Connect` (D1–D8, D10–D12, D16–D21) and `### Mobile apps`
   (D8's callback and consent rules, D9, D13, D14, D22, D23, D24), as tenets in the house voice.
5. **Keeping Documentation In Sync.**
   - The Cloud Connect docs group.
   - Shell-UI scenes.
   - "a `[cloud]` key change updates `cloud-connect-machine.md`".
   - Every new attack surface edits its T-row.
6. **Verification.** Add the `cloud/` and `mobile/` commands defined by 04, 14 and 18, and
   `node tools/module-headers/bin/module-headers.mjs --check` and `--lines --check` (01;
   `make headers-check` locally).

### Shell-UI screenshots without new screenshot machinery

The bundled shell UI (`mobile/app`, Phase 14) is a React web app. Docs screenshots of it
are ordinary **browser scenes** at `viewport: "phone"`. The scene loads a static build made
with `VITE_YARAN_SCREENS=1`, which swaps in the web stubs of the first-party plugins with
fixture data drawn from `cloud/protocol/fixtures/`.

`run.js` gains one optional scene field, `origin: "mobile-shell"`. It serves
`mobile/app/dist-screens/` on an ephemeral loopback port instead of the preview container.
`docs-screenshots.test.ts` needs **no change**, because the shape (viewport plus shoot plus
an `expect*` guard) is unchanged.

Native-only surfaces (the SSO sheet, OS notifications) are described in words in the
docs. Store screenshots on real simulators belong to 21, using the driver 19 selects.

Web and TUI cloud surfaces are captured in preview-env with a **fixture-only** cloud
state, under the `screens` profile. It has three parts:

- a fake `cloudflared` script in `screens/fixtures/` that answers `/ready` with 200;
- seeded credentials written by `seed.js`;
- a stub org endpoint serving `/v1/meta` and `/v1/machine/*` from the shared fixtures.

No real Cloudflare is involved. If Phase 10's leg needs more than this to show "connected",
the stub grows to match, and the yaran code does not.

## Work items

1. **Threat-model draft (first PR, Wave B week 1).**
   - Touch `docs/operations/threat-model.md`: append T25–T64 with the four paragraphs each
     and the `Status:` lines (T43, T59), and fix the stale counts.
   - Touch `SECURITY.md`: STRIDE rows T25–T64, scope, trust model, accepted risks.
   - Reuse the existing section format (T24 at :1076-1114).
   - Tests: the validation one-liner below (IDs match between the files); markdown renders.
2. **Notify owning phases.**
   - Each Wave B phase's PR template checklist gains "edited my T-row (IDs: …)". Touch
     `.github/pull_request_template.md` if it exists, otherwise add the checklist to
     `CONTRIBUTING.md`.
   - Test: none (process).
3. **New docs pages.**
   - Create the seven pages in the group table, with frontmatter `group: "Cloud Connect"`
     and orders 70-76.
   - Reuse the admonition syntax and the tone of `tailscale.md`.
   - Tests: website `npm test` (docs-screenshots and admonitions), `npm run build`, and
     `npm run test:search`.
4. **Edits to pages that become false.** Make every row of the edits table above.
   - Tests: a `grep -n "no login"` sweep (validation) shows each remaining hit scoped
     correctly; the build passes.
5. **README and CONTRIBUTING.**
   - `README.md` edits as specified.
   - `CONTRIBUTING.md` gets a "Cloud and mobile subprojects" section: prerequisites (Node
     pin, JDK, Xcode), the test commands from 04, 14 and 18, the module-headers check (01),
     and the fork-PR secrets note.
   - Test: link check by build.
6. **CLAUDE.md** edits 1–6.
   - Test: review checklist; `grep` validation for the new trains and placeholders.
7. **NOTICE.**
   - Create a root `NOTICE`. It names cloudflared (Apache-2.0, © Cloudflare, Inc.;
     downloaded and run by yaran, not bundled) and its license URL.
   - It points at the generated mobile and cloud inventories produced by 18
     (`mobile/THIRD_PARTY_LICENSES.*` and `cloud/*/THIRD_PARTY_LICENSES.*`; names fixed
     by 18).
   - It is linked from `README.md`.
   - Test: a validation grep.
8. **Screenshots.**
   - Create scenes (`tools/preview-env/screens/scenes/*.js`, each with the 00-CONVENTIONS
     §2 header and added to the module-headers opt-in manifest):

     | Scene | Viewport | Shows | Feature phase | Docs page |
     |---|---|---|---|---|
     | `web-cloud-preferences` | desktop | Preferences cloud row | 10 | `cloud-connect-machine.md` |
     | `web-connect-phone` | desktop | QR dialog | 13 | `mobile-apps.md` |
     | `phone-sign-in-needed` | phone | Sign-in needed overlay | 13 | `cloud-troubleshooting.md` |
     | `tui-cloud-crumb` | TUI | Header crumb | 10 | `cloud-connect-machine.md` |
     | `app-onboarding` | phone, shell UI | Onboarding | 14 | `mobile-apps.md` |
     | `app-machines` | phone, shell UI | Machines list | 14 | `mobile-apps.md` |
     | `app-settings` | phone, shell UI | Settings | 14 | `mobile-apps.md` |

   - Touch `tools/preview-env/screens/run.js` (the `origin` field), `seed.js`, `compose.yml`
     (the `screens` profile stub service), `screens/fixtures/` (fake cloudflared and the
     stub), and `tools/preview-env/README.md`.
   - Reuse the `expectVisibleText`, `expectDialogOpen` and `expectPanePainted` guards
     (`screens/lib.js:652-898`) and `PHONE` (`lib.js:21`).
   - Tests: `docs-screenshots.test.ts` passes with the allowlist still empty; each scene's
     guard refuses a blank capture.
9. **Docs guard test.**
   - Create `website/src/lib/cloud-docs-domains.test.ts`, with a header and added to the
     manifest. It fails if any `website/docs/cloud*.md`, `mobile-apps.md` or
     `push-notifications.md` names a hostname outside an allowlist of real, verified
     origins. The allowlist holds `github.com/SiavZ/yaran`, `dash.cloudflare.com`,
     `developers.cloudflare.com`, `f-droid.org`, `unifiedpush.org`, `ntfy.sh`, the two store
     domains, and the placeholder forms (`<zone>`, `<org-control-plane>`, `<publisher-relay>`,
     `<publisher-domain>`; a `*.workers.dev` hostname only in its placeholder form). Each entry carries a comment saying why it is real.
   - Tests: the test itself, plus a fixture page that must fail.
10. **Marketing copy.**
    - Touch `ServerMode.astro` and `FeatureGrid.astro` as specified.
    - Tests: website build; `figure/figure.test.tsx` stays green.

## Acceptance

- [ ] `threat-model.md` has `## T25` through `## T64`, each with all four bold paragraphs. T43 and T59 carry a `Status:` line (T62 may instead be struck through as retired). No stale count remains.
- [ ] `SECURITY.md` has STRIDE rows T25–T64 whose IDs and titles match the threat-model headings one to one. The scope, trust model and accepted-risk sections mention Cloud Connect, the Worker, the relay and the apps.
- [ ] Every Wave B PR that adds a surface edited its T-row. Phase 20 confirms this.
- [ ] Seven new pages render in a "Cloud Connect" sidebar group between Web UI and Reference. Each Cloud Connect page carries the D17 WARNING.
- [ ] Every "no login" sentence in `website/docs`, `README.md` and `ServerMode.astro` is either scoped to its leg or paired with the Cloud Connect sentence. `public-hosting.md` points to Cloud Connect from its cloudflared warning.
- [ ] The `[cloud]` table in `cloud-connect-machine.md` lists exactly the keys and defaults of the canonical renderer.
- [ ] `CLAUDE.md` names the three trains (`yaran-vX.Y.Z`, `yaran-cloud-vX.Y.Z`, `yaran-mobile-vX.Y.Z`) with the `--latest=false` and `yaran-v` installer-filter rule, the four placeholders, the platform scope, and the Cloud Connect and Mobile tenet sections.
- [ ] `README.md` "Release binaries" and `rebranding.md` describe the trains and say `install.sh` installs the newest `yaran-v*` release.
- [ ] `mobile-apps.md` describes the confirmation page (asked on the first sign-in to each host, skipped on later renewals on that phone, the cases that bring it back, and the iOS system confirmation that still appears every time; D24), the verified hand-back link and the warning on builds without a publisher domain; `cloud-admin-setup.md` names the three deploy values, the `workers.dev` setup window and the `cloud-deploy` branch.
- [ ] Root `NOTICE` exists and is linked from the README.
- [ ] Seven new scenes and PNGs exist. Each is referenced by a docs page, and the unreferenced allowlist is still empty.
- [ ] `cloud-docs-domains.test.ts` passes on the real pages and fails on its bad fixture.
- [ ] No page documents a route, wire frame or engine internal (CLAUDE.md consumer-docs rule). Reviewer sign-off is recorded in the PR.

## Validation

```bash
cd /Users/siavash/Projects/yaran
# T-IDs agree between the long form and the STRIDE table
diff <(grep -oE '^## T[0-9]+' docs/operations/threat-model.md | grep -oE 'T[0-9]+') \
     <(grep -oE '^\| T[0-9]+ ' SECURITY.md | grep -oE 'T[0-9]+')
grep -nE 'T1–T2[0-9]' docs/operations/threat-model.md   # expect: no output
# every remaining "no login" is scoped; inspect each hit
grep -rn -i "no login\|no authentication" website/docs website/src/components README.md
# every key in the docs [cloud] table exists in the canonical renderer (expect: no output)
for k in $(grep -oE '^\| `[a-z_]+`' website/docs/cloud-connect-machine.md | tr -d '|` '); do
  grep -q "\b$k\b" crates/yaran-tui/src/config.rs || echo "documented but not rendered: $k"; done
grep -n 'yaran-cloud-v\|yaran-mobile-v\|latest=false\|<publisher-relay>\|<publisher-domain>' CLAUDE.md
grep -n 'yaran-cloud-v\|yaran-mobile-v' README.md docs/operations/rebranding.md
test -f NOTICE && grep -n cloudflared NOTICE
cd website && npm ci && npm test && npm run build && npm run test:search
cd ../tools/preview-env && ./screens/reshoot.sh --list | grep -E 'cloud|connect|sign-in|app-'
cd ../.. && node tools/module-headers/bin/module-headers.mjs --check tools/preview-env/screens/scenes website/src/lib/cloud-docs-domains.test.ts
```

## Risks

| Risk | Mitigation |
|---|---|
| Docs drift from the code: messages and keys change after the page lands | Pages quote messages and keys from merged code, and each PR cites its commit. The troubleshooting messages are pinned by the code phases' tests. 19 walks the docs. |
| Owning phases skip their T-row edit | PR checklist item (work item 2). 20 audits every row against the code. |
| The shell UI behaves differently under plugin stubs, so screenshots lie | Stubs are fixture-driven from `cloud/protocol/fixtures`, the same data the shell's unit tests use. 19 compares against device runs. |
| `up.sh` refuses a macOS host (`up.sh:72-73`) | Reshoots run on the Linux host, as they do today. The shell-UI scenes need no container. |
| The marketing copy oversells, implying "end-to-end encrypted" for terminal traffic | The D17 WARNING is mandatory, and the reviewer checks every security adjective against the trust table. |
| T-IDs collide with another in-flight plan (for example rustport) appending T25 | Land the first PR in week one. Any other plan rebases onto the next free ID, per the maintenance rule (:1125-1131). |

## References

- `research/R3-repo-process.md` §6, §7, §9, §Implications 7-8
- `research/R1-server-core-cli.md` §8, §Implications 12
- `research/R4-cloudflare.md` §Design constraints (Hard constraints 3, 6, 7, 13, 14)
- `research/R5-mobile.md` §3-§5
- CLAUDE.md: Product identity; Keeping Documentation In Sync; consumer-docs rule

## Reconciliation notes (2026-11-14) — threat table

- T25: added publish order and teardown order (D21), per-rule `originRequest.access` and cloudflared ≥ 2026.11.0 (G2), and the G2 reduced-defence residual (03 G2); owner 10 added.
- T28: named `PUT /v1/machine/origin` and `POST /v1/machine/unpair` (R8, R9); owner 05 added for the origin-port ingress update.
- T29: minimum cloudflared 2026.11.0 also checked for user-supplied binaries (R16).
- T31: replaced `workers_dev=false` with the D19 restricted workers.dev window (R5); `cloud-deploy` branch (R4); owner 05 added.
- T33: workers.dev window and `SETUP_CODE` as a deploy-time secret (R5, R6); owner 04 added.
- T34: covers per-device mute settings and `push_state` (R9); owner 08 added.
- T35: machine key fingerprint on the confirm page (R9, Phase 06).
- T36: rewritten for R2 (verified https callback, dev-build custom scheme with visible warning as residual risk, consent interstitial on both handoff pages), JWE ECDH-ES + A256GCM (R1), `cookie` fallback (R9); owner 14 added.
- T41: owner 07 added (generates and rotates the VAPID key).
- T42: QR payload built from the canonical host (Phase 06); owner 06 added.
- T45: 4401 close, `revoke_user`, per-device revocation residual (Phase 06, 11).
- T47: widened to all three deploy secrets (R6, D20); owner 04 added.
- T49: D1 write budget (Phase 04); owner 04 added.
- T52: Deploy button and updates use the `cloud-deploy` branch (R4, D18).
- New T54–T63 appended per R14 for surfaces the table lacked: control-plane identity (04/06/07), D1 exposure (04), cross-instance and orphan resources (05), push-endpoint SSRF (08), handoff rate-limit starvation (11), plaintext event metadata at the Worker, accepted (12), shell WebView and native-only credentials (14/R12), iOS cookie HttpOnly (15), conditional loopback proxy (15), publisher-domain association files (R2, 21).
- Range references in this file updated from T25–T53 to T25–T63; T59 joins T43 as an accepted risk.
- D24: T36's mitigation adds remembered consent per (host, device key) and its residual says a hostile flow still meets the page because it cannot produce this install's device signature (02 §8.1).
- D24: new T64 (remembered-consent bypass: cookie theft, replay or forgery, consent-key leak, device-key misuse, revocation gap) appended after T63; no ID renumbered. Owners 02, 06, 11, 15. Its revocation gap (yaran never learns of a Worker device revocation) is an accepted-risk bullet in `SECURITY.md`, as 02 Risks records.
- D24: range references in this file updated from T25–T63 to T25–T64 (Goal, In scope, the draft heading, work item 1, Acceptance). Other phase files that cite "T25–T63" as Phase 17's allocation are not edited here.

## Reconciliation notes (2026-11-14) — rest of the file

- Goal: `CLAUDE.md` keeps D1–D23 (was D1–D17); New sections item 4 lists D16–D23 in the right sections (R20).
- Evidence and edits table: `README.md:72-84` and `rebranding.md:37` rows document the trains, `--latest=false` and the `yaran-v` installer filter (R17); Acceptance and Validation check them.
- CLAUDE.md product identity names `yaran-cloud-vX.Y.Z` and `yaran-mobile-vX.Y.Z` plus the three Phase 18 release edits (R17).
- Placeholders: `<publisher-domain>` added to the honest-framing rule, CLAUDE.md, the guard-test allowlist and Validation (D8, R2).
- `mobile-apps.md`: confirmation page, verified hand-back link, iOS 17.4, dev-build warning (R2, R21); troubleshooting gains cancelled sign-in and no-return cases (R2, G13).
- `cloud-admin-setup.md`: Deploy button → `cloud-deploy` branch (R4); three deploy values (R6); `workers.dev` setup window and custom-domain switch (R5); removal order (R7).
- `cloud-connect-machine.md`: fingerprint comparison (R9) and what `logout` removes (R8). `push-notifications.md`: "push stopped" for `gone` devices (R11). `cloud-security-privacy.md`: D21 order and consent page (R7, R2).
- Troubleshooting: "Sign-in needed" replaced by the expired Access sign-in cover, since Phase 13 quotes no such string; the page still quotes merged code.
- Threat table consistency (IDs unchanged): T28 signature text follows 02's canonical string; T33 says `410 setup_closed` (canonical names); T45 teardown wording matches D21 and 05's invalidate step.
- Validation: the module-headers line is now the Phase 01 command with path arguments; CLAUDE.md Verification item names the same command (R20).
- D24: Goal keeps D1–D24 in `CLAUDE.md`; New sections item 4 adds D24 to `### Mobile apps`.
- D24: `mobile-apps.md` no longer says the confirmation page appears on every renewal: it is asked on the first sign-in to each host, skipped on later renewals on that phone, and comes back on removal or revocation, reinstall, re-pair, data-key rotation, cleared cookies or the 400-day cap; the iOS system confirmation still appears every time. `cloud-security-privacy.md` explains why and states the machine-side revocation gap; `cloud-admin-setup.md` says a data-key rotation brings the page back once on every phone (04's rotation note); troubleshooting adds "the confirmation page shows on every renewal". Acceptance updated to match.

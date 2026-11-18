# Phase 19 — Integration and end-to-end verification

**Track:** Wave C (sequential, first) · **Parallel-safe with:** nothing (Wave C runs alone, in order)
**Depends on:** all of Wave B (04–18) merged (including Phase 18's Play App Signing enrollment, D23), and every Phase 03 gate closed (PASS or FALLBACK ADOPTED) · **Blocks:** 20 (security review starts only from a build that has met this phase's exit criteria), and through it 21 and 22

## Goal

Prove the whole product works end to end on real Cloudflare and real devices, and keeps
working. That means every flow in `00-README.md` §End-to-end flows, every failure path in
"What done means" item 5, and every distribution flavor, exercised by automation that runs
nightly and on every release candidate. A physical-device pass and latency, soak and
failure-injection results back it up.

The output is three things:

- a repeatable harness;
- a scenario matrix with recorded results;
- an exit report committed under `docs/plans/phoneapp/evidence/phase19/`.

Phase 20 starts only after every exit criterion below is met.

## Evidence

- **Phase 03 hands over tooling and verdicts.**
  - Gate verdicts decide which path each scenario exercises. A FALLBACK ADOPTED path is tested
    exactly as the primary would have been.
  - `tools/cloud-gates/lib/` (Cloudflare API wrapper, JWT decode, redaction) is reused here
    rather than rewritten.
  - `tools/cloud-gates/run.sh --recheck` is the unattended drift check (03 §WI-7).
  - G11's plain-wrangler variant is the non-interactive org deploy this phase automates.
- **`tools/preview-env/` is the machine under test.**
  - It runs the host-built yaran binary read-only in an `archlinux` container (`Dockerfile:13-14`, `compose.yml:47`).
  - Config is isolated with `YARAN_HOME=/data/yaran` (`entrypoint.sh:7`). State lives in named volumes (`compose.yml:51-52`).
  - It serves loopback-only on `127.0.0.1:${YARAN_PORT:-8790}` (`compose.yml:25`) and starts yaran with `yaran server --bind 0.0.0.0:$PORT --no-tailscale` (`entrypoint.sh:80-87`).
  - Network egress is unrestricted: compose sets no network mode (`compose.yml`), so cloudflared can dial out.
  - **No hook exists for extra processes.** The entrypoint `exec`s yaran (`entrypoint.sh:87`).
  - **`up.sh` refuses to run on macOS** (`up.sh:72-76`). The README describes an in-container build for macOS ARM that is not implemented (`README.md:301-310`).
- **The fake provider makes scenarios deterministic.**
  - Fixtures include `steady`, `working`, `attention`, `attention-delayed`, `failure`, `burst` and `live` (`fake-agent.sh:6-96`).
  - `attention` emits `OSC 9;…BEL` (`fake-agent.sh:27-31`). yaran treats that as attention (`crates/yaran-core/src/attention.rs:16-27`), gated by `attention_on_bell`, which defaults to true (`config.rs:2313`).
  - `apply_attention_decision` is at `crates/yaran-core/src/engine/mod.rs:1302`. This is the D12 push hook.
  - Scenes switch fixtures over REST with `PUT /api/v1/global-env` (`screens/lib.js:46`). `armAttention` reconnects a session and polls `GET /api/v1/sessions` until `needs_attention` is set (`screens/lib.js:376-398`).
- **preview-env already has browser automation and phone emulation.**
  - It uses puppeteer-core with Chromium, found through `CHROME=`, then a Playwright cache, then the system browser (`screens/reshoot.sh:62-75`).
  - A `PHONE` 390×844 preset emulates touch over CDP (`screens/lib.js:21,132-139`).
  - A TUI driver exists (`tui-driver.js`, `tui-journey.example.js`).
- **yaran surfaces the scenarios touch** (routes at `crates/yaran-web/src/server.rs:776-814`):
  - `/ws/events`, `/ws/sessions/{id}/pty` (handler at `server.rs:1274`) and the tab and terminal variants;
  - `POST /api/v1/file-drop` (`file_drop_routes.rs:129-130`);
  - `GET /api/v1/build` with `{version, process}` (`build_routes.rs:34-42,61`), which drives the reload-on-new-run tenet;
  - `GET /api/v1/bootstrap` (`bootstrap_routes.rs:22`) and `/healthz` (`server.rs:813`).
- **Headless login needs a printed URL.** `browser::open_url` returns an error when no launcher works (`crates/yaran-core/src/browser.rs:5-40`). In a container, `yaran cloud login` must therefore print the authorize URL (requirement H1 below).
- **CI today has no browser, end-to-end or emulator tests.**
  - Web CI runs lint, build and vitest only (`pr.yml:185,212,215`).
  - Runners are ubuntu-latest/24.04 and macos-latest (`pr.yml:262`, `test.yml:93`).
  - setup-node is pinned to 22 or 24.
- **E2E tooling (researched 2026-11-14, sources in References):**

  | Tool | Fit for this app |
  |---|---|
  | Maestro CLI 2.12.1 (Apache-2.0) | Framework-agnostic. Handles multi-app journeys (Chrome, Safari). Reads WebView DOM on Android through `androidWebViewHierarchy: devtools` when debugging is enabled. **No physical iOS** (2.11/2.12 fail early). No notification-shade command (issue #2666). |
  | Appium 3.9.0 (uiautomator2 9.1.0, xcuitest 13.1.1) | Covers all four targets. Needs WebDriverAgent provisioning and a ChromeDriver matched to each WebView major version. |
  | Detox 20.51.4 | "Does not support non-React Native apps on Android." |
  | Native XCUITest | Can tap SpringBoard sheets and Notification Center, and runs on physical devices with normal signing. |
  | Espresso-Web 3.7.0 | Drives a WebView by id without the debugging flag, but in-process only. |

- **Platform facts.**
  - The iOS Simulator receives real sandbox APNs on iOS 16+, macOS 13+, Apple silicon/T2 (Xcode 14 release notes). Whether that works inside GitHub's virtualised macOS runners is UNVERIFIED.
  - `xcrun simctl push` injects local payloads (Xcode 11.4+).
  - android-emulator-runner 2.38.0 needs a KVM udev rule on ubuntu.
  - FCM needs a Google APIs emulator image.
  - k6 2.4.0 `k6/websockets` is current. `k6/experimental/websockets` is deprecated and `k6/ws` is legacy.
  - Toxiproxy 2.13.0 and ntfy 2.37.2.
  - GitHub-hosted jobs cost $0.006/min on Linux 2-core and $0.062/min on macOS.
  - `macos-26` carries Xcode 26.6 and iOS 26.x simulators.
- **Physical Android device.** The shared Pixel 8a on GrapheneOS is reachable through the repo user's phone-testing workflow, which gives each agent its own virtual display on the one phone. This plan treats it as an available test device and assumes nothing about that workflow's API beyond what it documents.

## In scope

- Staging environment as code: the maintainer's staging Cloudflare account, a test identity provider, a public UnifiedPush server, and the staging publisher relay.
- Automated Deploy-button-equivalent provisioning and teardown of a test org, plus one real Deploy-button run per release candidate.
- The E2E harness. It combines:
  - yaran (preview-env with a `cloud` profile, where yaran itself acquires and supervises cloudflared);
  - the real org Worker and relay;
  - Android emulators (`foss` and `play`) and the iOS simulator;
  - a desktop browser.
- The tooling choice and the suites: Maestro flows, an XCUITest target, and harness scripts.
- The full scenario matrix, failure injection, latency and soak, physical-device passes, the drift check, the CI workflow and the exit report.

## Out of scope

- **Phase 20:** security findings beyond what a scenario asserts. Scenarios S23–S24 assert the designed defences; the penetration test, MASVS audit and fuzzing belong to 20.
- **Phase 21:** production publisher relay, store accounts and the permanent review server.
- **Phase 18:** release pipelines themselves, including every store upload. 18 calls this phase's workflow as a required stage for release candidates.
  This phase uploads nothing to Google Play on any track (internal included): play-flavor
  builds reach emulators and devices by sideloading the RC artifacts 18 produced. No Play
  upload of any kind happens before Phase 18 has generated the Android app-signing key and
  enrolled it in Play App Signing (D23); 18's `release-mobile` upload step is the only one.
- **Phase 03:** proving platform facts. Phase 19 only re-checks them for drift.

## Design

### Tool choice

**Maestro is the cross-platform flow runner, with a thin native XCUITest target for what Maestro cannot do on iOS.**

Maestro runs every emulator and simulator flow and Android physical-device flows:
- one YAML vocabulary for both platforms;
- system-browser hops (Auth Tab, Custom Tab, Safari sheet) as multi-app journeys;
- no signing for simulators;
- open source CLI, so no Maestro Cloud.

XCUITest (`mobile/ios/E2EUITests`) covers three gaps:
- the ASWebAuthenticationSession consent sheet, which SpringBoard owns;
- notification taps in Notification Center;
- every physical-iPhone run, which Maestro refuses.

On Android, a notification tap is an `adb shell cmd statusbar expand-notifications` step followed by a Maestro `tapOn`. If that proves flaky over 20 nightlies, a single UiAutomator test replaces it.

The alternatives were rejected for these reasons:
- **Appium** covers physical iOS too, but costs WebDriverAgent provisioning and a ChromeDriver per WebView version, for no capability that XCUITest plus Maestro lacks.
- **Detox** cannot drive a non-React-Native Android app.
- **Espresso** cannot cross into the system browser.

**Assertions prefer server-side oracles over reading the screen.** The terminal is an xterm.js canvas inside machine-view, which has no bridge (D9). So each scenario asserts what the system actually did:
- the fake agent's input log in the container;
- `GET /api/v1/sessions` (`needs_attention`, liveness);
- the Worker admin API: machines, devices, audit log;
- Cloudflare list endpoints: tunnels, apps, DNS;
- the push server's delivery records.

UI assertions read the shell UI (Capacitor WebView, accessible) and the remote UI's chrome through the accessibility tree.

Reading terminal text needs WebView inspection. That is enabled **only** in dedicated test builds (requirement H4):
- **Android:** an `e2e` build type sets `BuildConfig.E2E_WEBVIEW_DEBUG`, which calls `WebView.setWebContentsDebuggingEnabled(true)`. Maestro then uses `androidWebViewHierarchy: devtools`.
- **iOS:** an `E2E` build configuration compiles `#if E2E webView.isInspectable = true`.

A release-artifact check (WI-5) fails if either flag is present in a `release`/`play`/`foss` artifact or an App Store archive.

### Topology of one run

```text
GitHub Actions run (concurrency group: e2e-staging; one Access org per account)
┌ provision (ubuntu) ───────────────────────────────────────────────────────────┐
│ deploy test org Worker + D1 (G11 plain-wrangler path) → drive /setup wizard   │
│ (puppeteer-core, Dex sign-in) → outputs: cp URL, run id                       │
└───────────────────────────────────────────────────────────────────────────────┘
        │
        ├─▶ machine (ubuntu, long-running): preview-env `cloud` profile, projects
        │     e2e-m1 and e2e-m2; `yaran cloud login` via driver sidecar; waits until
        │     every client job has completed (polls the run's jobs via GITHUB_TOKEN)
        ├─▶ android-foss (ubuntu + KVM, API 36 `default` image, ntfy distributor)
        ├─▶ android-play (ubuntu + KVM, API 36 `google_apis_playstore` image)
        ├─▶ ios (macos-26, iOS 26 simulator; XCUITest + Maestro)
        └─▶ web (ubuntu, puppeteer-core: admin/user console + yaran web UI in the cloud mode)
                                   │ all clients reach the machines only through Cloudflare
        ▼
teardown (always): admin revoke-all → verify zero Access apps/policies/tunnels/DNS
tagged e2e-<run> → delete Worker + D1 → publish evidence artifact
```

The machines run only in the Linux job's preview-env containers. The iOS job reaches them over Cloudflare exactly as a phone would. Nobody runs yaran directly on a host, which keeps the CLAUDE.md preview-env rule intact on CI and on maintainers' Macs.

### Staging environment (persistent, maintainer-owned)

| Component | What | Notes |
|---|---|---|
| Staging account | Workers Paid + Zero Trust (org created after 2026-10-05), zone `<staging-zone>` | Separate from the publisher production account (21). Token and account id live in GitHub environment `e2e-staging` with required reviewers on non-default branches (environment protection from 18) |
| Test IdP | Dex in a container behind its own tunnel at `idp.<staging-zone>`, registered as a generic OIDC IdP in the staging Access org | Static users: `e2e-owner`, `e2e-other`, `e2e-admin`, with passwords in environment secrets. This enables scripted SSO with no email PIN, in the system browser, as users would do it. The Dex image is pinned by digest. Which Dex version exactly, and the static-password connector config keys, are UNVERIFIED until implementation reads Dex's docs |
| UnifiedPush server | ntfy 2.37.x behind a tunnel at `ntfy-e2e.<staging-zone>`, anonymous write to `up*` only | Public, because the org Worker must reach it, and has no Access app. The foss emulator's ntfy distributor points at it |
| Staging callback host | `cb-e2e.<staging-zone>`, a small Worker reusing 03's `workers/callback-probe` that serves `assetlinks.json` and `apple-app-site-association` for the e2e builds' signing certificate and team, covering `/auth/callback` and `/oauth/callback` | E2E builds carry `https://cb-e2e.<staging-zone>/auth/callback` as their publisher callback (H6), and the test org's `APP_CALLBACK_URLS` and the machines' `[cloud] app_callback_urls` name it, so the release-build https path (D8, 02 §8) is what the suites exercise. Production `<publisher-domain>` hosting is Phase 21's |
| Staging relay | `cloud/push-relay` deployed to the staging account with a sandbox APNs key (and the FCM service account if G5 adopted the fallback) | Mobile E2E builds take the staging relay URL from build config (D16, 08) |
| Self-hosted macOS runner (nightly real-APNs leg) | A maintainer-owned Apple-silicon Mac registered as a runner labelled `apns-sim` | Runs only the S09 iOS real-APNs leg, because the hosted-runner support is UNVERIFIED. Without it, the leg runs in the release-candidate device pass |

`tools/e2e/staging/check.sh` verifies all of this before every run (zone, org, the IdP list contains Dex, ntfy reachable, relay `/healthz`, both association files served on the callback host) and fails fast with the missing piece named.

### Hooks this phase needs from Wave B

Each hook is checked at the start of this phase. A missing one is filed against its owning
phase and blocks exit; it is not worked around in test code.

| # | Requirement | Owner |
|---|---|---|
| H1 | `yaran cloud login` prints the authorize URL (and keeps waiting on the loopback callback or a pasted landing address) when `browser::open_url` fails, as it does headless; `--no-browser` does the same on purpose | 09 |
| H2 | The tunnel ingress targets the machine's `origin_port` (02: `ClaimRequest.origin_port`, signed `PUT /v1/machine/origin`), which 09 sends at pairing, 05 writes as `http://127.0.0.1:<origin_port>`, and 10 corrects before `StartLeg`. The e2e profile then binds yaran to the container's non-loopback address on port P and runs Toxiproxy on `127.0.0.1:P` forwarding to it, so cloudflared's origin hop passes through Toxiproxy with no product change (yaran's port still equals `origin_port`, so 10 never re-targets). Whether 10's pre-`StartLeg` check accepts a non-loopback bind is UNVERIFIED until 10 lands; if it insists on loopback, use the fallback. Fallback: `tc netem` on the container loopback with `cap_add: NET_ADMIN`, scoped to the e2e compose profile only | 02 (W32, `origin_port`), 05, 09, 10 |
| H3 | The Worker's Cloudflare API base URL is a Worker var (default `https://api.cloudflare.com/client/v4`) with an inline comment in the deploy tree's `wrangler.jsonc`, so the chaos proxy can be interposed in staging | 05 (client), 07 (deploy-tree var) |
| H4 | Android `e2e` build type and iOS `E2E` configuration enabling WebView inspection, absent from all release variants | 14 (build type and configuration), 15 (machine-view's inspection switch) |
| H5 | Admin settings for session duration (down to the floor 07 sets), machine cap and max Access apps (`Settings.session_duration`, `machine_cap_per_user`, `quota_limits.access_apps` as a soft cap below Cloudflare's 500), all writable through `PUT /v1/admin/settings` (02 W26). Reconciliation is forced with `POST /v1/admin/reconcile` (W28) rather than by shortening an interval: 05's cron cadences are Worker-internal knobs, not contract settings (02 §6) | 07 (settings), 05 (reconcile, quota guard) |
| H6 | Mobile build config for the relay URL, the publisher callback domain (the staging callback host in e2e builds) and control-plane test defaults | 14 (build-config keys in `mobile/publisher.properties` and `Config/Publisher.xcconfig`), read by 15 (callback) and 16 (relay) |
| H7 | Emitter coalescing and offline expiry configurable in `[cloud]`: `push_coalesce_seconds` and `push_offline_ttl_seconds` (the Worker's `MachineConfig.events {max_batch, min_interval_ms}` still bounds the send rate) | 12 |

### Scenario matrix

Platform codes:
- **W:** desktop browser (puppeteer).
- **AF:** Android `foss` emulator. **AP:** Android `play` emulator. **IS:** iOS simulator.
- **PG:** Pixel 8a GrapheneOS. **IP:** physical iPhone. **SA:** stock-Android device with Google Play.

Cadence codes:
- **N:** nightly and on every release candidate (RC).
- **R:** RC only.
- **M:** manual, recorded in the RC device pass.

`—` means the scenario does not apply to that platform.

| ID | Scenario (assertions) | W | AF | AP | IS | PG | IP | SA |
|---|---|---|---|---|---|---|---|---|
| S01 | **Org setup wizard.** The three Deploy-time secrets (`CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY`, D20) present; before close, `workers.dev` answers only `/setup*` and `/v1/meta`; setup-code gate (`setup_code_invalid`, `setup_locked`), token verified per permission (G9), custom domain attached and the `workers.dev` subdomain disabled by API, after which any non-custom-domain Host gets `421 misdirected_host` (G14, D19), control-plane app with exactly the `/v1/meta` and `/v1/machine/*` public overrides (G8), IdP detection and OTP offer (G10), VAPID generated, admin bootstrapped, setup closed for good (`/setup` → `410 setup_closed`), audit rows (`setup.completed`) | N | — | — | — | — | — | — |
| S02 | **Real Deploy button** on the staging account from the RC's generated, self-contained deploy tree (the `worker/` subdirectory that 18's `release-cloud` publishes from Phase 07's assembler to the `cloud-deploy-rc` branch for release candidates (18), the same shape `cloud-deploy` carries; never `cloud/worker` on `main`, which imports `cloud/protocol` as a workspace package, D18). The prompt asks for the three secrets. Recorded per G11 procedure | M | — | — | — | — | — | — |
| S03 | **Machine pairing** three ways: CLI, TUI palette (tui-driver) and web app menu. Covers the confirm page's `MachineKeyFingerprint` equal to the one the surface printed (02 §7.1), the loopback callback, claim (`POST /v1/machine/claim` with `origin_port`; response `tunnel.token`, `access.{team_domain,aud}`, `owner_email`), credentials file mode 0600, cloud leg up, `/ready`, live host rule set, keyed statuses on both surfaces, QR (`yaranapp://add-org?u=`) shown on all four surfaces, audit `pair.approved` and `machine.claimed` | N | — | — | — | — | — | — |
| S04 | **Pairing refusals.** Email not allowed by admin policy (`pairing_not_allowed`); per-user machine cap (`machine_cap_reached`); re-pair with the same machine name (idempotent provisioning, no orphans) | N | — | — | — | — | — | — |
| S05 | **Phone onboarding.** Deep link `yaranapp://add-org?u=` (the scanner-equivalent; a camera QR scan is done in M), typed URL, `/v1/meta` protocol check (`setup: closed`), system-browser SSO with Dex, the control-plane consent interstitial (W16) naming this device and the host on this first handoff (D24: the request carries `dk`, `dts`, `dsig` and no consent cookie exists yet), tapped Continue (W16b `POST /v1/handoff`), whose `303` sets `__Secure-yaran-handoff-consent` host-only with `Path=/v1/handoff; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax` and audits `handoff.issued` with `details.consent: "explicit"`, the registered `Device.device_key_fingerprint` equal to the app's `dk` fingerprint, sealed handoff returned on the verified https callback (the staging callback host), machine list with live `status`, push registration (`POST /v1/me/devices` with `install_id`) recorded in the Worker with `push_state: active` | — | N | N | N | M | M | M |
| S06 | **Open machine.** Handoff on the machine host (first open: `GET /__yaran/handoff` consent page, Continue → Y1b `POST /__yaran/handoff`, whose `303` sets the consent cookie with `Path=/__yaran/handoff` and the same attributes as S05, and yaran logs the verdict as explicit; D24), the payload's `jwt` injected as the cookie (or its `cookie` field under G1 L1, or the L2 credential), UI loads, events socket live, deep link `#/agent/<id>` | N | N | N | N | M | M | M |
| S07 | **Terminal I/O.** Compose bar send, terminal-key row (Esc, Tab, Ctrl chord), Direct mode, output visible. Oracle: input log in the container, plus text read through devtools or inspection in e2e builds | N | N | N | N | M | M | M |
| S08 | **File upload.** "Attach a file…" from the picker into an agent → file present in the worktree upload directory; into a terminal → shell cwd. Oracle: `docker compose exec … ls` | N | N | N | N | M | M | M |
| S09 | **Push on each channel.** Attention rising edge (fixture `attention`) → notification within budget → tap opens that machine at `#/agent/<id>` and tab; attention cleared is sent with `Urgency: very-low` and arrives as a background push (relay → APNs `apns-push-type: background`, priority 5) that removes the notification where the platform allows and never shows anything; mutes set through `PATCH /v1/me/devices/{id}` (`muted_machine_ids`, `mute_all`, `muted_until`) honoured; after a forced 404/410 the device reads `push_state: gone`, the app re-registers and pushes resume. Channels: UnifiedPush (AF, PG foss), embedded FCM or relay-FCM per G5 (AP, PG play, SA), APNs via relay (IS real APNs on `apns-sim` runner; hosted IS uses `simctl push` for the NSE decrypt and tap path) | — | N | N | N | M | M | M |
| S10 | **Expiry and renewal.** Session duration at the floor: renewal before `exp` across a 2 h run with no IdP sign-in prompt and **no consent page** (D24, remembered consent: the Worker audits `handoff.issued` with `details.consent: "remembered"` and yaran logs the remembered verdict for every renewal after the first; a skip does not re-set the cookie); on iOS the ASWebAuthenticationSession system sign-in confirmation still appears on every renewal, and XCUITest taps it (expected and counted, not a failure); per UNVERIFIED-5 the first nightly records per platform and browser whether the cookie survives between system-browser sessions, and a platform where it does not has its expectation changed to the consent page with maintainer sign-off in REPORT.md (02 Risks); at the JWT's `exp` yaran closes PTY and events sockets with close code `4401` reason `access session expired`; forced expiry by `revoke_tokens` → refusals carry `Yaran-Refusal: access-expired` (or Access's own unheadered 401/403) → "Sign-in needed" on W and in machine-view → reauth succeeds, W's re-sign-in tab landing on `/__yaran/signed-in`; G12-adopted margin respected | N | N | N | N | M | M | — |
| S11 | **Revoke device** from phone settings, user console and admin console (`DELETE /v1/me/devices/{id}`, `DELETE /v1/admin/devices/{id}`). Pushes stop, the subscription is cleared and the device no longer appears in either device list, the app's next call is refused with `403 device_revoked` and it wipes that org's data and shows the signed-out state, audit rows | N | N | N | N | M | M | — |
| S12 | **Revoke machine** via `yaran cloud logout` (`POST /v1/machine/unpair` → `202 TeardownStarted`, credentials deleted on 202 or 410), user console (`DELETE /v1/me/machines/{id}`) and admin (`DELETE /v1/admin/machines/{id}`). Machine `status` reads `tearing_down` then the machine is gone; ordered teardown (D21: DNS → connections → tunnel → Access app → policy) seen in audit `teardown.step` rows; machine stops its leg out loud on both surfaces (`410 machine_revoked` on its next signed call when revoked elsewhere), phones drop the machine, an open machine-view shows the gone state, zero orphans in list endpoints | N | N | — | N | M | — | — |
| S13 | **Admin revokes a user** (`PATCH /v1/admin/users/{id}` with `{disabled: true, revoke_all: true}`). All their machines and devices revoked; the Access session revoked (`revoke_user`); their next Worker call gets `403 user_disabled` | N | N | — | N | — | — | — |
| S14 | **Rotate tunnel token** via `yaran cloud rotate` (`POST /v1/machine/rotate`) and admin rotate (`{kill_connections}`). `tunnel.token_version` increments, new token delivered, cloudflared restarted by the supervisor, old token refused for new connectors, audit `machine.rotated` | N | — | — | — | — | — | — |
| S15 | **Machine offline.** Container stopped → offline within the reconciliation interval on W, AF, IS; open shows an offline error; restart → online | N | N | — | N | — | — | — |
| S16 | **cloudflared crash and restart.** `kill -9` → supervisor restart with backoff, phone machine-view reconnects. Binary hash mismatch → fail-closed error on both surfaces | N | N | — | N | — | — | — |
| S17 | **Worker update and D1 migration.** Deploy the previous `yaran-cloud-v*` tag, create users, machines and devices, deploy the candidate → data intact, sessions valid, update checker reports correctly | N | N | — | N | — | — | — |
| S18 | **Protocol skew both ways.** Machine N−1 and N+stub against Worker N; Worker N−1 against machine and app N; app N−1 against Worker N; a stub-meta Worker advertising ranges above and below → clear mismatch messages and no crash. Before the first release, N−1 is replaced by the stub | N | N | — | N | — | — | — |
| S19 | **Quota limits.** Per-user machine cap; soft Access-app cap lowered through H5 → refusal before Cloudflare's cap; Cloudflare API 429 and 5xx via the chaos proxy (H3) → saga retries, compensates, says so; Worker rate limiting on pairing endpoints | N | — | — | — | — | — | — |
| S20 | **Multiple orgs and machines in the app.** Two orgs (second test org on a second staging zone, or the same org with a second user), two machines, switching via "Switch machine…" | — | N | — | N | M | M | — |
| S21 | **PTY ownership across devices.** Desktop browser drives, phone sees the take-over card, phone takes over, desktop gets the card, nothing passively reclaims | N | N | — | N | M | M | — |
| S22 | **Server-run reload.** Restart yaran in the container → machine-view and browser reload on the new `process` | N | N | — | N | — | — | — |
| S23 | **Access misconfiguration defence (D3; T25, T26).** Drop `access.required` from the ingress and widen the policy to include `e2e-other` through the API → yaran rejects `e2e-other` on HTTP and WS with `403` and `Yaran-Refusal: access-not-owner`, and a request with no JWT with `401 access-missing`; restore and confirm | N | — | — | — | — | — | — |
| S24 | **Sealed-handoff misuse (D8; T36).** On the release-shaped https callback the G13 hijack app receives nothing; on a dev build's `yaranapp://auth/callback` it receives only ciphertext; a replayed `state`, consent `csrf` or sealed payload is refused; a redirect outside the allowlist (any other https URL, or the custom scheme without `build=dev`) is `400 handoff_request_invalid` and never redirected to; Cancel on the consent page returns `error=handoff_declined` and audits `handoff.declined` | — | N | — | — | M | — | — |
| S25 | **Sign out of org and remove device on the phone.** Tokens wiped from secure storage (e2e-build inspection), the device revoked (`DELETE /v1/me/devices/{id}`) and absent from the Worker's device lists | — | N | N | N | M | M | — |
| S26 | **Lifecycle.** Background and foreground, process death and restore of machine-view, rotation, iPad split view, keyboard over the compose bar | — | N | — | N | M | M | — |
| S27 | **Offline phone.** Airplane mode (Android `cmd connectivity airplane-mode enable`; iOS by Toxiproxy cut on the origin side) → offline states → recovery | — | N | — | N | M | M | — |
| S28 | **Accessibility smoke.** TalkBack and VoiceOver labels and focus order on shell screens and machine-view chrome; dynamic type at largest size | — | — | — | — | M | M | — |
| S29 | **Origin port change.** Restart a machine with a different `[server] port` → before `StartLeg` yaran calls `PUT /v1/machine/origin` → `202 OriginUpdateResult {changed: true}`, audit `machine.origin_changed`, ingress targets the new port and the UI loads through the tunnel; the same port again → `changed: false`; an out-of-range port from a harness-signed request → `400 origin_port_invalid` | N | — | — | — | — | — | — |
| S30 | **Remembered-consent negatives (D24; T36, T64).** With a valid consent cookie already in the browser for the host, each of these meets the consent page, and a Continue on it sets the cookie only where noted: (a) **foreign-app handoff**: the G13 hijack app (AF, PG) or a harness-started flow signed with a different device key (W, via `device-signer.mjs`) is never skipped, on W16 and on Y1; (b) **revoked device**: after W14 or W24 the same device key meets the page on W16 (skip rule 5), while a Y1 skip still succeeds until re-pair (the accepted gap, 02 Risks; asserted so a silent change is noticed), and the app itself, refused with `403 device_revoked`, discards its key, so re-adding the org mints a new one that meets the page everywhere; (c) **rotated yaran consent key**: after a re-pair (`yaran cloud login` again, `handoff_consent_key_version` incremented) the old cookie fails on Y1; `yaran cloud logout` then a fresh pair does the same; (d) **rotated `DATA_KEY`** (04's rotation procedure on the test org) makes every W16 cookie fail; (e) a tampered `mac`, an `fp24` for another key, an `iat` older than 400 days or more than 300 s ahead, and a stale `kv`, each alone, show the page and the cookie is neither cleared nor answered with an error; (f) a well-formed `dsig` that does not verify shows the page, and Continue sets **no** cookie; Cancel sets none; (g) malformed inputs answer `400 handoff_device_key_invalid` (bad or missing `dk`), `400 handoff_signature_malformed` (DER, 85 chars, `r = 0`) and `400 handoff_timestamp_skewed` with `server_time` (`dts` 301 s off), as the JSON envelope or the `error=` redirect; (h) a `build=dev` install keeps remembered consent for its own key. Oracles: the audit's `details.consent`, yaran's handoff log and the response headers; the W cells replay 02's `fixtures/handoff/remembered-consent.json` rows end to end | N | N | — | N | M | M | — |

Each scenario lives in one file. Maestro flows are `mobile/e2e/maestro/flows/sNN-*.yaml`;
harness scenarios are `tools/e2e/scenarios/sNN-*.sh`; XCUITest cases are
`mobile/ios/E2EUITests/SNN*.swift`. A scenario writes a JSON result (`{id, platform,
verdict, duration, oracle values, artifacts}`), which `tools/e2e/report/aggregate.mjs` folds
into the run report.

### Failure injection

| Fault | Mechanism | Scenarios |
|---|---|---|
| Origin leg latency, reset, timeout and bandwidth | Toxiproxy between cloudflared and yaran in the container (H2). Toxics `latency` (200/1000 ms), `reset_peer`, `timeout`, `bandwidth` (64 KB/s), `slow_close` | S07, S10, S16 |
| cloudflared death | `docker compose exec yaran pkill -KILL cloudflared`; a corrupted binary for the acquisition check | S16 |
| Machine gone | `docker compose stop` / `start` | S15 |
| Cloudflare API errors | A `cf-api-chaos` Worker in staging proxies to the real API and injects 429 (with `Retry-After`) or 5xx per rule; the test org's API base points at it (H3) | S19, S04 |
| Push provider errors | Delete the ntfy topic (→ 404/410 → subscription cleared, device marked `push_state: gone`, row kept, R11); relay returns 429 (staging relay rate limit lowered) | S09, S11 |
| Phone network | Android emulator `adb emu network delay gprs`, `adb emu network speed edge`, airplane mode; iOS through Toxiproxy (simulator has no shaping) | S07, S27 |
| Access session loss | `revoke_tokens`, `revoke_user`, and logout from the system browser | S10, S13 |
| Worker runtime restart | Redeploy the same version mid-session → clients reconnect | S17 |

How Cloudflare's edge passes a `reset_peer` on to the client WebSocket (close code, timing) is
UNVERIFIED. The first nightly records it, and only then do assertions on close codes go in.
Until then, scenarios assert recovery, not the code.

### Latency and soak

- **Keystroke-to-echo latency.** `tools/e2e/perf/pty-latency.k6.js` uses k6 2.4 `k6/websockets`. It opens `/ws/sessions/{id}/pty` on the machine host with the Access cookie, which `tools/e2e/lib/sso-login.mjs` obtains by Dex sign-in in puppeteer, and an `echo` fixture agent.
  - It sends input frames carrying unique markers and records the time until the marker returns in output, in a `Trend`.
  - The frame format is the PTY socket protocol implemented behind `ws_session_pty_upgrade` (`crates/yaran-web/src/server.rs:1274`). The implementer re-reads that handler and its client (`crates/yaran-web/web/src/lib/`) before writing the encoder; this plan does not restate it.
  - A baseline run against the same container over loopback isolates the tunnel's cost.
- **Initial budgets** (from a GitHub-hosted runner, same continent as its nearest colo): p95 ≤ 250 ms and p99 ≤ 500 ms tunnel echo; zero lost markers.
  - The first three nightly baselines may move a budget, with maintainer sign-off recorded in the report.
  - Raising a budget past 2× the loopback baseline plus 150 ms requires a Phase 10 or 11 investigation instead.
- **Push latency.** Measured from the attention rising edge (yaran log timestamp) to notification-shown (device log), for each channel. Budget: p95 ≤ 10 s; delivery ≥ 99% over ≥ 200 edges.
- **Soak, server side.** A weekly 5 h job (hosted jobs stop at 6 h) runs, against two machines:
  - an attention edge every 60 s;
  - a k6 PTY session at 2 keystrokes/s;
  - one events socket per simulated client (5);
  - session duration at the floor, so renewals happen;
  - a `cloudflared` kill each hour.

  Pass criteria:
  - yaran and cloudflared RSS growth < 10% from hour 1 to hour 5;
  - no unrecovered disconnect;
  - Worker error rate < 0.1% (from `wrangler tail` JSON);
  - zero orphans at teardown.

  A 24 h soak runs once per RC on the `apns-sim` runner or a maintainer Linux box with the same compose project.
- **Soak, phone side.** Each RC device pass leaves the app connected to a machine with machine-view open for 8 h, on PG and IP. It records:
  - renewals, and how many of them skipped the consent page (D24; expected: every one after the first per host);
  - reconnects;
  - battery drain (Android `dumpsys batterystats` and the iOS Battery settings screenshot);
  - push delivery for hourly attention edges.

### Physical-device pass (per release candidate)

Every RC build gets a scripted checklist, `tools/e2e/devices/checklist.md`, with one line per
M cell in the matrix. Results go in `evidence/phase19/<rc>/devices/`.

- **Where the builds come from.** Every Android build in this pass is sideloaded from 18's RC
  artifacts (or the e2e build type); nothing is uploaded to Google Play from this phase (D23,
  §Out of scope). iOS uses the E2E configuration through Xcode and 18's TestFlight build.
- **Pixel 8a on GrapheneOS (PG).** Reached through the repo user's phone-testing workflow,
  following that workflow's own rules for sharing the device. Install the `foss` APK
  (UnifiedPush with a distributor installed on the phone) and the `play` APK (sandboxed Google
  Play), one at a time; they share an applicationId (D14). Run the checklist with Vanadium as
  the default browser, then with Chrome if installed, because G13's Auth Tab table differs.
  Maestro over adb runs the AF/AP flows on this phone only when it can be reserved exclusively;
  otherwise the checklist is executed step by step through the workflow and screenshots are
  committed.
- **Physical iPhone (IP).** Maintainer device, the E2E configuration installed through Xcode
  for the XCUITest suite (`xcodebuild test -destination 'id=<udid>'`), then the TestFlight build
  for the manual checklist. Real APNs through the staging relay, the NSE decrypt, and lock-screen tap.
- **Stock Android with Google Play (SA).** Covers the play-flavor push and Chrome Auth Tab on
  an unmodified OS. Sourcing (a maintainer device or a borrowed one) is a maintainer decision
  recorded in the RC report. If none is available, the report says so and the exit criterion
  below is not met.
- **QR scan.** A real camera scan of the QR from each of the four surfaces (CLI, TUI, web UI,
  admin console) on PG and IP.

### Drift checks

The nightly job runs `tools/cloud-gates/run.sh --recheck` (03 §WI-7) and publishes its JSON.
A failing gate re-check opens an issue labelled `platform-drift`, naming the gate, and fails
the nightly. That gives Phase 22's operations a standing early warning when Cloudflare,
Chrome or OS behaviour shifts under a decided gate.

### CI workflow

`.github/workflows/e2e.yml` (≤500 lines; Phase 18 owns CI conventions: SHA-pinned actions,
no secrets on fork PRs, environment protection).

- **Triggers:**
  - `schedule` (nightly);
  - `workflow_dispatch`;
  - `workflow_call`, so 18's `release-cloud` and `release-mobile` workflows require it for RC tags;
  - `push` to `main` touching `cloud/**`, `mobile/**`, `crates/yaran-core/src/cloud/**`, `crates/yaran-web/src/cloud_*` or `tools/e2e/**`.
- **Not on pull requests from forks:** staging secrets are withheld (18 rule).
- **Concurrency:** `group: e2e-staging`, `cancel-in-progress: false`, because one Access org per account means runs serialise.
- **Jobs** as in §Topology. `teardown` has `if: always()`, and a separate scheduled `sweep` job deletes anything tagged `e2e-` older than 6 h.
- **Artifacts:** the run report, Maestro and XCUITest output (screenshots and videos for failures), redacted logs (`tools/cloud-gates/lib/redact.sh`), and k6 summaries.
- **Required check:** reported through Phase 01's always-reporting aggregator for RC tags only (not per-PR).
- **Cost envelope per nightly:** about 40 min macOS ≈ $2.50, plus about 4 × 40 min Linux ≈ $1. Recorded in the report so Phase 22 can budget it.

## Work items

1. **Staging environment as code.**
   - **Create:** `tools/e2e/README.md`, `tools/e2e/env.example`, `tools/e2e/staging/check.sh` (≤250), `tools/e2e/staging/bootstrap.sh` (≤300; idempotent: Dex tunnel + IdP registration, ntfy tunnel, relay deploy, GitHub environment checklist).
   - **Reuse:** `tools/cloud-gates/lib/{common,cf,redact,access}.sh` (03 §WI-1).
   - **Tests:** `tools/e2e/tests/check_test.sh` with canned API responses for each missing-piece message.
2. **Test identity provider.**
   - **Create:** `tools/e2e/idp/compose.yml`, `tools/e2e/idp/dex.config.tmpl.yaml`, `tools/e2e/idp/up.sh` (≤150), and `tools/e2e/lib/sso-login.mjs` (≤250). `sso-login.mjs` drives Dex sign-in in puppeteer-core and returns the `CF_Authorization` value for API and k6 use without ever printing it.
   - **Reuse:** preview-env's Chromium discovery (`screens/reshoot.sh:62-75`), the puppeteer-core dependency (`tools/preview-env/package.json`), and the CDP phone emulation (`screens/lib.js:132-139`) for the W cells of phone-shaped checks.
   - **Tests:** a `node --test` case against a local Dex instance.
3. **Test-org lifecycle.**
   - **Create:**
     - `tools/e2e/org/provision.sh` (≤300): G11 plain-wrangler path with a run-scoped Worker name and D1, deploying the candidate's assembled deploy tree (Phase 07's assembler run locally, the same tree `cloud-deploy` carries, D18) rather than the `main` workspace, with `APP_CALLBACK_URLS` naming the staging callback host;
     - `tools/e2e/org/setup-wizard.mjs` (≤400): puppeteer drives `/setup` on `workers.dev` through custom domain, IdP and admin steps;
     - `tools/e2e/org/teardown.sh` (≤300): admin revoke-all, then verify list endpoints show no `e2e-<run>` resources, then delete the Worker and D1, failing loudly on any orphan;
     - `tools/e2e/org/deploy-previous.sh` (≤150): deploys the previous `yaran-cloud-v*` release's `yaran-cloud-worker-vX.Y.Z.tar.gz` (the assembled tree 07 attaches to each release, checksum verified) for S17 and S18.
   - **Tests:** a dry-run mode of each script against canned responses in `tools/e2e/tests/`.
4. **Machine under test (preview-env `cloud` profile).**
   - **Create:**
     - `tools/preview-env/compose.cloud.yml` (≤120): the e2e profile's environment, seeding `[cloud]` config through the existing first-boot path in `entrypoint.sh:14-23`; a `driver` sidecar with Chromium and node in `network_mode: service:yaran`, so the loopback pairing callback is reachable; and a `toxiproxy` sidecar;
     - `tools/preview-env/cloud-login.mjs` (≤200): reads the printed authorize URL (H1) from yaran's output and completes Dex SSO and confirm in the sidecar.
   - **Touch:**
     - `tools/preview-env/up.sh`: add `--cloud` and `--project <name>` for two machines;
     - implement the documented macOS in-container build (`README.md:301-310`) as `--in-container-build`, so maintainers on macOS run the same harness locally; today `up.sh:72-76` refuses;
     - `tools/preview-env/fake-agent.sh`: add an `echo` fixture that echoes input and appends each received line to `/data/e2e/received.log`, and a `pty-latency` fixture that reflects markers immediately;
     - `tools/preview-env/README.md`: document the profile.
     These files are under 500 lines, so the changes land in place with their headers updated to the Phase 01 format.
   - **Reuse:** `armAttention` (`screens/lib.js:376-398`), `setFixture` (`screens/lib.js:46`), the readiness poll on `/api/v1/workspace` (`up.sh:155-166`).
   - **Tests:** `tools/preview-env/tests/cloud_profile_test.sh` brings the profile up with a stub control plane and asserts the driver sidecar reaches the container's loopback.
5. **Mobile suites and test builds.**
   - **Create:**
     - `mobile/e2e/maestro/config.yaml`;
     - `mobile/e2e/maestro/subflows/` (sign-in with Dex, add org, open machine, compose and send; each ≤150);
     - `mobile/e2e/maestro/flows/sNN-*.yaml` for every AF, AP and IS cell (each ≤200);
     - `mobile/e2e/android/notify.sh` (≤80);
     - `mobile/ios/E2EUITests/` with `AuthSheet.swift`, `Notifications.swift` and `SNN*.swift` (each ≤400);
     - `mobile/e2e/check-release-flags.sh` (≤150), which fails if `E2E_WEBVIEW_DEBUG` or `isInspectable` is set in release APKs, AABs or IPAs. It inspects the dex with `apkanalyzer` and greps the Mach-O for the configuration symbol.
   - **Consume:** the `e2e` build type and `E2E` configuration are hook H4, implemented by 14 and 15 in their own files; this phase checks them at its start and files any gap against those phases (§Hooks), rather than adding them in test code.
   - **Tests:** the flows are the tests. `check-release-flags.sh` has a fixture APK pair, with and without the flag.
6. **Scenario harness.**
   - **Create:** `tools/e2e/run.sh` (≤250; selects scenarios × platforms), `tools/e2e/scenarios/sNN-*.sh` for every W and harness-side oracle (each ≤400), `tools/e2e/lib/oracles.sh` (≤300: input log, sessions API, admin API, Cloudflare list endpoints, ntfy records), `tools/e2e/lib/device-signer.mjs` (≤200: a software P-256 device key that builds `dk`, `dts` and `dsig` over 02 §8.1's canonical string, so S30's W cells can drive W16 and Y1 as a second, foreign device and replay `fixtures/handoff/remembered-consent.json`; test-only, never a product path), and `tools/e2e/report/aggregate.mjs` (≤300).
   - **Tests:** `node --test` for the aggregator and for `device-signer.mjs` (signs 02's `fixtures/sig/handoff-device-signature.json` inputs to signatures the fixture's public key verifies), plus `tools/e2e/tests/oracles_test.sh`.
7. **Failure injection.**
   - **Create:** `tools/e2e/chaos/toxics.sh` (≤200), `tools/e2e/chaos/cf-api-chaos/` (a TypeScript Worker, `src/index.ts` ≤250; rules by request header and path, forwarding everything else unchanged), and `tools/e2e/chaos/device-net.sh` (≤150).
   - **Tests:** Vitest for the chaos Worker's rule matching and pass-through.
8. **Latency and soak.**
   - **Create:** `tools/e2e/perf/pty-latency.k6.js` (≤250), `tools/e2e/perf/push-latency.mjs` (≤200), `tools/e2e/perf/soak.sh` (≤300), and `tools/e2e/perf/thresholds.json` (budgets from §Latency and soak).
   - **Tests:** k6 `--dry-run` style validation in CI, plus a unit test of the marker encoder against a captured frame.
9. **Drift check and physical-device pass.**
   - **Create:** `tools/e2e/drift.sh` (≤120; wraps `tools/cloud-gates/run.sh --recheck` and opens the `platform-drift` issue through `gh`) and `tools/e2e/devices/checklist.md`.
   - **Reuse:** 03's gate scripts unchanged.
10. **CI workflow.**
    - **Create:** `.github/workflows/e2e.yml` as in §CI workflow.
    - **Touch:** Phase 18's release workflows add one `uses: ./.github/workflows/e2e.yml` stage (18 reserves the slot), and `.github/BRANCH_PROTECTION.md` notes the RC-only required check.
11. **Exit report.**
    - **Create:** `docs/plans/phoneapp/evidence/phase19/<rc>/REPORT.md`: the matrix with per-cell verdicts, budgets versus measurements, soak graphs (PNG from k6 and docker stats), device evidence, open defects with severity, the drift status, and the cost.
    - `check-evidence.sh` (03) covers this directory.

Every created code file carries the 00-CONVENTIONS §2 header with a generated module-headers
block and stays at or below 500 lines. `tools/e2e/**`, `mobile/e2e/**`, `mobile/ios/E2EUITests/**`
and the touched preview-env files join the Phase 01 manifest. Maestro YAML carries a `#`
header (title, purpose, subflows used). Whether Phase 01's tool parses `runFlow` references
into trees is Phase 01's decision; until it does, the header lists them by hand.

## Exit criteria (gate into Phase 20)

All of these are met on one release candidate. The REPORT.md is signed off by the maintainer.

1. All fourteen Phase 03 gates are closed, and the nightly drift check has been green for 7 consecutive days.
2. Every N cell in the matrix passes in **three consecutive** nightly runs on the RC commit's lineage, with no quarantined or skipped cell.
3. Every R and M cell passes in the RC device pass on PG, IP and SA, with evidence committed. An SA device must have been available.
4. **Flake rate:** each automated flow passes in ≥ 98% of the last 20 nightlies. Any flow below that is fixed (test or product), not retried into green.
5. **Latency:** PTY echo p95 ≤ 250 ms and p99 ≤ 500 ms (or the signed-off calibrated budget); zero lost markers. Push p95 ≤ 10 s with ≥ 99% delivery on every channel.
6. **Soak:** the 5 h weekly and 24 h RC soaks meet the server-side criteria, and the 8 h phone soak shows renewals without an IdP sign-in prompt and without the consent page after the first handoff per host (D24, remembered consent; on iOS the system's sign-in confirmation still appears on every renewal and is expected and counted, not a failure; a platform recorded under UNVERIFIED-5 as not keeping the cookie shows the page instead, with the sign-off S10 requires) and no unrecovered disconnects.
7. **Zero orphaned** Cloudflare resources after every teardown in the qualifying runs.
8. The release-flag check passes on every RC artifact: no WebView inspection in release builds.
9. No open defect of severity P0 or P1 from this phase. Each P2 has an owner phase and an issue.
10. REPORT.md is committed, with its cost envelope and with every UNVERIFIED item from this document either resolved (recorded observation) or carried to Phase 20 by name.

## Acceptance

- [ ] Staging environment check (`tools/e2e/staging/check.sh`) passes against the staging account.
- [ ] `provision → setup → teardown` runs unattended and leaves zero `e2e-` resources.
- [ ] The preview-env `cloud` profile brings up two paired machines on Linux, and on macOS through `--in-container-build`.
- [ ] Every matrix cell has an implemented flow, scenario script, XCUITest case, or checklist line.
- [ ] `e2e.yml` runs nightly and as a `workflow_call` stage in 18's release workflows.
- [ ] Failure-injection, latency and soak jobs run and publish results against `thresholds.json`.
- [ ] Hooks H1–H7 verified present (or filed and fixed in their owning phases).
- [ ] No build was uploaded to Google Play by this phase, and no Play upload of any kind preceded Phase 18's Play App Signing enrollment (D23).
- [ ] All exit criteria met and REPORT.md signed off.

## Validation

```bash
bash tools/e2e/staging/check.sh
bash tools/cloud-gates/run.sh --recheck
bash tools/e2e/org/provision.sh --run-id "local-$(date +%s)" && node tools/e2e/org/setup-wizard.mjs
(cd tools/preview-env && ./up.sh --cloud --project e2e-m1 && ./up.sh --cloud --project e2e-m2)   # add --in-container-build on macOS
bash tools/e2e/run.sh --platform W --all
maestro test --env-file tools/e2e/.env.local mobile/e2e/maestro/flows/            # emulator / simulator
xcodebuild test -project mobile/ios/App.xcodeproj -scheme E2EUITests -configuration E2E \
  -destination 'platform=iOS Simulator,name=iPhone 17'
k6 run tools/e2e/perf/pty-latency.k6.js
bash mobile/e2e/check-release-flags.sh mobile/android/app/build/outputs/apk/fossRelease/*.apk
node tools/e2e/report/aggregate.mjs --out docs/plans/phoneapp/evidence/phase19/local/REPORT.md
bash tools/e2e/org/teardown.sh --run-id "$RUN_ID"            # must report zero orphans
bash docs/plans/phoneapp/evidence/check-evidence.sh
gh workflow run e2e.yml && gh run watch
```

## Risks

| Risk | Mitigation |
|---|---|
| Real-Cloudflare E2E is slow and flaky, and flakes get retried into green | Server-side oracles over screen-reading; flake-rate exit criterion; no retries counted as passes; per-flow history in the aggregator |
| The one-Access-org-per-account limit serialises runs | `concurrency: e2e-staging`; a nightly fits in about 45 min; a second staging account can be added later as a second concurrency group with no code change |
| Real APNs to simulators is unsupported on hosted macOS runners (UNVERIFIED) | `simctl push` for the NSE path in hosted CI; real APNs on the `apns-sim` self-hosted runner and in the RC device pass |
| The `play` emulator's embedded FCM registration needs a signed-in Google account (UNVERIFIED) | Nightly records the result; if it needs an account, the AP S09 leg moves to SA and PG in the RC pass and the matrix cell is changed with sign-off |
| WebView inspection leaks into a release build and exposes terminal DOM over USB | Compile-time gating (H4) plus `check-release-flags.sh` on every RC artifact (exit criterion 8) |
| The shared physical Pixel is busy with other agents | The checklist is executable step by step through the phone-testing workflow; exclusive reservation only for Maestro-over-adb runs |
| Staging secrets exposed to forks | Environment protection and no fork triggers (18 rules); evidence redaction and `check-evidence.sh` |
| Teardown failure leaves resources that hit caps or cost money | `teardown` with `if: always()`, the 6 h `sweep` job, and orphan checks as an exit criterion |
| Dex version or config differs from this plan's assumption | Pinned by digest; WI-2 reads Dex's docs at implementation and the UNVERIFIED note is resolved in REPORT.md |
| Budgets chosen before measurement are wrong | Three-baseline calibration with sign-off; a hard ceiling (2× loopback + 150 ms) triggers investigation, not acceptance |
| The consent cookie does not survive between system-browser sessions on some platform or browser (02 UNVERIFIED-5), so remembered consent never skips there | S10 records the observation per platform and browser on the first nightly; where the cookie does not persist, that cell expects the consent page with maintainer sign-off and REPORT.md names the platform for 17's troubleshooting page; no protocol change (02 Risks) |

## References

- `00-README.md` §What "done" means, D1–D24, flows 1–6; `00-CONVENTIONS.md` §2, §3
- `03-platform-verification-gates.md`: gate verdicts, `tools/cloud-gates/`, `run.sh --recheck`, G11 plain-wrangler path, G13 hijack app and `workers/callback-probe`
- `02-protocol-contract.md`: §5 endpoint inventory (W8, W14, W16/W16b, W26, W28, W31, W32, Y1/Y1b, Y2), §4 error registry, §8 redirect allowlist and consent interstitial, §9 push urgency, §13 `Yaran-Refusal` codes and close code 4401
- `17-docs-website-threat-model.md`: T25, T26, T36 (asserted by S23 and S24), T64 (asserted by S30; T36 also by S30)
- `02-protocol-contract.md` §8.1 (device key, `dk`/`dts`/`dsig`, consent cookie, skip rule) and fixtures `sig/device-fingerprint.json`, `sig/handoff-device-signature.json`, `handoff/consent-cookie.json`, `handoff/remembered-consent.json`; 02 Risks UNVERIFIED-5
- Repo (read 2026-11-14):
  - `tools/preview-env/`: `Dockerfile:13-14`, `compose.yml:25,47,51-52`, `entrypoint.sh:7,14-23,80-87`, `up.sh:72-76,155-166`, `README.md:301-310`, `fake-agent.sh:6-96`, `screens/lib.js:21,46,132-139,376-398`, `screens/reshoot.sh:62-75`
  - `crates/yaran-web/src/server.rs:776-814,1274`; `crates/yaran-web/src/file_drop_routes.rs:129-130`; `crates/yaran-web/src/build_routes.rs:34-42,61`; `crates/yaran-web/src/bootstrap_routes.rs:22`
  - `crates/yaran-core/src/attention.rs:16-27`; `crates/yaran-core/src/engine/mod.rs:1302`; `crates/yaran-core/src/config.rs:2242,2313`; `crates/yaran-core/src/browser.rs:5-40`
  - `.github/workflows/pr.yml:185,212,215,262`; `.github/workflows/test.yml:93`
- Tooling (read 2026-11-14):
  - Maestro docs https://docs.maestro.dev/ and changelog https://github.com/mobile-dev-inc/maestro/blob/main/CHANGELOG.md; issues #2666, #686
  - Maestro WebView devtools example https://github.com/mobile-dev-inc/maestro/blob/main/e2e/demo_app/.maestro/webView_chromeDevTools.yaml
  - Appium hybrid guides https://github.com/appium/appium-uiautomator2-driver/blob/master/docs/guides/hybrid.md and https://appium.github.io/appium-xcuitest-driver/latest/guides/hybrid/
  - Detox environment https://wix.github.io/Detox/docs/introduction/environment-setup
  - Espresso-Web https://developer.android.com/training/testing/espresso/web
  - WebView debugging https://developer.chrome.com/docs/devtools/remote-debugging/webviews ; WKWebView inspectable https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/
  - android-emulator-runner https://github.com/ReactiveCircus/android-emulator-runner ; emulator console https://developer.android.com/studio/run/emulator-console
  - runner images https://github.com/actions/runner-images ; pricing https://docs.github.com/en/billing/reference/actions-runner-pricing
  - Xcode 14 release notes (simulator remote notifications) https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes ; Xcode 11.4 (`simctl push`)
  - ntfy config https://docs.ntfy.sh/config/ ; Toxiproxy https://github.com/Shopify/toxiproxy ; k6 websockets https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/
  - FCM Android client (emulator requirement) https://firebase.google.com/docs/cloud-messaging/android/client
  - Auth Tab https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab

## Reconciliation notes (2026-11-14)

- Depends line, Out of scope (Phase 18), the physical-device pass and Acceptance: this phase uploads nothing to Google Play; play builds are sideloaded; no Play upload precedes Phase 18's Play App Signing enrollment (R13, D23).
- Hooks table owners corrected (R15): H2 now rests on 02's `origin_port` and `PUT /v1/machine/origin` (02/05/09/10) with a Toxiproxy topology needing no product change; H3 adds 07 for the deploy-tree var; H4 splits 14 (build type) and 15 (inspection switch); H5 uses `PUT /v1/admin/settings` and `POST /v1/admin/reconcile` instead of an admin-writable reconciliation interval, which 02 §6 keeps internal; H6 names 14's build-config files and adds the callback domain; H7 names 12's `push_coalesce_seconds` and `push_offline_ttl_seconds`.
- WI-5 no longer adds H4 in 14/15's files; it consumes the hook (the hooks rule forbids working around a missing hook in test code).
- New staging component: `cb-e2e.<staging-zone>` callback host serving association files, so suites exercise the release https callback (R2, 02 §8).
- Scenarios now use 02's canonical names: consent interstitial W16/W16b and Y1/Y1b (S05, S06, S24), `POST /v1/machine/unpair` + `202 TeardownStarted` + `tearing_down` (S12), `4401` and `Yaran-Refusal` (S10, S23), revoked devices absent from lists + `403 device_revoked` (S11, S25), `push_state: gone` with the row kept (S09, failure injection; R11), cleared events at `Urgency: very-low` as background pushes (S09), mutes via `PATCH /v1/me/devices/{id}` (S09), error codes in S01, S04, S13, S14.
- New S29 covers `PUT /v1/machine/origin` (R9).
- S01/S02: three Deploy secrets (R6, D20), workers.dev host lock and `421 misdirected_host` (R5, D19); S02 and WI-3 deploy the generated `cloud-deploy`-shaped tree, never `cloud/worker` on `main` (R4, D18).
- S10 and exit criterion 6: renewal is one consent tap per handoff with no IdP prompt, replacing "silent renewal" (R2); assertion strength unchanged.
- S23/S24 cite T25, T26, T36; References name D1–D23, 02 sections and 17's IDs (R14, R20).
- S02 (final pass): RC deploy trees come from 18's `cloud-deploy-rc` branch.
- D24: S10 and exit criterion 6 no longer expect one consent tap per renewal: renewals after the first handoff per host skip the consent page (audit `details.consent: "remembered"`), and on iOS the system's own sign-in confirmation still appears on every renewal. UNVERIFIED-5 (cookie persistence) is recorded by S10's first nightly, with a new Risks row; assertion strength unchanged.
- D24: S05 and S06 assert the first consent: the page appears, Continue sets `__Secure-yaran-handoff-consent` with 02 §8.1's attributes on each handoff path, audit `consent: "explicit"`.
- D24: new S30 (T36, T64): foreign-app handoff, revoked device (Worker meets the page; Y1 keeps skipping, the accepted gap), rotated yaran consent key (re-pair), rotated `DATA_KEY`, each cookie check failing alone, non-verifying signature sets no cookie, the three malformed-input codes, and `build=dev`. WI-6 adds the test-only `device-signer.mjs`; the phone soak counts skipped renewals; References add D1–D24, T64, 02 §8.1 and its four fixtures.

# Phase 03 gate tracking

The Tracking table from `03-platform-verification-gates.md`, kept here while the plan file is
not tracked on `main`. Status changes in the PR that closes a gate. Phase 19 cannot start
until every row reads PASS or FALLBACK ADOPTED.

| Gate | Question (short) | Affects | Primary | Fallback (level) | Decision owner | Target wk | Status | Evidence |
|---|---|---|---|---|---|---|---|---|
| G1 | Injected cookie accepted (HTTP + WS), both WebViews | 15, 11, 06, 05, 13 | L0 seal header JWT → cookie | L1 seal cookie value; L2 Managed OAuth + loopback proxy **[changes D8]** | Phase 15 lead | 2 | OPEN | [`G01-cookie-injection/`](G01-cookie-injection/RESULT.md) |
| G2 | Host preserved, HTTP/1.1, per-rule access enforces | 05, 10, 11 | per-rule access, no httpHostHeader, cloudflared ≥ 2026.11.0 | explicit httpHostHeader + XFH rule; yaran JWT check sole origin gate | Phase 05 lead | 1 | OPEN | [`G02-cloudflared-origin/`](G02-cloudflared-origin/RESULT.md) |
| G3 | Unauth/expired responses by kind and org age | 13, 15, 04 | classifier from matrix | table-driven union of observed rows | Phase 13 lead | 2 | OPEN | [`G03-access-responses/`](G03-access-responses/RESULT.md) |
| G4 | Worker → APNs HTTP/2 | 08, 21 | relay Worker `fetch` | APNs sender container (L1), same image on VM (L2) | Phase 08 lead | 2 | OPEN | [`G04-apns/`](G04-apns/RESULT.md) |
| G5 | Embedded FCM + direct VAPID, no publisher creds | 16, 08, 18 | embedded distributor | relay FCM HTTP v1 (kept built either way) | Phase 16 lead | 3 | OPEN | [`G05-embedded-fcm/`](G05-embedded-fcm/RESULT.md) |
| G6 | Second in-process WebView: cookies, files, IME, keyboard | 14, 15 | plain in-process WebView, platform defaults | per-item native insets/keyboard/file chooser | Phase 15 lead | 3 | OPEN | [`G06-machine-view/`](G06-machine-view/RESULT.md) |
| G7 | Reproducible `fdroid build` | 18, 21, 14 | variant A, developer-signed | L1 committed bundle tag; L2 F-Droid-signed **[changes D14]** | Phase 18 lead | 3 | OPEN | [`G07-fdroid/`](G07-fdroid/RESULT.md) |
| G8 | Public path overrides + precedence | 04, 07, 06, 05 | `destinations[].overrides` | path apps + Bypass policy | Phase 07 lead | 1 | OPEN | [`G08-public-paths/`](G08-public-paths/RESULT.md) |
| G9 | Token template URL + resolved IDs | 07, 17 | account-owned template URL | guided manual token, same probe verification | Phase 07 lead | 1 | OPEN | [`G09-token-template/`](G09-token-template/RESULT.md) |
| G10 | IdP detection + OTP via API, fresh org | 07 | API-created OTP | dashboard deep link + poll; no-org stop | Phase 07 lead | 1 | OPEN | [`G10-idp/`](G10-idp/RESULT.md) |
| G11 | Deploy button from the generated `cloud-deploy` branch subdir + D1 migrations + three secrets | 07, 04, 02, 18 | button at `/tree/cloud-deploy/worker` + deploy-script migrations | L1 runtime migrator; L2 template + CLI script (07's `cloud-deploy-root` tried first) | Phase 07 lead | 1 | OPEN | [`G11-deploy-button/`](G11-deploy-button/RESULT.md) |
| G12 | session_duration vs exp; open WS after exp | 15, 11, 07, 13 | renew at exp − margin; yaran closes at exp | larger margin, in-place cookie swap, 15 min floor | Phase 15 lead | 2 | OPEN | [`G12-session-expiry/`](G12-session-expiry/RESULT.md) |
| G13 | Verified https callback (iOS `.https`, App Link + Auth Tab); dev custom scheme | 15, 14, 21, 06, 11, 17 | iOS `.https` 17.4+; Auth Tab https / Custom Tab via verified App Link | Custom Tab + App Link; ACTION_VIEW; unverified link → system settings; iOS failure **[changes D8]** | Phase 15 lead | 3 | OPEN | [`G13-system-browser-auth/`](G13-system-browser-auth/RESULT.md) |
| G14 | Custom domain attach via API + permission; workers.dev host lock | 07, 04, 18, 17 | `workers_dev: true` + `preview_urls: false`, wizard API attach from workers.dev, then disable workers.dev; `421` for any other Host after setup | dashboard steps + poll | Phase 07 lead | 1 | OPEN | [`G14-custom-domain/`](G14-custom-domain/RESULT.md) |

## What each gate is waiting for

Machinery for every gate is committed in `tools/cloud-gates/`; no gate has been run. Each
RESULT.md lists the full prerequisites.

| Gate | Ready to run | Waiting on |
|---|---|---|
| G1 | script, echo origin, spike MachineViewSpike (Android builds) | account A, test identity, devices, Xcode for iOS; yaran half needs Phase 11's live host rule (or preview-env `allowed_hosts`) |
| G2 | script, fully automated, in `--recheck` | account A, cloudflared ≥ 2026.11.0, a wrong-aud and an expired JWT |
| G3 | script (`--target A`, `--target B`), in `--recheck` | account A, optional account B, JWTs, devices for the WebView half |
| G4 | script, apns-probe Worker | Apple developer account (.p8), Workers Paid, Xcode + simulator + iPhone |
| G5 | script, spike play flavor (builds) | Play emulator, GrapheneOS Pixel with sandboxed Play, a no-Play device |
| G6 | script, `/g6` page, spike fallbacks | account A, the Android and iOS device set, Xcode |
| G7 | script, spike foss flavor (builds) | Docker, a keystore, a pushed commit, an fdroiddata checkout, Binaries hosting; variant B tree from Phase 18 |
| G8 | script, public-path-probe Worker, in `--recheck` | account A (after G14) |
| G9 | script, in `--recheck` (ID resolution) | account A admin token, dashboard access |
| G10 | script | account A, scratch account C, a non-member mailbox |
| G11 | script, isolated deploy-probe | account A with Workers Builds, push rights for the gate branches |
| G12 | script, in `--recheck` (with `GATE_IDENTITY_JWT_CMD`) | account A, test identity, devices for the yaran-socket half |
| G13 | script, callback-probe Worker, spike AuthSpike + hijack module | account A, Apple team/bundle with Associated Domains, the Android and iOS device set, Xcode |
| G14 | script, domain-probe Worker, in `--recheck` (step 6) | account A, tokens A and B from the printed template links |

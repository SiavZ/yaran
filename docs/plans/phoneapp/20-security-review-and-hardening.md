# Phase 20 — Security review, penetration test, MASVS audit, hardening

**Track:** C (sequential) · **Parallel-safe with:** nothing (Wave C runs alone)
**Depends on:** 19 (the full product runs end to end on staging) · **Blocks:** 21, 22

## Goal

Before anything is offered to the public, prove that the shipped system matches its threat
model. That proof covers four parts:

- a code walkthrough of every threat;
- an independent, black-box confirmation of the authorization model;
- an external penetration test;
- an OWASP MASVS audit of both apps.

The phase also adds the checks the repo does not have yet (fuzzing, secret scanning, and
dependency audits beyond cargo), writes the data inventory and the key-compromise
playbooks, and **fixes every finding** before Phase 21 starts. Nothing found here is
deferred. A finding that conflicts with a D-decision goes to the owner as a change to
`00-README.md`. It is never quietly accepted.

## Evidence

**Repo facts** (verified 2026-11-14)

- The threat model ends at T24 (`docs/operations/threat-model.md:1076`). Phase 17 appends
  T25–T64 as design-stage drafts, each naming its owning phase (see
  `17-docs-website-threat-model.md` §Threat model).
- Security CI that exists today:
  - `cargo audit --deny warnings` and `cargo deny --all-features check` (`pr.yml:315-332`, `test.yml:139-155`);
  - SBOM and provenance on binary releases (`release.yml:145-183`, `:256-257`).
- Security CI that does **not** exist: gitleaks, trufflehog, any secret scanning job,
  cargo-fuzz or any `fuzz/` directory, CodeQL, semgrep, osv-scanner, `npm audit`, zizmor,
  OpenSSF Scorecard.
- Overdue `deny.toml` advisory ignores: RUSTSEC-2025-0141 (:30) and RUSTSEC-2024-0384 (:36)
  both say "Next review: 2026-08-01" (:29, :35). That date has passed.
- `SECURITY.md:164-168` describes `scripts/validate-threat-model.sh` as planned. It does not
  exist.
- No privacy policy or data inventory exists anywhere in the repo.
- `docs/audits/` holds earlier audit rounds (`audit01`–`audit03` plus dated reports). This
  phase's evidence goes there as `audit04-cloud-connect/`.

**OWASP MASVS** (fetched 2026-11-14)

- The current release is MASVS **v2.1.0** (2024-01-18, GitHub `OWASP/masvs` latest release).
- Controls, from https://github.com/OWASP/masvs/tree/master/controls:
  - STORAGE-1..2
  - CRYPTO-1..2
  - AUTH-1..3
  - NETWORK-1..2
  - PLATFORM-1..3
  - CODE-1..4
  - RESILIENCE-1..4
  - PRIVACY-1..4
- Profiles, from https://mas.owasp.org/Profiles/ (source in `OWASP/mas-website`): L1
  ("Other applications … are adversaries"), L2 ("The operating system cannot be trusted,
  and attackers may have physical access"), R ("The user of the device is an attacker"),
  and P (privacy). "MAS-R is meant to augment and not replace MAS-L1 and MAS-L2."
- Profiles attach to **MASWE** weaknesses (MASWE-0001…0078). Atomic MASTG tests reference
  MASWE IDs, so a test maps to a profile **through its MASWE entry**.

**Research**

- R5 §5 chooses the **L2 + P profile, without R**: anti-tamper does not fit a single-tenant
  tool whose user owns the server.
- R5 §5 also lists the baseline checklist: no certificate pinning (Cloudflare rotates edge
  certificates), backups off, `FLAG_SECURE` as a setting, and exact-host WebView allowlist.

**MASVS-NETWORK-2 versus Cloudflare.** NETWORK-2 is "performs identity pinning for all
remote endpoints under the developer's control". Cloudflare does not support pinning its
edge certificates (R5 §5.6, https://developers.cloudflare.com/ssl/reference/certificate-pinning/).
The audit records NETWORK-2 as **not applicable, with rationale**: the endpoints are the
org's own Cloudflare hostnames, not under the publisher's control, and pinning them is
unsupported. The control is satisfied instead by Certificate Transparency, which Android
enforces by default from Android 17 (R5 §5.6), and by hostnames that are exact and paired.
This is a documented design position, not a waiver.

## In scope

- A walkthrough of every threat from T25 to T64 against the code.
- Authz matrix verification on staging.
- An external penetration test, plus remediation and retest.
- A MASVS L2+P audit of Android (`foss` and `play`) and iOS.
- Abuse testing of the Worker and the relay.
- Fuzzing in Rust and TS.
- Secret scanning of history and artifacts.
- Dependency and license audits for cargo, npm, Gradle and SwiftPM.
- A privacy review and the data inventory.
- Key-compromise playbooks with rehearsals.
- Fixing every finding.
- Updating `threat-model.md` and `SECURITY.md` to the verified state.

## Out of scope

| Item | Owner |
|---|---|
| The privacy policy text, store privacy forms and listings (they consume this phase's data inventory) | 21 |
| Operational runbooks for outages and protocol deprecation (they link these playbooks) | 22 |
| New features | none. A finding is fixed in the code of the phase that owns that code, under this phase's tracking issue |

## Design

### Review structure

All evidence lands in `docs/audits/audit04-cloud-connect/`. The files are:

| File | Content |
|---|---|
| `00-summary.md` | Scope, commit SHAs per train, staging org, dates, and the sign-off table |
| `01-threat-walkthrough.md` | One row per threat: claimed mitigation, `file:symbol` evidence, test that proves it, verdict |
| `02-authz-matrix.md` | Generated matrix plus the run log |
| `03-pentest/` | Scope letter, rules of engagement, vendor report (as received), remediation map, retest letter |
| `04-masvs-android.md` and `05-masvs-ios.md` | One row per MASVS control and per in-profile MASWE: evidence, tool output reference, verdict |
| `06-abuse-tests.md` | Abuse tests |
| `07-fuzzing.md` | Fuzzing |
| `08-secrets-and-deps.md` | Secret scans and dependency audits |
| `09-findings.md` | Every finding with ID `CC-NNN`, severity (CVSS 4.0 base), owner phase, fix PR, verification |

The severity policy is that **every finding is fixed before 21**. Info-level observations
with no security impact are recorded as such. A finding may close as "accepted" only if it
is already an accepted risk in the threat model (T43, D17), or if the owner has amended a
D-decision.

### Fuzzing choice

**Rust.** `cargo-fuzz` (libFuzzer) in a `fuzz/` crate outside the workspace, under
`crates/yaran-core/fuzz/` and `crates/yaran-web/fuzz/`. It needs nightly, so it runs in a
scheduled workflow, not in a PR gate. Targets:

- Access JWT parsing and verification (11);
- the sealed handoff envelope codec (JWE ECDH-ES with Concat KDF, A256GCM; D8), both seal
  and the parser of its own output (02, 11);
- signed-request canonicalization (09);
- Host/Origin normalization (11).

Each target has a seed corpus taken from `cloud/protocol/fixtures/` (the envelope target from
`fixtures/jwe/`, signatures from `fixtures/sig/`, Access JWTs from `fixtures/access-jwt/`).

**TypeScript.** Property-based tests with `fast-check`, a new devDependency (no package in
the repo has it today), run in the regular Vitest suites. Covered code:

- Worker signature canonicalization and verification (04);
- the JWE/sealed-envelope parser (02, 06);
- the Web Push payload codec (08);
- relay endpoint-token parsing (08).

The properties are "never throws an untyped error", "round-trips", and "rejects any
single-byte mutation".

**Kotlin and Swift.** The shared negative vectors in `cloud/protocol/fixtures/` (truncated,
bit-flipped, wrong-key) are run by the existing unit suites from 15 and 16. No separate
fuzzer is added, because the decryption code on phones is a thin wrapper over platform
crypto, and the shared vectors already exercise its parse paths.

### Scanning choice (minimal tool set)

| Concern | Tool | Where | Why this one |
|---|---|---|---|
| Secrets | gitleaks | new job in `pr.yml` plus one full-history run here | Single binary, SARIF output, allowlist file; nothing exists today |
| Secrets in artifacts | gitleaks `--no-git` over the unpacked APK/AAB/IPA and the Worker bundle | this phase, then `release-mobile`/`release-cloud` (18) | Catches keys baked into builds |
| Known vulnerabilities, all ecosystems | osv-scanner over `Cargo.lock`, every `package-lock.json`, Gradle lockfiles and `Package.resolved` | new job; complements cargo-audit | One tool reads every lockfile type |
| Licenses (non-cargo) | the license gate 18 adds | verified here against `deny.toml`'s allowlist (:70-96) as the policy source | One policy for all ecosystems |
| Workflow security | zizmor over `.github/workflows/` | new job | New release workflows carry signing secrets |
| Mobile static analysis | MobSF (run as a tool, not a dependency) | this phase, evidence only | Standard MASTG companion |
| Mobile dynamic analysis | Frida/objection on a rooted test device or emulator and a jailbroken-equivalent iOS simulator setup | this phase | MASTG-standard |

## Work items

1. **Threat walkthrough.**
   - For each threat from T25 to T64, trace the claimed mitigation to the code and to a
     test.
   - Missing test: write it in the owning code. Mitigation absent or weaker: file a
     finding.
   - Then edit each threat's `Mitigation in code.`, `Residual risk.` and `Detection.` to the
     verified state, and update the `SECURITY.md` rows.
   - Re-verify T1–T24 only where the cloud work touched their surface (for example T5 for
     the credentials file).
   - **Handoff callback review (R2, D8; T36, T63).** Confirm each item by a test on staging
     and on release-channel builds; each failure is a finding:
     - **https callback.** A release build sends `build=release` with exactly
       `https://<publisher-domain>/auth/callback`. Both servers refuse a `release` request
       naming `yaranapp://auth/callback` and a `dev` request naming an https URL with
       `400 handoff_request_invalid`, per 02's `fixtures/uri/handoff-redirect.json`.
       Android: `adb shell pm get-app-links <applicationId>` reports `<publisher-domain>`
       verified for the Play, GitHub and F-Droid builds. iOS: a link to the callback opens
       the TestFlight build, and the AASA served by Apple's CDN
       (`https://app-site-association.cdn-apple.com/a/v1/<publisher-domain>`) matches the
       committed file. A test app signed with another key and declaring an `autoVerify`
       filter for the same host stays unverified.
     - **Dev-scheme warning.** A build compiled without a publisher domain shows its visible
       warning on the sign-in screen, sends `build=dev`, and the consent page adds 02's
       development-build warning. No release artifact contains a path that sends `build=dev`
       (static check over the built APKs and IPA). Because any app can declare `build=dev`,
       the pentest scope (work item 4) includes a malicious app that starts a `build=dev`
       handoff with its own key against a user already signed in to Access; the consent
       interstitial must be the barrier that stops it.
     - **Consent interstitial.** Both handoff pages (Worker W16b, yaran Y1b) name the device
       label and platform, the host and the signed-in email as 02 §8 specifies. A `GET`
       never seals. The `POST` re-validates every field, needs the single-use `csrf` minted
       by that `GET` (bound to `state`, `pk`, `dk` and the GET's signature verdict, 10 minutes) and passes the `Origin` rule.
       Cancel answers `handoff_declined` and writes `handoff.declined`. A cross-site
       auto-submitted `POST` and a framed page are both refused.
     - **Association files.** `assetlinks.json` and `apple-app-site-association` on
       `<publisher-domain>` are served over https with no redirect, as JSON, byte-equal to the
       committed files, with the fingerprint in `app-signing-cert.sha256`; 18's
       `check-association.mjs --live` passes. The domain's registrar lock and renewal owner
       are recorded (21, 22).
   - **Remembered-consent review (D24; T36, T64).** Confirm each item by a test on staging and
     on release-channel builds; each failure is a finding:
     - **Device key non-exportability.** On Android the key is generated in Keystore with
       `PURPOSE_SIGN` and `DIGEST_SHA256`, StrongBox where present, and `KeyInfo` reports a
       hardware security level (StrongBox or TEE), not software; on iOS it is a Secure
       Enclave key (`kSecAttrTokenIDSecureEnclave`) with `…AfterFirstUnlockThisDeviceOnly`.
       An export attempt fails, a device backup restored to another phone carries no usable
       key, and the private key never appears in logs, diagnostics or the shell WebView
       (MobSF plus Frida on the test device). One key per org registration: two orgs on one
       phone see different `device_key_fingerprint` values, and removing the org or a
       `device_revoked` answer discards the key with its `InstallId`.
     - **Signature canonical string.** Phone, Worker and yaran agree byte for byte on
       `yaran-handoff-device-v1\n<host>\n<pk>\n<state>\n<dts>\n` per 02's
       `fixtures/sig/handoff-device-signature.json`, with `host` taken from the server's own
       served hostname (Y1: the bound cloud hostname; W16: the recorded control-plane host)
       and never from the query; a signature made for one host fails on another. DER, 85- or
       87-char values and `r` or `s` outside `1..n−1` answer `handoff_signature_malformed`;
       an off-curve `dk` answers `handoff_device_key_invalid`; `dts` 301 s off answers
       `handoff_timestamp_skewed`; a well-formed signature that does not verify is the
       consent page, never an error. Verification is WebCrypto `ECDSA`/`SHA-256` on the
       Worker and ring `ECDSA_P256_SHA256_FIXED` on yaran, with no hand-rolled curve code.
     - **Cookie attributes and MAC.** `Set-Cookie` for `__Secure-yaran-handoff-consent` has
       no `Domain`, `Path` equal to the handoff path, `Max-Age=34560000`, `Secure`,
       `HttpOnly` and `SameSite=Lax`, and appears only on the `303` for
       `decision=continue` after a `verified` GET (never on a skip, Cancel or an unverified
       GET). The MAC matches `fixtures/handoff/consent-cookie.json`, is compared in constant
       time, binds the host, and the server enforces the `iat` window itself. The Worker
       derives its key by HKDF purpose `handoff_consent` from `DATA_KEY` and never verifies
       with `DATA_KEY_PREVIOUS`; yaran's `handoff_consent_key` lives only in the owner-only
       credentials file (T5) and is minted fresh on every claim.
     - **Skip rule.** Both servers decide every row of
       `fixtures/handoff/remembered-consent.json` as the fixture says; no path skips without
       all of a valid cookie, a matching fingerprint, a verifying signature and a fresh
       `dts`, and, on the Worker, no revoked device row for that fingerprint. A failing
       cookie is ignored, never cleared and never an error. The skip runs the same rate
       limit, sealing and audit as Continue (`details.consent: "remembered"`).
     - **Invalidation.** Revoking a device (W14, W24) makes its next W16 meet the page;
       rotating `DATA_KEY` makes every W16 meet it; re-pairing or `yaran cloud logout` makes
       every Y1 meet it (19's S30 is the end-to-end evidence).
     - **Accepted gap.** yaran never learns of a Worker device revocation, so a revoked
       phone keeps its Y1 skips until re-pair, logout or the 400-day cap. The review
       confirms the bound 02 Risks relies on (a Y1 skip still needs a verified owner Access
       JWT, and `sign_out_everywhere` revokes those, 06) and that the gap is listed as an
       accepted risk under T64 in `SECURITY.md`. It may close as "accepted" only on that
       basis; any reach beyond it is a finding.
   - Files: `docs/audits/audit04-cloud-connect/01-threat-walkthrough.md`,
     `docs/operations/threat-model.md`, `SECURITY.md`.
   - Test: the T-ID diff from Phase 17's validation still produces no output.
2. **Threat-model consistency script.**
   - Create `scripts/validate-threat-model.sh` (header per 00-CONVENTIONS §2). It fails when
     the T-IDs in `threat-model.md` and `SECURITY.md` differ, when a threat section lacks one
     of the four paragraphs, or when a `Phase` cell names a phase file that does not exist.
   - Wire it into `pr.yml`.
   - Rewrite `SECURITY.md:164-168` to describe the script as existing.
   - If rustport Phase 04 has already landed this script, extend that one instead.
   - Tests: a bats test in `scripts/tests/validate-threat-model.bats` with good and bad
     fixtures.
3. **Authz matrix, black box.**
   - Generate the route list from the Worker router (04) and from yaran's cloud-host routes
     (11).
   - On staging, run every route × {anonymous, user A, user B, admin, service-token JWT,
     expired JWT, wrong-AUD JWT, valid signature from a revoked machine, replayed nonce}.
   - Compare the results with the expected matrix committed in `02-authz-matrix.md`.
   - Create `cloud/worker/test/e2e/authz-matrix.e2e.ts` (≤500 lines; split per route group
     if larger), reusing 19's staging harness. Add a yaran-side counterpart in
     `crates/yaran-web/tests/cloud_host_authz.rs`.
   - Tests: these are the tests. Any mismatch is a finding.
4. **External penetration test.**
   - Scope: staging org Worker, setup wizard, admin and user console, pairing, machine API,
     a staging machine hostname (yaran behind Access), publisher relay (staging), the
     handoff consent pages and the association files on `<publisher-domain>`, and both
     apps (builds from `release-mobile` internal tracks).
   - Rules: staging Cloudflare account only, no social engineering, no DoS beyond
     agreed-rate abuse tests, test identities supplied.
   - Vendor criteria: experience with Cloudflare Access and mobile MASTG, a report mapped to
     CWE and MASWE, and a free retest.
   - Remediate, then retest. The retest letter closes the item.
   - Files: `docs/audits/audit04-cloud-connect/03-pentest/`.
   - Test: every pentest finding has a regression test in the owning code before it is
     marked fixed.
5. **MASVS L2+P audit, Android (both flavors) and iOS.**
   - One row per control and per in-profile MASWE, with the MASTG test used.
   - Areas checked:
     - **STORAGE:** Keystore and Keychain classes, backups off, logs, diagnostics export, the iOS `machine-view` cookie attributes, the handoff device key held non-exportable in Keystore or the Secure Enclave (T37, T51, T61, T64).
     - **CRYPTO:** the handoff JWE (P-256 ECDH-ES with the Concat KDF, A256GCM) against 02's `fixtures/jwe/` (including `kdf-rfc7518-appendix-c.json`), and Web Push decryption (RFC 8291: ECDH, HKDF, AES-128-GCM) against `fixtures/webpush/`; the device-key ES256 signature (DER to raw `r ‖ s` conversion) against `fixtures/sig/handoff-device-signature.json` (D24, T64).
     - **AUTH:** sealed handoff over the verified https callback with the consent tap on first use and remembered consent afterwards (work item 1's callback and remembered-consent reviews, T36, T64), biometric lock via `CryptoObject`/`SecAccessControl`, never a bare prompt.
     - **NETWORK:** HTTPS/WSS only, no cleartext, NETWORK-2 rationale as in Evidence; every Worker call (push registration included) made by the native client, never from JS (D22, T60).
     - **PLATFORM:** `machine-view` has no bridge, host allowlist, deep-link validation, `FLAG_SECURE`, app-switcher cover; the shell WebView cannot reach bearer credentials through the plugin bridge; the App Link / associated-domain declarations match the association files; the loopback proxy, if G1 rung 3 was adopted (T38, T42, T60, T62, T63).
     - **CODE:** minimum OS and WebView version enforced, update notice (T50), input validation of deep links and push payloads.
     - **PRIVACY:** data minimisation against the inventory, no trackers (MobSF tracker scan; F-Droid Tracking anti-feature).
   - RESILIENCE is out of profile, with the rationale from R5 §5.
   - Files: `04-masvs-android.md`, `05-masvs-ios.md`.
   - Tests: each fixed finding gets a unit or instrumentation test in `mobile/` (14, 15, 16
     code).
6. **Abuse testing, Worker and relay.**
   - Scenarios:
     - setup-code brute force (T33);
     - pairing flood and quota exhaustion (T49);
     - handoff consent `POST` replay, missing or reused `csrf`, and consent floods against
       both rate limits (Worker per JWT `sub`; yaran's process-wide limiter, T36, T58);
     - remembered-consent replay: a captured `dk`/`dts`/`dsig` replayed inside and past
       300 s, a consent cookie copied into another browser or used with another device key,
       and a forged cookie with a guessed `kv` (T64);
     - device push endpoints aimed at internal or same-zone hosts (T57);
     - nonce replay and timestamp skew (T28);
     - oversized and malformed bodies on every route;
     - relay endpoint minting with mismatched VAPID keys (T40);
     - push floods per key and per device;
     - 404/410 propagation;
     - Cloudflare API 429 handling under budget.
   - Record the limits observed against the configured ones.
   - Files: `06-abuse-tests.md`; scripts under `tools/cloud-gates/abuse/` (reusing Phase 03's
     gate-script layout).
   - Tests: the scripts are rerunnable against staging, and 22's post-launch checks reuse
     them.
7. **Fuzzing.**
   - Create `crates/yaran-core/fuzz/` and `crates/yaran-web/fuzz/` with the four Rust
     targets, seeded from fixtures.
   - Add `.github/workflows/fuzz.yml`: scheduled weekly plus `workflow_dispatch`, nightly
     toolchain, 30 min per target, crashes uploaded as artifacts, SHA-pinned actions.
   - Add the TS `fast-check` properties in the owning packages' test directories.
   - Run each Rust target at least 8 CPU-hours here before sign-off.
   - Tests: each crash found becomes a regression unit test with the minimized input.
8. **Secret scanning.**
   - Add the gitleaks job to `pr.yml` with `.gitleaks.toml` (allowlist only for test
     fixtures, each entry with a comment).
   - Do a full-history scan, plus an artifact scan of the unpacked release-candidate
     APK/AAB/IPA and the Worker and relay bundles.
   - If any live secret is found in history, rotate it via work item 10. Rewriting history
     is not an acceptable fix.
   - Tests: a fixture commit with a fake AWS-style key fails the job (temporary branch
     proof, recorded in `08-secrets-and-deps.md`).
9. **Dependency and license audits.**
   - osv-scanner and zizmor jobs.
   - Review the overdue `deny.toml` ignores (:29-36) and the duplicated ignores in `pr.yml`,
     with new review dates or removal.
   - License inventory across npm, Gradle and SwiftPM, checked against the `deny.toml`
     allowlist. Particular attention: MPL-2.0 (`@capgo/capacitor-native-biometric`, R5 §5)
     is allowed; anything GPL in the app bundle is a finding unless it is a build-time-only
     tool.
   - Every advisory is fixed or has a dated ignore with rationale.
   - Files: `pr.yml`, `deny.toml`, `08-secrets-and-deps.md`.
   - Tests: the jobs themselves.
10. **Key-compromise playbooks.**
    - Create `docs/operations/key-compromise-playbooks.md`, one section per key:

      | Key | Where it lives |
      |---|---|
      | APNs `.p8` | relay environment |
      | Publisher relay deploy credentials | |
      | Org VAPID private key | Worker D1, encrypted with `DATA_KEY` |
      | `DATA_KEY` | |
      | `CF_API_TOKEN` | org secret |
      | `SETUP_CODE` | relevant only before setup closes |
      | Tunnel token | per machine |
      | Machine Ed25519 key | |
      | Phone JWTs, push keys and the handoff device key (D24) | device loss; revoke the device (W14, W24), which also ends its remembered consent on the Worker |
      | yaran `handoff_consent_key` (D24, T64) | machine credentials file (09); rotated by re-pairing, which forgets every remembered consent on that machine |
      | Android app-signing key | offline, two holders; generated and enrolled in Play App Signing by 18 (D23) |
      | Android upload key | `android-release` environment (18) |
      | Publisher domain and its association files (T63) | registrar account; `publisher-site/.well-known/` hosted by 21 |
      | App Store Connect API key | |
      | Apple distribution certificate | |
      | Repo maintainer account or GitHub environment secrets | |

    - Each section covers: who detects it and how; containment (exact console or CLI step);
      rotation steps; user impact and comms text; verification afterwards.
    - Rehearse every rotatable key on staging and record the times. For the Android
      app-signing key, rotation via Play's key-upgrade path is UNVERIFIED for
      cross-channel installs, so the playbook states the consequence: GitHub and F-Droid
      installs cannot upgrade, users must reinstall, and the key is kept offline with two
      backups.
    - Tests: rehearsal logs in `00-summary.md`.
11. **Privacy review and data inventory.**
    - Create `docs/operations/data-inventory.md`. For every data element (email, machine
      name and hostname, `origin_port`, machine key fingerprint, device label, `install_id`,
      push endpoint and keys, `push_state`, the handoff device public key and its `device_key_fingerprint` (D24), the consent cookie in the phone's system browser, mute settings (`mute_all`, `muted_until`,
      `muted_machine_ids`), APNs token, relay `registration_id`, app version, attention
      event metadata (`label`, `project`, `state`), audit entries, Access JWTs and the
      optional `cookie` in the handoff payload, diagnostics), record:
      - where it is created, transmitted and stored (phone, yaran machine, org Worker D1,
        relay memory, Cloudflare, Apple, Google, distributor);
      - who can read it;
      - retention and the deletion path;
      - whether it is "collected" under the Apple and Google definitions (21 cites these).
    - Relay rule: verify the relay stores and logs nothing beyond rate-limit counters.
    - Tests: a test in the relay suite asserts that no log line contains a token-shaped
      string, using fixture tokens.
12. **Hardening fixes and sign-off.**
    - Every `CC-NNN` is fixed in the owning code with a regression test.
    - The threat model and `SECURITY.md` reflect the verified state.
    - `00-summary.md` has the sign-off table: maintainer, pentest vendor retest, MASVS
      auditor.

## Acceptance

- [ ] Every threat from T25 to T64 has a verified mitigation with a `file:symbol` and a named test in `01-threat-walkthrough.md`. The threat-model text matches what the code does.
- [ ] Every item of work item 1's remembered-consent review (D24; T36, T64) has a staging test, and the yaran-side revocation gap is recorded as an accepted risk in `SECURITY.md`.
- [ ] `scripts/validate-threat-model.sh` exists, runs in `pr.yml`, and passes. `SECURITY.md:164-168` describes it as existing.
- [ ] The authz matrix run on staging matches the expected matrix in every cell.
- [ ] The pentest report and the retest letter are filed. Every pentest finding is fixed and has a regression test.
- [ ] The MASVS L2+P checklists are complete for Android `foss`, Android `play` and iOS, with no failing in-profile control. The NETWORK-2 and RESILIENCE rationales are recorded.
- [ ] Each Rust fuzz target has had at least 8 CPU-hours with no open crash. `fuzz.yml` is scheduled. The fast-check properties are green in CI.
- [ ] The gitleaks job is in `pr.yml`. Full-history and artifact scans are clean, or every leaked secret is rotated and recorded.
- [ ] osv-scanner and zizmor jobs pass. The `deny.toml` ignores have current review dates. The license inventory is within the allowlist.
- [ ] `docs/operations/key-compromise-playbooks.md` covers every key in the list, and each rotatable key's rehearsal is logged.
- [ ] `docs/operations/data-inventory.md` covers every data element. The relay no-token-logging test passes.
- [ ] `09-findings.md` has zero open findings.

## Validation

```bash
cd /Users/siavash/Projects/yaran
scripts/validate-threat-model.sh && bats scripts/tests/validate-threat-model.bats
cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
cargo audit --deny warnings && cargo deny --all-features check
gitleaks detect --source . --log-opts="--all" --redact
osv-scanner scan source -r .
zizmor .github/workflows/
(cd crates/yaran-core/fuzz && cargo +nightly fuzz list)    # expect the targets named in work item 7
for p in cloud/protocol cloud/worker cloud/push-relay mobile/app; do (cd "$p" && npm ci && npm test); done
grep -c '^| CC-' docs/audits/audit04-cloud-connect/09-findings.md
grep -E '\| *(open|Open) *\|' docs/audits/audit04-cloud-connect/09-findings.md   # expect: no output
```

## Risks

| Risk | Mitigation |
|---|---|
| The pentest vendor's lead time slips Wave C | Contract the vendor during Wave B, with scope fixed by this document. The test starts the day 19 exits. |
| A finding needs a D-decision change (for example, Access session limits under G12) | Escalate to the owner. The change lands in `00-README.md` and the owning phase. 21 waits. |
| MobSF or Frida tooling misreports on Capacitor apps | Treat tool output as leads, and confirm each row manually against MASTG. Record the method per row. |
| A fuzz target needs nightly and breaks with toolchain drift | Run it scheduled and outside the PR gate. Pin the nightly date in `fuzz.yml` and bump it monthly (22's cadence). |
| Signing-key rotation would strand cross-channel installs | Prevention-first custody: offline key, two backups, CODEOWNERS on release workflows. The consequence is stated in the playbook. |
| The audit inflates into unrelated refactors | Fixes touch only the code a finding names, under 00-CONVENTIONS §1.2 (new modules, minimal wiring). |

## References

- OWASP MASVS v2.1.0: https://github.com/OWASP/masvs/releases (fetched 2026-11-14)
- MASVS controls: https://github.com/OWASP/masvs/tree/master/controls
- MAS profiles: https://mas.owasp.org/Profiles/
- MASWE: https://mas.owasp.org/MASVS/ (all fetched 2026-11-14)
- Cloudflare certificate pinning: https://developers.cloudflare.com/ssl/reference/certificate-pinning/ (R5 §5)
- `research/R5-mobile.md` §5 and Baseline checklist
- `research/R4-cloudflare.md` §Design constraints
- `research/R3-repo-process.md` §7, §9
- `17-docs-website-threat-model.md` (T25–T64)
- `00-README.md` D8, D22, D23; `02-protocol-contract.md` §8 (redirect allowlist, consent interstitial), §8.1 (device key, remembered consent, D24), §12 (fixtures); `18-build-ci-and-release-pipelines.md` (`check-association.mjs`, D23 enrollment)

## Reconciliation notes (2026-11-14)

- Threat range T25–T53 → T25–T63 in Evidence, In scope, work item 1, Acceptance and References (17's table now ends at T63; R14 superseded).
- Work item 1 gains the handoff callback review: verified https callback on all three Android channels and iOS, dev-scheme warning and the malicious `build=dev` scenario, consent interstitial (`csrf`, `Origin`, `handoff_declined`), association files (R2, D8; T36, T63).
- Work item 4: pentest scope adds the consent pages and the association files (R2).
- Work item 5: CRYPTO wording "HKDF parameters" replaced by the JWE Concat KDF check against `fixtures/jwe/` plus RFC 8291 push decryption (R1); AUTH, NETWORK, PLATFORM and STORAGE add T36, T60 (D22 native-only HTTP), T61, T62, T63.
- Fuzzing: envelope target named as the JWE codec; seed corpora point at 02's `fixtures/jwe/`, `fixtures/sig/`, `fixtures/access-jwt/` (canonical fixture paths).
- Work item 6: consent replay/flood (T36, T58) and push-endpoint SSRF (T57) abuse scenarios added.
- Work item 10: Android key rows say where they live (18 generates and enrolls, D23/R13); publisher domain and association files row added (T63).
- Work item 11: data inventory adds 02's canonical fields (`origin_port`, key fingerprint, `install_id`, `push_state`, mute settings, `registration_id`, event `label`/`project`/`state`, handoff `cookie`) (R9).
- References: D8, D22, D23, 02 §8/§12 and 18 added (R20).
- D24: threat range T25–T63 → T25–T64 in Evidence, In scope, work item 1, Acceptance and References (17 appended T64, remembered-consent bypass; no ID renumbered).
- D24: work item 1 gains the remembered-consent review (device-key non-exportability, canonical string, cookie attributes and MAC, skip rule, revocation and rotation invalidation, the accepted yaran-side revocation gap); the consent-interstitial `csrf` binding adds `dk` and the signature verdict; a new Acceptance line.
- D24: work item 5 adds the device-key ES256 vector (CRYPTO), non-exportable device key (STORAGE) and remembered consent (AUTH); work item 6 adds remembered-consent replay; work item 10 adds the device key to the phone row and a yaran `handoff_consent_key` row; work item 11 adds the device public key, its fingerprint and the consent cookie to the data inventory.

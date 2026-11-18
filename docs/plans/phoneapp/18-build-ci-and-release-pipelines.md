# Phase 18 — Build, CI and release pipelines for all trains and channels

**Track:** B (parallel) · **Parallel-safe with:** 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17
**Depends on:** 01 (`gates.yml` seam, module-headers gate), 02 (package layout, npm scripts, `ReleaseManifest`, §8 callback allowlist), 03 (G4, G5, G7, G11, G14); code-level, developed concurrently inside Wave B: 07 (deploy-tree assembler), 10 (cloudflared pin tooling), 14 (Gradle/Xcode projects, flavors, publisher config) · **Blocks:** 19 (Wave C runs 19 → 20 → 21 → 22; 21 and 22 also consume this phase's workflows and its D23 enrollment record directly)

## Goal

Every new subproject must get a CI suite that runs on each PR and joins the single required
check. Each new release train needs its own workflow that turns a tag into verified,
attested and checksummed artifacts on every channel:

- The `yaran-cloud-v*` train produces the protocol, Worker and relay bundles, deploys
  the relay, and publishes the generated, self-contained `cloud-deploy` branch that the
  Deploy button and the update checker read (D18).
- The `yaran-mobile-v*` train produces the signed GitHub APKs and a Play internal AAB,
  sends a TestFlight build, and runs F-Droid reproducibility verification. Before anything
  reaches Play, this phase generates the Android app-signing key and enrolls it in Play App
  Signing (D23).

The existing `yaran-v*` binary pipeline must keep working exactly as it does today (D15).
The new trains carry an equal supply-chain bar: SHA-pinned actions, protected
environments, one Android app-signing key (D14), license and audit gates, and reproducible
builds.

## Evidence

All repo facts were re-verified on 2026-11-14. Online facts were read on the same date.

- **Existing workflows.** The repo has seven: `install-script-ci`, `overlay-ci`, `pages`,
  `pr`, `release`, `test` and `website-ci`.
  - Each declares top-level `permissions` (e.g. `pr.yml:8-9`, `release.yml:7-8`).
  - Every action is pinned to a 40-hex SHA with a version comment:
    - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`
    - `actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0` (`website-ci.yml`, `release.yml:367-369`)
    - `actions/upload-artifact@ea165f8… # v4.6.2` and `download-artifact@d3f86a1… # v4.3.0` (`release.yml:271, :307`)
    - `actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2.4.0` (`release.yml:257`)
  - There is no `pull_request_target` anywhere. Fork PRs have the token withheld by the
    expression at `website-ci.yml:95`.
  - There is no `schedule:` trigger. `workflow_dispatch` appears only at `pages.yml:14`. The
    only `environment:` is `pages.yml:134`.
- **`release.yml`.**
  - It runs on `release: types: [created]` (:3-5). The case at :61-65 accepts only
    `yaran-v*` and `dux-amq-v*` and otherwise `exit 1` (:64).
  - It requires exactly 4 checksum lines (:328). Its tar is reproducible
    (`SOURCE_DATE_EPOCH`, sorted, `gzip -n`, built twice and `cmp`, :189-209). It attests
    with `id-token: write` and `attestations: write` (:93-96, :254-261).
  - A human creates the release (:286).
  - **Consequence:** a human-created `yaran-mobile-v*` or `yaran-cloud-v*` release turns
    this workflow red.
- **`install.sh`.**
  - With no version set it takes `tag_name` from `/releases/latest` (:281-282), falling
    back to `/releases?per_page=1` (:287). Neither path checks the tag prefix.
  - It then downloads `releases/download/<tag>/yaran-<os>-<arch>.tar.gz` (:332-338).
  - **Consequence:** if a mobile or cloud release becomes "latest", the default
    `curl | bash` install 404s and aborts. So does the CI leg `install-script-ci.yml:52-53`
    (`latest`).
- **Branch protection.** `BRANCH_PROTECTION.md` lists the required checks
  `Test (ubuntu-24.04)`, `Test (macos-14)`, `Security` and `shell` (:20-29). It protects
  the tags `v*`, `dux-amq-v*` and `yaran-v*` (:45) and sets read-only default workflow
  permissions (:53-54). It mentions no environments.
- **Phase 01** adds `gates.yml`. It has no `paths` filter. Its `changes` job emits `cloud`
  and `mobile` outputs, and its seam calls `cloud-ci.yml` and `mobile-ci.yml` as
  `on: workflow_call`. The always-reporting `Required gates` job is the one required
  context (01 §CI, items 1-5).
- **Ownership and update tooling.**
  - `CODEOWNERS`: `* @SiavZ` (:8), with explicit supply-chain paths (:23-29).
  - `dependabot.yml` covers `cargo`, `github-actions` and `npm` for
    `/crates/yaran-web/web` only (:12-42).
  - `deny.toml` holds the license allowlist (:70-96) and applies to cargo only. No npm or
    Gradle license or audit gate exists (R3 §9).
- **Node.** The repo has no `.nvmrc` or `.node-version`. CI mixes Node 22 (`pr.yml`,
  `test.yml`) and Node 24 (`website-ci.yml`, `release.yml`). `CONTRIBUTING.md:12` asks
  for Node 22.12 or newer.
  - Node 26 has been Active LTS since 2026-10-28; Node 24 is in maintenance until
    2028-04-30 (https://github.com/nodejs/Release).
- **The repo is public** (`gh repo view SiavZ/yaran` reports `PUBLIC`, fork).
  - Standard macOS runners are free for public repos
    (https://docs.github.com/en/billing/concepts/product-billing/github-actions).
  - Environment secrets are available on public repos under any plan. A job cannot read
    them until a required reviewer approves
    (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
  - Secrets are not passed to workflows triggered from forks
    (https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
- **Runners.** `macos-26` (equal to `macos-latest`, arm64) has Xcode 26.0.1-26.6 under
  `/Applications/Xcode_26.x.app`. There is no `macos-26-arm64` label
  (https://github.com/actions/runner-images).
  - Apple uploads require Xcode 26 and the iOS 26 SDK (since 2026-04-28) and a deployment
    target of iOS 13 or later (https://developer.apple.com/news/upcoming-requirements/).
- **fastlane 2.241.2** (2026-10-26).
  - `upload_to_play_store` takes `aab`, `track`, `json_key_data`, `validate_only`,
    `changes_not_sent_for_review` and `metadata_path`.
  - `app_store_connect_api_key` takes `key_id`, `issuer_id`, `key_content` and
    `is_key_content_base64`.
  - `match` runs `readonly` on CI, uses `MATCH_PASSWORD`, and supports
    `MATCH_GIT_BASIC_AUTHORIZATION`. `setup_ci` creates a temporary keychain.
  - Docs: https://docs.fastlane.tools/actions/upload_to_play_store/ , /upload_to_testflight/ ,
    /app_store_connect_api_key/ , /match/ , /setup_ci/.
  - `xcodebuild -allowProvisioningUpdates -authenticationKey*` is documented only in the
    man page and is **UNVERIFIED** as a supported CI signing path. That is why `match` is
    primary (R5 §7.4).
- **App Store Connect API keys.** Team keys are created by the Account Holder or an Admin.
  The `.p8` "can only be downloaded once"
  (https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).
  The minimum role for a TestFlight upload (App Manager) is **UNVERIFIED**.
- **Play App Signing.** Choose "use your own key" and export it via PEPK before the first
  release. The upload key is separate and resettable. Validity must be 25 years or more,
  ending after 2033-10-22 (https://support.google.com/googleplay/android-developer/answer/9842756 ,
  https://developer.android.com/studio/publish/app-signing).
- **F-Droid.**
  - `Binaries:` plus `AllowedAPKSigningKeys:` publishes the developer-signed APK when
    F-Droid's rebuild matches, verified with apksigcopier.
  - Only apksigner from build-tools **34** produces APKs that apksigcopier can verify
    (https://f-droid.org/docs/Reproducible_Builds/).
  - Fastlane metadata is read from the repo root at `fastlane/metadata/android/<locale>/`,
    or from `<subdir>/fastlane/…` when `subdir:` is set. "Placing the structure anywhere
    else … won't work" (https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/).
  - `UpdateCheckMode: Tags <regex>` scrapes `versionCode` and `versionName` literals
    without running the build (R5 §7.7).
- **Gradle and AGP.**
  - Gradle 9 makes archive tasks reproducible by default
    (https://docs.gradle.org/current/userguide/working_with_files.html).
  - `vcsInfo` defaults on for release builds (AGP 8.3.1+).
  - `dependenciesInfo { includeInApk = false }` avoids F-Droid's "extra signing block"
    failure (forum guidance).
  - Baseline-profile non-determinism is listed by F-Droid. The task-disabling snippet is
    **UNVERIFIED**.
  - `--write-verification-metadata sha256` is **UNVERIFIED** in this session, because the
    docs page did not render. It is the long-standing Gradle flag.
- **Supply-chain tooling.**
  - `actions/attest-build-provenance` v4.2.2 (`4d101475d8b20a2381f78447822ac1eab6504dd8`)
    is now a wrapper over `actions/attest`.
  - `cloudflare/wrangler-action` v4.1.3 is `953926a2e2182532811c01a25e53647d93bf07c0`.
  - CycloneDX Gradle plugin `org.cyclonedx.bom` 3.6.1 (`cyclonedxBom`).
  - `npm sbom --sbom-format cyclonedx` (npm 9.9+).
  - `license-checker-rseidelsohn` 5.0.1.
  - Gradle `com.github.jk1.dependency-license-report` 3.x (`checkLicense`).
  - `npm audit --omit=dev --audit-level=high`.
  - Dependabot supports `gradle`, `npm`, `bundler` and `swift` (git registries only), with
    a `directories:` list and globs
    (https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).
- **Plan facts this phase implements.**
  - D18/R4: the Deploy button targets the `cloud-deploy` branch, built by this train with
    `cloud/protocol` bundled in. On `main`, `cloud/worker` imports `cloud/protocol` as a
    local package (`file:../protocol`, 02 WI-1; no npm workspaces, 01). No vendored copy
    lives on `main`, so there is no vendored-copy drift check (01 §Scope).
  - 07 §1 owns the assembler `cloud/worker/scripts/assemble-deploy-tree.ts`; its tree goes
    under `worker/` on the branch, and 02's `ReleaseManifest` lives at
    `cloud-deploy:worker/release.json`, which 07's checker fetches.
  - D19/R5: the deploy tree ships `workers_dev: true`, `preview_urls: false` and no custom
    domain or route (07 §2, 03 G14).
  - 02 §8: release builds carry the configured https callback
    `https://<publisher-domain>/auth/callback` in the Worker's `APP_CALLBACK_URLS` and in
    yaran's compiled `[cloud] app_callback_urls` default; this phase injects it.
  - D23: the Android app-signing key is generated and enrolled in Play App Signing here,
    before any upload to Play, internal tracks included.
  - 10 hands this phase the scheduled pin-freshness check (`tools/cloudflared-pin/bump.sh
    --check`) and the CI job that caches the pinned cloudflared (minimum 2026.11.0, G2) for
    its gated real-binary test. 19 asks for an `e2e.yml` stage on release candidates.
- **Research.** R3 §1-§2, §9 and Implications 2-4; R5 §4 (target API 36, developer
  verification, F-Droid policy) and §7.

## In scope

- `cloud-ci.yml` and `mobile-ci.yml`, plus the mobile reusable sub-workflows, as
  `workflow_call` suites wired into Phase 01's `gates.yml` seam.
- A new always-run, required `Workflow policy` check. It enforces SHA pins, top-level
  permissions and no `pull_request_target`, and runs actionlint.
- `release-cloud.yml` (`yaran-cloud-v*`) and `release-mobile.yml` (`yaran-mobile-v*`).
- Publishing the generated `cloud-deploy` branch from `release-cloud` (D18), with the
  self-containment and wrangler-config (D19) checks run on the generated tree.
- A shared publish workflow for both, and a store-promotion dispatch workflow used by 22.
- A weekly F-Droid drift watch, and the weekly cloudflared pin watch plus the cached
  pinned-binary CI job that 10 hands over.
- The Android app-signing key ceremony and Play App Signing enrollment before any Play
  upload, with a code gate that refuses Play uploads without the enrollment record (D23).
- The one committed home for the publisher domain (`publisher.json`) and its injection into
  the Worker deploy tree, the yaran build and the app checks (02 §8, D16); the check of the
  association files 21 hosts (T63).
- The reserved `e2e.yml` stage for release candidates (19).
- Release-train tooling: tag parsing, version derivation, literal-version checks and
  bumping, and a license allowlist derived from `deny.toml`.
- Protection of the existing binary pipeline:
  - a guard in `release.yml`
  - a tag-prefix filter in `install.sh`
  - `--latest=false` on every new-train release
- Toolchain pins: Node, JDK, Android build-tools, Xcode and Ruby/bundler.
- Fastlane lanes, the F-Droid recipe draft, and the F-Droid metadata location.
- Signing and secrets management: environments, the secret inventory and the custody
  procedure.
- Supply-chain gates: dependabot, CODEOWNERS, license and audit checks, Gradle wrapper
  validation and dependency verification, SBOMs and provenance.
- Generated license inventories for npm, Gradle and SwiftPM (handed off by 17).
- Updates to `BRANCH_PROTECTION.md` and the tag protection for the new trains.

## Out of scope

| Item | Owner |
|---|---|
| `tools/module-headers`, `gates.yml` itself, the `Required gates` aggregator | 01 |
| Package layout, codegen, npm scripts of `cloud/*` | 02, 04, 08 |
| Deploy to Cloudflare button URL, the deploy-tree assembler (`assemble-deploy-tree.ts`), the tree's `wrangler.jsonc` template and the org-Worker update checker and job | 07 |
| Relay code, its wrangler config, the Container/VM packaging for the G4 fallback | 08 |
| cloudflared pin table (`pins.rs`), `tools/cloudflared-pin/bump.sh`, the real-binary test itself | 10 |
| Gradle/Xcode project structure, flavors, minSdk/target, Capacitor version (`~8.6.2`, and the upgrade to 9 at GA, 14 work item 14), publisher build-config loader, the license-list generator `mobile/scripts/licenses.sh` | 14 |
| Push plugin and NSE code (this phase only runs their tests and signs the NSE) | 16 |
| `CLAUDE.md` product-identity text naming the trains; consumer docs; threat rows T29, T46, T50, T52 and T63 text | 17 |
| End-to-end runs on real Cloudflare and devices, and `e2e.yml` itself (this phase reserves its release stage) | 19 |
| Apple account, iOS identifiers and distribution certificates, Play developer verification registration, hosting the association files on `<publisher-domain>`, F-Droid MR submission, listings and screenshots. (The Android app-signing and upload keys are generated and enrolled here, D23; the Play Console account is opened here for that and 21 records it.) | 21 |
| Staged rollout decisions, runbooks, rollback execution | 22 |

## Design

### Workflow inventory

| File | Trigger | Purpose | Required? |
|---|---|---|---|
| `cloud-ci.yml` | `workflow_call` from `gates.yml` (filter `cloud`) | protocol, worker, relay suites | via `Required gates` |
| `mobile-ci.yml` | `workflow_call` (filter `mobile`) | shell/plugins TS, then calls the two below | via `Required gates` |
| `_mobile-android-ci.yml` | `workflow_call` | Gradle lint/test/build, both flavors, emulator UI tests, reproducibility, license | via `Required gates` |
| `_mobile-ios-ci.yml` | `workflow_call` | unsigned build, XCTest/XCUITest on simulator, SwiftLint | via `Required gates` |
| `workflow-policy.yml` | every `pull_request`, push to `main` | SHA pins, permissions, no `pull_request_target`, actionlint | **yes**, `Workflow policy` |
| `release-cloud.yml` | `push: tags: ['yaran-cloud-v*']` | build (incl. the generated deploy tree), attest, publish, relay deploy, `cloud-deploy` branch publish (stable) or `cloud-deploy-rc` (release candidates) | n/a |
| `release-mobile.yml` | `push: tags: ['yaran-mobile-v*']` | build, sign, verify, publish, store upload (Play only after the D23 enrollment gate) | n/a |
| `_mobile-android-release.yml`, `_mobile-ios-release.yml`, `_fdroid-verify.yml` | `workflow_call` | release legs | n/a |
| `_publish-train-release.yml` | `workflow_call` | checksums with an exact expected file list, provenance, `gh release create --latest=false` | n/a |
| `mobile-store-promote.yml` | `workflow_dispatch` | Play track promotion/rollout, App Store submit (22 operates) | n/a |
| `fdroid-watch.yml` | `schedule` weekly plus dispatch | re-run `_fdroid-verify` on the newest stable mobile tag to catch buildserver drift | n/a |
| `cloudflared-pin-watch.yml` | `schedule` weekly plus dispatch | run 10's `tools/cloudflared-pin/bump.sh --check` (pin older than 60 days, or a `VULN-` release not adopted within 7 days); on failure open or update one issue labelled `ops:p2` (T29) | n/a |

Every file is planned at or under 500 lines. That is why the release legs are reusable
workflows.

- **Header.** Every workflow starts with a `#` header: title, responsibilities, and the
  scripts and reusable workflows it uses. The generated block is used if 01's tool covers
  YAML; otherwise the header is prose.
- **Pins.** Every action is pinned to a 40-hex SHA with `# vX.Y.Z`.
- **Existing pins are reused verbatim:** `checkout`, `setup-node`, `upload-artifact`,
  `download-artifact` and `attest-build-provenance`. Keeping one SHA per action means
  dependabot bumps every copy together.
- **New actions:**
  - `cloudflare/wrangler-action` 953926a… (v4.1.3)
  - `actions/setup-java`
  - `ruby/setup-ruby`
  - `gradle/actions/wrapper-validation`
  - `reactivecircus/android-emulator-runner`
  - `actions/cache` (the cached cloudflared binary)
  - `rhysd/actionlint` (run as a checksummed release binary)
  - The SHAs of the last six are resolved at implementation with
    `gh api repos/<o>/<r>/git/ref/tags/<tag>` and recorded in the PR. They are
    **UNVERIFIED** here.

### Release trains, tags and "latest"

- **Tags.** `yaran-v*` is unchanged. The new trains are `yaran-cloud-vX.Y.Z[-rc.N]` and
  `yaran-mobile-vX.Y.Z[-rc.N]` (D15). Only `-rc.N` prereleases exist.
- **Who creates the release.** The new trains trigger on the **tag push**, and the
  workflow creates the GitHub release itself with `gh release create --verify-tag
  --latest=false [--prerelease]`.
  - This departs on purpose from the binary train's human-created release (`release.yml:286`).
    The UI's default "Set as latest" would break `install.sh`, and a workflow can guarantee
    `--latest=false`.
  - A release created with `GITHUB_TOKEN` does not start other workflows, so `release.yml`
    does not fire.
- **Guards (R17; this phase owns all three edits, 17 documents them).** These are cheap,
  and they cover a human who creates such a release by hand anyway.
  1. `release.yml` gets a job-level
     `if: startsWith(github.event.release.tag_name, 'yaran-v') || startsWith(github.event.release.tag_name, 'dux-amq-v')`
     on `prepare`. The downstream jobs `needs` it, so the whole workflow skips instead of
     failing at :64.
  2. `install.sh`'s `resolve_version` lists `/releases?per_page=30`. It picks the first
     non-draft, non-prerelease release whose tag matches `yaran-v*|dux-amq-v*|v*`, and only
     then any matching prerelease. `/releases/latest` stays as the fast path, and its
     answer is accepted only when the tag matches.
- **Tag protection.** Add `yaran-cloud-v*` and `yaran-mobile-v*`, and a branch rule for
  `cloud-deploy` (see Cloud release).

### Version derivation (`tools/release-trains/`)

- **One parser for both trains.** It accepts `^yaran-(cloud|mobile)-v(\d+)\.(\d+)\.(\d+)(-rc\.(\d+))?$`.
- **Android `versionCode`.** `X*1_000_000 + Y*10_000 + Z*100 + (rc ? N : 99)`, with
  `Y ≤ 99`, `Z ≤ 99`, `1 ≤ N ≤ 98` and a result `≤ 2_100_000_000`.
  - This keeps codes monotonic across release candidates; R5 §7.8's scheme had no room for
    them.
  - iOS `CFBundleVersion` is the same integer, and `CFBundleShortVersionString` is `X.Y.Z`.
- **Literals.** Versions are written literally into the files F-Droid scrapes and Xcode
  reads, so the tag points at a commit that already holds them (R5 §7.7-7.8):
  - `mobile/android/app/build.gradle(.kts)`: `versionCode`, `versionName`
  - the `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` of **every** target in
    `project.pbxproj`, App and NSE alike, because the extension must match the app
  - `mobile/app/package.json`
  - `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`
  - the cloud train: each `cloud/*/package.json` `version`
- **Commands.**
  - `bump.mjs <tag>` writes the literals in the release PR.
  - `check-versions.mjs <tag>` is the first release job, and it fails on any mismatch.
  - fdroidserver scraping a Kotlin-DSL `versionCode = N` is **UNVERIFIED**. G7 checks it.
    If it fails, 14 uses Groovy `build.gradle` for the app module.
- **Language.** Node ESM with no dependencies and `node --test`, following the repo
  precedent `npm/scripts/build_npm_package.mjs`.

### Toolchain pins

- **`.node-version` at the repo root** holds Node `24.<patch>`. The exact patch is chosen at
  implementation and recorded in the file.
  - All new workflows use `setup-node` with `node-version-file: .node-version`, and the
    F-Droid recipe installs the same major.
  - Node 24 matches `release.yml` and `website-ci.yml`. The bump to Node 26 is a 22
    runbook item.
  - The existing workflows are not changed (out of scope), except that `gates.yml` and
    02's `cloud-protocol.yml` switch to `node-version-file: .node-version` when this phase
    fills 01's seam (01 §CI). `CONTRIBUTING.md` gains one line naming the file.
  - It is the one Node pin: 14 creates no `mobile/app/.nvmrc`, so two files cannot disagree
    (14's `engines` `node >=22.12`, the same floor as 01/02/04, stays, and 24 satisfies it).
- **`mobile/toolchain.env`** is the one home for the remaining pins. Workflows load it into
  `$GITHUB_ENV`.
  - `JAVA_VERSION`: per 14's AGP; JDK 21 expected, **UNVERIFIED**.
  - `ANDROID_BUILD_TOOLS=34.0.0`, so apksigner is from build-tools 34.
  - `ANDROID_COMPILE_SDK=36` and `ANDROID_TARGET_SDK=36` (Play requirement, 14).
  - `IOS_DEPLOYMENT_TARGET=17.4` (D8: the `.https` `ASWebAuthenticationSession` callback).
    `check-versions.mjs` fails when 14's Gradle or `project.pbxproj` disagree with either
    value (R21).
  - `XCODE_APP=/Applications/Xcode_26.<n>.app`.
  - `RUBY_VERSION`.
  - `IOS_SIM_DEVICE` and `IOS_SIM_OS`.
  - `APKSIGCOPIER_VERSION`.
  - `FDROIDSERVER_IMAGE` (digest-pinned `registry.gitlab.com/fdroid/docker-executable-fdroidserver@sha256:…`).
- **Ruby and fastlane.** fastlane is pinned through `mobile/Gemfile` and `Gemfile.lock`
  (fastlane 2.241.2, run with `bundle exec`).

### Secrets, environments and custody

| Environment (required reviewer: maintainers) | Secrets | Used by |
|---|---|---|
| `android-release` | `ANDROID_APP_SIGNING_KEYSTORE_B64`, `_STORE_PASSWORD`, `_KEY_ALIAS`, `_KEY_PASSWORD` (the one D14 app key, generated in work item 9); `ANDROID_UPLOAD_KEYSTORE_B64` + passwords; `PLAY_SERVICE_ACCOUNT_JSON` | `_mobile-android-release`, promote |
| `ios-release` | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_B64` (Team key, App Manager role, UNVERIFIED minimum); `MATCH_PASSWORD`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION` | `_mobile-ios-release`, promote |
| `push-relay-production` | `CLOUDFLARE_API_TOKEN` ("Edit Cloudflare Workers" template, publisher account only), `CLOUDFLARE_ACCOUNT_ID` | relay deploy |
| `cloud-release` | none (uses `GITHUB_TOKEN` `contents: write`); `CLOUD_DEPLOY_KEY` only if the branch-rule fallback below is needed | `cloud-deploy` and `cloud-deploy-rc` branch publish |

- **APNs `.p8` never enters GitHub.** It is set once in the relay with
  `wrangler secret put` by a maintainer (D11). Rotation is a 22 runbook item.
- **Fork PRs never see secrets.** CI suites use none, so there is nothing to withhold. The
  release workflows run only on tag pushes and dispatch, and every secret is
  environment-scoped. `workflow-policy` fails any `pull_request_target`.
- **Two Android signing paths.**
  - The **app key** signs the GitHub APKs. That is what makes Play, GitHub and F-Droid
    installs upgrade one another (D14).
  - The Play AAB is signed with the **upload key**, and Play re-signs it with the app key
    that was uploaded via PEPK before any upload (this phase executes it in work item 9,
    D23; `check-versions.mjs --play` refuses every Play upload until the enrollment record
    exists).
  - `mobile/android/signing/app-signing-cert.sha256` (the public fingerprint, committed) is
    checked against `apksigner verify --print-certs` on every release APK. A wrong key can
    never ship.
- **Custody.** `docs/operations/release-trains.md` (maintainer-facing, beside
  `threat-model.md`) records:
  - key generation (RSA 4096, validity of 30 years or more)
  - offline backups (two holders)
  - the PEPK upload step and the enrollment record `mobile/android/signing/play-enrollment.json`
    (D23, work item 9)
  - secret rotation (upload key reset via Play; ASC key revoke and reissue; match
    `nuke` and regenerate)
  - the compromise playbook pointer (20, T46)

### Publisher build values (D16)

- **Values must be committed.** The relay URL, application id, bundle ids, team id and
  play push transport go in the publisher build config that 14 defines. F-Droid builds
  from source, so these values cannot come from GitHub variables.
- **Placeholders block a release.** `check-versions.mjs --publisher` fails a release when
  any `<placeholder>` remains.
- **Firebase config.** The G5-fallback `google-services.json` alone is injected from the
  secret `PLAY_GOOGLE_SERVICES_JSON` (in `android-release`) for `play` builds. It is never
  needed by `foss`.
- **One home for the publisher domain (D8, D16, 02 §8).** `publisher.json` at the repo root
  holds `publisher_domain`, committed as the placeholder `<publisher-domain>` until the
  maintainer commits the real value. Every callback is derived from it:
  - the cloud train passes it to 07's assembler, which writes
    `APP_CALLBACK_URLS = https://<publisher_domain>/auth/callback` into the deploy tree's
    `wrangler.jsonc` `vars`;
  - the yaran binary's compiled default for `[cloud] app_callback_urls` is read from the same
    file at build time (09 renders the key, 11 enforces it), so `release.yml` needs no edit;
  - the app's App Link host and associated domain (14, 15) must equal it:
    `check-versions.mjs --publisher` fails on any disagreement with `mobile/publisher.properties`
    or `Config/Publisher.xcconfig`.
  - A tree that still holds the placeholder builds as "compiled without a publisher domain"
    (D8): dev custom-scheme callback, `build=dev`, on-screen warning. `--publisher` refuses
    such a tree for any official release, cloud or mobile.
- **Association files (T63).** 21 hosts `assetlinks.json` and `apple-app-site-association`
  on `<publisher-domain>` from files committed under `publisher-site/.well-known/`.
  `tools/release-trains/check-association.mjs` asserts that the committed files name the
  real `applicationId` with the SHA-256 in `app-signing-cert.sha256` (Android), and
  `<TeamID>.<bundle id>` with the `/auth/callback` and `/oauth/callback` paths (iOS). With
  `--live` it also fetches both files over https from the domain, with no redirect followed,
  and compares them byte for byte. The mobile `check` job runs `--live` for stable tags, so a
  release cannot ship while the domain vouches for the wrong key or for nothing. 22 runs the
  same script daily.

### CI suites

- **`cloud-ci.yml`.** Matrix over `cloud/worker` and `cloud/push-relay`. Each package must
  expose the npm scripts `typecheck`, `lint`, `test` and `build`, a contract on 04 and 08.
  Steps:
  1. `npm ci` (the Worker resolves `cloud/protocol` through its `file:../protocol`
     dependency, R4)
  2. the four scripts
  3. `npm audit --omit=dev --audit-level=high`
  4. `license-checker-rseidelsohn --production --onlyAllow "$(node tools/release-trains/license-allowlist.mjs --npm)"`
  5. `npx wrangler deploy --dry-run --outdir dist` (worker and relay)
  6. a double build with `diff -r` to prove the bundle is deterministic
  7. for the Worker only, `check-deploy-tree.mjs --config-only cloud/worker`: the
     `wrangler.jsonc` template 07 owns has `workers_dev: true`, `preview_urls: false`, no
     `route`/`routes` and no custom-domain entry, and no `database_id` (D19, R5)
  - `cloud/protocol`'s own suite is 02's `cloud-protocol.yml` (02 WI-11: `gen:check`,
    typecheck, tests, OpenAPI lint, vector check), which `gates.yml` already calls; this
    phase adds its npm audit and license steps to that workflow rather than running the
    package twice.
  - There is no vendored protocol copy on `main` and therefore no vendored-copy drift
    check (R4, D18). Self-containment is proven on the generated tree instead (Cloud
    release, `build`).
  - The Rust half of the shared fixtures already runs in `pr.yml` `cargo test`, which runs
    on every PR.
- **`mobile-ci.yml`, JS half.** `npm ci`, then `typecheck`, `lint`, `test` and `build` for
  the shell (`mobile/app`) and plugins, then npm audit and license as above, then a double
  `vite build` with `diff -r`, then 14's `mobile/scripts/licenses.sh --check` (generated
  license lists must match the dependency tree).
- **`mobile-ci.yml`, Android leg** (ubuntu-24.04, `setup-java` with the `JAVA_VERSION`
  pin and Gradle cache, wrapper validation):
  1. `./gradlew` with `lintFossRelease lintPlayRelease testFossDebugUnitTest
     testPlayDebugUnitTest ktlintCheck detekt checkLicense cyclonedxBom
     assembleFossRelease bundlePlayRelease` (unsigned)
  2. **Dependency verification:** `gradle/verification-metadata.xml` (sha256) is enforced
     by Gradle itself.
  3. **Classpath guard:** `fossReleaseRuntimeClasspath` must contain no Firebase, GMS or
     embedded-FCM artifact (14's `:app:verifyFossDependencies` task and 16's dependency
     assertion, both run here).
  4. **Reproducibility:** build `assembleFossRelease` twice in two clean checkouts at
     different paths, then compare the unsigned APKs with `cmp`. Any difference prints
     `diffoscope` output.
  5. **UI tests:** `connectedFossDebugAndroidTest` on an API 36 emulator via
     android-emulator-runner (KVM).
- **`mobile-ci.yml`, iOS leg** (`macos-26`, with `sudo xcode-select -s "$XCODE_APP"`):
  1. `npm ci`, the build, and `npx cap sync ios`
  2. `swift test` for `YaranPushCore`
  3. `xcodebuild test` (App, plugin and NSE unit tests and XCUITest) on the pinned
     simulator
  4. an unsigned `xcodebuild archive CODE_SIGNING_ALLOWED=NO`
  5. `swiftlint --strict`
- **`ui-kit-ci.yml`** (`on: workflow_call`; fills 01's `ui-kit` seam job, R18). The kit's
  own suite, with the commands 14 names (14 §Validation): `npm ci` in `packages/ui-kit`,
  `npx tsc --noEmit`, `npm test` (Vitest, including the tests moved with the components),
  `node scripts/export-native-colors.mjs --check` (native colour drift), then npm audit and
  license as above. The consumers (web UI, shell, Worker console) are still built by their
  own suites, which the `cloud` and `mobile` filters already trigger on a kit change.
- **cloudflared real-binary job (10, T29).** A `cloudflared` job in the `gates.yml` seam,
  filtered on `crates/yaran-core/src/cloud/cloudflared/**` and `tools/cloudflared-pin/**`:
  it downloads `PINNED_VERSION` (currently 2026.11.0, the G2 minimum) for linux-amd64,
  verifies it against the SHA-256 row in 10's `pins.rs`, caches it under
  `~/.cache/yaran-ci/cloudflared-<version>` with `actions/cache` keyed on version and hash,
  then runs `YARAN_TEST_CLOUDFLARED=<path> cargo test -p yaran-core -- --ignored
  real_cloudflared`. A hash mismatch fails the job and never falls back to an unverified
  download. `bump.sh --check` is time-dependent, so it stays out of PRs and runs in
  `cloudflared-pin-watch.yml` (Workflow inventory).
- **Seam fill in `gates.yml`.** Add `cloud`, `mobile`, `ui-kit` and `cloudflared` jobs with
  `uses: ./.github/workflows/<suite>.yml` (or the inline job above), gated on
  `needs.changes.outputs.<x>`, add them to `Required gates.needs`, and list them in
  `allowed-skips` (01 §CI item 4).
  - The `mobile` filter also matches `fastlane/**`, `.node-version`, `publisher.json`,
    `publisher-site/**` and `tools/release-trains/**`.
  - The `cloud` filter also matches `.node-version` and `publisher.json`.

### License allowlist, one home

- **Source.** `tools/release-trains/license-allowlist.mjs` reads the `allow = [...]` array
  of `deny.toml` (:70-96). It emits the npm `--onlyAllow` string, and jk1's
  `allowed-licenses.json` into `build/`, never committed. One list governs cargo, npm and
  Gradle.
- **Normalization.** jk1 license names that do not match SPDX ids go through jk1's
  normalizer bundle, committed as `mobile/android/config/license-normalizer.json`. That
  mapping is **UNVERIFIED** until the first run.
- **Inventories for 14 and 17.** The in-app licenses asset is 14's committed output of
  `mobile/scripts/licenses.sh` (checked for drift in `mobile-ci`). The `npm` license JSON,
  the jk1 report and the SwiftPM list below are this phase's allowlist gate over the same
  dependency trees, and all of them are attached to each mobile release.
  - The SwiftPM list comes from `Package.resolved` plus a committed
    `mobile/ios/licenses-swiftpm.json` map. The gate fails if a resolved package is missing
    from the map. No CycloneDX tool for SwiftPM was found.

### Cloud release (`release-cloud.yml`)

1. **`check`:** `check-versions.mjs` (with `--publisher` for stable tags), then
   `uses: ./.github/workflows/cloud-ci.yml` and 02's `cloud-protocol.yml`.
2. **`build`:**
   - `npm pack` gives `yaran-cloud-protocol-<v>.tgz`. It is attached to the release only and
     never published to npm (D16; no npm package exists).
   - **Deploy tree (D18, R4).** Run 07's `cloud/worker/scripts/assemble-deploy-tree.ts`
     with the tag and `publisher.json` (it writes `APP_CALLBACK_URLS` into the tree's
     `wrangler.jsonc` `vars`). Then `check-deploy-tree.mjs <out>/worker`:
     - **Self-contained:** copy the tree into an empty directory outside the checkout, so no
       parent `node_modules` or sibling package can be found, and run `npm ci && npm run
       build && npx wrangler deploy --dry-run` there. No dependency spec may point outside the
       tree (`file:../`, `link:`, `workspace:`); the bundled protocol lives at
       `vendor/cloud-protocol/` inside the tree (07 §1).
     - **Wrangler config (D19, R5):** `workers_dev: true`, `preview_urls: false`, no
       `route`/`routes`, no custom-domain entry, D1 binding without `database_id`.
     - **Callbacks:** `APP_CALLBACK_URLS` equals the list derived from `publisher.json`
       and holds no placeholder (stable tags).
   - Pack `yaran-cloud-worker-<v>.tar.gz` from the tree **without** `release.json`
     (reproducibly, reusing the `release.yml:189-209` recipe of `SOURCE_DATE_EPOCH`, sort,
     `gzip -n`, a double pack and `cmp`) and write its `.sha256`. Then write `release.json`
     (02 `ReleaseManifest`: `tarball.url` is the release asset URL, `tarball.sha256` the
     hash just written) and validate it against 02's schema. The manifest stays outside the
     tarball because it names the tarball's own hash.
   - The relay bundle comes from `wrangler deploy --dry-run --outdir` plus its config
     template, tarred the same way as `yaran-cloud-relay-<v>.tar.gz`.
   - One `npm sbom --sbom-format cyclonedx --omit dev` per package.
3. **`deploy-branch-rc`** (`-rc.N` tags only; environment `cloud-release`; `needs: build`).
   Release-candidate deploy trees are published here, for 19's staging runs (S02's real
   Deploy button, WI-3's `provision.sh`), never on `cloud-deploy`:
   - Check out the generated branch **`cloud-deploy-rc`** (an orphan branch created on the
     first candidate, never sharing history with `main` or `cloud-deploy`), replace
     `worker/` with the assembled tree plus `release.json`, commit as
     `yaran-cloud-v<x>-rc.<n>: generated from <tag commit sha>`, and push without force.
     Refuse a tag that is not newer, by semver, than the branch's `release.json`.
   - The staging Deploy URL is
     `https://deploy.workers.cloudflare.com/?url=https://github.com/SiavZ/yaran/tree/cloud-deploy-rc/worker`.
     Nothing user-facing names this branch: the README badge and 07's update checker read
     `cloud-deploy` only.
   - The same ruleset as `cloud-deploy` (no force-push, no deletion, pushes restricted to
     this job or the `CLOUD_DEPLOY_KEY` fallback, T52) covers `cloud-deploy-rc`.
   - The tarball, its `.sha256` and `release.json` also reach the prerelease through
     `publish`, as for a stable tag.
4. **`e2e`** (`-rc.N` tags only; slot reserved for 19): `uses: ./.github/workflows/e2e.yml`
   with `needs: deploy-branch-rc`, and `publish` `needs` it on release candidates. 19's PR
   adds the job; until then the slot is a commented block in the workflow.
5. **`publish`:** `_publish-train-release.yml` runs with the expected list of 7 files
   (protocol tarball, Worker tarball and its `.sha256`, relay tarball, three SBOMs). It
   writes `yaran-cloud-checksums.txt` (an exact count with `sha256sum -c`, generalising
   `release.yml:328`), attests provenance on the bundles and SBOMs (`id-token: write`,
   `attestations: write`, publish job only), and creates the release with notes that hold
   the checksums and the `gh attestation verify … --owner SiavZ` line. 07's update job
   verifies the Worker tarball with that attestation (T52).
6. **`deploy-relay`** (stable tags only; environment `push-relay-production`):
   - `wrangler-action` deploys `cloud/push-relay` from the built bundle.
   - A smoke check calls `GET https://<publisher-relay>/healthz` and expects the tag
     version. This is a requirement on 08.
   - **G4 fallback.** When 03 adopted the Container or VM runtime (repository variable
     `RELAY_RUNTIME = worker | container | vm`, a deploy-target selector rather than a user
     setting):
     - `container` uses the same wrangler deploy, which builds the image on the runner.
     - `vm` builds the relay OCI image per 08, pushes it to GHCR (`packages: write`) and
       attests it. The VM pulls it by digest, per the 22 runbook.
7. **`deploy-branch`** (stable tags only; environment `cloud-release`; `needs: publish`):
   publish the generated tree to branch **`cloud-deploy`** (D18, R4):
   - Check out `cloud-deploy` (created as an orphan branch on the first release; it never
     shares history with `main`). Replace `worker/` with the assembled tree plus
     `release.json`, commit as `yaran-cloud-v<x>: generated from <tag commit sha>`, and push
     without force. History is append-only, one commit per stable release.
   - Refuse when the tag is not newer, by semver, than the `release.json` already on the
     branch, so a re-run or an old tag cannot roll the Deploy button back.
   - After the push, fetch
     `https://raw.githubusercontent.com/SiavZ/yaran/cloud-deploy/worker/release.json` (the
     URL 07's checker reads) and compare it with the built file.
   - If G11 records FALLBACK ADOPTED (07 §1: the subdirectory form fails), the same job also
     pushes the tree at the root of `cloud-deploy-root`; that step lands in the PR that
     records the fallback.
   - Release candidates never touch the branch: the Deploy button and the update checker
     see stable releases only. Candidates go to `cloud-deploy-rc` (step 3).
   - **Who may push (T52).** A branch ruleset on `cloud-deploy` blocks force-push and
     deletion and restricts pushes to this job. Whether a ruleset can name the GitHub
     Actions app as the only bypass actor is **UNVERIFIED**; the fallback is a write deploy
     key, `CLOUD_DEPLOY_KEY`, held only in the `cloud-release` environment and named as the
     rule's sole permitted actor.

### Mobile release (`release-mobile.yml`)

```text
check ──▶ android-build ─┬─▶ fdroid-verify ─┐
      └─▶ ios-build ─────┼──────────────────┼─▶ publish (GitHub Release) ─▶ play-internal
                         └──────────────────┘                             └▶ testflight
```

1. **`check`:** `check-versions.mjs` (tag, literals, changelog file, publisher config,
   toolchain targets), then `uses: mobile-ci.yml`. For stable tags it also runs
   `check-association.mjs --live` (T63).
2. **`android-build`** (environment `android-release`):
   - Steps: in `mobile/app`, `npm ci && npm run build && npx cap sync android`, then `assembleFossRelease
     assemblePlayRelease bundlePlayRelease`.
   - **Signing:**
     - The APKs are signed with the app key by `apksigner` 34 (v2 and v3 schemes).
     - The AAB is signed with the upload key.
     - `foss` has `dependenciesInfo` off.
   - The fingerprint is checked against `app-signing-cert.sha256`.
   - `cyclonedxBom` and `npm sbom` run.
   - Outputs: `yaran-mobile-<v>-foss.apk`, `yaran-mobile-<v>-play.apk`, the AAB (not
     published on GitHub), `yaran-mobile-<v>-android-sbom.cdx.json` and
     `yaran-mobile-<v>-js-sbom.cdx.json`.
3. **`fdroid-verify`** (no secrets):
   - Copy `mobile/fdroid/<android-app-id>.yml` into a scratch fdroiddata tree and set
     `commit:` to the tag.
   - Run `fdroid build <appid>:<versionCode>` in `FDROIDSERVER_IMAGE` with a mounted
     Android SDK.
   - `apksigcopier compare` the signed `foss` APK against the unsigned rebuild.
   - Run `fdroid scanner` on the source.
   - A mismatch fails the release. Nothing is published that F-Droid cannot reproduce.
4. **`ios-build`** (environment `ios-release`, `macos-26`): `bundle exec fastlane ios
   build`:
   - `setup_ci`
   - `app_store_connect_api_key(key_content:, is_key_content_base64: true)`
   - `match(type: "appstore", readonly: true, app_identifier: [<bundle>, <bundle>.NotificationService])`
   - `build_app(export_method: "app-store")`
   - The IPA and dSYMs are kept as workflow artifacts only. An IPA is not installable from
     GitHub, so it is not a release asset.
5. **`e2e`** (`-rc.N` tags only; slot reserved for 19): `uses: ./.github/workflows/e2e.yml`;
   `publish` `needs` it on release candidates, exactly as in the cloud train.
6. **`publish`:** `_publish-train-release.yml` with exactly these release assets:
   - the two APKs and the two SBOMs, listed in `yaran-mobile-checksums.txt`
   - the license inventory, also attested
   - provenance attestations on the APKs and SBOMs (the GitHub flavor's update notice
     points users here, T50)
   - the `--prerelease` flag for `-rc.N`, which are public at once
   - `--latest=false` always (R17)
   - for a stable tag, `--draft`: assets, checksums and attestations are final, and 22 makes
     the release public with `mobile-store-promote.yml` `channel: github` when its rollout
     plan says so
   - release notes taken from the changelog, plus the expected certificate fingerprint and
     how to check it with `apksigner verify --print-certs`
7. **`play-internal`:** first `check-versions.mjs --play` (the D23 enrollment gate, work
   item 9) and a check that the AAB's signer certificate equals `upload_cert_sha256` in the
   enrollment record; then `bundle exec fastlane android internal`, which runs
   `upload_to_play_store(track: "internal", aab:, json_key_data:, metadata_path: "../fastlane/metadata/android")`.
8. **`testflight`:** `bundle exec fastlane ios beta`, which runs
   `upload_to_testflight(ipa:, skip_waiting_for_build_processing: true)`.
   - Store uploads run only after `publish` has created the GitHub release with its verified
     assets (a draft for stable tags), so a store never receives a build that the release
     artifacts and F-Droid verification do not match.
9. **`mobile-store-promote.yml`** (dispatch; inputs `channel` (`play | appstore | github`),
   `track` and `rollout_fraction`; environments as above):
   - Play: `check-versions.mjs --play` first, then
     `upload_to_play_store(track_promote_to:, rollout:)`.
   - iOS: `deliver(submit_for_review: true, phased_release: true)`, with metadata from
     `mobile/fastlane/metadata`.
   - GitHub: `gh release edit <tag> --draft=false --latest=false` (no secrets beyond
     `GITHUB_TOKEN` `contents: write` in that job).
   - The policy for when to promote is 22's.
   - F-Droid fetches `Binaries:` from the GitHub release, so its build of a stable tag finds
     no APK while the release is still a draft. Whether F-Droid retries on a later daily
     cycle or marks that version failed is **UNVERIFIED**; 22 work item 8 confirms it with
     fdroiddata and sets the GitHub publish point accordingly.

### F-Droid metadata and recipe

- **Android listing metadata lives at the repo root, in `fastlane/metadata/android/en-US/`.**
  That is the one location F-Droid documents unconditionally. `supply` points at it via
  `metadata_path`.
  - F-Droid reads only the root or `<subdir>/fastlane`. With `subdir: mobile/android/app`,
    that would be the Gradle module, the location F-Droid says "won't work". So the Android
    listing lives at the root. Lanes and iOS `deliver` metadata stay in `mobile/fastlane/`.
    00-README.md's layout now shows exactly this split (`fastlane/metadata/android/`,
    Phase 18), so the earlier layout conflict is resolved.
- **Listing length gate.** `check-versions.mjs --metadata` enforces F-Droid's limits:
  title 50, short description 80, full description 4000, changelog 500. The content is
  21's.
- **Recipe draft.** 21 submits it to fdroiddata; this phase uses it in CI. Path:
  `mobile/fdroid/<android-app-id>.yml`.
  - `RepoType: git` and `Repo: https://github.com/SiavZ/yaran.git`.
  - `Binaries: https://github.com/SiavZ/yaran/releases/download/yaran-mobile-v%v/yaran-mobile-%v-foss.apk`.
  - `AllowedAPKSigningKeys:` the fingerprint above.
  - One `Builds:` entry per version:
    - `subdir: mobile/android/app`
    - `gradle: [foss]`
    - `sudo:` installs Node at the `.node-version` major and build-tools 34
    - `prebuild:` runs `npm ci`, the build and `cap sync android` from `mobile/app/`
  - `AutoUpdateMode: Version`.
  - `UpdateCheckMode: Tags ^yaran-mobile-v[0-9]+\.[0-9]+\.[0-9]+$`, which excludes
    release candidates.
  - **UNVERIFIED (G7):** how F-Droid accepts an npm build tree (`scandelete` of
    `node_modules` versus a srclib) and whether Debian's Node produces a byte-identical
    Vite bundle.
- **Fallback ladder if `fdroid-verify` cannot match.**
  1. Pin Node exactly in the recipe from the official tarball, verified by SHA-256 in
     `prebuild`. Whether F-Droid accepts that prebuilt toolchain is **UNVERIFIED** and is
     part of G7.
  2. Commit the built web assets for `foss` release tags only. **Rejected**: it breaks
     "built from source" and F-Droid's policy.
  3. If G7 fails outright, F-Droid signs with its own key. The recipe then drops
     `Binaries` and `AllowedAPKSigningKeys`, and F-Droid installs cannot upgrade Play or
     GitHub installs, or be upgraded by them. 17's docs say so, and the app's About screen
     names the channel. **This contradicts D14's "F-Droid ships developer-signed
     reproducible builds" and needs a README decision change if it happens.**

### Supply-chain gates

- **`workflow-policy.yml`** (always runs, required, no secrets) runs
  `.github/scripts/check_workflow_policy.sh`. Over every file in `.github/workflows/*.yml`
  it checks:
  1. every `uses:` is a local path or `owner/repo@<40-hex> # v…`
  2. a top-level `permissions:` block exists
  3. no `pull_request_target`
  4. no `secrets: inherit`
  5. new-train release workflows contain `--latest=false`
  6. no workflow other than `release-cloud.yml` pushes to `cloud-deploy`,
     `cloud-deploy-rc` or `cloud-deploy-root`, and no workflow names `cloud-stable`

  It then runs pinned, checksummed `actionlint`.
- **Dependabot** (weekly, Monday, limit 5, `patches` group as today):
  - `npm` with `directories: ["/cloud/*", "/mobile/app", "/mobile/plugins/*", "/packages/ui-kit", "/tools/release-trains"]`
    (this one entry absorbs the `/cloud/protocol` entry 02 WI-11 adds)
  - `gradle` at `/mobile/android`
  - `bundler` at `/mobile`
  - `swift` at the SwiftPM manifest directory, only if 14 adds remote SwiftPM packages;
    Capacitor's own iOS packages arrive through npm and are covered there
  - The existing `github-actions` entry already covers the new workflows.
- **CODEOWNERS** lines, owner `@SiavZ` as today:
  - `/cloud/`, `/mobile/`, `/fastlane/`
  - `/tools/release-trains/`, `/.node-version`, `/mobile/toolchain.env`
  - `/publisher.json`, `/publisher-site/` (association files, T63)
  - `/mobile/android/signing/`, `/mobile/android/gradle/verification-metadata.xml`
  - `/mobile/Gemfile.lock`, `/mobile/fdroid/`, and `wrangler.*` under `/cloud/`
- **Gradle.** Wrapper validation runs on every Android job. `verification-metadata.xml`
  is regenerated in dependabot PRs by a maintainer, so the diff is reviewed.

## Work items

Every new script or code file carries the 00-CONVENTIONS §2 header and is checked by
`module-headers` when in scope. `tools/release-trains/` and `.github/scripts/*` are added
to 01's opt-in manifest in this phase.

1. **Release-train tooling.**
   - **Create in `tools/release-trains/`:**
     - `versions.mjs` (parse a tag, compute versionCode, validate bounds)
     - `check-versions.mjs` (CLI: tag ↔ literals, toolchain targets, `--publisher`,
       `--metadata`, `--play`)
     - `bump.mjs` (CLI: write literals and a changelog stub)
     - `check-deploy-tree.mjs` (self-containment, wrangler-config and callback checks on
       the generated tree; `--config-only` for `cloud/worker` on PRs)
     - `check-association.mjs` (committed association files vs signing cert and
       identifiers; `--live` fetch and compare)
     - `license-allowlist.mjs` (`deny.toml` → npm and jk1 formats)
     - `swiftpm-licenses.mjs`
     - `package.json` (dev-only: `license-checker-rseidelsohn@5.0.1`, locked)
     - `test/*.test.mjs`
   - **Reuse:** the `release.yml:61-71` semver regex semantics, and the
     `build_npm_package.mjs` style.
   - **Tests** (`node --test`):
     - versionCode for `1.2.3`, `1.2.3-rc.1` < `1.2.3`, and `1.3.0-rc.1` > `1.2.99`
     - rejection of `Y=100`, `N=99` and overflow
     - pbxproj with mismatched NSE versions failing
     - placeholder detection, including `publisher.json` and its disagreement with 14's
       publisher config
     - listing over-length detection
     - `deny.toml` parse equal to the 18-entry list at `deny.toml:70-96`
     - deploy tree: a fixture tree with a `file:../protocol` dependency fails; one with
       `workers_dev: false`, `preview_urls: true`, a `routes` entry or a custom domain fails;
       a placeholder `APP_CALLBACK_URLS` fails for a stable tag; the clean fixture passes
     - `release.json` written for a fixture tarball validates against 02's schema and names
       that tarball's hash
     - association files: wrong fingerprint, wrong package, missing `/auth/callback` path and
       a redirecting `--live` response (local HTTP fixture server) each fail
     - `--play`: no enrollment record, a placeholder record, and an app fingerprint that
       differs from `app-signing-cert.sha256` each fail
2. **Protect the binary pipeline (R17).**
   - **Touch:**
     - `.github/workflows/release.yml`: the `prepare` job `if:` only.
     - `install.sh` `resolve_version`: prefix filter and list fallback.
     - `.github/workflows/install-script-ci.yml`: add the new test to its paths and steps.
   - **Create:** `.github/scripts/test_install_resolve_version.sh`. This is an offline test
     with fixture JSON:
     - latest equal to `yaran-mobile-v1.0.0` must resolve to the newest `yaran-v*`
     - only prereleases resolves to the newest matching prerelease
     - no matching release at all fails with the existing error text
3. **Workflow policy.**
   - **Create:**
     - `.github/workflows/workflow-policy.yml`
     - `.github/scripts/check_workflow_policy.sh`
     - `.github/scripts/test_check_workflow_policy.sh`, which runs fixture workflows for
       each violation
   - **Tests:** each rule has a failing fixture and a passing fixture, and the current
     seven workflows pass.
4. **CI suites.**
   - **Create:** `.github/workflows/cloud-ci.yml`, `mobile-ci.yml`,
     `_mobile-android-ci.yml`, `_mobile-ios-ci.yml` and `ui-kit-ci.yml`.
   - **Touch:** `.github/workflows/gates.yml` (01's seam block, filters, `needs`,
     `allowed-skips`, the `cloudflared` job, `.node-version`) and 02's
     `.github/workflows/cloud-protocol.yml` (`.node-version`, npm audit and license steps).
   - **Tests:** a throwaway PR per suite proving that it runs on a matching change, that it
     is skipped yet `Required gates` stays green on a docs-only change, and that a failing
     unit test turns `Required gates` red. For the `cloudflared` job, a throwaway PR that
     corrupts the SHA-256 row in `pins.rs` must fail it, and a second run must hit the cache.
5. **Toolchain and build hardening.**
   - **Create:**
     - `.node-version`
     - `mobile/toolchain.env`
     - `mobile/android/gradle/verification-metadata.xml` (generated, marked generated)
     - `mobile/android/config/license-normalizer.json`
     - `mobile/android/signing/app-signing-cert.sha256`, holding the placeholder until work
       item 9's ceremony
     - `publisher.json` with the `<publisher-domain>` placeholder and an inline description
       of what reads it
   - **Touch:** 14's Gradle files, minimal lines only:
     - the `org.cyclonedx.bom` and jk1 plugins
     - `dependenciesInfo { includeInApk = false; includeInBundle = true }` for `foss`
     - signing configs reading environment variables
     - baseline-profile tasks disabled for `foss` release, if 14 enables them; the snippet
       is UNVERIFIED and is proven by the reproducibility job
   - **Touch also:** `CONTRIBUTING.md`, one line about `.node-version`; `check-versions.mjs`
     fails if any `.nvmrc` appears under `mobile/` (one Node pin; 14 creates none).
   - **Tests:** the double-build `cmp` job, and the fingerprint check (it must fail against
     a debug-signed APK).
6. **Fastlane.**
   - **Create:**
     - `mobile/Gemfile` and `mobile/Gemfile.lock`
     - `mobile/fastlane/Appfile` and `Matchfile`, using D16 placeholders
     - `mobile/fastlane/Fastfile`, which imports `lanes/android.rb` (`internal`,
       `promote`) and `lanes/ios.rb` (`build`, `beta`, `submit`)
     - `fastlane/metadata/android/en-US/` with placeholder text files, marked for 21
   - **Tests:** `bundle exec fastlane lanes` in CI, and
     `upload_to_play_store(validate_only: true)` in a dispatch dry run before the first
     real release. The dry run uploads a bundle into an uncommitted edit, so it runs only
     after work item 9's enrollment and starts with `check-versions.mjs --play` (D23).
7. **Release workflows.**
   - **Create:**
     - `.github/workflows/release-cloud.yml`
     - `release-mobile.yml`
     - `_mobile-android-release.yml`, `_mobile-ios-release.yml`, `_fdroid-verify.yml`
     - `_publish-train-release.yml`
     - `mobile-store-promote.yml`
     - `fdroid-watch.yml`
     - `cloudflared-pin-watch.yml`
     - `mobile/fdroid/<android-app-id>.yml`
   - **Reuse:**
     - the reproducible-tar recipe `release.yml:189-209`
     - the checksum and `sha256sum -c` pattern `release.yml:301-353`, with the hard-coded 4
       replaced by an input list
     - the attestation step `release.yml:254-261`, with the same pinned SHA
     - 07's `assemble-deploy-tree.ts` (run, never re-implemented)
   - **Tests:**
     - An `-rc.1` rehearsal tag of each train on the real repo produces a prerelease that
       is not "latest", and leaves `cloud-deploy` untouched; the cloud rehearsal pushes its
       tree to `cloud-deploy-rc` under `worker/` before `e2e` starts, and an older candidate
       tag is refused without pushing.
     - The first stable cloud tag creates `cloud-deploy` with the tree under `worker/`; the
       raw `release.json` URL serves the built manifest; re-running the job, or pushing an
       older stable tag, refuses without pushing; a Deploy-button deploy from
       `…/tree/cloud-deploy/worker` succeeds on a scratch account (with 07, G11).
     - A stable mobile tag leaves a draft release; `mobile-store-promote.yml`
       `channel: github` publishes it and it is still not "latest".
     - `cloudflared-pin-watch.yml` opens an issue when run against 10's recorded stale
       fixture, and only one on a second run.
     - `install-script-ci`'s `latest` leg stays green afterwards.
     - `gh attestation verify` passes on every asset.
     - The Play internal track and TestFlight each receive the build.
     - `fdroid-verify` passes.
8. **Repository policy docs.**
   - **Touch:**
     - `.github/BRANCH_PROTECTION.md`:
       - required: `Workflow policy` (beside 01's `Required gates`)
       - tag protection: `yaran-cloud-v*` and `yaran-mobile-v*`
       - branch rule for `cloud-deploy` and `cloud-deploy-rc` (and `cloud-deploy-root` if
         G11's fallback is adopted): only the `cloud-release` job may push, no force-push,
         no deletion
       - the four environments, their reviewers and deployment-branch rule (tags matching
         the train only)
     - `.github/CODEOWNERS`
     - `.github/dependabot.yml`
   - **Create:** `docs/operations/release-trains.md`, covering:
     - trains, tags, `--latest=false`
     - the secret inventory and custody (above)
     - the one-time setup checklist (this phase executes the Android signing part, work
       item 9; 21 executes the rest)
     - how to cut each release, and what `cloud-deploy` is and who writes it
     - how to verify artifacts
   - **Tests:** `check_workflow_policy.sh` asserts that `BRANCH_PROTECTION.md` names every
     environment used in a workflow.
9. **Android app-signing key and Play App Signing enrollment (D23; before any Play
   upload).**
   - **Preconditions.** The publisher's Play Console organization account exists (D-U-N-S
     can take up to 28 days, so it is opened on the first day of Wave B; 21 records it in
     `publisher-infrastructure.md`). The real `applicationId` is committed in 14's
     `mobile/publisher.properties`, because Play binds the key to the package name for good.
   - **Ceremony** (an offline machine, two maintainers present, steps in
     `docs/operations/release-trains.md`):
     - generate the app-signing key with `keytool -genkeypair`: RSA 4096, validity of 30
       years or more (ending well after 2033-10-22);
     - generate the separate upload key the same way;
     - write two encrypted offline backups of the app key, one per holder.
   - **Enroll.** Create the app record for the package in Play Console, choose "use your own
     key" under Play App Signing, export the app key with PEPK, upload it, and register the
     upload certificate. All of this happens before any bundle is uploaded on any track,
     internal included. Nothing in this work item uploads an AAB.
   - **Record.** Commit the real `mobile/android/signing/app-signing-cert.sha256`
     (replacing the placeholder) and `mobile/android/signing/play-enrollment.json`
     `{package, app_signing_cert_sha256, upload_cert_sha256, enrolled_at, enrolled_by}`.
     The PR carries a screenshot of Play Console's App signing page showing the same
     SHA-256. Load both keystores and their passwords into the `android-release`
     environment.
   - **Gate in code.** `check-versions.mjs --play` fails unless `play-enrollment.json`
     exists, holds no placeholder, and its app fingerprint equals `app-signing-cert.sha256`.
     `play-internal`, the Play channel of `mobile-store-promote.yml` and the `validate_only`
     dry run (work item 6) all run it first, so no workflow can reach Play before
     enrollment. 19 and 21 never upload to Play by hand (they consume this phase's
     workflows).
   - **Tests:** the `--play` fixtures (work item 1); after enrollment,
     `apksigner verify --print-certs` on a locally app-key-signed `foss` APK prints the
     committed SHA-256, and `keytool -printcert -jarfile` on an upload-signed AAB prints
     `upload_cert_sha256`.

## Acceptance

- [ ] A docs-only PR shows `Required gates` and `Workflow policy` green with cloud and
      mobile skipped. A PR that touches `cloud/worker` or `mobile/android` runs the suite,
      and a failing test there blocks the merge.
- [ ] `yaran-cloud-v<x>-rc.1` and `yaran-mobile-v<x>-rc.1` rehearsals publish prereleases
      that are not marked latest. `release.yml` does not run or is skipped, and
      `install.sh` with no version still installs the newest `yaran-v*`.
- [ ] The mobile release attaches exactly the listed assets with a matching
      `yaran-mobile-checksums.txt`. Every asset passes `gh attestation verify --owner SiavZ`,
      and both APKs report the committed certificate fingerprint.
- [ ] `fdroid-verify` reproduces the `foss` APK from source (apksigcopier compare passes),
      or G7's fallback has been adopted with the README decision updated.
- [ ] The Play internal track holds the AAB and TestFlight holds the build, both uploaded
      only after the GitHub release was created.
- [ ] The Android app-signing key was generated and enrolled in Play App Signing before
      the first upload of anything to Play (D23). `play-enrollment.json` and
      `app-signing-cert.sha256` are committed and agree with Play Console, and every Play
      upload path runs `check-versions.mjs --play` first.
- [ ] The first stable `yaran-cloud-v*` tag publishes the self-contained tree to
      `cloud-deploy` under `worker/` with a schema-valid `release.json`; the tree builds in
      isolation, ships `workers_dev: true`, `preview_urls: false` and no custom domain or
      route; release candidates never touch the branch; nothing on `main` holds a vendored
      protocol copy or a drift check for one.
- [ ] Stable mobile releases are drafts until `mobile-store-promote.yml` `channel: github`
      publishes them, never "latest"; stable mobile releases are refused while the live
      association files disagree with the committed ones (T63).
- [ ] The `cloudflared` CI job verifies and caches the pinned binary and runs 10's
      real-binary test; `cloudflared-pin-watch.yml` runs weekly.
- [ ] `publisher.json` is the only place the publisher domain is written; `--publisher`
      refuses an official release while it holds the placeholder or disagrees with 14's
      publisher config.
- [ ] The relay deploy runs only after a required-reviewer approval, and `/healthz`
      reports the tag version.
- [ ] npm audit, license (npm and Gradle, from `deny.toml`), Gradle wrapper validation and
      dependency verification all gate CI. Dependabot opens PRs for npm (cloud, mobile,
      tools), Gradle and bundler.
- [ ] No workflow contains `pull_request_target` or an unpinned action. No CI suite
      references a secret.
- [ ] Every new file is at or under 500 lines and passes `module-headers --check` where in
      scope.

## Validation

```bash
node --test tools/release-trains/test
bash .github/scripts/test_check_workflow_policy.sh && bash .github/scripts/check_workflow_policy.sh
bash .github/scripts/test_install_resolve_version.sh && bash .github/scripts/test_install_checksum.sh
actionlint .github/workflows/*.yml
grep -nE 'uses: ' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40} # v|uses: \./' && exit 1 || true
grep -n 'pull_request_target' .github/workflows/*.yml && exit 1 || true
grep -n -- '--latest=false' .github/workflows/_publish-train-release.yml
node tools/release-trains/check-versions.mjs yaran-mobile-v1.0.0-rc.1 --dry-run
node tools/release-trains/check-versions.mjs --play                        # fails until work item 9 is done
node tools/release-trains/check-deploy-tree.mjs --config-only cloud/worker
node tools/release-trains/check-association.mjs                            # committed files vs cert and ids
grep -rn 'cloud-stable' .github/ docs/operations/ && exit 1 || true
git ls-remote origin refs/heads/cloud-deploy                              # after the first stable cloud tag
curl -fsS https://raw.githubusercontent.com/SiavZ/yaran/cloud-deploy/worker/release.json | jq -e '.train == "yaran-cloud"'
bash tools/cloudflared-pin/bump.sh --check
cd mobile/android && ./gradlew assembleFossRelease && cp app/build/outputs/apk/foss/release/*.apk /tmp/a.apk \
  && ./gradlew clean assembleFossRelease && cmp /tmp/a.apk app/build/outputs/apk/foss/release/*.apk
gh attestation verify yaran-mobile-1.0.0-rc.1-foss.apk --owner SiavZ     # after the rehearsal
apksigner verify --print-certs yaran-mobile-1.0.0-rc.1-foss.apk | grep -f mobile/android/signing/app-signing-cert.sha256
```

## Risks

| Risk | Mitigation |
|---|---|
| A new-train release becomes "latest" and breaks the default install | `--latest=false` enforced by policy check; `install.sh` prefix filter; `release.yml` guard |
| Node/Vite output differs between CI and the F-Droid buildserver (G7) | Release blocked on `fdroid-verify`; weekly drift watch; Node-pin and F-Droid-signed fallbacks spelled out |
| Signing key loss or leak (D14, T46) | Offline backups with two holders; environment-scoped secrets with reviewers; fingerprint check; upload key separate and resettable |
| Play keeps a Google-generated key because something was uploaded before enrollment (D23) | Work item 9 enrolls before any upload; `check-versions.mjs --play` gates every Play path in code, the `validate_only` dry run included; 19 and 21 never upload by hand |
| D23 pulls the Play organization account (and its D-U-N-S wait, up to 28 days) into Wave B | Open the account on the first day of Wave B; the mobile train's Play legs wait for work item 9, everything else proceeds |
| A push to `cloud-deploy` from anything but the release job changes every new org's Deploy (T52) | Branch ruleset (no force, no deletion, one permitted actor), environment reviewer on `cloud-release`, workflow-policy rule 6, append-only history, semver refusal of older tags |
| The generated tree silently depends on the monorepo (works in CI, fails for deployers) | Isolated build in an empty directory outside the checkout on every stable tag, plus G11's real Deploy-button run against `…/tree/cloud-deploy/worker` |
| Association files on `<publisher-domain>` drift from the signing key (T63) | `check-association.mjs --live` gates stable mobile releases; 22 runs it daily |
| `match` repo or ASC key misconfigured | `readonly` match; dispatch dry run; Xcode cloud signing kept as UNVERIFIED alternative only |
| macOS runner image changes Xcode set | Pinned `XCODE_APP` path in `toolchain.env`; job fails loudly if missing |
| Kotlin DSL `versionCode` not scraped by F-Droid | G7 checks; Groovy app module fallback with 14 |
| jk1 license names do not map to SPDX | Normalizer file; first run tunes it; failures are loud, never ignored |
| Environment secrets and reviewer gate with a single maintainer | Reviewer gate still forces a deliberate approval click; documented in `BRANCH_PROTECTION.md` |
| Relay APNs from Worker stops working (G4) | `RELAY_RUNTIME` switch to Container/VM deploy path already specified |

## References

- research/R3-repo-process.md §1, §2, §9, Implications 2-4; research/R5-mobile.md §4, §7, "Store-policy risks"
- 00-README.md D8, D14, D15, D16, D18, D19, D23; 01-conventions-and-enforcement-tooling.md §Scope, §CI; 02-protocol-contract.md §8 (redirect allowlist, `APP_CALLBACK_URLS`), `ReleaseManifest`, WI-11; 03-platform-verification-gates.md G4, G5, G7, G11, G14; 07-worker-setup-admin-and-deploy.md §1, §2, §7; 10-yaran-cloudflared-leg.md (pins, `bump.sh`, real-binary test); 14-mobile-app-foundation.md (publisher config, `licenses.sh`, `verifyFossDependencies`); 16-mobile-push-clients.md; 19-integration-and-end-to-end-verification.md (`e2e.yml`); 17-docs-website-threat-model.md T29, T46, T50, T52, T63
- `.github/workflows/release.yml:3-8, :61-71, :93-96, :189-209, :254-261, :286, :301-353`; `install.sh:263-300, :332-346`; `.github/workflows/install-script-ci.yml:40-53`; `.github/workflows/website-ci.yml:95`; `.github/BRANCH_PROTECTION.md:20-29, :45, :53-54`; `.github/CODEOWNERS:8, :23-29`; `.github/dependabot.yml:12-42`; `deny.toml:70-96`; `CONTRIBUTING.md:12`
- https://docs.fastlane.tools/actions/upload_to_play_store/ ; /upload_to_testflight/ ; /app_store_connect_api_key/ ; /match/ ; /setup_ci/ (2026-11-14)
- https://developer.android.com/studio/publish/app-signing ; https://support.google.com/googleplay/android-developer/answer/9842756
- https://f-droid.org/docs/Reproducible_Builds/ ; https://f-droid.org/docs/Build_Metadata_Reference/ ; https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/ ; https://gitlab.com/fdroid/docker-executable-fdroidserver
- https://github.com/actions/runner-images ; https://developer.apple.com/news/upcoming-requirements/
- https://github.com/actions/attest-build-provenance/releases ; https://github.com/cloudflare/wrangler-action/releases ; https://github.com/CycloneDX/cyclonedx-gradle-plugin ; https://github.com/jk1/Gradle-License-Report ; https://docs.npmjs.com/cli/v11/commands/npm-sbom
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments ; https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories ; https://github.com/nodejs/Release

## Reconciliation notes (2026-11-14)

- Header: Depends on names 02's `ReleaseManifest` and §8, gates G11 and G14, and the Wave B code-level seams (07, 10, 14); Blocks is 19 with the Wave C chain stated (R20).
- Goal, Evidence, In scope: the `cloud-deploy` branch (D18), workers.dev/`preview_urls` facts (D19), the callback injection (02 §8), D23, 10's and 19's hand-offs recorded (R4, R5, R13, R20).
- Cloud release: `deploy-ref` fast-forwarding `cloud-stable` replaced by `deploy-branch`, which publishes 07's assembled self-contained tree to `cloud-deploy` (append-only, semver refusal, ruleset with UNVERIFIED actor and deploy-key fallback); `build` runs the assembler and `check-deploy-tree.mjs`; `release.json` written outside the tarball; expected file list 6 → 7 (R4, T52).
- CI suites: `cloud-ci` drops `cloud/protocol` (02's `cloud-protocol.yml` owns it, WI-11) and its codegen-drift step; states there is no vendored-copy drift check on `main`; adds the wrangler-config check (`workers_dev: true`, `preview_urls: false`, no custom domain or route) (R4, R5).
- Signing: this phase now generates the Android app-signing and upload keys and enrolls Play App Signing before any Play upload (new work item 9); `check-versions.mjs --play` gates `play-internal`, Play promotion and the `validate_only` dry run (R13, D23).
- Release guards: labelled as owned here, documented by 17 (R17); mobile stable releases are drafts with `--latest=false`, published by `mobile-store-promote.yml` `channel: github` so 22's GitHub stage needs no "latest" (R17; F-Droid draft interaction marked UNVERIFIED for 22 WI-8).
- Publisher values: new `publisher.json` as the one home of the publisher domain, feeding `APP_CALLBACK_URLS`, yaran's `[cloud] app_callback_urls` default and the app checks (02 §8, D16; new design, owned here).
- Association files: `check-association.mjs` and a `--live` gate on stable mobile tags (T63, R2).
- cloudflared: `cloudflared` CI job with cached, hash-verified pinned binary and `cloudflared-pin-watch.yml`, both asked for by 10 (T29, R21: minimum 2026.11.0).
- `e2e` stage reserved in both release workflows for 19 (R20).
- Pins: `ANDROID_TARGET_SDK=36`, `IOS_DEPLOYMENT_TARGET=17.4` checked against 14's projects; one Node pin (`.node-version` 24; 14's `mobile/app/.nvmrc` deleted); Capacitor `~8.6.2` and the 9 upgrade attributed to 14 work item 14 (R21).
- Paths: `mobile/package.json` → `mobile/app/package.json`; F-Droid `prebuild` and dependabot use `mobile/app`; the README layout conflict on `fastlane/metadata/android/` is recorded as resolved (R20).
- Classpath guard names 14's `verifyFossDependencies`; `mobile-ci` runs 14's `licenses.sh --check` (R20).
- Out of scope: 21 row no longer generates Android keys; 10 and 19 rows added; 17 row lists T29, T46, T50, T52, T63 (R13, R14).
- Risks, Acceptance, Validation, References extended for D23, `cloud-deploy`, T63 and cloudflared; nothing removed.

### Straggler pass (2026-11-14)

- Straggler pass: Node pin text says 14 creates no `.nvmrc` and keeps `engines` `>=22.12`; work item 5 has `check-versions.mjs` refuse any `.nvmrc` under `mobile/` instead of deleting one (R21).
- Straggler pass: new `ui-kit-ci.yml` suite (14's commands) fills 01's `ui-kit` seam job; added to work item 4 and the seam fill (R18). `cloud-protocol.yml` stays 02's; 18 only adds steps to it (verified, no duplicate).
- Straggler pass: release-candidate deploy trees: new `deploy-branch-rc` job pushes RC trees to the generated `cloud-deploy-rc` branch before `e2e` (19's S02/WI-3); ruleset, workflow-policy rule 6, environment, branch docs and rehearsal test updated; later cloud steps renumbered 5–7; "never `cloud-stable`" phrasing dropped from step 7 (R4, R20).

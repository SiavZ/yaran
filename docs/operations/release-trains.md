# Release trains: cloud and mobile

Maintainer-facing. This page covers the two release trains the phone app added
(D15), the secrets they use and who holds them, the one-time Android signing
ceremony (D23), and how to check what a release published. The binary train
(`yaran-vX.Y.Z`, `release.yml`) is unchanged and not covered here.

## Trains and tags

| Train | Tag | Workflow | Publishes |
|---|---|---|---|
| Binary | `yaran-vX.Y.Z` | `release.yml` | the `yaran` archives (unchanged) |
| Cloud | `yaran-cloud-vX.Y.Z[-rc.N]` | `release-cloud.yml` | protocol, Worker and relay bundles; the `cloud-deploy` branch; the production relay |
| Mobile | `yaran-mobile-vX.Y.Z[-rc.N]` | `release-mobile.yml` | signed APKs on GitHub, the Play internal track, TestFlight |

- Only `-rc.N` prereleases exist, with `1 <= N <= 98`.
- The cloud and mobile trains start on the **tag push**. The workflow creates the
  GitHub release itself with `--latest=false`, plus `--prerelease` for a candidate.
  Do not create these releases by hand. If one is created by hand anyway,
  `release.yml` skips it, because its tag is not `yaran-v*` or `dux-amq-v*`.
- A new-train release is never "latest". `install.sh` with no version resolves
  the newest `yaran-v*` release whatever GitHub calls latest, and the
  `Workflow policy` check fails any new-train release command missing
  `--latest=false`.
- A stable mobile release is created as a **draft**: its assets, checksums and
  attestations are final, but it is not public. Run `mobile-store-promote.yml`
  with `channel: github` to publish it.

### Version numbers

`tools/release-trains/versions.mjs` parses a tag and derives every number from it.

- The Android `versionCode`, and the iOS `CFBundleVersion` with it, is
  `X*1000000 + Y*10000 + Z*100 + (N for -rc.N, 99 for a stable release)`.
  Release candidates therefore sort below their release, and `Y` and `Z` are at
  most 99.
- `CFBundleShortVersionString` (`MARKETING_VERSION`) is `X.Y.Z`.
- Gradle `versionName`, `mobile/app/package.json` and every `cloud/*/package.json`
  carry the full version, `-rc.N` included.

The versions are written into the files themselves, because F-Droid reads them
without running the build and Xcode reads them from the project.

## Cutting a release

1. On a branch, run `node tools/release-trains/bump.mjs <tag>`. For the mobile
   train it writes the Gradle literals, both versions in every `project.pbxproj`
   target (App and NotificationService alike), `mobile/app/package.json`, and a
   changelog stub at `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`.
   For the cloud train it writes each `cloud/*/package.json`.
2. For a mobile release, replace the changelog stub with the real notes (500
   characters at most). They become the Play notes, the F-Droid notes and the top
   of the GitHub release notes.
3. Run `node tools/release-trains/check-versions.mjs <tag>`, adding `--publisher`
   for a stable tag and `--metadata` for a mobile tag. Merge the PR once it passes.
4. Tag the merge commit on `main` with an **annotated** tag and push the tag:
   `git tag -a yaran-cloud-v1.2.0 -m "yaran cloud 1.2.0" && git push origin yaran-cloud-v1.2.0`.
   A cloud tag message may carry two trailers, which are copied into `release.json`:
   - `Min-Update-From: 1.0.0`: the oldest org Worker that may update straight to
     this release (default `0.0.0`).
   - `Security: true`: marks a security release for the update checker (default
     `false`).
5. Approve the environment deployments when GitHub asks. Every job that touches a
   secret or a public branch waits for a maintainer.

The first job of both workflows is `check-versions.mjs`, so a tag that disagrees
with the committed literals fails before anything is built.

## The cloud train

1. **check**: the literals, plus the publisher domain on stable tags. Then the
   cloud and protocol CI suites.
2. **build**:
   - The protocol tarball, attached to the release only. There is no npm package.
   - Phase 07's assembler (`npm run assemble-deploy-tree` in `cloud/worker`) writes
     the self-contained deploy tree, with `cloud/protocol` vendored at
     `vendor/cloud-protocol/` and `APP_CALLBACK_URLS` derived from `publisher.json`.
   - `check-deploy-tree.mjs --isolated-build` then copies the tree outside the
     checkout and builds it there. It also checks that the tree has
     `workers_dev: true`, `preview_urls: false`, no route or custom domain, no D1
     `database_id`, and the correct callback.
   - The Worker and relay tarballs are packed twice and compared, like the binary
     archives. `release.json` is written next to the tree rather than inside the
     Worker tarball, because it names the tarball's hash; the assembler's own
     `--write-manifest` writes it, so the tarball is named
     `yaran-cloud-worker-v<version>.tar.gz` (every cloud asset carries the `v`).
   - The assembler refuses the `<publisher-domain>` placeholder, so a release
     candidate needs the real domain in `publisher.json` too.
3. **Release candidates**: `deploy-branch-rc` appends the tree to the
   `cloud-deploy-rc` branch, and the release is published as a prerelease.
   Phase 19's staging runs use
   `https://deploy.workers.cloudflare.com/?url=https://github.com/SiavZ/yaran/tree/cloud-deploy-rc/worker`.
4. **Stable tags**:
   - The release is published.
   - The production relay is deployed after a reviewer approves the
     `push-relay-production` environment. A smoke check then expects
     `GET <relayUrl>/v1/meta` to answer as the relay with this release's protocol
     range (the relay has no `/healthz` and does not report its version).
   - The tree is appended to `cloud-deploy` under `worker/`.
   - The job then waits until
     `https://raw.githubusercontent.com/SiavZ/yaran/cloud-deploy/worker/release.json`
     serves the file it built.

### What `cloud-deploy` is and who writes it

`cloud-deploy` is a generated orphan branch. It shares no history with `main`
and holds one commit per stable release, each holding the deploy tree under
`worker/`.

- The Deploy to Cloudflare button builds from `…/tree/cloud-deploy/worker`.
- Every org Worker's update checker reads `worker/release.json` on this branch.
- Only `release-cloud.yml` writes it, through `.github/scripts/publish_deploy_branch.sh`.
  The script refuses any tag that is not newer, by semver, than the
  `release.json` already on the branch, and it pushes without force. A re-run or
  an old tag therefore cannot roll every new org's deploy back.
- The branch ruleset in `.github/BRANCH_PROTECTION.md` blocks force pushes and
  deletion, and restricts pushes to that job.
- `cloud-deploy-rc` is the same for release candidates. Nothing user-facing names it.

The relay runtime is chosen by the repository variable `RELAY_RUNTIME`:

- `worker` (the default when unset) and `container` deploy with wrangler.
- `vm` builds the relay image from `cloud/push-relay/container/Dockerfile`,
  pushes it to `ghcr.io/siavz/yaran/push-relay:<version>`, and attests it. The VM
  pulls the image by digest.

This variable is a deploy-target selector for gate G4, not a user setting.

## The mobile train

```text
check ──▶ CI ──▶ android-build ─┬─▶ fdroid-verify ─┐
              └▶ ios-build ─────┴──────────────────┴─▶ assets ─▶ publish ─┬─▶ play-internal
                                                                          └─▶ testflight
```

- **check**: the literals, toolchain targets, listing lengths, and on stable tags
  the publisher config and `check-association.mjs --live`. The live check fails
  while the association files served from the publisher domain differ from the
  committed ones in `publisher-site/.well-known/` (T63).
- **android-build** (`android-release` environment):
  - Gradle builds unsigned.
  - Both APKs are signed with the app-signing key by `apksigner` from build-tools
    34, using the v2 and v3 schemes.
  - The AAB is signed with the upload key.
  - `check_apk_cert.sh` refuses any APK whose one signer is not the fingerprint in
    `mobile/android/signing/app-signing-cert.sha256`.
- **fdroid-verify**:
  - Rebuilds the foss APK with the pinned fdroidserver image from the recipe
    draft in `mobile/fdroid/`.
  - Then runs `apksigcopier compare` against the signed APK. A mismatch fails the
    release.
- **ios-build** (`ios-release` environment): runs `fastlane ios build`. The IPA
  and dSYMs stay workflow artifacts.
- **publish**:
  - Attaches exactly five assets: the foss and play APKs, the Android and JS
    SBOMs, and the license inventory.
  - Also attaches `yaran-mobile-checksums.txt` and a provenance attestation for
    each file.
- **play-internal**: runs `check-versions.mjs --play` (the D23 gate), checks that
  the AAB's signer is the enrolled upload key, then runs `fastlane android internal`.
- **testflight**: runs `fastlane ios beta`.

Both store uploads run only after the GitHub release exists. Promotion beyond
the internal track and TestFlight is `mobile-store-promote.yml`, which Phase 22
operates.

## Secrets and who holds them

Every secret is an **environment** secret. Each environment has required reviewers
(see `.github/BRANCH_PROTECTION.md`). CI suites use no secrets at all, and fork PRs
never receive any.

| Environment | Secret | What it is |
|---|---|---|
| `android-release` | `ANDROID_APP_SIGNING_KEYSTORE_B64` | base64 of the app-signing keystore (the one D14 key) |
| | `ANDROID_APP_SIGNING_STORE_PASSWORD`, `ANDROID_APP_SIGNING_KEY_ALIAS`, `ANDROID_APP_SIGNING_KEY_PASSWORD` | its passwords and alias |
| | `ANDROID_UPLOAD_KEYSTORE_B64` | base64 of the Play upload keystore |
| | `ANDROID_UPLOAD_STORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_KEY_PASSWORD` | its passwords and alias |
| | `PLAY_SERVICE_ACCOUNT_JSON` | Play Developer API service account (upload and promote) |
| | `PLAY_GOOGLE_SERVICES_JSON` | only if gate G5 adopted its Firebase fallback; `play` flavor only |
| `ios-release` | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_B64` | App Store Connect Team API key (App Manager role; the minimum role is UNVERIFIED) |
| | `MATCH_PASSWORD`, `MATCH_GIT_URL`, `MATCH_GIT_BASIC_AUTHORIZATION` | fastlane match certificate repository |
| `push-relay-production` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | "Edit Cloudflare Workers" token scoped to the publisher account |
| `cloud-release` | `CLOUD_DEPLOY_KEY` | only if the ruleset fallback is needed (see BRANCH_PROTECTION.md) |

- The APNs `.p8` never enters GitHub. A maintainer sets it once in the relay with
  `wrangler secret put` (D11).
- Rotation:
  - Reset the upload key in Play Console; the app key never changes.
  - Revoke and reissue the ASC key.
  - For match, run `fastlane match nuke` and regenerate.
  - For a Cloudflare token, roll it in the dashboard and update the secret.
  - APNs key rotation is a Phase 22 runbook item.
- A leaked or lost key follows the compromise playbook (Phase 20, T46).

## One-time setup checklist

Phase 18 runs the Android signing steps. Phase 21 runs the rest and records them in
its publisher-infrastructure record.

- [ ] The tag rules, the `cloud-deploy*` branch ruleset and the five environments in
      `.github/BRANCH_PROTECTION.md`.
- [ ] `Workflow policy` and `Required gates` added as required checks after both
      have reported once on `main`.
- [ ] `publisher.json` holds the real publisher domain, and `mobile/publisher.properties`
      holds the real `appId`, team id and relay URL. `check-versions.mjs --publisher`
      refuses every official release until then.
- [ ] Android signing ceremony and Play App Signing enrollment (below), before
      anything is uploaded to Play.
- [ ] iOS identifiers, distribution certificate and match repository; the ASC Team
      key loaded into `ios-release`.
- [ ] The Cloudflare token loaded into `push-relay-production`; the APNs key set on
      the relay.
- [ ] Association files committed under `publisher-site/.well-known/` and served from
      the publisher domain.
- [ ] `mobile/android/gradle/verification-metadata.xml` generated and committed. Generate
      it on Linux (`./gradlew --write-verification-metadata sha256` over the Android CI
      task list), because aapt2 resolves a per-OS artifact and a file written on macOS
      fails every Linux job; Gradle enforces it as soon as it exists.

## Android signing ceremony and Play App Signing enrollment (D23)

This runs once, before anything is uploaded to Play on any track, internal
included. If anything reaches Play first, Play generates its own app-signing key,
and Play, GitHub and F-Droid installs can then never upgrade one another (D14).

**Preconditions**:

- The publisher's Play Console organization account exists. Its D-U-N-S
  verification can take 28 days.
- The real `applicationId` is committed in `mobile/publisher.properties`. Play
  binds the key to the package name for good.

**On an offline machine, with two maintainers present:**

1. Generate the app-signing key. Use RSA 4096 with a validity of at least 30
   years; Play requires the key to remain valid past 2033-10-22.
   ```bash
   keytool -genkeypair -v -keystore yaran-app-signing.jks -alias yaran-app \
     -keyalg RSA -keysize 4096 -validity 11000 -dname "CN=Yaran, O=<publisher>"
   ```
2. Generate the separate upload key the same way (`yaran-upload.jks`, alias
   `yaran-upload`). The upload key can be reset through Play later; the app key
   cannot.
3. Write two encrypted offline backups of the app keystore and its passwords,
   one for each holder. Record where each backup is kept, but not its contents.
4. Print both fingerprints. `apksigner` prints lowercase hex without colons, which
   is the form the repo stores:
   ```bash
   keytool -list -v -keystore yaran-app-signing.jks -alias yaran-app | sed -n 's/^.*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f'
   ```

**In Play Console:**

5. Create the app record for the package.
6. Under Play App Signing, choose **use your own key** and export the app key with
   PEPK as Play instructs. Upload it, then register the upload certificate.
7. Do not upload any bundle during these steps.

**Record:**

8. In one PR, commit:
   - the app fingerprint in `mobile/android/signing/app-signing-cert.sha256`
     (one line, replacing the placeholder);
   - `mobile/android/signing/play-enrollment.json`:
     ```json
     {
       "package": "<applicationId>",
       "app_signing_cert_sha256": "<lowercase hex>",
       "upload_cert_sha256": "<lowercase hex>",
       "enrolled_at": "<YYYY-MM-DD>",
       "enrolled_by": "<maintainer>, <maintainer>"
     }
     ```
   - The PR carries a screenshot of Play Console's App signing page showing the
     same SHA-256.
9. Load both keystores (base64) and their passwords into the `android-release`
   environment, then delete the online copies from the ceremony machine.

**The gate in code.** `check-versions.mjs --play` fails until `play-enrollment.json`
exists, holds no placeholder, names the committed `appId`, and agrees with
`app-signing-cert.sha256`. Every path to Play runs it first:

- `play-internal`
- the Play channel of `mobile-store-promote.yml`
- both fastlane Android lanes, including a `PLAY_VALIDATE_ONLY=true` dry run

Phases 19 and 21 never upload to Play by hand.

**Check after enrollment**:

- `apksigner verify --print-certs` on a foss APK signed locally with the app key
  prints the committed SHA-256.
- `keytool -printcert -jarfile` on an upload-signed AAB prints `upload_cert_sha256`.

## Verifying what a release published

```bash
gh release download yaran-mobile-v1.0.0 --repo SiavZ/yaran
sha256sum -c yaran-mobile-checksums.txt
gh attestation verify yaran-mobile-1.0.0-foss.apk --owner SiavZ
apksigner verify --print-certs yaran-mobile-1.0.0-foss.apk | grep -f mobile/android/signing/app-signing-cert.sha256
```

The cloud train works the same way with `yaran-cloud-checksums.txt`. The org
Worker's update job verifies the Worker tarball's attestation itself before it
applies an update (T52).

## Toolchain pins

| Pin | Where |
|---|---|
| Node (the only Node pin) | `.node-version` |
| JDK, Android build-tools 34, compile and target SDK, iOS deployment target, Xcode path, simulator, Ruby, SwiftLint, apksigcopier, fdroidserver image digest | `mobile/toolchain.env` |
| fastlane and its gems | `mobile/Gemfile.lock` |
| GitHub Actions | 40-character commit SHAs in each workflow and in `.github/actions/*` |

`check-versions.mjs` fails when Phase 14's Gradle or Xcode projects disagree with
the SDK level or deployment target in `toolchain.env`, or when any `.nvmrc` appears
under `mobile/`. When a runner image drops the pinned Xcode, the iOS jobs fail and
name the missing path. Update `XCODE_APP` then; the jobs never fall back to the
image default.

### What the Android project must carry for these pipelines

Phase 14 owns the Gradle files. The pipelines expect:

- the `org.cyclonedx.bom` plugin, so `cyclonedxBom` writes a `bom.json` under
  `app/build/reports`;
- the `com.github.jk1.dependency-license-report` plugin, whose `checkLicense`
  reads `mobile/android/build/allowed-licenses.json`. CI writes that file from
  `deny.toml`. The plugin applies the normalizer
  `mobile/android/config/license-normalizer.json` and writes a JSON report under
  `app/build/reports/dependency-license/`;
- `dependenciesInfo { includeInApk = false; includeInBundle = true }` for `foss`;
- no Gradle signing config for release builds, because CI signs after the build;
- baseline-profile tasks disabled for the `foss` release, if they are enabled at
  all. The reproducibility job proves this.

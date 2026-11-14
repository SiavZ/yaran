# Branch protection: expected server-side configuration

Audit02 (P0-I bundle, P0-H, audit02 §27.3 spot-check, SECURITY.md cadence rule)
mandates the following branch protection on `main`. This file is the source of
truth; configure via `gh api` (recipe at the bottom of this file) or via the
GitHub UI (Settings → Branches → Protection rules → main).

## main

- **Require pull request before merging**: yes
  - Required approvals: 1 (CODEOWNERS-aware)
  - Dismiss stale approvals on push: yes
  - Require approval from CODEOWNERS: yes
- **Required status checks** (the contexts currently enforced on `main`;
  verify with `gh api /repos/SiavZ/yaran/branches/main/protection`).
  These job names are kept stable on purpose. Upstream's workspace CI names
  its jobs `Test` and `Clippy and test (macOS)`; this fork renames them back so
  the protection that already exists keeps gating. Each job carries a
  `BRANCH-PROTECTION CONTRACT` comment. Do not rename them in an upstream merge.
  - `Test (ubuntu-24.04)`: `cargo test` on Linux, the `test` job in
    `.github/workflows/pr.yml` and `.github/workflows/test.yml`, pinned to
    `ubuntu-24.04`
  - `Test (macos-14)`: the `clippy-test-macos` job in the same two files.
    It runs clippy with `--all-targets` and then `cargo test` on
    `macos-latest`, as upstream does (not yet proven on a macos-14 runner)
  - `Security`: `cargo audit` + `cargo deny check`, in pr.yml and test.yml
  - `shell`: `shellcheck` + `bats` from `.github/workflows/overlay-ci.yml`
  - `Required gates`: the always-reporting aggregator job in
    `.github/workflows/gates.yml`. It carries the `BRANCH-PROTECTION
    CONTRACT` comment, runs on every PR (docs-only ones included) and on
    pushes to `main`, and fails when any job it gathers fails: today
    `Module headers` (`tools/module-headers --check`, skipped when no code
    file changed), `File length` (the 500-line gate against
    `tools/module-headers/baseline-oversize.json`) and `Protocol`
    (`.github/workflows/cloud-protocol.yml`, skipped unless `cloud/protocol/**`
    or `crates/yaran-core/src/cloud/**` changed), and the phone-app suites
    Phase 18 added, each skipped when its filter does not match: `Cloud`
    (`cloud-ci.yml`), `Mobile` (`mobile-ci.yml` with its Android and iOS legs),
    `UI kit` (`ui-kit-ci.yml`), `cloudflared real binary` and
    `Release-train tooling`
  - `Workflow policy`: `.github/workflows/workflow-policy.yml`, which runs on
    every PR with no paths filter. It fails on an action not pinned to a
    40-hex SHA, a workflow without top-level `permissions`, any
    `pull_request_target` or `secrets: inherit`, a new-train release without
    `--latest=false`, a writer of the `cloud-deploy*` branches other than
    `release-cloud.yml`, an environment not documented below, and any
    actionlint finding
  - `Strict mode (require branches up to date before merging)`: yes
- **Path-filtered suites are never required directly.** A workflow skipped
  by a `paths:` filter leaves its check "Pending" forever, which blocks the
  merge. Such a suite (the cloud, mobile, protocol and UI-kit suites of the
  phone-app plan) is a reusable workflow called from the seam in
  `.github/workflows/gates.yml`, gated there by `if:` on its filter, and it
  reaches branch protection only through `Required gates`.
- **Admins can bypass the required checks** while `enforce_admins` is
  `false`. Turning it on is an owner decision and is deliberately left off
  here.
- **Recommended (not currently required) but run on every PR**:
  - `Format`, `Clippy`, `Web lint`, `Web build and unit tests`,
    `yaran-web dependency isolation`, `Reject YARAN_DISABLE_UI_BUILD`, and
    `MSRV (1.89)` (`cargo +1.89.0 check`, which keeps the workspace's
    declared `rust-version` true).
    Add them to the protection if you treat them as merge gates; the recipe
    below shows the syntax.
- **Disallow force push**: yes (covers force-push to main + delete)
- **Disallow deletion**: yes
- **Require signed commits on main**: opt-in if/when GPG enrollment is in place
- **Require linear history**: no (merge commits are used for integration branches)
- **Lock branch**: no (push allowed via PRs only)

## Tag protection

- Pattern: `v*`, `dux-amq-v*` (historical), `yaran-v*`, and the phone-app
  trains `yaran-cloud-v*` and `yaran-mobile-v*` (D15)
- Restrict who can push: maintainers only (CODEOWNERS)
- New release tags for this fork are `yaran-vX.Y.Z`. Historical releases retain their `dux-amq-vX.Y.Z` tags. The release workflow strips
  the prefix for the crate version and refuses to publish an archive that is not
  fork lineage (`.github/scripts/verify_fork_lineage.sh`).

- The new trains publish on the **tag push**: `release-cloud.yml` and
  `release-mobile.yml` create the GitHub release themselves with
  `--latest=false`, so `install.sh`'s default install keeps resolving the
  newest `yaran-v*`. `release.yml` skips any release whose tag is not
  `yaran-v*` or `dux-amq-v*`. See `docs/operations/release-trains.md`.

## Generated branches: `cloud-deploy`, `cloud-deploy-rc`, `cloud-deploy-root`

A branch ruleset (Settings → Rules → Rulesets, target these three names):

- **Block force pushes** and **restrict deletions**.
- **Restrict updates** to one actor: the `deploy-branch` and
  `deploy-branch-rc` jobs of `release-cloud.yml`, which run in the
  `cloud-release` environment. Whether a ruleset can name the GitHub Actions
  app as its only bypass actor is UNVERIFIED; if it cannot, add a write deploy
  key, store its private half as `CLOUD_DEPLOY_KEY` in the `cloud-release`
  environment only, and make that key the rule's sole permitted actor. The jobs
  use the key when the secret is set and the job token otherwise.
- `cloud-deploy` is what the Deploy to Cloudflare button and every org
  Worker's update checker read (T52); `cloud-deploy-rc` carries release
  candidates for staging; `cloud-deploy-root` exists only if gate G11 adopts
  its fallback. History is append-only, one commit per release.

## Environments

Each holds its secrets and has **required reviewers: maintainers** and a
**deployment branch and tag rule** limited to the train's own tags. Secret
names are listed in `docs/operations/release-trains.md`; their values never
appear in a workflow file or in config.

| Environment | Tags allowed | Used by |
|---|---|---|
| `android-release` | `yaran-mobile-v*` | `_mobile-android-release.yml`, `release-mobile.yml` (`play-internal`), `mobile-store-promote.yml` (`play`) |
| `ios-release` | `yaran-mobile-v*` | `_mobile-ios-release.yml`, `release-mobile.yml` (`testflight`), `mobile-store-promote.yml` (`appstore`) |
| `push-relay-production` | `yaran-cloud-v*` | `release-cloud.yml` (`deploy-relay`, `relay-image`) |
| `cloud-release` | `yaran-cloud-v*` | `release-cloud.yml` (`deploy-branch`, `deploy-branch-rc`) |
| `github-pages` | `main` | `pages.yml` (existing) |

`mobile-store-promote.yml` is a manual dispatch from `main`, so the two mobile
environments also allow `main`. With a single maintainer the reviewer gate
still forces one deliberate approval click per release.

## Default workflow permissions

- Settings → Actions → General → Workflow permissions: **Read repository contents and packages permissions**
- Allow GitHub Actions to create and approve pull requests: **off**

## Configuration recipe (idempotent)

```bash
# Apply the currently-enforced contexts. To also gate on Format/Clippy,
# add the matching `-f 'required_status_checks[contexts][]=...'` lines.
gh api -X PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/SiavZ/yaran/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f 'required_status_checks[contexts][]=Test (ubuntu-24.04)' \
  -f 'required_status_checks[contexts][]=Test (macos-14)' \
  -f 'required_status_checks[contexts][]=Security' \
  -f 'required_status_checks[contexts][]=shell' \
  -f 'required_status_checks[contexts][]=Required gates' \
  -f 'required_status_checks[contexts][]=Workflow policy' \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f required_pull_request_reviews[require_code_owner_reviews]=true \
  -f enforce_admins=false \
  -f required_linear_history=false \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -F restrictions=null
```

**Verify after applying:**
```bash
gh api /repos/SiavZ/yaran/branches/main/protection | jq .
gh api /repos/SiavZ/yaran/branches/main/protection \
  --jq '.required_status_checks.contexts'   # must list "Required gates"
```

Apply the `Required gates` and `Workflow policy` contexts only after
`gates.yml` and `workflow-policy.yml` have landed on `main` and reported once: a required context that no workflow reports leaves
every open PR blocked on "Expected — Waiting for status to be reported".

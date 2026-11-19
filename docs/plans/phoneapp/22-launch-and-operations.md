# Phase 22 — Launch, staged rollout and operations

**Track:** C (sequential, last) · **Parallel-safe with:** nothing
**Depends on:** 21 (store-ready on all channels; relay and demo in production) · **Blocks:** nothing (it closes the product)

## Goal

Ship the product to the public in an order where no released component ever depends on
one that is not out yet. Then ramp every channel gradually, with halt criteria written
down before the ramp starts, and leave the publisher with what it needs to keep the
product healthy:

- monitoring and alerting;
- runbooks;
- a support process;
- a rollback answer for every channel;
- a maintenance calendar.

Without that last list, the product decays within a year: cloudflared support windows,
target API deadlines and Xcode SDK requirements all expire on fixed dates.

## Evidence

All web sources were fetched on 2026-11-14.

**Release trains and compatibility.** The trains are `yaran-vX.Y.Z` (binary),
`yaran-cloud-vX.Y.Z` (protocol, Worker, relay) and `yaran-mobile-vX.Y.Z` (apps).
Compatibility comes from protocol version negotiation, never from releasing in lockstep
(D15). The contract is `02-protocol-contract.md`.

**Play** (https://support.google.com/googleplay/android-developer/answer/6346149 and https://support.google.com/googleplay/android-developer/answer/16285429):

- A staged rollout percentage "won't increase automatically".
- When a rollout is halted, "no additional users will receive the app version … Users who already received the app version … will remain on that version". A bad build is replaced by "a new release with a fixed app bundle".
- Halting a 100% release puts the previous version back "for new and eligible users". "You cannot halt your first release on a track."
- Users who already updated are never downgraded, so there is no true rollback. A fix always needs a higher `versionCode` (inference from the above, and R5 §7.8).

**App Store phased release** (https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases):

- Rollout runs over 7 days at 1%, 2%, 5%, 10%, 20%, 50% and 100%, and only for users with automatic updates.
- "You can pause your release for a total of 30 days", with no limit on the number of pauses.
- Manual downloads always get the new version.

**F-Droid** (https://f-droid.org/docs/FAQ_-_App_Developers/ and https://f-droid.org/docs/Build_Metadata_Reference/):

- Daily builds, so a release takes "a few days".
- No staged rollout is documented. `CurrentVersionCode` controls which version clients recommend. A per-build disable field is UNVERIFIED and is confirmed in work item 8.
- Phase 21 pins `UpdateCheckMode: Tags ^yaran-mobile-v\d+\.\d+\.\d+$` (18's recipe draft uses the same pattern). Release-candidate tags such as `yaran-mobile-v1.0.0-rc.1`, the only prerelease form 18's tag parser accepts, therefore never reach F-Droid.
- New-train GitHub releases are never "latest": 18 creates them with `--latest=false`, so `latest` stays on `yaran-v*` and `install.sh` keeps working (R17). 18 creates a stable mobile release as a draft and `mobile-store-promote.yml` `channel: github` publishes it.
- Nothing reaches Play before 18's Play App Signing enrollment: every Play path in 18's workflows runs `check-versions.mjs --play` first (D23).

**Workers** (https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/):

- "Gradual deployments let you incrementally deploy new versions of your Worker by splitting traffic across versions", via `wrangler versions deploy`.
- You can "Roll back to a previously stable version". The exact CLI is on the linked Rollbacks page and is UNVERIFIED here.
- The page gives no guidance on D1 migrations. That is why this plan requires D1 changes to be backward compatible, using expand and contract.

**Fixed external deadlines that drive the maintenance calendar:**

- cloudflared supports versions within one year of the latest, at roughly 30 releases a year (R4 Hard constraint 13).
- Play target API 36 since 2026-08-31, renewed each year (https://developer.android.com/google/play/requirements/target-sdk). A 2027 bump is UNVERIFIED.
- The Xcode 26 / iOS 26 SDK upload requirement since 2026-04-28, renewed each year (https://developer.apple.com/news/upcoming-requirements/).
- Capacitor upgrades to 9 at GA (D13).
- `deny.toml` ignores are "reviewed quarterly" (`deny.toml:19-22`).

**What exists from Phase 21.** `relay-canary.yml` and `demo-healthcheck.yml` are
scheduled. `docs/operations/publisher-infrastructure.md` exists. Phase 20 left
`docs/operations/key-compromise-playbooks.md` and the rerunnable abuse scripts in
`tools/cloud-gates/abuse/`.

**Docs slots and what has no channel yet.**

- Phase 17 reserved `website/docs/operating-your-control-plane.md` (order 77) for this phase.
- The website has a blog (`website/blog/`, `content.config.ts:23-52`).
- There is no telemetry and no crash SDK (Phase 14, F-Droid Tracking). Health signals
  therefore come only from:
  - the publisher's own canaries;
  - Play Console Android vitals and App Store Connect crash reports (OS-level, no SDK);
  - user reports.

## In scope

- Release order.
- The go/no-go checklist.
- Beta, then GA staged rollouts on Play, the App Store, GitHub and F-Droid.
- Rollback per channel.
- Monitoring and alerting for the publisher's relay and demo.
- An observability guide for org admins.
- Runbooks.
- A support process.
- Post-launch verification.
- The maintenance calendar.
- Launch docs: store links, the blog post, README.

## Out of scope

| Item | Owner |
|---|---|
| New features, or fixes to findings | Their owning phases. A launch blocker is fixed there and re-enters at the go/no-go gate. |
| Key-compromise procedures themselves | 20. Runbooks here link them. |

## Design

### Release order (each step gates the next)

1. **`yaran-cloud-v1.0.0`.** The protocol package, the Worker release and the relay.
   - The relay is promoted in production, where it already runs from 21, to the tagged
     build.
   - The Worker release is what new Deploy-button orgs get, through the generated
     `cloud-deploy` branch that `release-cloud` publishes (D18), and what existing staging
     and demo orgs update to.
   - Gate: `cloud-deploy:worker/release.json` names the tag, the demo org has updated
     through the documented update path (07), the canary is green, and the D1 migrations
     have been applied.
2. **`yaran-vX.Y.Z` with the cloud leg.** It is a normal binary release through the
   existing `release.yml`.
   - Gate: `yaran cloud login` against the demo and staging orgs on Linux and macOS, from
     the released archives rather than CI artifacts.
3. **Mobile beta, `yaran-mobile-v1.0.0-rc.N`.** Four channels:
   - Play open testing, promoted from the 21 closed test;
   - TestFlight external public link;
   - GitHub pre-release APK (18 publishes `-rc.N` as a prerelease, not "latest");
   - not F-Droid, because the tag pattern excludes release candidates.

   The beta lasts at least 14 days, and only ends once at least 2 betas in a row show no
   P1 issue.
4. **Mobile GA, `yaran-mobile-v1.0.0`.** The tag starts 18's `release-mobile` (draft
   GitHub release, Play internal, TestFlight); from there each channel is staged (below)
   through `mobile-store-promote.yml`. Docs and store links go live on the day each
   listing does.

### Staged rollout and halt criteria

**Halt criteria apply on every channel and are evaluated at each step.** Any one of these
triggers a halt:

- a P1 issue, meaning data exposure, being unable to open any machine, push being broken
  for a whole channel, or a crash on launch;
- the relay canary or demo healthcheck failing twice in a row;
- Play Android vitals user-perceived crash or ANR rate above Play's bad-behaviour
  threshold;
- an App Store Connect crash spike against the beta baseline;
- a security report affecting the release.

| Channel | Mechanism | Plan |
|---|---|---|
| Play `production` | Managed publishing plus staged rollout | 5% (day 0) → 20% (day 2) → 50% (day 4) → 100% (day 7). Each step is a manual decision against the halt criteria. The decision is logged in the release issue. |
| App Store | Phased release, 7 days | Turned on at submission. Pause on a halt criterion (≤30 days total). "Release to all" is used only for a security fix. |
| GitHub APK | The `yaran-mobile-vX.Y.Z` release 18 creates as a draft, never `latest` (R17) | Published with `mobile-store-promote.yml` `channel: github` when Play reaches 20% with no halt. Until then the draft holds the two signed APKs, the SBOMs, the license inventory, `yaran-mobile-checksums.txt` and provenance, built by 18. |
| F-Droid | Daily autoupdate from the tag (a few days' lag) | The GA tag is what starts 18's pipeline, so it cannot wait for store approvals; F-Droid's lag after the tag, plus its `Binaries:` download failing while the GitHub release is still a draft, makes F-Droid the late wave. Whether F-Droid retries a version whose binary was missing is confirmed in work item 8; if it does not, the GitHub publish point moves before F-Droid's first build of the tag. On a halt, follow the F-Droid halt procedure (work item 8). |
| Org Workers | Each org admin's own deployment | Release notes plus the in-console update notice (07). Recommend gradual deployments in the org guide. The publisher never deploys into an org. |
| yaran binary | Existing release pipeline | No staging. Users upgrade at will. Protocol negotiation keeps old and new versions working together. |

### Rollback per channel

| Component | Rollback answer |
|---|---|
| Org Worker | The admin rolls back to the previous Worker version (Cloudflare Workers rollback). Safe because every D1 migration is expand/contract: release N never removes or renames anything release N-1 reads. The contract step ships one release later. This rule is added to `cloud/worker/README` by this phase if 04 has not already stated it. |
| Relay | The publisher rolls back the relay deployment (18's `push-relay-production` environment) to the previous version. The relay is stateless apart from rate-limit counters. |
| Deploy button | A bad stable `yaran-cloud` release has already advanced `cloud-deploy`; 18's job refuses to push an older tag, so the fix is a new patch release, which advances the branch again. Orgs that already deployed roll back their own Worker (row above). |
| yaran binary | Reinstall the previous `yaran-v*` archive. The credentials file is schema-versioned (09). An older binary that meets a newer schema stops the cloud leg out loud and never rewrites the file. 19's skew tests prove this, and this phase re-checks it on the released archives. |
| Play | No downgrade. Halt the rollout, then ship a hotfix with a higher `versionCode` through the same staged plan, compressed to 20% → 100%. |
| App Store | No downgrade. Pause the phased release, then submit the hotfix and request expedited review (Apple's process; criteria UNVERIFIED). |
| GitHub | Mark the bad release as a pre-release with a warning in its notes (it was never `latest`, R17), or return it to draft if it was published minutes ago. Then ship the hotfix. |
| F-Droid | Open an fdroiddata MR to set `CurrentVersionCode` back, and disable the bad build if the per-build disable field is confirmed. Then ship the hotfix tag. |

### Monitoring and alerting

The publisher monitors only what the publisher runs.

| Signal | Source | Threshold, then action |
|---|---|---|
| Relay delivers to APNs | `relay-canary.yml` (21), every 30 min | 2 failures in a row: open an issue labelled `ops:p1` and assign it to the on-call maintainer (GitHub notification) |
| Relay error rate and 429 rate | Cloudflare analytics for the relay Worker, polled by a scheduled workflow `relay-metrics.yml` through the GraphQL Analytics API. A native Cloudflare notification for Worker error rates is UNVERIFIED; this workflow is the guaranteed path. | 5xx above 1% over 1 h, or rate-limit hits above 3× the 7-day median: open an issue labelled `ops:p2` |
| Demo review environment | `demo-healthcheck.yml` (21) | 2 failures in a row: `ops:p1` while any store review is pending, otherwise `ops:p2` |
| Store review state | Manual check in the release issue, daily, during submission | Rejection: run the store-rejection runbook |
| Android vitals and iOS crashes | Play Console and App Store Connect | Checked at each rollout step and weekly afterwards |
| cloudflared and dependency advisories | osv-scanner, zizmor and cargo-audit jobs (20), 18's weekly `cloudflared-pin-watch.yml` (10's `bump.sh --check`), plus GitHub releases of cloudflared (watch) | Advisory affecting the pin: run the cloudflared pin-bump runbook within 72 h; a `cloudflared-pin-watch` issue is handled within its 7-day window |
| Association files on `<publisher-domain>` (T63) | `association-check.yml`, daily, running 18's `check-association.mjs --live` | Any mismatch or fetch failure: `ops:p1` (release-build sign-in depends on it) |

Org Workers are the orgs' own. `operating-your-control-plane.md` tells admins how to watch
theirs (Workers logs and analytics in their dashboard, the audit log in the console, D1
usage against Free-plan limits, and the API budget), what each console warning means, and
how to update and roll back.

### Support process

**Intake.**

- Use the issue templates from 21.
- Security reports go only to the `SECURITY.md` contact, which promises acknowledgement
  within 72 h (`SECURITY.md:8-13`).
- Store reviews and the F-Droid issue tracker are checked weekly by the on-call maintainer.

**Labels.** `area:cloud-worker`, `area:relay`, `area:cloud-leg`, `area:mobile`,
`channel:{play,appstore,github,fdroid}`, `ops:{p1,p2}`.

**Targets (best effort, stated publicly in `CONTRIBUTING.md`).** First response within 3
business days, and the same day for `ops:p1`.

**On-call.** A weekly rotation between at least two maintainers, recorded in
`docs/operations/publisher-infrastructure.md`.

## Work items

1. **Go/no-go checklist and release runbook.**
   - Create `docs/operations/runbooks/release-and-rollout.md`, the reusable runbook for
     every future release. It covers:
     - the release order;
     - the per-step gates;
     - the halt criteria;
     - the per-channel staged plan;
     - the release-issue template (`.github/ISSUE_TEMPLATE/release.yml`), with one
       checkbox per gate.
   - The go/no-go list for 1.0 requires:
     - 18's Play App Signing enrollment record exists, matches Play Console, and predates
       every Play upload (D23);
     - Phase 20 has zero open findings;
     - all 21 acceptance items are met;
     - every Phase 03 gate is closed;
     - the docs are live;
     - the demo and canary are green for 7 days;
     - support labels and on-call are in place.
   - Test: a dry run of the checklist against the beta release, recorded in the release
     issue.
2. **Execute the release order** (cloud, then binary, then beta, then GA), with each gate's
   evidence in the release issue.
   - Test: the per-gate evidence links.
3. **Monitoring.**
   - Create `.github/workflows/relay-metrics.yml` (SHA-pinned actions, a read-only API
     token scoped to analytics on `publisher-relay` held in 18's `push-relay-production`
     environment, and a script under `tools/ops/relay-metrics.mjs` with a header).
   - Create `.github/workflows/association-check.yml` (daily, SHA-pinned, no secrets) running
     18's `check-association.mjs --live`; failures open an `ops:p1` issue (T63).
   - Wire the canary and healthcheck issue labels and assignees.
   - Tests: a unit test for the threshold logic in `tools/ops/relay-metrics.test.mjs` using
     recorded GraphQL responses. Also force a canary failure on staging once and confirm an
     issue opens.
4. **Org admin observability guide.** Create `website/docs/operating-your-control-plane.md`
   (group "Cloud Connect", order 77), covering consumer facts only.
   - Tests: website `npm test` and the build; Phase 17's domain guard covers the page.
5. **Runbooks.** Create one file each in `docs/operations/runbooks/`:
   - `relay-outage.md`: detection, comms text, failover to the G4 fallback relay design if
     Workers-to-APNs breaks (18's `RELAY_RUNTIME` switch; for `vm`, pulling the attested
     GHCR image by digest), and what users see (Android unaffected, iOS pushes delayed).
   - `cloudflare-api-change.md`: detect breaking API or Access changes through 19's
     scheduled smoke run on staging, assess impact on the provisioning engine (05), ship a
     `yaran-cloud` patch, and tell org admins to update.
   - `cloudflared-pin-bump.md`: read release notes, take the SHA-256 from them, update
     yaran's compiled table with 10's `tools/cloudflared-pin/bump.sh` (never below the
     2026.11.0 minimum), let 18's `cloudflared` CI job verify and test the new binary, test
     on staging, ship in the next binary release, and ship out of band for a CVE.
   - `protocol-deprecation.md`: the policy. A protocol version is advertised in
     `/v1/meta` as deprecated for at least 6 months and two mobile releases before the
     minimum is raised. The Worker raises it last, and every surface's mismatch message
     (02) names the fix.
   - `store-rejection.md`: Resolution Center reply templates for 4.2, 4.2.7, 2.5.2 and 2.1
     (taken from 21's notes), the Play appeal path, and owner escalation.
   - `mobile-hotfix.md`: the compressed rollout and per-channel rollback steps.
   - `key-rotation.md`: an index into `key-compromise-playbooks.md` plus the scheduled
     renewals, including the relay's APNs `.p8` (set with `wrangler secret put`, 18) and the
     publisher domain's registration (T63).
   - Test: each runbook is rehearsed once on staging (relay outage via a forced canary
     failure, pin bump end to end, protocol deprecation flag on the staging Worker), with a
     log in `docs/audits/audit04-cloud-connect/12-runbook-rehearsals.md`.
6. **Support setup.**
   - Create the labels via `gh label create`.
   - Add the `CONTRIBUTING.md` support targets section.
   - Record the on-call rotation in `publisher-infrastructure.md`.
   - Test: labels exist (validation).
7. **Launch docs.**
   - Add real store links to `website/docs/mobile-apps.md` and `README.md`, only once each
     listing is live.
   - Add `website/blog/<date>-yaran-in-your-pocket.md`. It is in the site's voice, makes
     no feature counts in headings, and states D17 plainly.
   - Update `ServerMode.astro` and `FeatureGrid.astro` CTAs to point at the live docs.
   - Test: website `npm test` and the build; the domain-guard allowlist gains only the
     verified store listing URLs.
8. **F-Droid halt procedure.**
   - Confirm the fdroiddata field for disabling one build. Document it in `mobile-hotfix.md`
     with an example MR diff.
   - Confirm what F-Droid does when a tag's `Binaries:` URL 404s because 18's GitHub release
     is still a draft (retry on a later cycle, or mark the version failed), and set the
     GitHub publish step in `release-and-rollout.md` accordingly.
   - Test: a review of the procedure by an fdroiddata maintainer, requested in the
     inclusion MR thread.
9. **Post-launch verification** within 24 h of each channel reaching 100%:
   - Install from each store on real devices: the GrapheneOS phone through the
     phone-testing skill, and an iPhone.
   - Cross-channel upgrade: GitHub APK 1.0.0 to the Play 1.0.1 hotfix-train build, and
     F-Droid to GitHub.
   - Run a fresh Deploy-button org on the production `yaran-cloud` release, then the 19
     smoke subset (pair, onboard, open a machine, push on every channel, revoke).
   - Run 20's abuse scripts against the production relay at the agreed low rate.
   - Test: results in `docs/audits/audit04-cloud-connect/13-post-launch.md`.
10. **Maintenance calendar.**
    - Create `docs/operations/maintenance-calendar.md`, with one row per recurring
      obligation (cadence, owner, trigger, runbook):

      | Obligation | Cadence |
      |---|---|
      | cloudflared pin review | Monthly. Bump at least every 60 days and within 7 days of a `VULN-` release (10's `bump.sh --check`, run weekly by 18's `cloudflared-pin-watch.yml`), so no pin nears the one-year support window. Within 72 h for a CVE affecting the pin. |
      | Capacitor and plugin upgrades | Dependabot weekly. The upgrade from `~8.6.2` to Capacitor 9 is 14's work item 14, landing at GA; if it has not landed by launch, it ships in the first release after. |
      | Node LTS (`.node-version`, 18) | Move to the next Active LTS within 6 months of its LTS date (Node 26 has been Active LTS since 2026-10-28; 18 pins 24) |
      | `<publisher-domain>` registration, registrar lock and association files (T63) | Yearly renewal check, plus the daily `association-check.yml` |
      | Android target API (36 today, `mobile/toolchain.env`) | Every year before 31 August (exact 2027 level UNVERIFIED; check the Play page each spring) |
      | Xcode / iOS SDK upload requirement | Every year before late April |
      | Apple Developer membership and distribution certificate | Yearly |
      | D-U-N-S record | Yearly |
      | `deny.toml` ignore reviews | Quarterly |
      | Fuzz nightly toolchain pin | Monthly |
      | Demo VM OS, Dex and image | Monthly |
      | Relay dependency updates | With each `yaran-cloud` release |
      | Review of this calendar | Yearly |

    - Add `.github/workflows/maintenance-reminders.yml`, which opens an issue on each due
      date from a small data file `docs/operations/maintenance-calendar.json` (the
      generated-from file for the markdown table).
    - Test: a unit test of the date logic in `tools/ops/maintenance-reminders.test.mjs`
      (the script has a header).

## Acceptance

- [ ] The release-and-rollout runbook and the release issue template exist, and the beta dry run is recorded.
- [ ] The trains were released in order: cloud, then binary, then mobile beta (14 days or more, two clean betas), then GA. Each gate's evidence is linked in the release issue.
- [ ] Play reached 100% through the 5/20/50/100 steps, App Store phased release completed, the GitHub release (never `latest`) was published after Play reached 20%, and F-Droid published the developer-signed APK. No halt is outstanding.
- [ ] No Play upload predates 18's Play App Signing enrollment (D23), and `association-check.yml` is green.
- [ ] `relay-metrics.yml` runs with tested threshold logic. The canary and healthcheck open labelled issues on failure, as proven once on staging.
- [ ] `operating-your-control-plane.md` is live in the Cloud Connect group.
- [ ] Seven runbooks exist and each has a logged rehearsal.
- [ ] Support labels, `CONTRIBUTING.md` targets and the on-call rotation are in place.
- [ ] Store links and the launch blog post are live. The domain guard passes.
- [ ] The post-launch verification on real devices and fresh orgs passed on every channel.
- [ ] The maintenance calendar and reminder workflow exist, and their tests pass.

## Validation

```bash
cd /Users/siavash/Projects/yaran
ls docs/operations/runbooks/{release-and-rollout,relay-outage,cloudflare-api-change,cloudflared-pin-bump,protocol-deprecation,store-rejection,mobile-hotfix,key-rotation}.md
gh label list | grep -E 'area:(cloud-worker|relay|cloud-leg|mobile)|channel:|ops:p[12]'
node --test tools/ops/relay-metrics.test.mjs tools/ops/maintenance-reminders.test.mjs
gh run list --workflow relay-canary.yml --limit 336 --json conclusion -q '[.[]|select(.conclusion!="success")]|length'   # 7 days; expect: 0
gh run list --workflow demo-healthcheck.yml --limit 336 --json conclusion -q '[.[]|select(.conclusion!="success")]|length'
gh release view yaran-mobile-v1.0.0 --json assets,isLatest -q '.isLatest, .assets[].name'   # false; foss and play APKs, SBOMs, license inventory, yaran-mobile-checksums.txt
gh release download yaran-mobile-v1.0.0 -p yaran-mobile-checksums.txt -p '*.apk' -p '*.cdx.json' -D /tmp/rel && (cd /tmp/rel && sha256sum -c yaran-mobile-checksums.txt)
gh attestation verify /tmp/rel/yaran-mobile-1.0.0-foss.apk --owner SiavZ
curl -fsS https://raw.githubusercontent.com/SiavZ/yaran/cloud-deploy/worker/release.json | jq -r .tag   # the launched yaran-cloud tag
node tools/release-trains/check-association.mjs --live
(cd website && npm ci && npm test && npm run build)
scripts/validate-threat-model.sh
```

## Risks

| Risk | Mitigation |
|---|---|
| No telemetry means a regression is invisible until users report it | Canaries on publisher infrastructure, store vitals at every step, a 14-day beta with two clean builds, and a slow Play ramp. Deliberate: telemetry would contradict the F-Droid Tracking rule and the privacy policy. |
| F-Droid publishes days after the tag and cannot be staged | The lag, and the draft GitHub release its `Binaries:` URL points at, make it a late wave. Retry behaviour after a missing binary and the halt procedure are confirmed with fdroiddata maintainers (work item 8). |
| An org admin never updates their cloned Worker, so protocol skew grows | The negotiation window, the 6-month deprecation policy, the in-console update notice, and mismatch messages that name the fix. |
| Workers-to-APNs (G4 primary) breaks after launch | `relay-outage.md` fails over to the designed G4 fallback. Android is unaffected. |
| Missing a fixed external deadline (target API, Xcode SDK, cloudflared window) | Calendar plus the reminder workflow opening issues ahead of each date. Reviewed yearly. |
| A maintainer is unavailable during a P1 | Two-person on-call rotation. Playbooks and runbooks are written to be executable by any maintainer with environment access. |
| A store rejection on a hotfix delays a security fix | App Store expedited review request, the Play halt, and marking the bad GitHub release as a pre-release are all available immediately. Rejection runbook templates are ready. |
| `<publisher-domain>` lapses or its association files drift, breaking release-build sign-in (T63) | Daily `association-check.yml` (`ops:p1`), registrar lock and auto-renew (21), renewal in the calendar. |

## References

- Play staged rollouts: https://support.google.com/googleplay/android-developer/answer/6346149 ; halting fully rolled-out releases: https://support.google.com/googleplay/android-developer/answer/16285429 (fetched 2026-11-14)
- App Store phased release: https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases (fetched 2026-11-14)
- Workers gradual deployments: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/ (fetched 2026-11-14)
- F-Droid FAQ for App Developers; Build Metadata Reference (fetched 2026-11-14)
- `research/R4-cloudflare.md` Hard constraint 13
- `research/R5-mobile.md` §7, §8
- `20-security-review-and-hardening.md`, `21-publisher-infrastructure-and-store-readiness.md`, `17-docs-website-threat-model.md` (T29, T40, T63)
- `18-build-ci-and-release-pipelines.md` (draft releases and `channel: github`, `--latest=false`, `--play` gate, `cloud-deploy`, `check-association.mjs`, `cloudflared-pin-watch.yml`, `.node-version`); `10-yaran-cloudflared-leg.md` (pin cadence); `14-mobile-app-foundation.md` work item 14 (Capacitor 9); `00-README.md` D15, D18, D23

## Reconciliation notes (2026-11-14)

- GitHub channel: "Release marked `latest`" and "move `latest` back" replaced; new-train releases are never `latest` (`--latest=false`), the stable release is 18's draft published via `mobile-store-promote.yml` `channel: github`; asset list and `SHA256SUMS` → `yaran-mobile-checksums.txt` with both APKs, SBOMs and the inventory (R17, 18 names).
- Beta tags `-beta.N` → `-rc.N`, the only prerelease form 18 accepts (R20).
- F-Droid: "push the tag only after store approvals" removed, because the tag starts 18's pipeline; the late-wave reasoning and a new work item 8 check of F-Droid's behaviour on a draft `Binaries:` URL replace it (R20, consistency with 18).
- Go/no-go and Acceptance: 18's Play App Signing enrollment must predate every Play upload (R13, D23).
- Release order: Deploy-button orgs get the `cloud-deploy` branch; gate checks its `release.json` (R4, D18); rollback table gains the Deploy-button row.
- Environment `relay-production` → 18's `push-relay-production` (R20).
- Monitoring and calendar: daily `association-check.yml` and domain renewal (T63); cloudflared cadence aligned to 10's 60-day / 7-day `VULN-` rule run by 18's `cloudflared-pin-watch.yml`, 72 h CVE target kept, minimum 2026.11.0 (R21); Capacitor 9 attributed to 14 work item 14 (R21); Node LTS row added (18 hands it here); target API 36 named (R21).
- Runbooks: relay failover names 18's `RELAY_RUNTIME`; pin bump uses 10's `bump.sh` and 18's CI job; key rotation names the APNs `.p8` and the publisher domain (R20, T63).
- Validation and References updated to the canonical asset names, attestation check, `cloud-deploy` manifest and association check; nothing removed.

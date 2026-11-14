# G07 A reproducible fdroid build of the foss flavor: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G07` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Variant A builds and fdroid publish verifies the developer-signed APK | pending | pending |
| fdroid lint clean | pending | pending |
| Scanner raises no non-free dependency in foss | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 18 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 18, 21, 14 (none updated yet)

## Re-run triggers

New AGP/Gradle/Capacitor versions; fdroidserver releases; any reproducibility regression in CI (Phase 18).

## What is ready, and what closing it needs

- **Ready to run:** `g07-fdroid.sh` builds the spike foss release twice in clean fdroidserver containers, compares hashes (diffoscope on mismatch), signs with apksigner from build-tools 34, writes metadata variants A and B, and with a local fdroiddata checkout runs readmeta/lint/build/publish and apksigcopier.
- **The maintainer must provide:** Docker with the fdroidserver buildserver image; an Android signing keystore (D14's key comes in Phase 18; a gate key is enough to measure reproducibility); a pushed commit of this branch; a local fdroiddata checkout; somewhere to host the signed APK at the Binaries URL.
- **Later-phase dependency:** Variant B needs a tag tree with the built shell bundle and vendored @capacitor/android, which Phase 18's release workflow produces.

# G11 Deploy button from a branch subdirectory (the generated cloud-deploy layout), with D1 migrations in the deploy script and secret prompts: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G11` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| The button deploys from the subdirectory | pending | pending |
| D1 is provisioned and migrated by the deploy script | pending | pending |
| Secrets are prompted with descriptions | pending | pending |
| A redeploy applies new migrations | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 07 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 07, 04, 02, 18 (none updated yet)

## Re-run triggers

Any Deploy-button or Workers Builds changelog entry; wrangler majors.

## What is ready, and what closing it needs

- **Ready to run:** `g11-deploy-button.sh` runs the plain-wrangler variant unattended (d1 create, migrations apply, deploy --secrets-file, 0002), then, after confirmation, pushes the orphan gate branch (worker/ only) and its workspace:* variant and walks the operator through the button, reading /v1/meta.
- **The maintainer must provide:** Staging account A with Workers Builds; push rights to SiavZ/yaran for the gate branches; a GitHub account for the button's clone.
- **Later-phase dependency:** None (the generated cloud-deploy branch itself is Phase 07/18).

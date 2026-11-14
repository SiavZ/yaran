# G09 The account-owned API token template URL, with permission group IDs resolved by API: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G09` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Every ID resolves | pending | pending |
| The URL pre-fills with no notices | pending | pending |
| The created token passes all step-5 calls | pending | pending |
| Every step-6 removal produces a distinguishable error | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 07 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 07, 17 (none updated yet)

## Re-run triggers

Any API token permissions changelog entry; nightly via the recheck.

## What is ready, and what closing it needs

- **Ready to run:** `g09-token-template.sh` resolves each permission group by name, diffs against the research table, builds the template URL, verifies the operator's token, exercises each permission and records the per-permission errors. ID resolution is part of `run.sh --recheck`.
- **The maintainer must provide:** Staging account A with an admin-capable runner token; dashboard access to create the template token and the one-permission-removed tokens.
- **Later-phase dependency:** None.

# G03 Access responses for unauthenticated and expired requests, by request kind and org age: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G03` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Matrix complete for account A, account A with Managed OAuth, and account B (or "not available") | pending | pending |
| Device half recorded: fetch redirect:"manual" result and WebSocket error/close code in Android WebView and WKWebView | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 13 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 13, 15, 04 (none updated yet)

## Re-run triggers

Any Access changelog entry about responses, strict service-token mode or Managed OAuth.

## What is ready, and what closing it needs

- **Ready to run:** `g03-access-responses.sh --target A` (then `--target B`) builds the credential x kind x service-token matrix into matrix-*.tsv and prints the device checklist. Target A is part of `run.sh --recheck`.
- **The maintainer must provide:** Staging account A; optionally account B (org older than 2026-10-05; without it the gate records "not available"); an expired JWT (G12) and a fresh JWT to revoke; the devices for the in-WebView half.
- **Later-phase dependency:** The in-WebView half uses the spike's MachineViewSpike and the echo origin's /expiry page, both in this branch.

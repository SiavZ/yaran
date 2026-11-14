# G13 Verified https callback (ASWebAuthenticationSession .https, Android App Link with Auth Tab / Custom Tab), and the dev-build custom scheme: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G13` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Release https callback arrives in the starting app on every platform and browser listed; the hijack APK never receives it | pending | pending |
| App Link verified on the emulator and stock Android; GrapheneOS state recorded | pending | pending |
| Cancel detectable; consent Cancel yields error=handoff_declined | pending | pending |
| Dev custom-scheme path works and its Custom Tab exposure is recorded | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 15 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 15, 14, 21, 06, 11, 17 (none updated yet)

## Re-run triggers

Chrome Auth Tab changes; iOS majors; any GrapheneOS change to App Link verification.

## What is ready, and what closing it needs

- **Ready to run:** `g13-system-browser-auth.sh` deploys workers/callback-probe on <gate-callback-host> and <cp-host>, checks the association files, allowlist, 303 shapes and CSP, then prints the device checklist. The spike has AuthSpike (Auth Tab / Custom Tab / App Link, ASWebAuthenticationSession) and the hijack module.
- **The maintainer must provide:** Staging account A; an Apple developer account (team id, bundle id with Associated Domains for applinks: and webcredentials:); the spike's debug signing certificate SHA-256; the devices (emulator with Chrome >= 137, GrapheneOS Pixel with Vanadium and Chrome, a stock Android device, Firefox, iOS 17.4 and latest); Xcode 26.
- **Later-phase dependency:** None (Phase 21 hosts the real association files).

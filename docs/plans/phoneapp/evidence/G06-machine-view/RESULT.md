# G06 A Capacitor app hosts a separate in-process native WebView with no bridge, with cookie injection, file chooser, IME and insets, and keyboard: OPEN

Not run yet. This record is the Phase 03 template with the verdict pending; the gate closes only
when a run fills it in and the decision owner and the maintainer sign it off.

- **Date / operator role / commit of tools/cloud-gates used:** pending
- **Versions:** cloudflared pending; wrangler 4.162.0 (pinned in the scripts); Capacitor 8.6.2 (spike);
  Android API / WebView M-version / browser pending; iOS + Xcode pending; account A org creation date
  (strict mode yes/no) pending
- **Procedure:** `tools/cloud-gates/run.sh G06` plus the device checklist it prints (kept as
  `run-YYYY-MM-DD/checklist.md`)

## Observations

Paste the run's `run-YYYY-MM-DD/observations.md` here. Pass criteria (Phase 03):

| Criterion | Observed | Met? |
|---|---|---|
| Bridge absent | pending | pending |
| Cookie present on the first request | pending | pending |
| Both pickers open and upload | pending | pending |
| Textarea and compose bar stay above the keyboard on every device | pending | pending |
| Safe-area insets non-zero where present | pending | pending |
| No focus lost on the first tap | pending | pending |

## Verdict and sign-off

- **Verdict:** OPEN (PASS or FALLBACK ADOPTED with its level, once run)
- **Decision owner:** Phase 15 lead, pending
- **Maintainer sign-off:** pending
- **Affected phases to update in the closing PR:** 14, 15 (none updated yet)

## Re-run triggers

A new Android WebView or iOS major; Capacitor 9 GA.

## What is ready, and what closing it needs

- **Ready to run:** `g06-machine-view.sh` stands up the machine fixture so /g6 (and ?variant=no-interactive-widget) is reachable behind Access and records each criterion per device. The spike's MachineViewSpike has fileChooser=native and imeInsets=apply toggles for the fallbacks; its manifest test pins the in-process Activity.
- **The maintainer must provide:** Staging account A; Android 15/16 (targetSdk 36, WebView >= M144), one WebView at M13x, the GrapheneOS Pixel, iOS 17.4/18/26 and iPad split view; Xcode 26 for the iOS spike.
- **Later-phase dependency:** The yaran-UI half (compose bar, key row, /api/v1/file-drop) needs yaran behind the gate tunnel (G1 step 6; Phase 11 for the live host rule).

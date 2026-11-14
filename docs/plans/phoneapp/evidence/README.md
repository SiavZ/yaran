# Phase 03 gate evidence

One directory per gate (`G01-cookie-injection/` … `G14-custom-domain/`), each holding:

- `RESULT.md`: the verdict record (template from Phase 03). It reads OPEN until a run fills it
  in and the gate's decision owner and the maintainer sign it off with PASS or FALLBACK
  ADOPTED (level named).
- `run-YYYY-MM-DD/`: what `tools/cloud-gates/run.sh G<NN>` recorded on that day: `log.txt`,
  per-step files, `checklist.md` (the device checklist as printed), `observations.tsv`, the
  same as `observations.md` (paste it into RESULT.md), and `summary.json`. A second run on
  the same day gets a time suffix.

[`TRACKING.md`](TRACKING.md) is the gate-tracking table: status, what is ready, and what each
gate still needs.

## Rules

- **Everything here is redacted.** The gate scripts pass every recorded line through
  `tools/cloud-gates/lib/redact.sh`. JWTs survive only as `<jwt aud=… exp=… iat=… iss=… type=…>`
  with the email claim replaced by `<owner>`; API, tunnel, `oauth:` and device tokens, keys,
  push endpoints and email addresses are masked; hashes appear as `sha256:<hex>`.
- **`check-evidence.sh` must pass before you commit.** It runs every text file under this
  directory through the same filter and fails, naming the file and line numbers only, when
  anything would still be masked. Phase 18 wires it into the CI aggregator.
- **Screenshots and HAR excerpts are scrubbed by hand.** The check skips binary files. Crop
  or blur tokens, cookies and email addresses out of images; pipe HAR text through
  `tools/cloud-gates/lib/redact.sh` and keep only the hops a criterion needs.
- **Naming:** keep the script's file names. Add hand-made files as
  `run-YYYY-MM-DD/<step>-<what>.<ext>` (for example `step4-set-cookie.har.txt`).
- **Never commit** a signing key, a `.p8`, an APK, or a `.env.local`.
- A gate closes in a PR that commits its `run-*/` evidence, updates `RESULT.md` and
  `TRACKING.md`, and edits every affected phase file named in its row (and `00-README.md` for
  a fallback marked **[changes Dn]**).

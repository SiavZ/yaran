# Threat Model — long-form companion

This document is the long-form companion to the STRIDE table in
[`/SECURITY.md`](../../SECURITY.md). For every row in that table we capture
the concrete attack scenario, the mitigation in code (with
file:line references taken from `docs/audits/audit02/audit02.md`), the
residual risk after mitigation, and the detection mechanism — what
shows up in `yaran.log` or `yaran-amq doctor` output when the threat
fires.

Code paths below point at the crates workspace (`crates/yaran-core`,
`crates/yaran-tui`). Line numbers from the audits refer to the older
single-crate layout, so treat them as hints and search by symbol.

The audit reports in `docs/audits/` are point-in-time snapshots.
This file and `SECURITY.md` are the living artifacts and must be
updated whenever new attack surface is added.

---

## T1 — Malicious repo executes through permission, sandbox, or hook-trust bypasses

**Attack scenario.** An operator clones a third-party repository
and opens a `yaran` pane. The repo contains a `.claude/`
configuration, a poisoned README, or a doc string that prompt-injects
the running Claude session. Because the wrapper previously passed
`--dangerously-skip-permissions` to `claude` and
`--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust` to `codex` by
**default**, the injected payload runs arbitrary commands inside
the operator's Linux account: exfiltrating `~/.claude/.credentials.json`,
reading `~/.ssh/id_*`, or launching reverse shells. This is the
worst-case configuration for the entire 2025–2026 CVE class
(CVE-2025-59536, CVE-2026-21852, CVE-2026-25723, CVE-2026-33068,
CVE-2026-35020/35021/35022).

**Mitigation in code.** Permission and sandbox bypasses are off by
default. An operator who knowingly accepts the risk enables the
per-session `yolo_permissions` setting. Yaran maps that setting to
`CLAUDE_AMQ_YOLO=1` or `CODEX_AMQ_YOLO=1` for wrapper providers and to
OpenCode's native `--auto` launch argument; OpenCode receives no such
argument when the setting is false. Codex hook trust review is a
separate control and remains enabled even in YOLO mode. Disabling that
review requires the explicit `CODEX_AMQ_BYPASS_HOOK_TRUST=1` opt-in in
`yaran-amq/wrappers/codex-amq`. The wrappers also fail closed below the
reviewed provider-CLI floors (Claude 2.1.163, Codex 0.39.0, Gemini
0.39.1), including when a version string cannot be parsed.

**Residual risk.** Operators who set the YOLO or hook-trust-bypass env
vars globally (e.g. in `~/.bashrc`) re-create the affected part of the
original posture. Likewise,
prompt injection that targets the upstream provider's own
sandbox-bypass primitives is out of our control.

**Detection.** Each wrapper prints a warning when its dangerous opt-in
is active. The Codex warning distinguishes sandbox bypass from hook
trust review bypass so the operator can see which control was disabled.
For OpenCode, the enabled YOLO checkbox remains visible in session
settings and the PTY launch debug log includes `--auto`. An unsupported
or unknown wrapper-provider version is refused with the required minimum
in the error message.

---

## T2 — Compromised AMQ peer spoofs `--me <other>` and injects text

**Status: accepted-risk in single-user-VM mode.** The Phase 08
HMAC mitigation is preserved as opt-in but no longer the default.
The full reasoning lives below; the short version is that the
mitigation defends against an attacker that doesn't exist in yaran's
declared trust model.

**Attack scenario.** Two panes share `$STATE_ROOT/amq`. Pane `bob`
is compromised (e.g. via T1). It runs
`amq send --me alice <victim> "rm -rf $HOME"`. The victim pane,
configured with `--inject-mode raw`, auto-types the payload into
its underlying CLI as if it came from `alice`. The receiver has no
way to verify the sender; AMQ wrappers
(`claude-amq`, `codex-amq`, `gemini-amq`) trust whatever
`--me` claims.

**Why the original Phase 08 HMAC mitigation does not actually defend
this surface.** Phase 08 added an HMAC-signed envelope: each
`amq send` (via `yaran-amq/scripts/amq-send-signed`) reads a per-VM
secret from `$AMQ_SECRET_PATH` (default
`$HOME/.local/share/yaran-amq/amq-secret`, mode 0600) and signs the
payload + a nonce. The current YARAN2 format binds the sender, recipient,
UTC timestamp, 96-bit nonce, and base64 body. Receivers bind the signed
recipient to their actual handle, preserve body bytes, and use atomic
directory creation so simultaneous replay checks have one winner.
Implementation-wise this works as designed.

But the trust model in [SECURITY.md](../../SECURITY.md) explicitly
states: *"yaran runs as a single-user, single-Linux-account TUI. All
panes spawned by yaran share the same `$HOME`, the same filesystem
permissions, and the same environment. There is no in-VM isolation
between panes. One compromised pane = one compromised user account."*

Inside that model, every "peer" is a process running as the same
Linux user. Same-UID processes can:

- `cat $HOME/.local/share/yaran-amq/amq-secret` and forge envelopes
  with valid MACs (the secret is mode 0600 by the same UID).
- `ptrace` the signing process and read the secret from memory.
- `LD_PRELOAD` the signer to substitute the body before signing.

Per Linus Torvalds's canonical position ([Debian thread, 2014](https://linux.debian.devel.narkive.com/66QPZz2A/using-sgid-binaries-to-defend-against-ld-preload-ptrace)),
*"there is a complete lack of a security boundary between processes
of the same user."* The MIT 6.828 OS-security course
([2008 lecture](https://pdos.csail.mit.edu/6.828/2008/lec/l-security.html))
makes the same point. T2's mitigation defends a boundary that
Linux itself does not enforce.

A second, concrete cost surfaced in production: enforcing strict
verification at the receiver silently dropped every legacy
`amq send` body that hadn't been wrapped through `amq-send-signed`.
Most senders don't go through the signed path — the skill teaches
plain `amq send` and the upstream AMQ binary has no signing
support — so the mitigation broke the steady-state flow without
adding a meaningful defense.

**Mitigation in code (current).**

- The bridge defaults to **skip mode**: it byte-safely decodes a
  `YARAN2\t...` envelope when present, retains YARAN1 compatibility for
  already queued messages, and treats plain bodies as raw. No HMAC check.
- Strict mode is opt-in via `[amq.inject].verify_envelope = true`
  in yaran's `config.toml`. yaran exports `YARAN_AMQ_VERIFY=1` to
  spawned PTYs at bootstrap; the bridge calls
  `amq-receive-verify`; unsigned, misaddressed, replayed, stale, and
  MAC-mismatched envelopes are dropped silently. Reserved for environments that genuinely
  cross a trust boundary — proxying wakes across hosts, mixed-trust
  agents under the same UID via setuid shims, etc.
- The `amq-send-signed` and `amq-receive-verify` tooling is kept
  in the overlay and is exercised by the bats suite.
- The per-VM secret at `$AMQ_SECRET_PATH` is still initialised by
  `amq-secret-init.sh` so opt-in works out of the box. To rotate,
  `rm` the file and restart every pane.

**Residual risk.** In skip mode (the default), any peer process
running as the same Linux user can write to another peer's AMQ
inbox with a forged `--me`. This is concretely no worse than what
the same peer could already do via `ptrace`/`LD_PRELOAD`/direct
filesystem access against the signer in strict mode — the
boundary doesn't exist in either case. In strict mode, the residual
risk is the original Phase 08 risk: attackers with read access to
`$AMQ_SECRET_PATH` can still forge.

**Detection.** When strict mode is active, rejected envelopes are
written to `$AMQ_GLOBAL_ROOT/agents/<me>/.wake.log` by
`amq-receive-verify`'s stderr. yaran's main JSON log records every
delivered wake under `target: "yaran::amq_inject"` for the
post-bridge half of the path; the bridge itself stays silent on
the happy path so AMQ's `--inject-via` retry contract is preserved.

**Reverting accepted-risk status.** If a future deployment lands
in a context where `same-UID` does become a meaningful boundary
(e.g. a setuid-segregated multi-tenant variant of yaran), this
section must be updated and `verify_envelope = true` shipped as
the default. `[amq.inject].verify_envelope` was named
deliberately so the policy flip is a one-line config change.

---

## T3 — Tampered `amq` binary `eval`'d on every shell

**Attack scenario.** `bashrc-additions.sh` runs
`eval "$($AMQ_BIN shell-init)"` on every interactive shell. If an
attacker swaps `~/.local/bin/amq` for a malicious binary, every
new shell executes attacker-controlled output as code with the
operator's permissions — silent persistence.

**Mitigation in code.** Phase 02 pins the sha256 of the trusted
binary in the bashrc fragment
(`bashrc-additions.sh:17-32`). Before the `eval`, the fragment
recomputes the binary's hash and refuses to run if the hash
doesn't match the recorded value. Phase 02 also closes the
fail-open hole from P1-E: a missing `binary.sha256` record now
fails closed with a red banner instead of silently allowing the
eval.

**Residual risk.** A root attacker can edit both the binary and
the recorded sha simultaneously. Operators on multi-user hosts
should additionally `chmod 0444` the wrapper and own it by root.

**Detection.** A mismatch prints
`AMQ binary integrity check failed — refusing to load` on every
new shell, and the same line appears in `yaran.log` when `yaran-amq
doctor` runs. The doctor's `amq.binary` section displays the
expected vs actual sha pair.

---

## T4 — Spot-VM preemption mid-sqlite write

**Attack scenario.** yaran runs on a GCE spot VM. The VM is
preempted while `crates/yaran-core/src/storage.rs` is mid-transaction on
`sessions.sqlite3`. Because the database opened with the default
rollback journal and no `synchronous=NORMAL`/WAL settings
(`storage.rs:22`), the operator returns to find a session row
attached to the empty-string project (`storage.rs:209`),
half-written agent rows, or a corrupt header. Loss of session
metadata also breaks auto-resume (T12).

**Mitigation in code.** Phase 14 sets
`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` on every
open and runs `PRAGMA integrity_check` once per launch. A
periodic `.backup` copies the DB to
`sessions.sqlite3.bak` so a failed `integrity_check` can be
recovered without losing more than the last backup interval.

**Residual risk.** A torn write that occurs *after* the integrity
check on launch but before the next backup still loses the
intervening transactions. Filesystem-level corruption (failing
disk) is outside the scope of WAL.

**Detection.** `yaran.log` records
`sqlite integrity_check: ok` or the failing pragma output on every
launch. `yaran-amq doctor` surfaces the same line and the age of the
most recent `.bak`. A failing `integrity_check` is the operator's
cue to restore from `.bak`.

---

## T5 — Plaintext API tokens / chat on persistent disk after VM destroyed

**Attack scenario.** The operator destroys a spot VM but the
attached persistent disk (`/data/state`) survives, gets snapshotted,
or is re-attached to a different VM. Chat JSONLs under
`/data/state/claude/projects/`, `/data/state/codex/`, and the
files in `~/.claude/.credentials.json` (symlinked into `/data/state/`)
contain PII and live API tokens, all in plaintext.

**Mitigation in code.** Phase 25 documents and tools an
operator-driven encryption playbook in
`docs/operations/encryption-at-rest.md`: the recommended pattern is
`gocryptfs` over `/data/state` for portable VMs and LUKS for
dedicated hosts. The playbook covers passphrase rotation and
recovery, and the installer detects the encryption posture and
warns when `$STATE_ROOT` is plaintext.

**Residual risk.** Anyone with the passphrase can decrypt. We do
not encrypt secrets at the application layer — the upstream
provider CLIs require plaintext credential files at runtime.
Snapshots taken *after* the disk is mounted-and-decrypted on a
running VM are still cleartext from the cloud's perspective.

**Detection.** `yaran-amq doctor`'s `encryption` line reports
`encrypted (gocryptfs)`, `encrypted (luks)`, or `plaintext — at
risk`. The installer prints the same warning at first run.

---

## T6 — Right-to-erasure: per-customer chat history can't be deleted

**Attack scenario.** A customer requests deletion of their data
under GDPR Art. 17. The operator runs the existing
`reset_agent_data` (`crates/yaran-tui/src/cli.rs`), which removes worktrees,
sqlite, and `yaran.log`. It does **not** touch
`~/.claude/projects/<encoded>/*.jsonl` or
`/data/state/{codex,gemini}/`. Every prompt and response with
potential PII survives the delete.

**Mitigation in code.** `yaran session purge --hard <target>` resolves a UUID or
immutable agent handle, and accepts a branch only when it maps to exactly one
row. For isolated sessions it cascades through the managed worktree, encoded
provider-history directories, the exact-owner AMQ inbox, session-scoped log
redaction, and finally the SQLite row. Recursive targets are resolved through
symlinks and must remain strict descendants of their category root. Whole
worktree/root removal also refuses any target that is an ancestor or descendant
of a registered project; contained-file cleanup is deliberately outside that
guard. Any failed step retains the SQLite identity for retry, and bulk purge
retains rows whose full target inventory cannot be planned.

Shared sessions never remove the registered checkout. Per-session provider
history cannot be honestly attributed because sibling Yaran sessions and non-Yaran
conversations use the same provider directory. The default plan therefore
reports an explicit `INCOMPLETE` item and retains the row, while still erasing
provably owned AMQ and log records. The operator may explicitly accept residual
provider data, or confirm a workspace-wide purge that covers every Yaran session
on that canonical path. The latter deletes the shared provider directory and
therefore also deletes non-Yaran conversations stored under the same workspace.
`PURGE ALL` is not workspace-wide provider-history consent: bulk purge retains
shared provider history and its recovery rows while reporting them incomplete.

`yaran config reset --all` loads config, active rows, tombstones, durable store
identity, and the complete registered-project inventory before its first
destructive step. It aborts on any incomplete/corrupt inventory, frees every
exactly-owned AMQ inbox before deleting SQLite, and never removes a shared
session's registered checkout. The error names the failed file or row; repair
or restore it and retry. If identity cannot be restored, associated AMQ and
filesystem data requires manual ownership verification before metadata removal.

**Residual risk.** Backups (sqlite `.bak`, OS-level snapshots, disk encryption
snapshots) still contain the data and must be purged out-of-band. A shared
per-session purge that accepts residual data intentionally leaves provider
transcripts and reports that fact in its purge summary.

**Detection.** Each successful purge logs `session purged
session_id=<id> files=<n> bytes=<m>` at INFO. `yaran-amq doctor
--anonymize` reports the count of purges in the last 24 h, which
the operator can use as a GDPR audit trail.

---

## T7 — Cross-store or normalized wrapper identity collision

**Attack scenario.** Two YARAN_HOME stores share one AMQ root and independently
allocate the same normalized handle, or a standalone wrapper/path marker
already occupies that physical `agents/<handle>` key. An unlocked
read-modify-write can also lose one writer's `config.json` registration. Either
case can redirect delivery or let one store prune another store's identity.

**Mitigation in code.** Every YARAN_HOME has a durable `store-id`. Yaran persists
the session UUID and handle before provider launch, then Rust and all three
wrappers use the same mandatory `flock` on `meta/config.lock` for complete
owner-marker and registry updates. The atomic marker binds `store_id` and
`session_id`; reconciliation prunes only missing/deleted rows owned by its own
store. Foreign, standalone, malformed, ownerless, and ambiguous legacy keys
are never reclaimed. Creation/backfill instead allocates a bounded `-2`,
`-3`, … suffix while the lock is held. Wrappers use AMQ's guarded
`wake recover-owner` before launch so a dead exact-owner claim cannot make a
restart permanently fail; AMQ refuses that operation while the owner is live.

**Residual risk.** This is coordination, not an authorization boundary:
same-UID code can edit the shared root or lock it indefinitely. That remains
inside the declared single-user VM threat model. A provider launched outside
an AMQ wrapper has no owner-bound wake, so deletion can reserve/remove its
registry identity but has no notifier process to manage.

**Detection.** Missing lock support and owner mismatches fail closed with an
explicit wrapper or `yaran::peer` error. `amq doctor --ops` reports managed-wake
health. A recycled legacy wake PID that no longer identifies `amq wake` is
logged and left untouched.

---

## T8 — Log injection via PTY content into `yaran.log`

**Attack scenario.** Producers feed unfiltered byte streams into
`logger.rs:84-92`: `String::from_utf8_lossy(&output.stderr)` from
`crates/yaran-core/src/git.rs`, GitHub PR titles via `gh pr view`,
`/proc/<pid>/comm` from `pty.rs:521-525`, arbitrary user paths.
A hostile branch name, PR title, or process name with embedded
ANSI/OSC/DCS bytes lands verbatim in `yaran.log`. When the operator
runs `tail yaran.log` or `less yaran.log`, those bytes execute as
terminal escapes: OSC 0/2 rewrites the terminal title, OSC 8
drops a covering hyperlink, OSC 52 paste-injects clipboard, DCS
sequences can corrupt subsequent rendering. Same incident class
as Rails CVE-2025-55193.

**Mitigation in code.** Phase 03 introduces
`for_terminal(s: &str) -> String` (lives in
`crates/yaran-core/src/sanitize.rs`) which strips
`[\x00-\x08\x0b-\x1f\x7f\x1b]`. Every `logger::*` call and every
`set_error`/`set_info` status-line writer (`crates/yaran-tui/src/app/workers.rs`,
`crates/yaran-tui/src/app/sessions.rs`, `crates/yaran-tui/src/app/input.rs`) now routes through
the sanitizer. The 17 `git.rs` `anyhow!` sites listed in P0-C
are wrapped at the consumer side.

**Residual risk.** Bytes that escape the regex (legitimate UTF-8
that happens to look adversarial when mis-rendered) can still
confuse a viewer that interprets the file as something other than
plain text. Operators who `cat yaran.log` into a tool that
re-escapes are on their own.

**Detection.** The sanitizer replaces each stripped byte with its
`\xNN` hex form (see `for_terminal`), so a hostile payload stays visible
in `yaran.log` as escaped bytes rather than vanishing. A spike in those
escapes is the signal that something upstream is producing hostile
content. `doctor` does not currently surface a count; tracked
for a future iteration.

---

## T9 — Resource exhaustion: no PTY/memory caps

**Attack scenario.** A user (or a buggy auto-resume — see T12)
spawns 100 panes. Each pane is ~1 MB of grid + ~100 MB of chat
process RSS. Within a minute the host OOMs. There is no per-pane
memory cap and no PTY-count cap.

**Mitigation in code.** Phase 16 adds a `[limits]` config block:
`max_panes` (default 0, no hard cap), `max_panes_soft_warn`
(default 16, warns without blocking), `max_companion_terminals`
(default 0, no cap), `max_total_scrollback_mb` (default 256), and a
pair of disk thresholds (`disk_high_water_pct` default 95, which
refuses new agents; `disk_warn_pct` default 80, which warns). The
agent-creation path (`crates/yaran-core/src/engine/command.rs`, via
`Engine::refuse_agent_spawn_for_limits` and `soft_warn_for_pane_count`)
consults the caps and refuses with a status-line error when a hard cap is
set and exceeded. A disk watchdog refuses new agents at the high-water mark.

**Residual risk.** A fork-bomb inside an existing pane (`while :;
do bash & done`) is invisible to yaran's pane counter — that's an
OS-level concern. Per-pane RSS is not bounded; we count panes,
not megabytes.

**Detection.** `yaran.log` records the refusal message from
`LimitsConfig::refuse_agent_spawn` at WARN, naming the knob that
blocked the spawn (`limits.max_panes = N` or
`limits.disk_high_water_pct = N%`) and the way out. `doctor` reports
disk usage of the state root.

---

## T10 — DoS via AMQ inbox flood

**Attack scenario.** A compromised pane (or a buggy script)
sends 10 000 small messages to a victim pane in a tight loop.
Each message is a small file under
`$STATE_ROOT/amq/<victim>/inbox/`. Even at a few hundred bytes
each, 10 000+ files exhaust inodes on default ext4 small-inode
filesystems and slow every directory listing.

**Mitigation in code.** Phase 16 adds a local inode-usage
watchdog: when the AMQ root exceeds 80% of available inodes the
TUI drops a status-line warning and `doctor` flags the
filesystem. Rate limiting per sender is tracked upstream with
the AMQ project; we coordinate via the shared issue tracker
referenced in Phase 16's plan.

**Residual risk.** The local watchdog is reactive, not
preventive — a fast attacker still exhausts inodes between
checks. A real fix requires upstream rate limiting in `amq`
itself.

**Detection.** `yaran.log` logs
`amq: inbox <handle> reached <n> messages` at WARN every 1 000
messages. `doctor`'s `amq queue depth` and `oldest message age`
fields surface the flood.

---

## T11 — Symlink swap of `~/.claude` → attacker dir

**Attack scenario.** `~/.claude` is a symlink to
`/data/state/claude` on persistent-disk VMs. An attacker with
write access to `$HOME` (e.g. via T1) replaces the symlink with
one pointing into an attacker-controlled directory containing
forged `.credentials.json`, forged `projects/`, and a poisoned
`skills/` tree. On the next yaran launch every spawned `claude`
pane reads attacker-controlled credentials and skills.

**Mitigation in code.** **Planned, not yet implemented.** The
audit lists this as `future`. The intended mitigation is a
launch-time check in `yaran-amq doctor` and the yaran startup path
that resolves `~/.claude` and refuses to launch (or warns
loudly) if the resolved target is not the recorded canonical
path. Until then, `SECURITY.md` documents this as a known gap.

**Residual risk.** Until the check ships, this threat is
unmitigated. Operators on shared hosts should
`chattr +i ~/.claude` after install.

**Detection.** `yaran-amq doctor`'s Symlinks section already prints
each of `~/.claude`, `~/.agents`, `~/.codex`, `~/.gemini` with its
target and warns when the target is not under the state root (or the
entry is not a symlink at all). Comparing the recorded canonical path
against a launch-time check remains future work.

---

## T12 — Auto-resume thundering herd on spot-VM reboot

**Attack scenario.** A spot VM is preempted with 50 active yaran
sessions. On reboot, the startup relaunch pass
(`Engine::queue_startup_launches` + `Engine::pump_startup_launches`)
would fire every session's PTY spawn and TLS handshake at once: API
rate-limit responses, exhausted file descriptors, and OOM during the
resume burst — which itself triggers another preempt-resume cycle.

**Mitigation in code.** Phase 15 introduces a bounded scheduler
(`crates/yaran-core/src/auto_resume.rs`) driven by the `[auto_resume]`
config block: `concurrency` (default 4) caps startup launches in
flight, `stagger_ms` (default 250) spaces two dispatches apart, and
`stale_days` (default 30) skips agents whose directory went untouched
for that long, so a cold session is resumed lazily on operator focus
instead of during the burst.

**Residual risk.** A correctly tuned cap still spends bursts of
CPU when the user has many fresh sessions. The
`stale_days` default is a heuristic; operators
running long-lived sessions may need to raise it.

**Detection.** Per-session outcomes surface as status lines
through `pump_startup_launches`. `doctor` shows detached and
exited session counts.

---

## T13 — Watch-rule regex evaluated on attacker-influenced PTY output

**Attack scenario.** Phase 26 introduces user-configurable watch
rules under `[[providers.<name>.watch]]` in `config.toml`. Each
rule pairs a regex against the agent's terminal output with an
action — `send_text` (Phase 1) writes bytes back into the agent's
PTY when the regex matches, and `wait_until_capture` (Phase 2)
does the same after waiting until a parsed time captured from the
matched text. Both variants ultimately write attacker-influenceable
bytes back into the agent. Two distinct abuse paths follow:

1. **Regex DoS.** An attacker (a malicious project the agent is
   editing, or an upstream prompt-injection that gets the model to
   print specific text) crafts a payload that triggers pathological
   regex behavior, freezing the UI thread on every render tick.
2. **Spurious-fire.** An attacker crafts output that *legitimately*
   matches the user's rule, causing yaran to write the rule's
   `text` (e.g. `"please continue"`) back into the agent. For the
   shipped default this only resumes a Claude conversation, but a
   user with a custom rule (e.g. an "auto-yes" pattern) could be
   tricked into auto-confirming dangerous actions.

**Mitigation in code** (`crates/yaran-core/src/watch/`, `crates/yaran-tui/src/app/mod.rs`).

- *Linear-time matching.* Rules compile via the `regex` crate's
  NFA engine, which is guaranteed linear in input length —
  catastrophic backtracking is not possible regardless of pattern
  shape.
- *Pattern complexity cap.* `RegexBuilder::size_limit(64 KiB)` and
  `dfa_size_limit(64 KiB)` reject oversized programs at load time;
  the bad rule is logged and skipped, leaving the rest of the
  config intact.
- *Rule cap per provider.* `MAX_RULES_PER_PROVIDER = 32` so a
  malicious config (or a supply-chain compromise of the canonical
  template) cannot DoS via thousands of rules.
- *Per-rule fire budget.* Every rule has a `budget.max_attempts`
  (default 5; `0` means explicitly unlimited). When exhausted, the
  rule disarms itself for the rest of the session and emits a status
  warning. Spurious-fire attacks therefore cap at `max_attempts` rule
  firings unless the operator deliberately marks that rule unlimited.
- *Cooldown between repeats.* `cooldown_ms` and the
  `baseline_match_count` dedup mean stale matches still visible in
  scrollback do not re-arm the rule. A single attacker payload
  cannot fire more than once per occurrence.
- *Opt-in defaults.* The canonical config template ships every
  example rule **commented out**. A fresh install has zero active
  watch rules; users explicitly uncomment to enable.
- *Active-pane suppression.* `App::tick_watch_engines` skips
  effects when the user is interactively typing in the matched
  session, so an auto-action does not arrive in the middle of the
  user's prompt.
- *Manual disarm.* `WatchEngine::disarm` (Phase 3 palette command)
  lets users immediately silence a rule that misfires.

**Residual risk.** A user who configures a permissive rule (e.g.
`text = "yes"`, `pattern = "Continue\\?"`) opts into the spurious-
fire risk for that rule's `max_attempts` budget, or unbounded risk if
they set `max_attempts = 0`. We document this
in the canonical-config comment block above the example. Watch
rules **never** evaluate during oneshot mode (commit-message
generation), only during interactive PTY sessions in
`SessionState::Live`.

**Detection.** `yaran.log` records
`watch rule load error` at WARN whenever a rule fails to compile
(regex too big, malformed, etc.) and
`watch send_text failed` at WARN if a PTY write fails after a
rule fires. The status line surfaces every rule fire
(`watch rule "X": fired (attempt N/M)` or `N/unlimited`) and budget exhaustion
(`watch rule "X": budget exhausted; disarming`).

---

## T14 — Malicious file in `~/.local/share/yaran-amq/inject-queue/` injects unauthorised text into a yaran session

**Attack scenario.** yaran's drainer (`crate::amq_inject` and
`crate::app::inject_runtime`) reads files from a per-receiver
queue under `~/.local/share/yaran-amq/inject-queue/<receiver>/<ts>.msg`
and types each body into the matching session's PTY. An attacker
with same-UID write access to the queue dir — i.e. anyone running
as the yaran operator (per the trust model T2 already concedes) —
can drop a hand-crafted `.msg` file. The drainer would type it
into whichever session matches the parent directory name, with
`\r` to submit. Concretely: drop
`inject-queue/payment-ms-engineer/666.msg` containing
`yes, run rm -rf` and the message would land in the
payment-ms-engineer session as if it had been routed through AMQ.

This is a derivative of T2 — same trust boundary — but lands in
the agent's input field rather than the AMQ inbox, so it bypasses
any agent-side filtering on AMQ message metadata.

**Mitigation in code.** The drainer rejects:

- Files larger than `[amq.inject].max_message_bytes` (default 64
  KiB). A legitimate wake notification is ~150 bytes; the cap stops
  a forged multi-megabyte body.
- Symlinks. `fs::symlink_metadata` is checked before `read_to_string`,
  so symlink swaps under TOCTOU don't escape the queue root.
- Receiver subdirectories that don't match the wrapper's
  sanitisation regex (`[a-z0-9_-]+`, no `..`, no leading dash).
  Anything else is logged at WARN and skipped.
- Inflight files left behind by a crashed prior yaran instance are
  reclaimed at startup (renamed back to `.msg`); bridge-format
  `mktemp .inflight.XXXXXX` files (no `.msg` suffix) are skipped
  on purpose so a concurrent in-progress write isn't corrupted. If a
  producer has recreated the original `.msg`, the stranded inflight is
  moved to a unique `.expired/` quarantine name. Claims themselves use
  a no-replace rename, so a quarantine failure cannot turn a later scan
  into an overwrite of either body.

The bridge runs `amq-receive-verify` (HMAC + freshness + replay)
ahead of writing the queue file *only* when strict mode is opted
into (see T2). In skip mode (the default), unsigned bodies pass
through. This is consistent with T2's accepted-risk reasoning:
defending the queue against same-UID writers requires defending
the agent's PTY against same-UID writers, which is not a boundary
Linux gives us.

**Residual risk.** Same-UID code can already type into the
session's PTY directly via `ioctl(TIOCSTI)` (where supported) or
by writing to `/proc/<pid>/fd/0`, so the queue is not adding new
attack surface beyond what the OS already provides at this trust
level. The size cap and symlink check exist primarily to keep the
drainer's *own* failure modes bounded — operator error and
filesystem hiccups — rather than to harden against a hostile peer.

**Detection.** Rejections log at WARN under
`target: "yaran::amq_inject"` with `path` and `reason` fields.
Successful deliveries log at INFO with a body preview. The
status line surfaces "no session matches receiver X" warnings
(rate-limited to once per minute per receiver) when a queued file
can't be routed.

---

## T15 — Tampered `agent_sessions.session_settings` blob escalates a session into autonomous mode

**Vector.** An attacker (or a buggy version of yaran itself) writes a
malformed JSON value into `agent_sessions.session_settings`, or
crafts one that explicitly enables `yolo_permissions: true` /
`mode: worker` / `auto_clear_on_task_done: true` /
`auto_compact_on_compact: true` for a session the
operator never opted in. On the next yaran launch — or the next time
that session re-spawns — those settings would normally drive a
provider bypass (`CLAUDE_AMQ_YOLO=1` or OpenCode's `--auto`), AMQ
postscript injection (asking the agent to emit `[task-done]`), and
the built-in auto-clear and auto-compact watch rules.

The attacker model is the same as T1 / T14: same-UID code with
write access to `~/.yaran/sessions.sqlite3`. The novelty is that the
sqlite blob is now load-bearing for autonomous behaviour, which
makes the parser the primary attack surface.

**Mitigation in code.** Asymmetric-default policy at the parse
boundary:

- `SessionSettings::parse_or_default(raw)` (in
  `crates/yaran-core/src/session_settings.rs`, called by
  `SessionStore::load_session_settings` in
  `crates/yaran-core/src/storage.rs`)
  returns `Self::default()` for `None`, empty string, or any blob
  that fails `serde_json::from_str`. The fallback emits a WARN
  carrying the parse error so post-hoc forensics can see what was
  rejected.
- `SessionSettings::default()` is the safe everything-off shape:
  `mode = Attended` (no postscript, no auto-clear),
  `yolo_permissions = false` (no CLI flag, no env var),
  `watch_rule_arm = {}` (no overrides),
  `auto_clear_on_task_done = false` (asymmetric: even Worker mode
  requires the operator to tick the box explicitly),
  `auto_compact_on_compact = false` (the same asymmetry, as its own
  box), `compact_instructions_path = None` (inherit the global path),
  and
  `verify_envelope_override = None` (inherit the global config
  default).
- Every consumer reads through this filter. PTY launches compose the
  environment through
  `crates/yaran-core/src/agent_env.rs::agent_launch_env` (which layers
  `SessionSettings::to_pty_env` on the Yaran identity variables), and
  `crates/yaran-core/src/amq/delivery.rs::apply_inject_postscript`
  consults the session's mode for the postscript decision. None of
  those paths read the raw column text directly.

A successful tamper that produces *valid* JSON enabling autonomous
behaviour requires the same write access an attacker already needs
to type into the PTY directly (T14 residual). The defence here is
limited to keeping the *parser* a deterministic, fail-safe
chokepoint so a malformed blob can never produce surprising
defaults — not to defending against a same-UID attacker who has
lawful access to the database.

**Residual risk.** Same-UID code with write access to
`sessions.sqlite3` can plant valid JSON enabling YOLO. The
mitigation is operator awareness via the modal (the operator can
inspect any session's settings at a glance) and the existing
T1/T14 chain. A future hardening would be SQLCipher with an
operator-derived key, currently tracked under T5
(encryption-at-rest playbook).

The auto-compact rule adds one input the blob can steer:
`compact_instructions_path` names a file whose text yaran types into
the agent's prompt, which sends it to the provider. A planted path
could name any file the user can read. That gives a same-UID attacker
nothing they lack (they can read the file themselves), but a mistyped
path by the operator would send the wrong file's text to the model.
The read is bounded: it only happens for a Worker session that ticked
auto-compact, it refuses files over 8 KiB and non-UTF-8 content
(falling back to a bare `/compact` with a `[watch]` WARN in yaran's
log naming the path), and it drops control characters so file content
cannot act as keystrokes in the terminal.

**Detection.** Malformed-blob rejections log at WARN under
`yaran::session_settings` with the raw input. Settings-driven
decisions (env var set, postscript appended, built-in rule
attached) log at DEBUG under the same target so an operator
running with `RUST_LOG=yaran::session_settings=debug` can audit
which session enabled what.

---

## T16 — Shared-workspace provider mutates the registered checkout

**Attack scenario.** Shared-workspace mode deliberately launches a provider in
the user's registered checkout rather than a Yaran-owned worktree. A surprising
default change could expose an existing installation to writes it previously
expected to be isolated. If Yaran later confused that checkout with a managed
worktree, automatic branch, cleanup, or link operations could also mutate the
real repository.

**Mitigation in code.** Workspace consent is represented by section presence:
an existing config with no `[workspace]` table resolves to `worktree`, while a
fresh canonical config writes `default_mode = "shared"` explicitly. A
per-project override can restore isolation. Before registration, creation, and
reconnect, shared paths are canonicalized and rejected when they resolve under
the Yaran state or worktree roots. The creation modal identifies shared mode and
shows the real checkout path. Persisted `shared_workspace` state, rather than
path equality or the current project default, gates lifecycle behavior: shared
sessions set neither worktree nor branch ownership, do not create the repository
link. Shared auto-resume remains opt-in; when enabled it selects only the exact
captured provider UUID and never a latest/recency selector. A missing or invalid
UUID starts fresh and is captured before it can become resumable. Fork is an
explicit isolation boundary and always creates a worktree.

**Residual risk.** Running a provider in a real checkout grants it the same file
permissions as the operator and is the purpose of shared mode; Yaran is not a
sandbox. Shared writers use one index and staging area: one writer can stage,
unstage, commit, discard, or overwrite another's changes and can switch the
branch beneath every sibling. Another `YARAN_HOME` and unmanaged same-UID
processes cannot be observed reliably. Operators who need independent changes
must use worktree mode or Fork.

**Detection.** The create modal and completion status identify shared sessions,
and starting a second writer visible to the current store requires an explicit
confirmation. A persistent header warning is derived from live session state
on every render and is deliberately labeled `CURRENT STORE ONLY`; it does not
claim visibility into other stores or unmanaged processes. The database retains
`shared_workspace = 1`, and eligibility failures are shown before provider
launch. Branch and PR status are derived from the checkout's live HEAD so Yaran
does not present a stale per-session branch as authoritative.

---

## T17 — Orphan cleaner removes user work

**Attack scenario.** A broad directory scan could mistake a crash residue,
user-created worktree, main checkout, or worktree still represented by a
soft-deleted session for an orphan and remove uncommitted work or its branch.

**Mitigation in code.** Cleanup is a command-palette action and never runs at
startup or when workspace mode changes. Before offering any item it loads the
complete config and protected-project inventory, durable store identity, all
session rows including tombstones, and every registered project's
machine-readable `git worktree list`; any failure aborts before removal. A
candidate must be a Git-registered non-main worktree whose canonical path is a
strict descendant of `worktrees_root` and has no matching row. Dirty/untracked
state is displayed, every item has its own confirmation, and branch deletion is
off by default. Execution revalidates the complete inventory and calls the
central protected-workspace guard before `git worktree remove`.

**Residual risk.** Under the single-user, single-UID VM model, the operator or a
same-UID process can change a worktree after inventory and before Git removes
it. The per-item warning reports the last inventoried dirty state; operators
must review it before confirmation.

**Detection.** Inventory and fail-closed errors use the
`yaran::orphan_worktrees` tracing target. The modal displays the exact sanitized
path, branch, and dirty status and returns to the remaining candidate list after
each removal.

---

## T18 — Provider-history recovery assigns or copies the wrong conversation

**Attack scenario.** Startup recovery and fresh Codex capture read JSONL files
outside `$STATE_ROOT`, under `~/.claude/projects` and `~/.codex/sessions`. A
forged transcript could claim another worktree CWD so Yaran associates one
agent's conversation with another. A symlink or special file could redirect a
Claude copy, an existing destination could be overwritten, or a large provider
tree could exhaust memory, CPU, or inodes. Concurrent fresh Codex launches in
one shared CWD could also race and swap their newly-created rollout UUIDs.

**Mitigation in code.** `crates/yaran-core/src/resume_recovery.rs` reads provider originals and
never moves, edits, or deletes them. Recovery accepts only regular JSONLs with
valid UUIDs and an absolute recorded CWD that is exactly
`<historical-worktrees-root>/<registered-project-name>/<agent-dir>`. It checks
the session's stored project path against the registered project, normalizes the
old basename with the same immutable agent-handle rules used at creation, and
requires the provider/project/handle match to be unique. Ambiguous matches are
reported and left unmapped. Scans have file-count and per-line size bounds.

For Claude, only matched `<uuid>.jsonl` files and their matching `<uuid>/`
companion directories are copied. Sources and recursive children must be plain
files/directories; symlinks and special files fail closed. Each destination is
built under a unique temporary name, flushed, and installed with a no-replace
atomic rename, so an existing history is never overwritten and originals are
retained. For Codex, fresh capture snapshots all existing rollout UUIDs before
launch and accepts one new UUID only when its first `session_meta` record has
the expected canonical CWD. Uncaptured launches are serialized per canonical
CWD; zero or multiple candidates time out or fail closed and block another
uncaptured launch in that CWD rather than guessing. All diagnostics sanitize
provider-controlled fields under the `yaran::resume_recovery` tracing target.

While a Claude agent runs, yaran also follows it onto the conversation it is
actually in (a `/clear` or `/resume` moves it to a new UUID) by reading Claude
Code's own per-process record, `~/.claude/sessions/<pid>.json`, every 20
seconds on a worker. A record is used only for the agent's own PTY child pid,
only when it was written no earlier than that process started (so a record left
by a crashed process whose pid was reused is ignored), only for an interactive
session, and only when its id is a valid UUID; reads are size-bounded, and a
newer capture recorded while the read ran always wins. The conversation may be
recorded under another directory when the agent's own pane `/resume`d it from
there; a relaunch then continues it in the agent's directory under a new id,
and the original transcript is only read. Resuming checks that the transcript
exists in the agent's project or, failing that, in another Claude project, so
a missing id still never silently starts a blank conversation.

**Residual risk.** The documented trust model grants same-UID processes access
to both provider roots. Such a process can race filesystem names or forge one
otherwise-valid transcript during the capture window; Yaran is not a security
boundary against a fully compromised Unix account. Ancestor symlink replacement
under `~/.claude` remains the broader T11 gap. The generous scan bounds limit,
but do not eliminate, startup I/O from a very large legitimate history.

**Detection.** Startup logs the number of recovered mappings, copied artifacts,
and refused candidates. Capture timeout, ambiguity, persistence failure, and
blocked-CWD events emit warnings and a status-line warning; SQLite retains the
exact provider UUID used for future resumes.

---

## T19 — Selected NTL provider can send prompts off-host or act as the operator

**Attack scenario.** An operator selects the built-in NTL provider. The
third-party CLI can send prompts and workspace context to its service, and
agent mode can request file writes or commands with the same Unix permissions
as Yaran.

**Mitigation in code.** NTL is only a default configuration entry: Yaran neither
installs it nor launches it until the operator selects it. Interactive sessions
invoke the official executable as `ntl --agent`; one-shot commit-message work
uses `ntl --chat --no-color -p <prompt>` so it cannot inherit agent mode from
the CLI's persisted preferences. Yaran has no NTL adapter, private API access, or
credential handling, and declares no unsupported resume behavior.

**Residual risk.** Yaran is not a sandbox. Once selected, NTL and its remote
service receive whatever the official CLI sends and any approved agent action
runs as the operator. NTL's binary, service, authentication, approvals, and
data handling remain upstream responsibilities.

**Detection.** NTL appears by name in the provider selector and generated
configuration. It is never selected silently; the session header shows the
active provider, and removing or overriding `[providers.ntl]` disables it.

---

## T20 — jcode provider self-updates, swarms, or reaches fleet messaging via inherited MCP

**Attack scenario.** An operator selects the built-in jcode provider. The
third-party CLI auto-updates its own binary by default on release builds,
spawns headless sub-agent swarms and a shared background `serve` daemon that
outlives individual panes, and loads the operator's user-scope MCP servers —
including fleet-messaging servers such as claude-peers — giving the agent a
path to message other agents under the operator's identity.

**Mitigation in code.** jcode is only a default configuration entry: Yaran
neither installs nor launches it until selected. The `jcode-amq` wrapper fails
closed below a reviewed version floor and probes the version with
`--no-update` so the probe itself cannot swap the binary. Every wrapped launch
has `--no-update` force-injected (and `resume_by_id_args` repeats it, since
resume args replace base args), pinning the pane's binary for the PTY's
lifetime. Subcommand invocations (`run`, `usage`, `telemetry`, ...) bypass
identity and wake claims, so oneshot work cannot register or hold an AMQ
handle. The wrapper's contract (`--no-update`, `--resume [<id>]`,
`run --quiet`, `debug -S <session> client:message` / `clients:map`, and the
`recent_sessions` table in `session-metadata-v1.sqlite3` that auto-resume
reads) has been verified through jcode v0.88.0.

Wrapped sessions use the same owner-bound co-op wake, flock-guarded
registration, and inject-bridge verification path as the other wrappers.

**Operator note: upgrading jcode under a running fleet.** The shared `serve`
daemon keeps the old executable mapped after the files on disk are replaced,
so panes attached to it keep running the previous version. jcode's own
`server reload` compares binary timestamps and, once the old file is deleted
or renamed away, reports "already the newest binary" and does nothing;
`jcode --no-update server reload --force` performs the graceful in-place
handoff (same pid, live sessions preserved). `jcode server stop` without
`--force` is refused by jcode, and with it kills every attached pane; check
`jcode debug clients:map` first. Replace whatever the release ships for the
platform (a launcher script plus the executable it points at, or a bare
executable) by rename rather than by copying over the existing files:
writing into a mapped executable fails with `ETXTBSY`, an atomic rename does
not.


The inject-bridge can deliver AMQ wakes through each provider's own push
channel instead of typing into the PTY: claude panes via the claude-peers
channel (`yaran peer send --transport claude-peers`, the live registration
whose process environment names the receiving agent's `YARAN_SESSION_ID`, or
for registrations that name no agent the one in the receiver's directory,
chosen by host kind: daemon-hosted session, then the pane yaran spawned, then
other clients, daemon spares last; a registration naming a different agent is
never chosen. The environment is a same-UID label, trusted exactly as T2's
`--me` is) and jcode panes via the daemon's client
protocol (`jcode debug -S <session> client:message`). The jcode session is
picked from `clients:map`: a client whose working directory is the receiver's
worktree, or whose directory basename equals the receiver handle; if none
matches and exactly one client is connected, that client; if several match,
the first listed. With no candidate the wake exits non-zero and the message
stays held in the AMQ inbox rather than going to an arbitrary pane. Native
delivery therefore isolates by worktree only as far as jcode clients keep
distinct working directories. This is **opt-in** (`YARAN_AMQ_NATIVE_DELIVERY=1`)
and requires jcode's `display.debug_socket = true`; a stock install keeps the
file-queue/drainer path. When enabled, readiness is checked before the inbox
is drained so a held message is retried rather than lost, an unreachable
daemon falls back to the queue, and every jcode delivery attempt is logged to
`~/.local/state/inject-bridge-jcode.log`.

**Residual risk.** Yaran is not a sandbox. The `serve` daemon, swarm sub-agents,
and inherited MCP servers run with the operator's Unix permissions and
identity; enabling jcode's debug socket for native delivery exposes a
same-UID control surface (message submission, session listing) that the
single-user-VM trust model already accepts under T2; killing a pane does not stop the shared daemon, and a swarm's
resource use is bounded only by jcode itself and by host-level limits. jcode's
binary, backends, authentication, and data handling remain upstream
responsibilities.

**Detection.** jcode appears by name in the provider selector, generated
configuration, and the session header. The wake watcher and `serve` daemon are
visible in the process table (`amq wake --me <handle>`, `jcode ... serve`);
removing or overriding `[providers.jcode]` disables the provider.

---

## T21 — Agent forges, floods or hides human-board cards, or injects escapes through them

**Attack scenario.** Any process running as the operator, an agent included, can
run `yaran board post` or edit `human_board.json` directly. A misbehaving agent
could post under another agent's name, bury the cards that matter under hundreds
of noise cards, resolve a card nobody looked at, or put terminal escape sequences
in a title to repaint the operator's screen.

**Mitigation in code.** The board is one file in the yaran config directory,
created owner-only; every writer holds an exclusive `flock` on
`human_board.lock` for its whole read-modify-write and lands the document with
an atomic rename, so concurrent posts never lose a card and readers never see a
half-written board. Every card string (title, detail, ticket, poster, note) is
passed through the terminal sanitizer and bounded in length before it is
stored, and the terminal UI renders it as plain text. Open cards are capped
(`MAX_OPEN_CARDS`) and a post past the cap is refused with an error rather than
dropping older cards; resolved history is pruned, open cards never are. A board
the parser cannot read is shown as unreadable in the pane and is never
overwritten, and a document from a newer schema is read but not rewritten.

**Residual risk.** The poster field is a label taken from the launch
environment (`YARAN_AMQ_HANDLE`/`AM_ME`) or `--from`, not an authenticated
identity, and resolving a card is not authenticated either: both are
same-UID actions under the single-user trust model accepted in T2. The board
carries no executable content; nothing on it is ever run. A reply sent from a
card's dialog is typed into an agent's terminal through the same ownership gate
as any keystroke, and the default reply template quotes the card's title
(sanitized, cut to 80 characters): agent-written text therefore reaches an
agent's prompt only when the person sends a reply, by default only the agent
that posted the card, and the dialog names that agent first. An empty
`human_board_reply_template` sends the person's words alone.

**Detection.** `yaran board list --all --json` shows every card with its
poster, timestamps, and who resolved it; the file itself is plain JSON.

---

## T22 — A shared board folder carries foreign card text in, and its git sync publishes and merges

**Attack scenario.** With `[board] dir` set, the board is a folder of Markdown
notes that other machines and people also write, typically through a synced
notes vault or a git repository. A note can therefore come from anyone with
write access to that vault or remote, not only from this operator's agents: it
may hold escape sequences, absurd sizes, malformed properties, a symlink to
some other file, or two notes claiming one card id. With `[board] sync = "git"`
yaran also runs git in the repository holding the folder on its own schedule:
it commits, merges the upstream and pushes, so a hostile or simply busy
repository state could make it publish something unintended, overwrite local
work, or hang on a credential prompt.

**Mitigation in code.** Every note is read through the same cleaning and length
bounds a posted card gets (terminal sanitizer, per-field caps), a note larger
than `MAX_NOTE_BYTES` is not read, symlinks are not followed, and a note that
does not parse (or duplicates another's id) is listed as unreadable, left
exactly as it is, and its id is never handed to a new card. A change rewrites
only the notes of the cards it changed, each through a hidden temporary file
and an atomic rename, under the same `flock` as the private board. The sync
commits only the board folder's paths (a pathspec-limited commit, so whatever
else is staged or modified in the repository stays out of it), holds the
board lock while committing or merging so no half-written note is committed,
does nothing while the repository is mid merge, rebase or cherry-pick, merges
by fast-forward or merge commit and never rebases or forces, lets git refuse a
merge that would overwrite uncommitted work, settles a conflict only when every
conflicted path is a note directly in the board folder (keeping the card with
the later `updated` time, deterministically on every machine) and otherwise
aborts the merge and reports it. Every git call has a hard time limit, runs with
`GIT_TERMINAL_PROMPT=0` and ssh in batch mode (unless the user configured an
ssh command), and its error text is sanitized before it reaches the status
line or the log. It pushes only to the branch's configured upstream, with a
fully qualified refspec. The feature is off by default; nothing syncs unless
`sync = "git"` is set.

**Residual risk.** Anyone who can write the shared folder or push to its
remote can post, edit, reassign or resolve cards, and a card's poster and
resolver are labels, not identities: the board inherits exactly the trust of
the vault or repository it lives in. The push sends the checked-out branch, so
commits other tools made in that repository and have not pushed yet go with
it. A settled conflict keeps one card version's fields and drops the other's
edit to them (the messages of both versions' conversations are kept). A note
edited by hand to a newer `updated` time wins conflicts it should not.

**Detection.** The repository's history shows every board commit
(`Update the shared board: …`) and merge; the board pane's bottom edge shows
the last sync's time or failure and counts unreadable notes, and
`yaran board list` names them.

---

## T23 — A card's conversation carries another person's words into this machine's agents

**Attack scenario.** On a shared board a card holds a conversation, and with
`[board] relay = true` the terminal UI passes what another side wrote on a card
to the agent of this machine that posted it, and hands a card another person
assigns to `me` to the agent named in `relay_to`. Whoever can write the shared
folder or push to its remote can therefore put text in front of this
operator's agents, written as if a colleague had said it: an instruction to
push, deploy, delete or exfiltrate something, or text built to break out of
the message it is quoted in.

**Mitigation in code.** Relaying is off by default. Only a message written on
another side (its `side` is not `me`) is passed, only to the agent that posted
the card on this machine (a session of this yaran with that handle) or to the
one configured `relay_to` agent for a card assigned to `me`, and never for a
card this machine's agents did not post or was not handed. Message text gets
the terminal sanitizer and the per-message length cap when it is written and
again when a note is read, and a whole card's quoted detail is capped again in
the relay. The send runs `yaran peer send` with the text as one argument (no
shell), time-limited, over the same transports agents use between
themselves; it is never typed into a terminal. Each message is passed once:
only a send that went through is recorded on the card (`relayed`), a failed
one is retried after a pause, and the card's conversation shows which
messages were passed. The relayed text says who wrote it on which card and
points the agent back at the card to answer, so the exchange stays on the
board where both people can read it.

**Residual risk.** A message's writer and side are labels, not identities: the
relay trusts the shared folder exactly as T22 does, so anyone who can write it
can speak as the other person to this machine's agents, and an agent acts on
that text with its own permissions (the command guards an agent runs under
still apply to what it then does). Turn `relay` on only for a folder whose
writers you would let instruct your agents.

**Detection.** Every relayed message is marked as passed in the card's
conversation (and its note), the status line names each relay and its agent,
the agent's message history holds the text it received, and the folder's
repository history shows who changed the card.

---

## T24 — Claude Code's self-relaunch runs through a launcher yaran installs

**Attack scenario.** `claude-amq` sets `CLAUDE_CODE_PROCESS_WRAPPER` to
`claude-peers-launcher`, so every time Claude Code execs itself again (its
`/restart`, its switch onto an updated build, its background daemon and the
sessions and spares that daemon hosts, when started from a yaran pane) it runs
that script first. Whoever can modify the script runs code in every one of
those processes with the operator's permissions. A launcher that adds flags
to the wrong process could also start a background session on a prompt nobody
is there to answer.

**Mitigation in code.** The launcher is installed next to `claude-amq` with the
same mode and the same ownership advice (root-owned, `0444`, see T3), and is
referenced by absolute path, which Claude Code requires. It always `exec`s the
command it was given and passes the environment through unchanged; the only
change it ever makes is appending
`--dangerously-load-development-channels server:claude-peers`, and only when
the relaunch is still on the terminal `claude-amq` started on, is an
interactive invocation (no subcommand, `-p`, `--print`, `--bare` or `--`),
does not carry the flag already, and `CLAUDE_PEERS_DISABLE` is not `1`.
Anything else, including every daemon-hosted process, runs exactly as asked.
`claude-amq` does not replace a launcher the operator already set.

`claude-amq` also starts the Claude Peers broker when it is not answering:
only the `broker.ts` beside the `server.ts` that Claude Code's own config
registers as `claude-peers`, run with that registration's command, once under
a lock, in a process group of its own and with no terminal. It is the same
same-UID loopback daemon that the MCP server would otherwise start itself.

**Residual risk.** The script is a second executable on the self-exec path of
every Claude process started from a yaran pane, so its integrity matters as
much as `claude-amq`'s. With an operator launcher already set, a Claude Code
restart turns claude-peers off for that pane again, and `yaran peer` falls
back to AMQ for it.

**Detection.** `claude-amq` warns when it leaves an existing
`CLAUDE_CODE_PROCESS_WRAPPER` alone; `claude daemon status` names the launcher
the background service records; `yaran peer list` marks any Claude agent that
is running without the channel.

---

## Cloud Connect and the phone apps (design-stage drafts)

The sections from T25 onward cover Cloud Connect (the org control-plane
Worker on Cloudflare, the supervised `cloudflared` leg, the Access check
yaran runs itself), the publisher push relay, and the phone apps under
`mobile/`. They were written at design stage, before the code existed.
Each `Mitigation in code.` paragraph opens by naming the phone-app phases
that own it; the owning phase replaces the design text with symbols and
file paths in the same PR that lands the surface, and the security review
phase checks every row against the implementation. Placeholders follow the
docs: `<zone>`, `<org-control-plane>`, `<publisher-relay>` and
`<publisher-domain>` stand for values the deployer or the maintainer
supplies, and none of them is a real hostname.

---

## T25 — The unauthenticated web API reachable from the internet through the tunnel

**Attack scenario.** A machine's hostname routes to its tunnel, and the
tunnel reaches yaran's loopback listener, which has no login. If the
machine's Access app or policy is missing, scoped to the wrong hostname or
path, or deleted, or if the DNS record is published before the app
protects it, anyone on the internet gets the whole workspace: PTY input,
the filesystem through the project picker, and config rewrites.

**Mitigation in code.** Design-stage draft; owners phoneapp 05, 10 and 11.
The control plane creates one Access app and one owner-only reusable policy
per machine, in the order policy, app, tunnel, ingress, DNS, and tears down
in the order DNS, connections, tunnel, app, policy, so no DNS record ever
points at an unprotected tunnel. Every machine ingress rule carries
`originRequest.access` with `required` and the app's `audTag`, and yaran
refuses a cloudflared older than 2026.11.0, so cloudflared itself rejects a
request with no valid Access JWT. yaran then verifies the JWT on every
request for the cloud hostname (T26). Reconciliation compares live
Cloudflare state with the desired state and repairs drift.

**Residual risk.** If the gate run shows that per-rule `access.required`
does not enforce, yaran's own JWT check is the only origin-side gate and
this row records the reduced defence in depth. A Cloudflare account admin
can still delete the app by hand between reconciliation runs.

**Detection.** Worker audit events `provision.step`, `drift.repaired` and
`machine.reconciled`; a `provision.failed` audit event when an ordered step
fails; yaran's `yaran::cloud::ingress` log records every refused request on
the cloud Host.

---

## T26 — Access JWT forgery, confusion or replay at yaran

**Attack scenario.** A request reaches yaran on the cloud hostname with a
JWT that is signed for another Access app (wrong `aud`), issued by another
team, expired, minted for a service token, or issued to a different user
than the paired owner. Or the team's signing keys cannot be fetched and a
naive verifier fails open.

**Mitigation in code.** Design-stage draft; owner phoneapp 11. yaran
verifies RS256 against the team's JWKS, cached by `kid`, and checks `iss`,
`aud`, `exp` and `nbf` with a configurable clock skew. The token's email,
lowercased, must equal the paired owner's. Service-token JWTs are rejected.
When the JWKS is unavailable yaran fails closed with a 503 that says so.
The check runs on every HTTP request and every WebSocket upgrade whose Host
is the cloud hostname; loopback, LAN and Tailscale Hosts are unaffected.

**Residual risk.** A valid JWT stolen from the owner's browser or phone is
accepted until it expires (T37, T45). The skew window extends every token's
life by its width.

**Detection.** `yaran::cloud::ingress` logs each refusal with its reason
(audience, issuer, expiry, owner mismatch, service token, keys
unavailable); the 503 carries the `Yaran-Refusal: access-keys-unavailable`
header.

---

## T27 — Tunnel token stolen from the developer machine

**Attack scenario.** The tunnel token is read from a file, a process
argument list, a backup, the raw-config endpoint or `[env]`. With it an
attacker runs a rogue connector for the same tunnel and receives a share of
the machine's traffic, including requests that already carry the owner's
Access JWT.

**Mitigation in code.** Design-stage draft; owners phoneapp 09, 10 and 05.
The token lives only in the owner-only credentials file under the 0700
config root (`file_modes.rs`), never in `config.toml` or `[env]`. It
reaches cloudflared through a 0600 token file written just before each
spawn and deleted when the leg stops, never through argv. `yaran cloud
rotate` asks the control plane to replace the tunnel secret and drop live
connections.

**Residual risk.** Anything running as the same Unix user can read the
credentials file; that is the trust model in `SECURITY.md`. A stolen token
works until it is rotated.

**Detection.** Worker audit event `machine.rotated`; the admin console's
machine page lists the tunnel's live connectors, so an unknown connector
location shows there.

---

## T28 — Machine signing key theft or signed-request replay

**Attack scenario.** An attacker who copies the machine's Ed25519 key, or
captures one signed request, calls the machine routes of the control
plane: posting events, fetching config, retargeting the tunnel's origin
port with `PUT /v1/machine/origin`, or unpairing the machine.

**Mitigation in code.** Design-stage draft; owners phoneapp 09, 04 and 05.
The key is generated at pairing and stored in the credentials file. Every
machine request is signed over the protocol's canonical string (method,
path, Host, protocol version, machine id, timestamp, nonce and body hash).
The Worker keeps a nonce store and accepts a timestamp only within ±300 s.
Revoking the machine invalidates its key. The origin route is signed like
every other machine route, because a forged one would point the tunnel at
another local port.

**Residual risk.** A stolen key works until the machine is revoked or
re-paired. A replay inside the window is stopped only by the nonce store.

**Detection.** Worker audit events `machine.origin_changed` and
`machine.unpaired`; signature and nonce failures are counted in the
Worker's request log.

---

## T29 — cloudflared supply chain

**Attack scenario.** The cloudflared download is tampered with, the pinned
version has a known vulnerability, or cloudflared replaces itself through
its own updater with a binary yaran never checked. The binary runs as the
developer.

**Mitigation in code.** Design-stage draft; owners phoneapp 10 and 18.
yaran pins one cloudflared version with SHA-256 hashes compiled in for the
archive and the binary of each supported target, re-hashes the binary on
every start, and fails closed on a mismatch. A user-supplied binary
(`cloudflared_path`) is checked against the same minimum version,
2026.11.0. cloudflared always runs with `--no-autoupdate` and
`NO_AUTOUPDATE=true`. The managed binary is stored owner-only. The release
pipeline owns a pin-bump process.

**Residual risk.** A user-supplied binary is not hash-checked; that path is
the user's responsibility and the docs say so. A vulnerability published
after the pin stays until the next yaran release.

**Detection.** The leg's status names the expected and actual hash on a
mismatch; yaran warns when the pin nears the end of Cloudflare's one-year
support window.

---

## T30 — cloudflared's metrics endpoint reached by another local user or a page

**Attack scenario.** cloudflared serves an unauthenticated metrics endpoint
that exposes tunnel configuration and profiling data. If it binds a wide
address, another user on the machine or the LAN, or a web page through DNS
rebinding, reads it.

**Mitigation in code.** Design-stage draft; owner phoneapp 10. yaran always
passes `--metrics 127.0.0.1:<port>` explicitly, with the port configurable
(`[cloud] metrics_port`, a free port by default). Remote management
diagnostics stay off unless `management_diagnostics` is turned on.

**Residual risk.** Other local users can still reach a loopback port. On a
shared machine that exposes the tunnel's configuration, not its token.

**Detection.** yaran logs the metrics address it chose under
`yaran::cloudflare` at each start.

---

## T31 — Org Worker compromise or a malicious `cloud-deploy` change

**Attack scenario.** The org control-plane Worker holds an API token that
can edit tunnels, Access apps and DNS. A bug in the Worker, a malicious
commit in the deployer's clone of the `cloud-deploy` branch, or a script
injected into the admin console lets an attacker use that token against
the org's Cloudflare account.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 05 and 07.
The token comes from a least-privilege template, and the docs state each
permission's blast radius. Until setup closes, `workers.dev` answers only
the setup pages and the service-info check; the wizard then disables
`workers.dev` by API, and the Worker refuses every Host other than the
custom domain. Preview URLs are off and no custom domain is written into
the wrangler config. The admin console sits behind Access and loads no
third-party scripts. The update checker verifies release tags. Every
mutating route writes the audit log.

**Residual risk.** Whoever controls the deployer's clone controls the
Worker; that is the org's own supply chain.

**Detection.** Worker audit events `setup.completed` and
`settings.updated`; the console's Updates page names the running version
against the latest verified release.

---

## T32 — Same-zone `fetch` from the Worker bypassing Access

**Attack scenario.** A Worker in the same zone can `fetch` a hostname in
that zone without passing through Access in some configurations. If the
control plane ever proxied requests to machine hostnames, it could reach a
machine origin with no Access check.

**Mitigation in code.** Design-stage draft; owners phoneapp 04 and 05. The
Worker never proxies to machines; phones and browsers reach each machine
hostname directly. The Worker runs with `global_fetch_strictly_public`.
cloudflared's per-rule `access.required` is the second gate (T25).

**Residual risk.** A future change that adds proxying would reopen this.

**Detection.** A route-table test fails on any route that fetches a
machine hostname.

---

## T33 — Setup takeover before setup closes

**Attack scenario.** Between deploy and the end of setup the Worker is on a
public `workers.dev` address. Someone who finds it guesses the setup code,
or a second admin races the first, and claims the control plane.

**Mitigation in code.** Design-stage draft; owners phoneapp 04 and 07. The
setup code is a deploy-time Worker secret of at least 24 characters. Setup
attempts are rate-limited and lock out after repeated failures, and the
comparison is constant-time. Only the setup pages and the service-info
check answer on `workers.dev` in that window. Setup closes permanently in
one database transaction, after which the setup pages answer
`410 setup_closed` and `workers.dev` is disabled.

**Residual risk.** A setup code shared over a leaky channel is a valid
credential until setup closes.

**Detection.** Worker audit events `setup.completed` and `setup.closed`;
failed attempts are counted, and the lockout shows as `setup_locked`.

---

## T34 — Cross-user authorization flaws in the Worker

**Attack scenario.** A signed-in user changes an id in a request and reads
or changes another user's machine or phone, including its mute settings or
push state, or escalates to admin.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 06 and 08.
Every query is scoped by the authenticated email. The role comes from the
Worker's own settings table, never from the request. An authorization
matrix test covers every route, every role and owner versus non-owner, the
device mute routes included.

**Residual risk.** A route added without a matrix row; the test fails when
a route has no row.

**Detection.** Refused requests are logged with the route and the caller's
email; admin actions write the audit log (T48).

---

## T35 — Pairing hijack

**Attack scenario.** An attacker forges a pairing request (CSRF), steals
the one-time code from the loopback redirect, injects a code into another
machine's callback, or sends someone a pairing link they crafted, so their
machine ends up paired to the victim's account or the victim's machine to
theirs.

**Mitigation in code.** Design-stage draft; owners phoneapp 06 and 09.
Pairing uses PKCE and `state`. The browser's confirm page shows the machine
name and the machine key fingerprint, and the terminal prints the same
fingerprint before the browser opens, so the person compares them before
confirming. The one-time code is short-lived and single-use. Claiming it
needs both the machine signature and the PKCE verifier.

**Residual risk.** A person who confirms without comparing the fingerprint.

**Detection.** Worker audit events `pair.requested`, `pair.approved`,
`pair.denied`, `pair.expired` and `machine.claimed`.

---

## T36 — Sealed-handoff interception

**Attack scenario.** During phone sign-in, another app receives the
callback, an attacker replays `state` or abuses the redirect parameter, or
a page starts a handoff that rides the user's live SSO session so the
identity provider approves it silently.

**Mitigation in code.** Design-stage draft; owners phoneapp 02, 06, 11, 14
and 15. The handoff payload (the Access JWT, and a cookie where the gate
run requires one) is sealed as JWE ECDH-ES with A256GCM to an ephemeral
P-256 key that only the app holds. Release builds return on a verified
https callback on `<publisher-domain>` (an Android App Link through Auth
Tab or a Custom Tab; an iOS `ASWebAuthenticationSession` https callback,
iOS 17.4 or newer), which the OS delivers only to the app that domain
vouches for (T63). The redirect allowlist accepts exactly that callback,
and the custom scheme `yaranapp://auth/callback` only when the request
declares a development build. Both handoff pages, the Worker's and
yaran's, show a one-tap consent page naming the device and the host before
sealing. Consent is remembered per host and device key after an explicit
Continue, and a later handoff skips the page only with a verifying
signature from this install's hardware-held device key (T64). `state` is
single-use and short-lived. There is no unauthenticated exchange endpoint,
and the responses are `no-store`.

**Residual risk.** A build compiled without a publisher domain uses the
custom scheme, which any app on the phone can register; such builds show a
permanent warning in the app. A hijacked flow the user started yields only
ciphertext. A hostile app that starts its own flow still needs the user to
tap Continue, and remembered consent does not help it, because it cannot
produce this install's device signature.

**Detection.** Worker audit events `handoff.issued` and
`handoff.declined`; yaran logs the same outcomes under
`yaran::cloud::handoff`.

---

## T37 — Phone token theft at rest or on device loss

**Attack scenario.** Control-plane and machine JWTs, or push keys, are read
from the phone's storage, a backup, logs or a diagnostics export, or from a
lost phone.

**Mitigation in code.** Design-stage draft; owners phoneapp 14, 15 and 06.
Secrets live in the iOS Keychain with `ThisDeviceOnly` access and behind an
Android Keystore AES-GCM key. Android backups are off with matching
extraction rules. Diagnostics redact tokens, cookies and query strings. An
optional app lock uses biometrics bound to the key (`CryptoObject` or
`SecAccessControl`). An admin or the person can remove the phone from the
console.

**Residual risk.** An unlocked phone in an attacker's hands with the app
lock off has the sessions until they expire (T45).

**Detection.** Worker audit event `sessions.revoked` when sessions are
revoked; `device.updated` when a phone is removed.

---

## T38 — `machine-view` WebView escape

**Attack scenario.** The remote yaran page shown in the app reaches a
native bridge, navigates the WebView to a foreign origin, or reads local
files.

**Mitigation in code.** Design-stage draft; owner phoneapp 15. The machine
WebView is a first-party native component with no JavaScript bridge. It
navigates only to the exact machine host; every other link opens in the
system browser. File and content access are off, and WebView debugging is
off in release builds.

**Residual risk.** A WebView engine vulnerability is the platform's to fix.

**Detection.** Blocked navigations are counted in the app's local
diagnostics.

---

## T39 — Push content exposed to Google, Apple, the distributor or the relay

**Attack scenario.** Agent labels and project names in notifications are
read by the push transport: Google's service, Apple's service, a
UnifiedPush distributor, or the publisher relay.

**Mitigation in code.** Design-stage draft; owners phoneapp 08, 12 and 16.
Payloads are end-to-end encrypted to keys held on the device (RFC 8291) and
decrypted on the device, on iOS in a Notification Service Extension. The
payload is minimal, and the org can drop labels and project names
entirely. When decryption cannot run, the visible text is generic.

**Residual risk.** Transports still see timing, volume and the device's
push token (T40).

**Detection.** Decrypt failures are counted in the app's local
diagnostics.

---

## T40 — Publisher relay abused or compromised

**Attack scenario.** The relay that turns Web Push into Apple pushes is
used to mint endpoints, flood devices or run up cost, or it is compromised
and its APNs key used to push to every iOS user.

**Mitigation in code.** Design-stage draft; owners phoneapp 08 and 21. Each
relay endpoint is bound to the org's VAPID key, and the relay verifies the
VAPID JWT against exactly that key. Rate limits apply per key and per
device. The relay logs no tokens. The APNs key exists only in the relay's
environment. A key-compromise playbook is owned by the security review
phase.

**Residual risk.** A relay compromise lets an attacker send pushes, but not
readable ones (T39), and lets them stop iOS push for everyone.

**Detection.** Relay rate-limit refusals and per-key volume alerts.

---

## T41 — Org VAPID private key compromise

**Attack scenario.** An attacker who gets the org's VAPID private key sends
pushes that the push services accept as coming from the org.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 07 and 08.
The Worker generates the key during setup and stores it sealed with
`DATA_KEY`. Rotating it makes every phone register again. Payloads are
still end-to-end encrypted to device keys, so the VAPID key alone cannot
produce a notification the phone shows with real content.

**Residual risk.** A spoofed push still wakes the phone and can show the
generic fallback text.

**Detection.** After a rotation, phones that have not re-registered show
as "push stopped: the phone must register again" in the consoles.

---

## T42 — Malicious deep links or QR codes

**Attack scenario.** A `yaranapp://add-org` link or QR code points the app
at an attacker's org so the person signs in to it, or a notification tap
opens a foreign host.

**Mitigation in code.** Design-stage draft; owners phoneapp 06, 14, 15 and
16. Adding an org shows the org's name and Access team domain, fetched from
the org itself, and needs an explicit confirm before any sign-in. The
genuine QR payload is built only from the control plane's canonical host,
never from a request's Host. Deep links open only hosts of orgs already
added. Notification taps are checked against the machine list.

**Residual risk.** A person who confirms an org they do not recognise.

**Detection.** Refused deep links are counted in the app's local
diagnostics.

---

## T43 — Cloudflare sees all tunneled traffic in plaintext at its edge

**Status: accepted-risk.** Cloud Connect is built on Cloudflare's HTTPS
edge, which terminates TLS. This is stated in the docs, the app's
onboarding and the store listing.

**Attack scenario.** Cloudflare, or anyone who compromises or compels it,
reads terminal I/O, file contents and everything else that crosses a
machine hostname.

**Mitigation in code.** Design-stage draft; owner phoneapp 17 (docs). No
code mitigates this. Every Cloud Connect docs page carries the warning,
the app shows it before the first sign-in, and the `yaran server` console
says it when the leg first comes up. Layer-4 alternatives would break the
one-HTTPS-hostname-per-machine model.

**Residual risk.** All of it, by design. People who cannot accept it use
Tailscale or their own proxy instead.

**Detection.** None possible from yaran's side.

---

## T44 — Raw config and `[env]` reachable by the remote owner

**Attack scenario.** The raw-config endpoint and the bootstrap `[env]`
stay reachable to an authenticated owner over the tunnel. A stolen phone
session therefore reads any secret the person put in `[env]`, and those
values cross Cloudflare's edge in plaintext on every page load.

**Mitigation in code.** Design-stage draft; owner phoneapp 11. Decision
record: the remote identity is the paired owner, so no route is restricted
by origin. The exposure is bounded by T26 and T37 and by the Access session
duration, and the docs tell people to keep real secrets out of `[env]`.

**Residual risk.** Secrets in `[env]` are as exposed as the owner's
session.

**Detection.** yaran's access log records the raw-config requests.

---

## T45 — Revocation lag

**Attack scenario.** A revoked phone or machine keeps working until its
JWT expires, or an open WebSocket keeps streaming after the token behind it
expired.

**Mitigation in code.** Design-stage draft; owners phoneapp 05, 06 and 11.
The Access session duration is short and configurable. Teardown removes DNS
first and invalidates the tunnel secret before deleting connections.
Rotation drops live connections. yaran re-checks the JWT on every
reconnect and closes open sockets with code 4401 at expiry plus skew
(`close_sockets_at_access_expiry`). The console offers sign-out-everywhere
through Access session revocation.

**Residual risk.** Access has no per-device revocation, so a stolen phone
keeps a control-plane JWT for the session duration; the console says so
beside the remove action.

**Detection.** Worker audit events `device.updated` and
`sessions.revoked`; yaran logs 4401 closes under `yaran::cloud::ingress`.

---
## T46 — Android signing key or App Store credentials compromised

**Attack scenario.** An attacker with the app-signing key or the store
credentials ships a malicious update that every installed copy accepts.

**Mitigation in code.** Design-stage draft; owners phoneapp 18 and 21. One
app-signing key is held by the maintainers for every Android channel, with
Play App Signing and a separate upload key. Release workflows run in
protected GitHub environments and are covered by CODEOWNERS. A
key-compromise playbook is owned by the security review phase.

**Residual risk.** A compromise of the maintainer's custody of the key
affects every Android channel at once; that is the price of channels that
can upgrade each other.

**Detection.** Release provenance attestations; store consoles notify the
maintainers of every upload.

---

## T47 — Deploy secrets leaked

**Attack scenario.** `CF_API_TOKEN`, `SETUP_CODE` or `DATA_KEY` leaks
through Workers Builds logs, a committed `.dev.vars` file or the admin
console, giving access to the org's Cloudflare account or to every secret
sealed with `DATA_KEY`.

**Mitigation in code.** Design-stage draft; owners phoneapp 04 and 07. The
deploy prompts for all three as secrets and never echoes them. `.dev.vars`
is gitignored. The console never displays them. A secret-leak sentinel test
covers logs and responses. Each secret has a documented rotation procedure.

**Residual risk.** A secret pasted into a chat or ticket is outside the
code's reach.

**Detection.** The sentinel test in CI; Worker audit events on every
settings change.

---

## T48 — Repudiation or tampering of admin actions

**Attack scenario.** An admin revokes a machine or changes policy and
later denies it, or someone edits the record of what happened.

**Mitigation in code.** Design-stage draft; owner phoneapp 04. Every
mutating route appends to an `audit_log` table, which the console can
export as JSON Lines.

**Residual risk.** Anyone with write access to the account's D1 database
can edit the table directly.

**Detection.** The audit log itself, and its export.

---

## T49 — Quota or budget exhaustion

**Attack scenario.** One user pairs many machines, or API calls exhaust
Cloudflare's per-token rate budget, the account's Access app cap or the
database write budget, and nobody else in the org can pair.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 05 and 06.
A per-user machine cap (10 by default). A quota guard that refuses with the
quota's name and both numbers before Cloudflare would. A rate-limit
binding. Reconciliation uses list calls. The scheduled dispatcher has a
budget per run.

**Residual risk.** Access apps created outside yaran count against the same
account cap.

**Detection.** Worker audit events `quota.refused` and
`cloudflare.rate_limited`; the console warns at 90% of a quota.

---

## T50 — Spoofed update notice leading to a malicious APK

**Attack scenario.** People who install the APK from GitHub are pointed at
a malicious APK by a fake update notice.

**Mitigation in code.** Design-stage draft; owners phoneapp 14 and 18. The
app has no update check and no in-app installer. The only link it offers
is to `github.com/SiavZ/yaran` releases. Releases carry checksums and
provenance attestations.

**Residual risk.** Phishing outside the app.

**Detection.** None in the app; release provenance is checkable by anyone.

---

## T51 — Diagnostics or crash logs leak tokens or hostnames

**Attack scenario.** A person shares the app's diagnostics for support,
and the file carries tokens or infrastructure names.

**Mitigation in code.** Design-stage draft; owner phoneapp 14. Diagnostics
stay on the phone until the person exports them. Tokens, cookies, query
strings and terminal escapes are redacted, tested with fixtures. The export
screen says the file contains hostnames and machine names. There is no
third-party crash reporting.

**Residual risk.** Hostnames and machine names are in the export by
design.

**Detection.** The redaction fixture tests in CI.

---

## T52 — Malicious upstream `yaran-cloud-v*` release pulled into a deployment

**Attack scenario.** A compromised upstream release, or a tampered
`cloud-deploy` branch, reaches an org's control plane through the Deploy
button or an update.

**Mitigation in code.** Design-stage draft; owners phoneapp 07 and 18. The
Deploy button and updates use the generated, self-contained `cloud-deploy`
branch that the `yaran-cloud-v*` release workflow builds. Tags are signed
and releases carry provenance attestations, which the update job verifies.
The update arrives as a pull request in the admin's clone, so the admin
reviews the diff and changelog before merging.

**Residual risk.** An admin who merges without reading.

**Detection.** The console's Updates page; attestation failures stop the
update job with a stated reason.

---

## T53 — Attacker-controlled text injects terminal escapes

**Attack scenario.** Cloudflare API errors, cloudflared stderr or push
provider responses carry ANSI, OSC or DCS sequences that reach `yaran.log`,
the status line or the admin console.

**Mitigation in code.** Design-stage draft; owners phoneapp 05, 08 and 10.
yaran passes all such text through `yaran_core::sanitize::for_terminal`
before logging or showing it. The Worker escapes all output in console
HTML.

**Residual risk.** A new call site that skips the sanitizer.

**Detection.** Sanitizer tests with escape-laden fixtures for each source.

---

## T54 — Control-plane Worker reached without a valid identity

**Attack scenario.** The control plane's own Access app is missing or
mis-scoped, or a request carries a service-token JWT, a JWT for the wrong
app, or one for a disabled user.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 06 and 07.
The Worker verifies the Access JWT on every non-public route (RS256 with a
pinned algorithm, `iss`, `aud`, `exp`, `nbf`), rejects service-token JWTs
and disabled users, and fails closed when the JWKS is unavailable. Every
route declares an authentication class or the type check fails. Group
membership is decided by the Access policy; the Worker does not re-evaluate
groups it cannot see.

**Residual risk.** The two public paths (the service-info check and the
signed machine routes) depend on their own checks (T28).

**Detection.** Refusals are logged with the route and the reason.

---

## T55 — D1 contents exposed

**Attack scenario.** Someone with account-level read access to the D1
database, or a copy of an export or backup, reads its contents.

**Mitigation in code.** Design-stage draft; owners phoneapp 04, 05, 06 and
08. Secrets the Worker generates are stored only sealed with `DATA_KEY`,
with additional data bound to the row. One-time codes are stored as
hashes. Tunnel tokens are never written to D1, and a full-table scan test
proves it.

**Residual risk.** Emails and machine metadata remain readable to whoever
can read the account's D1.

**Detection.** Cloudflare's account audit log records database exports.

---

## T56 — Control plane acts on Cloudflare resources it does not own

**Attack scenario.** Two deployments share one account, or orphan cleanup
mistakes a foreign tunnel, Access app, policy or DNS record for its own
and deletes it.

**Mitigation in code.** Design-stage draft; owner phoneapp 05. Every
resource the control plane creates carries an instance marker. Orphan
cleanup acts only on marked resources past a grace period. It never uses
undocumented cascade deletes.

**Residual risk.** Someone who copies the marker onto a resource by hand.

**Detection.** Worker audit events `orphan.found` and `orphan.deleted`.

---

## T57 — Device-supplied push endpoint used for SSRF

**Attack scenario.** A phone registers a push endpoint that points at an
internal or same-zone service, turning the Worker into a fetch client
against it.

**Mitigation in code.** Design-stage draft; owners phoneapp 06 and 08. The
endpoint policy is enforced at registration: https only, no IP literals,
nothing under the org's own zone, a length cap, and relay endpoints in the
relay's fixed form. The Worker runs with `global_fetch_strictly_public`. A
404 or 410 clears the subscription and marks the device's push as stopped.

**Residual risk.** Any public https host is still a valid endpoint, so the
Worker can be made to send small encrypted requests to it.

**Detection.** Worker audit event `device.registered` records the endpoint
host.

---

## T58 — yaran's handoff rate limit starves another phone's sign-in

**Attack scenario.** One client fills yaran's process-wide handoff rate
limit, and the owner's own phone cannot sign in.

**Mitigation in code.** Design-stage draft; owner phoneapp 11. The default
is 12 a minute against an expected one a day per phone, and the limit is
configurable (`[cloud] handoff_requests_per_minute`). Every handoff request
already passed Access, so only the owner's identity can spend it.

**Residual risk.** The owner's own misbehaving client.

**Detection.** `yaran::cloud::handoff` logs each refusal with
`rate_limited`.

---

## T59 — Attention-event metadata visible to the org Worker

**Status: accepted-risk.** The org Worker and its database are the org's
own infrastructure.

**Attack scenario.** The agent label, project name and state token in each
attention event are readable in plaintext by the org Worker and stored in
its database.

**Mitigation in code.** Design-stage draft; owners phoneapp 12 and 08.
Events are batched and minimal. The state is a fixed token, never free
text. No agent output leaves the machine. Push payloads past the Worker
stay end-to-end encrypted (T39). The org can drop labels and project names
from pushes.

**Residual risk.** Whoever controls the org's Cloudflare account sees
agent labels and project names.

**Detection.** None needed for an accepted risk.

---

## T60 — Shell WebView compromise drives native plugins

**Attack scenario.** Injected or remote script runs in the app's bundled
shell UI, the one page with access to native plugins, and uses them to
read the vault, sessions or push keys.

**Mitigation in code.** Design-stage draft; owners phoneapp 14, 15 and 16.
The shell loads only bundled assets under a strict Content Security
Policy, and the plugin surface is narrow. JavaScript never holds bearer
credentials: every control-plane call, push registration included, goes
through the native client, so script that reaches the bridge cannot read a
token.

**Residual risk.** Script that reaches the bridge can still ask the native
client to act on the person's behalf while it runs.

**Detection.** CSP violations are counted in the app's local diagnostics.

---

## T61 — iOS machine session cookie readable by page script

**Attack scenario.** On iOS the machine session cookie cannot be marked
HttpOnly through public API, so script in the machine page can read the
machine's Access JWT.

**Mitigation in code.** Design-stage draft; owner phoneapp 15. The cookie
is a session cookie, never persisted, in a data store per org. The only
page that can read it is the person's own yaran UI, which already has full
reach over the API.

**Residual risk.** Stated in the row: script injected into the yaran UI
could read the token. That script would already have the workspace.

**Detection.** None specific.

---

## T62 — Native loopback proxy reachable by other apps or pages on the phone

**Attack scenario.** If the sign-in gate lands on its third fallback, the
app runs a loopback proxy that carries a managed OAuth bearer, and another
app or a web page on the phone reaches it.

**Mitigation in code.** Design-stage draft; owner phoneapp 15. Conditional:
phoneapp 15 writes this mitigation if that fallback is adopted. Otherwise
this ID is struck through as retired, per the maintenance rule below.

**Residual risk.** Open until the gate verdict.

**Detection.** Open until the gate verdict.

---

## T63 — Publisher-domain association files tampered or lost

**Attack scenario.** The `assetlinks.json` or `apple-app-site-association`
file on `<publisher-domain>` is tampered with, carries a wrong
fingerprint, or disappears with the domain, so another app receives the
verified sign-in callback, or no app does.

**Mitigation in code.** Design-stage draft; owners phoneapp 21, 18, 14 and
15. The files are committed in the repo and hosted from there. The
`assetlinks.json` fingerprint is the app-signing certificate that the
release pipeline checks. The domain and its DNS are under maintainer
custody with renewal monitored. The handoff stays sealed to the app's
ephemeral key, so a hijacked callback yields ciphertext only (T36).

**Residual risk.** Losing the domain stops sign-in on release builds until
it is restored.

**Detection.** The release pipeline's fingerprint check; domain-expiry
monitoring.

---

## T64 — Remembered-consent bypass

**Attack scenario.** The consent cookie that lets a phone skip the sign-in
confirmation page is stolen, replayed or forged; the consent key leaks;
the phone's device key is extracted or made to sign by something other
than the app; or remembered consent outlives the phone's revocation. A
handoff the person did not start then skips the confirmation page.

**Mitigation in code.** Design-stage draft; owners phoneapp 02, 06, 11 and
15. A handoff skips the page only when all of these hold: the
`__Secure-yaran-handoff-consent` cookie is well formed, names the current
key version, and its HMAC-SHA256 verifies in constant time; it is less
than 400 days old; its fingerprint equals the fingerprint of the device
key in the request; the request carries a verifying ES256 signature by
that key over the server's own host, the ephemeral key, `state` and a
timestamp within ±300 s; and, on the Worker, no revoked device row carries
that fingerprint. The cookie is worthless without a fresh signature, and
the signature without the cookie. A replay inside the window yields an
envelope sealed to the original ephemeral key. The cookie is host-only,
HttpOnly, Secure, SameSite=Lax, scoped to the handoff path, set only by an
explicit Continue after a verified request, never refreshed by a skip and
never set by Cancel. The device key is a non-exportable P-256 key in
Android Keystore (StrongBox where present) or the Secure Enclave, one per
org registration, discarded with the install. The Worker derives its
consent key from `DATA_KEY`; yaran keeps its consent key in the owner-only
credentials file and mints a new one at every pairing. Revoking a device
stops its Worker skips at once; rotating `DATA_KEY`, re-pairing, `yaran
cloud logout` or `yaran cloud rotate --consent-key` drops every memory on
that side.

**Residual risk.** Code running as the app, or as root, on an unlocked
phone can ask the keystore to sign, because signing needs no user
presence, and with the system browser's cookie it can skip the page for a
flow it started; that attacker already holds the app's live sessions (T37,
T60). yaran never learns that the Worker revoked a device, so a revoked
phone keeps remembered consent on machines until re-pair, logout, a
consent-key rotation or the 400-day cap; such a skip still needs a valid
owner Access JWT, which sign-out-everywhere revokes. This gap is an
accepted risk in `SECURITY.md`.

**Detection.** The Worker's `handoff.issued` audit event records whether
consent was remembered or explicit; yaran logs the same verdict under
`yaran::cloud::handoff`.

---

## Maintenance

When you add or change attack surface in this codebase, you must
update both `SECURITY.md` (the table) and this file (the
paragraph). PRs that touch the surface listed above without
updating these documents are blocked at review.

Every ID is a stable reference; a new threat takes the next free
ID at the end rather than reshuffling. Retired
threats are kept in the table with a `~~strikethrough~~` and a
note pointing to the PR that retired them. Threats that move to
**accepted-risk** (in single-user-VM mode, or by a stated design
decision such as T43) keep their original ID,
get a `Status:` line at the top of their long-form section, and
remain referenced from `SECURITY.md`'s "Accepted risks" list.

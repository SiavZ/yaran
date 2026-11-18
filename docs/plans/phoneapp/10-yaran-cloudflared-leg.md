# Phase 10 — yaran: cloudflared acquisition, supervisor leg, control lane, surfaces

**Track:** B (parallel) · **Parallel-safe with:** 04, 05, 06, 07, 08, 11, 12, 13, 14, 15, 16, 17, 18
**Depends on:** 09 (credentials, `CloudPaths`, `MachineApi` incl. `set_origin` and `rotate`, `RevocationSignal`, `[cloud]` keys, leg-state format); 02 (error codes, W5 `MachineConfig`, W7 rotate, W32 `PUT /v1/machine/origin`); 03 gate G2 (Host / HTTP/1.1 / `access.required`, primary and fallback below); 01 · **Blocks:** 11 (writes the ingress cell 11 reads), 13 (bootstrap `cloud` projection, `cloud.changed`), 19

## Goal

While yaran is serving and this machine is paired, run exactly one supervised `cloudflared`
child that dials out to Cloudflare and forwards to yaran's loopback listener. The tunnel is
a **leg** with no listener of its own. It follows the Tailscale leg's control shape:

- a tri-state mode;
- one control lane that only the serve loop acts on;
- both reload owners;
- one sentence per outcome on every surface.

The leg also has to do the jobs that a listener never had:

- get a trustworthy binary;
- keep the child alive;
- notice when Cloudflare stops accepting its token;
- never leave an orphan process behind.

## Evidence

Code was checked against `main` at `ba9e61b9` on 2026-11-14 by sub-agents reading the full
call paths. cloudflared was read at tag `2026.11.0` (commit `b0297f0b`). In the citations
below, `SRC` stands for `https://github.com/cloudflare/cloudflared/blob/2026.11.0/`.

### Tailscale leg template (`crates/yaran-web/src/serve_legs.rs`, 1562 lines)

- `TailscaleModeControl` (:709-722) holds `tx: mpsc::Sender<ModeRequest>`, `runtime`,
  `watched` and `host_literals`.
  - `new` (:726). `set_mode_detached` (:760) runs on the runtime. `set_mode` (:776) maps a
    closed lane to `NotServing` and a timeout to `TimedOut`.
  - `MODE_REQUEST_QUEUE` is 8 (:681). `MODE_REQUEST_TIMEOUT` is 7s (:689).
- `ModeStep` (:545) and `plan_mode_change` (:569) form the pure planner.
- `TAILSCALE_LEG_KEY` (:236). `LegStatus` / `LegCoalescer` (:246-423) apply a 6s dwell
  (:264).
- `ServeShutdown::record_best_effort_failure` (:218) records a leg death without tripping
  the serve.

### Serve loop (`crates/yaran-web/src/lib.rs`, 3532 lines)

- `run_serve_loop` (:885) is a `tokio::select!` (:904) with these arms:
  - shutdown :905
  - mode request :906-929
  - detection :930-952
  - `join_next` :953
  - dwell :960-971
  - leg command :972-984
  
  After the loop it runs `ts.shutdown()` (:993) and drains the tasks (:996).
- `apply_mode_request` (:1071). Detection runs as its own arm through `spawn_blocking`
  (:1135-1150), never awaited inside the mode arm.
- The control lane is built in three places:
  - `run_plain_http` (`yaran server`) :489-494
  - `ServeCore::start` :1552-1557, which covers both the flip and background mode
  - `router_params` :1379, which passes it to the router
- Wind-down, per mode:
  - `yaran server`: :589-591
  - `ServeCore::wind_down` :1725, which joins with a 3s timeout (`SERVER_JOIN_TIMEOUT` :619)
  - `finish` :1748, which calls `shutdown_timeout(2s)`
  - the flip, `serve_with_engine`: :1874-1904
  - background, `BackgroundServer::stop` (`background.rs:190`): reached from
    `stop_background_server_quietly`, which runs on every `App::run` exit (`app/mod.rs:4563`)
- **A second signal calls `std::process::exit(130)`** (:1969-1975), and the TUI's
  `QuitWatchdog` calls `exit(129)` (`app/hangup.rs:193`). Neither runs a destructor.

### Reload owners and other seams

- `yaran server` and the flip: the engine actor's reload arm (`engine_actor.rs:2845-2914`)
  captures the previous and next mode before the swap (:2857), calls `set_mode_detached`,
  and posts a keyed status (:2890-2905). The control lane sits in a `OnceLock`
  (:626-627, :771-776).
- Background mode: the TUI's `apply_reloaded_config` (`app/mod.rs:6020`) captures the mode
  before the swap (:6055), then asks the companion only if a serve was running both before
  and after the reload (:6101-6107). The actor arm never runs in this mode (:2884-2889).
- Companion seam:
  - `BackgroundServeCompanion` (`yaran-core/src/background_serve.rs:214`) declares
    `set_tailscale_mode` (:295) and `connections` (:264).
  - `WebCompanion::set_tailscale_mode` (`crates/yaran/src/companion.rs:115-119`).
  - `BackgroundServer::set_tailscale_mode` (`background.rs:174-185`) sends
    `WorkerEvent::TailscaleModeApplied` (`worker.rs:721`).
- Palette path:
  - `set-tailscale-mode` registration: `palette.rs:184-191`, `action.rs:199`,
    `keybindings.rs:337-345`, and the tests at `keybindings.rs:3293, 3376`
  - dispatch: `execute_command` arm (`app/mod.rs:5692-5694`)
  - picker functions in `background_server.rs`: `open_set_tailscale_mode_prompt` :504,
    `save_and_apply_tailscale_mode` :564, `ask_companion_for_tailscale_mode` :590-622,
    `apply_tailscale_mode_outcome` :625-654
  - config write: `WireCommand::SetTailscaleMode` (`wire.rs:255`, dispatch :1865) and
    `Engine::set_tailscale_mode` (:2239)
- Web path:
  - route: `config_routes.rs:63`, handler :467-497
  - Preferences row: `settingsDescriptors.ts:366-390`, with its tests in
    `settingsDescriptors.test.ts` (key pin :60-94)
  - client call: `configApi.ts:69-100`; the dialog builds the write in `buildWrites`
    (`CustomizeWebappDialog.tsx:427, 455`)
  - bootstrap: `BootstrapView` (`viewmodel.rs:44`, :326-338, :1469; field pin :3285),
    `bootstrap_routes.rs:35` and `bootstrapApi.ts:100-105`
  - state: `AppState` (`server.rs:36`, :143-147)
- Host guard: `TailscaleLiterals::Live(Arc<AtomicBool>)` (`host_guard.rs:152-158`), passed
  through `RouterParams.with_live_tailscale_host_literals`. The serve loop is its only
  writer (`lib.rs:1110`).
- Header crumb: `serving_chip` / `serving_chip_label` (`background_server.rs:30, 785`),
  rendered by `app/render.rs:1707`. The flip's status screen shows a URL snapshot
  (`server_screen.rs:89, 133`). The console has `leg_changed` (`console.rs:420`).
- Reload exec runs only in the TUI (`reload_policy.rs:162-174`). The background server is
  stopped before the exec (`app/mod.rs:4563`). Any child that is not a PTY survives the
  exec with nothing holding it (`pty_adopt_child.rs:9-15`).

### Process primitives

- `bounded_command::run_command_with_timeout` (:50) suits one-shot probes. It kills the
  pid only.
- `WatchBackoff` (`watch/rule.rs:170-199`) provides `deterministic_delay_ms(attempt)`
  (`pub(crate)`). Jitter is inline in `watch/engine.rs:498-506`, using a `rand` `SmallRng`
  (`rand` is already a direct dependency).
- Group signals use `rustix::process::kill_process_group` (`pty.rs:2357-2372`). No
  production code calls `process_group(0)` today.
- Also reused: `sysinfo` (direct dependency, used to verify a stale pid), `flate2` (direct
  dependency, for gzip), `ring::digest` (direct from 09).

### cloudflared facts (Apache-2.0)

- Flags: `--token-file` / `TUNNEL_TOKEN_FILE` arrived in 2025.4.0
  (SRC`tunnel/subcommands.go:132-136`, SRC`RELEASE_NOTES:336`). It is read once and
  trimmed.
- With stdout piped there is no TTY, so cloudflared self-updates and exits 11 unless
  `--no-autoupdate` is set (SRC`updater/update.go:271-303, 41-70`).
- `--metrics` defaults to the first free port in 20241-20245 (SRC`metrics/metrics.go:28-53`).
- `/ready` answers 200 with `{"status","readyConnections","connectorId"}` when at least one
  connection is up, and 503 otherwise (SRC`metrics/readiness.go:36-61`).
- `--grace-period` defaults to 30s and is capped at 3m. A second SIGTERM forces exit
  (SRC`tunnel/cmd.go:825-829`, SRC`tunnel/signal.go:12-23`).
- Exit codes: 1 for an error, 255 for a usage error such as an invalid token or "Failed to
  read token file" (SRC`tunnel/subcommands.go:770-786`), and 10/11 for self-update. A
  graceful exit returning 0 is inferred and UNVERIFIED.
- **An auth failure never exits.** An "Unauthorized" registration error is retried forever
  (SRC`supervisor/supervisor.go:256-264`, `retryForever` :126/:211/:235), backing off to
  32s.
- Rotating the secret leaves running connectors up until they restart or until the
  connections are deleted (https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/,
  read 2026-11-14).
- JSON logs go to stderr (`--output json`, SRC`logger/create.go:187-188`), with fields
  `level`, `time`, `message`, `error`, `connIndex`, `ip`, `event`, `connection`,
  `location` and `protocol`. `"Registered tunnel connection"` is logged at info
  (SRC`connection/observer.go:56-66`). `"Register tunnel error from server side"` carries
  `error:"Unauthorized: …"` (SRC`supervisor/tunnel.go:440-444`).
- The token is masked in cloudflared's own logs. However, **any environment variable whose
  text contains `TUNNEL_` is logged in clear** unless it is `TUNNEL_TOKEN` or
  `TUNNEL_CRED_CONTENTS` (SRC`tunnel/configuration.go:77-114`).
- Origin side: Host is preserved unless `httpHostHeader` is set (SRC`ingress/origin_proxy.go:47-52`),
  and `http2Origin` defaults to false (SRC`ingress/config.go:139`). Both are
  source-confirmed; G2 proves them live.
- **`originRequest.access` is honoured only from each ingress rule's own `originRequest`,
  never from the tunnel-wide block** (SRC`ingress/ingress.go:429-437`; 03 G2). 05 therefore
  writes it per tunnel route.
- **Release 2026.11.0 fixed an Access bypass via matrix parameters (VULN-170057)** (03 G2,
  R4 Hard constraint 13). That makes 2026.11.0 the **minimum** cloudflared yaran will run,
  managed or user-supplied; it also implies `--token-file`, which arrived in 2025.4.0.
- Release assets: darwin ships `.tgz` archives holding one `cloudflared`; Linux ships raw
  binaries. The release-body SHA-256 for a darwin `.tgz` is the hash of the **inner
  binary**, not the archive. The archive's hash is the GitHub API asset `digest`
  (`gh release view 2026.11.0`, 2026-11-14). There are no signature files.
- Support: Cloudflare supports releases within one year of the latest one
  (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
- yaran's release targets: `x86_64`/`aarch64` `unknown-linux-musl` and `x86_64`/`aarch64`
  `apple-darwin` (`.github/workflows/release.yml:106-115`).

## In scope

Managed acquisition and a user path, version probing, the supervisor, the exit and
Unauthorized policy, orphan prevention, the leg, the planner, the outcome sentences, the
`CloudModeControl` lane and serve-loop arms, both reload owners, the ingress-cell seam that
11 consumes, the leg-state file, keyed statuses, the TUI palette picker and header crumb,
the flip status line, `yaran server` console lines, the web Preferences row and route, the
bootstrap projection, the `cloud.changed` event, the pin-bump tool, and unpaired, revoked
and rotated handling.

## Out of scope

| Item | Owner |
|---|---|
| Tunnel/ingress provisioning: per-tunnel-route `originRequest.access {required: true, teamName, audTag}` on the machine's own ingress rule (never only the tunnel-wide block, which cloudflared ignores for access), `httpHostHeader`, `http2Origin`, and the ingress repair behind W32 (`setOriginPort`, step P4) | 05 |
| Host-guard rule and JWT checks that read the ingress cell | 11 |
| Login, logout, rotate verbs, credentials file, signed client | 09 |
| Scheduled pin-freshness workflow and the CI job that caches the pinned binary | 18 |
| Web "Connect a phone…" | 13 |
| Threat rows T25 (the minimum-version check keeps per-route access enforceable), T27 (token file, argv, environment), T29, T30, T53 text (17 drafts, this phase's PRs amend); consumer docs | 17 |

## Design

### Shape

```text
[cloud] mode ─┐                 credentials revision (poll, 2s) ─┐   RevocationSignal ─┐
              ▼                                                  ▼                     ▼
 CloudModeControl::set_mode ──▶ mpsc<CloudModeRequest> ──▶ run_serve_loop: cloud arm ◀── mpsc<CloudLoopInput>
   (actor OnceLock / AppState / ServeCore)                      │ plan_cloud_change (pure)
                                                                ▼
                                       CloudLoop (yaran-web) ── owns ── CloudLeg (yaran-core, std threads)
                                         │ writes LiveCloudIngress (only after Ready, cleared otherwise)
                                         │ posts keyed statuses, console lines, `cloud.changed`, view snapshot
                                         ▼
                      acquire ─▶ spawn cloudflared (own process group) ─▶ stderr JSON reader ─▶ /ready poller
                                         └─ exit / Unauthorized ─▶ plan_after_exit (pure) ─▶ restart │ heal │ stop
```

- yaran-core holds the leg and has **no tokio**. The leg talks to the serve loop through an
  injected sink (`Box<dyn Fn(CloudLegEvent) + Send>`), and the yaran-web side uses
  `blocking_send` into the select arm.
- The serve loop is the only writer of the ingress cell and the only actor on mode
  changes. This is the "only the serve loop may act" tenet carried over from Tailscale.

### Desired state and planner (pure, `cloud/planner.rs`)

- **`desired_leg(mode, pairing, serving) -> Desired`**
  - `mode == No`: `Stop(ModeOff)`.
  - Not paired: `Stop(NotPaired)`. The tone is Info under `auto` and a sticky Warning
    under `yes`, naming `yaran cloud login`.
  - `revoked_at` is set: `Stop(Revoked)`.
  - The loopback origin is unreachable: `Stop(NoLoopbackPrimary)`. Reachability is a
    100 ms TCP connect to `127.0.0.1:<port>`, an empirical check that also settles the
    `[::]` dual-stack case.
  - Origin port mismatch: `Stop(OriginPortMismatch{paired, serving})`. This applies only
    when the W32 origin update below fails.
  - Otherwise: `Run`.
- **`plan_cloud_change(running, desired) -> Vec<CloudStep{StopLeg, StartLeg, ReplyOutcome}>`**
  runs on every input: a mode request, a credentials revision change, a revocation, or a
  terminal leg failure.
- `CloudModeOutcome` covers mode changes. Its variants are exhaustive: `Starting{hostname}`,
  `AlreadyRunning`, `Stopped`, `NotPaired`, `Revoked`, `NoLoopbackPrimary`,
  `OriginPortMismatch{paired, serving}`, `BinaryUnavailable{reason}`, `NotServing`,
  `Superseded` and `TimedOut`. `report(mode)` builds a `status_text!` sentence with the
  hostname and the command as chips.
- Becoming ready is reported separately, on the leg key ("Remote access is live at
  `<hostname>`, protected by Cloudflare Access for `<owner>`"). The reason is the same as
  Tailscale's `Applied{bound}`: a mode reply must not wait out a download.
- Keys:
  - `cloud-mode`: `MODE_CHANGE_STATUS_KEY` style
  - `cloud-leg`: coalesced 6s, reusing `LegStatus`/`LegCoalescer`. If the key is
    hard-coded today, it becomes a constructor parameter, and the Tailscale call sites pass
    `TAILSCALE_LEG_KEY` (an extraction under 00-CONVENTIONS §1.2).
  - `cloud-cloudflared`: download busy status, then its final.

### Acquisition (`cloud/cloudflared/`)

**Pins.**
- `pins.rs` holds `PINNED_VERSION` (2026.11.0 at this writing), `PINNED_RELEASED` (a date),
  and one row per yaran target: `{asset, kind: Raw|Tgz, asset_sha256, binary_sha256}`.
- `tools/cloudflared-pin/bump.sh` generates the file, and a header marks it generated. The
  tool reads asset `digest`s from the GitHub API for archive hashes and the release-body
  block for binary hashes, downloads each asset, and verifies both.
- No hash is ever typed by hand.

**Minimum version.**
- `version.rs` holds `MIN_VERSION = 2026.11.0`, hand-maintained (not generated) with a
  comment naming why: the VULN-170057 Access-bypass fix and per-route `originRequest.access`
  (03 G2, T25, T29). Raising it is a deliberate PR.
- A unit test asserts `PINNED_VERSION >= MIN_VERSION`, and `bump.sh` refuses to write a pin
  below it, so the managed binary always meets the floor.
- Every binary is version-checked before each spawn (the user path below; the managed path
  by the pin plus its hash). Nothing below the floor is ever executed.

**Managed path.** This applies when `cloudflared_path` is empty.
- The binary lives at `<root>/cloud/bin/cloudflared-<version>`, mode 0700. A new constant
  `file_modes::PRIVATE_EXEC_MODE = 0o700` goes in the one module that decides modes; the
  directory is 0700.
- On each start, the leg thread re-hashes the binary (`ring::digest`, about 40 MB) and
  compares it to `binary_sha256`.
- If the binary is missing or the hash does not match, the leg downloads it.
  - Source: `https://github.com/cloudflare/cloudflared/releases/download/<v>/<asset>`.
  - A ureq agent follows redirects, with an idle timeout of `request_timeout_seconds` per
    read and no global cap. Whether ureq 3.3 has the per-read timeout and redirect
    defaults is UNVERIFIED; the PR checks them against the config builder.
  - The body is capped at 150 MB. It is streamed into a 0600 `.part` file while being
    hashed. The asset hash is checked first.
  - For a `Tgz` asset, `targz.rs` (flate2 plus an 80-line ustar reader) accepts only a
    regular file named `cloudflared`, capped at 200 MB. The extracted binary's hash is
    checked. Because the hash is the trust anchor, the reader needs no `tar` crate.
  - Then: chmod 0700, rename, and delete older `cloudflared-*` files.
  - Any mismatch deletes the temp files and **fails closed** with `BinaryUnavailable`. The
    sentence names the expected hash, the actual hash, and `cloudflared_path` as the way
    out.
  - Progress is a keyed Busy updated at most once a second ("Downloading cloudflared
    2026.11.0 (41 MB): 42%"), followed by its final.
- A download never happens unless the machine is paired and the planner says `Run`.
- macOS: ureq sets no quarantine xattr, so Gatekeeper is not involved. The binary is
  Developer-ID signed upstream; notarization is UNVERIFIED and irrelevant here.
- Targets outside the four rows get `BinaryUnavailable(UnsupportedTarget)`, which names
  `cloudflared_path`.

**User path.**
- `version.rs` runs `cloudflared --version` through `bounded_command` with a 5s timeout,
  then parses `cloudflared version YYYY.M.N`.
- Below `MIN_VERSION` (2026.11.0) it fails closed with `BinaryUnavailable(TooOld{found,
  min})`. The sentence names the found version, the minimum and why ("needed for
  per-route Cloudflare Access enforcement and the VULN-170057 fix"), and offers emptying
  `cloudflared_path` to use the managed binary. An unparseable `--version` output fails
  closed the same way.
- If the binary is more than 365 days older than `PINNED_RELEASED`, it warns (once per
  start) that the version is outside Cloudflare's support window.
- There is no hash check, because the binary is the user's responsibility (T29, documented).

**Support window and pin bumps.**
- The leg warns at start when `PINNED_RELEASED` is more than 330 days old: "update yaran;
  its cloudflared is nearing the end of Cloudflare's one-year support".
- Process, run by maintainers and wired by 18:
  - Bump at least every 60 days, and within 7 days of any release whose notes contain
    `VULN-`.
  - `bump.sh --check` exits non-zero when either condition is met.
- A PATH-installed cloudflared is deliberately ignored unless it is configured: managed
  and pinned are deterministic, and explicit beats ambient.

### Child command (`command.rs`)

```text
<bin> tunnel --no-autoupdate --metrics 127.0.0.1:<port> --output json --loglevel <lvl>
      --grace-period <g>s --management-diagnostics=<bool> run --token-file <root>/cloud/tunnel-token
```

- **Token file.** `tunnel-token` is written from the credentials (0600, `private_file`)
  immediately before each spawn and deleted when the leg stops. The token never appears in
  argv (D5, T27).
- **Environment.** `env_clear()`, then only `HOME`, `PATH`, `TMPDIR` and
  `NO_AUTOUPDATE=true`. This is because cloudflared logs every `TUNNEL_*`-containing
  variable in clear, and yaran's environment may hold `[env]` secrets.
- **Metrics port.** Port 0 is resolved by binding `127.0.0.1:0`, reading the port, and
  dropping the socket. If cloudflared loses that race it exits 1, and the restart picks a
  new port.
- **Process.**
  - stdin is null. stdout and stderr are piped.
  - `process_group(0)`, so a terminal Ctrl-C does not reach the child; yaran owns its
    shutdown.
  - On Linux only, a `pre_exec` does `prctl(PR_SET_PDEATHSIG, SIGTERM)`. That signal fires
    when the **spawning thread** exits, so every spawn happens on the leg's one long-lived
    supervisor thread, which outlives its children.
- **Flag placement.** The tunnel-level flags come before `run` and `--token-file` after it
  (cloudflared docs examples). A gated integration test runs the real pinned binary
  offline: with a nonexistent token file it must exit 255 with "Failed to read token
  file", and never with "flag provided but not defined".

### Supervisor and policy (`supervisor.rs`, `policy.rs`, `log_lines.rs`)

**Stderr reader thread.**
- Lines are capped at 16 KiB and parsed as JSON objects (key order is not stable).
- `message` and `error` are sanitized with `for_terminal`. Any occurrence of the exact
  token text is replaced by `*****` as a backstop.
- Each line is emitted as `tracing` under target `yaran::cloudflare`, with levels mapped
  one to one.
- Lines that are not JSON (usage errors) are logged as warn, sanitized.
- Classification:
  - `Registered tunnel connection` → `Registered`
  - an `error` containing `Unauthorized` → `Unauthorized(at)`
  - everything else → `Other`

**Ready poller.**
- Polls `GET http://127.0.0.1:<port>/ready` with ureq (`proxy(None)`): every 1s until
  ready, every 5s after.
- `readyConnections > 0` means Ready.
- Ready emits `CloudLegEvent::Ready`. Leaving Ready emits `NotReady`.

**`plan_after_exit(exit, ctx) -> ExitAction`** is pure and table-tested.

| Exit | Action |
|---|---|
| after our SIGTERM | `Done` |
| 255 | `Heal` (token unreadable or invalid; see below), no backoff loop |
| 10 / 11 (self-update despite the flag) | managed binary: re-verify hash; mismatch → delete, re-acquire, `Restart`; user path: warn, `Restart` |
| 0 unexpected, 1, killed by signal | `Restart(backoff)` |
| spawn error ENOENT/EACCES | `Stop(BinaryUnavailable)` |

- Backoff uses `WatchBackoff::deterministic_delay_ms(attempt)` with the `[cloud]` bounds
  plus `rand` jitter. It resets after 60s of continuous Ready.
- Restarts are unbounded, as cloudflared's own retries are, but the first failure of each
  run of failures posts a `cloud-leg` Warning, and a run that never reaches Ready escalates
  it to sticky after 5 attempts.

**Unauthorized and heal.**
- cloudflared never exits on auth failure, so the policy watches for **Unauthorized seen,
  and `/ready` continuously 503, for `unauthorized_confirm_seconds`**. When that holds:
  - `MachineApi::config()` returns 410 → `RevocationSignal` (09 also stamps `revoked_at`)
    → stop, sticky Warning: "Yaran Cloud revoked `<hostname>`; remote access is off. Run
    `yaran cloud login <org>` to pair again."
  - It returns 200 → compare `MachineConfig.tunnel.token_version` with the stored
    `token_version`:
    - higher → `MachineApi::rotate(Sync)` (W7 `reason: "sync"`) fetches the current token
      without rotating again (02 §6), the new token is written to the credentials, the
      revision bumps, restart. This heals an admin rotation.
    - equal → `MachineApi::rotate(User)` mints a fresh token and restarts, as the last
      self-heal before the stop below.
  - The heal runs once per confirm window. If Unauthorized persists after a successful
    rotate, the leg stops with an Error naming both facts and pointing at the admin
    console.
  - A network error keeps the child running, retries after the next window, and warns once.
  - A `signature_expired` answer (02 §7, `details.server_time`) keeps the child running and
    posts a `cloud-leg` Warning naming the offset ("this machine's clock is off by N s; fix
    the system clock"), as 02's Risks row expects of this phase.
- Which edge string ("Failed to get tunnel" or "Invalid tunnel secret") means deleted and
  which means rotated is UNVERIFIED. The policy deliberately keys only on `Unauthorized`
  plus the control plane's answer.

**Stop.**
- SIGTERM to the group. Wait `grace_period_seconds + 2`. SIGKILL the group. Reap.
- The stdout and stderr readers are joined.

### Orphan prevention (`child_registry.rs`)

The registry is process-global and records the live pgids. Three calls cover the exits:

- `shutdown()` is non-blocking: SIGTERM, and the stopping state is marked.
- `wait_all(deadline)` waits, then SIGKILLs and reaps any survivors.
- `kill_all_now()` sends SIGKILL immediately.

| Exit path | Hook |
|---|---|
| any serve ends | `CloudLoop::shutdown()` in `run_serve_loop`'s post-loop block, beside `ts.shutdown()` (`lib.rs:993`) |
| `yaran server` | `wait_all` after `take_error` (`lib.rs:591`) |
| flip | `wait_all` after `core.finish()` (`lib.rs:1904`) |
| background (quit, flip, **reload exec**) | `wait_all` after `stop_background_server_quietly` (`app/mod.rs:4563`), so the child is gone before `exec` |
| second signal `exit(130)` / `QuitWatchdog` `exit(129)` | `kill_all_now()` one line before each exit |
| parent SIGKILL / crash | Linux PDEATHSIG; on both OSes, a **stale reap** at the next leg start: read `leg-state.json`; if the pid is alive and `sysinfo` reports the same exe path and start time, SIGTERM→grace→SIGKILL its group |

**Reload exec decision: kill and respawn, not adopt.** The PTY adopt path
(`pty_adopt_child.rs`) exists to keep a conversation alive. A tunnel reconnects in seconds,
and adopting would need the pid, both pipes and the reader threads handed across the exec.
After the exec, `serve_while_tui` restarts the serve and the leg follows.

### Ingress cell, the seam for 11 (`cloud/ingress_cell.rs`)

- `CloudIngress { hostname, team_domain, aud, owner_email }` is taken from the credentials
  (`owner_email` is `ClaimResponse.owner_email`, stored by 09; D3).
- `LiveCloudIngress::new() -> (CloudIngressWriter, CloudIngressReader)` wraps an
  `Arc<RwLock<Option<Arc<CloudIngress>>>>`.
  - The writer is not `Clone`, and only `CloudLoop` owns one.
  - Readers clone cheaply.
- It is set **only on `Ready`** and cleared on every other transition and on shutdown, so
  the rule is live exactly while the tunnel can deliver requests. D4 requires a live rule
  and never an `allowed_hosts` entry.
- This phase wires the reader into `RouterParams` (`.with_cloud_ingress(reader)`) and
  `AppState`. 11 adds the host rule and the JWT middleware that consume it.

### Origin port (02 `origin_port`, W32)

09 sends `origin_port` at authorize and in the claim and stores the answer. This phase owns
**triggering** the update when the port later changes (02 names 10 as W32's caller):

- Before every `StartLeg`, the leg compares the serving loopback port with
  `credentials.origin_port`. Equal: start.
- Different: `MachineApi::set_origin(serving)` (signed `PUT /v1/machine/origin`,
  `OriginUpdate {origin_port}`) → `202 OriginUpdateResult {origin_port, changed}` → 09's client
  rewrites `origin_port` in the credentials (the revision bump is ignored for this one write,
  so it does not loop) → start. The Worker's ingress repair (05 `setOriginPort`, step P4)
  runs asynchronously, so the first requests may 502 until it lands; `Ready` still gates the
  ingress cell.
- `410 machine_revoked` → `RevocationSignal` → `Stop(Revoked)`.
- Any other failure (network, `signature_expired`, a refusal) → `Stop(OriginPortMismatch{paired,
  serving})` with the sentence "this machine was paired for port X; yaran is serving on Y;
  set `[server] port = X` or check your network", and the next input retries.
- A `MachineConfig.origin_port` read during heal that disagrees with the credentials is
  treated the same way (the Worker is authoritative after a repair by an admin).
- This is the yaran half of 19's hook H2 (the ingress follows the reported `[server] port`).

### Gate G2 (03)

**Primary**, confirmed in source: Host is preserved and the origin speaks HTTP/1.1. Access
is enforced at the connector only through **per-tunnel-route** `originRequest.access
{required: true, teamName, audTag}` on the machine's own ingress rule (05 writes it), and
only by cloudflared ≥ 2026.11.0, which this phase enforces for every binary it runs.

**Fallback**, if G2 disproves either: 05 sets `httpHostHeader = <hostname>` (Host then
equals the public name, so Origin==Host still holds) and an explicit `http2Origin: false`.
Nothing changes in yaran. If G2 shows `access.required` is not enforced, 11's own JWT
check (D3) still guards. This phase is unaffected.

### Surfaces

**View.**
- `cloud/view.rs` `CloudLegView { mode, state: CloudLegState, hostname, org_url,
  org_name, since, detail }`.
- `CloudLegState` (exhaustive) is one of `Off`, `Unpaired`, `Acquiring{pct}`, `Starting`,
  `Ready`, `Reconnecting`, `Healing`, `Revoked`, `Failed` or `NotServing`.
- One `Arc<Mutex<CloudLegView>>` snapshot is written by `CloudLoop` and read by every
  surface below. The same writer persists `leg-state.json` (09's format) for the CLI and
  the stale reap.

**Web.**
- `BootstrapView.cloud` is injected the way `tailscale_forced_no` is
  (`bootstrap_routes.rs:35`).
- `GET /api/v1/cloud/leg` returns the snapshot; it is cheap and makes no remote call.
- A payload-less resource event `cloud.changed` on `/ws/events` fires on every state
  change. 13 refetches on it.
- Preferences row `cloud.mode` (an enum, `writeTarget: "cloudMode"`) and
  `POST /api/v1/server/cloud-mode`:
  - `WireCommand::SetCloudMode` (config write, then refuse or save)
  - then `control.set_mode`
  - reply `{mode, warning, message, segments}`
  
  This mirrors `config_routes.rs:467-497`.

**TUI.**
- Palette command `set-cloud-mode` opens a Picker-family prompt modelled on
  `open_set_tailscale_mode_prompt`. It saves, then asks the companion (when
  background-serving), and the result comes back through `WorkerEvent::CloudModeApplied`.
- Companion trait gains `set_cloud_mode(&mut self, &Engine, CloudMode)` and
  `cloud_view(&self) -> Option<CloudLegView>`.
- **Header crumb:** the serving chip gains a cloud segment.
  - `☁ <hostname>` when Ready, `☁ connecting…` while Starting or Reconnecting,
    `☁ revoked` or `☁ failed` in the warning token. Nothing is shown when the state is
    `Off` or `Unpaired` under `auto`.
  - Colors come only from existing semantic theme tokens.
  - The view snapshot is compared in the redraw gate (TUI tenet: a change with no
    mutation path on this surface must be compared there).
- The flip's status screen gets a live cloud line under the URLs.

**`yaran server` console.**
- Lines for Ready, lost, revoked and failed.
- On the first Ready of a run, it prints one sentence (D17): "Cloudflare terminates TLS
  for `<hostname>` and can see this traffic".

### Reload owners

- **Engine actor arm** (`yaran server`, flip): capture the previous and next `cloud.mode`
  beside :2857. If they changed, call `CloudModeControl::set_mode_detached` and post a
  keyed `cloud-mode` status. The control lane gets its own `OnceLock` slot, set beside
  :771.
- **TUI `apply_reloaded_config`:** capture `cloud_before` beside :6055. After
  `apply_serve_while_tui_setting`, ask the companion only when a serve was running both
  before and after and the mode changed. As for Tailscale, the change is never applied
  twice.
- Other `[cloud]` keys take effect at the next child (re)start (09's comment says so). A
  changed `cloudflared_path`, `metrics_port`, `cloudflared_loglevel`,
  `management_diagnostics` or `grace_period_seconds` triggers a restart through the same
  arm, as an `Input::ConfigChanged`, so "applies live" stays true.

## Work items

Every created file carries the §2 header with its generated module trees. Sizes are
planned ceilings.

1. **Pins and the bump tool.**
   - Create `crates/yaran-core/src/cloud/cloudflared/pins.rs` (~90, generated) and
     `tools/cloudflared-pin/bump.sh` (~220).
   - Tests:
     - `current_target()` maps all four triples;
     - a pin-table sanity test (64-hex hashes, distinct assets);
     - `bump.sh --check` against a recorded API fixture;
     - `bump.sh` refuses a version below `MIN_VERSION`.
2. **Acquisition.**
   - Create `cloudflared/acquire.rs` (~420), `cloudflared/targz.rs` (~130) and
     `cloudflared/version.rs` (~160). Touch `file_modes.rs` to add one constant.
   - Reuse: `private_file` (09), `ring::digest`, `flate2`, `bounded_command`, and 09's
     ureq agent builder.
   - Tests:
     - a loopback download stub serves good, truncated, wrong-hash and oversize bodies;
     - fail closed leaves no file behind;
     - the tgz rejects a second entry, a symlink and an oversize member;
     - a tampered managed binary is re-downloaded;
     - version parse and compare table, including 2026.11.0 exactly, 2026.10.x and 2025.4.0
       (refused as `TooOld`), an unparseable output (refused), and the support-window warning;
     - `PINNED_VERSION >= MIN_VERSION`;
     - the user path uses the `StandIn` fake-CLI pattern (`tailscale.rs:308-352`).
3. **Command and supervisor.**
   - Create `cloudflared/command.rs` (~180), `cloudflared/log_lines.rs` (~200),
     `cloudflared/policy.rs` (~260), `cloudflared/supervisor.rs` (~450) and
     `cloudflared/child_registry.rs` (~200).
   - Tests:
     - argv contains no token;
     - the environment is exactly the allowlist;
     - a `process_group` group kill reaches a grandchild;
     - the `plan_after_exit` table;
     - Unauthorized tracker timing with an injected clock;
     - log redaction and sanitizing;
     - `/bin/sh` fake children exercise exit 1/255/11, ignore SIGTERM (so SIGKILL after
       the grace period), and print `Registered` JSON;
     - an injected ready probe and a std-thread `/ready` stub;
     - stale reap kills only a pid whose exe and start time match.
   - Gated (`#[ignore]`, `YARAN_TEST_CLOUDFLARED=<path>`, run by 18 with the cached
     pinned binary): the real-binary flag-parse test.
4. **Leg, planner, outcomes, view, ingress cell.**
   - Create `cloud/leg.rs` (~420), `cloud/planner.rs` (~200), `cloud/leg_outcome.rs`
     (~260), `cloud/view.rs` (~150) and `cloud/ingress_cell.rs` (~110).
   - Tests:
     - `desired_leg` and `plan_cloud_change` tables (every mode × pairing × serving);
     - outcome sentences, plain and segmented;
     - the ingress cell is set only on Ready and cleared otherwise;
     - the writer is not `Clone` (compile-fail doc test);
     - a revocation stops the leg and stamps the view;
     - an origin-port update and mismatch against the mock Worker from 09: W32 202 with
       `changed` true and false rewrites `origin_port` and starts; 410 stops as revoked; a
       network failure gives `OriginPortMismatch`; the credentials write does not re-trigger
       the planner;
     - heal: config `token_version` higher → `rotate(Sync)`; equal → `rotate(User)`;
       `signature_expired` → clock warning, child kept.
5. **Control lane and serve loop.**
   - Create `crates/yaran-web/src/cloud_mode.rs` (~280: `CloudModeControl`, request,
     timeouts copied from `serve_legs.rs:681-789`) and `crates/yaran-web/src/cloud_loop.rs`
     (~420: inputs, steps, statuses through `LegStatus`, console, `cloud.changed`, the view
     writer, shutdown).
   - Touch `lib.rs`:
     - `run_serve_loop`: one parameter, two select arms (mode requests, loop inputs), one
       post-loop line;
     - construction and distribution in `run_plain_http` and `ServeCore::start`;
     - `wait_all` in `yaran server` and the flip;
     - `kill_all_now` before `exit(130)`.
   - Touch `serve_legs.rs`: the `LegStatus` key parameter, if needed.
   - Touch `engine_actor.rs`: the `OnceLock` slot and the reload-arm lines.
   - Touch `server.rs`: the `AppState` field and the `RouterParams` builder.
   - Touch `background.rs`: `set_cloud_mode` and `cloud_view`.
   - Create `crates/yaran-web/src/console_cloud.rs` (~90, `impl Console`).
   - Tests:
     - a `live_cloud_mode_tests` module in `cloud_loop.rs` mirroring
       `live_tailscale_mode_tests` (`lib.rs:2837`);
     - every request is answered, including superseded ones;
     - a closed lane gives `NotServing`;
     - a credentials change starts and stops the leg;
     - shutdown leaves no child;
     - reload-arm tests beside `engine_actor.rs:5947-6151`.
6. **Config write and wire.**
   - Create `crates/yaran-core/src/engine/cloud_mode.rs` (~90, `impl Engine
     set_cloud_mode`).
   - Touch `wire.rs`: the variant, the dispatch arm, and the `mutates_config_static` and
     `wire_to_command` arms.
   - Tests: parse and refuse; `save_lazy` persists `[cloud] mode`.
7. **Web surfaces.**
   - Create `crates/yaran-web/src/cloud_mode_routes.rs` (~200: `POST
     /api/v1/server/cloud-mode`, `GET /api/v1/cloud/leg`) and
     `crates/yaran-web/web/src/lib/settingsDescriptorsCloud.ts` (~70, the row, imported
     into `SETTING_GROUPS`).
   - Touch:
     - `settingsDescriptors.ts`: one import and spread;
     - its test's key pin;
     - `CustomizeWebappDialog.tsx`: a two-line `buildWrites` branch;
     - 09's `cloudApi.ts`: `setCloudMode`, `getCloudLeg`;
     - `viewmodel.rs`: the `cloud` field and the field-pin test;
     - `bootstrap_routes.rs`: the injection;
     - `bootstrapApi.ts`: the type;
     - the server events fan-out: the `cloud.changed` name.
   - Tests: route; Vitest for the row, the toast and the lock; the bootstrap JSON pin.
8. **TUI surfaces.**
   - Create `crates/yaran-tui/src/app/cloud_mode.rs` (~300: picker, save, ask companion,
     apply outcome) and `crates/yaran-tui/src/app/cloud_crumb.rs` (~120).
   - Touch, wiring only:
     - `palette.rs`, `action.rs` and `keybindings.rs` (one command each);
     - `modal.rs`: Picker arm;
     - `app/mod.rs`: `PromptState`, `execute_command`, the `apply_reloaded_config` lines,
       `wait_all` after `stop_background_server_quietly`, the redraw-gate compare;
     - `hangup.rs`: `kill_all_now`;
     - `render.rs`: the crumb call;
     - `server_screen.rs`: the cloud line;
     - `worker.rs` and `events.rs`: `CloudModeApplied`;
     - `background_serve.rs` and `companion.rs`: the two trait methods.
   - Tests:
     - picker family;
     - the outcome applies with and without a pending op;
     - crumb text for every state;
     - the redraw gate notices a view change;
     - registry tests.

## Acceptance

- [ ] With a fake Worker and a fake cloudflared, pairing (09), then `yaran server`, leads
      to Ready within one poll. The ingress cell is set only after Ready, the console
      prints the D17 sentence once, and stopping the server leaves no cloudflared process
      (`pgrep` test).
- [ ] The same holds in the flip and in background mode, and across a TUI reload exec (the
      child is gone before exec and is respawned after).
- [ ] `exit(130)`, the `QuitWatchdog` and a SIGKILLed parent leave no orphan: either killed
      now, killed by PDEATHSIG (Linux), or reaped at the next start.
- [ ] A managed binary with the wrong hash is never executed. A truncated download leaves
      no file. A user path below 2026.11.0 is refused with a sentence naming the minimum, and
      no binary below it is ever spawned.
- [ ] With the serving port different from `credentials.origin_port`, the leg calls signed
      `PUT /v1/machine/origin` before spawning and starts on 202; a failed call stops with
      `OriginPortMismatch`.
- [ ] A forced Unauthorized leads to config 410 → stop, sticky revoked warning, `revoked_at`
      stamped; or config 200 → `rotate(Sync)` (newer `token_version`) or `rotate(User)` →
      restart → Ready.
- [ ] Mode changes from the TUI picker, the web row, and a config reload (both owners) each
      produce exactly one `cloud-mode` sentence with identical wording, and never apply
      twice.
- [ ] The token appears in no argv, environment, log line, `/proc/<pid>/cmdline`, or
      `leg-state.json`.
- [ ] Every new file is ≤ 500 lines with valid header trees. Oversize files gain wiring
      only.

## Validation

```bash
cd /Users/siavash/Projects/yaran
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p yaran-core cloud::cloudflared:: cloud::leg cloud::planner cloud::ingress_cell
cargo test -p yaran-web cloud_mode cloud_loop live_cloud_mode_tests cloud_mode_routes
cargo test -p yaran-web --lib engine_actor::tests::reload
cargo test -p yaran-tui cloud_mode cloud_crumb palette
YARAN_TEST_CLOUDFLARED="$HOME/.cache/yaran-ci/cloudflared-2026.11.0" cargo test -p yaran-core -- --ignored real_cloudflared
tools/cloudflared-pin/bump.sh --check
(cd crates/yaran-web/web && npm run typecheck && npx vitest run src/lib/settingsDescriptors src/lib/cloudApi)
tools/module-headers/module-headers --check
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| cloudflared retries Unauthorized forever, so a revoked machine looks "connecting" indefinitely | Certain without policy | Silent outage | Confirm window → signed config → stop or heal (above). |
| Orphaned child after a hard exit keeps the tunnel up to a dead port | Medium | 502s at the edge; resource leak | Own process group, registry hooks on every exit path, PDEATHSIG (Linux), stale reap with exe and start-time verification. |
| A darwin tgz is verified against the release-body hash and always fails | Certain if naive | No tunnel on macOS | Two hashes per row: the API `digest` for the archive, the body hash for the extracted binary. Generated by the tool. |
| Pinned version ages past Cloudflare's one-year support | Medium | Edge refuses an old connector | 330-day warning, 60-day bump cadence, `--check` in CI (18), user-path escape hatch. |
| Supply chain (T29): tampered download | Low | Code execution as the developer | Fail-closed double hash, owner-only storage, re-hash on every start, `--no-autoupdate` plus `NO_AUTOUPDATE`. |
| Metrics endpoint readable by other local users (T30) | Medium on shared hosts | Ingress config disclosure (no token) | Loopback only, configurable port, documented. `management_diagnostics=false` by default. |
| `PR_SET_PDEATHSIG` fires when the spawning thread exits | Medium | Child killed on restart | All spawns run on the one long-lived supervisor thread. Tested. |
| Serving port differs from the paired origin port | Medium | 502 on a non-default or changed port | Resolved in 02: W32 `PUT /v1/machine/origin` before every start (above); a failure stops with a sentence. |
| A user-supplied cloudflared below 2026.11.0 ignores per-route access or carries VULN-170057 | Medium | Connector-side Access check missing (T25); yaran's JWT check (D3) is the only gate | `MIN_VERSION` check before every spawn, fail closed; the pin is tested ≥ the minimum. |
| Reload exec drops the tunnel for a few seconds | Certain | Brief remote outage | Accepted and documented. Adoption judged not worth the pipe handover. |
| Inferred exit code 0 on graceful stop is wrong | Low | Misclassified as unexpected | After our own SIGTERM every exit is `Done`, whatever the code. |

## References

- `00-README.md` D1-D5, D17; flows 2 and 6. `09-yaran-cloud-identity-and-cli.md`.
- `research/R1-server-core-cli.md` §1, §2, §7, §9, Implications 2-4, 8-9.
- `research/cloudflare-parts/06-cloudflared-tls.md` §1-5.
- cloudflared 2026.11.0 source (SRC paths above); https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/;
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/;
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ (all read 2026-11-14).
- `03-platform-verification-gates.md` G2 (per-rule access, 2026.11.0 floor); `02-protocol-contract.md` §5–§7 (W5, W7, W32, error codes); `19-integration-and-end-to-end-verification.md` hook H2.
- `17-docs-website-threat-model.md` T25, T27, T29, T30, T53.

## Reconciliation notes (2026-11-14)

- R16/R21: `MIN_VERSION = 2026.11.0` added and enforced before every spawn (user path refused below it with a sentence; pin tested ≥ it; `bump.sh` refuses lower). Was a 2025.4.0 floor. Evidence cites VULN-170057 and the per-rule access fact from 03 G2.
- R16: per-tunnel-route `originRequest.access {required, teamName, audTag}` stated in Evidence, Out of scope (05 writes it) and the G2 section.
- R9: origin-port section rewritten: 10 owns triggering signed W32 `PUT /v1/machine/origin` before `StartLeg`, with 202/410/failure handling; the 3890-only fallback is removed because 02 adopted the primary; Risks row rewritten; new tests and an acceptance item.
- 02 W5/W7: Unauthorized heal now compares `MachineConfig.tunnel.token_version` and calls `rotate(Sync)` or `rotate(User)` (was an unconditional rotate).
- 02 §7: `signature_expired` posts a clock-offset Warning (02's Risks row names this phase).
- R9: `owner_email` source (`ClaimResponse.owner_email`, stored by 09) named on the ingress cell.
- R14: T25 and T27 added to Out of scope and References (were T29, T30, T53 only); new risk row for a below-floor user binary (T25).
- R15: 19's hook H2 yaran half noted in the origin-port section. (The hooks table lives in Phase 19, not Phase 03.)
- R20: Depends line names 02's W5/W7/W32; Wave B lines otherwise unchanged.

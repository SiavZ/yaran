# Security Policy

This document is the **living** security posture of `yaran-amq-setup`,
the Rust TUI (`yaran`), and the AMQ integration shipped under
`yaran-amq/`. Audit reports under `docs/audits/` are point-in-time
snapshots; this file is what stays current.

## Reporting a vulnerability

Please email `siavash@kiani.fi` with details and, if possible, a
proof-of-concept. Do **not** open a public GitHub issue for
security-relevant findings until a fix is available. We aim to
acknowledge reports within 72 hours.

## Scope

- The `yaran` TUI binary built from this repository.
- The `yaran-amq` installer (`yaran-amq/install.sh`),
  `bashrc-additions.sh`, and the agent wrappers
  (`claude-amq`, `codex-amq`, `gemini-amq`, `jcode-amq`) and
  `claude-peers-launcher`.
- The skills and seed material installed under
  `~/.claude/skills/` and `$STATE_ROOT/`.
- The configuration and on-disk state under
  `$STATE_ROOT` (default `/data/state` on persistent-disk VMs,
  `~/.config/yaran` on Linux laptops, `~/.yaran` on macOS).
- Cloud Connect: the org control-plane Worker under `cloud/worker`,
  the publisher push relay under `cloud/push-relay`, the shared
  protocol under `cloud/protocol`, and yaran's supervision of
  `cloudflared` and its own Access check on the cloud hostname.
- The phone apps under `mobile/`.

Out of scope: configured upstream provider binaries (including `ntl`) and
the `amq` binary; cloud-provider IAM; the host kernel; the Cloudflare
platform itself (its edge, Access, Tunnel and D1); Apple's and Google's
push services; UnifiedPush distributors; and the org's identity
provider.

## Trust model summary

`yaran` runs as a **single-user, single-Linux-account** TUI. All panes
spawned by `yaran` share the same `$HOME`, the same filesystem
permissions, and the same environment. There is no in-VM isolation
between panes. One compromised pane = one compromised user account.

That assumption is **load-bearing** for every other mitigation in
this document. Do not deploy `yaran` in a multi-tenant context where
multiple humans share the same Linux account.

**Cloud Connect** does not change this. Each machine's workspace is
still single-tenant: the one remote principal is the paired owner,
whom yaran verifies from the Cloudflare Access token on every request
for the machine's cloud hostname, so remote access equals owner
access. The org admin who deploys the control plane is trusted with
the org's Cloudflare account and everything the deploy token can
reach. Cloudflare terminates TLS and can read all tunneled traffic
(T43). The publisher relay is trusted for availability of iOS push
only, never for content: payloads are end-to-end encrypted to the
phone.

## STRIDE threat model

STRIDE (Spoofing, Tampering, Repudiation, Information disclosure,
Denial of service, Elevation of privilege) covers the threats we
actively mitigate. For long-form scenarios, mitigation pointers
into source, residual risk, and detection signals, see
[`docs/operations/threat-model.md`](docs/operations/threat-model.md).

The Cloud Connect and phone-app rows (T25–T64) end with a status:
implemented, partly implemented, or design only. No row is yet verified
against live Cloudflare, Apple or Google, or on real devices.

| #   | Threat                                                                                                  | STRIDE | Asset                  | Mitigation                                                            | Phase        |
|-----|---------------------------------------------------------------------------------------------------------|--------|------------------------|-----------------------------------------------------------------------|--------------|
| T1  | Malicious repo executes through permission, sandbox, or hook-trust bypasses                              | T,E    | Host shell, API tokens | Default-deny YOLO; `SessionSettings.yolo_permissions` is per-session and defaults to `false`, mapping to `CLAUDE_AMQ_YOLO=1` / `CODEX_AMQ_YOLO=1` for wrapper providers and native `opencode --auto` for OpenCode. A missing or corrupt `agent_sessions.session_settings` blob loads `SessionSettings::default()` (asymmetric default) so a tampered DB cannot escalate a session into YOLO. Codex hook trust review is preserved independently unless the operator explicitly sets `CODEX_AMQ_BYPASS_HOOK_TRUST=1`. Wrappers fail closed below reviewed provider-version floors or when the version cannot be parsed. | 01, hardened in audit03 phases 01/B/P1 |
| T2  | Compromised AMQ peer spoofs `--me <other>` and injects text                                             | S,T    | Sibling panes          | **Accepted-risk in single-user-VM mode** (see "Accepted risks" below). Strict verification is opt-in via `[amq.inject].verify_envelope = true`; YARAN2 HMAC envelopes bind sender, recipient, timestamp, nonce, and byte-safe body, with atomic replay claims. The per-VM secret remains same-UID-readable, so this rail is for genuine cross-trust-boundary deployments | 08, accepted in single-user-VM rev; strict rail hardened audit03 P1 |
| T3  | Tampered `amq` binary `eval`'d on every shell                                                           | T,E    | TCB                    | sha256-pinned binary + bashrc hash guard fails closed                 | 02           |
| T4  | Spot-VM preemption mid-sqlite write                                                                     | T,D    | sessions.sqlite3       | WAL journal + integrity check + periodic `.bak`                       | 14           |
| T5  | Plaintext API tokens / chat on persistent disk after VM destroyed                                       | I      | Tokens, PII            | gocryptfs / LUKS playbook in `docs/operations/encryption-at-rest.md`  | 25           |
| T6  | Right-to-erasure: per-customer chat history can't be deleted                                            | I,N    | Chat JSONLs            | `yaran session purge --hard <id>` cascades to JSONLs + AMQ + sqlite; recursive targets must resolve as strict descendants of their category roots, and the session row is retained for retry after any earlier execution failure. `purge-all` reports malformed rows, continues valid cascades, and performs an explicit row-only purge for identities whose targets cannot be safely planned | 10, hardened in audit03 phase B |
| T7  | Cross-store or normalized wrapper identity collision                                                    | S,T    | AMQ identity/inbox     | Stable per-YARAN_HOME `store-id`; atomic `{store_id,session_id}` owner records; whole-root suffix allocation and wrapper/Rust reconciliation share mandatory `flock` on `meta/config.lock`; foreign/ambiguous legacy owners are preserved, never pruned or reclaimed | 22, shared-workspace phase 2 |
| T8  | Log injection via PTY content into `yaran.log`                                                            | T      | Operator trust         | `sanitize_for_terminal` strips C0/C1 control bytes                    | 03           |
| T9  | Resource exhaustion: no PTY/memory caps                                                                 | D      | Host RAM/disk          | `[limits]` config (`max_panes`, scrollback) + disk watchdog           | 16           |
| T10 | DoS via AMQ inbox flood                                                                                 | D      | Filesystem             | Rate-limit (upstream coordination); local inode monitoring            | 16, upstream |
| T11 | Symlink swap of `~/.claude` → attacker dir                                                              | T,E    | API tokens             | Symlink target check on launch (planned)                              | future       |
| T12 | Auto-resume thundering herd on spot-VM reboot                                                           | D      | Host CPU, API quota    | Bounded scheduler (`auto_resume_concurrency`, default 4) + staleness skip | 15        |
| T13 | Watch-rule regex evaluated on attacker-influenced PTY output (DoS / unintended action firing)           | T,D    | UI thread, child PTY   | Linear-time `regex` crate; per-pattern `size_limit` (64 KiB); rule cap (32/provider); per-rule `budget`/`cooldown_ms` by default (`max_attempts = 0` is explicit unlimited); opt-in (commented defaults); manual disarm | 26 |
| T14 | Malicious file in `~/.local/share/yaran-amq/inject-queue/` injects unauthorised text into a yaran session   | T,E    | Agent input            | In opt-in strict mode the bridge verifies HMAC, recipient, freshness, and atomic replay claim before writing. In the default same-UID mode this is accepted under T2. The drainer rejects symlinks, oversized files, and invalid receiver dirs; `.unrouted` is disjoint from legal handles; claims use no-replace renames and collisions quarantine the stranded body; delivery honors `InputTarget::Agent` | this PR; hardened audit03 P0/P1 |
| T15 | Tampered `agent_sessions.session_settings` blob escalates a session into autonomous mode                | T,E    | Agent input, Host shell | Asymmetric default policy: `SessionSettings::parse_or_default()` returns `Self::default()` (Attended mode, `yolo_permissions=false`, no auto-clear, no overrides) for NULL or malformed blobs and logs a warning at `target: "yaran::session_settings"`. Every consumer (PTY env, watch engine, AMQ postscript injection) reads `settings` only after this filter, so a corrupt DB row degrades to safe defaults rather than enabling autonomous behaviour. | audit03 phase 01 |
| T16 | Shared-workspace provider unexpectedly mutates the registered checkout or Yaran treats it as a managed worktree | T,E | Source checkout | Legacy configs without `[workspace]` stay isolated; fresh configs state the shared default explicitly; the create modal labels shared mode and shows the real path. Shared sessions persist `shared_workspace`, never own/create/remove a worktree or branch, and are rejected under Yaran-managed roots. Auto-resume is opt-in and uses only an exact captured provider UUID; it never uses a latest/recency selector. A second current-store writer requires confirmation and produces a persistent derived warning; Fork always isolates. | shared-workspace phases 4/6 + exact-resume |
| T17 | Orphan cleaner mistakes user data or a retained session worktree for disposable residue | T,D | Worktrees, branches | Cleaner is palette-only and never automatic; inventory fails closed across config/store identity/all rows including tombstones/every project's `git worktree list`; candidates must be strict canonical descendants of the managed root, exclude the main checkout, show dirty state, require per-item confirmation, preserve branches by default, and re-enter the protected-workspace guard at removal. | shared-workspace phase 6 |
| T18 | Forged or raced provider history causes cross-agent conversation assignment, clobbering, or recovery-scan exhaustion | S,T,I,D | Claude/Codex histories, agent identity | Recovery accepts regular JSONLs with valid provider UUIDs and an absolute recorded CWD exactly two components below Yaran's historical worktree root; it independently matches registered project ownership plus the immutable normalized agent handle and refuses non-unique matches. Claude copies only matched JSONLs/companion dirs, rejects symlinks and special files, retains originals, and installs fsynced temporary copies with no-replace atomic renames. Codex fresh capture snapshots existing UUIDs, matches canonical CWD, serializes uncaptured launches per CWD, and blocks after timeout/ambiguity rather than guessing. A running Claude agent is followed onto its current conversation only from Claude Code's record for the agent's own PTY child, written after that process started, for an interactive session with a valid UUID; a conversation the pane resumed from another directory is continued in the agent's own directory under a new id. File-count and JSON-line-size bounds cap scans. | exact-resume |
| T19 | A selected third-party NTL provider sends prompts off-host or executes agent actions with the operator's Unix permissions | I,T,E | Workspace, prompts, host shell | NTL is an explicit config-only provider and is never installed or launched automatically. Yaran invokes the official `ntl` executable without an adapter or private API access; one-shot use is forced to `--chat --no-color`, session resume is disabled, and the operator retains NTL's own approval and authentication controls. | NTL provider |
| T20 | jcode provider self-updates mid-session, spawns headless sub-agent swarms, or reaches fleet messaging through inherited MCP servers | T,I,E | Workspace, prompts, host shell, AMQ identity | jcode is a config-only provider entry; Yaran never installs or launches it silently. `jcode-amq` fails closed below a reviewed provider-version floor, probes the version with `--no-update`, and force-injects `--no-update` into every wrapped launch (targeted resume repeats it in `resume_by_id_args`) so the pane's binary is pinned for the PTY's lifetime. Non-interactive subcommand invocations (`run`, `usage`, ...) bypass identity and wake claims entirely, so oneshot work cannot register or hold an AMQ handle. Native (non-PTY) wake delivery via claude-peers / the jcode daemon socket is opt-in (`YARAN_AMQ_NATIVE_DELIVERY=1`), checks readiness before draining, falls back to the file queue when the daemon is unreachable, and logs every attempt; the debug socket it needs is a same-UID surface accepted under T2. The shared `serve` daemon, sub-agent swarms, and any inherited user-scope MCP servers run with the operator's Unix permissions and identity; their binaries, backends, and data handling remain upstream responsibilities. | jcode provider + jcode-amq |
| T21 | An agent forges, floods or hides cards on the human board, or injects terminal escapes through card text | S,T,D | Operator attention, terminal | `yaran board` writes only `human_board.json` in the config directory (owner-only, flock-serialized read-modify-write, atomic rename), or with `[board] dir` only the card notes of that folder (one atomic rename per changed card, under the same lock); every string is passed through the terminal sanitizer and length-bounded before it is stored; open cards are capped and a full board refuses new posts out loud; an unreadable board is reported and never overwritten. The poster field is the agent handle the launch environment sets, a label rather than an authenticated identity, the same same-UID trust T2 accepts. | human board |
| T22 | A shared board folder brings in card notes from other machines or people, and its opt-in git sync commits, merges and pushes on its own schedule | S,T,I,D | Operator attention, the folder's repository | Notes get the same sanitizing and length bounds as posts; oversized notes and symlinks are not read; unreadable or duplicate notes are reported, never rewritten, and their ids never reused. The sync commits only the board folder's paths, holds the board lock while committing or merging, skips a repository mid merge/rebase/cherry-pick, never rebases or forces, lets git refuse merges over uncommitted work, auto-settles only conflicts confined to board notes (newer `updated` wins) and aborts anything else, pushes only to the configured upstream with a qualified refspec, and runs every git call time-limited with prompts disabled and sanitized errors. The board inherits the trust of the vault or remote it lives in; off by default. | shared human board |
| T23 | Another person's words on a shared board card are passed to this machine's agents (`[board] relay`) | S,T,E | The agent that posted the card, or `relay_to` | Off by default; only messages written on another side, only to the agent of this yaran that posted the card or to the configured `relay_to` for a card assigned to `me`; text sanitized and length-bounded; sent with `yaran peer send` (one argument, no shell, time-limited), never typed into a terminal; each message passed once and recorded on the card. Writer and side are labels: the relay trusts the shared folder exactly as T22 does. | board relay |
| T24 | Claude Code's self-relaunch runs through `claude-peers-launcher` (`CLAUDE_CODE_PROCESS_WRAPPER`), a script yaran installs | T,E | Every Claude process re-exec'd from a yaran pane | Installed beside `claude-amq` with the same mode and ownership advice and referenced by absolute path; always `exec`s what it was given with the environment unchanged; appends only the claude-peers development-channel flag, and only for an interactive relaunch on the pane's own terminal that lacks it, so daemon-hosted sessions and spares run as asked; an operator-set launcher is left alone with a warning. | claude-peers across restarts |
| T25 | The unauthenticated web API reachable from the internet through the tunnel | S,E | Whole workspace: PTY input, filesystem, config rewrite | Saga creates policy → app → tunnel → ingress → DNS and tears down DNS → invalidate secret → evict → tunnel → app → policy; `originRequest.access` (`required` + `audTag`) on every machine ingress rule from `desired.ts`; cloudflared ≥ 2026.11.0 enforced; yaran verifies the JWT itself (T26); drift task repairs. Implemented, unverified live. | phoneapp 05, 10, 11 |
| T26 | Access JWT forgery, confusion or replay at yaran | S | Workspace | Fixed-order check in `cloud::access_jwt`: RS256 with known `kid`, `iss`, `aud`, `exp`/`nbf` with skew, `type == "app"`, service tokens refused, owner email; keys only from the team's Access domain; fails closed with 503 `access-keys-unavailable`; every request and upgrade on the cloud Host. Implemented, unverified live. | phoneapp 11 |
| T27 | Tunnel token stolen from the developer machine | S,I | Tunnel identity and the requests it carries | Owner-only `cloud/credentials.json`, never in config or `[env]`; reaches cloudflared by a 0600 token file deleted when the leg stops, never argv; not stored in D1; owner rotation replaces the secret, admin rotation can also cut live connections. Implemented, unverified live. | phoneapp 09, 10, 05 |
| T28 | Machine signing key theft or signed-request replay | S,R,T | Machine identity: events, config fetch, origin port, unpair | Ed25519 over the protocol's canonical string; Worker checks clock window (±300 s), key, signature, revocation, then D1 nonce; the origin-port route is signed like every machine route. Implemented, unverified live. | phoneapp 09, 04, 05 |
| T29 | cloudflared supply chain | T,E | Code running as the developer | Pinned 2026.11.0 with compiled-in SHA-256 for archive and binary, re-checked on every start, fails closed; user-supplied binaries refused below 2026.11.0; `--no-autoupdate`; owner-only storage; `tools/cloudflared-pin/bump.sh`. Implemented, unverified live. | phoneapp 10, 18 |
| T30 | cloudflared's metrics endpoint reached by another local user or a page | I | Tunnel config | `--metrics 127.0.0.1:<port>` always explicit, port configurable or probed free; remote management diagnostics off by default. Implemented, unverified live. | phoneapp 10 |
| T31 | Org Worker compromise or a malicious `cloud-deploy` change | E,T | The org's Cloudflare account and every machine policy | Six-permission token template, replacement checked for every permission; token sealed in D1; `workers.dev` serves only setup and `/v1/meta` until setup closes, then `421 misdirected_host` for every other Host and disabled by API; no preview URLs or custom domain in wrangler config; console behind Access, own assets only; audit log. Implemented, unverified live. | phoneapp 04, 05, 07 |
| T32 | Same-zone `fetch` from the Worker bypassing Access | E | Machine origins | No Worker proxying to machines; outbound fetches only to the Cloudflare API, GitHub releases and policy-checked push endpoints; `global_fetch_strictly_public`; cloudflared `access.required` as the second gate. Implemented, unverified live. | phoneapp 04, 05 |
| T33 | Setup takeover before setup closes | E | Org control plane | Deploy-time `SETUP_CODE` of ≥ 24 characters, constant-time compare; 5 tries per address per 15 min and 30 a day; 20 wrong codes lock that address (never the wizard) until the code changes, and a global backstop locks an address on its first wrong code past 100 a day; only setup and `/v1/meta` on `workers.dev`; single-use Access-gated claim closes setup in one D1 batch, then `410 setup_closed` and `workers.dev` disabled. Implemented, unverified live. | phoneapp 04, 07 |
| T34 | Cross-user authorization flaws in the Worker | E,I | Other users' machines and phones | Every route declares an auth class; one authorize switch; role from D1 only; user queries take the authenticated user id; authorization matrix over every route × identity × Host × setup state; phone cap refused. Implemented, unverified live. | phoneapp 04, 06, 08 |
| T35 | Pairing hijack | S | Machine enrolment | PKCE and constant-time `state` on a loopback-only listener; loopback-only callbacks; confirm page with email, machine name and the fingerprint the terminal prints, behind a CSRF token; hashed codes (request 10 min, code 120 s); claim needs signature, verifier and a code-bound nonce. Implemented, unverified live. | phoneapp 06, 09 |
| T36 | Sealed-handoff interception | S,I | Access JWTs for the control plane and machines | JWE ECDH-ES + A256GCM to an in-memory ephemeral app key; release builds return only on the verified https callback on `<publisher-domain>` (Auth Tab / Custom Tab, iOS 17.4+ `ASWebAuthenticationSession`); custom scheme only in builds without a publisher domain, which show a banner; `build`, `redirect` and `state` validated before any redirect, else 400; script-free one-tap consent page with a single-use, bound CSRF token on both handoff pages, remembered only with this install's device signature (T64); app-side constant-time `state` match, ten-minute limit; `no-store`, nothing secret logged. Implemented, unverified live. | phoneapp 02, 06, 11, 15 |
| T37 | Phone token theft at rest or on device loss | I,S | Control-plane and machine JWTs, push keys | Vault in the Keychain (`WhenUnlockedThisDeviceOnly`) or AES-256-GCM under a non-exportable, StrongBox-backed Keystore key in `noBackupFilesDir`; `allowBackup=false` with extraction rules; machine cookie is a session cookie; optional biometric lock enforced by a key (`SecAccessControl`, `CryptoObject`); sanitized diagnostics; device removal from the console. Implemented, unverified live. | phoneapp 14, 15, 06 |
| T38 | `machine-view` WebView escape | E | Phone and app secrets | No bridge of any kind on either platform; shared `NavigationPolicy` with exact-host loads and off-host links to the system browser on a gesture only; file and content access off, no mixed content, no multiple windows (Android); debugging and inspection only in debug and E2E builds. Implemented, unverified live. | phoneapp 15 |
| T39 | Push content exposed to Google, Apple, the distributor or the relay | I | Agent labels and project names | RFC 8291 `aes128gcm` to device keys, decrypted on the phone (UnifiedPush connector; iOS Notification Service Extension); label, project and state word only, stripped under Minimal detail on the machine and in the Worker; generic text when decryption fails. Implemented, unverified live. | phoneapp 08, 12, 16 |
| T40 | Publisher relay abused or compromised | D,S,E | APNs key; every iOS user's notifications | Stateless sealed endpoints (AES-256-GCM, rotatable keys) carrying the org VAPID key; VAPID `k` must match it and the JWT verify (relay audience, ≤ 24 h); rate limits per client IP (mint), per VAPID-key hash and per device-token hash; 2,900-byte cap; no token, endpoint, JWT or body logged; APNs key only as a relay secret; playbook not written yet. Implemented, unverified live. | phoneapp 08, 21 |
| T41 | Org VAPID private key compromise | S | Notification integrity | Generated at setup and sealed with a `DATA_KEY`-derived key; an admin rotates it from Health, which works after a lost `DATA_KEY` and makes every phone re-register (`auth_failed`); payloads still end-to-end encrypted to device keys. Implemented, unverified live. | phoneapp 04, 07, 08 |
| T42 | Malicious deep links or QR codes | S,T | User's SSO credentials, trust in the app | Every add-org link or scan lands on Confirm org, which re-checks the host, shows the org's name and team domain from the org and adds it only after sign-in; QR built only from the canonical control-plane host or the paired org; machines opened by id from the authenticated machine list, never a host from a link or push. Implemented, unverified live. | phoneapp 06, 13, 14, 15, 16 |
| T43 | Cloudflare sees all tunneled traffic in plaintext at its edge | I | Terminal I/O, file contents | **Accepted risk** (see below). Stated in the docs, the app's org confirm screen and yaran's status when the leg comes up; the store listing is phoneapp 21's. | phoneapp 17 |
| T44 | Raw config and `[env]` reachable by the remote owner | I | Env secrets, config | Decision record in `cloud_ingress`: remote identity equals the paired owner; bounded by T26, T37 and the session duration; docs say to keep secrets out of `[env]`. Implemented, unverified live. | phoneapp 11 |
| T45 | Revocation lag | E | Workspace | Configurable Access session (default 24 h); teardown removes DNS first and invalidates the tunnel secret before evicting connections; admin rotation can evict, owner rotation does not; yaran closes sockets with 4401 at expiry plus skew; sign-out-everywhere. Implemented, unverified live. | phoneapp 05, 06, 11 |
| T46 | Android signing key or App Store credentials compromised | T,E | Every installed app | Release keystore read from the environment at build time, never committed; one maintainer-held key, Play App Signing with an upload key, protected environments, CODEOWNERS and the playbook are still to come. Design only. | phoneapp 18, 21 |
| T47 | Deploy secrets leaked | I,E | Org Cloudflare account; every `DATA_KEY`-sealed secret | Asked as Worker secrets; `.dev.vars` gitignored; only secret names logged; logger redacts and sanitizes; never shown in the console; sentinel test over logs, bodies and headers; rotation path for each. Implemented, unverified live. | phoneapp 04, 07 |
| T48 | Repudiation or tampering of admin actions | R | Audit trail | Append-only `audit_log` from a fixed action registry, written in the same batch as the change, never updated, purged only by retention; JSON Lines export. Implemented, unverified live. | phoneapp 04 |
| T49 | Quota or budget exhaustion | D | Org's ability to pair | Per-user machine cap (10); quota guard naming the quota and both numbers; API budget gate with a reserve for interactive work; rate-limit bindings with D1 fallback; coalesced denied-attempt audits; per-run cron budget. Implemented, unverified live. | phoneapp 04, 05, 06 |
| T50 | Spoofed update notice leading to a malicious APK | T | Phone | No in-app update check or installer; the only link, in `foss` builds, is a fixed one to the repository's GitHub releases; release checksums and provenance are still to come. Partly implemented. | phoneapp 14, 18 |
| T51 | Diagnostics or crash logs leak tokens or hostnames | I | Tokens, infrastructure names | Local ring log (1 MiB, seven days); one shared sanitizer (escapes, auth headers, JWTs, query strings) pinned by fixtures on both platforms; export only through the share action, and the screen says what it contains; no third-party crash SDK. Implemented, unverified live. | phoneapp 14 |
| T52 | Malicious upstream `yaran-cloud-v*` release pulled into a deployment | T | Org control plane | Update job verifies SHA-256 and GitHub provenance, replaces only upstream-owned files and arrives as a pull request; the release workflow and tag signing are not built yet. Partly implemented. | phoneapp 07, 18 |
| T53 | Attacker-controlled text injects terminal escapes | T | Operator terminal, logs | `yaran_core::sanitize::for_terminal`/`truncate` on cloudflared output, JWKS errors and every control-plane string; the Worker keeps raw Cloudflare errors out (`safeErrorDetail`) and escapes console HTML. Implemented, unverified live. | phoneapp 05, 08, 10 |
| T54 | Control-plane Worker reached without a valid identity | S,E | Org control plane; every user's machines and phones | Access JWT from the header only, RS256 pinned, `iss`/`aud`/`exp`/`nbf`, person app tokens only, service tokens refused, fails closed without JWKS; active user row required; every route declares an auth class or does not compile. Implemented, unverified live. | phoneapp 04, 06, 07 |
| T55 | D1 contents exposed | I | Sealed secrets, pairing codes, device push keys and endpoints, user emails | Generated secrets sealed under per-purpose `DATA_KEY` keys with table/column/row AAD; codes and CSRF tokens hashed; tunnel tokens never written to D1, checked by a full-table scan after every provisioning test. Implemented, unverified live. | phoneapp 04, 05, 06, 08 |
| T56 | Control plane acts on Cloudflare resources it does not own | T,D | Other deployments' and the account's own tunnels, apps, policies and DNS | Instance marker on every created resource, never adopting or deleting unmarked ones; orphan cleanup after two sightings and a 120-minute grace, in D21 order; no cascade deletes; Cloudflare error text sanitized. Implemented, unverified live. | phoneapp 05 |
| T57 | Device-supplied push endpoint used for SSRF | E,I | Same-zone or internal services; Worker egress budget | Endpoint policy at registration (https, port 443, public DNS name, not the control plane or the org's zone, no `workers.dev`, length cap, channel-shaped URL, valid keys); relay allowlist; `global_fetch_strictly_public`; 404/410 clears the subscription. Implemented, unverified live. | phoneapp 06, 08 |
| T58 | yaran's handoff rate limit starves another phone's sign-in | D | Phone sign-in availability | Default 12 a minute against about one a day per phone; configurable; applied only after the Access check, with `Retry-After`. Implemented, unverified live. | phoneapp 11 |
| T59 | Attention-event metadata visible to the org Worker | I | Agent labels and project names | **Accepted risk** (see below). Batched events with fixed state tokens and no agent output; minimal detail drops labels on the machine and again in the Worker; only event ids kept in D1; pushes encrypted to device keys (T39). | phoneapp 12, 08 |
| T60 | Shell WebView compromise drives native plugins | E,I | Vault contents, sessions, push keys | Bundled assets only under a `'self'`-only script and connect CSP; debugging off; no plugin method returns a JWT, cookie or key; every control-plane call through the native client; push bridge refuses credential-bearing fields. Implemented, unverified live. | phoneapp 14, 15, 16 |
| T61 | iOS machine session cookie readable by page script | I | Machine Access JWT | Host-only Secure session cookie, never on disk; the undocumented `HttpOnly` key is set, honoured on macOS WebKit, unverified on iOS; one data store per machine host; only the person's own yaran UI can read it. Residual risk stated. Implemented, unverified live. | phoneapp 15 |
| T62 | Native loopback proxy reachable by other apps or pages on the phone | S,E | Machine access via the managed OAuth bearer | The fallback is not built, so the app runs no loopback listener; conditional on the sign-in gate's third fallback, otherwise retired by strikethrough. Design only. | phoneapp 15 |
| T63 | Publisher-domain association files tampered or lost | S,T,D | Sealed handoffs (ciphertext only), sign-in availability | Release builds accept only the verified https callback; iOS Release guard refuses the placeholder bundle id and, when required, a missing publisher domain; handoffs stay sealed (T36); association files, fingerprint check and domain custody are still to come. Partly implemented. | phoneapp 21, 18, 14, 15 |
| T64 | Remembered-consent bypass | S,E | Access JWTs for the control plane and machines; the consent page as the human check | Skip only with a valid MACed consent cookie naming the device-key fingerprint **and** a fresh ES256 device signature over the server's own host, plus no revoked device row with that fingerprint on the Worker; non-exportable per-org device key (StrongBox/TEE, Secure Enclave); consent keys from `DATA_KEY` (Worker) and the credentials file (yaran); revocation, rotation, re-pair and logout drop memory. Revocation gap on machines is an accepted risk (see below). Implemented, unverified live. | phoneapp 02, 06, 11, 15 |

## What's in scope vs. accepted

**In scope** — we mitigate or document:

- Single-user, single-VM compromise via prompt injection.
- Supply-chain integrity of `yaran`, `amq`, and the skills package
  (sha256 pins, GitHub Actions pinned by SHA, SBOM, attestation).
- Local data-at-rest exposure on persistent disks that may outlive
  the VM (operator-driven encryption playbook).
- AMQ peer-spoofing within a single VM.
- Right-to-erasure for chat history that may contain PII.
- Cloud Connect: the org control-plane Worker, the tunnel leg yaran
  supervises, yaran's own Access check, phone sign-in, and push
  delivery through the publisher relay (T25–T64).
- The phone apps' storage of sessions and keys, and the boundary
  between their bundled shell and the remote yaran page.

**Accepted risks** — not mitigated, with rationale:

- **Multi-tenant isolation.** yaran is a single-user-on-a-VM product.
  Two humans sharing one Linux account is out of scope.
- **Cloud-provider IAM compromise.** If your GCP/AWS service
  account is hijacked, the attacker controls the disk and the VM
  before any yaran-level mitigation can help.
- **Side-channel leakage from upstream CLIs.** Bugs in `claude`,
  `codex`, or `gemini` themselves (e.g. the CVE-2025/26 series) are
  the upstream vendor's responsibility. Wrappers enforce reviewed
  minimum-safe versions, but operators own upgrades above those floors;
  yaran does not re-implement provider sandboxing.
- **TIOCSTI on legacy kernels.** Mitigation requires
  `dev.tty.legacy_tiocsti=0`; we document the sysctl in Phase 13
  but cannot guarantee its presence on every host kernel.
- **AMQ peer spoofing within the same Linux user account (T2,
  reclassified).** Originally Phase 08 mitigated this with an
  HMAC envelope and a per-VM secret at
  `~/.local/share/yaran-amq/amq-secret` (mode 0600). On reflection
  the mitigation does not match the trust model declared above:
  every "peer" is a process running as the same Linux user with
  full access to `$HOME`, including the secret file. A peer can
  `cat` the secret directly, `ptrace` the signer, or `LD_PRELOAD`
  into it — none of which the HMAC check defends against. Per
  Linus Torvalds ("there is a complete lack of a security
  boundary between processes of the same user") and the MIT
  6.828 OS-security course, same-UID is not a defensible
  boundary on Linux. We've therefore made strict verification
  **opt-in** (`[amq.inject].verify_envelope = true`) and left it
  off by default. Operators that genuinely cross a trust boundary
  with their wake notifications — proxying across hosts, or
  running mixed-trust agents under the same UID via setuid
  shims — should flip the switch and accept the legacy-message
  drop semantics. The HMAC tooling
  (`amq-send-signed`/`amq-receive-verify`) remains in the
  overlay and is exercised by the bats suite.

- **Cloudflare reads tunneled traffic at its edge (T43).** Cloud
  Connect rides Cloudflare's HTTPS edge, which terminates TLS, so
  terminal I/O and file contents are visible to Cloudflare. The docs,
  the app's onboarding and the store listing say so. People who
  cannot accept this use Tailscale or their own proxy.
- **Attention metadata at the org Worker (T59).** Agent labels,
  project names and state tokens reach the org's own Worker and
  its push queue in plaintext (D1 keeps only event ids). That is the org's own infrastructure; no
  agent output leaves the machine, and pushes past the Worker stay
  end-to-end encrypted.
- **Remembered consent outlives a Worker-side phone revocation on
  machines (T64).** yaran never learns that the control plane removed
  a phone, so that phone can still skip the sign-in confirmation page
  on a machine until the machine is re-paired or logged out, its
  consent key is rotated, or 400 days pass. A skip still needs a
  valid owner Access token, which sign-out-everywhere revokes.

## Verification

The project ships a self-check tool: `yaran-amq doctor` (Phase 20).
Run it after every install or upgrade:

```bash
yaran-amq doctor | grep -E '(integrity|tiocsti|amq.binary|encryption)'
```

`doctor` reports:

- `binary integrity` — sha256 of `~/.local/bin/amq` against the
  recorded pin in `bashrc-additions.sh`.
- `tiocsti` — value of `dev.tty.legacy_tiocsti`.
- `sqlite integrity_check` — `PRAGMA integrity_check` on
  `sessions.sqlite3`.
- `encryption at rest` — whether the configured `$STATE_ROOT` is on
  an encrypted mount.
- AMQ queue depth, oldest-message age, `~/.claude` symlink target,
  free disk space, currently-running yaran PID/uptime/RSS.

Pass `--anonymize` to redact paths and identities before sharing
the output for support.

## Update cadence

This file is **a living document**. Every audit
(`docs/audits/audit01/audit01.md`, `docs/audits/audit02/audit02.md`,
`docs/audits/audit03/`, …) must extend the STRIDE
table with new threats discovered, and stale rows must be either
re-validated or removed in the same PR that supersedes them.

When introducing a new attack surface — a new MCP integration, a
new network egress, a new file write outside `$STATE_ROOT`, a new
provider CLI — update the STRIDE table **in the same PR** that
introduces the surface. PRs that add attack surface without
updating this file are blocked at review.

A future CI check (`scripts/validate-threat-model.sh`) is planned
to compare the phase references in this table against the audit
reports under `docs/audits/` and warn when a phase claims to
mitigate a threat that is not listed here. Tracked as a
post-audit02 follow-up.

# Phase 09 — yaran: cloud config, credentials store, machine identity, `yaran cloud` CLI

**Track:** B (parallel) · **Parallel-safe with:** 04, 05, 06, 07, 08, 10, 11, 12, 13, 14, 15, 16, 17, 18
**Depends on:** 02 (wire types in `yaran_core::cloud::protocol`, signing canonical string, fixtures, error codes, fingerprint format, QR payload); 01 (header gate) · **Blocks:** 10 (credentials, signed client, `[cloud]` keys), 11 (owner email, team domain, AUD and the D24 handoff consent key in credentials), 12 (signed client, revocation signal, `push_notifications`), 13 (status route), 19

## Goal

Give a developer machine a durable cloud identity and a way to get one:

- a `[cloud]` config section that holds portable intent only;
- an owner-only credentials file that holds every secret and every pairing-derived value;
- an Ed25519 machine key, and a signed HTTP client for `/v1/machine/*` that every later
  yaran phase reuses;
- `yaran cloud login | logout | status | rotate | pair-phone`, with the same actions in the
  TUI palette and the web app menu, all reporting through one set of outcome sentences;
- the machine's handoff consent key (D24, 02 §8.1), minted at pairing and rotatable from the
  CLI, which Phase 11 uses to remember a phone's consent.

When this phase is done, `yaran cloud login https://<org-control-plane>` pairs the machine
and writes credentials. Phase 10 turns those credentials into a running tunnel.

## Evidence

All lines checked against `main` at `ba9e61b9` on 2026-11-14 by sub-agents reading the
full call paths. Implementers re-verify before editing (00-CONVENTIONS §4).

**CLI dispatch and help**
- `crates/yaran/src/main.rs:22-39` (564 lines) dispatches `server`, `--version`, `peer`
  (:35) and `board` (:36). Anything else goes to `run_tui_with_flip()` (:37).
  - `run_peer` (:46-50) and `run_board` (:55-59) take no single-instance lock, run no
    engine and do not init the logger.
  - `run_board` loads config (`human_board/cli.rs:103`).
  - The hand-parsed argument precedent is `parse_server_args` (:388-455), with tests at
    :457-564.
- `yaran_tui::run` prints top-level help if `--help` appears anywhere
  (`crates/yaran-tui/src/lib.rs:82`). That is why non-TUI verbs must be dispatched before
  it. Help text is at :256-299; per-verb tests are at :321-381 (e.g.
  `help_lists_the_board_subcommand` :355).
- Injectable-IO precedent: `human_board::cli::run_with(args, settings, stdin, out)`
  (`human_board/cli.rs:111`), with the test harness `run_as` (:772-777).

**Config (R3 §5 checklist, re-verified)**
- Root `Config`: `crates/yaran-core/src/config.rs:3043-3104`; `Default` at :3161-3229.
  - Section-in-own-module precedent: `AmqConfig` in `amq/config.rs:11-16`, re-exported at
    `config.rs:18`.
- `TailscaleMode`: :589-658. It is a `String` field with a parsed accessor (:1108-1110).
  The unknown-value warning (:868-872) is corrected in `load_config` (:3842-3848).
- `YaranPaths` (:2584-2593) is built as a struct literal in 116 places. A new field breaks
  all of them, so cloud paths must be methods or a separate type.
  - `ensure_dirs` makes the root 0700 on every start (:2612-2645).
- Renderer table: `config_schema() -> Vec<ConfigEntry>` (`crates/yaran-tui/src/config.rs:341`).
  - `FieldValue` (:289-298) has `Str`, `OptStr`, `U16`, `U32`, `U64`, `Usize`, `Bool`,
    `StrList`. **No float.**
  - `OptStr(None)` renders `key = ""`, which parses back as `Some("")` (:1871-1873). Use
    `String` with empty meaning unset (the `board.dir` precedent).
  - Section template: `[storage]` at :1714-1723. Completeness test:
    `default_config_is_commented_and_complete` (:3428-3535). Round-trip test: :3957.
- `config_write::apply_patches` (:232-779) is a hand list. A key missing from it is never
  saved.
  - The patch helpers (`patch_table_str` :835, `_bool` :874, `_u16` :845, `_u64` :879) are
    private. `ensure_table` (:828) is `pub`.
- `config diff`: `policy_for` (`crates/yaran-tui/src/cli.rs:510-527`).
  - `mutate_leaf` (:1669-1738) panics on a closed-set enum string with no candidate
    (:1691).
  - A `String` mode like `tailscale` passes through the `-mutated` suffix.
  - Exhaustiveness test :1756; never-prints test :1867.
- `tests/upgrade_config.rs:209-252`: absent sections must equal `Config::default()`.
- Exposure (why secrets can never live in config):
  - `GET /api/v1/config/raw` returns the file verbatim (`config_routes.rs:412-420`).
  - `BootstrapView.global_env` (`viewmodel.rs:196, 1476`).

**Secrets, files, processes**
- `file_modes.rs` (351): `PRIVATE_FILE_MODE` :26, `PRIVATE_DIR_MODE` :31,
  `restrict_to_owner` :57, `restrict_to_owner_best_effort` :90,
  `create_private_dir_all` :112. There is no 0600-file creator.
- `human_board/store.rs`:
  - `write_private` (:192) wraps the private `write_atomic` (:336-374): `create_new` with
    mode, `sync_all`, rename, temp cleanup, but no parent-dir fsync. Both are
    `pub(crate)`/private.
  - flock helper (:150-168) using `rustix::fs::flock` with an EINTR retry.
  - `config_write::write_config_atomic` (:45) does fsync the directory.
- `browser::open_url(&str) -> Result<()>` (`browser.rs:5`). Test builds refuse it (:76-77).
  Its only caller is the TUI's `UrlOpener` seam (`app/mod.rs:105-109`).
- `ureq 3.3.0` is a direct yaran-core dependency (rustls + ring + webpki-roots). Usage
  pattern: `release_notes.rs:507-523` (timeouts, `http_status_as_error(false)`, body limit
  :626-630).
- There is no HTTP server outside yaran-web, and yaran-core has no tokio
  (Cargo manifests).

**Crypto and dependencies (Cargo.lock)**
- `ring 0.17.14` is transitive only (via rustls). It provides:
  - `Ed25519KeyPair::{generate_pkcs8, from_pkcs8, sign}`
  - `digest::SHA256`
  - `rand::SystemRandom`
  
  Its licence is "Apache-2.0 AND ISC", which `deny.toml:72-98` allows.
- `base64 0.22.1` is transitive only.
- `qrcode` is absent. `qrcode 0.14.1` is "MIT OR Apache-2.0" and has zero dependencies
  with `default-features = false`. It provides `render::unicode::Dense1x2`.
  https://crates.io/crates/qrcode (2026-11-14).
- `deny.toml`: crates.io only (:107-112); `wildcards = "deny"`.

**Status and surfaces**
- Keyed status APIs:
  - `StatusUpdate::keyed` (`engine/events.rs:161`)
  - `status_op(..).resolve_in_handler(..)` (`engine/status_op.rs:203, 233`)
  - `Engine::post_status` (`engine/mod.rs:3153`), and its web wrapper
    `engine_actor.rs:850`
  - `status_text!` (`status_text.rs:132`)
  - worked example: `background_server.rs:590-654`
- Palette registration:
  - core entry: `palette.rs:184-191`
  - `Action` arms: `action.rs:199, 374, 638, 816-821`
  - TUI binding: `BindingDef` (`keybindings.rs:337-345`)
  - registry tests: `keybindings.rs:3293, 3376`
  - dispatch: `execute_command` (`app/mod.rs:5649`)
- Modal family registry: `crates/yaran-tui/src/app/modal.rs` (1919 lines).
- Theme tokens are registered as `register_default_token("yaran.overlay_bg", …)`
  (`theme.rs:566`).
- Web app menu: `web/src/lib/appMenu.ts` (278).

**Protocol (`02-protocol-contract.md` is the source of truth; route numbers are 02 §5)**
- W2 `GET /v1/pair/authorize`, query `PairAuthorizeQuery {v, state, code_challenge,
  code_challenge_method, machine_pubkey, machine_name, callback, yaran_version, origin_port?}`
  (02 §6):
  - `callback` is exactly `http://127.0.0.1:<port>/callback`, port 1024–65535.
  - `state` is 22–128 base64url. `code_challenge` is 43 chars, `S256` only.
  - `machine_pubkey` is an `Ed25519PublicKey` (base64url of 32 bytes, 43 chars).
  - `machine_name` is a `MachineName` (`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`, ≤ 32, DNS-label
    safe); yaran slugifies before sending.
  - `origin_port` is optional (default 3890) and lets 05 provision the ingress at authorize.
- W4 `POST /v1/machine/claim`, body `ClaimRequest {code, code_verifier, yaran_version,
  origin_port}` (`origin_port` required and authoritative). Response `ClaimResponse
  {machine_id, machine_name, hostname, url, origin_port, tunnel {id, token, token_version},
  access {team_domain, aud}, owner_email, user_slug, org {name, url}, protocol}`.
- W5 `GET /v1/machine/config` → `MachineConfig` (never the token; carries `origin_port` and
  `tunnel.token_version`); `410 machine_revoked` when revoked.
- W7 `POST /v1/machine/rotate`, `RotateRequest {known_token_version, reason: user|sync}` →
  `RotateResponse {tunnel, rotated}`.
- W8 `POST /v1/machine/unpair`, empty body → `202 TeardownStarted`; an already-revoked
  machine → `410 machine_revoked`. yaran deletes its credentials on 202 or 410.
- W32 `PUT /v1/machine/origin`, `OriginUpdate {origin_port}` → `202 OriginUpdateResult
  {origin_port, changed}`.
- Signing (02 §7): the canonical string is `yaran-machine-sig-v1`, method, path (machine paths
  match `^/v1/machine/[a-z]+$` and carry no query), Host, protocol, machine id (or `-`),
  timestamp, nonce and the hex SHA-256 of the body, joined by `\n`. Headers: `Yaran-Protocol`,
  `Yaran-Machine-Id` (absent on W4), `Yaran-Timestamp`, `Yaran-Nonce` (16 bytes, 22 chars)
  and `Yaran-Signature`. The Rust implementation is `cloud::protocol::signing` (02 work item 10).
- Fingerprint (02 §7.1): SHA-256 of `"yaran-machine-key-v1\n" ‖ public key`, first 15 bytes,
  RFC 4648 base32 with no padding, six groups of four joined by `-` (29 chars, shape
  `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`). Rust `cloud::protocol::fingerprint::machine_key_fingerprint`,
  pinned by `cloud/protocol/fixtures/sig/fingerprint.json`; 06's confirm page shows the same string.
- Error codes this client maps (02 §4, `registry/errors.json`): `machine_revoked`,
  `protocol_unsupported` (`details {min, max}`), `signature_expired` (`details.server_time`
  plus a `Date` header), `signature_missing`, `signature_invalid`, `nonce_replayed`,
  `machine_unknown`, `machine_not_ready` (retryable), `pair_code_invalid`, `pkce_mismatch`,
  `machine_name_invalid`, `machine_cap_reached`, `origin_port_invalid`, and `rate_limited` /
  `unavailable` with `Retry-After`. Every Worker response carries `Yaran-Request-Id`.
- QR (02 §10): `yaranapp://add-org?u=<pct-encoded OrgUrl>`, built by Rust
  `cloud::protocol::uri::add_org_uri` and pinned by `cloud/protocol/fixtures/uri/add-org.json`.
- `[cloud] app_callback_urls` (02 §8): 09 renders the key, 11 enforces it.
- Re-pairing the same name offers Replace (06 Design, "Replace").

**Standards**
- RFC 8252:
  - §7.3: loopback redirect on `127.0.0.1` with an ephemeral port, which the server MUST
    accept.
  - §8.3: listen only on loopback, and only for the duration of the request.
- RFC 7636 §4.1-4.2, §7.2: verifier of 43-128 chars, `S256` mandatory.
- Sources: https://www.rfc-editor.org/rfc/rfc8252.txt and
  https://www.rfc-editor.org/rfc/rfc7636.txt (read 2026-11-14).

## In scope

1. The `[cloud]` section through all 12 points of the config checklist.
2. The credentials store: owner-only, schema-versioned, flock-guarded, atomic, with a
   change-detection revision.
3. Extracting the private atomic-write and flock helpers out of `human_board/store.rs` into
   a shared module, used by both.
4. Machine identity (Ed25519 via `ring`) and the key fingerprint.
5. A signed client for `/v1/meta` (W1) and `/v1/machine/{claim,config,rotate,unpair,origin}`
   (W4, W5, W7, W8 `POST /v1/machine/unpair`, W32 `PUT /v1/machine/origin`), with typed errors
   and a process-wide revocation signal.
6. The login flow: PKCE, state, a loopback callback listener, browser open, a pasted-URL
   fallback for SSH sessions, and the claim.
7. `yaran cloud` CLI: five verbs, help, and tests.
8. QR payload and rendering: terminal (CLI) and themed matrix (TUI).
9. TUI palette commands, and web routes plus the "Yaran Cloud…" app-menu dialog, for
   login, logout, rotate and status.
10. The leg-state file format (written by 10, read here by `status`).
11. The D24 handoff consent key: minted on each claim, stored in the credentials, rotated by
    `yaran cloud rotate --consent-key`, read by 11.

## Out of scope

| Item | Owner |
|---|---|
| The JSON Schemas, Rust wire types and fixtures themselves | 02 |
| The Worker side of pairing, claim, config, rotate and unpair | 06 |
| cloudflared download and supervision, `set-cloud-mode`, the cloud Preferences row, the bootstrap `cloud` projection, the header crumb | 10 |
| Host rule and Access JWT verification | 11 |
| Event emitter and the `push_notifications` Preferences row | 12 |
| Web "Connect a phone…" QR entry | 13 |
| Threat rows T27, T28 (signed machine routes, including `PUT /v1/machine/origin` and `POST /v1/machine/unpair`), T35 and T53 (drafted in 17); consumer docs `cloud-connect-machine.md` | 17 |
| Enforcing `[cloud] app_callback_urls` on the handoff route | 11 |
| Consent cookie MAC, skip rule and the device-signature check (D24) | 02 (functions), 11 (route) |

This phase's PRs update the mitigation text of those threat rows when the implementation
differs from the draft, in the same PR (CLAUDE.md "Update the threat model when you add
attack surface").

## Design

### What lives where (D5)

| Value | Home | Why |
|---|---|---|
| mode, org URL default, push toggle, cloudflared path, metrics port, backoff bounds, grace period, log level, management diagnostics, Unauthorized confirm window, login timeout, request timeout, app callback URLs | `[cloud]` in `config.toml` | Portable intent the user writes. Safe to commit (configuration.md TIP), safe over `config/raw`. |
| tunnel token, Ed25519 PKCS#8 private key, handoff consent key (D24) | credentials file | Secrets. D5: never config, never `[env]`. |
| machine id, hostname, team domain, AUD, owner email (`ClaimResponse.owner_email`, the only email 11's JWT check accepts, D3), bound org URL and name, origin port, tunnel token version, protocol version, paired-at, revoked-at | credentials file | Pairing-derived. They belong to the same atomic record as the secret. They are not portable: copying them to another machine would be a lie, so they cannot go in config. They are bound to a secret that may not enter SQLite (`sessions.sqlite3` is not owner-only by contract, and the DB is not the D5 home). |
| leg runtime state (child pid, pgid, binary path, metrics address, state word, since) | `cloud/leg-state.json` (format here, writer 10) | Lets the separate `yaran cloud status` process and 10's stale-orphan reaper see the running leg without IPC. |

**The CLI never writes `config.toml`.** A running yaran patches the file from its in-memory
`Config` (`config_write::apply_patches`), which would clobber an out-of-process edit. So
`[cloud] org_url` stays user intent: an org can ship a preset so that a bare
`yaran cloud login` and the TUI prompt are pre-filled. The org a machine is actually paired
with is recorded in the credentials.

### `[cloud]` keys (rendered with full inline comments)

| Key | Type / default | Meaning |
|---|---|---|
| `mode` | `"auto"` (`auto`/`yes`/`no`) | `auto`: run the tunnel whenever this machine is paired and yaran is serving, and follow login/logout live; an unpaired machine is quiet. `yes`: the same, but serving while unpaired warns and names the login command, and leg failures are sticky. `no`: never run it; credentials are kept. A `String` with a parsed accessor, as for `tailscale`. |
| `org_url` | `""` | Default control-plane URL for `yaran cloud login` and the TUI/web login prompt. Empty means you type it. |
| `push_notifications` | `true` | Send attention events to the control plane for phone pushes (consumed by 12). Independent of `ui.attention_indicator` (D12). |
| `cloudflared_path` | `""` | Empty: yaran downloads its pinned, checksum-verified cloudflared. A path: use that binary (it must be ≥ 2026.11.0, the minimum 10 enforces; see 10). |
| `metrics_port` | `0` (u16) | Loopback port for cloudflared's readiness/metrics server. 0 means yaran picks a free port at each start. |
| `grace_period_seconds` | `5` (u64) | Passed as `--grace-period`. yaran sends SIGKILL this many seconds plus 2 after SIGTERM. Max 180 (cloudflared's cap). |
| `restart_backoff_initial_ms` / `restart_backoff_max_ms` / `restart_backoff_jitter_ms` | 1000 / 60000 / 1000 | Restart delays for a failed cloudflared. The multiplier is fixed at 2: the renderer has no float type (`FieldValue`), and the comment says so. |
| `cloudflared_loglevel` | `"info"` | Passed as `--loglevel`. The comment warns that `debug` logs request headers, including the Access cookie. |
| `management_diagnostics` | `false` | Passed as `--management-diagnostics`. Off by default so Cloudflare's remote management cannot pull pprof/metrics (06-cloudflared-tls §7.3). |
| `unauthorized_confirm_seconds` | `60` (u64) | How long cloudflared may report Unauthorized before yaran asks the control plane whether the machine was revoked or its token rotated (10). |
| `login_timeout_seconds` | `900` (u64) | How long login waits for the browser round trip. |
| `request_timeout_seconds` | `15` (u64) | Timeout for each control-plane request. |
| `app_callback_urls` | `StrList`; default the release build's compiled-in list (`https://<publisher_domain>/auth/callback`, with `publisher_domain` read at build time from the repo-root `publisher.json`, Phase 18's one home for the publisher domain), empty in a build without a publisher domain (the file still holds the `<publisher-domain>` placeholder) | The https callbacks yaran's handoff route may redirect a phone to (02 §8; 11 enforces, byte for byte). A fork that publishes its own app adds its callback here and to the Worker's `APP_CALLBACK_URLS`. The comment says the dev custom scheme `yaranapp://auth/callback` is never listed: it is accepted only for a `build=dev` request. Resolved and written at first boot, per CLAUDE.md. |

**Reload.** Every `[cloud]` key applies live. None goes in `server_bind_settings_changed`.
- `mode` takes effect through 10's lane, in both reload owners.
- `push_notifications` is read by 12 on each event.
- `app_callback_urls` is read by 11 on each handoff request.
- Every other key is read when cloudflared is next (re)started or when the next request is
  made.

The canonical comment states this per key.

12 adds its emitter debounce and flush keys (19 hook H7) to `CloudConfig` and
`config_schema_cloud.rs` in its own PR, through the same 12-point checklist.

**Internal timings are not keys** (credentials re-check cadence, `/ready` poll cadence).
This follows the `serve_legs.rs:39` `WATCH_PERIOD` precedent: probe cadences are mechanism,
not preference.

### Credentials file

- **Location:** `<config root>/cloud/credentials.json`. The directory `cloud/` is made with
  `create_private_dir_all` (0700) and the file is mode 0600. Writers take a flock on
  `<root>/cloud/credentials.lock`.
- **Paths:** a `CloudPaths` value derived from `&YaranPaths` (`root.join("cloud")…`), so
  none of the 116 `YaranPaths` literals change.
- **Format:** JSON written with `serde_json`.
  ```json
  { "schema": 1,
    "org_url": "https://<org-control-plane>", "machine_id": "...", "hostname": "<machine>-<user>.<zone>",
    "team_domain": "<team>.cloudflareaccess.com", "aud": "...", "owner_email": "...",
    "org_name": "...", "origin_port": 3890, "protocol": 1, "paired_at": "RFC3339",
    "revoked_at": null,
    "machine_key_pkcs8": "<base64url>", "tunnel_token": "<opaque>", "token_version": 1,
    "handoff_consent_key": "<base64url, 32 bytes>", "handoff_consent_key_version": 1 }
  ```
- **Handoff consent key (D24, 02 §8.1):** `handoff_consent_key` is 32 bytes from
  `ring::rand::SystemRandom`, base64url (43 chars); `handoff_consent_key_version` is an integer
  ≥ 1, the cookie's `kv`. It lives in this file, so it gets the same 0600 mode, flock and atomic
  write as the tunnel token; it never goes in config, SQLite, logs or the bootstrap.
  - **Minted on every successful claim**, before the atomic write: a fresh key, with the
    version one above the replaced credentials' version on a same-org re-pair, or 1 when there
    were none (a new random key already fails every old MAC, so a reset version is safe).
  - **Kept** by tunnel-token rotation (W7, user or sync) and by W32's `origin_port` rewrite.
  - **Rotated** by `yaran cloud rotate --consent-key` (Surfaces): fresh key, version + 1, under
    the flock, no network call. Every phone then meets the consent page once on this machine.
  - **Deleted** with the credentials (logout, `--local-only`).
  - Schema 1 is unreleased, so the two fields are part of it: a schema-1 file without them is
    `CredentialsUnreadable`, not a migration case.
  - **Read** by 11 through `credentials::read_handoff_consent_key(&CloudPaths) ->
    Result<Option<HandoffConsentKey>, CredentialsError>` (`HandoffConsentKey { key: [u8; 32],
    version: u32 }`, `None` when not paired). It takes no lock (the atomic rename makes a read
    whole) and is called per request, so a rotation by another process applies to 11's next
    handoff without a rebind or a leg restart.
- **Mapping from `ClaimResponse`** (02 §6): `tunnel.token` → `tunnel_token`,
  `tunnel.token_version` → `token_version` (the wire name, kept in the file), `access.team_domain`
  → `team_domain`, `access.aud` → `aud`, `org.url` → `org_url`, `org.name` → `org_name`,
  `owner_email` and `origin_port` as named. A `RotateResponse` rewrites `tunnel_token` and
  `token_version`; an accepted W32 rewrites `origin_port`.
- **Reading:**
  - An unknown `schema` greater than 1 is refused with a sentence: "written by a newer
    yaran; upgrade or run `yaran cloud logout --local-only`". It is never rewritten.
  - A file with group/other bits set is tightened with `restrict_to_owner`, and a warning
    is logged.
  - A symlinked file is refused, because `file_modes` never follows symlinks.
- **`Debug` and `Display` redact** `machine_key_pkcs8`, `tunnel_token` and
  `handoff_consent_key` (also `HandoffConsentKey`'s own `Debug`). A test asserts that none
  appears in `format!("{:?}")`.
- **`CredentialsRevision`** is `(dev, ino, len, mtime_ns)`. 10 polls it to pick up a
  login, logout or rotate made by another process. It is cheap, and the stat runs off the
  UI thread.
- **Relationship to `docs/operations/encryption-at-rest.md`:** there is no app-level
  encryption and no OS keychain. That is consistent with T5's accepted risk
  (`threat-model.md:241-245`): the 0700 config root is the boundary, a headless Linux host
  has no secret service, and one code path serves both platforms. 17 adds the file to the
  at-risk list at `encryption-at-rest.md:42-51` and to T27.

### Machine identity and signing

- **Key:** `ring::signature::Ed25519KeyPair::generate_pkcs8(&SystemRandom)` at login.
  - The PKCS#8 document is stored base64url.
  - The public key (32 bytes, base64url) goes in the authorize query.
  - The fingerprint is 02 §7.1's `MachineKeyFingerprint` (29 chars, six base32 groups of
    four, e.g. shape `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`), computed by
    `cloud::protocol::fingerprint::machine_key_fingerprint`; this phase never re-derives it.
    The CLI, TUI and web all print it as a chip beside the authorize URL so the person can
    match it against the Worker's confirm page (06), which shows the same string.
- **Signing:** 02 §7 exactly, through `cloud::protocol::signing::sign` (02 work item 10);
  this phase builds no canonical string of its own.
  - The canonical string covers method, path (no query), Host, protocol, machine id (or `-`),
    timestamp, nonce and the body's SHA-256.
  - Headers: `Yaran-Protocol`, `Yaran-Machine-Id`, `Yaran-Timestamp`, `Yaran-Nonce` and
    `Yaran-Signature`. The claim (W4) omits `Yaran-Machine-Id`.
  - The nonce is 16 random bytes, base64url (22 chars).
  - `cloud/signed_request.rs` only serializes the body once, calls `sign` over those exact
    bytes and attaches the headers; 02's canonical-string fixtures, the same vectors the
    Worker tests use, pin the result.
- **Dependencies:**
  - `ring = "0.17"` becomes a direct yaran-core dependency. It resolves to the 0.17.14
    already in the lock, so no new crate enters the tree. 11 reuses it for RS256, and 02's
    `cloud::protocol::handoff::seal` uses `ring::agreement` (ephemeral-only, which suits the
    sender side) for the JWE ECDH-ES (Concat KDF) + A256GCM envelope.
  - `base64 = "0.22"`, already in the lock. Not 0.23, which would duplicate it.

### Signed client (`MachineApi`)

- **Runtime:** a ureq `Agent` configured the way `release_notes.rs:507-523` does it:
  `request_timeout_seconds` for both connect and global timeouts,
  `http_status_as_error(false)`, a 64 KiB body cap, and HTTPS only. Plain
  `http://127.0.0.1` is allowed only through a constructor flag that the test-support
  feature exposes.
- **Calls:** `meta()` (W1, unsigned), `claim(..)` (W4), `config()` (W5),
  `rotate(reason: User | Sync)` (W7, sends `known_token_version` from the credentials),
  `unpair()` (W8 `POST /v1/machine/unpair`, empty body) and `set_origin(port)` (W32
  `PUT /v1/machine/origin`). 10 triggers `set_origin` and `rotate(Sync)`; this phase only
  provides them.
- **Threading:** worker or CLI threads only, never the UI thread.
- **Errors:** `MachineApiError` has the exhaustive variants `Revoked`,
  `ProtocolUnsupported{min,max,ours}`, `ClockSkew{server_time}`, `Refused{code, message}`,
  `Server{status}`, `Network(String)` and `Malformed`.
  - They come from 02's error envelope, keyed on `code`: `machine_revoked` → `Revoked`;
    `protocol_unsupported` → `ProtocolUnsupported` (from `details {min, max}`);
    `signature_expired` → `ClockSkew` (from `details.server_time`, else the `Date` header);
    any other registered code → `Refused{code, message}`; an unknown code falls back to its
    status class (02 §4). `Retry-After` is kept on retryable codes.
  - `request_id` (or the `Yaran-Request-Id` header) is logged with every failure.
  - Every server-supplied string goes through `sanitize::for_terminal` and is truncated to
    200 characters before it is logged or shown (T53).
- **Revocation:** any `410 machine_revoked` from any caller (CLI, 10's leg, 12's emitter)
  does two things. It sets the process-wide `RevocationSignal`, which 10's leg subscribes
  to. It also stamps `revoked_at` in the credentials under the flock. That stamp is how
  "machine's yaran learns on its next signed call and stops the leg out loud" (README
  flow 6) holds for every caller.
- **Logging:** one `tracing` target, `yaran::cloud`. Request logs carry method, path and
  status, never headers or bodies.

### Login flow (one engine-free function, three front ends)

```text
normalize org URL ─▶ GET /v1/meta (protocol check, org name) ─▶ refuse if already paired
  ─▶ keygen + PKCE verifier (32B b64url = 43 chars) + state (32B b64url)
  ─▶ bind std TcpListener 127.0.0.1:0 ─▶ authorize URL (v, state, code_challenge, S256,
     machine_pubkey, machine_name, callback, yaran_version, origin_port*) ─▶ open browser + print URL + fingerprint
  ─▶ first of: loopback GET /callback?code&state │ pasted callback URL │ cancel │ timeout
  ─▶ constant-time state compare ─▶ signed POST /v1/machine/claim (code, code_verifier, yaran_version, origin_port*)
  ─▶ mint handoff consent key (D24) ─▶ write credentials (flock, atomic, 0600) ─▶ LoginOutcome
```

- **`cloud::login::run_login(params, io: &mut dyn LoginIo) -> LoginOutcome`.**
  - `LoginIo` supplies: `open_browser(url)`, `show_authorize(url, fingerprint, org_name)`,
    `pasted_callback() -> Receiver<String>` (may never yield), `cancelled() -> bool`, and
    `progress(step)`.
  - The CLI implements it with stdin/stdout, the TUI with a worker plus a prompt, and the
    web with a session registry.
- **Loopback listener** (`cloud/loopback.rs`), a std listener with no HTTP crate:
  - Binds only `127.0.0.1`.
  - Accepts with a 250 ms poll so cancel and timeout are checked.
  - Reads at most 8 KiB of request head, accepts only `GET /callback?…`, and answers 404
    to anything else (favicon included) while it keeps waiting.
  - A state mismatch answers 400 with a plain sentence and keeps waiting, so a stray tab
    cannot end the login.
  - On success it answers a self-contained HTML page ("yaran is paired; you can close this
    tab") with `Cache-Control: no-store` and no external assets, then drops the listener.
- **Pasted URL:** the parser accepts the full `http://127.0.0.1:<port>/callback?code=…&state=…`.
  The port must equal ours, the path must be `/callback`, and `state` must match. This
  covers SSH sessions where the browser runs on another device and the redirect fails
  there, without any new Worker surface.
- **Machine name:** 02's `MachineName` (`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`), so yaran
  slugifies before sending; 05 still derives the hostname from it.
  - Default: the short hostname (`rustix::system::uname().nodename()`, trimmed at the first
    dot), lowercased, every run of other characters turned into one `-`, leading and trailing
    `-` dropped, cut to 32 characters (then trailing `-` dropped again); an empty result
    becomes `machine`. The slug is printed before the browser opens.
  - `--name` must already match `MachineName`; otherwise the CLI refuses with a sentence that
    names the rule and suggests the slugified form. A Worker `machine_name_invalid` is shown
    the same way.
- **Org URL normalization:**
  - `https` only.
  - Lowercased host, no userinfo, no query or fragment.
  - The path must be `/` or empty; the trailing slash is dropped.
  - IDN goes through `url` (already a direct dependency).
- **Already paired:**
  - A different org is refused with "Run `yaran cloud logout` first".
  - The same org is allowed: the Worker's replace flow handles it (06 Design, "Replace"), and
    the old credentials are swapped only after a successful claim.
- **\* `origin_port` (02 `OriginPort`, 1–65535):** the Worker must learn the loopback port
  the tunnel targets.
  - Login sends the effective `[server] port` as `origin_port` in the authorize query (so 05
    can provision the ingress at authorize) and again, required and authoritative, in the
    claim body. When the two differ the Worker repairs the ingress before answering (02 §6).
  - The credentials store `ClaimResponse.origin_port`.
  - A later port change is 10's job: before it starts the leg, 10 compares the serving port
    with `origin_port` and calls `MachineApi::set_origin(port)` (signed W32
    `PUT /v1/machine/origin`), which answers `202 OriginUpdateResult {origin_port, changed}`;
    this client then rewrites `origin_port` in the credentials under the flock. This is the
    yaran half of 19's hook H2.

### Outcomes and status keys (one sentence per outcome, every surface)

- **`cloud::outcome::CloudActionOutcome`** is exhaustive:
  - `Paired{hostname, org_name}`
  - `AlreadyPairedElsewhere{org}`
  - `ProtocolUnsupported{..}`
  - `LoginTimedOut`
  - `LoginCancelled`
  - `BrowserUnavailable{url}`: not an error. The surface shows the URL to open by hand.
  - `ClaimRefused{code, message}`
  - `Unpaired{hostname}`
  - `UnpairedLocallyOnly{hostname}`: Warning, sticky. The token stays valid until an admin
    removes the machine, so the person must act.
  - `NotPaired`
  - `Rotated{hostname}`
  - `ConsentKeyRotated{hostname}`: Info. The effect is invisible on this screen, so it is
    always confirmed: "Phones will be asked to confirm again the next time they sign in to
    `<hostname>`."
  - `Revoked{hostname}`
  - `ClockSkew` (from `signature_expired`; names the server time and the offset)
  - `Network{detail}`
  - `CredentialsUnreadable{reason}`
- **`report()`** returns a `StatusText` built with `status_text!`. The org, hostname and
  command are `q(..)` chips. The terminal UI prints the plain spelling; the web gets the
  segments.
- **Keys:** `cloud-login`, `cloud-logout`, `cloud-rotate` and `cloud-status`, as constants
  in `cloud/outcome.rs`.
- **Confirmation policy (CLAUDE.md "A confirmation is owed…"):**
  - `Paired`, `Unpaired`, `Rotated` and `ConsentKeyRotated` are always confirmed: destructive
    or small-indicator changes, and a consent-key rotation shows nothing on screen.
  - `NotPaired` is confirmed as the "state already held" case.

### Surfaces

- **CLI.** All five verbs are listed in top-level help. Each has `--help`.
  - `yaran cloud login [<url>] [--name <n>] [--no-browser]`
    - `--no-browser` prints the URL and waits for the loopback or a paste.
    - The CLI prints the org name, the machine name it will send, the URL and the
      fingerprint (02 §7.1, e.g. `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`, with "check that your
      browser shows the same code"), then "Waiting… (paste the address your browser lands
      on if it can't reach this machine)".
    - If `browser::open_url` fails (headless, SSH, container), the CLI prints the URL and
      keeps waiting on the loopback and the paste (`BrowserUnavailable{url}`, not an error).
      This is 19's hook H1.
    - On success it prints the hostname, and also whether a running yaran picked it up
      (the leg-state file appears within the 10 cadence) or that no yaran is serving
      (naming `yaran server` / `serve_while_tui`).
  - `yaran cloud logout [--yes] [--local-only]`
    - Destructive. On a TTY it asks with the hostname; off a TTY, `--yes` is required.
    - It sends signed `POST /v1/machine/unpair` (W8, empty body); `202 TeardownStarted`
      and `410 machine_revoked` both count as success.
    - Then it deletes the credentials.
    - A network failure refuses unless `--local-only` was given, which forgets the
      credentials locally and prints the sticky warning sentence.
  - `yaran cloud status [--json] [--offline]`
    - Local: credentials summary (no secrets), mode, leg state (pid verified alive).
    - Remote: signed `GET /v1/machine/config`, unless `--offline`.
    - Exit codes: 0 when paired and the leg is ready; 3 when paired and the leg is not
      running; 4 when not paired; 5 when revoked; 1 on errors. Documented in `--help`.
  - `yaran cloud rotate [--yes]`
    - Confirms, then sends signed `POST /v1/machine/rotate` with
      `{known_token_version, reason: "user"}`.
    - It rewrites `tunnel_token` and `token_version` from `RotateResponse.tunnel`. 10's leg
      restarts on the new credentials revision. The handoff consent key is untouched.
  - `yaran cloud rotate --consent-key [--yes]` (D24)
    - Local only: no Worker call, the tunnel token untouched. It confirms on a TTY ("every
      phone will see the consent page once more on `<hostname>`"); off a TTY, `--yes` is
      required.
    - Under the flock it writes a fresh `handoff_consent_key` with the version incremented,
      so every remembered consent on this machine stops verifying at once. Outcome
      `ConsentKeyRotated`, key `cloud-rotate`; `NotPaired` when there are no credentials.
    - CLI only, deliberately: the TUI palette and the web dialog keep their one rotate action.
      This is a rare recovery step (a lost phone whose holder still has an Access session),
      a full re-pair does the same, and a second rotate button beside "Rotate token…" would
      invite the wrong one. Revisit if users ask.
  - `yaran cloud pair-phone [--org <url>]`
    - Prints a QR of `yaranapp://add-org?u=<org url>` built by
      `cloud::protocol::uri::add_org_uri` (02 fixture `cloud/protocol/fixtures/uri/add-org.json`),
      plus the URL in text and the install hint.
    - The org comes from the credentials, then `--org`, then `[cloud] org_url`.
- **TUI palette** (decided per CLAUDE.md "keep surfaces in step").
  - Five commands: `cloud-login`, `cloud-logout`, `cloud-rotate-token`, `cloud-status`
    and `cloud-pair-phone`.
  - They are always listed. The worker answers `NotPaired` / `AlreadyPairedElsewhere`
    rather than gating availability on a file stat on the UI thread.
  - Modals, each registered with its family in `modal.rs`:

    | Modal | Family | Contents |
    |---|---|---|
    | Login | Form | Single-line URL field, pre-filled. After start, a single-line "paste the address" field plus the authorize URL and fingerprint as chips. Enter submits; Escape cancels the login. |
    | Logout | Confirm | Cancel autofocused. |
    | Rotate | Confirm | Cancel autofocused. |
    | Status | Report | |
    | Pair phone | Report | Shows the QR. |

  - The QR is painted from the module matrix with two new theme tokens,
    `yaran.qr_dark` / `yaran.qr_light`, wired through every theme with black/white
    defaults. Scanners need that contrast; no existing semantic token means "scanner
    contrast".
  - The browser opens through the existing `UrlOpener` seam.
- **Web.** One app-menu entry, "Yaran Cloud…" (icon, trailing `…`). It opens a dialog that
  shows status and offers Connect / Rotate token… / Disconnect…; each destructive action
  has its own confirm dialog.
  - Connect follows the same flow: `POST /api/v1/cloud/login/start {org_url}` returns
    `{login_id, authorize_url, fingerprint, org_name}`.
  - The page opens `authorize_url` in a new tab from the click handler. **The server never
    calls `open_url`**, because the browser may not be on the server's machine (the
    remote-first reasoning of the hyperlink tenet).
  - A local browser completes through the loopback listener. A remote one pastes the
    landing address into a single-line field: `POST …/login/complete {login_id,
    callback_url}`.
  - Results arrive as the keyed toast through `lib/notify.ts`.
  - The global, parameter-free palette commands map to this one dialog. "Connect a
    phone…" is 13's entry; this dialog links to it rather than duplicating the QR.

## Work items

Every created file starts with the 00-CONVENTIONS §2 header and its generated Uses /
Used-by tree. Planned sizes are ceilings, not targets.

1. **Extract the shared private-file helpers (first PR).**
   - Create `crates/yaran-core/src/private_file.rs` (~170).
     - `write_private_atomic(path, body)`: the `store.rs:336-374` logic plus a parent-dir
       fsync.
     - `with_exclusive_lock(lock_path, f)`: the `store.rs:150-168` logic.
   - Touch `human_board/store.rs`: replace both bodies with calls. Add one `mod` line in
     `lib.rs`.
   - Reuse: `io_retry::retry_on_interrupt_errno` and `file_modes::PRIVATE_FILE_MODE`.
   - Tests: mode is 0600; a crash mid-write (temp left behind) never replaces the target;
     two threads contend on the lock; an existing board test suite passes unchanged.
2. **`[cloud]` config section.**
   - Create `crates/yaran-core/src/cloud/config.rs` (~220): `CloudConfig` with
     `#[serde(default)]` and `Default`; `CloudMode` with `parse`, `as_str`,
     `unknown_value_warning`, `wants_leg`, `warns_when_unpaired`; `cloud_load_warning`.
   - Touch the existing `crates/yaran-core/build.rs` (+~30): read `publisher_domain`
     from the repo-root `publisher.json` (18), emit `cargo:rerun-if-changed`, and expose it as
     `YARAN_PUBLISHER_DOMAIN` (empty for the `<publisher-domain>` placeholder or a missing
     file). `CloudConfig::default().app_callback_urls` is
     `["https://<domain>/auth/callback"]`, or empty when the value is empty.
   - Touch `config.rs`:
     - the `cloud` field plus `Default` (2 lines);
     - the re-export (1);
     - the correction call in `load_config` beside :3842 (3).
   - Create `crates/yaran-tui/src/config_schema_cloud.rs` (~160), returning
     `Vec<ConfigEntry>`. Touch `config_schema()` with one `.extend` splice before
     `[storage]`, and touch `default_config_is_commented_and_complete` with one assert per
     key.
   - Create `crates/yaran-core/src/cloud/config_patch.rs` (~90), `patch_cloud`. Touch
     `config_write.rs`: make the 5 helpers `pub(crate)`, and add one call in
     `apply_patches`.
   - Tests:
     - mode parse table, including case and whitespace;
     - an unknown mode corrects to auto with one warning;
     - render → parse → render is stable;
     - `upgrade_config.rs` asserts `config.cloud == fresh.cloud` for an old file;
     - `config_diff_reports_the_cloud_mode`;
     - the exhaustiveness test passes untouched (string mode);
     - patch round trip keeps user comments;
     - the `app_callback_urls` default derives from `publisher.json`: a real domain gives one
       `https://…/auth/callback` entry, the placeholder gives an empty list.
3. **Paths, credentials, leg-state format.**
   - Create `cloud/paths.rs` (~70), `cloud/credentials.rs` (~380) and `cloud/leg_state.rs`
     (~140).
   - Reuse: `file_modes::{create_private_dir_all, restrict_to_owner}` and `private_file`.
   - Tests:
     - round trip;
     - modes are 0600/0700;
     - a symlink is refused;
     - a future schema is refused without a write;
     - redacting `Debug`;
     - the revision changes on rewrite;
     - concurrent writers serialize;
     - `revoked_at` stamping;
     - a leg-state file with a dead pid reads as "not running";
     - D24: `read_handoff_consent_key` returns the stored key and version, `None` unpaired;
       a schema-1 file missing either field is `CredentialsUnreadable`; a key that is not 32
       bytes or a version of 0 is refused; the key is redacted from `Debug`.
4. **Identity and signing.**
   - Create `cloud/identity.rs` (~160: keygen, PKCS#8 load, public key, fingerprint through
     `cloud::protocol::fingerprint`) and `cloud/signed_request.rs` (~120: serialize once,
     `cloud::protocol::signing::sign`, attach headers). Add `ring` and `base64` to
     `crates/yaran-core/Cargo.toml`.
   - Tests:
     - sign/verify round trip with `UnparsedPublicKey`;
     - 02 canonical-string and signature fixtures (exact bytes, Host and protocol lines
       included), so a body re-serialized after signing fails the test;
     - `fixtures/sig/fingerprint.json`: every key's fingerprint matches, and the printed
       form matches `^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$`;
     - the PKCS#8 reload signs identically.
5. **Signed client and revocation.**
   - Create `cloud/machine_api.rs` (~420) and `cloud/revocation.rs` (~90).
   - Tests:
     - error-envelope fixture → variant table;
     - a 410 sets the signal and stamps credentials;
     - a hostile server string is sanitized and truncated;
     - the body cap is enforced;
     - plain HTTP is refused without the test flag;
     - the code → variant table covers every code listed in Evidence, plus an unknown code
       falling back to its status class.
   - Integration (`crates/yaran-core/tests/cloud_machine_api.rs`): a std-thread mock
     Worker on loopback verifies signatures with the 02 Rust verifier helper and plays
     each endpoint's success, 410, skew and malformed responses, for W1, W4, W5, W7 (`user`
     and `sync`), W8 (202 and 410 both delete credentials) and W32 (`changed` true and false,
     `origin_port` rewritten in the credentials).
6. **PKCE, org URL, loopback, login.**
   - Create `cloud/pkce.rs` (~80), `cloud/org_url.rs` (~130), `cloud/loopback.rs` (~300)
     and `cloud/login.rs` (~420).
   - Tests:
     - verifier length/charset and S256 against RFC 7636 Appendix B;
     - URL normalization table;
     - machine-name slug table (dots, uppercase, Unicode, > 32 chars, all-symbol → `machine`)
       and `--name` refusal;
     - listener: 404 on other paths, 400 on bad state (keeps waiting), oversized head
       rejected, timeout, cancel, binds 127.0.0.1 only;
     - pasted-URL parser table.
   - Integration (`tests/cloud_login.rs`): a mock Worker plus a fake `LoginIo` "browser"
     that GETs the callback. Covers the full login, the paste path, the already-paired
     refusal, protocol mismatch, and a claim refusal leaving no credentials. It asserts the
     authorize query and the claim body both carry `origin_port`, and that
     `ClaimResponse.owner_email` lands in the credentials.
   - D24: a first claim writes a 32-byte `handoff_consent_key` with version 1; a same-org
     re-pair writes a different key with the version incremented; a refused claim leaves the
     old key and version in place.
   - 19 hook H1: a `LoginIo` whose `open_browser` fails still prints the authorize URL and the
     login completes through the loopback.
7. **QR.**
   - Create `cloud/qr.rs` (~150). Add `qrcode = { version = "0.14", default-features = false }`.
   - Tests:
     - the payload from `add_org_uri` equals `fixtures/uri/add-org.json`;
     - the matrix decodes back: a dev-dependency decoder is avoided, so instead compare
       against `qrcode`'s own `to_colors` for a pinned input and snapshot the Dense1x2
       string;
     - a quiet zone of 4 modules.
8. **CLI.**
   - Create `cloud/cli/mod.rs` (~200: dispatch, help, `run_cloud(args, paths)` and
     `run_with(args, deps, stdin, out)`), `cloud/cli/args.rs` (~250), `cloud/cli/login.rs`
     (~220), `cloud/cli/manage.rs` (~400: status, logout, rotate) and
     `cloud/cli/pair_phone.rs` (~110).
   - Touch `crates/yaran/src/main.rs`: the `Some("cloud") => run_cloud(args)` arm plus a
     6-line fn mirroring `run_board` (discover paths, `load_config`, no lock, no engine).
   - Touch `crates/yaran-tui/src/lib.rs` help with two lines, plus
     `help_lists_the_cloud_subcommand`.
   - Tests, through `run_with` with a mock Worker:
     - every verb's output and exit code;
     - `logout` refuses off a TTY without `--yes`;
     - `logout` sends `POST /v1/machine/unpair` and deletes credentials on 202 and on 410;
     - D24: `rotate --consent-key` changes the key, increments the version, leaves
       `tunnel_token` and `token_version` unchanged, makes no request to the mock Worker,
       refuses off a TTY without `--yes`, and answers `NotPaired` without credentials;
       plain `rotate` (user and sync) leaves the consent key and version unchanged;
     - `login` prints the fingerprint in the 02 §7.1 form;
     - `--local-only` warning;
     - `status --json` schema;
     - unknown verb/flag messages;
     - `yaran cloud --help` does not launch the TUI.
9. **TUI commands.**
   - Create `crates/yaran-tui/src/app/cloud_commands.rs` (~450: `impl App` prompts, worker
     spawns via `status_op(..).resolve_in_handler(..)`, outcome application) and
     `crates/yaran-tui/src/app/cloud_render.rs` (~300: modal bodies through the shared
     modal chrome, `name_chip`, and the QR painter).
   - Touch, wiring only:
     - `palette.rs`: 5 entries;
     - `action.rs`: 5 variants plus arms;
     - `keybindings.rs`: 5 `BindingDef`, plus the expected-set test;
     - `app/mod.rs`: `PromptState` variants and the `execute_command` arms;
     - `modal.rs`: 5 registry arms;
     - `worker.rs` and `engine/events.rs`: a `CloudActionFinished` event and reaction;
     - `theme.rs`: two tokens across all themes.
   - Tests:
     - modal families registered;
     - Escape cancels the login and closes the listener;
     - Space activates the focused button;
     - outcome sentences render as chips;
     - the QR painter uses only theme tokens;
     - the palette registry tests pass.
10. **Web routes and dialog.**
    - Create `crates/yaran-web/src/cloud_routes.rs` (~420):
      - `GET /api/v1/cloud/status`
      - `POST /api/v1/cloud/login/start`, `…/login/complete`, `…/login/cancel`
      - `POST /api/v1/cloud/logout`, `POST /api/v1/cloud/rotate`

      Work runs in `spawn_blocking`, statuses go through `EngineHandle::post_status`, and
      there is one login session at a time (a new start supersedes the old one).
    - Touch `server.rs`: one router merge.
    - Create `web/src/lib/cloudApi.ts` (~160), `web/src/components/cloud/CloudDialog.tsx`
      (~400), `CloudLogoutDialog.tsx` (~150) and `CloudRotateDialog.tsx` (~120). Touch
      `appMenu.ts` with one item.
    - Reuse: shadcn dialog/button primitives, `InlineCode` chips, `lib/notify.ts`, the
      shared confirm-dialog pattern, and the `TextInput`-equivalent web field.
    - Tests:
      - route tests (POSTs are covered by the existing same-origin layer, `server.rs:970-980`);
      - start → complete with a mock Worker;
      - supersede;
      - Vitest for the dialog states and confirms (Cancel autofocused);
      - the chip guard test passes;
      - the app-menu item has an icon and `…`.

## Acceptance

- [ ] `yaran cloud login <url>` against a mock Worker pairs, writes
      `<root>/cloud/credentials.json` with mode 0600 inside a 0700 dir, and prints the
      hostname and fingerprint (02 §7.1 form, equal to `machine_key_fingerprint` of the
      registered key). The paste path works with the browser unable to reach the listener,
      and a failed browser open still prints the URL (19 H1).
- [ ] The claim sends `origin_port`; the credentials hold `owner_email`, `origin_port` and
      `token_version` from the `ClaimResponse`; `set_origin` (W32) rewrites `origin_port`.
- [ ] No secret (the handoff consent key included) appears in `config.toml`, `GET /api/v1/config/raw`, `yaran config diff`
      (plain and `--raw`), the bootstrap, any log line, or `Debug` output. Each has a test.
- [ ] Every signed request matches 02's fixtures byte for byte. A `410 machine_revoked`
      from any caller sets the revocation signal and stamps `revoked_at`.
- [ ] `logout` (`POST /v1/machine/unpair`), `rotate` and `status` behave as specified,
      including exit codes, `--local-only` and TTY confirms.
- [ ] D24: every claim mints a fresh 32-byte `handoff_consent_key` in the 0600 credentials
      with `handoff_consent_key_version` incremented on re-pair; tunnel rotation keeps both;
      `yaran cloud rotate --consent-key` replaces the key and increments the version with no
      network call; logout deletes it; 11 reads it through `read_handoff_consent_key`.
- [ ] The `[cloud]` section renders fully commented, round-trips, survives an old-config
      upgrade, and every key is saved by `apply_patches`.
- [ ] The TUI palette has 5 cloud commands with registered modal families. The web app menu
      has "Yaran Cloud…" with login, rotate and disconnect, all destructive actions
      confirmed, and outcome sentences identical on both surfaces.
- [ ] Every new file is ≤ 500 lines and passes `module-headers --check`. `cargo deny check`
      passes with `ring`, `base64` and `qrcode`.

## Validation

```bash
cd /Users/siavash/Projects/yaran
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p yaran-core cloud::
cargo test -p yaran-core --test cloud_machine_api --test cloud_login --test upgrade_config
cargo test -p yaran-tui config_schema cloud help_lists_the_cloud_subcommand palette
cargo test -p yaran-tui --lib cli::tests::config_diff
cargo test -p yaran-web cloud_routes
cargo deny check licenses bans sources
(cd crates/yaran-web/web && npm run typecheck && npx vitest run src/components/cloud src/lib/cloudApi src/lib/appMenu)
node tools/module-headers/bin/module-headers.mjs --check crates/yaran-core/src/cloud crates/yaran-web/src
node tools/module-headers/bin/module-headers.mjs --lines --check
grep -rn 'tunnel_token\|machine_key_pkcs8' crates/yaran-core/src/config*.rs crates/yaran-tui/src/config*.rs && exit 1 || true
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The serving port differs from the paired `origin_port` (a non-default or changed `[server] port`), so the tunnel targets the wrong port | Medium | Tunnel 502s | Resolved in 02: `origin_port` rides the authorize query and the claim, and 10 calls signed W32 `PUT /v1/machine/origin` before starting the leg; a failed W32 stops the leg with a sentence (10). |
| A running yaran clobbers a CLI config edit | Certain if the CLI wrote config | Lost org URL | The CLI never writes config. The credentials carry the binding. |
| SSH session: the browser cannot reach the 127.0.0.1 callback | Common | Login stalls | Pasted-URL fallback on every surface, plus `--no-browser`. |
| Clock skew fails signed requests | Medium | Login and claim fail | `ClockSkew` outcome names the server time and tells the person to fix the system clock. |
| Credentials stolen by a same-uid process or from a backup | Medium | Rogue connector (T27), forged machine calls (T28) | 0600 in the 0700 root, never in argv/config/env. `rotate` and admin revoke. Documented honestly with no keychain (T5). |
| The handoff consent key leaks with the credentials | Medium (same as the file) | A thief can mint consent cookies for this host, which still need the phone's own device signature and an owner Access JWT to skip anything (02 §8.1) | Same 0600 file and boundary as the tunnel token; `rotate --consent-key` or a re-pair invalidates every cookie. |
| A stray or hostile local tab hits the loopback port | Low | Login aborted | State mismatch answers 400 and keeps waiting. Constant-time compare. The port is open only during login (RFC 8252 §8.3). |
| The fingerprint or canonical string drifts from 02 | Low (02 §7 and §7.1 fix both) | Pairing confirm mismatch, every signed call fails | This phase calls 02's Rust `signing` and `fingerprint` modules and is pinned by 02's fixtures. Nothing is hard-coded beyond the parser. |
| `qrcode` matrix differs from the Worker's `uqr` for the same payload | Low | None functionally (both valid) | Tests decode-compare the payload, not the pixels. |

## References

- `00-README.md` D2, D5, D6, D7, D12, D15, D16, D24; flows 2, 4 and 6.
- `research/R1-server-core-cli.md` §6, §7, §8, §9; `research/R3-repo-process.md` §5.
- `02-protocol-contract.md` §4 (errors), §5 (W1, W2, W4, W5, W7, W8, W32), §6 (schemas), §7 and §7.1 (signing, fingerprint), §8 (`app_callback_urls`), §8.1 (handoff consent key), §10 (`add-org` URI).
- `06-worker-pairing-and-sessions.md` (Worker side of pairing, confirm page, Replace flow).
- `19-integration-and-end-to-end-verification.md` hooks H1 (owned here), H2 (yaran half here and in 10), H7 (12 adds keys to `[cloud]`).
- `17-docs-website-threat-model.md` T27, T28 (including `PUT /v1/machine/origin`), T35, T53; `cloud-connect-machine.md`.
- RFC 8252 §7.3, §8.3; RFC 7636 §4.1–4.2, §7.2 (rfc-editor.org, read 2026-11-14).
- https://crates.io/crates/qrcode, https://crates.io/crates/ring (read 2026-11-14).

## Reconciliation notes (2026-11-14)

- R20/02: Evidence "Protocol" block now cites 02 (W1–W8, W32 shapes, error codes, signing, fingerprint, QR) instead of 06's draft line numbers.
- R8: unpair is signed `POST /v1/machine/unpair` (W8); `202` and `410` both delete credentials (was `DELETE /v1/machine`, 204/410).
- R9: `origin_port` sent in the authorize query (optional) and the claim body (required); stored from `ClaimResponse`; `MachineApi::set_origin` (W32 `PUT /v1/machine/origin`) added, triggered by 10. The 3890-only fallback is removed because 02 adopted the primary; the Risks row is rewritten accordingly.
- R9: `owner_email` (flat in `ClaimResponse`) stored in credentials and named as D3's input to 11; `org_name` added; `token_rev` renamed `token_version`; `ClaimResponse` → credentials mapping stated (`tunnel.token`, `access.*`, `org.*`).
- R9/02 §7.1: fingerprint format stated (29-char base32, six groups) and computed by 02's `cloud::protocol::fingerprint`; the CLI prints it.
- 02 §7 / one home per concept: signing goes through `cloud::protocol::signing`; `cloud/signing.rs` replaced by a thin `cloud/signed_request.rs`; the canonical-string description corrected (Host, protocol, machine id, no query).
- 02 `MachineName`: names are slugified to ≤ 32 DNS-label chars before sending (was 64 printable chars, "slugging is 05's job").
- 02 §4: error-code → `MachineApiError` mapping spelled out (`signature_expired` → `ClockSkew`, etc.); `Yaran-Request-Id` logged.
- 02 §8: `[cloud] app_callback_urls` key added (09 renders, 11 enforces).
- 02 §10: QR payload uses `add_org_uri` and fixture `cloud/protocol/fixtures/uri/add-org.json` (was `qr-add-org.json`).
- R1: the ring sentence names the JWE ECDH-ES (Concat KDF) + A256GCM envelope; no HKDF wording.
- R16/R21: `cloudflared_path` comment says the minimum is 2026.11.0 (was 2025.4.0).
- R14: T28 now explicitly covers `PUT /v1/machine/origin` and `POST /v1/machine/unpair`.
- R15: 19's hook H1 (print the authorize URL when the browser cannot open) has an explicit design line, test and acceptance item; H2's yaran half and H7's `[cloud]` placement are noted. (The hooks table lives in Phase 19, not Phase 03.)
- R20: Depends / Blocks / Parallel-safe lines checked against 00-README Wave B; unchanged.

### Straggler pass (2026-11-14)

- Straggler pass: `[cloud] app_callback_urls` default derived at build time from the repo-root `publisher.json` via the existing `crates/yaran-core/build.rs`; work item 2 and a test added (18's one home, D16).
- Straggler pass: Validation uses 01's real CLI (`node tools/module-headers/bin/module-headers.mjs`) (R20). H1 and H2 work items verified (R15).
- D24: credentials gain `handoff_consent_key` (32 random bytes, base64url) and `handoff_consent_key_version`, minted on every claim (version + 1 on re-pair), kept by tunnel rotation, deleted with the credentials, redacted from `Debug`; schema 1 is unreleased so no migration.
- D24: rotation path is `yaran cloud rotate --consent-key [--yes]` (local, no Worker call), outcome `ConsentKeyRotated`, key `cloud-rotate`; CLI only by decision (TUI palette and web dialog unchanged, reason in Surfaces).
- D24: `credentials::read_handoff_consent_key` is 11's per-request reader, so a rotation applies without a rebind; tests in work items 3, 6 and 8, one acceptance item, one Risks row; the no-secret acceptance names the key.

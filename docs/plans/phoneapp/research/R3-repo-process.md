# R3: Repo structure, process, config, docs, release, security docs

Repo: `/Users/siavash/Projects/yaran`. All paths below are relative to it. `file:line` citations come from four parallel read-only sub-agents. The lead spot-checked these: the threat-model's last ID, the empty phoneapp dir, the release tag pattern, the plan header, the missing `ci/` and `xtask/` dirs, `brand_env::var`, the diff exhaustiveness test, and LICENSE. Anything not confirmed is marked UNVERIFIED.

---

## 1. Repo layout and monorepo conventions

- **Cargo workspace.** Members are `crates/yaran-core`, `crates/yaran-tui`, `crates/yaran` and `crates/yaran-web` (Cargo.toml:2-7), with `resolver = "3"`.
  - One shared `[workspace.package] version = "0.1.0"` (:13).
  - MSRV is `rust-version = "1.89"` (:17), checked by the `msrv` job. There is deliberately no `rust-toolchain.toml` (:14-16).
  - The release profile uses size optimisation plus LTO (:58-60).
- **package.json files.** There are four. All use **npm** with `package-lock.json` lockfileVersion 3. There is no pnpm, yarn or bun anywhere.

  | Path | Purpose | Scripts |
  |---|---|---|
  | `website/package.json` | Astro docs and marketing site (private) | `prep`, `dev`, `build` (prep, then astro build, then verify-figure), `test` (vitest), `test:search` (:6-19). Has an `allowScripts` block for esbuild and fsevents (:46-49). |
  | `crates/yaran-web/web/package.json` | React + Vite + Tailwind UI, compiled into the binary by `crates/yaran-web/build.rs` | `dev`, `build` (`tsc -b && vite build`), `test` (vitest), `lint` (eslint) (:6-12). TypeScript `~6.0.2`. |
  | `tools/preview-env/package.json` | puppeteer-core and xterm for screenshots | none |
  | `npm/package.json` | npm wrapper that ships prebuilt binaries | `bin/yaran.js` picks `vendor/<platform-arch>/yaran` (bin/yaran.js:11-32). `engines: node >=18` (:34-36). |

- **Node version.**
  - There is no `.nvmrc`, `.node-version` or `.tool-versions`. CONTRIBUTING.md:12 says "Node 22.12 or newer".
  - CI is split across two versions:
    - Node 22 via `actions/setup-node@49933ea…` (v4.4.0) in pr.yml and test.yml.
    - Node 24 via `setup-node@2499707…` (v6.5.0) in website-ci.yml:56-58, pages.yml:70-72 and release.yml:367-369.
  - The release build jobs have **no setup-node step**, so the web UI is built with whatever Node the runner image ships (release.yml:119-164). pr.yml:99-103 warns about exactly this risk.
- **`npm/` directory.**
  - `npm/scripts/build_npm_package.mjs` takes `RELEASE_VERSION`, packs the four release archives and writes `dist/npm/yaran-npm-<ver>.tgz` (:16-61).
  - npm/README.md:33 says no Yaran npm package is published.
  - The npm publish jobs only run in the upstream repo `patrickdappollonio/dux` (release.yml:362, :395). The fork never publishes.
- **`tools/`.**
  - `reload-live-check{,-fullscreen,-multi}.sh` are live checks for `reload-binary`.
  - `preview-env/` is the Docker preview container: screenshots, TUI driver and `screens/reshoot.sh`. See §6 and §8.
- **Makefile** (read in full). It has thin cargo wrappers: `run`, `fmt`, `fmt-check`, `lint`, `lint-fix`, `profiling` (:3-20). It also has `overlay-shellcheck`, `overlay-bats` and `overlay-test` (:22-35). There are no npm or web targets.
- **"Overlay".** This is `yaran-amq/`: bash setup scripts, wrappers and bats tests that wire yaran to AMQ on a Linux VM (yaran-amq/README.md:3-5).
- **Precedent for non-Rust subprojects with their own CI.** Each has its own workflow file, `concurrency` group and `permissions: contents: read`:
  - `website/` uses `website-ci.yml`, path-filtered.
  - `yaran-amq/` uses `overlay-ci.yml`, not path-filtered (shellcheck and bats).
  - `install.sh` uses `install-script-ci.yml`, path-filtered.
- **`docs/plans/phoneapp/`** exists but is **empty**. It was created 2026-11-14 08:31 and has no git history (lead verified with `ls -la`). No phone-app plan exists. Every earlier "phone" mention in git history is about the web UI's phone layout.

## 2. CI and release

### Common conventions

- Every third-party action is pinned to a full commit SHA with a `# vX.Y.Z` comment. Examples: `actions/checkout@11d5960… # v4.4.0`, `Swatinem/rust-cache@6323deb… # v2.9.2`, and the dtolnay toolchain at a SHA with `# stable` (pr.yml:75).
- Every workflow declares top-level `permissions`.
- Caching is done with `setup-node` (`cache: npm`, `cache-dependency-path` set to the lockfiles) and `Swatinem/rust-cache`.

### Workflows

| Workflow | Trigger and paths | Jobs | Notes |
|---|---|---|---|
| install-script-ci.yml | PR and push to main, for `install.sh`, itself, and `test_install_checksum.sh` (:3-14) | `verify-checksum-logic` (offline); `install` matrix against real releases (:39-80) | `contents: read` |
| overlay-ci.yml | every PR, plus push to main (:11-16) | `shell`: shellcheck plus `bats yaran-amq/tests` (:27-46) | required check |
| pages.yml | `release: published` and dispatch | build, then deploy to Pages | gated to `patrickdappollonio/dux` (:38), so **dead in this fork** |
| pr.yml | every `pull_request` | `no-ui-build-hatch` gate (fails if `YARAN_DISABLE_UI_BUILD` is set); `fmt`; `clippy -D warnings`; `Test (ubuntu-24.04)`; `web-lint`; `web-build` (build plus vitest); `dep-isolation` (yaran-web must not depend on the TUI crates, :218-236); `Test (macos-14)` (:261-293); `Security` (cargo-audit 0.22.2 and cargo-deny 0.20.2, :304-332); `msrv` (:338-361) | `contents: read` |
| test.yml | every push | mirrors the hatch, Test ubuntu/macOS and Security | |
| website-ci.yml | PR and push to main, for `website/**`, `tools/preview-env/screens/scenes/**`, `install.sh`, two assets and the workflow files (:6-29) | `build`: npm ci for both website and web, tests, build, output verify, search-index check (:39-110) | withholds `GH_TOKEN` from fork PRs (:95) |
| release.yml | `release: types: [created]` | see below | top-level `contents: write` |

### Repo policy files

- **BRANCH_PROTECTION.md.**
  - Required checks are `Test (ubuntu-24.04)`, `Test (macos-14)`, `Security` and `shell`, with strict up-to-date branches (:14-28). Others are recommended only (:30-36).
  - Merges need one CODEOWNERS approval (:10-13).
  - Tag protection covers `v*`, `dux-amq-v*` and `yaran-v*` (:45). Default workflow permissions are read-only (:53).
  - One statement is stale: :25-26 says macOS does not run `cargo test`, but pr.yml:292 does.
- **CODEOWNERS.** `* @SiavZ` (:8). Supply-chain paths are listed explicitly: workflows, scripts, dependabot, install.sh, deny.toml and Cargo.lock (:22-29).
- **dependabot.yml.** Covers `cargo` (:12-23), `github-actions` (:25-30) and `npm` for `/crates/yaran-web/web` only (:34-42). All run weekly on Monday with a limit of 5. **website/ and tools/preview-env are not covered.**
- **.github/scripts/.**
  - `set_workspace_version.sh` rewrites `[workspace.package] version`.
  - `smoke_archive.sh` runs the packaged `yaran server` and checks the HTML, the hashed asset graph and the WebSocket. It falls back to a static grep for the cross-compiled x86_64-darwin build.
  - `verify_fork_lineage.sh` refuses archives built from upstream code by checking for the jcode `resume_by_id_args` marker (:4-24).
  - `test_install_checksum.sh` tests install.sh's checksum logic offline.

### release.yml in detail

- **Trigger.** A human creates the GitHub release and tag first. The workflow then runs on `release: created` (:3-5).
- **Tag pattern.** `yaran-v*`, or the historical `dux-amq-v*`, followed by semver with an optional prerelease suffix (:60-71). Anything else exits with "Use yaran-vX.Y.Z" (lead verified, :62-69). A prerelease maps to npm dist-tag `next` (:79-83).
- **Matrix**, non-fail-fast (:103-117). Archives are named `yaran-{linux,darwin}-{amd64,arm64}.tar.gz`.
  - `x86_64-unknown-linux-musl` on ubuntu-latest
  - `aarch64-unknown-linux-musl` on ubuntu-24.04-arm
  - `x86_64-apple-darwin` and `aarch64-apple-darwin` on macos-latest
- **Build.**
  - `cargo auditable build --release` with `YARAN_RELEASE_BUILD=1` (:161-164). Tool versions are pinned: cargo-auditable 0.7.5 and cargo-cyclonedx 0.5.9 (:145-148).
  - A CycloneDX SBOM is produced per target (:176-183).
  - Packaging is reproducible: GNU tar with sort, owner and `--mtime=SOURCE_DATE_EPOCH` options and `gzip -n`, packed twice and compared with `cmp` (:189-209).
  - Each archive gets a `.sha256`. The comments say this is "not tamper protection… Signing… is not in place" (:215-234).
- **Web UI.** It is built inside `cargo build` by `crates/yaran-web/build.rs` (`npm ci`, falling back to `npm install`, then `npm run build`, build.rs:266-276). A failed frontend build is a hard failure.
- **Gates.** `smoke_archive.sh` (:242-243) and `verify_fork_lineage.sh` (:251-252) run before upload.
- **Provenance.** `actions/attest-build-provenance@e8998f9…` (v2.4.0) runs on the archive and the SBOM, with `id-token: write` and `attestations: write` (:93-96, :254-261). Verify with `gh attestation verify … --owner SiavZ`. There is **no cosign and no separate SLSA generator**.
- **Publish.** `publish-archives` needs every build leg. It concatenates `yaran-checksums.txt`, **requires exactly 4 lines** (:328) and runs `sha256sum -c`. It then does a single `gh release upload --clobber` (:301-353).
- **After publish.** `upload-install-script` attaches `install.sh` (:449-458). `update-release-notes` appends the README `## Install` section (:460-506).
- **install.sh.**
  - Repo defaults to `SiavZ/yaran` (:7). The version comes from `YARAN_VERSION` (:11).
  - The asset is `${bin}-${os}-${arch}.tar.gz`, with `bin=dux` for `dux-amq-v*` and `v*` tags (:332-338). A bare `X.Y.Z` becomes `yaran-vX.Y.Z` (:265-269).
  - Latest is resolved from `/releases/latest`, falling back to `/releases` (:274-292).
  - The checksum comes from `<url>.sha256`, falling back to `SHA256SUMS` (:353-366). A mismatch is fatal. A **missing checksum only warns** (:162-166, :187-240, :371).
- **Supply-chain plan status** (docs/plans/rustport/03-release-pipeline-and-supply-chain.md).
  - Done: the fork-lineage gate, the smoke test (server and web, not `yaran doctor`), the prerelease-tolerant version resolver and README-to-release-notes.
  - Not done:
    - There is no scheduled pin-freshness workflow (no `schedule:` in any workflow).
    - The overlay pins are stale: `AMQ_TAG v0.61.0` and `SKILLS_PIN 1.5.3` (yaran-amq/install.sh:38-41).
    - yaran-amq/install.sh:8 references `docs/plans/audits/audit01/01-supply-chain-hardening.md`, which does not exist.
  - UNVERIFIED: whether any non-prerelease `yaran-v*` release exists on GitHub.

## 3. Modularity tooling (rustport phase 02): planned, NOT built

- **What the plan specifies** (02-ci-gates-and-modularity-enforcement.md):
  - `ci/check-file-length.sh` would fail any `.rs` file over 500 lines (`MAX=${MAX:-500}`). The opt-out is `// allow-long-file: <reason>` in the first 5 lines (:70-89). It was to land warn-only first, because 22 files already violated it (:91-92).
  - `cargo modules orphans --deny` and `dependencies --acyclic` (:93-96).
  - A module-tree generator, `ci/module-trees.rs` or an `xtask`, emitting `# Uses` / `# Used by` trees in ```` ```text ```` fences, with a `--check` mode (:97-106).
  - Also: `clippy::missing_docs_in_private_items`, branch protection as code plus a drift check, an `#[allow]` scorecard, report-only `cargo llvm-cov`, and a pre-commit hook (:107-129).
  - Acceptance checkboxes at :131-145 are all unticked.
- **Reality.**
  - There is no `ci/` and no `xtask/` (lead verified).
  - Grepping `.github/`, Makefile, Cargo manifests, build.rs and tests finds nothing for any of: file length, `allow-long-file`, module-trees, `check-file-length`, `cargo modules`, `missing_docs_in_private`, `llvm-cov`, `pre-commit`.
  - 127 tracked `.rs` files exceed 500 lines. Examples: `crates/yaran-tui/src/app/input.rs` at about 39k lines, `render.rs` at about 28k, `yaran-core/src/wire.rs` at about 13.7k.
  - rustport phases 12-17 claim a dependency on a gate that does not exist. rustport's own CONVENTIONS.md:151-152 validation block lists the never-built scripts.
- **The real CI gates** are: fmt, clippy `-D warnings`, cargo test on Linux and macOS, web `npm run lint` / `build` / `test`, the dep-isolation check, cargo-audit, cargo-deny and MSRV 1.89.
- **File-header convention.**
  - What is written down: rustport CONVENTIONS.md:6-62 asks for a `//!` purpose line, a contract paragraph, then `# Uses` / `# Used by` trees.
  - What is practised: 247 of 285 tracked crate `.rs` files open with prose `//!` doc comments describing purpose, contract, threading and tradeoffs. **0** contain `//! # Uses`. Examples:
    - `yaran-core/src/lib.rs:1-4` states the layering rule.
    - `engine/amq.rs:1-12` describes the threading model.
    - `yaran-tui/src/app/modal.rs:1-15` has a markdown table.
    - `yaran-web/src/server.rs:1-12` describes the security posture.
    - Exception: `yaran-tui/src/app/mod.rs:1` has no header.
  - TypeScript files use `//` header comments. `web/src/lib/notify.ts:1-8` gives the module role and names its boundary test. `lib/termkeys.ts:1-4` says "Pure… No React, DOM or window access". Some components have none (`AddProjectDialog.tsx`).

## 4. Plan-doc house format (docs/plans/rustport/)

- **Header.** The title line is `# Phase NN — <title>`. Two bold `·`-separated lines follow:
  - `**Track:** A (foundation) · **Parallel-safe with:** 01, 03, 04`
  - `**Depends on:** nothing · **Blocks:** 12–17 (<reason>)` (02:3-4; lead verified; same shape in 03:3-4)
  - Variant: `**Track:** E (serialized) · **Runs alone**` (23:3).
  - **There is no Status field.** A phase is done when every acceptance box is ticked and every validation command passes (README.md:169-170).
- **Section order** (README.md:165-167; counts are across the 24 phase files):
  1. `## Goal` (24)
  2. `## Evidence` (10), sometimes with a qualifier, e.g. "Evidence — all re-verified at the top level" (03:12)
  3. `## In scope` / `## Out of scope` (11). Each out-of-scope item points to the phase that owns it.
  4. `## Work items` (23): numbered, with bold lead-ins, `file:line` references and inline code.
  5. Optional `## Module tree` (6)
  6. `## Acceptance criteria` (24): `- [ ]` checkboxes, each verifiable. Example: "verified by reading back the live API — not by reading the doc" (02:140-141).
  7. `## Validation` (24): one bash block of commands.
  8. `## Risks` (24): a `| Risk | Mitigation |` table.
  9. `## References` (24): pointers into `artifacts/…` by section (§).
  - Some phases add a "Why …" section.
- **Evidence style.**
  - Dense `file:line` citations.
  - Live command output quoted verbatim.
  - Inline corrections, e.g. "**CORRECTED 2026-08-31 … supersedes the audit02 artifact**" (02:15).
  - Tables of measured numbers.
  - Research agents had to cite `file:line` and log anything unverifiable as an open question (README.md:31-36).
- **Supporting files.**
  - `README.md` holds:
    - the "not an MVP" rule (:14-17)
    - an ASCII track tree (:88-122)
    - a dependency graph with a reason on every edge (:126-137)
    - "why this ordering" (:139-154)
    - the baseline to preserve (:172-181)
    - a "historical record" banner (:3-12)
  - `CONVENTIONS.md` is binding ("do not restate these rules inside a phase file", :3-4). It covers headers, the 500-line rule, test placement, behaviour preservation, commit discipline and pre-push validation.
  - Raw research briefs live in `artifacts/` (README.md:38-47).

## 5. Config system: adding a setting end-to-end

### Structs

- The root `Config` is at `crates/yaran-core/src/config.rs:3045` with `#[serde(default)]`. Sections are fields on it (`server: ServerConfig` around :3073).
- `ServerConfig` is at :876. Its defaults are in `impl Default` at :2238: `127.0.0.1`, port `3890`, `tailscale "auto"`, `serve_while_tui false`.
- `tailscale` is a `String` tri-state with a custom deserializer that also accepts a bool (around :838). It is read only through `tailscale_mode()` (:1104). An unknown value logs one warning (`tailscale_load_warning`, :870).
- Load-time key renames live in `config_migrate.rs:28` (`apply_load_migrations`). Clamping uses `normalized_*` helpers called from `load_config` (:3762).

### Canonical commented renderer (lives in the TUI crate)

- `config_schema()` is at `crates/yaran-tui/src/config.rs:342`. It is a data table of `ConfigEntry` (:306) values: `Comment`, `Blank`, `Section`, and `Field{key, comment, value_fn}`.
- Values go through `FieldValue` (:289): Str, OptStr, U16, U32, U64, Usize, Bool, StrList. There is no float.
- The rule at :283: a new setting is a struct field, plus its Default, plus one entry here.
- `[server]` starts at :1022.
- `render_config` (:1841) is registered into core through `config_write::set_canonical_renderer` (:1939; config_write.rs:164-191).
- `default_config_is_commented_and_complete` (:3428) needs a **manual `assert!` per new key**.
- The schema must be kept in step by hand with the web's `settingsDescriptors.ts` (:334-340).

### config_write.rs (toml_edit patching)

- `apply_patches` (:232) is a hand-written list. `[server]` is at :548-688. Helpers are `ensure_table` (:828) and `patch_table_{str,opt_str,u16,u32,usize,u64,bool,string_array}` (:835-903).
- **A key missing from `apply_patches` is never saved**, including through the web's plain render (`render_config_plain` :224).
- Patching keeps the user's comments but never adds new ones (:156-161). `yaran config restore-docs` restores them.
- Retired keys use `remove_table_key`. Retired sections go in `ORPHANED_CONFIG_SECTIONS` (:1426).
- Atomic write is `write_config_atomic` (:45): temp file at 0600, then rename, then a directory fsync.
- Runtime saves go through `ConfigWriteQueue` (`config_queue.rs:150/176`).

### `yaran config diff`

- Entry point is `crates/yaran-tui/src/cli.rs` `run_diff` (:399). `--raw` prints the whole config, `[env]` values included.
- `collect_config_changes` (:458) diffs `Config::default()` against the user's config as serde_json, so new keys are reported automatically.
- `policy_for` (:511) summarises `env`, `projects` and `macros`.
- The exhaustiveness test is `config_diff_reports_every_leaf_of_the_default_config` (:1756, lead verified), with `SUMMARIZED_SUBTREES` (:1629) and `mutate_leaf` (:1669). It panics on a closed-set enum string with no candidate value (:1691) or on an empty map.
- **A secret such as `cloud.token` would print in clear.** It needs a `policy_for` arm, a `SUMMARIZED_SUBTREES` entry, and a test modelled on `config_diff_never_prints_a_global_env_value` (:1867).

### Reload classification (no central classifier)

- Restart-bound `[server]` keys are listed in `server_bind_settings_changed` (config.rs:1149): host, port, allowed_hosts, the ws caps, the file_drop caps, tree_list and release_notes. `server_console_settings_changed` (:1176) covers `color`. The rationale for which keys are live is at :1121-1148.
- There are two reload owners:
  - `crates/yaran-web/src/engine_actor.rs:2834-2900`, for `yaran server` and the flip. It computes `server_restart_warning_copy` (:462), calls `Engine::apply_reloaded_config` (engine/mod.rs:2466) and `retune_after_config_swap` (:2496), updates `LiveServerLimits` (:509), sends `config.changed`, and calls `TailscaleModeControl::set_mode_detached`.
  - The TUI's `apply_reloaded_config` (`crates/yaran-tui/src/app/mod.rs:6020`), for background serve. It applies `serve_while_tui` live (:6098-6100) and tailscale (:6106-6112). Its restart warning comes from `workers.rs:860-878`.
- Tests live at engine_actor.rs:5947-6151 and config.rs:6494-6518.
- `docs/RELOAD_DESIGN.md` is about binary hot-reload, not config reload.

### Env precedence

- `brand_env::var` / `var_os` (`crates/yaran-core/src/brand_env.rs:14`, :24; lead verified). `YARAN_X` wins when present, even if empty. Tested at :33.
- `YARAN_HOME` (config.rs:2598) and others go through it.
- **No config key has a `YARAN_*` override today.** That pattern would be new.

### Secrets

- There is no keyring and no token-file precedent. `gh` stores its own credentials (`gh.rs:1369`).
- The only existing pattern is literal values in `[env]` inside config.toml (0600), with `${VAR}` references recommended (website/docs/configuration.md:150-184).
- **Exposure if a token goes in config.toml:**
  - `GET /api/v1/config/raw` returns the file verbatim to any browser (`crates/yaran-web/src/config_routes.rs:415`).
  - `yaran config diff --raw` prints it.
  - The docs TIP says config is "safe to commit to git" (configuration.md:144).
- **`file_modes.rs` API:**
  - `PRIVATE_FILE_MODE=0o600` (:26) and `PRIVATE_DIR_MODE=0o700` (:31)
  - `restrict_to_owner(path)` (:57): clears group and other bits, skips symlinks, treats a missing path as Ok
  - `restrict_to_owner_best_effort(path, what)` (:90)
  - `create_private_dir_all(path)` (:112)
  - CLAUDE.md forbids chmod at call sites.

### Web Preferences

- Rows are `SETTING_GROUPS` in `crates/yaran-web/web/src/lib/settingsDescriptors.ts:92`. `server.tailscale` is at :366 with `writeTarget: "tailscale"`. A `.test.ts` pins the key set. `buildWrites` is at `CustomizeWebappDialog.tsx:427`.
- The generic patch is `PATCH /api/v1/config/settings` (config_routes.rs:62, :345) to `SettingsPatch` (wire.rs:734) to `Engine::set_settings` (wire.rs:2029).
- `[server]` keys use dedicated routes, for example `POST /api/v1/server/tailscale-mode` (:63, :467).
- Values must be mirrored on `BootstrapView` (`viewmodel.rs`, e.g. :330) and `Bootstrap` (`web/src/lib/bootstrapApi.ts:14`).

### Checklist for a new setting or section

1. `yaran-core/src/config.rs`: struct, `#[serde(default)]`, Default, the `Config` field, normalisation.
2. `config_migrate.rs`, only for renames.
3. `yaran-tui/src/config.rs`: a `config_schema()` entry with a full comment, plus an assert in `default_config_is_commented_and_complete`.
4. `config_write.rs` `apply_patches` (mandatory).
5. `cli.rs` diff policy, for secrets or closed-set enums.
6. Reload classification in **both** owners, plus `server_bind_settings_changed` if restart-bound. The config comment says which.
7. `BootstrapView` and `bootstrapApi.ts`, if the browser needs the value.
8. `settingsDescriptors.ts` and its test, a writeTarget and a dedicated route, if it belongs in Preferences.
9. `brand_env` for any env override.
10. `file_modes.rs` for any secret file.
11. Docs: a topic-page key table (e.g. `website/docs/server-mode.md:232`), configuration.md, README.
12. `tests/upgrade_config.rs` (schema-policy.md:84-106).

## 6. Docs

- **Frontmatter schema** (`website/src/content.config.ts:8-21`): `title`, `description`, `group` (default "Guides"), `order` (default 100).
- **Groups in sidebar order**:

  | Group | Pages (order) |
  |---|---|
  | Getting started | introduction (1), supported-agents (1.5), configuration (2), first-run-and-whats-new (3) |
  | Guides | creating-agents (10), agent-tabs (11), ordering-the-sidebar (12), macros (20), startup-commands (30), attention-indicators (35), terminal-capabilities (36), human-board (37), themes (40), custom-agents (50) |
  | Web UI | server-mode (60), web-workspace (61), web-editor (62), web-git (63), web-agents (64), tailscale (65), public-hosting (66), dropping-files (67) |
  | Reference | recommended-tools.mdx (90), faq (100) |

- **Pipeline.**
  - Astro uses a glob loader over `website/docs/**/*.{md,mdx}` (content.config.ts:9). Pages render at `/docs/<file>` via `src/pages/docs/[...slug].astro` and `DocsLayout.astro`.
  - `DocsSidebar.astro:2-32` sorts pages by order, then title. Groups sort by their lowest order, then name. Nothing is hardcoded.
  - Remark plugins: gemoji, admonitions, graphviz (```` ```dot ```` blocks). Rehype plugins: slug, autolink, prose-images (`astro.config.mjs:81-109`).
  - Search is Pagefind. A sitemap is built only when `YARAN_SITE_URL` is set (:36).
  - Website vitest covers `src/**/*.test.*` (vitest.config.ts:17). That includes `remark-admonitions.test.ts` and `docs-screenshots.test.ts`, which requires every PNG in `public/screens` to have a scene and a docs page; its allowlist must stay empty (:7-18).
- **Admonitions.** GitHub-style: `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` (`src/lib/remark-admonitions.mjs:2-4,21`). Example from tailscale.md:12-13: `> [!WARNING]` / `> This is the point where yaran stops being reachable only by you. **There is no login.**`
- **tailscale.md** (287 lines).
  - Sections: intro WARNING; What yaran actually does (:16); It follows the interface (:54); When Tailscale isn't there (:82); Serving from the TUI is loopback plus Tailscale (:99); Changing the mode while serving (:112); The MagicDNS gotcha (:135); Plain HTTP costs browser features (:165); Caveats (:201); Tailscale HTTPS proxy in front (:228); Where to go next (:280).
  - Tone: plain second person, frank about what has been tested ("documented from yaran's behaviour rather than from a tested recipe", :257-258).
  - Security: "There is no login, so routing is your only access control" (:204). Being on the tailnet should be treated like "holding a terminal on this machine" (:207-208).
  - Do not use Funnel (:225-226). The proxy must pass WebSockets and keep `Host` (:262-274).
- **server-mode.md** (366 lines).
  - Sections: intro IMPORTANT; Three ways to serve (:31); `yaran server` (:33); Stopping (:64); Restarting with a tab open (:75); Flip a running TUI (:86); Background serve (:103); The trust model, stated plainly (:185); The `[server]` config keys table (:232); Editing config from the browser (:339); Where to go next (:353).
  - Key quotes: "yaran is a single-tenant, trusted-access tool" (:187); "**There is no login. None.**" (:190-192); "Anything wider is on you… Put it behind a trusted reverse proxy or keep it on Tailscale" (:213-218).
- **public-hosting.md** (432 lines).
  - A worked recipe: Caddy, then oauth2-proxy with GitHub, then yaran with no published port.
  - Sections: The shape of it (:31, a dot diagram at :36); Before you start (:71); The Compose file (:100); The one line of yaran config (:224); Building the image (:243); What each piece is doing (:290); What this does not give you (:317); When it does not work (:340), with five failure subsections; Where to go next (:425).
  - Quotes: "There is no authentication layer in yaran at all" (:9). yaran reads no `X-Forwarded-*`, so the audit trail lives in the proxy (:328-331).
  - **The only cloudflared mention in the repo** (:333-338): "Do not use Tailscale Funnel, `ngrok`, `cloudflared` in its no-authentication mode, … A tunnel that skips that step has not made this easier, it has made it public."
- **README.** `### Server Mode` (README.md:315-337) covers how it binds (:327), "**And there is no login.**" (:329), safe shapes versus `0.0.0.0` (:331), and `allowed_hosts` (:333). The `## Documentation` list (:97, with public-hosting at :108).
- **Screenshot tooling.** See §8. `tools/preview-env/screens/reshoot.sh` runs all scenes, named scenes, or `--list`. There are 41 scenes in `screens/scenes/`, one per PNG.
  - Browser scenes export `{file, viewport, shoot(page)}`.
  - TUI journeys export `config`, `expectText`, `file` and `cols`.
  - Guard calls are mandatory.
- **Docs rules from CLAUDE.md.** Consumer facts only: no routes, wire or internals. Admonitions are reserved for what a skimmer must not miss. `website/` is updated in the same change. Stale screenshots are reshot.

## 7. Security docs

- **docs/operations/threat-model.md.**
  - Structure: an intro (:1-19), one `## Tn — <title>` section per threat, `---` separators, and `## Maintenance` (:1118).
  - Each threat has bold paragraphs: **Attack scenario.** / **Mitigation in code.** / **Residual risk.** / **Detection.** (T24 at :1078-1110).
  - **The last ID is `T24`**, "Claude Code's self-relaunch runs through a launcher yaran installs" (:1076; lead verified).
  - Rules: IDs are stable, new ones are appended, retired ones are struck through, accepted risks get a `Status:` line (:1124-1131).
  - Stale counts: "T1–T20" at :4 and "T1–T23" at :1124.
- **SECURITY.md.**
  - STRIDE table columns: `| # | Threat | STRIDE | Asset | Mitigation | Phase |` (:50). Rows run T1 (:52) to T24 (:75): T21 human board, T22 shared board folder, T23 board relay. The last row is T24 (claude-peers-launcher / `CLAUDE_CODE_PROCESS_WRAPPER`, STRIDE `T,E`, phase "claude-peers across restarts").
  - Reporting: email `siavash@kiani.fi`, no public issue before a fix, acknowledgement within 72 h (:8-13).
  - Trust model: single user on a single Linux account (:31-40). Scope at :79-87.
  - Rule: new egress or attack surface updates the table in the same PR (:158-162).
  - **Gap: neither file models the no-login web server, HTTP or Tailscale surface.**
- **encryption-at-rest.md.** An opt-in operator playbook for T5 (:3-4).
  - It explains why cloud-default disk encryption is insufficient (:27-35) and lists the data at risk: transcripts, `~/.agents`, AMQ queues, `sessions.sqlite3` (:42-51).
  - Option A is gocryptfs, recommended (:61). Option B is LUKS (:173).
  - It also covers performance, ops quirks such as preemption and backups (:245-290), and a GDPR Art. 32 note (:318).
- **schema-policy.md.**
  - There are no migration files and no `user_version`. An idempotent `migrate()` runs on every open (:19-32).
  - A new column goes into both `create table if not exists` and `ensure_column` (:36-38). It must be nullable or defaulted with a safe default (:39-43). Never reuse a dropped name (:44-45).
  - **Each workstream appends its own commented block at the end of `migrate()`** and never edits another's (:47-53).
  - Constraint changes use a transactional, idempotent table rebuild (:55-62). Never rename; deprecate for one release first (:64-68).
  - `upgrade_database.rs` must prove that the open succeeds, rows survive, defaults and backfills apply, and a second open is a no-op (:70-78).
  - Config changes need `#[serde(default)]`, `config_migrate.rs` and `tests/upgrade_config.rs` (:84-106). Checklist at :108-116.
- **rebranding.md.**
  - `YARAN_HOME` comes first, then `DUX_HOME` only if `YARAN_HOME` is absent. An empty or relative `YARAN_HOME` is an error (:11).
  - Other `YARAN_*` variables follow the same new-first rule, and children get both aliases (:18).
  - Durable names that must not be renamed: `dux.lock` (:16), the `dux-amq` AMQ namespace and `*_AMQ_QUEUE_DIR` (:24), `.dux-amq-source` (:25), worktree links and excludes (:26), `.dux/uploads` (:27), `dux.log` (:28), the `dux_dark` aliases (:29), legacy browser storage keys (:31), published `dux-amq-v*` tags (:39). The old repo redirect must not be recreated (:45).
  - No public website origin exists. `YARAN_SITE_URL` stays unset (:56).
- **Keyword sweep** (excluding node_modules, target and dist):
  - `cloudflare`/`cloudflared`: only public-hosting.md:334.
  - "tunnel": public-hosting.md:209 and :337.
  - push notification, APNs, `yaran login`: none. FCM: only base64 noise in lockfiles.
  - android/ios: all about the mobile browser or UA parsing (`yaran-core/src/device_label.rs:35-39`, `web/src/lib/deviceLabel.ts:12-13`, `App.tsx:252`, `TerminalPane.tsx:333`).

## 8. Testing conventions

- **Rust integration tests.**
  - `crates/yaran-core/tests/` has 19 files, including `upgrade_database.rs`, `upgrade_config.rs`, `upgrade_shared_workspace.rs`, `storage_migrations.rs`, `pty_integration.rs`, `reload_handoff_e2e.rs`, `build_compat.rs` and `fixtures/`.
  - `crates/yaran-web/tests/` has 19 route and transport files (e.g. `ws_transport.rs`, `static_serving.rs`, `live_server_limits.rs`).
  - `crates/yaran/tests/` has 5 (`peer_cli.rs`, `version_flag.rs`, `jcode_*_acceptance.rs`, `overlay_config.rs`).
  - yaran-tui tests are inline.
- **upgrade_database.rs.**
  - The `//!` header at :1-41 states the strategy.
  - Old schemas are **transcribed from real commits**: `FIRST_RELEASE_SCHEMA` from `ed917a4` (:50-74), `PROJECTS_ERA_SCHEMA` from `a4f628b` (:76-132), and `FORK_SCHEMA_6` (:1035). The sibling `upgrade_shared_workspace.rs:27-28` uses `include_str!` on `fixtures/fork_main_schema/*.sql`.
  - The builders `first_release_database()` / `old_database()` (:156-186) use a tempdir, `execute_batch` and raw seed rows.
  - Assertions (:204-1197) cover: rows survive, defaults, backfills, empty new tables, write/close/reopen, every added column nullable or defaulted (:850), and a second open as a no-op (:950).
  - Test names are full snake_case sentences.
- **Web.**
  - Vitest 4 with jsdom and @testing-library/react. Setup is in `src/testSetup.ts`.
  - 286 colocated `*.test.ts(x)` files. Helpers live in `src/test/`.
  - ESLint. Both are CI-gated (pr.yml:163-215).
  - The website has its own vitest.
- **E2E.** There is no Playwright suite. UI driving uses puppeteer-core through `tools/preview-env`.
- **tools/preview-env.**
  - Docker-only, mandatory per CLAUDE.md. A host-built binary is mounted read-only. State lives in named volumes under `YARAN_HOME=/data/yaran`. There is a `fake-agent.sh` streaming provider and seeded repos (README.md:17-33).
  - `up.sh` (with `--restart`) brings it up.
  - `shot.sh` captures desktop at 1440×900 or `--mobile` at 390×844, both at 2× (:91-117).
  - `tui-shot.sh` and `tui-driver.js` run TUI journeys (:147-201).
  - `screens/reshoot.sh` and `screens/seed.js` handle reshoots. Fixtures load only under `YARAN_SCREENS=1` (:203-246).
  - Guards such as `expectPanePainted` refuse a bad capture (:251-274).
  - `up.sh` refuses a Mac host; a Mac needs an in-container arm64 build (:301-310).

## 9. Licensing

- **LICENSE** is MIT, "Copyright (c) 2026 Patrick D'appollonio" (LICENSE:1-3; lead verified). There are no NOTICE, THIRD_PARTY or COPYING files.
- **deny.toml license allowlist** (:70-96): MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-DFS-2016, Unicode-3.0, MPL-2.0, CC0-1.0, 0BSD, OFL-1.1, Bitstream-Vera, BSL-1.0, CDLA-Permissive-2.0.
  - Confidence is 0.8, with no exceptions and `private = { ignore = true }`.
- **Other deny.toml sections.**
  - Advisories: `yanked = "deny"`. Two ignores, RUSTSEC-2025-0141 (bincode) and RUSTSEC-2024-0384 (instant), both with "next review 2026-08-01", which is **overdue**. The same ignores are duplicated in pr.yml:327-329.
  - Bans: `multiple-versions = warn`, `wildcards = deny`.
  - Sources: crates.io only, `allow-git = []`.
- **Scope.** The policy applies to cargo only. **No npm license or audit gate exists in any workflow.**
- **Fit for the new feature.** Apache-2.0, which covers cloudflared, is on the allowlist. But cloudflared is a separate Go binary, not a crate, so deny.toml would never see it. Bundling or redistributing it would need a NOTICE/attribution file, which the repo lacks.

---

## Implications for adding Worker and mobile subprojects

1. **Placement.**
   - Top-level `cloud/worker/` and `mobile/{android,ios}/` fit the existing pattern of self-contained non-Rust trees (`website/`, `npm/`, `yaran-amq/`, `tools/preview-env/`). They stay out of the Cargo workspace.
   - The Worker should use **npm with lockfile v3** and `npm ci`, matching all four existing package.json files.
   - Add an `.nvmrc` or `engines` field deliberately. The repo has none, and CI mixes Node 22 and 24.
   - The `docs/plans/phoneapp/` folder already exists and is empty, so the plan can go there. Alternatively create `docs/plans/cloud/`.
2. **CI.**
   - Give each subproject one workflow modelled on website-ci.yml: path filters that include the workflow file itself, `concurrency` with cancel-in-progress, `permissions: contents: read`, SHA-pinned actions with `# vX.Y.Z` comments, `setup-node cache: npm`, and secrets withheld from fork PRs.
   - Wrangler deploys and store uploads belong only on main or tags, or behind `workflow_dispatch` with environment protection.
   - **Path-filtered workflows cannot be required checks** (a skipped required check blocks merging). Either leave them unrequired like website-ci, or add an always-reporting aggregator. Update BRANCH_PROTECTION.md either way.
   - iOS needs macOS runners. Precedent exists: `Test (macos-14)` runs on macos-latest.
3. **Release.**
   - **Do not extend release.yml.** It triggers on `yaran-v*`, hard-requires exactly 4 checksum lines (:328), and owns the binary pipeline.
   - Use separate tag prefixes and workflows, for example `worker-vX.Y.Z` and `mobile-vX.Y.Z`. Add the new prefixes to the tag protection list in BRANCH_PROTECTION.md:45.
   - Reuse `actions/attest-build-provenance` and the SHA256SUMS pattern for the GitHub Releases APK. The current release step does no signing, while an APK must be signed. Keystore and Apple secrets are new territory.
   - F-Droid needs reproducible builds from source. The repo's reproducible-tar precedent (release.yml:189-209) shows the mindset; Gradle reproducibility is separate work.
   - If the cloud leg means yaran ships or downloads `cloudflared`, add an Apache-2.0 NOTICE. Treat the download like install.sh's checksum path, but make a missing checksum **fatal**; install.sh only warns.
4. **Supply chain.**
   - Add dependabot entries: `npm` for `/cloud/worker`, `gradle` for `/mobile/android`, `swift` for `/mobile/ios` if SPM is used.
   - Add CODEOWNERS lines for the new paths, including the deploy workflows and any `wrangler.toml`.
   - There is no npm or Gradle license or audit gate today. Decide on one, for example `npm audit --omit=dev` plus a license checker, and record it in BRANCH_PROTECTION.md.
   - deny.toml covers only the Rust side of `yaran login`.
5. **Config (Rust cloud leg).**
   - A new `[cloud]` section touches the 11-point checklist in §5.
   - **Do not store tokens in config.toml.** `GET /api/v1/config/raw`, `diff --raw` and the "safe to commit" docs TIP would all leak them.
   - Put credentials in a separate owner-only file under the config root via `file_modes.rs`. This would be the first one; there is no precedent.
   - Add a diff `policy_for` summary plus a never-prints test.
   - Classify each key live versus restart-bound in **both** reload owners (engine_actor.rs:2834 and tui app/mod.rs:6020). Supervising `cloudflared` resembles the Tailscale leg (`TailscaleModeControl`, a tri-state, a watcher thread with a bounded probe), which is the obvious model to copy.
   - Any `YARAN_*` env override would be a new pattern. Read it through `brand_env`. A new feature needs no `DUX_*` fallback (inference).
6. **Schema.** Any device or account rows go in a new appended workstream block in `SessionStore::migrate()` with `ensure_column`, plus an `upgrade_database.rs` case.
7. **Docs.**
   - Add new pages via frontmatter only. Cloud remote access fits group "Web UI" at about order 66.5 (next to public-hosting). Mobile apps could go in a new "Mobile" group at order 70-89, before Reference (90).
   - **Pages that become false and must be edited in the same change:**
     - server-mode.md:190-192 ("There is no login. None.")
     - public-hosting.md:9-11 and the cloudflared caution at :333-338
     - README.md:329-331
     - SECURITY.md trust model (:31-40) and scope (:79-87)
     - tailscale.md:204
   - Any screenshot needs a scene in `tools/preview-env/screens/scenes/`, or `docs-screenshots.test.ts` fails. preview-env has a 390×844 mobile preset, but it cannot screenshot native apps.
   - The CLAUDE.md "Do not invent a deployed domain" rule applies to the Worker URL. Docs should describe a self-deployed `*.workers.dev` or custom domain as the user's own.
8. **Threat model.**
   - Append starting at **T25**, both as a `## T25 — …` section with the four bold paragraphs and as a SECURITY.md row (`| T25 | … | STRIDE | Asset | Mitigation | Phase |`).
   - Candidate threats:
     - The never-modelled no-login web surface, which now becomes internet-adjacent
     - Worker or control-plane compromise and tenant confusion
     - `yaran login` token theft or replay, and token storage at rest (link encryption-at-rest.md)
     - The cloudflared binary supply chain
     - Mobile pairing and session hijack
     - Push payload leakage through APNs/FCM, plus push abuse
   - Fix the stale "T1–T20" / "T1–T23" counts while there.
9. **Plan docs.**
   - Use the rustport format: the `# Phase NN — title` header and the two bold `Track · Parallel-safe with` / `Depends on · Blocks` lines; Goal, Evidence (`file:line`), In/Out of scope, numbered Work items, `- [ ]` Acceptance, bash Validation, a Risks table, References. Add a README with a track tree, dependency edges and a baseline, plus a CONVENTIONS.md.
   - **Do not cite the 500-line gate or the module-tree generator as existing.** Either schedule them explicitly or rely on the real gates.
   - The practised header convention is prose `//!` (Rust) and `//` (TS) purpose, contract and threading comments. `# Uses` trees are not used.
   - New TS and Kotlin/Swift code should follow the prose-header style.

UNVERIFIED or not checked:
- GitHub repo settings and actual branch protection
- Whether any `yaran-v*` release exists
- Whether `tools/preview-env/node_modules` is tracked
- The content of the 21 rustport phases beyond headers and the section census
- `ensure_config` first-boot resolution
- `buildWrites` internals

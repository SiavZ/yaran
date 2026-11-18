# Phase 01 — Conventions and enforcement tooling

**Track:** Wave A (foundation) · **Parallel-safe with:** 02, 03
**Depends on:** nothing · **Blocks:** every Wave B PR (each must pass `module-headers --check`), 18 (adds its suites to the aggregator built here)

## Goal

Make `00-CONVENTIONS.md` §1.1, §1.2 and §2 enforced by a machine instead of by reviewers.
That means three things:

1. A tool that **generates and checks** the `<module-headers:begin>`/`<module-headers:end>`
   block (Uses / Used by trees) in every in-scope file, in all five languages this plan uses.
2. A **500-line gate** that fails outright on new files and holds the files that are already
   oversize to their current size.
3. A **required aggregator check** that always reports, so path-filtered suites (the
   cloud, mobile and header gates) can block merges without blocking PRs they skip.

## Evidence

All verified against the current tree on 2026-11-14 unless marked otherwise.

- **Nothing exists yet.** There is no `ci/`, no `xtask/`, no pre-commit configuration
  (`.pre-commit-config.yaml`, `.githooks/`, `lefthook.yml` and `.husky` are all absent), and
  `git grep` finds no `module-headers` marker and no `# Uses` line anywhere. The rustport
  phase that planned this (`docs/plans/rustport/02-ci-gates-and-modularity-enforcement.md:70-129`)
  was never built (research/R3-repo-process.md:109-131).
- **Precedent for tools.** `tools/` holds POSIX `sh` scripts (`tools/reload-live-check.sh:1`)
  and a Node tree (`tools/preview-env/package.json:5-8`, with a tracked `package-lock.json`
  and an untracked `node_modules`, `.gitignore:1`). There is no Rust dev-tool crate in the
  workspace (`Cargo.toml:2-7`). Every package in the repo uses npm with lockfile v3
  (research/R3-repo-process.md:12).
- **Node.** `CONTRIBUTING.md:12` requires "Node 22.12 or newer". CI uses Node 22 in `pr.yml`
  and Node 24 in `website-ci.yml` (research/R3-repo-process.md:21-25). On Node 22.12 to 22.17
  a `.ts` file only runs with `--experimental-strip-types`; type stripping is on by default
  from 22.18 (https://nodejs.org/api/typescript.html, read 2026-11-14). So the tool is
  written as plain ESM `.mjs` with JSDoc types and typechecked by `tsc --checkJs`.
- **TypeScript.** `crates/yaran-web/web/package.json:58` pins `typescript ~6.0.2`, which
  resolves to 6.0.3 (`package-lock.json:9411`). The web tsconfig maps `"@/*": ["./src/*"]`
  (`crates/yaran-web/web/tsconfig.json:8`, `tsconfig.app.json:4`). The website maps `@/*`
  into the web UI's source (`website/tsconfig.json:12`). TypeScript 7.0 (2026-07-08) "does
  not ship with an API": the 7.0.2 tarball's `"."` export only exports `version`
  (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/). TS 6.0 stays
  API-compatible with 5.9 (https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).
  So the tool pins **exactly `typescript@6.0.3`** for its compiler API. This is also the
  plan-wide TypeScript pin (R21): every new package this plan creates (`cloud/protocol`,
  `cloud/worker`, `cloud/push-relay`, `mobile/app`, `mobile/plugins/*`, `packages/ui-kit`)
  pins `typescript@6.0.3` exactly, as Phase 02 already does. The existing web UI keeps its
  `~6.0.2` range, which resolves to the same 6.0.3, and is not changed by this plan.
- **Local packages.** `cloud/protocol` (Phase 02) and `packages/ui-kit` (Phase 14, R18: the
  one shared tokens and components package for the web UI, the app shell and the Worker
  console) are consumed through npm `file:` dependencies (`"@yaran/protocol":
  "file:../protocol"`, `"@yaran/ui-kit": "file:../../../packages/ui-kit"`). The repo has no
  npm workspaces (Phase 14 Evidence). `main` never holds a vendored copy of the protocol: the
  self-contained bundle exists only on the generated `cloud-deploy` branch (D18, R4).
- **Parsers.** `web-tree-sitter` 0.27.2 (MIT, 2026-11-07) was checked on 2026-11-14 with the
  grammar `.wasm` files loaded and a sample parsed. `tree-sitter-rust` 0.24.0 (npm),
  `tree-sitter-bash` 0.25.1 (npm) and `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0 (npm)
  ship working wasm. The npm `tree-sitter-swift` 0.7.1 ships no wasm, but the GitHub release
  0.7.3 asset (2026-06-01) loads. The `tree-sitter-wasms` 0.1.13 bundle fails to load in
  0.27.2, so it is not used.
- **Rust module rules** a resolver must follow: `mod foo;` loads `foo.rs` or `foo/mod.rs`;
  non-mod-rs files nest children in a directory named after the file; `#[path]` resolves
  differently inside inline module blocks
  (https://doc.rust-lang.org/reference/items/modules.html).
- **Oversize files today** (tracked, counted with `wc -l`): 127 of 285 `.rs`, 25 of 428
  `.ts`, 31 of 237 `.tsx`, 1 of 53 `.js` (`tools/preview-env/screens/lib.js`, 963), 2 of 20
  `.sh`, plus the extensionless bash script `yaran-amq/scripts/yaran-amq-doctor` (860) and
  three `.bats` files (503-531). The largest is `crates/yaran-tui/src/app/input.rs` (39,165).
  So a gate without a baseline would fail every PR.
- **CI and protection.** The live protection (`gh api repos/SiavZ/yaran/branches/main/protection`,
  read 2026-11-14) requires `Security`, `Test (macos-14)`, `Test (ubuntu-24.04)` and `shell`,
  with `strict: true` and `enforce_admins: false`. This matches
  `.github/BRANCH_PROTECTION.md:14-29`. The required jobs carry a `BRANCH-PROTECTION CONTRACT`
  comment (`BRANCH_PROTECTION.md:18-19`). `website-ci.yml:6-29` is path-filtered and is
  deliberately not required.
- **Skipped required checks block merges.** A workflow skipped by a `paths` filter leaves its
  check "Pending". A job skipped by `if:` reports success
  (https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks,
  read 2026-11-14). The standard aggregator is `dorny/paths-filter` v4.0.3
  (`ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d`) plus `re-actors/alls-green` v1.3.0
  (`b5b5b37504aa4183270bd3d855c52a67f212be35`).
- **Header style in practice.** Prose `//!` in Rust (`crates/yaran-core/src/lib.rs:1-4`), `//`
  prose in TS (`crates/yaran-web/web/src/lib/notify.ts:1-8`), and `#` after the shebang in
  shell (`tools/reload-live-check.sh:1-12`; `yaran-amq/scripts/yaran-amq-doctor:2` puts a
  `# shellcheck` directive first). The tool leaves all of that prose alone and only rewrites
  its own delimited block.
- **Supply-chain conventions** the workflow must follow: every action is pinned to a full SHA
  with a `# vX.Y.Z` comment, top-level `permissions` are declared, and setup-node uses
  `cache: npm` (research/R3-repo-process.md:45-49). `CODEOWNERS:8` is `* @SiavZ`, with
  `:23-24` covering `.github/workflows/` and `.github/scripts/`. The Makefile already has
  "local mirror of CI" targets (`Makefile:9-13`, `:22-35`).

## In scope

- The `tools/module-headers/` Node tool: header generation, `--check`, the 500-line gate and
  its ratchet baseline.
- The scope manifest: the new subproject roots plus an opt-in list of existing files.
- `.github/workflows/gates.yml`, carrying the header and line jobs and the always-reporting
  `Required gates` aggregator, with a documented seam for later suites.
- Updates to `BRANCH_PROTECTION.md` and `CODEOWNERS`, Makefile targets, an optional pre-commit
  hook, and contributor docs.
- Tests for the tool, run against fixture repositories.

## Out of scope

- The cloud and mobile CI suites themselves, and their release workflows. Phase 18 adds them
  as reusable workflows called from `gates.yml`.
- Writing headers into Wave B files. Each Wave B phase does that for the files it creates or
  touches, and its PR passes `--check`.
- Splitting existing oversize files. That is not part of this product (`00-CONVENTIONS.md`
  §1.2).
- Turning on `enforce_admins`. That is a repository-policy decision for the owner and is
  noted under Risks.

## Design

### Runtime and parsers

| Language | Files | Parser | What counts as an edge |
|---|---|---|---|
| Rust | `*.rs` | tree-sitter-rust (wasm) plus a hand-written module resolver that follows the Rust Reference rules, `#[path]` included | `mod x;`, `use` trees (`crate::`, `self::`, `super::`, `yaran_core::`, `yaran_web::` and so on, globs included), and fully qualified paths in expressions (`crate::cloud::leg::start()`). A path resolves by its longest module prefix that maps to a file. Crate names map through each workspace member's `Cargo.toml` (`yaran-core` to `yaran_core` to `crates/yaran-core/src/lib.rs`). |
| TS/TSX/JS | `*.ts *.tsx *.mts *.cts *.js *.mjs *.cjs` | TypeScript 6 compiler API: `ts.preProcessFile` for import, export-from, dynamic `import()` and `require`, then `ts.resolveModuleName` with the nearest `tsconfig.json` (`paths` honored, `bundler` resolution) | Only resolved first-party files. A bare specifier that names a `file:` dependency in the importer's nearest `package.json` (`@yaran/protocol`, `@yaran/ui-kit`) resolves through that package's `exports` map (conditions `types`, `import`, `default`) to its tracked source, so it is a first-party edge and needs no `npm ci` in the consumer; the node renders as `<package>:<path>` (`@yaran/protocol:src/sig/canonical.ts`). Every other bare specifier goes in `External`. |
| Kotlin | `*.kt *.kts` | tree-sitter-kotlin | `import a.b.C` resolves to the file declaring top-level `C` in package `a.b` (package directories plus a declaration index). Same-package references with no import are **inferred**: an identifier that matches a sibling file's top-level declaration. |
| Swift | `*.swift` | tree-sitter-swift (wasm fetched from the pinned GitHub release, SHA-256 checked) | `import Module` goes to `External`, or to a first-party module named by its SwiftPM/Xcode target directory. Same-module references are **inferred** from a top-level type, function and extension index, because Swift files in one module see each other without imports. |
| Shell | `*.sh *.bash *.bats`, plus extensionless files with a `sh`/`bash` shebang | tree-sitter-bash | `source F` and `. F` with a literal or `$(dirname "$0")`-relative path. Dynamic paths are reported as `unresolved` in the block, not dropped silently. |

**Honest limits** go in the tool's README section of the contributor doc and in each
generated block. Kotlin and Swift "Uses" entries that came from name matching are rendered
with an `(inferred)` suffix. Name collisions can over-report, and an extension-only use can
be missed. The block is still checked, so drift is still caught. Shell edges with a computed
path are listed as `unresolved: <expr>`.

### The generated block

- It sits inside the file's leading header comment, in that language's syntax (`//!` for
  Rust, `/** */` for TS and Kotlin, `///` for Swift, `#` for shell). The markers are exactly
  `<module-headers:begin>` and `<module-headers:end>`.
- Content: `Uses:` tree, an `External:` line (sorted, de-duplicated), and a `Used by:` tree.
  Node names are Rust module paths (`cloud::credentials`, and `yaran-web::serve_loop` across
  crates), TS paths relative to the subproject root, Kotlin fully qualified names, Swift
  `Module/File` and shell repo-relative paths.
- **Annotations survive.** A trailing `(…)` on a tree line is hand-written. On regeneration it
  is kept, keyed by the node name.
- **Entry points.** A file with no importers must be listed in `scope.json` `entryPoints`
  with a launch description. It then renders `Used by: entry point (<description>)`. An
  unlisted file with no importers fails `--check` as an orphan, which is the
  `cargo modules orphans` check generalized to every language.
- **Header prose is required but not generated.** `--check` also fails if the comment before
  the block has no title line, or if the block is missing from an in-scope file.

### Scope

`tools/module-headers/scope.json`:

```json
{
  "roots": ["cloud/**", "mobile/**", "packages/**", "tools/module-headers/**",
            "crates/yaran-core/src/cloud/**", "crates/yaran-web/src/cloud_*.rs",
            "crates/yaran-web/web/src/lib/native/**"],
  "optIn": [],
  "exclude": ["**/generated/**", "**/fixtures/**", "**/node_modules/**", "mobile/ios/Pods/**"],
  "entryPoints": {}
}
```

- The graph is always built over **every** tracked file of a language, so a new file's
  `Used by` names importers outside scope (for example `engine/mod.rs` using
  `cloud::emitter`). Only in-scope files are written or checked.
- Every Wave B PR that touches an existing file adds it to `optIn` in the same PR. Files are
  never removed from `optIn`.
- `packages/**` covers `packages/ui-kit/` (R18). The web UI files Phase 14 moves there with
  `git mv` enter scope in that PR and get their headers there; a moved file over 500 lines is
  a rename under the ratchet below, so it needs `--accept-growth` with a reason.
- The generated `cloud-deploy` branch (D18) is never checked. `gates.yml` runs only on PRs and
  `main`, Phase 18's `yaran-cloud-v*` workflow pushes that branch, and its bundled protocol
  copy is a build artifact. There is no vendored copy on `main`, so there is no protocol
  drift check to run (R4).

### The 500-line gate and its ratchet

- **What it counts:** tracked code files (the extensions above, extensionless shebang
  scripts, and `.github/workflows/*.yml`), every line included. Exempt: lockfiles, `*.d.ts`
  files carrying a vendored marker, and files whose first 5 lines contain `@generated`.
  Generated files are marked that way by their generators (Phase 02's types, for instance).
- **New file over 500 lines:** hard fail. No opt-out directive exists.
- **Baselined files:** `tools/module-headers/baseline-oversize.json` records
  `{ "<path>": { "lines": N, "reason": "baseline 2026-11-14" } }` for every file over 500 on
  the day this lands (about 190 entries).
  - A file may never exceed its recorded `lines`.
  - Minimal wiring (`00-CONVENTIONS.md` §1.2) is allowed only by running
    `module-headers --accept-growth <path> --reason "<phase NN: why>"`. That raises `lines`
    and appends the reason, so the growth shows up as a reviewed diff to a CODEOWNERS-guarded
    file. This is how "may not grow" and "minimal wiring" coexist without a silent allowance.
  - `--write` lowers `lines` automatically when a file shrinks, and drops entries for files
    that are gone or now at or under 500. `--check` fails if an entry's file no longer exists,
    so the baseline cannot rot.
  - A renamed baselined file counts as new. Re-baselining it needs `--accept-growth` with a
    reason.

### CI: one always-running workflow with one required check

`.github/workflows/gates.yml` has no `paths` filter and runs on `pull_request` and on pushes
to `main`. Its jobs:

1. `changes`: `dorny/paths-filter` (SHA-pinned) publishes `headers` plus the suite filters.
   Because consumers import local packages by `file:` dependency, a package's filter includes
   the packages it imports:
   - `protocol`: `cloud/protocol/**`, `crates/yaran-core/src/cloud/**` (Phase 02's
     `cloud-protocol.yml`);
   - `cloud`: `cloud/**`, `packages/ui-kit/**` (the Worker console uses the kit);
   - `mobile`: `mobile/**`, `cloud/protocol/**`, `packages/ui-kit/**`;
   - `ui-kit`: `packages/ui-kit/**` (the kit's own suite, commands from Phase 14).
2. `Module headers` (`if: needs.changes.outputs.headers == 'true'`): `npm ci` in
   `tools/module-headers`, then `fetch-grammars`, then `module-headers --check`. The `headers`
   filter is "any code file", because a change anywhere can alter a `Used by` tree.
3. `File length`: `module-headers --lines --check`, which runs on every PR and is cheap.
4. Seam for later suites: a `protocol` job that `uses: ./.github/workflows/cloud-protocol.yml`
   (Phase 02 WI-11), and `cloud`, `mobile` and `ui-kit` jobs that use Phase 18's
   `cloud-ci.yml`, `mobile-ci.yml` and the kit's suite (`on: workflow_call`), each gated on its
   filter output. Phase 01 ships the seam as a commented, documented block; Phases 02 and 18
   fill it in.
5. `Required gates`: `if: always()`, `needs:` every job above, running `re-actors/alls-green`
   with `jobs: ${{ toJSON(needs) }}` and `allowed-skips` listing the gated jobs. **This one
   context is added to branch protection.** It carries the `BRANCH-PROTECTION CONTRACT`
   comment.

Workflow conventions: top-level `permissions: contents: read`, a `concurrency` group with
cancel-in-progress, actions pinned by SHA with `# vX.Y.Z`, `setup-node` with `cache: npm` and
`cache-dependency-path: tools/module-headers/package-lock.json`. The Node version is `22` until
Phase 18 adds the root `.node-version` (Node 24); Phase 18 then switches `gates.yml` to
`node-version-file: .node-version` when it fills the seam, like every new workflow.

## Work items

Every file planned below is at most 500 lines and carries the §2 header with a generated
block. The tool checks itself, since `tools/module-headers/**` is in scope.

1. **Package skeleton.**
   - Create: `tools/module-headers/package.json` (private, `"type": "module"`,
     `engines.node: ">=22.12"`, scripts `check`, `write`, `lines`, `test`, `typecheck`,
     `fetch-grammars`); `package-lock.json`; `tsconfig.json` (`allowJs`, `checkJs`, `strict`,
     `noEmit`); `.gitignore` (`node_modules/`, `.grammars/`).
   - Dependencies, pinned exactly: `typescript@6.0.3`, `web-tree-sitter@0.27.2`,
     `tree-sitter-rust@0.24.0`, `tree-sitter-bash@0.25.1`,
     `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`. All are MIT. Tests use Node's built-in
     `node:test` and `node:assert`, so no test framework is added.
   - Reuse: npm lockfile v3 convention (research/R3-repo-process.md:12).
2. **Grammar loader.**
   - Create `src/parsers.mjs`, which loads wasm grammars from `node_modules` and `.grammars/`
     and exposes a `parse(lang, text)` that returns a tree.
   - Create `scripts/fetch-grammars.mjs`, which downloads
     `tree-sitter-swift.wasm` from the alex-pinkus release `0.7.3`, verifies it against a
     SHA-256 constant in the script, and **fails closed** on a mismatch or a missing checksum.
     It is idempotent and uses the cache.
   - Tests: `test/parsers.test.mjs` (each grammar parses a fixture; a corrupted wasm is
     refused).
3. **File enumeration and language detection.**
   - Create `src/files.mjs`, which reads `git ls-files -z`, detects languages by extension and
     by shebang, and applies the exempt rules.
   - Create `src/config.mjs`, which loads and validates `scope.json` and the baseline file and
     matches globs (a small glob-to-regex function; no dependency).
   - Tests: `test/files.test.mjs` (shebang detection, `@generated` exemption, glob matching).
4. **Graph model.**
   - Create `src/graph.mjs`, holding nodes with display names and edges with an `inferred`
     flag. It builds reverse edges and computes the `Uses` and `Used by` sets.
   - Tests: `test/graph.test.mjs`.
5. **Rust frontend.**
   - Create `src/lang/rust-modules.mjs`: module-path-to-file resolution covering mod-rs versus
     non-mod-rs files, `#[path]` at top level and inside inline blocks, and crate-root
     mapping from workspace `Cargo.toml` files.
   - Create `src/lang/rust.mjs`: extracts `mod`, `use` trees (globs, groups, renames) and
     qualified paths.
   - Tests: `test/rust.test.mjs` against `test/fixtures/rust-ws/`, a two-crate workspace with
     `foo.rs` and `foo/mod.rs` forms, a nested non-mod-rs file, both `#[path]` cases, a
     cross-crate `use yaran_core::…`, `use super::*`, and a `crate::a::b::f()` call with no
     `use`.
6. **TypeScript frontend.**
   - Create `src/lang/typescript.mjs`: finds the nearest tsconfig, then `preProcessFile` and
     `resolveModuleName`.
   - Tests: `test/typescript.test.mjs` against `test/fixtures/ts-paths/` (an `@/*` alias as in
     the web UI, `export * from`, a dynamic import, a `.tsx` importer, a type-only import, a
     bare package specifier that becomes External, and a `file:` dependency on a sibling
     package with an `exports` source map, as `@yaran/ui-kit` and `@yaran/protocol` use, that
     resolves first-party with no `node_modules` present).
7. **Kotlin, Swift and shell frontends.**
   - Create `src/lang/kotlin.mjs`, `src/lang/swift.mjs` and `src/lang/shell.mjs`.
   - Tests: `test/kotlin.test.mjs`, `test/swift.test.mjs` and `test/shell.test.mjs` against
     fixtures. They pin the inferred-edge behavior, the collision over-report (asserted, so a
     future fix is visible) and the unresolved shell path.
8. **Block rendering and rewriting.**
   - Create `src/render.mjs`: draws trees with `├──`/`└──`, sorts deterministically, keeps
     annotations, and renders entry points and orphans.
   - Create `src/block.mjs`: per-language comment syntax, locating and inserting the block,
     header-prose presence checks, the Kotlin rule (the block goes in the KDoc before
     `package`), and the shell rule (after the shebang and any `# shellcheck` directive).
   - Tests: `test/block.test.mjs` with golden files for each language, idempotence (running
     `--write` twice gives no diff), and annotation preservation.
9. **Line gate.**
   - Create `src/lines.mjs`: counting, the new-file hard fail, the baseline ratchet,
     `--accept-growth` and automatic tightening.
   - Create `baseline-oversize.json`, generated by `--init-baseline` on the landing commit and
     committed.
   - Tests: `test/lines.test.mjs` (a new file at 501 fails; a baselined file growing by 1
     fails; `--accept-growth` passes and records the reason; a shrink tightens; a stale entry
     fails; a rename counts as new).
10. **CLI.**
    - Create `bin/module-headers.mjs` as the entry point, run as `node
      tools/module-headers/bin/module-headers.mjs [<path>…]`. Optional positional paths limit
      which in-scope files are written or checked (the graph is still built over every tracked
      file), so a phase can run `--check cloud/worker`. Flags: `--write`, `--check`, `--lines`,
      `--accept-growth <path> --reason <text>`, `--init-baseline`, `--explain <path>` (prints
      that file's edges), `--json`. Exit codes: 0 ok, 1 drift or violation, 2 usage or
      internal error.
    - Output names the file, the rule, and the exact command that fixes it.
    - Tests: `test/cli.test.mjs`, which runs the bin against a temporary git repo copied from
      `test/fixtures/mixed/` and asserts exit codes and output.
11. **Make it run in CI.**
    - Create `.github/workflows/gates.yml` as designed.
    - Touch `.github/BRANCH_PROTECTION.md`:
      - add `Required gates` to the required list at `:14-29`, with the contract comment;
      - state that path-filtered suites join through `gates.yml` and are never required
        directly;
      - fix the stale macOS `cargo test` note (research/R3-repo-process.md:68);
      - add the apply command for `Required gates` to the recipe at `:61-76`.
    - Touch `.github/CODEOWNERS`, adding `tools/module-headers/` and
      `tools/module-headers/baseline-oversize.json` explicitly next to `:22-29`.
    - Touch `.github/dependabot.yml`, adding an `npm` entry for `/tools/module-headers` that
      follows the `:34-42` shape.
12. **Local use and pre-commit.**
    - Touch `Makefile`, adding `headers` (write), `headers-check` and `lines-check` beside the
      existing mirror-of-CI targets (`Makefile:9-13`).
    - Create `tools/module-headers/pre-commit.sh` (POSIX sh). It runs `--check` limited to
      staged in-scope files plus the line gate. Enable it with `git config core.hooksPath
      tools/module-headers/hooks`. Also create `tools/module-headers/hooks/pre-commit`, which
      execs the script. The hook is opt-in; CI is the gate.
    - Create `docs/contributing/module-headers.md`: what the block is, how to run each
      command, how to add a file to `optIn` and an entry point, `--accept-growth` etiquette,
      the honest per-language limits, and enabling the hook.
    - Touch `CONTRIBUTING.md`: one paragraph after `:163-169` linking to it.
13. **Self-application.** Every file under `tools/module-headers/` carries its header, and
    `module-headers --check` passes on the repo at the landing commit.

## Acceptance

- [ ] `npm ci && npm run fetch-grammars && npm test && npm run typecheck` pass in
      `tools/module-headers` on Node 22.12 and Node 24.
- [ ] `module-headers --check` exits 0 on the landing commit and exits 1, naming the file and
      the fix command, for each of: a missing block, a stale `Uses` entry, a stale `Used by`
      entry, a missing title line, and an orphan that is not a declared entry point.
- [ ] `--write` is idempotent and keeps hand annotations, in all five languages, as shown by
      the golden tests.
- [ ] The Rust fixtures cover `mod.rs` and non-mod-rs layouts, both `#[path]` forms,
      cross-crate `use`, globs and qualified-path calls.
- [ ] The TS fixtures resolve the `@/*` alias exactly as the web UI's tsconfig does, and
      resolve a `file:` local-package import (`@yaran/protocol`, `@yaran/ui-kit`) to a
      first-party edge.
- [ ] The Kotlin and Swift inferred edges are marked `(inferred)`, and their limits are
      written in `docs/contributing/module-headers.md`.
- [ ] Line gate: a new 501-line file fails, a baselined file cannot grow without
      `--accept-growth --reason`, and a stale baseline entry fails.
- [ ] `baseline-oversize.json` lists exactly the tracked files over 500 lines at the landing
      commit (checked by `--init-baseline --dry-run` producing no diff).
- [ ] `gates.yml` reports `Required gates` on every PR, docs-only PRs included, and that
      check fails when any gated job fails.
- [ ] `Required gates` is in the live branch protection (read back with `gh api`, not taken
      from the doc), and `BRANCH_PROTECTION.md` matches.
- [ ] Every action in `gates.yml` is pinned to a 40-character SHA with a version comment.
- [ ] `make headers-check` and the opt-in hook work locally.

## Validation

```bash
cd tools/module-headers
npm ci
npm run fetch-grammars
npm run typecheck
npm test
node bin/module-headers.mjs --check
node bin/module-headers.mjs --lines --check
node bin/module-headers.mjs --init-baseline --dry-run    # must print no diff
cd ../..
make headers-check
grep -nE 'uses: [^@]+@[0-9a-f]{40} # v' .github/workflows/gates.yml
gh api repos/SiavZ/yaran/branches/main/protection \
  --jq '.required_status_checks.contexts'               # must include "Required gates"
```

## Risks

| Risk | Mitigation |
|---|---|
| TypeScript 7 has no JS API, and Dependabot proposes a bump to 7 | Pin exactly to 6.0.3 and add a Dependabot `ignore` for `typescript >=7` in the tool's entry, with a comment pointing here. Each new package's Dependabot entry (added by its owning phase) carries the same ignore, so the plan-wide pin moves in one reviewed change. Revisit when a TS 7 API ships. |
| The Swift grammar is not on npm, and a fetched binary is a supply-chain input | Pinned release URL plus a SHA-256 constant. The fetch fails closed. The file is cached in `.grammars/` and never committed. |
| Inferred Kotlin and Swift edges are wrong in corner cases | They are labelled `(inferred)`, documented, and pinned by fixtures. They are still checked, so drift is caught even when the edge set is approximate. |
| A one-line wiring change to `input.rs` (39k lines) needs `--accept-growth` | Intended. Growth is visible and reviewed (CODEOWNERS on the baseline). The reason names the phase. |
| `Used by` trees change whenever any importer moves, which churns diffs | That is the signal the convention asks for. `--write` in the pre-commit hook makes fixing it one command. |
| Parsing all 900+ tracked code files is slow in pre-commit | The hook checks only staged in-scope files, but the graph still needs every file. Parse results are cached in `node_modules/.cache/module-headers` keyed by blob SHA (`git ls-files -s`). The target is under 5 s warm. |
| `enforce_admins: false` lets an admin bypass `Required gates` | Out of scope here. Noted in `BRANCH_PROTECTION.md` as an owner decision. |
| Branch protection can only be changed by an admin | The work item ships the exact `gh api -X PUT` command. Acceptance requires reading back the live state. |

## References

- `00-CONVENTIONS.md` §1, §2; research/R3-repo-process.md §1-3 (:7-131), Implications 2 and 4 (:390-403)
- `docs/plans/rustport/02-ci-gates-and-modularity-enforcement.md:70-129` (the unbuilt precedent)
- `.github/BRANCH_PROTECTION.md:14-29, :45, :61-76`; `.github/CODEOWNERS:8, :22-29`; `.github/dependabot.yml:34-42`; `Makefile:9-13, :22-35`; `CONTRIBUTING.md:12, :163-169`
- `crates/yaran-web/web/package.json:58`; `crates/yaran-web/web/tsconfig.json:8`; `website/tsconfig.json:12`; `Cargo.toml:2-7`
- https://nodejs.org/api/typescript.html (2026-11-14)
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ and https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ (2026-11-14)
- https://www.npmjs.com/package/web-tree-sitter (0.27.2, 2026-11-07); https://github.com/alex-pinkus/tree-sitter-swift/releases (0.7.3, 2026-06-01)
- https://doc.rust-lang.org/reference/items/modules.html (2026-11-14)
- https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks (2026-11-14)
- https://github.com/dorny/paths-filter (v4.0.3, 2026-08-05); https://github.com/re-actors/alls-green (v1.3.0, 2026-08-22)

## Reconciliation notes (2026-11-14)

- Evidence: TypeScript pin stated as exactly `typescript@6.0.3` (was `~6.0.3` in Evidence, exact in the work item) and declared the plan-wide pin for every new package (R21).
- Evidence: added the local-packages fact (`file:` dependencies on `cloud/protocol` and `packages/ui-kit`, no npm workspaces, no vendored protocol on `main`) (R4, R18).
- Design, TS row: `file:` local-package imports resolve through the package's `exports` map as first-party edges (R4, R18); work item 6 and Acceptance gained the matching fixture.
- Scope: `packages/**` added to `roots`; moved ui-kit files and the generated `cloud-deploy` branch handled explicitly; no protocol drift check exists (R4, R18).
- CI: filter list now names `protocol`, `cloud`, `mobile`, `ui-kit` with their local-package dependencies; seam names Phase 02's `cloud-protocol.yml` (02 WI-11) alongside Phase 18's suites (R20).
- CI: Node version follows Phase 18's `.node-version` once it exists (R21).
- CLI: optional positional paths, so the `--check cloud/worker` form used by Phases 04 and 05 is valid (R20).
- Risks: Dependabot `typescript >=7` ignore extends to every new package (R21).

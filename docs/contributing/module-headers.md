# Module headers and the 500-line gate

Two rules from the phone-app plan's conventions are enforced by a tool instead of by
reviewers:

1. Every in-scope code file opens with a header comment: a title line, a purpose
   paragraph, its responsibilities, and a generated block listing what it uses and
   what uses it.
2. No code file grows past 500 lines. The files that were already over 500 when the
   gate landed are held to their size by a ratchet baseline.

Both live in `tools/module-headers/`, and both run in CI as part of
`.github/workflows/gates.yml`, whose `Required gates` job is the required check.

## Setup

```bash
cd tools/module-headers
npm ci                    # no install scripts run (see .npmrc)
npm run fetch-grammars    # Swift grammar from a pinned, SHA-256-checked GitHub release
```

Node 22.12 or newer. The Swift grammar is only needed once Swift files exist, but the
tool's own tests use it.

## The block

The tool owns only the part between the markers. Everything above it is yours:

```rust
//! Cloudflare tunnel supervisor: owns the one `cloudflared` child process.
//!
//! - Runs on its own thread; never touches the engine (which is `!Send`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/supervisor.rs
//! ├── cloud::credentials  (token file path)
//! └── cloud::ready_probe
//! External: std, tracing
//!
//! Used by:
//! cloud/supervisor.rs
//! └── cloud::leg
//! <module-headers:end>
```

- **Comment syntax** follows the language: `//!` lines in Rust, a leading `/** … */` in
  TypeScript and JavaScript (`//` lines also work, which is the web UI's existing
  style), a KDoc `/** … */` before `package` in Kotlin, `///` lines in Swift (after a
  SwiftPM manifest's `// swift-tools-version:` line, which must stay first), and `#`
  lines after the shebang (and any `# shellcheck` directive) in shell.
- **Node names**: Rust module paths (`cloud::credentials`; `yaran-web::serve_loop`
  across crates; `crate` for the crate root), TypeScript paths relative to the package
  root (`<package>:<path>` across packages, such as `@yaran/protocol:src/sig/canonical.ts`),
  Kotlin `<package>.<file stem>`, Swift `<module>/<file stem>`, shell repo-relative paths.
- **External** lists third-party crates and packages (std and node builtins included).
- **Annotations**: a trailing `(…)` you write on a tree line is kept when the block is
  regenerated, keyed by the node name. `(inferred)` is generated, not an annotation.
- **Title**: the check fails when the comment above the block has no title line.
  Directives (`# shellcheck …`, `@ts-…`, `eslint-…`) do not count.
- **Orphans**: a file nothing imports must be declared an entry point (below), or the
  check fails.
- Files with `@generated` in their first five lines are exempt from both rules.

## Commands

All commands run from anywhere in the repository.

| Command | What it does |
|---|---|
| `node tools/module-headers/bin/module-headers.mjs --check [<path>…]` | Fails on a missing, stale or unterminated block, a missing title, or an orphan |
| `node tools/module-headers/bin/module-headers.mjs --write [<path>…]` | Rewrites the blocks; inserts one where missing |
| `node tools/module-headers/bin/module-headers.mjs --explain <path>` | Prints one file's edges and expected block (any tracked file, in scope or not) |
| `node tools/module-headers/bin/module-headers.mjs --lines --check` | The 500-line gate |
| `node tools/module-headers/bin/module-headers.mjs --lines --write` | Tightens the baseline after files shrank or were deleted |
| `node tools/module-headers/bin/module-headers.mjs --accept-growth <path> --reason "<phase NN: why>"` | Records reviewed growth of an oversize file |
| `node tools/module-headers/bin/module-headers.mjs --init-baseline --dry-run` | Prints how the baseline differs from the tree |
| `make headers` / `make headers-check` / `make lines-check` | The same, as CI runs them |

Optional paths limit which in-scope files are written or checked (a file, or a
directory prefix such as `cloud/worker`). The graph is still built over every tracked
file, so `Used by` stays complete. `--json` prints machine-readable results. Exit
codes: 0 ok, 1 drift or a violation, 2 usage or internal error.

Every failure names the file, the rule and the exact command or edit that fixes it.

Only tracked files exist for the tool: `git add` a new file before checking it.

## Scope

`tools/module-headers/scope.json` decides which files carry a block:

- `roots`: the new subproject trees (`cloud/**`, `mobile/**`, `packages/**`,
  `tools/cloud-gates/**`, the Rust and web cloud seams, and this tool itself).
- `optIn`: existing files outside the roots. **A PR that touches an existing file for
  the phone-app plan adds it here in the same PR**, and gives it its header. Files never
  leave `optIn`; a renamed file is renamed here.
- `exclude`: generated code, fixtures, `node_modules`, CocoaPods, the `CapApp-SPM` package
  the Capacitor CLI manages, and the Gradle wrapper script.
- `entryPoints`: a path or glob mapped to how the file is launched, for files nothing
  imports (binaries, test files, scripts, app entries). The block then reads
  `Used by: entry point (<description>)`. A glob (`cloud/worker/test/*.test.ts`) covers a
  whole test directory. An entry that matches no tracked file fails the check.

## Growing an oversize file

`tools/module-headers/baseline-oversize.json` records every file that was over 500
lines on 2026-11-14 with its line count. A baselined file may never exceed its count,
and a new file over 500 lines fails outright; there is no in-file opt-out.

When a phase genuinely needs to add wiring to an oversize file (a `mod` line, a call, a
match arm; the behaviour itself goes in a new module), run:

```bash
node tools/module-headers/bin/module-headers.mjs --accept-growth crates/yaran-tui/src/app/input.rs \
  --reason "phase 10: route the cloud palette command"
```

That raises the count and appends the reason, so the growth is a reviewed diff to a
CODEOWNERS-guarded file. Keep the reason specific: the phase number and what the wiring
is for. A renamed baselined file counts as new and is re-baselined the same way.

When a file shrinks, `--lines --write` lowers its count (and drops it once it is at or
under 500). An entry whose file is gone fails the check until that runs.

## What the graph can and cannot see

The trees are computed, and the computation has limits. The check still catches drift
inside those limits.

- **Rust**: modules are resolved by the Rust Reference rules (`foo.rs` and
  `foo/mod.rs`, non-mod-rs nesting, `#[path]` at top level and inside inline blocks).
  `use` trees, `crate::`/`self::`/`super::` paths, child-module paths, `use` aliases and
  workspace crate names (`yaran_core::…`) are edges. **Paths inside macro arguments**
  (`format!("{}", crate::x::y())`) are not seen, because tree-sitter does not parse
  macro token trees. A path naming an item in the crate root resolves to `crate`.
- **TypeScript/JavaScript**: imports, `export … from`, dynamic `import()` and `require`
  with literal specifiers, resolved by the TypeScript 6 compiler with the nearest
  `tsconfig.json` (`paths` honored) under `bundler` resolution. A `file:` dependency
  (`@yaran/protocol`, `@yaran/ui-kit`) resolves through its `exports` map to tracked
  source, with no `npm ci` needed. Computed specifiers and assets are not edges.
- **Kotlin**: `import a.b.C` resolves through a top-level declaration index. Uses within
  one package (and from a wildcard-imported package) need no import, so they are
  **inferred** by name: an identifier equal to another file's top-level declaration.
  Inferred entries carry `(inferred)`. Two files declaring the same name (overloads)
  both get the edge, which over-reports. A use only through an extension can be missed.
- **Swift**: files in one module see each other without imports, so every same-module
  edge is **inferred** the same way, and a first-party `import M` makes module `M`
  visible. A file's module is its SwiftPM target (`Sources/<M>/…`), else the top
  directory under the nearest directory holding an `.xcodeproj`, else its parent
  directory. An `extension Foo` declares nothing, so a file used only through an
  extension it adds is missed. Name collisions over-report.
- **Shell**: `source F` and `. F` with a literal path, or one built from the script's own
  directory (`$(dirname "$0")`, `${BASH_SOURCE%/*}`, the `cd … && pwd` idiom, or a
  variable assigned one of those). Anything else computed is listed as
  `unresolved: <expr>`, never dropped. bats `load` is not followed.

## The pre-commit hook

Optional; CI is the gate.

```bash
git config core.hooksPath tools/module-headers/hooks
```

It checks the blocks of the staged files and runs the line gate. It reads the working
tree, so stage what you checked. Disable it with `git config --unset core.hooksPath`.

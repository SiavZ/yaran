# Conventions binding on every phase

These rules apply to every file written or touched by this plan, in every language
(Rust, TypeScript, Kotlin, Swift, shell, workflow YAML where code-like). They are in
addition to the repo's own `CLAUDE.md`, which wins on any conflict.

## 1. Modularity and reuse

1. **500-line ceiling.** No code file created by this plan exceeds 500 lines (blank and
   comment lines included; generated files and lockfiles excepted and marked as generated).
2. **Touching an oversize file.** Many seams this plan edits are already far over 500 lines
   (R1 §11: 127 of 285 `.rs` files; R2 §10: 17 frontend files, `store.ts` at 6335). When a
   phase adds behaviour to such a file, the new behaviour lands in a **new module**, and the
   oversize file gains only the minimal wiring (a `mod` line, a call, a match arm). If the
   touched region itself contains logic the new code would otherwise duplicate, that logic
   is **extracted into a reusable module first** (its own PR inside the phase), and both the
   old caller and the new code use it. Whole-file refactors of unrelated code are not part
   of this product and are not done here.
3. **Search before you write.** Before creating any helper, component, hook, type, or
   module, search the codebase for an existing one (CLAUDE.md: "A shared component probably
   already exists"). Every phase lists the existing abstractions it reuses, with file:line.
4. **One home per concept.** Shared wire types live in `cloud/protocol` (TS) and
   `yaran_core::cloud::protocol` (Rust), both validated against the same JSON Schemas and
   test vectors. No phase re-declares a wire type locally.
5. **Exhaustive matches** for every enum that crosses a trust or state boundary (CLAUDE.md
   pattern for `TerminalOwner`/workspace), `assertNever` in TS, `when` without `else` in
   Kotlin, `switch` without `default` in Swift where the compiler allows.

## 2. File header comment (mandatory on every code file)

Every code file begins with a header comment containing, in this order:

1. **Title line** and a one-paragraph statement of what the file does and why it exists.
2. **Responsibilities / invariants**: bullet list (threading, trust boundary, side effects).
3. **Uses**: a tree of every first-party module this file imports (external crates/packages
   in a separate `External` list).
4. **Used by**: for any module imported by another first-party file, a tree of its
   first-party importers. Entry points (binaries, `main.rs`, route roots, app entry) write
   `Used by: entry point (<how it is launched>)`.

The trees are **generated and checked** by `tools/module-headers` (Phase 01). A PR whose
headers disagree with the real import graph fails CI. Hand edits outside the generated
block are allowed; the generated block is delimited so the tool can rewrite it.

Rust example:

```rust
//! Cloudflare tunnel supervisor: owns the one `cloudflared` child process for this run.
//!
//! Spawns cloudflared with the tunnel token passed by file, restarts it with jittered
//! backoff, polls `/ready`, and reports transitions as keyed statuses on both surfaces.
//!
//! - Runs on its own thread; never touches the engine (which is `!Send`).
//! - Kills the whole process group on shutdown (SIGTERM, grace, SIGKILL, reap).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/supervisor.rs
//! ├── cloud::credentials        (token file path)
//! ├── cloud::ready_probe        (/ready polling)
//! └── watch::backoff::WatchBackoff
//! External: std::process, tracing
//!
//! Used by:
//! cloud/supervisor.rs
//! ├── cloud::leg                (start/stop on mode change)
//! └── yaran-web::serve_loop     (wind-down on shutdown)
//! <module-headers:end>
```

TypeScript uses a leading `/** … */` block, Kotlin a leading `/** … */` KDoc block before
`package`, Swift a leading `///` block, shell a leading `#` block after the shebang, all
with the same `<module-headers:begin>`/`<module-headers:end>` markers.

## 3. Tests are part of the work, not after it

- Every work item names its tests. New non-trivial logic ships with unit tests; every
  trust-boundary or wire-format change also ships an integration test. CLAUDE.md: "Prove
  your work with tests" and "prove your findings with a unit test" before fixing a bug.
- Wire formats are pinned by **shared fixtures** in `cloud/protocol/fixtures/` read by the
  Rust, Worker, relay and mobile test suites alike (the repo's existing shared-fixture
  pattern for `Prose`).
- Rust: `cargo fmt`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`.
  TS: typecheck in `strict` mode for all new packages, Vitest. Kotlin: ktlint/detekt + JUnit.
  Swift: SwiftLint + XCTest. Each phase's Validation block lists the exact commands.

## 4. Research protocol (for implementers as well as planners)

The owner's rule: **no assumptions.** Before deciding how a seam works, read the full call
path (callers and callees), not one grep hit or one file. Concretely:

1. Start from the research file cited in the phase, then **re-verify every cited
   file:line against the current tree** (line numbers drift).
2. For investigation, the implementing agent acts as a coordinator: it spawns sub-agents,
   each of which may spawn its own sub-agents for narrow reads or online lookups and
   returns condensed, cited findings. The coordinator merges and verifies them. This keeps
   the coordinating context small; it is the expected way of working on every phase.
3. Online research is encouraged; prefer primary sources (developers.cloudflare.com,
   developer.android.com, developer.apple.com, capacitorjs.com, f-droid.org, RFCs) and
   record URL + date in the PR.
4. Anything not confirmed is labelled UNVERIFIED in the PR and either proven (Phase 03
   style) or designed around.

## 5. yaran house rules that this plan leans on hardest

- Long-running work runs in background workers; every async op uses the keyed status
  controller (Busy → final, same key) on both surfaces (`yaran_core::statusline`).
- Status and toast text is verbose and actionable; names in modals are chips (`name_chip`
  / `InlineCode`); destructive actions confirm.
- All settings configurable and documented inline in the canonical config; secrets never in
  config (D5).
- Theme engine for every TUI pixel; shadcn/base-ui tokens for every web pixel.
- New attack surface updates `docs/operations/threat-model.md` (append from **T25**) and the
  `SECURITY.md` STRIDE table in the same change.
- Sanitize attacker-controlled text (Cloudflare API errors, cloudflared stderr, push
  provider responses) with `yaran_core::sanitize` before logging or showing it.
- Commit messages are plain sentences; work reaches `main` only through PRs.

## 6. Plan document format (for these phase files)

`# Phase NN — Title`, then two bold lines (`Track · Parallel-safe with`, `Depends on ·
Blocks`), then: Goal, Evidence (file:line / URL), In scope, Out of scope (only things owned
by another phase, with its number), Design, Work items (numbered, each with files to create
or touch, reuse, tests), Acceptance (`- [ ]`), Validation (bash), Risks (table), References.

# Audits

The [2026-11-04 web UI/UX audit](2026-11-04-ui-ux.md) records the T3 Code
comparison, fixed findings, scoring rubric, verification, and coverage limits.

The separate [2026-11-04 TUI UI/UX audit](2026-11-04-tui-ui-ux.md) covers the
terminal interface, its fixes, real terminal captures, checks and scoring limits.

The [main TUI redesign and review](2026-11-04-tui-main-workspace.md) records the
later visible workspace changes implemented with Opus 5.5 and independently
reviewed before installation.

Point-in-time audit reports of the fork (audit01, audit02, audit03 with its
disposition in `audit03/99-disposition.md`).

> **Historical record, pre-workspace paths.** File paths in these reports
> refer to the fork-main single-crate layout, before the `crates/`
> restructure. Mapping: `src/` -> `crates/dux-core/src/` (engine, config,
> storage, pty, git, model) or `crates/dux-tui/src/` (`src/app/`, `src/cli.rs`,
> keys, rendering); `tests/` -> `crates/*/tests/`. Storage no longer uses
> numbered migrations (`src/storage/migrations/000N_*.sql`, `PRAGMA
> user_version`): it uses idempotent `ensure_column` calls in
> `crates/dux-core/src/storage.rs`. See
> [docs/contributing/schema-policy.md](../contributing/schema-policy.md).
> The body is left as written.

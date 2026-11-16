//! The `yaran config` subcommands (path, diff, reset, regenerate) and their config-diff engine.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cli.rs
//! ├── cli::plaintext_shape_preview_tests
//! ├── cli::preview_leak_tests
//! ├── config
//! ├── config_cli
//! ├── config_spec
//! ├── crate
//! ├── keybindings
//! ├── yaran-core::auth
//! ├── yaran-core::branch_history
//! ├── yaran-core::client
//! ├── yaran-core::config
//! ├── yaran-core::config_keys
//! ├── yaran-core::config_write
//! ├── yaran-core::engine
//! ├── yaran-core::file_modes
//! ├── yaran-core::leftover_folders
//! ├── yaran-core::model
//! ├── yaran-core::process_sessions
//! ├── yaran-core::project_browser
//! ├── yaran-core::purge
//! ├── yaran-core::purge_amq
//! ├── yaran-core::sanitize
//! ├── yaran-core::storage
//! ├── yaran-core::test_git
//! ├── yaran-core::text
//! └── yaran-core::worktree_ops
//! External: anyhow, chrono, rusqlite, rustix, serde_json, similar, std, tempfile, toml
//!
//! Used by:
//! cli.rs
//! ├── cli::plaintext_shape_preview_tests
//! ├── cli::preview_leak_tests
//! ├── config_cli::appended_password_tests
//! ├── config_cli::names_never_printed_property_tests
//! └── crate
//! ```
//! <module-headers:end>

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow, bail};

use crate::config::{self, Config, YaranPaths};
use crate::config_spec::{config_flags, has_flag};
use crate::git;
use crate::keybindings::RuntimeBindings;
use crate::logger;
use crate::storage::SessionStore;
use yaran_core::project_browser::canonical_or_original;
use yaran_core::purge::PurgeRun;
use yaran_core::text::count_of;

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

/// Whether the arguments after `yaran config` ask for help: `-h` or `--help`
/// anywhere, except after a literal `--`, where words are a value's.
pub(crate) fn asks_for_help(args: &[String]) -> bool {
    args.iter()
        .take_while(|a| a.as_str() != "--")
        .any(|a| a == "-h" || a == "--help")
}

/// Whether `yaran config regenerate` or `restore-docs` writes the file or only
/// previews what it would write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConfigRewrite {
    /// Show the diff and say how to apply it.
    Preview,
    /// `--yes`: write the file.
    Apply,
}

/// How much `yaran config reset` removes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResetScope {
    /// The config, logs and remotes only.
    ConfigOnly,
    /// `--all`: the agent data too.
    Everything,
}

/// What `yaran config diff` prints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffForm {
    /// The structural summary that is safe to paste.
    Summary,
    /// `--raw`: the whole file.
    Raw,
}

/// Standard output, or any writer, carrying a config command's result. A
/// write it cannot make fails with a [`PrintFailed`] inside, so
/// [`finish_config`] can tell a result that could not be printed from a
/// command that failed.
pub(crate) struct ResultOut<W>(pub(crate) W);

impl<W: std::io::Write> std::io::Write for ResultOut<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf).map_err(PrintFailed::wrap)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush().map_err(PrintFailed::wrap)
    }
}

/// The marker inside a write error [`ResultOut`] returns: the result could not
/// be printed.
#[derive(Debug)]
struct PrintFailed(std::io::Error);

impl PrintFailed {
    /// `error`, of the same kind, marked as a failure to print the result.
    fn wrap(error: std::io::Error) -> std::io::Error {
        std::io::Error::new(error.kind(), Self(error))
    }
}

impl std::fmt::Display for PrintFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for PrintFailed {}

/// How a config command ends, the way every other command does: a result that
/// could not be printed because its reader went away (`| head`) ends it
/// quietly with its own code, any other failure to print it is said and ends
/// it as failed, and every other error is the command's own.
pub(crate) fn finish_config(result: Result<()>) -> Result<()> {
    let Err(error) = result else {
        return Ok(());
    };
    let printed = error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .find(|io| {
            io.get_ref()
                .is_some_and(<dyn std::error::Error + Send + Sync>::is::<PrintFailed>)
        });
    match printed {
        Some(io) => match yaran_core::client::print_failure(io) {
            None => Ok(()),
            Some(failed) => Err(failed.into()),
        },
        None => Err(error),
    }
}

pub(crate) fn run(args: &[String], paths: &YaranPaths) -> Result<()> {
    let mut out = ResultOut(std::io::stdout());
    let sub = args.first().map_or("", std::string::String::as_str);
    match sub {
        "reset" => {
            let all = has_flag("reset", &args[1..], "--all");
            reject_unknown_flags(&args[1..], config_flags(sub))?;
            run_reset(
                paths,
                if all {
                    ResetScope::Everything
                } else {
                    ResetScope::ConfigOnly
                },
                &mut ResetReport::terminal(),
            )
        }
        "diff" => {
            let raw = has_flag("diff", &args[1..], "--raw");
            reject_unknown_flags(&args[1..], config_flags(sub))?;
            run_diff(
                paths,
                if raw {
                    DiffForm::Raw
                } else {
                    DiffForm::Summary
                },
                &mut out,
            )
        }
        "regenerate" => {
            let yes = has_flag("regenerate", &args[1..], "--yes");
            let held_back = if has_flag("regenerate", &args[1..], "--show") {
                yaran_core::config_keys::HeldBack::Shown
            } else {
                yaran_core::config_keys::HeldBack::Masked
            };
            reject_unknown_flags(&args[1..], config_flags(sub))?;
            run_regenerate(
                paths,
                if yes {
                    ConfigRewrite::Apply
                } else {
                    ConfigRewrite::Preview
                },
                held_back,
                &mut out,
            )
        }
        "restore-docs" => {
            let yes = has_flag("restore-docs", &args[1..], "--yes");
            let held_back = if has_flag("restore-docs", &args[1..], "--show") {
                yaran_core::config_keys::HeldBack::Shown
            } else {
                yaran_core::config_keys::HeldBack::Masked
            };
            reject_unknown_flags(&args[1..], config_flags(sub))?;
            run_restore_docs(
                paths,
                if yes {
                    ConfigRewrite::Apply
                } else {
                    ConfigRewrite::Preview
                },
                held_back,
                &mut out,
            )
        }
        "path" => {
            writeln!(out, "{}", paths.config_path.display())?;
            Ok(())
        }
        "get" => crate::config_cli::run_get(&args[1..], paths, &mut out, &mut std::io::stderr()),
        "set" => crate::config_cli::run_set(
            &args[1..],
            paths,
            &mut crate::config_cli::TerminalSecrets,
            &mut out,
        ),
        "" | "--help" | "-h" => print_config_help(&mut out),
        other => bail!("unknown config subcommand: {other}\nRun `yaran config --help` for usage."),
    }
}

fn reject_unknown_flags(args: &[String], known: &[&str]) -> Result<()> {
    for arg in args {
        if arg.starts_with('-') && !known.contains(&arg.as_str()) {
            bail!("unknown flag: {arg}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// yaran session: GDPR hard purge (fork 3e5c1c32, 0b831554)
// ---------------------------------------------------------------------------

/// Exit code for "a cascade step reported an error".
const EXIT_PURGE_ERRORS: i32 = 1;
/// Exit code for "aborted at the confirmation prompt".
const EXIT_PURGE_ABORTED: i32 = 2;

/// `yaran session <sub>`. Returns the process exit code: 0 on success or a dry
/// run, [`EXIT_PURGE_ERRORS`] when any cascade step failed,
/// [`EXIT_PURGE_ABORTED`] when the confirmation phrase did not match. Invalid
/// arguments and an unknown target are `Err`. The caller holds the
/// single-instance lock for the mutating subcommands.
pub(crate) fn run_session(args: &[String], paths: &YaranPaths) -> Result<i32> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    run_session_with_input(args, paths, &mut input)
}

fn run_session_with_input(
    args: &[String],
    paths: &YaranPaths,
    input: &mut dyn std::io::BufRead,
) -> Result<i32> {
    let sub = args.first().map_or("", std::string::String::as_str);
    match sub {
        "purge" => run_session_purge(paths, &args[1..], input),
        "purge-all" => {
            let rest = &args[1..];
            reject_unknown_flags(rest, &["--yes", "--dry-run"])?;
            if let Some(extra) = rest.iter().find(|arg| !arg.starts_with('-')) {
                bail!("unexpected positional argument: {extra}");
            }
            let flags = PurgeFlags {
                yes: rest.iter().any(|a| a == "--yes"),
                run: if rest.iter().any(|a| a == "--dry-run") {
                    PurgeRun::DryRun
                } else {
                    PurgeRun::Apply
                },
            };
            run_session_purge_all(paths, flags, input)
        }
        "" | "--help" | "-h" => {
            print_session_help();
            Ok(0)
        }
        other => {
            bail!("unknown session subcommand: {other}\nRun `yaran session --help` for usage.")
        }
    }
}

fn print_session_help() {
    println!(
        "\
yaran session: manage individual agents

Subcommands:
  yaran session purge --hard <target> [--yes] [--dry-run]
                       [--accept-residual-data | --workspace-wide-provider-history]
                       Permanently erase one agent: its worktree, provider chat
                       history, AMQ inbox, startup-command logs, log records, and
                       its row (a soft-deleted agent included). <target> is a
                       session id, agent handle, or a branch naming exactly one
                       agent. A shared-workspace or standalone agent's directory
                       is never removed, and its provider history needs explicit
                       consent (below).
  yaran session purge-all [--yes] [--dry-run]
                       Purge every agent. Shared provider history stays and is
                       reported incomplete; rows that cannot be planned safely
                       are kept and listed.

Flags:
  --hard               Required for `purge`. Affirms the destructive intent.
  --yes                Skip the typed 'PURGE <branch>' confirmation.
  --dry-run            Print the plan and exit without changing anything.
  --accept-residual-data
                       Shared or standalone agents only: keep the shared provider
                       history but erase everything this agent owns, row included.
  --workspace-wide-provider-history
                       Shared or standalone agents only: purge EVERY agent in that
                       directory and its provider history, including chats that
                       were never started by yaran.

Environment:
  CLAUDE_CONFIG_DIR, STATE_ROOT, AMQ_GLOBAL_ROOT, AM_ROOT
                       Where provider history and the AMQ bus live. Each must be
                       an absolute path. See the plan output for what is targeted.

Exit codes:
  0  success (or dry run)
  1  a step failed; the row is kept so the purge can be re-run
  2  aborted at the confirmation prompt"
    );
}

fn run_session_purge(
    paths: &YaranPaths,
    args: &[String],
    input: &mut dyn std::io::BufRead,
) -> Result<i32> {
    use yaran_core::purge::SharedPurgeMode;

    let mut yes = false;
    let mut run = PurgeRun::Apply;
    let mut hard = false;
    let mut shared_mode = SharedPurgeMode::RetainIdentity;
    let mut target: Option<String> = None;
    for arg in args {
        match arg.as_str() {
            "--yes" => yes = true,
            "--dry-run" => run = PurgeRun::DryRun,
            "--hard" => hard = true,
            "--accept-residual-data" => {
                if shared_mode == SharedPurgeMode::WorkspaceWide {
                    bail!("shared purge consent flags are mutually exclusive");
                }
                shared_mode = SharedPurgeMode::AcceptResidualData;
            }
            "--workspace-wide-provider-history" => {
                if shared_mode == SharedPurgeMode::AcceptResidualData {
                    bail!("shared purge consent flags are mutually exclusive");
                }
                shared_mode = SharedPurgeMode::WorkspaceWide;
            }
            s if s.starts_with('-') => bail!("unknown flag: {s}"),
            other => {
                if target.is_some() {
                    bail!("unexpected positional argument: {other}");
                }
                target = Some(other.to_string());
            }
        }
    }
    if !hard {
        bail!(
            "`yaran session purge` requires --hard to affirm the destructive intent.\n\
             It permanently deletes the agent's worktree, provider chat history, AMQ inbox,\n\
             logs and row. Shared provider history additionally needs\n\
             --accept-residual-data or --workspace-wide-provider-history.\n\
             Re-run as: yaran session purge --hard <target>"
        );
    }
    let Some(target) = target else {
        bail!("missing target: yaran session purge --hard <session-id-handle-or-branch>");
    };
    let (storage, purge_config) = open_purge_inputs(paths)?;
    let plans = yaran_core::purge::build_plans_for_target(
        &storage,
        paths,
        &purge_config,
        &target,
        shared_mode,
    )?;
    for plan in &plans {
        println!("{}", format_purge_plan(plan, run));
    }

    if !yes && !run.is_dry() {
        let confirmed = if shared_mode == SharedPurgeMode::WorkspaceWide {
            let phrase = format!("PURGE WORKSPACE {}", plans[0].branch);
            eprint!(
                "Type '{}' to confirm provider-history deletion for every agent in this directory: ",
                yaran_core::sanitize::for_terminal(&phrase)
            );
            let _ = std::io::Write::flush(&mut std::io::stderr());
            let mut line = String::new();
            input
                .read_line(&mut line)
                .map_err(|err| anyhow!("failed to read confirmation: {err}"))?;
            line.trim() == phrase
        } else {
            prompt_purge_confirmation(&plans[0], input)?
        };
        if !confirmed {
            eprintln!("aborted: confirmation phrase did not match");
            return Ok(EXIT_PURGE_ABORTED);
        }
    }

    let mut any_errors = false;
    for plan in &plans {
        let report = yaran_core::purge::execute(plan, &storage, paths, &purge_config, run)?;
        eprint!("{}", report.summary());
        any_errors |= report.had_errors();
    }
    Ok(if any_errors { EXIT_PURGE_ERRORS } else { 0 })
}

/// What `--yes` and `--dry-run` asked of a purge.
#[derive(Clone, Copy, Debug)]
struct PurgeFlags {
    /// Skip the typed confirmation.
    yes: bool,
    /// Whether anything is deleted.
    run: PurgeRun,
}

fn run_session_purge_all(
    paths: &YaranPaths,
    PurgeFlags { yes, run }: PurgeFlags,
    input: &mut dyn std::io::BufRead,
) -> Result<i32> {
    let (storage, purge_config) = open_purge_inputs(paths)?;
    let (plans, planning_failures) =
        yaran_core::purge::build_plans_for_all(&storage, paths, &purge_config)?;
    for failure in &planning_failures {
        eprintln!("WARNING: {failure}");
    }
    println!("about to purge {} session(s)", plans.len());
    for (i, plan) in plans.iter().enumerate() {
        println!("--- session {} of {} ---", i + 1, plans.len());
        println!("{}", format_purge_plan(plan, run));
    }

    if !yes && !run.is_dry() {
        // One phrase for the whole list: typing every branch is impractical.
        eprint!("Type 'PURGE ALL' to confirm: ");
        let _ = std::io::Write::flush(&mut std::io::stderr());
        let mut line = String::new();
        input
            .read_line(&mut line)
            .map_err(|e| anyhow!("failed to read confirmation: {e}"))?;
        if line.trim() != "PURGE ALL" {
            eprintln!("aborted: confirmation phrase did not match");
            return Ok(EXIT_PURGE_ABORTED);
        }
    }

    let mut any_errors = !planning_failures.is_empty();
    for plan in &plans {
        let report = yaran_core::purge::execute(plan, &storage, paths, &purge_config, run)?;
        eprint!("{}", report.summary());
        any_errors |= report.had_errors();
    }
    Ok(if any_errors { EXIT_PURGE_ERRORS } else { 0 })
}

/// Everything a purge needs, loaded fail-closed: the database must exist and
/// load whole, and the config must parse, because a defaulted config would
/// register no projects and so protect none of them.
fn open_purge_inputs(paths: &YaranPaths) -> Result<(SessionStore, yaran_core::purge::PurgeConfig)> {
    if !paths.sessions_db_path.exists() {
        bail!(
            "no sessions database found at {}: nothing to purge",
            yaran_core::sanitize::for_terminal(&paths.sessions_db_path.display().to_string())
        );
    }
    let config = yaran_core::purge::load_config_strict(paths)?;
    let storage = SessionStore::open(&paths.sessions_db_path)?;
    let sessions = storage.load_sessions_including_deleted()?;
    let protected = yaran_core::purge::protected_project_paths(&config, &storage, &sessions)?;
    let purge_config = yaran_core::purge::PurgeConfig::default_layout(paths, &config, protected)?;
    Ok((storage, purge_config))
}

fn prompt_purge_confirmation(
    plan: &yaran_core::purge::PurgePlan,
    input: &mut dyn std::io::BufRead,
) -> Result<bool> {
    eprint!(
        "Type 'PURGE {}' to confirm: ",
        yaran_core::sanitize::for_terminal(&plan.branch)
    );
    let _ = std::io::Write::flush(&mut std::io::stderr());
    yaran_core::purge::confirm_with_reader(plan, input)
}

fn format_purge_plan(plan: &yaran_core::purge::PurgePlan, run: PurgeRun) -> String {
    let session_id = yaran_core::sanitize::for_terminal(&plan.session_id);
    let branch = yaran_core::sanitize::for_terminal(&plan.branch);
    let mut s = if run.is_dry() {
        format!("DRY-RUN purge plan for session {session_id} (branch {branch}):\n")
    } else {
        format!("purge plan for session {session_id} (branch {branch}):\n")
    };
    for item in &plan.items {
        s.push_str("  - ");
        s.push_str(&item.describe());
        s.push('\n');
    }
    s
}

/// `yaran config --help`: the description of `yaran config` and then of each of
/// its subcommands in full, so one help holds every flag and warning.
fn print_config_help(out: &mut dyn std::io::Write) -> Result<()> {
    let mut command = crate::config_spec::config_command();
    command.build();
    let about = command.get_about().map_or_default(ToString::to_string);
    let mut about = about.chars();
    let lowered: String = about
        .next()
        .map_or_default(|first| first.to_lowercase().chain(about).collect());
    let root = command
        .clone()
        .help_template("{usage-heading} {usage}\n\n{all-args}")
        .render_long_help()
        .to_string();
    write!(out, "yaran config: {lowered}\n\n{}", root.trim_end())?;
    for sub in command.get_subcommands_mut() {
        write!(out, "\n\n{}", sub.render_long_help().to_string().trim_end())?;
    }
    writeln!(out)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// yaran config reset
// ---------------------------------------------------------------------------

/// A folder or program in the way of the factory reset, and why.
#[derive(Debug)]
struct ResetLeftover {
    path: PathBuf,
    reason: String,
}

/// Why `reset --all` deleted nothing: something still runs, or a check had no
/// answer. Carried as the command's error, so it prints once and exits 1.
#[derive(Debug, Default)]
struct ResetRefused {
    running: Vec<ResetLeftover>,
    /// The whole reason, way forward included, when the refusal is not about
    /// a program found running.
    unknown: Option<String>,
}

impl ResetRefused {
    fn unknown(reason: impl std::fmt::Display) -> Self {
        Self {
            running: Vec::new(),
            unknown: Some(format!(
                "could not check which programs are still running: {reason}. Fix that and run \
                 the reset again, or delete the files yourself."
            )),
        }
    }

    /// The session database could not answer which folders under the
    /// worktrees root are the user's. Deleting it by hand is the way past,
    /// once whatever of the user's lives in that root is out of it.
    fn unreadable_records(
        problem: impl std::fmt::Display,
        paths: &YaranPaths,
        error: impl std::fmt::Display,
    ) -> Self {
        let db = paths.sessions_db_path.display();
        let worktrees = paths.worktrees_root.display();
        Self {
            running: Vec::new(),
            unknown: Some(format!(
                "{problem}, so yaran cannot tell which folders under {worktrees} are yours \
                 ({error}). To reset anyway, quit yaran and anything it started, move anything of \
                 yours out of {worktrees} (a project kept inside it would be removed with it), \
                 delete {db} yourself, and run the reset again. Or repair the named row in \
                 {db}, or restore {db}.bak, the copy yaran keeps of it, and retry."
            )),
        }
    }
}

impl std::fmt::Display for ResetRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(reason) = &self.unknown {
            return write!(f, "yaran config reset --all deleted nothing: {reason}");
        }
        write!(
            f,
            "yaran config reset --all deleted nothing: something is still running. Stop what is \
             listed, then run the reset again."
        )?;
        for program in &self.running {
            write!(f, "\n  {}: {}", program.path.display(), program.reason)?;
        }
        Ok(())
    }
}

impl std::error::Error for ResetRefused {}

/// Why `reset --all` stopped part-way: a folder could not be removed, and
/// nothing after it, the database and the config included, was touched.
#[derive(Debug)]
struct ResetFailed {
    removed: Vec<PathBuf>,
    failed: ResetLeftover,
}

impl std::fmt::Display for ResetFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "yaran config reset --all stopped part-way: {} could not be removed ({}). The \
             database and the config were kept.",
            self.failed.path.display(),
            self.failed.reason
        )?;
        if self.removed.is_empty() {
            write!(f, " Nothing was removed before it.")?;
        } else {
            write!(f, " Already removed:")?;
            for path in &self.removed {
                write!(f, "\n  {}", path.display())?;
            }
        }
        write!(
            f,
            "\nSomething may still be using it: stop whatever is running there, then delete it \
             yourself (if git still lists it as a worktree of its project, run `git worktree \
             remove --force -- {}` in that project's folder) and run the reset again.",
            self.failed.path.display()
        )
    }
}

impl std::error::Error for ResetFailed {}

/// Where `yaran config reset` reports as it goes: what it removed on `out`, its
/// warnings on `err`.
struct ResetReport {
    out: Box<dyn std::io::Write>,
    err: Box<dyn std::io::Write>,
}

impl ResetReport {
    /// Standard output and standard error.
    fn terminal() -> Self {
        Self {
            out: Box::new(std::io::stdout()),
            err: Box::new(std::io::stderr()),
        }
    }

    /// A line of the report. One that cannot be written is dropped: a closed
    /// pipe must not stop a reset half-way through removing things.
    fn say(&mut self, line: std::fmt::Arguments<'_>) {
        let _ = writeln!(self.out, "{line}");
    }

    /// A warning, dropped the same way when standard error is gone.
    fn warn(&mut self, line: std::fmt::Arguments<'_>) {
        let _ = writeln!(self.err, "{line}");
    }
}

/// Says that a log the reset would otherwise remove was kept because it is
/// not plainly inside the config folder.
fn report_left_outside(path: &Path, root: &Path, report: &mut ResetReport) {
    report.say(format_args!(
        "left {} alone: it is outside the config folder {}, or reached through a \
         symlinked folder, so yaran does not delete it. Remove it yourself if you want it gone",
        path.display(),
        root.display()
    ));
}

/// The reset itself. Reports what it removed as it goes.
fn run_reset(paths: &YaranPaths, scope: ResetScope, report: &mut ResetReport) -> Result<()> {
    let (log_path, server_log_path) = resolve_reset_log_paths(paths);

    if scope == ResetScope::Everything {
        reset_agent_data(paths, report)?;
    }

    // Only from inside the config folder: a log path that leaves it, by an
    // absolute name, a `..` or a symlinked folder, is the user's to delete.
    if is_plainly_inside(&log_path, &paths.root) {
        if let Err(error) = remove_file_with_message(&log_path, report) {
            report.warn(format_args!("warning: {error}"));
        }
        prune_empty_ancestors(&log_path, &paths.root)?;
    } else {
        report_left_outside(&log_path, &paths.root, report);
    }
    if is_plainly_inside(&server_log_path, &paths.root) {
        // A log that will not go is a warning, as for yaran.log, never a reason
        // to keep the config.
        for copy in logger::rotated_copies_of(&server_log_path)
            .into_iter()
            .chain([server_log_path.clone()])
        {
            if let Err(error) = remove_file_with_message(&copy, report) {
                report.warn(format_args!("warning: {error}"));
            }
        }
        prune_empty_ancestors(&server_log_path, &paths.root)?;
    } else {
        report_left_outside(&server_log_path, &paths.root, report);
    }
    remove_file_with_message(&paths.root.join("remotes.toml"), report)?;
    remove_file_with_message(&paths.root.join("remotes.toml.lock"), report)?;
    remove_file_with_message(&paths.config_path, report)?;
    prune_empty_ancestors(&paths.config_path, &paths.root)?;

    // The lockfile (`yaran.lock`) is left in place: unlinking it while holding
    // the flock would orphan the inode, letting a new process create and flock
    // a fresh file at the same path and break the single-instance guarantee.
    // `remove_root_if_empty` therefore skips the root when the lockfile is the
    // sole remaining entry.
    remove_root_if_empty_with_message(&paths.root, report)?;
    report.say(format_args!("reset complete"));
    Ok(())
}

// ---------------------------------------------------------------------------
// yaran config diff
// ---------------------------------------------------------------------------

/// Refuse when config.toml is a symbolic link to a file that is gone: that is
/// not "no config file yet", and reading it as one would print a wrong answer
/// about a config the user keeps somewhere else.
fn refuse_dangling_config_link(paths: &YaranPaths) -> Result<()> {
    if let Some(target) = yaran_core::config::dangling_link_target(&paths.config_path) {
        bail!(
            "{} is a symbolic link to {}, which does not exist, so there is no config file to \
             read; nothing was changed. Restore {} or point the link at your config file.",
            paths.config_path.display(),
            target.display(),
            target.display()
        );
    }
    Ok(())
}

fn run_diff(paths: &YaranPaths, form: DiffForm, out: &mut dyn std::io::Write) -> Result<()> {
    refuse_dangling_config_link(paths)?;
    if !paths.config_path.exists() {
        writeln!(
            out,
            "no config file found at {}",
            paths.config_path.display()
        )?;
        return Ok(());
    }

    let current_raw =
        fs::read_to_string(&paths.config_path).with_context_path(&paths.config_path)?;
    let mut current: Config = toml::from_str(&current_raw).map_err(|e| {
        anyhow!(
            "{}: {}",
            paths.config_path.display(),
            yaran_core::config::describe_toml_error(&current_raw, &e)
        )
    })?;
    // The text it was read from, so a name the summary may not print is
    // placed by its line.
    current.source_text = yaran_core::config::SourceText::of(&current_raw);

    if form == DiffForm::Raw {
        run_diff_raw(&current_raw, &current, out)
    } else {
        run_diff_summary(&current, out)
    }
}

fn run_diff_raw(_current_raw: &str, current: &Config, out: &mut dyn std::io::Write) -> Result<()> {
    write!(out, "{}", raw_diff_text(current))?;
    Ok(())
}

/// What `yaran config diff --raw` prints for `current`.
pub(crate) fn raw_diff_text(current: &Config) -> String {
    let bindings = RuntimeBindings::from_keys_config(&current.keys);
    let default_rendered = config::render_default_config();
    // Re-render current config to normalize it before diffing.
    let current_rendered = render_config_for_diff(current, &bindings);
    if current_rendered == default_rendered {
        return "config matches defaults, so there are no differences\n".to_string();
    }
    unified_diff("default", "current", &default_rendered, &current_rendered)
}

fn run_diff_summary(current: &Config, out: &mut dyn std::io::Write) -> Result<()> {
    let changes = collect_config_changes(current);
    if changes.is_empty() {
        writeln!(out, "config matches defaults, so there are no differences")?;
    } else {
        for line in &changes {
            writeln!(out, "  {line}")?;
        }
    }
    Ok(())
}

/// Every setting whose current value differs from the default, as display lines.
///
/// Derived, never hand-maintained: `current` and [`Config::default()`] are both
/// projected to `serde_json::Value` and walked structurally, so a config key
/// added anywhere in the struct tree is reported without being registered here.
///
/// `serde_json` and not `toml` on purpose. TOML has no null and its serializer
/// omits a `None` struct field, which would make every default-`None` setting
/// (`defaults.start_directory`, the optional provider fields) invisible to the
/// comparison. JSON keeps them as an explicit null.
///
/// What is compared is the parsed file against [`Config::default()`]: neither
/// `load_config` nor `ProvidersConfig::ensure_defaults` runs, so the summary
/// reports what the file says rather than what yaran normalizes it into, with no
/// value clamping and no shipped provider injected into a config that does not
/// name it.
pub(crate) fn collect_config_changes(current: &Config) -> Vec<String> {
    let (Ok(default_json), Ok(current_json)) = (
        serde_json::to_value(Config::default()),
        serde_json::to_value(current),
    ) else {
        return Vec::new();
    };

    // Every path is printed through the one formatter, against the file's
    // own text where the config carries it (for the line a hidden name is
    // on): this summary is meant to be pasted, so a name that is not a
    // setting name (a token pasted where a key goes) never reaches it.
    let raw = current.source_text.as_str().unwrap_or_default();
    let mut found: Vec<(String, String)> = Vec::new();
    let mut path: Vec<String> = Vec::new();
    diff_node(raw, &mut found, &mut path, &default_json, &current_json);

    // Map iteration order differs by container (`IndexMap` for providers and
    // macros, `BTreeMap` for env and keys), so the order must be imposed here
    // rather than inherited. Sorting on the structural path, not on the rendered
    // line, keeps the ordering a property of the setting and not of its value.
    found.sort();
    found.into_iter().map(|(_, line)| line).collect()
}

/// What the differ does with one subtree.
///
/// There is deliberately no third "ignore this subtree" policy: a setting yaran
/// reads and never reports is silent drift. Something too sensitive or too
/// unstable to print is [`Policy::Summarize`]d, which still tells the user that
/// it changed.
enum Policy {
    /// An ordinary settings subtree: descend and report the leaves that differ.
    Recurse,
    /// Report that the subtree changed, never descend, never format its values.
    Summarize(Summary),
}

/// How a summarized subtree describes itself.
enum Summary {
    /// `env: changed`. The bare fact, with no shape to it at all.
    Changed,
    /// `macros: 2 macros configured`, for the given singular and plural nouns.
    Count(&'static str, &'static str),
}

/// How a key present on only one side is reported.
enum MissingStyle {
    /// `providers.foo: (added)` / `providers.foo: (removed)`. For a table whose
    /// entries are whole settings blocks, where printing the block would be
    /// noise.
    Marker,
    /// `keys.quit: (new) -> [ctrl-q]` / `keys.quit: [ctrl-q] -> (removed)`.
    Valued,
}

/// The policy for the subtree at `path`.
fn policy_for(path: &[String]) -> Policy {
    use yaran_core::config_keys::SensitiveAuthSetting;
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    match segments.as_slice() {
        // Holds API tokens. The value must never reach the terminal, a log, or a
        // pasted bug report, so this reports the fact and nothing else.
        ["env"] => Policy::Summarize(Summary::Changed),
        // An array index is not a stable identity and `ProjectConfig::id` can be
        // generated at deserialize time, so there is no honest per-project path
        // to print. Projects also carry their own `env`, which must stay
        // unprinted for the reason above.
        ["projects"] => Policy::Summarize(Summary::Count("project", "projects")),
        // A macro body is arbitrary user prose, frequently long and multi-line.
        // Counting them is what this command has always done.
        ["macros"] => Policy::Summarize(Summary::Count("macro", "macros")),
        // The auth settings no summary prints (the one list the previews
        // read too): the hash only as changed, the addresses as a count.
        _ => match yaran_core::config_keys::sensitive_auth_setting(path) {
            Some(SensitiveAuthSetting::PasswordHash) => Policy::Summarize(Summary::Changed),
            Some(SensitiveAuthSetting::BlockedAddresses) => {
                Policy::Summarize(Summary::Count("address", "addresses"))
            }
            None => Policy::Recurse,
        },
    }
}

/// How a key missing from one side of the subtree at `path` is reported.
fn missing_style_for(path: &[String]) -> MissingStyle {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    match segments.as_slice() {
        ["providers"] => MissingStyle::Marker,
        _ => MissingStyle::Valued,
    }
}

fn diff_node(
    raw: &str,
    found: &mut Vec<(String, String)>,
    path: &mut Vec<String>,
    default: &serde_json::Value,
    current: &serde_json::Value,
) {
    if default == current {
        return;
    }

    match policy_for(path) {
        Policy::Summarize(summary) => {
            let dotted = yaran_core::config::shown_path(raw, path);
            let line = match summary {
                Summary::Changed => format!("{dotted}: changed"),
                Summary::Count(singular, plural) => {
                    format!(
                        "{dotted}: {} configured",
                        yaran_core::text::count_of_with(collection_len(current), singular, plural)
                    )
                }
            };
            found.push((dotted, line));
        }
        Policy::Recurse => {
            if let (
                serde_json::Value::Object(default_map),
                serde_json::Value::Object(current_map),
            ) = (default, current)
            {
                let style = missing_style_for(path);
                let names: BTreeSet<&String> =
                    default_map.keys().chain(current_map.keys()).collect();
                for name in names {
                    path.push(name.clone());
                    match (default_map.get(name), current_map.get(name)) {
                        (Some(d), Some(c)) => diff_node(raw, found, path, d, c),
                        (Some(d), None) => {
                            push_missing(raw, found, path, &style, Side::DefaultOnly, d);
                        }
                        (None, Some(c)) => {
                            push_missing(raw, found, path, &style, Side::CurrentOnly, c);
                        }
                        (None, None) => {}
                    }
                    path.pop();
                }
            } else {
                // Every other shape, arrays included, is one value. `terminal.args`
                // and `server.allowed_hosts` are settings in their own right, not
                // parents of a `terminal.args.0`.
                let dotted = yaran_core::config::shown_path(raw, path);
                let line = format!(
                    "{dotted}: {} -> {}",
                    format_value(raw, path, default),
                    format_value(raw, path, current)
                );
                found.push((dotted, line));
            }
        }
    }
}

/// Which side of the comparison holds a key the other side lacks.
enum Side {
    DefaultOnly,
    CurrentOnly,
}

fn push_missing(
    raw: &str,
    found: &mut Vec<(String, String)>,
    path: &[String],
    style: &MissingStyle,
    side: Side,
    value: &serde_json::Value,
) {
    let dotted = yaran_core::config::shown_path(raw, path);
    let line = match (style, side) {
        (MissingStyle::Marker, Side::CurrentOnly) => format!("{dotted}: (added)"),
        (MissingStyle::Marker, Side::DefaultOnly) => format!("{dotted}: (removed)"),
        (MissingStyle::Valued, Side::CurrentOnly) => {
            format!("{dotted}: (new) -> {}", format_value(raw, path, value))
        }
        (MissingStyle::Valued, Side::DefaultOnly) => {
            format!("{dotted}: {} -> (removed)", format_value(raw, path, value))
        }
    };
    found.push((dotted, line));
}

fn collection_len(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(items) => items.len(),
        serde_json::Value::Object(map) => map.len(),
        _ => 0,
    }
}

/// Render one value the way the summary shows it: through the one value
/// printer (so a value at or below a key the formatter does not name is
/// never printed), unquoted, one line, truncated.
fn format_value(raw: &str, path: &[String], value: &serde_json::Value) -> String {
    use yaran_core::config_keys::{NOT_SHOWN, ValueForm, printed_value};
    if yaran_core::config::path_is_hidden(path) {
        return NOT_SHOWN.to_string();
    }
    let rendered = match value {
        // An absent optional setting. Matches what this command has always
        // printed for an unset `defaults.start_directory`.
        serde_json::Value::Null => "(unset)".to_string(),
        value => toml::Value::try_from(value)
            .ok()
            .and_then(|value| printed_value(raw, path, &value, ValueForm::Summary))
            .unwrap_or_else(|| NOT_SHOWN.to_string()),
    };
    truncate_display(&rendered, 40)
}

// ---------------------------------------------------------------------------
// yaran config regenerate
// ---------------------------------------------------------------------------

#[expect(
    deprecated,
    reason = "blessed sync-direct: `yaran config regenerate` is a CLI-only, one-shot boot tool"
)]
fn run_regenerate(
    paths: &YaranPaths,
    rewrite: ConfigRewrite,
    held_back: yaran_core::config_keys::HeldBack,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    let fresh = config::render_default_config();

    if rewrite == ConfigRewrite::Preview {
        refuse_dangling_config_link(paths)?;
        if paths.config_path.exists() {
            let current =
                fs::read_to_string(&paths.config_path).with_context_path(&paths.config_path)?;
            if current == fresh {
                writeln!(
                    out,
                    "config already matches defaults, so there is nothing to do"
                )?;
                return Ok(());
            }
            write!(out, "{}", regenerate_preview(&current, &fresh, held_back))?;
            if let Some(note) = regenerate_password_note(&current) {
                writeln!(out, "\n{note}")?;
            }
            writeln!(
                out,
                "\nRun `yaran config regenerate --yes` to overwrite with these defaults."
            )?;
        } else {
            writeln!(
                out,
                "no config file exists; regenerate --yes will create one at:"
            )?;
            writeln!(out, "  {}", paths.config_path.display())?;
        }
        return Ok(());
    }

    let note = fs::read_to_string(&paths.config_path)
        .ok()
        .and_then(|current| regenerate_password_note(&current));
    paths.ensure_dirs()?;
    yaran_core::config_write::write_config_secure(&paths.config_path, &fresh)
        .with_context_path(&paths.config_path)?;
    writeln!(out, "config regenerated at {}", paths.config_path.display())?;
    if let Some(note) = note {
        writeln!(out, "{note}")?;
    }
    Ok(())
}

/// Fresh defaults have no password, so regenerating a config that has one
/// opens the web UI to whoever can reach it. Said in words rather than left
/// to one line of the diff.
///
/// Looks at the text itself too, so a password inside a section yaran cannot
/// load (or a file that is not TOML) is still warned about.
fn regenerate_password_note(current: &str) -> Option<&'static str> {
    let loaded = yaran_core::config::auth_section_of(current).is_ok_and(|auth| auth.has_password());
    let written = current.lines().any(|line| {
        let Some(at) = line.find("password_hash") else {
            return false;
        };
        let Some(value) = line[at + "password_hash".len()..]
            .trim_start()
            .strip_prefix('=')
        else {
            return false;
        };
        let value = value.trim();
        !value.is_empty() && !value.starts_with("\"\"") && !value.starts_with("''")
    });
    (loaded || written).then_some(()).map(|()| {
        "Note: this removes the web UI password (server.auth.password_hash). Set it again \
             afterwards with `yaran config set server.auth.password`."
    })
}

// ---------------------------------------------------------------------------
// yaran config restore-docs
// ---------------------------------------------------------------------------

/// Re-apply the commented template to the existing config, keeping every value.
///
/// Non-destructive by default (preview only), mirroring `yaran config regenerate`:
/// `--yes` commits. Unlike `regenerate`, this never falls back to defaults: an
/// unparseable config is refused outright, because the whole point of the
/// command is to be the safe alternative to a defaults-based rewrite.
fn run_restore_docs(
    paths: &YaranPaths,
    rewrite: ConfigRewrite,
    held_back: yaran_core::config_keys::HeldBack,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    refuse_dangling_config_link(paths)?;
    if !paths.config_path.exists() {
        writeln!(
            out,
            "no config file found at {}",
            paths.config_path.display()
        )?;
        writeln!(
            out,
            "yaran writes a fully commented config the first time it starts."
        )?;
        return Ok(());
    }

    let raw = fs::read_to_string(&paths.config_path).with_context_path(&paths.config_path)?;

    // REFUSE on an unparseable config. Falling through to a defaults-based
    // regeneration here would destroy exactly the data (projects, macros,
    // provider commands, env values) this command exists to protect.
    let restored = config::restore_documentation(&raw).map_err(|e| {
        anyhow!(
            "{e:#}\n\n\
             Your config.toml has NOT been modified.\n\
             Fix the syntax error at {} and run this again. If you would rather \
             start over from defaults and lose your current settings, that is \
             `yaran config regenerate --yes`.",
            paths.config_path.display()
        )
    })?;

    if restored.is_noop(&raw) {
        writeln!(
            out,
            "config documentation is already up to date, so there is nothing to do"
        )?;
        return Ok(());
    }

    if rewrite == ConfigRewrite::Preview {
        write!(
            out,
            "{}",
            restore_docs_preview(&raw, &restored.text, held_back)
        )?;
        print_restore_report(&restored, out)?;
        writeln!(
            out,
            "\nRun `yaran config restore-docs --yes` to apply this (a timestamped backup"
        )?;
        writeln!(out, "of your current config is written first).")?;
        return Ok(());
    }

    // The config file exists, so its folder does; tighten it before the write
    // lock, the backup and the new file are created in it.
    yaran_core::file_modes::create_private_dir_all(&paths.root)?;

    // Back up BEFORE committing. The writer below is atomic, which protects
    // against a torn file, but not against "the result was not what I wanted".
    // Both happen inside the config write lock, on the file as it is NOW (a
    // `yaran config set` that landed since the preview above included), so the
    // [server.auth] written is the one the file holds at that moment.
    let (backup_path, restored) =
        yaran_core::config_write::replace_config_file(&paths.config_path, |current| {
            let current = current.ok_or_else(|| {
                anyhow!(
                    "{} disappeared; nothing was written",
                    paths.config_path.display()
                )
            })?;
            let restored = config::restore_documentation(current)?;
            let backup_path = backup_config(&paths.config_path, current)?;
            Ok((restored.text.clone(), (backup_path, restored)))
        })
        .with_context_path(&paths.config_path)?;

    writeln!(
        out,
        "documentation restored in {}",
        paths.config_path.display()
    )?;
    writeln!(
        out,
        "backup of the previous config: {}",
        backup_path.display()
    )?;
    print_restore_report(&restored, out)?;
    Ok(())
}

/// Print what the restore changed beyond adding comments. A dropped section is
/// reported even though its data was inert: a silent drop is still data loss.
fn print_restore_report(
    restored: &config::RestoredConfig,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    if !restored.dropped.is_empty() {
        writeln!(out, "\nRemoved (yaran no longer reads these):")?;
        for path in &restored.dropped {
            writeln!(out, "  [{path}]")?;
        }
    }
    if !restored.preserved.is_empty() {
        writeln!(
            out,
            "\nKept as-is (not settings yaran knows, carried over unchanged):"
        )?;
        for path in &restored.preserved {
            writeln!(out, "  {path}")?;
        }
    }
    // Not reachable through any config the canonical renderer can produce, and
    // printed anyway: a key that could not be placed is data loss, and the one
    // thing worse than losing it is losing it quietly.
    if !restored.unplaceable.is_empty() {
        writeln!(
            out,
            "\nCOULD NOT BE KEPT (this is a yaran bug, please report it, and \
             recover these from the backup above):"
        )?;
        for path in &restored.unplaceable {
            writeln!(out, "  {path}")?;
        }
    }
    Ok(())
}

/// Write `raw` beside the config as `config.toml.backup-<UTC timestamp>`.
///
/// Never overwrites: if a backup with this second-resolution name already
/// exists, a counter is appended, so repeated runs cannot clobber an earlier
/// safety copy. Created 0600 like the config itself, since it holds the same
/// potential secrets.
fn backup_config(config_path: &Path, raw: &str) -> Result<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let base = config_path.file_name().map_or_else(
        || "config.toml".to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let dir = config_path
        .parent()
        .ok_or_else(|| anyhow!("config path {} has no parent", config_path.display()))?;

    let mut candidate = dir.join(format!("{base}.backup-{stamp}"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base}.backup-{stamp}-{counter}"));
        counter += 1;
    }

    // Called inside the config write lock (see `run_restore_docs`); 0600.
    yaran_core::config_write::write_beside_config_locked(&candidate, raw)
        .with_context_path(&candidate)?;
    Ok(candidate)
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/// Truncate a display string, replacing the end with "..." if too long.
fn truncate_display(s: &str, max: usize) -> String {
    // For multiline values just show first line.
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.chars().count() > max {
        let truncated: String = first_line.chars().take(max).collect();
        format!("{truncated}...")
    } else if s.contains('\n') {
        format!("{first_line}...")
    } else {
        s.to_string()
    }
}

fn render_config_for_diff(config: &Config, bindings: &RuntimeBindings) -> String {
    // Use the same render_config used for default to ensure comparable output.
    // This is a re-render of the current config through the canonical renderer.
    config::render_config_with(config, bindings)
}

fn unified_diff(label_a: &str, label_b: &str, a: &str, b: &str) -> String {
    let diff = similar::TextDiff::from_lines(a, b);
    let mut out = format!("--- {label_a}\n+++ {label_b}\n");
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        let _ = writeln!(out, "{hunk}");
    }
    out
}

/// The user's file `raw` as a preview may print it: every line through the
/// one value printer's rules (see `config_keys::shown_file_text`), so a
/// plaintext password is never shown and, while `held_back` masks, nothing below a
/// hidden key or in `[env]` or `[projects]` either.
fn shown_for_preview(raw: &str, held_back: yaran_core::config_keys::HeldBack) -> Result<String> {
    yaran_core::config_keys::shown_file_text(raw, held_back, &crate::config::binding_is_understood)
}

/// The diff of `a` against `b`, each shown as a printer may show it; when
/// either is not TOML, only why nothing of it is shown.
fn preview(
    label_a: &str,
    label_b: &str,
    a: &str,
    b: &str,
    held_back: yaran_core::config_keys::HeldBack,
) -> String {
    match (
        shown_for_preview(a, held_back),
        shown_for_preview(b, held_back),
    ) {
        (Ok(a), Ok(b)) => unified_diff(label_a, label_b, &a, &b),
        (Err(error), _) | (_, Err(error)) => format!("{error:#}\n"),
    }
}

/// What `yaran config regenerate` previews: the user's file against the
/// fresh default, each side shown as a printer may show it.
pub(crate) fn regenerate_preview(
    current: &str,
    fresh: &str,
    held_back: yaran_core::config_keys::HeldBack,
) -> String {
    preview("current", "default", current, fresh, held_back)
}

/// What `yaran config restore-docs` previews: the user's file against the
/// documented one, each side shown as a printer may show it.
pub(crate) fn restore_docs_preview(
    raw: &str,
    restored: &str,
    held_back: yaran_core::config_keys::HeldBack,
) -> String {
    preview("current", "restored", raw, restored, held_back)
}

// ---------------------------------------------------------------------------
// Agent data reset
// ---------------------------------------------------------------------------

fn reset_agent_data(paths: &YaranPaths, report: &mut ResetReport) -> Result<()> {
    reset_agent_data_at_amq_root(paths, reset_amq_root(paths).as_deref(), report)
}

/// Refuse a whole-folder removal of `target` when it is, or sits inside, a
/// registered project: removing it would remove part of that project. A project
/// inside `target` is not refused here, because the reset keeps every folder a
/// project occupies (see `remove_session_worktree` and `sweep_worktrees_root`).
fn refuse_inside_a_project(target: &Path, protected: &[PathBuf]) -> Result<()> {
    let resolved = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let target_resolved = resolved(target);
    for project in protected {
        if resolved(project) == target_resolved
            || git::whole_workspace_target_is_within(project, target)?
        {
            bail!(
                "refusing to remove {} because it is inside the registered project {}",
                yaran_core::sanitize::for_terminal(&target.display().to_string()),
                yaran_core::sanitize::for_terminal(&project.display().to_string())
            );
        }
    }
    Ok(())
}

/// The AMQ root a factory reset frees owned inboxes under.
///
/// Tests see only the `amq` directory beside the yaran home and never the
/// `AMQ_GLOBAL_ROOT`/`AM_ROOT` environment: a developer machine that exports
/// those would otherwise have every reset test lock and inspect the real bus.
fn reset_amq_root(paths: &YaranPaths) -> Option<PathBuf> {
    if cfg!(test) {
        return paths
            .root
            .parent()
            .map(|parent| parent.join("amq"))
            .filter(|root| root.exists());
    }
    // The same AMQ root resolution the peer router uses.
    yaran_core::purge_amq::optional_amq_root(paths)
}

/// The factory reset, failing closed before its first change.
///
/// Every read-only inventory completes first: the config (strictly: a config
/// that does not parse would read as "no projects" and protect none), the
/// agent rows including soft-deleted ones, the protected-checkout list, the
/// store identity, and the exact ownership of every AMQ inbox. Every planned
/// whole-worktree removal is then checked against the protected-workspace
/// guard, and each isolated managed agent for containment in the managed root.
/// Any failure stops the reset with the file or row to repair, and nothing has
/// been touched.
///
/// Only then does it change anything: it stops what yaran started, frees the
/// exact-owned AMQ inboxes while the rows that prove ownership still exist,
/// then removes the worktrees, the root's leftovers, the database with its WAL
/// sidecars, and last the store identity.
///
/// Never removed: a shared-workspace agent's checkout (it is the user's
/// project), a standalone agent's folder, and anything a registered project
/// overlaps.
fn reset_agent_data_at_amq_root(
    paths: &YaranPaths,
    amq_root: Option<&Path>,
    report: &mut ResetReport,
) -> Result<()> {
    use anyhow::Context;
    let config_path = yaran_core::sanitize::for_terminal(&paths.config_path.display().to_string());
    let database_path =
        yaran_core::sanitize::for_terminal(&paths.sessions_db_path.display().to_string());
    let store_id_path =
        yaran_core::sanitize::for_terminal(&paths.root.join("store-id").display().to_string());
    let abort = "reset aborted before mutation";
    let config = yaran_core::purge::load_config_strict(paths).with_context(|| {
        format!("{abort}: repair {config_path} or run `yaran config regenerate --yes`, then retry")
    })?;
    let mut protected: Option<Vec<PathBuf>> = None;
    // Folders a standalone agent occupies: the sweep of the whole worktrees
    // root below is otherwise indiscriminate, and nothing stops a user pointing
    // a standalone agent at a directory inside yaran's managed area, which yaran
    // did not make.
    let mut occupied_folders: Vec<PathBuf> = Vec::new();
    // The same folders as recorded (never resolved), for the link rule: a
    // link in the root is kept when one of these is at or through it.
    let mut recorded_folders: Vec<PathBuf> = Vec::new();
    let seen_welcome = last_seen_welcome(paths);
    let mut sessions: Vec<yaran_core::model::AgentSession> = Vec::new();
    // What yaran recorded starting, this boot only: a session from another boot
    // is void.
    let mut recorded: Vec<yaran_core::process_sessions::StoredSession> = Vec::new();
    // Branches kept with left-over folders, with the repository each lives
    // in: they outlive the agent rows they came from.
    let mut kept_with_leftovers: Vec<(
        PathBuf,
        yaran_core::leftover_folders::LeftoverFolderRecord,
    )> = Vec::new();
    let mut histories = BranchHistories::new();
    if paths.sessions_db_path.exists() {
        let db = paths.sessions_db_path.display();
        let store = SessionStore::open(&paths.sessions_db_path).map_err(|error| {
            ResetRefused::unreadable_records(
                format_args!("the session database {db} could not be opened"),
                paths,
                error,
            )
        })?;
        // Soft-deleted agents too: their worktrees and inboxes are still there.
        sessions = store.load_sessions_including_deleted().map_err(|error| {
            ResetRefused::unreadable_records(
                format_args!("the agents recorded in {db} could not be read"),
                paths,
                error,
            )
        })?;
        // A standalone agent's folder is never removed, and neither is a shared
        // agent's checkout, which is the user's project. Filtered on the
        // workspace (the managed-root check passes one under that root) and
        // collected before any removal.
        for session in &sessions {
            if session.workspace.as_managed().is_none() || session.shared_workspace() {
                occupied_folders.push(canonical_or_original(Path::new(session.directory())));
                recorded_folders.push(PathBuf::from(session.directory()));
            }
        }
        // A project's repository is the user's too: a worktree that holds one
        // (a clone made inside it) is kept.
        let projects = store.load_projects().map_err(|error| {
            ResetRefused::unreadable_records(
                format_args!("the projects recorded in {db} could not be read"),
                paths,
                error,
            )
        })?;
        occupied_folders.extend(
            projects
                .iter()
                .map(|project| canonical_or_original(Path::new(&project.path))),
        );
        recorded_folders.extend(projects.iter().map(|project| PathBuf::from(&project.path)));
        kept_with_leftovers = branches_kept_with_leftovers(&store, &projects, paths)?;
        histories = branch_histories(&store, &sessions);
        recorded = store
            .load_process_registry_strict()
            .map_err(|error| ResetRefused::unknown(format_args!("{error}")))?
            .into_iter()
            .filter(|entry| entry.session.is_this_boot())
            .collect();
        protected = Some(
            yaran_core::purge::protected_project_paths(&config, &store, &sessions).with_context(
                || format!("{abort}: repair the project inventory in {config_path}, then retry"),
            )?,
        );
    }
    let protected = match protected {
        Some(protected) => protected,
        None => git::registered_project_paths(config.projects.iter().map(|p| p.path.as_str()))
            .with_context(|| {
                format!("{abort}: repair the project inventory in {config_path}, then retry")
            })?,
    };
    // Every registered project, the config's included, is a folder the reset
    // keeps, as it keeps the ones the database names.
    occupied_folders.extend(protected.iter().map(|path| canonical_or_original(path)));
    recorded_folders.extend(protected.iter().cloned());

    // The store identity proves which AMQ inboxes are this store's. Without an
    // AMQ root there are none to prove, and an install that never ran the AMQ
    // layer has never minted one, so its absence only matters when a root is
    // there.
    let amq_root = amq_root.filter(|root| root.exists());
    let store_id = match (yaran_core::storage::load_store_id(&paths.root), amq_root) {
        (Ok(id), _) => Some(id),
        (Err(_), None) => None,
        (Err(err), Some(_)) => {
            return Err(err).with_context(|| {
                format!(
                    "{abort}: restore {store_id_path}, then retry; without it, exact AMQ \
                     ownership cannot be proven and those directories require manual \
                     verification and removal"
                )
            });
        }
    };

    // The guard runs first, on the root wipe itself: a project inside the
    // worktrees root, or a root inside a project, stops everything.
    refuse_inside_a_project(&paths.worktrees_root, &protected).with_context(|| {
        format!("{abort}: repair overlapping project paths in {config_path}, then retry")
    })?;
    let isolated_managed = || {
        sessions.iter().filter_map(|session| {
            (!session.shared_workspace())
                .then(|| session.workspace.as_managed().map(|m| (session, m)))
                .flatten()
        })
    };
    for (session, managed) in isolated_managed() {
        let worktree = Path::new(&managed.worktree_path);
        let session_id = yaran_core::sanitize::for_terminal(&session.id);
        refuse_inside_a_project(worktree, &protected).with_context(|| {
            format!(
                "{abort}: repair session {session_id:?} in {database_path} or the project \
                 inventory in {config_path}, then retry"
            )
        })?;
        let within = git::whole_workspace_target_is_within(&paths.worktrees_root, worktree)
            .with_context(|| {
                format!("{abort}: repair session {session_id:?} in {database_path}, then retry")
            })?;
        if !within {
            bail!(
                "{abort}: session {session_id:?} in {database_path} points outside the managed \
                 root to {}; repair or remove that row, then retry",
                yaran_core::sanitize::for_terminal(&managed.worktree_path)
            );
        }
    }
    let mut owned_amq = Vec::new();
    if let (Some(root), Some(store_id)) = (amq_root, store_id.as_deref()) {
        for session in &sessions {
            let owned =
                yaran_core::purge_amq::amq_handle_is_exact_owner_at_root(root, store_id, session)
                    .with_context(|| {
                    format!(
                        "{abort}: repair the AMQ ownership marker for session {:?}, then \
                             retry; if ownership cannot be restored, verify and remove that \
                             inbox manually first",
                        yaran_core::sanitize::for_terminal(&session.id)
                    )
                })?;
            if owned {
                owned_amq.push(session);
            }
        }
    }
    // Nothing is deleted until everything yaran started has stopped and one last
    // look finds nothing left in the way.
    let removing = folders_reset_removes(paths, &sessions, &occupied_folders);
    stop_recorded_programs(paths, &recorded, report)?;
    ensure_nothing_runs(&recorded, &removing)?;

    // AMQ first, while the rows proving ownership still exist. A failure here
    // stops before any worktree or row is gone, so the reset can be re-run.
    if let (Some(root), Some(store_id)) = (amq_root, store_id.as_deref()) {
        for session in owned_amq {
            yaran_core::purge_amq::free_amq_handle_at_root(root, store_id, session)?;
        }
    }

    let mut removed: Vec<PathBuf> = Vec::new();
    for (session, managed) in isolated_managed() {
        let plan = yaran_core::branch_history::unasked_plan(
            managed,
            session.created_at,
            histories.get(&session.id).map_or(&[][..], Vec::as_slice),
        );
        match remove_session_worktree(paths, managed, &plan, &occupied_folders, &protected, report)
        {
            SessionWorktreeReset::Removed => removed.push(PathBuf::from(&managed.worktree_path)),
            SessionWorktreeReset::Skipped => {}
            SessionWorktreeReset::Left(failed) => {
                return Err(ResetFailed { removed, failed }.into());
            }
        }
    }
    report.say(format_args!("{}", removed_worktrees_line(removed.len())));

    // What the loop above could not account for goes with the root, except a folder
    // a standalone agent occupies; it stops at the first entry it cannot remove.
    // The guard runs again right before, as it does inside every removal.
    refuse_inside_a_project(&paths.worktrees_root, &protected)?;
    sweep_worktrees_root(
        &paths.worktrees_root,
        &occupied_folders,
        &recorded_folders,
        &mut removed,
        report,
    )?;
    delete_branches_kept_with_leftovers(&kept_with_leftovers, report);
    remove_file_with_message(&paths.sessions_db_path, report)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = paths.sessions_db_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        remove_file_with_message(Path::new(&sidecar), report)?;
    }
    // Every inbox this identity could prove it owned is gone, and a fresh
    // install should mint a fresh one.
    yaran_core::storage::remove_store_identity(&paths.root)?;
    // The welcome screen was already seen, and a reset does not make it new
    // again: the fresh database starts with that one record.
    if let Some(version) = seen_welcome {
        let kept = SessionStore::open(&paths.sessions_db_path)
            .and_then(|store| store.set_last_seen_version(&version));
        if let Err(error) = kept {
            report.warn(format_args!(
                "warning: could not keep the record that you saw the welcome screen, so it \
                 opens again on the next start: {error}"
            ));
        }
    }
    Ok(())
}

/// Every left-over folder record, with the repository its project lives in.
fn branches_kept_with_leftovers(
    store: &SessionStore,
    projects: &[yaran_core::config::ProjectConfig],
    paths: &YaranPaths,
) -> Result<Vec<(PathBuf, yaran_core::leftover_folders::LeftoverFolderRecord)>> {
    let db = paths.sessions_db_path.display();
    Ok(store
        .load_all_leftover_folders()
        .map_err(|error| {
            ResetRefused::unreadable_records(
                format_args!("the left-over worktree folders recorded in {db} could not be read"),
                paths,
                error,
            )
        })?
        .into_iter()
        .filter_map(|record| {
            projects
                .iter()
                .find(|project| project.id == record.project_id)
                .map(|project| (PathBuf::from(&project.path), record))
        })
        .collect())
}

/// Delete the branches left-over folders kept, now that the folders are gone
/// with the worktrees root, by the rule every unasked delete applies: only a
/// branch yaran created, and only while it still points at the commit recorded
/// for it. Best effort: a branch that stays is a warning.
fn delete_branches_kept_with_leftovers(
    kept: &[(PathBuf, yaran_core::leftover_folders::LeftoverFolderRecord)],
    report: &mut ResetReport,
) {
    for (repo, record) in kept {
        for branch in &record.branches {
            // Each kept branch by its own provenance: a record a later
            // removal recorded again holds branches of more than one agent.
            if !branch
                .provenance
                .is_some_and(|provenance| provenance.yaran_may_delete_branch())
            {
                continue;
            }
            let why = match git::delete_kept_branch(repo, branch) {
                Ok(git::KeptBranchDeletion::Deleted | git::KeptBranchDeletion::AlreadyGone) => {
                    continue;
                }
                Ok(git::KeptBranchDeletion::Moved) => {
                    "it changed since its folder was left behind".to_string()
                }
                Ok(git::KeptBranchDeletion::Refused { reason }) => {
                    format!("git refused to delete it ({reason})")
                }
                Ok(git::KeptBranchDeletion::Unverifiable) => {
                    "no commit was recorded for it".to_string()
                }
                Err(error) => format!("git could not check it ({error:#})"),
            };
            report.warn(format_args!(
                "warning: kept branch {} in {}: {why}",
                branch.name,
                repo.display()
            ));
        }
    }
}

/// The release whose welcome screen was last seen, read before the database
/// is deleted. Absent when there is no database or it holds no such record.
fn last_seen_welcome(paths: &YaranPaths) -> Option<String> {
    if !paths.sessions_db_path.exists() {
        return None;
    }
    let store = SessionStore::open(&paths.sessions_db_path).ok()?;
    store.last_seen_version().ok().flatten()
}

/// Every folder the reset will remove: each agent's managed worktree under
/// the worktrees root that holds nothing the user owns, and each entry of the
/// root itself that holds nothing the user owns (a standalone agent's folder,
/// a project's repository). Decided once, before anything is ended, so the
/// processes ended and the folders removed are the same set.
fn folders_reset_removes(
    paths: &YaranPaths,
    sessions: &[yaran_core::model::AgentSession],
    occupied: &[PathBuf],
) -> Vec<PathBuf> {
    let holds_something = |folder: &Path| {
        occupied
            .iter()
            .any(|kept| yaran_core::worktree_ops::folder_contains(folder, kept))
    };
    let mut removing: Vec<PathBuf> = sessions
        .iter()
        .filter_map(|session| session.workspace.as_managed())
        .map(|managed| PathBuf::from(&managed.worktree_path))
        .filter(|worktree| git::is_under(&paths.worktrees_root, worktree))
        .filter(|worktree| !holds_something(worktree))
        .collect();
    // Each entry at its own LEXICAL path. A link entry is only unlinked, so
    // it removes no folder: nothing working in its target is ever ended.
    if let Ok(entries) = fs::read_dir(&paths.worktrees_root) {
        removing.extend(
            entries
                .flatten()
                .filter(|entry| !entry.file_type().is_ok_and(|kind| kind.is_symlink()))
                .map(|entry| entry.path())
                .filter(|entry| !holds_something(entry)),
        );
    }
    // A managed worktree that is itself a link is only unlinked too.
    removing.retain(|folder| {
        !fs::symlink_metadata(folder).is_ok_and(|meta| meta.file_type().is_symlink())
    });
    removing
}

/// The grace a factory reset gives each process before forcing it. A config
/// yaran cannot load still gets a reset: the grace falls back to the default
/// rather than stopping the reset over an unrelated setting.
fn reset_grace(paths: &YaranPaths, report: &mut ResetReport) -> std::time::Duration {
    let timeout_seconds = match yaran_core::config::load_config(paths) {
        Ok(config) => config.shutdown_timeout_seconds,
        Err(error) => {
            report.warn(format_args!(
                "warning: could not read config.toml, so processes get the default grace \
                 period before they are forced to stop: {error}"
            ));
            yaran_core::config::Config::default().shutdown_timeout_seconds
        }
    };
    yaran_core::config::shutdown_grace(timeout_seconds)
}

/// Stop every program yaran recorded starting this boot, by its recorded identity, as an
/// agent delete does; an unreadable process list or a program that survives refuses the reset.
fn stop_recorded_programs(
    paths: &YaranPaths,
    recorded: &[yaran_core::process_sessions::StoredSession],
    report: &mut ResetReport,
) -> std::result::Result<(), ResetRefused> {
    use yaran_core::process_sessions as ps;
    if recorded.is_empty() {
        return Ok(());
    }
    let grace = reset_grace(paths, report);
    let mut running: Vec<ResetLeftover> = Vec::new();
    for entry in recorded {
        let table = ps::read_process_table_strict().map_err(ResetRefused::unknown)?;
        let members = ps::members(
            &table,
            &[entry.session],
            &entry.survivors,
            std::process::id(),
        );
        if members.is_empty() {
            continue;
        }
        let left = ps::end_exactly_with(&members, grace, &ps::read_process_table_strict)
            .map_err(ResetRefused::unknown)?;
        if !left.is_empty() {
            running.push(ResetLeftover {
                path: entry.folder.clone(),
                reason: format!("{} that yaran started would not stop", ps::describe(&left)),
            });
        }
    }
    if running.is_empty() {
        Ok(())
    } else {
        Err(ResetRefused {
            running,
            ..Default::default()
        })
    }
}

/// The last look before anything is deleted: nothing yaran recorded still runs, forked
/// children included, and no program of this user works in a folder about to go.
fn ensure_nothing_runs(
    recorded: &[yaran_core::process_sessions::StoredSession],
    removing: &[PathBuf],
) -> std::result::Result<(), ResetRefused> {
    use yaran_core::process_sessions as ps;
    let table = ps::read_process_table_strict().map_err(ResetRefused::unknown)?;
    let mut running: Vec<ResetLeftover> = Vec::new();
    for entry in recorded {
        let members = ps::members(
            &table,
            &[entry.session],
            &entry.survivors,
            std::process::id(),
        );
        if !members.is_empty() {
            running.push(ResetLeftover {
                path: entry.folder.clone(),
                reason: format!(
                    "{} that yaran started is still running",
                    ps::describe(&members)
                ),
            });
        }
    }
    if !removing.is_empty() {
        for who in ps::occupants_of(&table, removing).map_err(ResetRefused::unknown)? {
            running.push(ResetLeftover {
                path: who.cwd,
                reason: format!("process {} ({}) is working there", who.pid, who.command),
            });
        }
    }
    if running.is_empty() {
        Ok(())
    } else {
        Err(ResetRefused {
            running,
            ..Default::default()
        })
    }
}

/// Clear the worktrees root, keeping every entry that contains or canonically is a
/// standalone agent's folder; stops at the first failure, with `removed` extended so far.
fn sweep_worktrees_root(
    root: &Path,
    occupied: &[PathBuf],
    recorded: &[PathBuf],
    removed: &mut Vec<PathBuf>,
    report: &mut ResetReport,
) -> std::result::Result<(), ResetFailed> {
    if !root.exists() {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            return Err(ResetFailed {
                removed: std::mem::take(removed),
                failed: ResetLeftover {
                    path: root.to_path_buf(),
                    reason: format!("its contents could not be read: {error}"),
                },
            });
        }
    };
    let mut kept = 0usize;
    for entry in entries.flatten() {
        // Every entry is judged at its own LEXICAL path. A link is only
        // unlinked (its target stays), so it is kept only when something is
        // recorded at or through the link itself, never for what its target
        // holds.
        let path = entry.path();
        let link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
        let keep = if link {
            recorded
                .iter()
                .any(|folder| yaran_core::engine::recorded_at_or_through_link(&path, folder))
        } else {
            occupied
                .iter()
                .any(|folder| yaran_core::worktree_ops::folder_contains(&path, folder))
        };
        if keep {
            kept += 1;
            continue;
        }
        // A link is removed as a link, whatever it points at.
        let gone = if !link && entry.path().is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        };
        match gone {
            Ok(()) => removed.push(entry.path()),
            Err(error) => {
                return Err(ResetFailed {
                    removed: std::mem::take(removed),
                    failed: ResetLeftover {
                        path: entry.path(),
                        reason: error.to_string(),
                    },
                });
            }
        }
    }
    if kept > 0 {
        report.say(format_args!(
            "reset {} but kept {kept} entr{} a standalone agent is running in",
            root.display(),
            if kept == 1 { "y" } else { "ies" }
        ));
    } else if remove_dir_if_empty(root).unwrap_or(false) {
        report.say(format_args!("removed {}", root.display()));
    }
    Ok(())
}

/// Whether a managed worktree must be left standing because it IS, or CONTAINS,
/// a folder a standalone agent occupies.
///
/// The same rule [`sweep_worktrees_root`] applies to the root's own
/// entries, and compared the same way: canonically, so a symlinked spelling
/// cannot slip past. A worktree strictly INSIDE an occupied folder is not spared
/// here, deliberately: yaran made that worktree and resets what it made, and the
/// user's folder itself is still standing around it afterwards.
///
/// BOTH sides are canonicalized here, not just the worktree: the function's
/// contract is "any two spellings of the same ground answer truthfully", and
/// only one of the two callers canonicalizes the occupied list itself (the
/// factory reset does; the comparison in [`remove_worktrees_root_sparing`]
/// does too). A caller passing an un-canonicalized spelling (a symlinked temp
/// root on macOS, where `/var/folders` is reached through `/private/var/folders`)
/// would otherwise spare nothing, and an un-spared occupied folder is an
/// unconditional `remove_dir_all` on the user's data. Answering "not occupied"
/// is the wrong direction to be wrong in.
fn worktree_holds_occupied_folder(worktree: &Path, occupied: &[PathBuf]) -> bool {
    occupied
        .iter()
        .any(|folder| yaran_core::worktree_ops::folder_contains(worktree, folder))
}

/// Remove one agent's managed worktree during a factory reset. Returns whether
/// it was actually removed, so the caller's count cannot claim a skip.
///
/// It takes a [`ManagedWorkspace`], not a session, and that is the guard: this
/// function ends in an unconditional `remove_dir_all`, and the managed-root
/// path check below is not enough on its own, because a standalone agent
/// pointed at a directory under yaran's managed root would pass it.
///
/// `occupied` closes the other door: the worktree itself may be, or contain, a
/// folder a standalone agent occupies, and the `remove_dir_all` would take the
/// user's folder with it, so the whole removal is skipped and the reason
/// printed.
/// The factory reset's stdout summary, counting the worktrees it removed.
fn removed_worktrees_line(removed: usize) -> String {
    format!("removed {}", count_of(removed, "session worktree"))
}

/// Every branch each managed agent's worktree was on, by agent.
type BranchHistories =
    std::collections::HashMap<String, Vec<yaran_core::branch_history::BranchHistoryEntry>>;

/// Every branch each managed agent's worktree was on, which decides what the
/// reset may delete. A list that cannot be read leaves the agent's own two
/// recorded branches, which keeps more rather than less.
fn branch_histories(
    store: &SessionStore,
    sessions: &[yaran_core::model::AgentSession],
) -> BranchHistories {
    sessions
        .iter()
        .filter(|session| session.workspace.as_managed().is_some())
        .map(|session| {
            (
                session.id.clone(),
                store.load_branch_history(&session.id).unwrap_or_default(),
            )
        })
        .collect()
}

/// What the reset did with one agent's managed worktree.
enum SessionWorktreeReset {
    Removed,
    /// Deliberately left alone, and already said why.
    Skipped,
    /// It could not be removed; reported with the rest at the end.
    Left(ResetLeftover),
}

fn remove_session_worktree(
    paths: &YaranPaths,
    managed: &yaran_core::model::ManagedWorkspace,
    plan: &yaran_core::branch_history::BranchPlan,
    occupied: &[PathBuf],
    protected: &[PathBuf],
    report: &mut ResetReport,
) -> SessionWorktreeReset {
    let worktree = Path::new(&managed.worktree_path);
    if !git::is_under(&paths.worktrees_root, worktree) {
        report.warn(format_args!(
            "warning: skipping worktree outside of managed root: {}",
            managed.worktree_path
        ));
        return SessionWorktreeReset::Skipped;
    }
    // Refused before anything runs, git or `remove_dir_all`: a worktree that
    // is, contains, or sits inside a registered checkout is the user's data,
    // and the last-resort folder removal below would otherwise undo the guard
    // inside the git removal.
    if let Err(err) = git::guard_whole_workspace_removal(worktree, protected) {
        report.warn(format_args!(
            "warning: keeping {}: {err:#}",
            managed.worktree_path
        ));
        return SessionWorktreeReset::Skipped;
    }
    if worktree_holds_occupied_folder(worktree, occupied) {
        report.warn(format_args!(
            "warning: keeping {}: a standalone agent is running in that directory or one \
             inside it, and yaran never removes a folder it did not make",
            managed.worktree_path
        ));
        return SessionWorktreeReset::Skipped;
    }
    // Route through the shared core removal so the worktree is removed with the
    // correct `-C <repo>`, the repo's worktree registration is pruned, and the
    // branch is deleted afterward. Continue-on-error: a factory reset must
    // press on past any single failure.
    if let Some(project_path) = managed.project_path.as_deref() {
        // The same no-dialog plan the engine's unasked delete runs: only the
        // branch yaran made for the agent goes, pinned and only while git can
        // prove it is still that branch. A reset that deleted the user's
        // `develop` because an agent was once on it would be data loss.
        let remove = || {
            yaran_core::branch_history::remove_worktree_with_plan(
                Path::new(project_path),
                worktree,
                plan,
                managed.branch_provenance,
                protected,
            )
            .map(|_| ())
        };
        let first = remove();
        // Belt-and-suspenders for the factory-reset guarantee: ensure the
        // directory is gone even when git could not remove it. Core removal
        // never filesystem-deletes, so this stays the CLI's own last resort.
        if let Some(leftover) = remove_leftover_folder(worktree) {
            return leftover;
        }
        // A folder git let go of keeps the branches it was asked to delete;
        // with the folder now gone, the reset deletes them as it would have.
        if let Some(leftover) = first
            .as_ref()
            .err()
            .and_then(|err| err.downcast_ref::<git::LeftoverWorktreeFolder>())
        {
            git::delete_kept_branches_after_folder(Path::new(project_path), leftover);
        }
        // git refused while it still had the worktree registered (a lock, a
        // transient failure), so its registration, and the branch it was
        // asked to delete, are still there. With the folder gone, the same
        // call forgets exactly this registration (never a repository-wide
        // prune) and deletes the branches provenance allows.
        if first
            .as_ref()
            .err()
            .is_some_and(|err| err.downcast_ref::<git::RemovalWorthRetrying>().is_some())
            && let Err(err) = remove()
        {
            report.warn(format_args!(
                "warning: removed {} but could not forget its registration in {project_path}: \
                 {err:#}",
                worktree.display()
            ));
        }
        return SessionWorktreeReset::Removed;
    }

    // An orphan with no `project_path`: no repository to drive git.
    if let Some(leftover) = remove_leftover_folder(worktree) {
        return leftover;
    }
    SessionWorktreeReset::Removed
}

/// Delete what is left of a worktree folder, the reset's last resort; the
/// leftover when it cannot.
fn remove_leftover_folder(worktree: &Path) -> Option<SessionWorktreeReset> {
    if worktree.exists()
        && let Err(error) = fs::remove_dir_all(worktree)
    {
        return Some(SessionWorktreeReset::Left(ResetLeftover {
            path: worktree.to_path_buf(),
            reason: error.to_string(),
        }));
    }
    None
}

// ---------------------------------------------------------------------------
// File / directory helpers
// ---------------------------------------------------------------------------

/// Where the config says `yaran.log` and `server.log` are, or where they are by
/// default when there is no config or it does not parse.
fn resolve_reset_log_paths(paths: &YaranPaths) -> (PathBuf, PathBuf) {
    let config = if paths.config_path.exists() {
        fs::read_to_string(&paths.config_path)
            .ok()
            .and_then(|raw| toml::from_str::<config::Config>(&raw).ok())
            .unwrap_or_default()
    } else {
        config::Config::default()
    };
    (
        logger::resolve_log_path(&config.logging, paths),
        logger::resolve_server_log_path(&config.server, paths),
    )
}

/// Whether `path` reaches under `root` by plain folders, with no `..` and no symlinked
/// folder on the way; the last name may be a symlink, which removing only unlinks.
fn is_plainly_inside(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let names: Vec<_> = relative.components().collect();
    if names.is_empty() {
        return false;
    }
    let mut walked = root.to_path_buf();
    for (index, name) in names.iter().enumerate() {
        let std::path::Component::Normal(name) = name else {
            return false;
        };
        walked.push(name);
        let is_folder_on_the_way = index + 1 < names.len();
        if is_folder_on_the_way
            && fs::symlink_metadata(&walked).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return false;
        }
    }
    true
}

fn remove_file_with_message(path: &Path, report: &mut ResetReport) -> Result<()> {
    if remove_file_if_present(path)? {
        report.say(format_args!("removed {}", path.display()));
    }
    Ok(())
}

fn remove_root_if_empty_with_message(path: &Path, report: &mut ResetReport) -> Result<()> {
    if remove_dir_if_empty(path)? {
        report.say(format_args!("removed {}", path.display()));
    }
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(anyhow!("failed to remove {}: {error}", path.display())),
    }
}

fn remove_dir_if_empty(path: &Path) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| anyhow!("failed to inspect {}: {error}", path.display()))?;
    if entries.next().is_some() {
        return Ok(false);
    }
    fs::remove_dir(path)
        .map_err(|error| anyhow!("failed to remove {}: {error}", path.display()))?;
    Ok(true)
}

fn prune_empty_ancestors(path: &Path, root: &Path) -> Result<()> {
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(());
    };
    if relative.as_os_str().is_empty() {
        return Ok(());
    }

    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        if !remove_dir_if_empty(dir)? {
            break;
        }
        current = dir.parent();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Convenience extension for anyhow context on paths
// ---------------------------------------------------------------------------

trait WithContextPath<T> {
    fn with_context_path(self, path: &Path) -> Result<T>;
}

/// The whole cause chain is printed. Every error routed here is free of
/// parser text: config parse failures are described by position and kind
/// before they get this far, never by the line they quote.
impl<T, E: std::fmt::Display> WithContextPath<T> for std::result::Result<T, E> {
    fn with_context_path(self, path: &Path) -> Result<T> {
        self.map_err(|e| anyhow!("{}: {e:#}", path.display()))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
impl ResetReport {
    /// A report nobody reads, for the tests that drive a reset.
    fn discarding() -> Self {
        Self {
            out: Box::new(std::io::sink()),
            err: Box::new(std::io::sink()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;

    use chrono::Utc;
    use tempfile::TempDir;

    use super::*;

    /// A writer that refuses every write with its kind.
    struct Refusing(std::io::ErrorKind);

    impl std::io::Write for Refusing {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(self.0, "refused"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_config_result_whose_reader_went_away_ends_quietly_and_any_other_print_failure_is_said() {
        let mut printed = Vec::new();
        print_config_help(&mut ResultOut(&mut printed)).expect("printed");
        let help = String::from_utf8(printed).expect("text");
        assert!(
            help.starts_with("yaran config: manage the yaran configuration file\n"),
            "{help}"
        );
        for needle in [
            "This prints the WHOLE config, [env] values included: redact it before sharing",
            "asked for twice without echo, with a strength meter",
            "Remove config, logs and saved remotes (keeps agents and worktrees)",
        ] {
            assert!(help.contains(needle), "missing {needle}:\n{help}");
        }

        let gone = print_config_help(&mut ResultOut(Refusing(std::io::ErrorKind::BrokenPipe)));
        assert!(finish_config(gone).is_ok());

        let full = print_config_help(&mut ResultOut(Refusing(std::io::ErrorKind::StorageFull)));
        let failed = finish_config(full)
            .unwrap_err()
            .downcast::<yaran_core::client::CliError>()
            .unwrap();
        assert_eq!(
            failed,
            yaran_core::client::CliError::new(
                yaran_core::client::Exit::Failed,
                "could not print the result: refused"
            )
        );

        let own = finish_config(Err(anyhow!("unknown flag: --nope"))).unwrap_err();
        assert_eq!(own.to_string(), "unknown flag: --nope");
    }

    /// A config.toml that is a link to a file that is gone is not "no config
    /// file": the commands that read it say what the link points at.
    #[test]
    fn a_dangling_config_link_is_named_rather_than_read_as_no_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
            worktrees_root: tmp.path().join("worktrees"),
        };
        std::os::unix::fs::symlink(tmp.path().join("gone.toml"), &paths.config_path).expect("link");
        let held_back = yaran_core::config_keys::HeldBack::Masked;
        let outcomes = [
            run_diff(&paths, DiffForm::Summary, &mut Vec::new()),
            run_restore_docs(&paths, ConfigRewrite::Preview, held_back, &mut Vec::new()),
            run_regenerate(&paths, ConfigRewrite::Preview, held_back, &mut Vec::new()),
        ];
        for outcome in outcomes {
            let said = outcome.expect_err("refused").to_string();
            assert!(said.contains("gone.toml"), "{said}");
        }
        assert!(
            fs::symlink_metadata(&paths.config_path).is_ok_and(|meta| meta.is_symlink()),
            "the link is left alone"
        );
    }

    #[test]
    fn a_help_flag_asks_for_help_until_a_literal_double_dash() {
        let args = |a: &[&str]| {
            a.iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
        };
        assert!(asks_for_help(&args(&["get", "--help"])));
        assert!(asks_for_help(&args(&["set", "k", "v", "-h"])));
        assert!(!asks_for_help(&args(&["set", "k", "--", "--help"])));
        assert!(!asks_for_help(&args(&["set", "k", "v"])));
    }
    use crate::config::{self, Config};
    use crate::keybindings::RuntimeBindings;
    use crate::model::{AgentSession, ProviderKind, SessionStatus};

    /// A factory reset still runs on a config.toml yaran cannot load: the grace
    /// it gives each process falls back to the default instead of stopping the
    /// reset, and a loadable file's own setting is honoured.
    #[test]
    fn a_reset_grace_falls_back_to_the_default_when_the_config_will_not_load() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let default_grace = yaran_core::config::shutdown_grace(
            yaran_core::config::Config::default().shutdown_timeout_seconds,
        );
        fs::write(&paths.config_path, "this is [not toml\n").expect("write");
        assert!(yaran_core::config::load_config(&paths).is_err());
        assert_eq!(
            reset_grace(&paths, &mut ResetReport::discarding()),
            default_grace
        );

        fs::write(&paths.config_path, "shutdown_timeout_seconds = 3\n").expect("write");
        assert_eq!(
            reset_grace(&paths, &mut ResetReport::discarding()),
            yaran_core::config::shutdown_grace(3),
            "a loadable file's own grace is used",
        );
    }

    /// A startup command's job that yaran left running (recorded in
    /// the saved process registry for agent m1, in m1's worktree) is still
    /// running when `yaran config reset --all` runs. The reset ends it first and
    /// then removes everything, so nothing is left running in a folder that
    /// is gone.
    #[test]
    fn review21_factory_reset_removes_a_worktree_a_recorded_yaran_job_still_runs_in() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let worktree = paths.worktrees_root.join("proj").join("feat");
        fs::create_dir_all(&worktree).expect("worktree");
        let mut command = std::process::Command::new("sleep");
        command.arg("60").current_dir(&worktree);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn the job");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        let now = Utc::now();
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_session(&AgentSession {
                id: "m1".to_string(),
                slot_tab_id: "m1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Managed(
                    yaran_core::model::ManagedWorkspace {
                        project_id: "p1".to_string(),
                        project_path: None,
                        source_branch: "main".to_string(),
                        branch_name: "feat".to_string(),
                        initial_branch: "feat".to_string(),
                        branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                        worktree_path: worktree.to_string_lossy().to_string(),
                    },
                ),
                title: None,
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
                agent_handle: "m1".to_string(),
                deleted_at: None,
                shared_workspace: false,
            })
            .expect("upsert managed");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some("m1".to_string()),
                session,
                folder: worktree.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("an agent's startup command".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        run_reset(
            &paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        let still_running = job.try_wait().expect("try_wait").is_none();
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            !still_running,
            "the recorded yaran job (pid {}) was left running",
            job.id()
        );
        assert!(
            !worktree.exists(),
            "its worktree is removed once it stopped"
        );
        assert!(!paths.sessions_db_path.exists(), "the database goes too");
    }

    /// A project whose repository lives under the worktrees root is KEPT by
    /// the reset (a project's repository is the user's), but the project
    /// terminal's program recorded there is still stopped: the reset stops
    /// everything yaran started.
    #[test]
    fn a_factory_reset_stops_a_project_terminals_program_in_a_kept_repository() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let project_repo = paths.worktrees_root.join("vendor");
        fs::create_dir_all(&project_repo).expect("project dir");
        fs::write(project_repo.join("keep.txt"), "mine\n").expect("seed");
        let mut command = std::process::Command::new("sleep");
        command.arg("60").current_dir(&project_repo);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn the job");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_project(&yaran_core::config::ProjectConfig {
                id: "p2".to_string(),
                path: project_repo.to_string_lossy().into_owned(),
                name: Some("vendor".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: BTreeMap::default(),
                workspace_mode: None,
            })
            .expect("upsert project");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some(yaran_core::process_sessions::UNOWNED_PTYS.to_string()),
                session,
                folder: project_repo.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("a project terminal".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        let _ = reset_agent_data(&paths, &mut ResetReport::discarding());

        let alive = job.try_wait().expect("try_wait").is_none();
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            project_repo.join("keep.txt").exists(),
            "the repository is kept"
        );
        assert!(
            !alive,
            "the project terminal's job (pid {}) working in the project's repository {} \
             was left running",
            job.id(),
            project_repo.display()
        );
    }

    /// A project terminal's session (started at the project's repository,
    /// outside the worktrees root) has two processes: one job working in agent
    /// m1's worktree, and another working in the repository itself. Both are
    /// stopped, wherever they work.
    #[test]
    fn a_factory_reset_stops_a_terminal_job_working_outside_the_worktrees() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let worktree = paths.worktrees_root.join("proj").join("feat");
        fs::create_dir_all(&worktree).expect("worktree");
        // The leader works in the repository; its child in the worktree.
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg(format!(
                "(cd '{}' && exec sleep 61) & exec sleep 62",
                worktree.display()
            ))
            .current_dir(&repo);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn the job");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        std::thread::sleep(std::time::Duration::from_millis(300));
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some(yaran_core::process_sessions::UNOWNED_PTYS.to_string()),
                session,
                folder: repo.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("a project terminal".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        let _ = reset_agent_data(&paths, &mut ResetReport::discarding());

        let repo_job_alive = job.try_wait().expect("try_wait").is_none();
        // End the whole group we started, whatever the reset did.
        let _ = rustix::process::kill_process_group(
            rustix::process::Pid::from_raw(job.id().cast_signed()).unwrap(),
            rustix::process::Signal::KILL,
        );
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            !repo_job_alive,
            "a job a project terminal left working in the repository {} (pid {}) was left \
             running",
            repo.display(),
            job.id()
        );
    }

    /// Review 22: a project terminal's session (recorded under the unowned
    /// key, started at the project's repository, OUTSIDE the worktrees root)
    /// left a job running whose working directory is agent m1's worktree.
    /// The reset only looks at sessions started under the worktrees root, so
    /// it neither ends this job nor keeps the folder it works in.
    #[test]
    fn review22_factory_reset_removes_a_worktree_a_recorded_terminal_job_works_in() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let worktree = paths.worktrees_root.join("proj").join("feat");
        fs::create_dir_all(&worktree).expect("worktree");
        let mut command = std::process::Command::new("sleep");
        command.arg("60").current_dir(&worktree);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn the job");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        let now = Utc::now();
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_session(&AgentSession {
                id: "m1".to_string(),
                slot_tab_id: "m1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Managed(
                    yaran_core::model::ManagedWorkspace {
                        project_id: "p1".to_string(),
                        project_path: None,
                        source_branch: "main".to_string(),
                        branch_name: "feat".to_string(),
                        initial_branch: "feat".to_string(),
                        branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                        worktree_path: worktree.to_string_lossy().to_string(),
                    },
                ),
                title: None,
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
                agent_handle: "m1".to_string(),
                deleted_at: None,
                shared_workspace: false,
            })
            .expect("upsert managed");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some(yaran_core::process_sessions::UNOWNED_PTYS.to_string()),
                session,
                folder: repo.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("a project terminal".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        let _ = reset_agent_data(&paths, &mut ResetReport::discarding());

        let still_running = job.try_wait().expect("try_wait").is_none();
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            worktree.exists() || !still_running,
            "the reset removed {} while the yaran job recorded by a project terminal (pid {}) was still working in it",
            worktree.display(),
            job.id()
        );
    }

    /// A process a standalone agent's run left running is stopped like every
    /// other recorded one, and the reset then goes on; the agent's folder is
    /// the user's and stays.
    #[test]
    fn a_factory_reset_stops_a_recorded_standalone_process_and_keeps_its_folder() {
        struct Kill(std::process::Child);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().join("yaran"),
            config_path: tmp.path().join("yaran").join("config.toml"),
            sessions_db_path: tmp.path().join("yaran").join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("yaran").join("worktrees"),
            lock_path: tmp.path().join("yaran").join("dux.lock"),
            socket_path: tmp.path().join("yaran").join("yaran.sock"),
        };
        fs::create_dir_all(&paths.root).expect("root");
        let folder = tmp.path().join("my-notes");
        fs::create_dir_all(&folder).expect("folder");
        let mut command = std::process::Command::new("sleep");
        command.arg("60").current_dir(&folder);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = Kill(command.spawn().expect("spawn the job"));
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.0.id());
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some("s1".to_string()),
                session,
                folder: folder.clone(),
                standalone: true,
                survivors: Vec::new(),
                label: None,
            }])
            .expect("save the registry");
        drop(store);

        run_reset(
            &paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        assert!(
            job.0.try_wait().expect("try_wait").is_some(),
            "the standalone agent's process was stopped"
        );
        assert!(folder.exists(), "its folder is kept");
        assert!(!paths.sessions_db_path.exists(), "the database goes");
    }

    /// If yaran cannot read what it recorded starting, it cannot know nothing is
    /// running, so the reset deletes nothing and says why.
    #[test]
    fn a_factory_reset_deletes_nothing_when_the_recorded_programs_cannot_be_read() {
        // A body that is not text, and a text body that is not a registry.
        for body in ["x'ff'", "'this is not json'"] {
            let harness = ResetHarness::new();
            harness.write_config_with_log_path("logs/custom.log");
            let worktree = harness.create_session("agent-1");
            let store = SessionStore::open(&harness.paths.sessions_db_path).expect("store");
            store.replace_process_registry(&[]).expect("registry row");
            drop(store);
            let conn = rusqlite::Connection::open(&harness.paths.sessions_db_path).expect("raw");
            conn.execute(
                &format!("update process_registry set body = {body} where id = 1"),
                [],
            )
            .expect("make the body unreadable");
            drop(conn);

            let refusal = run_reset(
                &harness.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding(),
            )
            .expect_err("the reset refuses");

            let message = format!("{refusal:#}");
            assert!(
                message.contains("could not check which programs are still running"),
                "{body}: {message}"
            );
            assert!(message.contains("deleted nothing"), "{body}: {message}");
            assert!(worktree.exists(), "{body}");
            assert!(harness.paths.config_path.exists(), "{body}");
            assert!(harness.paths.sessions_db_path.exists(), "{body}");
        }
    }

    /// Without the project or agent records yaran cannot tell which folders under
    /// the worktrees root are a user's, so the reset deletes nothing and says
    /// how to get past the unreadable record.
    #[test]
    fn a_factory_reset_deletes_nothing_when_its_records_cannot_be_read() {
        // An unreadable agent row already stops the database from opening.
        for (what, failed, corrupt) in [
            (
                "the projects recorded in",
                "read",
                "insert into projects (id, path, created_at, updated_at) \
                 values ('p', x'ff', 'now', 'now')",
            ),
            (
                "the session database",
                "opened",
                "update agent_sessions set created_at = x'ff'",
            ),
        ] {
            let harness = ResetHarness::new();
            harness.write_config_with_log_path("logs/custom.log");
            let worktree = harness.create_session("agent-1");
            let conn = rusqlite::Connection::open(&harness.paths.sessions_db_path).expect("raw");
            conn.execute(corrupt, []).expect("an unreadable row");
            drop(conn);

            let refusal = run_reset(
                &harness.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding(),
            )
            .expect_err("the reset refuses");

            let message = format!("{refusal:#}");
            let db = harness.paths.sessions_db_path.display();
            let worktrees = harness.paths.worktrees_root.display();
            let head = format!(
                "yaran config reset --all deleted nothing: {what} {db} could not be {failed}, so \
                 yaran cannot tell which folders under {worktrees} are yours ("
            );
            let tail = format!(
                "). To reset anyway, quit yaran and anything it started, move anything of yours \
                 out of {worktrees} (a project kept inside it would be removed with it), delete \
                 {db} yourself, and run the reset again. Or repair the named row in {db}, or \
                 restore {db}.bak, the copy yaran keeps of it, and retry."
            );
            assert!(message.starts_with(&head), "{what}: {message}");
            assert!(message.ends_with(&tail), "{what}: {message}");
            assert!(worktree.exists(), "{what}");
            assert!(harness.paths.config_path.exists(), "{what}");
            assert!(harness.paths.sessions_db_path.exists(), "{what}");
        }
    }

    /// A factory reset must not remove a STANDALONE agent's folder, even when
    /// the user pointed that agent at a directory inside yaran's own managed
    /// area. The per-session loop already skips it; the sweep of the whole
    /// worktrees root afterwards did not, so the guard held for one line and
    /// then the directory went anyway.
    ///
    /// Nothing refuses a folder under the managed root at creation, so this is
    /// reachable, not theoretical.
    #[test]
    fn a_factory_reset_keeps_a_standalone_agents_folder_inside_the_managed_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        // A managed worktree yaran made, and a standalone folder the user chose
        // that happens to live beside it under the same root.
        let managed = paths.worktrees_root.join("proj").join("feat");
        let occupied = paths.worktrees_root.join("my-notes");
        fs::create_dir_all(&managed).expect("managed dir");
        fs::create_dir_all(&occupied).expect("occupied dir");
        fs::write(occupied.join("notes.txt"), "mine\n").expect("seed a file");

        let now = Utc::now();
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_session(&AgentSession {
                id: "sa1".to_string(),
                agent_handle: "sa1".to_string(),
                shared_workspace: false,
                deleted_at: None,
                slot_tab_id: "sa1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Folder(
                    yaran_core::model::FolderWorkspace {
                        folder_path: occupied.to_string_lossy().to_string(),
                    },
                ),
                title: Some("my-notes".to_string()),
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
            })
            .expect("upsert standalone");
        drop(store);

        reset_agent_data(&paths, &mut ResetReport::discarding()).expect("reset");

        assert!(
            occupied.exists(),
            "a standalone agent's folder is the user's and survives a factory reset"
        );
        assert_eq!(
            fs::read_to_string(occupied.join("notes.txt")).expect("the file survives"),
            "mine\n",
            "and so does everything in it"
        );
        assert!(
            !managed.exists(),
            "yaran's own managed worktree is still reset: it made that one"
        );
    }

    /// The other door into the same data loss: the folder is not beside the
    /// managed worktrees, it is INSIDE one. The removal of that worktree ends in
    /// an unconditional `remove_dir_all`, so it took the user's folder with it,
    /// and which of the two rows the loader returned first decided whether it
    /// happened at all.
    ///
    /// Reachable: point a standalone agent at an empty directory under the
    /// managed root, then create a managed agent whose worktree lands on it.
    #[test]
    fn a_factory_reset_keeps_a_standalone_folder_inside_a_managed_worktree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let managed_worktree = paths.worktrees_root.join("proj").join("feat");
        let occupied = managed_worktree.join("notes");
        fs::create_dir_all(&occupied).expect("occupied dir");
        fs::write(occupied.join("notes.txt"), "mine\n").expect("seed a file");

        let now = Utc::now();
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        // The MANAGED row first, so the loader's order is the hostile one even
        // without relying on how it sorts.
        store
            .upsert_session(&AgentSession {
                id: "m1".to_string(),
                agent_handle: "m1".to_string(),
                shared_workspace: false,
                deleted_at: None,
                slot_tab_id: "m1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Managed(
                    yaran_core::model::ManagedWorkspace {
                        project_id: "p1".to_string(),
                        // No owning repo, so the removal is the CLI's own
                        // `remove_dir_all` and no git subprocess runs.
                        project_path: None,
                        source_branch: "main".to_string(),
                        branch_name: "feat".to_string(),
                        initial_branch: "feat".to_string(),
                        branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                        worktree_path: managed_worktree.to_string_lossy().to_string(),
                    },
                ),
                title: None,
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
            })
            .expect("upsert managed");
        store
            .upsert_session(&AgentSession {
                id: "sa1".to_string(),
                agent_handle: "sa1".to_string(),
                shared_workspace: false,
                deleted_at: None,
                slot_tab_id: "sa1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Folder(
                    yaran_core::model::FolderWorkspace {
                        folder_path: occupied.to_string_lossy().to_string(),
                    },
                ),
                title: Some("notes".to_string()),
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
            })
            .expect("upsert standalone");
        drop(store);

        reset_agent_data(&paths, &mut ResetReport::discarding()).expect("reset");

        assert_eq!(
            fs::read_to_string(occupied.join("notes.txt")).expect("the folder survives"),
            "mine\n",
            "a standalone agent's folder survives even when a managed worktree encloses it"
        );
    }

    /// A yaran project's repository inside a managed worktree survives a
    /// factory reset: the project is the user's, like a standalone folder.
    #[test]
    fn a_factory_reset_keeps_a_projects_repository_inside_a_managed_worktree() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let managed_worktree = paths.worktrees_root.join("proj").join("feat");
        let project_repo = managed_worktree.join("vendor");
        fs::create_dir_all(&project_repo).expect("project dir");
        fs::write(project_repo.join("keep.txt"), "mine\n").expect("seed a file");
        let now = Utc::now();
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_session(&AgentSession {
                id: "m1".to_string(),
                slot_tab_id: "m1-slot".to_string(),
                provider: ProviderKind::new("claude"),
                workspace: yaran_core::model::AgentWorkspace::Managed(
                    yaran_core::model::ManagedWorkspace {
                        project_id: "p1".to_string(),
                        project_path: None,
                        source_branch: "main".to_string(),
                        branch_name: "feat".to_string(),
                        initial_branch: "feat".to_string(),
                        branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                        worktree_path: managed_worktree.to_string_lossy().to_string(),
                    },
                ),
                title: None,
                started_providers: Vec::new(),
                desired_running: false,
                auto_reopen_enabled: false,
                status: SessionStatus::Detached,
                created_at: now,
                updated_at: now,
                last_focused_tab: None,
                agent_handle: "m1".to_string(),
                deleted_at: None,
                shared_workspace: false,
            })
            .expect("upsert managed");
        store
            .upsert_project(&yaran_core::config::ProjectConfig {
                id: "p2".to_string(),
                path: project_repo.to_string_lossy().into_owned(),
                name: Some("vendor".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: BTreeMap::default(),
                workspace_mode: None,
            })
            .expect("upsert project");
        drop(store);

        reset_agent_data(&paths, &mut ResetReport::discarding()).expect("reset");

        assert!(
            project_repo.join("keep.txt").exists(),
            "a project's repository survives a reset even when a managed worktree encloses it"
        );
    }

    /// The skip rule itself, on the four ways two paths can overlap. Only the
    /// two where removing the worktree would take the user's folder with it are
    /// spared.
    #[test]
    fn the_reset_skip_rule_spares_a_worktree_that_is_or_holds_an_occupied_folder() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let worktree = root.join("wt");
        fs::create_dir_all(worktree.join("inner")).expect("dirs");
        fs::create_dir_all(root.join("elsewhere")).expect("dirs");

        // Equal: the standalone agent is running in the worktree itself.
        assert!(worktree_holds_occupied_folder(
            &worktree,
            std::slice::from_ref(&worktree)
        ));
        // The worktree CONTAINS the folder: removing it recursively takes the
        // folder with it.
        assert!(worktree_holds_occupied_folder(
            &worktree,
            &[worktree.join("inner")]
        ));
        // The folder CONTAINS the worktree: yaran made the worktree, so it goes,
        // and the user's folder is still there around it.
        assert!(!worktree_holds_occupied_folder(
            &worktree.join("inner"),
            std::slice::from_ref(&worktree)
        ));
        // Disjoint.
        assert!(!worktree_holds_occupied_folder(
            &worktree,
            &[root.join("elsewhere")]
        ));
        // Nothing occupied at all is the ordinary reset.
        assert!(!worktree_holds_occupied_folder(&worktree, &[]));

        // The occupied list may arrive in a different spelling than the
        // worktree: a standalone agent's directory is stored as it was given,
        // and a symlinked ancestor (macOS `/var` for `/private/var`, an alias
        // the user made) must not let the skip rule miss the folder it protects.
        // This is the case the function must answer correctly on its own,
        // because not every caller canonicalizes the list before passing it.
        let alias = root.join("wt-alias");
        std::os::unix::fs::symlink(&worktree, &alias).expect("worktree alias");
        assert!(
            worktree_holds_occupied_folder(&worktree, &[alias]),
            "an occupied folder spelled through a symlink must still match the worktree it is"
        );
    }

    #[test]
    fn config_diff_reports_nothing_for_a_default_config() {
        assert!(
            collect_config_changes(&Config::default()).is_empty(),
            "{:#?}",
            collect_config_changes(&Config::default())
        );
    }

    #[test]
    fn config_diff_reports_the_first_load_screen_opt_outs() {
        // Both keys are hand-registered in `collect_config_changes`; a key that
        // is missing there is one `yaran config diff` silently ignores.
        let mut config = Config::default();
        config.ui.disable_automated_welcome_screen = true;
        config.ui.disable_release_notes = true;

        // Match the EXACT rendered line, not a substring of the key: a
        // `contains("ui.disable_release_notes")` check also matches a typo'd
        // `ui.disable_release_notes_xyz`, which makes the test useless as a guard.
        let changes = collect_config_changes(&config);
        assert!(
            changes.contains(&"ui.disable_automated_welcome_screen: false -> true".to_string()),
            "{changes:#?}"
        );
        assert!(
            changes.contains(&"ui.disable_release_notes: false -> true".to_string()),
            "{changes:#?}"
        );
        assert_eq!(changes.len(), 2, "nothing else should have changed");
    }

    // -----------------------------------------------------------------------
    // yaran config diff (summary)
    // -----------------------------------------------------------------------

    /// A string no default value contains, so its presence in the output can
    /// only have come from the fixture that planted it.
    const SENTINEL: &str = "sentinel-do-not-print-me-9f3a";

    /// Every path the differ must be able to report, discovered by walking the
    /// serialized default config rather than by anyone listing them.
    ///
    /// Returns `(dotted path, config with exactly that leaf mutated)`.
    fn mutated_leaf_fixtures() -> Vec<(String, Config)> {
        let default = serde_json::to_value(Config::default()).expect("serialize default config");
        assert_eq!(
            serde_json::from_value::<Config>(default.clone()).expect("round-trip default config"),
            Config::default(),
            "the differ compares a JSON projection, so the projection must be lossless"
        );

        let mut fixtures = Vec::new();
        let mut path = Vec::new();
        walk_default_leaves(&default, &default, &mut path, &mut fixtures);
        assert!(
            fixtures.len() > 40,
            "the walk found only {} leaves; the config is much bigger than that",
            fixtures.len()
        );
        fixtures
    }

    /// Top-level subtrees the differ deliberately summarizes instead of
    /// descending into. They are covered by their own fixtures below, because
    /// their reported line is not a leaf path.
    const SUMMARIZED_SUBTREES: &[&str] = &["env", "projects", "macros"];

    fn walk_default_leaves(
        root: &serde_json::Value,
        node: &serde_json::Value,
        path: &mut Vec<String>,
        out: &mut Vec<(String, Config)>,
    ) {
        if path.len() == 1 && SUMMARIZED_SUBTREES.contains(&path[0].as_str()) {
            return;
        }
        match node {
            serde_json::Value::Object(map) => {
                assert!(
                    !map.is_empty(),
                    "no mutation policy for the empty object at {}: decide whether it \
                     recurses or is summarized, then teach this walk about it",
                    path.join(".")
                );
                for (name, child) in map {
                    path.push(name.clone());
                    walk_default_leaves(root, child, path, out);
                    path.pop();
                }
            }
            other => {
                let dotted = path.join(".");
                let mutated = mutate_leaf(root, path, other).unwrap_or_else(|| {
                    panic!(
                        "no candidate mutation for the leaf at {dotted} ({other}); \
                         add one so this exhaustiveness check keeps working"
                    )
                });
                out.push((dotted, mutated));
            }
        }
    }

    /// Replace the leaf at `path` with a different value of the same shape and
    /// deserialize the result. `None` when nothing produced a valid `Config`.
    fn mutate_leaf(
        root: &serde_json::Value,
        path: &[String],
        leaf: &serde_json::Value,
    ) -> Option<Config> {
        let candidates: Vec<serde_json::Value> = match leaf {
            serde_json::Value::Bool(b) => vec![serde_json::Value::Bool(!b)],
            serde_json::Value::Number(n) => {
                let raised = n.as_u64().map(|v| serde_json::json!(v + 1));
                let lowered = n
                    .as_u64()
                    .and_then(|v| v.checked_sub(1))
                    .map(|v| serde_json::json!(v));
                raised.into_iter().chain(lowered).collect()
            }
            // Settings that validate their string (an enum, a password hash)
            // refuse the appended form, so a few values that pass each kind of
            // check follow it.
            serde_json::Value::String(s) => [
                format!("{s}-mutated"),
                "tailnet".to_string(),
                "always".to_string(),
                a_valid_password_hash(),
                // A leaf whose type is a CLOSED SET (a serde enum such as
                // `oneshot_output` or the workspace mode) refuses anything
                // else, so its other spellings are offered too.
                "stdout".to_string(),
                "tempfile".to_string(),
                "shared".to_string(),
                "worktree".to_string(),
            ]
            .into_iter()
            // The value already there is no mutation at all.
            .filter(|candidate| candidate != s)
            .map(|candidate| serde_json::json!(candidate))
            .collect(),
            serde_json::Value::Array(items) => ["yaran-diff-probe", "192.0.2.1"]
                .into_iter()
                .map(|probe| {
                    let mut grown = items.clone();
                    grown.push(serde_json::json!(probe));
                    serde_json::Value::Array(grown)
                })
                // An array of TABLES (a provider's `watch` rules) refuses a
                // string element, so a minimal table-shaped one is offered too.
                .chain(std::iter::once({
                    let mut grown = items.clone();
                    grown.push(serde_json::json!({
                        "pattern": "yaran-diff-probe",
                        "action": "send_text",
                        "text": "yaran-diff-probe",
                    }));
                    serde_json::Value::Array(grown)
                }))
                .collect(),
            // A null carries no type, so try each shape an `Option` field can take.
            serde_json::Value::Null => vec![
                serde_json::json!("yaran-diff-probe"),
                serde_json::json!(4321),
                serde_json::json!(true),
                serde_json::json!(["yaran-diff-probe"]),
            ],
            serde_json::Value::Object(_) => Vec::new(),
        };

        for candidate in candidates {
            let mut document = root.clone();
            let mut cursor = &mut document;
            for segment in path {
                cursor = cursor
                    .get_mut(segment)
                    .expect("path exists in the default document");
            }
            *cursor = candidate;
            if let Ok(config) = serde_json::from_value::<Config>(document) {
                return Some(config);
            }
        }
        None
    }

    #[test]
    fn config_diff_reports_the_cloud_mode() {
        let mut config = Config::default();
        config.cloud.mode = "no".to_string();
        assert_eq!(
            collect_config_changes(&config),
            vec!["cloud.mode: auto -> no".to_string()]
        );
    }

    #[test]
    fn config_diff_reports_the_tailscale_mode() {
        // The exhaustiveness walk below covers this structurally, but the walk
        // mutates a string by appending to it, and this particular setting has a
        // lenient deserializer that also accepts a boolean. Naming it here proves
        // the leaf is genuinely reachable and reported as a value change rather
        // than being quietly rejected on the way in.
        let mut config = Config::default();
        config.server.tailscale = "no".to_string();
        assert_eq!(
            collect_config_changes(&config),
            vec!["server.tailscale: auto -> no".to_string()]
        );
    }

    fn a_valid_password_hash() -> String {
        static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        HASH.get_or_init(|| {
            yaran_core::auth::hash_password(&yaran_core::auth::Password::new(
                "correct horse battery staple".to_string(),
            ))
            .expect("hash")
        })
        .clone()
    }

    /// A pasted bug report must not carry the password hash: anyone holding
    /// it can guess offline. The summary says only that it changed.
    #[test]
    fn config_diff_never_prints_the_password_hash() {
        let mut config = Config::default();
        config.server.auth.password_hash = a_valid_password_hash();
        let changes = collect_config_changes(&config);
        assert_eq!(
            changes,
            vec!["server.auth.password_hash: changed".to_string()]
        );
        assert!(!changes.concat().contains("argon2id"), "{changes:?}");
    }

    /// Blocked addresses are other people's IP addresses; the summary counts
    /// them instead of listing them.
    #[test]
    fn config_diff_counts_blocked_addresses_without_printing_them() {
        let mut config = Config::default();
        config.server.auth.blocked_addresses =
            vec!["203.0.113.7".to_string(), "198.51.100.0/24".to_string()];
        let changes = collect_config_changes(&config);
        assert_eq!(
            changes,
            vec!["server.auth.blocked_addresses: 2 addresses configured".to_string()]
        );
    }

    #[test]
    fn regenerate_warns_that_it_removes_a_password() {
        let with = format!(
            "[server.auth]\npassword_hash = \"{}\"\n",
            a_valid_password_hash()
        );
        assert!(regenerate_password_note(&with).is_some_and(|n| n.contains("password")));
        assert_eq!(regenerate_password_note("[server]\nport = 1\n"), None);
        // Still warned about when the section around it is invalid, or the
        // file is not even TOML: the password is in there either way.
        for broken in [
            "[server.auth]\npassword_hash = \"$argon2id$v=19$whatever\"\nrequire = \"lan\"\n",
            "[server.auth\npassword_hash = \"x\"\n",
        ] {
            assert!(regenerate_password_note(broken).is_some(), "{broken}");
        }
        assert_eq!(
            regenerate_password_note("[server.auth]\npassword_hash = \"\"\n"),
            None,
            "an empty hash is no password"
        );
    }

    #[test]
    fn config_diff_reports_every_leaf_of_the_default_config() {
        let mut unreported = Vec::new();
        for (dotted, config) in mutated_leaf_fixtures() {
            let changes = collect_config_changes(&config);
            let prefix = format!("{dotted}: ");
            let matching: Vec<&String> =
                changes.iter().filter(|l| l.starts_with(&prefix)).collect();
            if matching.len() != 1 {
                unreported.push(format!("{dotted} -> {changes:?}"));
            }
        }
        assert!(
            unreported.is_empty(),
            "these settings are not reported by `yaran config diff`:\n{}",
            unreported.join("\n")
        );
    }

    #[test]
    fn config_diff_marks_a_provider_present_only_in_the_current_config() {
        let mut config = Config::default();
        config.providers.commands.insert(
            "mine".to_string(),
            config::ProviderCommandConfig {
                command: "mine".to_string(),
                ..Default::default()
            },
        );

        assert_eq!(
            collect_config_changes(&config),
            vec!["providers.mine: (added)".to_string()]
        );
    }

    #[test]
    fn config_diff_marks_a_provider_present_only_in_the_default_config() {
        let mut config = Config::default();
        let removed = config
            .providers
            .commands
            .keys()
            .next()
            .expect("the default config ships providers")
            .clone();
        config.providers.commands.shift_remove(&removed);

        assert_eq!(
            collect_config_changes(&config),
            vec![format!("providers.{removed}: (removed)")]
        );
    }

    #[test]
    fn config_diff_recurses_into_a_provider_present_on_both_sides() {
        let mut config = Config::default();
        let entry = config
            .providers
            .commands
            .get_mut("claude")
            .expect("the default config ships a claude provider");
        entry.command = "claude-next".to_string();
        entry.args = vec!["--dangerously".to_string()];

        assert_eq!(
            collect_config_changes(&config),
            vec![
                "providers.claude.args: [] -> [--dangerously]".to_string(),
                "providers.claude.command: claude -> claude-next".to_string(),
            ]
        );
    }

    #[test]
    fn config_diff_never_names_a_provider_whose_name_breaks_the_rule() {
        let mut config = Config::default();
        config.providers.commands.insert(
            "my agent.v2".to_string(),
            config::ProviderCommandConfig::default(),
        );

        assert_eq!(
            collect_config_changes(&config),
            vec!["an entry of [providers] whose name is not shown: (added)".to_string()]
        );
    }

    #[test]
    fn config_diff_reports_an_array_as_one_value_not_as_indexed_paths() {
        let mut config = Config::default();
        config.server.allowed_hosts = vec!["yaran.local".to_string(), "yaran.lan".to_string()];
        config.terminal.args = vec!["-l".to_string(), "-i".to_string()];

        let changes = collect_config_changes(&config);
        assert!(
            changes.contains(&"server.allowed_hosts: [] -> [yaran.local, yaran.lan]".to_string()),
            "{changes:#?}"
        );
        assert!(
            changes.contains(&"terminal.args: [-l] -> [-l, -i]".to_string()),
            "{changes:#?}"
        );
        assert!(
            !changes
                .iter()
                .any(|l| l.contains(".0:") || l.contains(".1:")),
            "an array must never be reported as indexed paths: {changes:#?}"
        );
    }

    #[test]
    fn config_diff_never_prints_a_global_env_value() {
        let mut config = Config::default();
        config
            .env
            .insert("ANTHROPIC_API_KEY".to_string(), SENTINEL.to_string());

        let changes = collect_config_changes(&config);
        assert_eq!(changes, vec!["env: changed".to_string()]);
        assert!(
            !changes.join("\n").contains(SENTINEL),
            "an env value must never reach the summary"
        );
    }

    #[test]
    fn config_diff_never_prints_a_project_env_value() {
        let mut config = Config::default();
        let mut env = BTreeMap::new();
        env.insert("PROJECT_TOKEN".to_string(), SENTINEL.to_string());
        config.projects.push(config::ProjectConfig {
            id: "p1".to_string(),
            path: "/tmp/project".to_string(),
            name: None,
            default_provider: None,
            leading_branch: None,
            auto_reopen_agents: None,
            startup_command: None,
            env,
            workspace_mode: None,
        });

        let changes = collect_config_changes(&config);
        assert_eq!(changes, vec!["projects: 1 project configured".to_string()]);
        assert!(
            !changes.join("\n").contains(SENTINEL),
            "a project env value must never reach the summary"
        );
    }

    #[test]
    fn config_diff_reports_macros_by_count_and_never_their_bodies() {
        let mut config = Config::default();
        config.macros.entries.insert(
            "review".to_string(),
            config::MacroEntry {
                text: SENTINEL.to_string(),
                surface: config::MacroSurface::Both,
            },
        );

        let changes = collect_config_changes(&config);
        assert_eq!(changes, vec!["macros: 1 macro configured".to_string()]);
        assert!(!changes.join("\n").contains(SENTINEL));
    }

    #[test]
    fn config_diff_reports_a_rebound_and_an_unbound_key_action() {
        let mut config = Config::default();
        config
            .keys
            .bindings
            .insert("quit".to_string(), vec!["ctrl-q".to_string()]);

        assert_eq!(
            collect_config_changes(&config),
            vec!["keys.quit: (new) -> [ctrl-q]".to_string()]
        );
    }

    /// `yaran config diff` parses the file as written and never runs the load
    /// migrations, so a not-yet-folded `exit_interactive` row reaches the
    /// structural walk as an ordinary unknown key. It must be reported like any
    /// other binding rather than tripping the differ.
    #[test]
    fn config_diff_reports_an_unfolded_legacy_key_as_an_ordinary_binding() {
        let mut config = Config::default();
        config
            .keys
            .bindings
            .insert("exit_interactive".to_string(), vec!["ctrl-g".to_string()]);

        assert_eq!(
            collect_config_changes(&config),
            vec!["keys.exit_interactive: (new) -> [ctrl-g]".to_string()]
        );
    }

    #[test]
    fn config_diff_truncates_a_long_value_at_forty_characters() {
        let mut config = Config::default();
        config.editor.default = "e".repeat(45);

        let changes = collect_config_changes(&config);
        assert_eq!(
            changes,
            vec![format!(
                "editor.default: {} -> {}...",
                Config::default().editor.default,
                "e".repeat(40)
            )]
        );
    }

    #[test]
    fn config_diff_output_is_sorted_and_repeatable() {
        let mut config = Config::default();
        config.server.port = 9999;
        config.editor.default = "hx".to_string();
        config.ui.theme = "gruvbox".to_string();
        config.defaults.provider = "codex".to_string();

        let changes = collect_config_changes(&config);
        let mut sorted = changes.clone();
        sorted.sort();
        assert_eq!(changes, sorted, "output must be sorted by path");
        assert_eq!(
            changes,
            collect_config_changes(&config),
            "output must not depend on map iteration order"
        );
    }

    /// CHARACTERIZATION of a known inconsistency, not an endorsement of it.
    ///
    /// The two ways a `[ui]` width default can be reached must agree.
    ///
    /// `[ui]` carries `#[serde(default)]`, so a config whose `[ui]` table omits a
    /// width fills it from `UiConfig::default()`, while a fresh install gets the
    /// value the canonical template renders from `Config::default()`. These
    /// disagreed once (17/19 against 20/23), which gave the same setting two
    /// defaults depending on how the user arrived and made this command report a
    /// width the user had never written as changed. Both halves are asserted, and
    /// then the behaviour that actually matters: a sparse `[ui]` table reports no
    /// width at all.
    #[test]
    fn a_sparse_ui_table_reports_no_width_because_both_defaults_agree() {
        assert_eq!(
            (
                config::UiConfig::default().left_width_pct,
                config::UiConfig::default().right_width_pct
            ),
            (
                Config::default().ui.left_width_pct,
                Config::default().ui.right_width_pct
            ),
            "UiConfig::default() and the literal in Config::default() must not drift apart"
        );

        let sparse: Config =
            toml::from_str("[ui]\ntheme = \"yaran\"\n").expect("parse sparse config");
        let changes = collect_config_changes(&sparse);
        let widths: Vec<&String> = changes
            .iter()
            .filter(|l| l.starts_with("ui.left_width_pct") || l.starts_with("ui.right_width_pct"))
            .collect();
        assert!(
            widths.is_empty(),
            "a width the user never wrote must not be reported as changed: {widths:#?}"
        );
    }

    #[test]
    fn reset_rejects_unknown_flags() {
        let error = reject_unknown_flags(&["--wat".to_string()], &["--all"]).unwrap_err();
        assert!(error.to_string().contains("unknown flag"));
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one scenario walked in order on one config folder, each step asserting on what the previous step left"
    )]
    fn default_reset_removes_config_and_logs_but_keeps_agent_data() {
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("logs/custom.log");
        harness.write_log("logs/custom.log");
        // The server log, its rotated copies (plain, gzipped, an abandoned
        // temporary) and the saved remotes all go with the config.
        for name in [
            "logs/web-custom.log",
            "logs/web-custom.log.1",
            "logs/web-custom.log.2.gz",
            "logs/web-custom.log.3.gz.4242.tmp",
            "remotes.toml",
            "remotes.toml.lock",
        ] {
            harness.write_log(name);
        }
        // A file that only looks like a copy is somebody else's.
        harness.write_log("logs/web-custom.log.old");
        harness.write_log("logs/web-custom.log.notes.tmp");
        let worktree = harness.create_session("agent-1");

        run_reset(
            &harness.paths,
            ResetScope::ConfigOnly,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        assert!(!harness.paths.config_path.exists());
        assert!(!harness.paths.root.join("logs/custom.log").exists());
        for name in [
            "logs/web-custom.log",
            "logs/web-custom.log.1",
            "logs/web-custom.log.2.gz",
            "logs/web-custom.log.3.gz.4242.tmp",
            "remotes.toml",
            "remotes.toml.lock",
        ] {
            assert!(!harness.paths.root.join(name).exists(), "{name} is removed");
        }
        assert!(
            harness.paths.root.join("logs/web-custom.log.old").exists(),
            "a file that is not a numbered copy stays"
        );
        assert!(
            harness
                .paths
                .root
                .join("logs/web-custom.log.notes.tmp")
                .exists(),
            "a temporary that is not the compression's stays"
        );
        assert!(harness.paths.sessions_db_path.exists());
        assert!(worktree.exists());

        // A reset never deletes outside the config folder: a server log path that
        // leaves it (absolute, through `..`, or through a symlinked folder) is
        // left alone with its copies. A symlink AT the path is unlinked, and what
        // it points at stays.
        let outside = harness.paths.root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, harness.paths.root.join("linked-dir"))
            .expect("folder link");
        std::os::unix::fs::symlink(
            outside.join("target.log"),
            harness.paths.root.join("leaf-link.log"),
        )
        .expect("leaf link");
        for (configured, kept) in [
            (
                outside.join("abs.log").to_string_lossy().into_owned(),
                "abs.log",
            ),
            ("../outside/dots.log".to_string(), "dots.log"),
            ("linked-dir/through.log".to_string(), "through.log"),
        ] {
            harness.write_config_with_server_log_path(&configured);
            for name in [kept.to_string(), format!("{kept}.1")] {
                fs::write(outside.join(name), "not yaran's to delete").expect("outside file");
            }
            run_reset(
                &harness.paths,
                ResetScope::ConfigOnly,
                &mut ResetReport::discarding(),
            )
            .expect("reset");
            for name in [kept.to_string(), format!("{kept}.1")] {
                assert!(
                    outside.join(&name).exists(),
                    "{configured}: {name} survives"
                );
            }
        }
        fs::write(outside.join("target.log"), "behind the link").expect("link target");
        harness.write_config_with_server_log_path("leaf-link.log");
        run_reset(
            &harness.paths,
            ResetScope::ConfigOnly,
            &mut ResetReport::discarding(),
        )
        .expect("reset");
        assert!(
            fs::symlink_metadata(harness.paths.root.join("leaf-link.log")).is_err(),
            "the link itself is unlinked"
        );
        assert!(
            outside.join("target.log").exists(),
            "what it pointed at stays"
        );

        let _config = config::ensure_config(&harness.paths).expect("config recreated");
        let store = SessionStore::open(&harness.paths.sessions_db_path).expect("store");
        let sessions = store.load_sessions().expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0]
                .managed_worktree()
                .expect("managed test session"),
            worktree.to_string_lossy()
        );
    }

    #[test]
    fn reset_leaves_a_yaran_log_outside_the_config_folder_alone() {
        let harness = ResetHarness::new();
        let outside = harness.paths.root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, harness.paths.root.join("linked-dir"))
            .expect("folder link");
        for (configured, kept) in [
            (
                outside.join("abs.log").to_string_lossy().into_owned(),
                "abs.log",
            ),
            ("../outside/dots.log".to_string(), "dots.log"),
            ("linked-dir/through.log".to_string(), "through.log"),
        ] {
            harness.write_config_with_log_path(&configured);
            fs::write(outside.join(kept), "not yaran's to delete").expect("outside file");
            run_reset(
                &harness.paths,
                ResetScope::ConfigOnly,
                &mut ResetReport::discarding(),
            )
            .expect("reset");
            assert!(outside.join(kept).exists(), "{configured}: {kept} survives");
        }
    }

    #[test]
    fn reset_all_wipes_database_and_worktrees() {
        for seen in [None, Some("v0.6.0")] {
            let harness = ResetHarness::new();
            harness.write_config_with_log_path("logs/custom.log");
            harness.write_log("logs/custom.log");
            let worktree = harness.create_session("agent-1");
            if let Some(version) = seen {
                SessionStore::open(&harness.paths.sessions_db_path)
                    .expect("store")
                    .set_last_seen_version(version)
                    .expect("record the welcome screen as seen");
            }

            run_reset(
                &harness.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding(),
            )
            .expect("reset");

            assert!(!worktree.exists());
            assert!(!harness.paths.config_path.exists());
            match seen {
                // Nothing to keep: the folder goes with everything else.
                None => assert!(!harness.paths.root.exists()),
                // The welcome screen stays dismissed: a fresh database holds
                // that one record and no agents.
                Some(version) => {
                    let store = SessionStore::open(&harness.paths.sessions_db_path).expect("store");
                    assert_eq!(store.last_seen_version().unwrap().as_deref(), Some(version));
                    assert!(store.load_sessions().unwrap().is_empty());
                }
            }
        }
    }

    #[test]
    fn reset_succeeds_when_paths_are_already_missing() {
        let harness = ResetHarness::new();
        fs::create_dir_all(&harness.paths.root).expect("root");

        run_reset(
            &harness.paths,
            ResetScope::ConfigOnly,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        assert!(!harness.paths.root.exists());
    }

    /// A worktree folder something is still writing into cannot be removed
    /// whole (git and `remove_dir_all` both answer "Directory not empty"). The
    /// reset stops there: the database and config stay, and it says what it
    /// removed and what it could not.
    #[test]
    fn reset_all_stops_at_a_worktree_it_cannot_remove_and_keeps_the_database_and_config() {
        use std::os::unix::fs::PermissionsExt;
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("logs/custom.log");
        let removed = harness.create_session("agent-1");
        // An entry the sweep cannot delete: a folder whose own directory is
        // read-only still holds a file, the way a folder a process keeps
        // writing into refuses to empty.
        let stuck = harness.paths.worktrees_root.join("stuck");
        let locked = stuck.join("locked");
        fs::create_dir_all(&locked).expect("stuck folder");
        fs::write(locked.join("still-writing.log"), "x").expect("file");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).expect("chmod");

        let result = run_reset(
            &harness.paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("chmod back");

        let refusal = result.expect_err("one stuck folder stops the reset");
        let message = format!("{refusal:#}");
        assert!(
            harness.paths.sessions_db_path.exists(),
            "the database stays"
        );
        assert!(harness.paths.config_path.exists(), "the config stays");
        assert!(message.contains(&stuck.display().to_string()), "{message}");
        assert!(message.contains("could not be removed"), "{message}");
        assert!(
            message.contains(&removed.display().to_string()),
            "{message}"
        );
        assert!(
            !removed.exists(),
            "what was removed before it stopped is gone"
        );
    }

    #[test]
    fn reset_all_removes_worktrees_without_database() {
        let harness = ResetHarness::new();
        let orphan = harness.paths.worktrees_root.join("orphan");
        fs::create_dir_all(&orphan).expect("orphan worktree");
        // Something nobody recorded works in the folder: the reset refuses and
        // names it, even with no database to say what yaran started.
        let mut stranger = std::process::Command::new("sleep")
            .arg("60")
            .current_dir(&orphan)
            .spawn()
            .expect("spawn");

        let refusal = run_reset(
            &harness.paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .expect_err("the reset refuses");

        let message = format!("{refusal:#}");
        assert!(message.contains(&stranger.id().to_string()), "{message}");
        assert!(message.contains("sleep"), "{message}");
        assert!(message.contains(&orphan.display().to_string()), "{message}");
        assert!(orphan.exists());

        stranger.kill().expect("kill");
        stranger.wait().expect("reap");
        run_reset(
            &harness.paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        assert!(!harness.paths.root.exists());
    }

    #[test]
    fn reset_all_preserves_existing_worktree_behavior_for_missing_session_directory() {
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("yaran.log");
        let worktree = harness.create_session("already-missing");
        fs::remove_dir_all(&worktree).unwrap();

        run_reset(
            &harness.paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .expect("reset");

        assert!(!harness.paths.root.exists());
    }

    #[test]
    fn reset_all_never_removes_a_shared_registered_checkout() {
        let harness = ResetHarness::new();
        let managed_worktree = harness.create_session("managed");
        harness.create_session("shared");
        let checkout = harness.paths.root.parent().unwrap().join("real-checkout");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(checkout.join("uncommitted.txt"), "keep me").unwrap();
        let store = SessionStore::open(&harness.paths.sessions_db_path).unwrap();
        let mut session = store
            .load_sessions()
            .unwrap()
            .into_iter()
            .find(|session| session.id == "shared")
            .unwrap();
        session.shared_workspace = true;
        let managed = session.workspace.as_managed_mut().unwrap();
        managed.worktree_path = checkout.to_string_lossy().into_owned();
        managed.project_path = Some(managed.worktree_path.clone());
        store.upsert_session(&session).unwrap();
        drop(store);
        harness.write_config_with_projects(&[&checkout]);

        run_reset(
            &harness.paths,
            ResetScope::Everything,
            &mut ResetReport::discarding(),
        )
        .unwrap();

        assert!(checkout.join("uncommitted.txt").exists());
        assert!(!managed_worktree.exists());
    }

    #[test]
    fn reset_all_aborts_before_mutation_on_incomplete_config_or_database_inventory() {
        let corrupt_config = ResetHarness::new();
        let worktree = corrupt_config.create_session("agent-1");
        fs::write(&corrupt_config.paths.config_path, "not = [valid").unwrap();
        let error = format!(
            "{:#}",
            run_reset(
                &corrupt_config.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding()
            )
            .unwrap_err()
        );
        assert!(error.contains(&corrupt_config.paths.config_path.display().to_string()));
        assert!(error.contains("yaran config regenerate --yes"));
        assert!(error.contains("retry"));
        assert!(worktree.exists());
        assert!(corrupt_config.paths.sessions_db_path.exists());
        assert!(corrupt_config.paths.root.join("store-id").exists());

        let corrupt_database = ResetHarness::new();
        corrupt_database.write_config_with_log_path("yaran.log");
        yaran_core::storage::load_or_create_store_id(&corrupt_database.paths.root).unwrap();
        fs::write(&corrupt_database.paths.sessions_db_path, "not sqlite").unwrap();
        let orphan = corrupt_database.paths.worktrees_root.join("orphan");
        fs::create_dir_all(&orphan).unwrap();
        let error = format!(
            "{:#}",
            run_reset(
                &corrupt_database.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding()
            )
            .unwrap_err()
        );
        assert!(
            error.contains(
                &corrupt_database
                    .paths
                    .sessions_db_path
                    .display()
                    .to_string()
            )
        );
        // The refusal is the one upstream's reset says for unreadable records:
        // what could not be read, and how to reset anyway.
        assert!(error.contains("deleted nothing"), "{error}");
        assert!(error.contains("run the reset again"), "{error}");
        assert!(orphan.exists());
        assert_eq!(
            fs::read_to_string(&corrupt_database.paths.sessions_db_path).unwrap(),
            "not sqlite"
        );

        // Upstream installs never minted a store id, so its absence only
        // aborts when there is an AMQ root whose ownership it must prove.
        let missing_store_id = ResetHarness::new();
        missing_store_id.write_config_with_log_path("yaran.log");
        let worktree = missing_store_id.create_session("agent-1");
        fs::remove_file(missing_store_id.paths.root.join("store-id")).unwrap();
        let amq_root = missing_store_id.paths.root.parent().unwrap().join("amq");
        fs::create_dir_all(&amq_root).unwrap();
        let error = format!(
            "{:#}",
            reset_agent_data_at_amq_root(
                &missing_store_id.paths,
                Some(&amq_root),
                &mut ResetReport::discarding()
            )
            .unwrap_err()
        );
        assert!(
            error.contains(
                &missing_store_id
                    .paths
                    .root
                    .join("store-id")
                    .display()
                    .to_string()
            )
        );
        assert!(error.contains("exact AMQ ownership cannot be proven"));
        assert!(error.contains("retry"));
        assert!(worktree.exists());
        assert!(missing_store_id.paths.sessions_db_path.exists());

        let invalid_handle = ResetHarness::new();
        invalid_handle.write_config_with_log_path("yaran.log");
        let worktree = invalid_handle.create_session("agent-1");
        let store = SessionStore::open(&invalid_handle.paths.sessions_db_path).unwrap();
        store
            .corrupt_agent_handle_for_test("agent-1", "Bad/handle")
            .unwrap();
        drop(store);
        let error = format!(
            "{:#}",
            run_reset(
                &invalid_handle.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding()
            )
            .unwrap_err()
        );
        assert!(error.contains("agent-1"), "{error}");
        assert!(error.contains(&invalid_handle.paths.sessions_db_path.display().to_string()));
        assert!(error.contains("run the reset again"), "{error}");
        assert!(worktree.exists());
        assert!(invalid_handle.paths.sessions_db_path.exists());
        assert!(invalid_handle.paths.root.join("store-id").exists());

        let outside_root = ResetHarness::new();
        outside_root.write_config_with_log_path("yaran.log");
        let worktree = outside_root.create_session("agent-1");
        let store = SessionStore::open(&outside_root.paths.sessions_db_path).unwrap();
        let mut session = store.load_sessions().unwrap().remove(0);
        let outside = outside_root.paths.root.parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        session.workspace.as_managed_mut().unwrap().worktree_path =
            outside.to_string_lossy().into_owned();
        store.upsert_session(&session).unwrap();
        drop(store);
        let error = format!(
            "{:#}",
            run_reset(
                &outside_root.paths,
                ResetScope::Everything,
                &mut ResetReport::discarding()
            )
            .unwrap_err()
        );
        assert!(error.contains("agent-1"));
        assert!(error.contains(&outside_root.paths.sessions_db_path.display().to_string()));
        assert!(error.contains("repair or remove that row"));
        assert!(error.contains("retry"));
        assert!(worktree.exists());
        assert!(outside.exists());
        assert!(outside_root.paths.sessions_db_path.exists());
    }

    #[test]
    fn reset_all_frees_exact_owned_amq_before_deleting_database() {
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("yaran.log");
        harness.create_session("agent-1");
        let store = SessionStore::open(&harness.paths.sessions_db_path).unwrap();
        store.soft_delete_session("agent-1").unwrap();
        let session = store.load_sessions_including_deleted().unwrap().remove(0);
        drop(store);
        let amq_root = harness.paths.root.parent().unwrap().join("amq");
        let agent_dir = amq_root.join("agents").join(session.agent_handle());
        fs::create_dir_all(agent_dir.join("inbox")).unwrap();
        fs::create_dir_all(amq_root.join("meta")).unwrap();
        // The durable marker keeps its legacy filename so both generations
        // can prove ownership before removing an inbox or its database.
        fs::write(
            agent_dir.join(".dux-amq-source"),
            format!(
                r#"{{"store_id":"{}","session_id":"{}"}}"#,
                yaran_core::storage::load_store_id(&harness.paths.root).unwrap(),
                session.id
            ),
        )
        .unwrap();
        let amq_config = amq_root.join("meta/config.json");
        fs::write(&amq_config, "not json").unwrap();

        assert!(
            reset_agent_data_at_amq_root(
                &harness.paths,
                Some(&amq_root),
                &mut ResetReport::discarding()
            )
            .is_err()
        );
        assert!(agent_dir.exists());
        assert!(harness.paths.sessions_db_path.exists());

        fs::write(
            &amq_config,
            format!(r#"{{"agents":["{}"]}}"#, session.agent_handle()),
        )
        .unwrap();

        reset_agent_data_at_amq_root(
            &harness.paths,
            Some(&amq_root),
            &mut ResetReport::discarding(),
        )
        .unwrap();

        assert!(!agent_dir.exists());
        assert!(!harness.paths.sessions_db_path.exists());
        assert!(
            !harness.paths.root.join("store-id").exists(),
            "the identity goes last, once nothing it proves ownership of remains"
        );
    }

    #[test]
    fn reset_root_wipe_keeps_a_nested_project_and_rejects_an_enclosing_one() {
        for descendant_project in [true, false] {
            let harness = ResetHarness::new();
            let worktree = harness.create_session("agent-1");
            let project_path = if descendant_project {
                worktree.join("nested-project")
            } else {
                harness.paths.root.parent().unwrap().to_path_buf()
            };
            fs::create_dir_all(&project_path).unwrap();
            fs::write(project_path.join("keep.txt"), "mine\n").unwrap();
            harness.write_config_with_projects(&[&project_path]);

            let reset = reset_agent_data(&harness.paths, &mut ResetReport::discarding());
            if descendant_project {
                // A project inside an agent's worktree keeps that worktree: the
                // folder it occupies is never removed.
                reset.expect("the reset keeps the project and carries on");
                assert!(project_path.join("keep.txt").exists());
            } else {
                // A root inside a project would take part of it: refused whole.
                assert!(reset.is_err());
                assert!(worktree.exists());
                assert!(harness.paths.sessions_db_path.exists());
            }
        }
    }

    /// A project registered inside the worktrees root is the user's data, and
    /// the reset keeps it, as it keeps every folder a project occupies, while
    /// the rest of the root goes. (Fork 454d8bca refused the whole reset here;
    /// keeping the project is just as safe and leaves no reset half-done.)
    #[test]
    fn a_project_inside_the_worktrees_root_is_kept_by_the_reset() {
        let harness = ResetHarness::new();
        let worktree = harness.create_session("agent-1");
        let project = harness.paths.worktrees_root.join("a-real-project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("keep.txt"), "mine\n").unwrap();
        harness.write_config_with_projects(&[&project]);

        reset_agent_data(&harness.paths, &mut ResetReport::discarding()).expect("reset");
        assert!(project.join("keep.txt").exists(), "the project is kept");
        assert!(!worktree.exists(), "the agent's worktree goes");
    }

    /// A worktrees root that sits inside a registered project would take part of
    /// that project with it, so the reset refuses before any change.
    #[test]
    fn a_worktrees_root_inside_a_project_stops_the_reset_before_any_change() {
        let harness = ResetHarness::new();
        let worktree = harness.create_session("agent-1");
        let project = harness.paths.root.clone();
        harness.write_config_with_projects(&[&project]);

        let error = format!(
            "{:#}",
            reset_agent_data(&harness.paths, &mut ResetReport::discarding()).unwrap_err()
        );
        assert!(error.contains("reset aborted before mutation"), "{error}");
        assert!(
            worktree.exists(),
            "no worktree may go before the guard runs"
        );
        assert!(harness.paths.sessions_db_path.exists());
    }

    #[test]
    fn diff_summary_reports_no_differences_for_defaults() {
        // Just verify it runs without error on defaults.
        let defaults = Config::default();
        run_diff_summary(&defaults, &mut std::io::sink()).expect("a sink takes every line");
    }

    /// Fork 773a6b04 (P1-26): `yaran config diff` reports a change in every
    /// typed section, provider arguments included. Upstream's differ is
    /// structural, so this guards that no section (the ported [limits] and
    /// [storage] among them) is silently skipped.
    #[test]
    fn diff_summary_covers_every_typed_section_and_provider_arguments() {
        fn assert_reports(config: &Config, path: &str) {
            let changes = collect_config_changes(config);
            assert!(
                changes.iter().any(|change| change.starts_with(path)),
                "missing {path} in {changes:#?}"
            );
        }
        type Edit = (&'static str, fn(&mut Config));
        let edits: Vec<Edit> = vec![
            ("defaults.provider:", |c| {
                c.defaults.provider = "codex".into();
            }),
            ("providers.claude.args:", |c| {
                c.providers.commands["claude"].args.push("--audit03".into());
            }),
            ("terminal.command:", |c| {
                c.terminal.command = "/bin/audit03".into();
            }),
            ("logging.level:", |c| c.logging.level = "debug".into()),
            ("projects:", |c| {
                c.projects
                    .push(toml::from_str("id = \"audit03\"\npath = \"/tmp/audit03\"\n").unwrap());
            }),
            ("ui.left_width_pct:", |c| c.ui.left_width_pct += 1),
            ("editor.default:", |c| c.editor.default = "audit03".into()),
            ("keys.show_terminal_keys:", |c| {
                c.keys.show_terminal_keys = !c.keys.show_terminal_keys;
            }),
            ("macros:", |c| {
                c.macros.entries.insert(
                    "audit03".into(),
                    yaran_core::config::MacroEntry {
                        text: "proof".into(),
                        surface: yaran_core::config::MacroSurface::Both,
                    },
                );
            }),
            ("limits.max_panes:", |c| c.limits.max_panes = 3),
            ("storage.backup_interval_minutes:", |c| {
                c.storage.backup_interval_minutes += 1;
            }),
        ];
        for (path, edit) in edits {
            let mut config = Config::default();
            edit(&mut config);
            assert_reports(&config, path);
        }
    }

    #[test]
    fn config_path_subcommand() {
        // Just verify it doesn't error.
        let paths = YaranPaths {
            root: PathBuf::from("/tmp/test"),
            config_path: PathBuf::from("/tmp/test/config.toml"),
            sessions_db_path: PathBuf::from("/tmp/test/sessions.sqlite3"),
            worktrees_root: PathBuf::from("/tmp/test/worktrees"),
            lock_path: PathBuf::from("/tmp/test/dux.lock"),
            socket_path: PathBuf::from("/tmp/test/yaran.sock"),
        };
        let result = run(&["path".to_string()], &paths);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // yaran config restore-docs
    // -----------------------------------------------------------------------

    fn bare_user_config_fixture() -> String {
        std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/bare_user_config.toml"
        ))
        .expect("read bare user config fixture")
    }

    /// Every backup this command wrote, oldest name first.
    fn backups(harness: &ResetHarness) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = fs::read_dir(&harness.paths.root)
            .expect("read dir")
            .filter_map(std::result::Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.contains(".backup-"))
            })
            .collect();
        found.sort();
        found
    }

    #[test]
    fn restore_docs_preview_writes_nothing_and_leaves_the_file_alone() {
        let harness = ResetHarness::new();
        let original = bare_user_config_fixture();
        fs::write(&harness.paths.config_path, &original).expect("seed");

        run(&["restore-docs".to_string()], &harness.paths).expect("preview");

        assert_eq!(
            fs::read_to_string(&harness.paths.config_path).expect("read"),
            original,
            "preview must not modify the config"
        );
        assert!(
            backups(&harness).is_empty(),
            "preview must not write a backup"
        );
    }

    #[test]
    fn restore_docs_yes_writes_a_backup_containing_the_original_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let harness = ResetHarness::new();
        let original = bare_user_config_fixture();
        fs::write(&harness.paths.config_path, &original).expect("seed");
        fs::set_permissions(&harness.paths.root, fs::Permissions::from_mode(0o755))
            .expect("loosen root");

        run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect("apply");

        let root_mode = fs::metadata(&harness.paths.root)
            .expect("stat root")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(root_mode, 0o700, "the config folder must be tightened");

        // The config was rewritten with comments...
        let after = fs::read_to_string(&harness.paths.config_path).expect("read config");
        assert!(after.contains('#'), "config gained no comments");
        assert_ne!(after, original);

        // ...and exactly one backup holds the original bytes verbatim.
        let backups = backups(&harness);
        assert_eq!(backups.len(), 1, "expected one backup, got {backups:?}");
        assert_eq!(
            fs::read_to_string(&backups[0]).expect("read backup"),
            original,
            "the backup must be a byte-for-byte copy of the original"
        );
    }

    #[test]
    #[cfg(unix)]
    fn restore_docs_backup_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let harness = ResetHarness::new();
        fs::write(&harness.paths.config_path, bare_user_config_fixture()).expect("seed");

        run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect("apply");

        // The backup carries the same potential secrets ([env] tokens) as the
        // config, so it must not be group/world readable either.
        let backup = backups(&harness).remove(0);
        let mode = fs::metadata(&backup).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "backup must be 0600, got {mode:o}");
    }

    #[test]
    fn restore_docs_never_clobbers_an_earlier_backup() {
        let harness = ResetHarness::new();
        fs::write(&harness.paths.config_path, bare_user_config_fixture()).expect("seed");
        run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect("first apply");

        // Make the config restorable again, then run again inside the same
        // second so both runs compute the same timestamp.
        let mut second = fs::read_to_string(&harness.paths.config_path).expect("read");
        second.push_str("\n[a_fork_section]\nknob = 1\n");
        fs::write(&harness.paths.config_path, &second).expect("reseed");
        // Re-adding an orphan guarantees the second run is not a no-op.
        fs::write(
            &harness.paths.config_path,
            format!("{second}\n[auth]\nusers = []\n"),
        )
        .expect("reseed with orphan");

        run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect("second apply");

        assert_eq!(
            backups(&harness).len(),
            2,
            "the second run must not overwrite the first backup"
        );
    }

    #[test]
    fn restore_docs_refuses_an_unparseable_config_and_leaves_it_byte_identical() {
        let harness = ResetHarness::new();
        let broken = "[server]\nport = = 8080\n[[[ nope\n";
        fs::write(&harness.paths.config_path, broken).expect("seed");

        let err = run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect_err("must refuse a broken config");
        let message = format!("{err:#}");

        // It says why, and points at the path that would lose data instead.
        assert!(message.contains("not valid TOML"), "{message}");
        assert!(message.contains("has NOT been modified"), "{message}");
        assert!(message.contains("regenerate --yes"), "{message}");

        // The file is untouched, and no backup was written for a run that did
        // nothing.
        assert_eq!(
            fs::read_to_string(&harness.paths.config_path).expect("read"),
            broken,
            "a refused restore must leave the file byte-identical"
        );
        assert_eq!(backups(&harness), Vec::<PathBuf>::new());
    }

    #[test]
    fn with_context_path_keeps_the_cause() {
        let failed: Result<()> = Err(anyhow!("Permission denied").context("failed to write"));
        let message = failed
            .with_context_path(Path::new("/cfg/config.toml"))
            .expect_err("still an error")
            .to_string();
        assert!(message.contains("Permission denied"), "{message}");
    }

    #[test]
    fn restore_docs_refusal_never_prints_an_env_value() {
        let harness = ResetHarness::new();
        for malformed in [
            "[env]\nAPI_KEY = \"sk-live-123\" trailing\n",
            "[env]\nAPI_KEY = [\"sk-live-123\"]\n",
        ] {
            fs::write(&harness.paths.config_path, malformed).expect("seed");
            for args in [vec!["restore-docs"], vec!["restore-docs", "--yes"]] {
                let args: Vec<String> = args.into_iter().map(String::from).collect();
                let err = run(&args, &harness.paths).expect_err("must refuse");
                let message = format!("{err:#}");
                assert!(!message.contains("sk-live-123"), "{message}");
            }
        }
    }

    #[test]
    fn restore_docs_is_a_noop_on_an_already_documented_config() {
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("yaran.log");
        let original = fs::read_to_string(&harness.paths.config_path).expect("read");

        run(
            &["restore-docs".to_string(), "--yes".to_string()],
            &harness.paths,
        )
        .expect("apply");

        assert_eq!(
            fs::read_to_string(&harness.paths.config_path).expect("read"),
            original,
            "a canonical config must not be rewritten"
        );
        assert!(
            backups(&harness).is_empty(),
            "a no-op must not write a backup"
        );
    }

    #[test]
    fn restore_docs_handles_a_missing_config_without_creating_one() {
        let harness = ResetHarness::new();
        assert!(!harness.paths.config_path.exists());

        run(&["restore-docs".to_string()], &harness.paths).expect("missing config is not an error");

        assert!(
            !harness.paths.config_path.exists(),
            "restore-docs must not create a config"
        );
    }

    #[test]
    fn restore_docs_rejects_unknown_flags() {
        let harness = ResetHarness::new();
        let err = run(
            &["restore-docs".to_string(), "--force".to_string()],
            &harness.paths,
        )
        .expect_err("unknown flag must be rejected");
        assert!(format!("{err:#}").contains("unknown flag"));
    }

    struct ResetHarness {
        _tempdir: TempDir,
        paths: YaranPaths,
    }

    impl ResetHarness {
        fn new() -> Self {
            let tempdir = TempDir::new().expect("tempdir");
            let root = tempdir.path().join("yaran");
            fs::create_dir_all(&root).expect("root");
            let paths = YaranPaths {
                config_path: root.join("config.toml"),
                sessions_db_path: root.join("sessions.sqlite3"),
                worktrees_root: root.join("worktrees"),
                lock_path: root.join("dux.lock"),
                socket_path: root.join("yaran.sock"),
                root,
            };
            Self {
                _tempdir: tempdir,
                paths,
            }
        }

        fn write_config_with_log_path(&self, log_path: &str) {
            let mut config = Config::default();
            config.logging.path = log_path.to_string();
            config.server.log_path = "logs/web-custom.log".to_string();
            let bindings = RuntimeBindings::from_keys_config(&config.keys);
            let body = config::render_config_with(&config, &bindings);
            fs::write(&self.paths.config_path, body).expect("config");
        }

        fn write_config_with_server_log_path(&self, server_log_path: &str) {
            let mut config = Config::default();
            config.server.log_path = server_log_path.to_string();
            let bindings = RuntimeBindings::from_keys_config(&config.keys);
            let body = config::render_config_with(&config, &bindings);
            fs::write(&self.paths.config_path, body).expect("config");
        }

        /// A config registering `projects`, the inventory the factory reset's
        /// protected-workspace guard reads.
        fn write_config_with_projects(&self, projects: &[&Path]) {
            let config = Config {
                projects: projects
                    .iter()
                    .enumerate()
                    .map(|(index, path)| crate::config::ProjectConfig {
                        id: format!("protected-{index}"),
                        path: path.to_string_lossy().into_owned(),
                        name: Some(format!("protected-{index}")),
                        default_provider: None,
                        leading_branch: None,
                        auto_reopen_agents: None,
                        startup_command: None,
                        env: BTreeMap::default(),
                        workspace_mode: None,
                    })
                    .collect(),
                ..Config::default()
            };
            fs::write(&self.paths.config_path, toml::to_string(&config).unwrap()).expect("config");
        }

        fn write_log(&self, relative_path: &str) {
            let path = self.paths.root.join(relative_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("log dir");
            }
            fs::write(path, "log").expect("log");
        }

        fn create_session(&self, id: &str) -> PathBuf {
            yaran_core::storage::load_or_create_store_id(&self.paths.root).expect("store id");
            fs::create_dir_all(&self.paths.worktrees_root).expect("worktrees root");
            let worktree = self.paths.worktrees_root.join(id);
            fs::create_dir_all(&worktree).expect("worktree");

            let store = SessionStore::open(&self.paths.sessions_db_path).expect("store");
            let now = Utc::now();
            store
                .upsert_session(&AgentSession {
                    id: id.to_string(),
                    agent_handle: yaran_core::model::normalize_agent_handle(id),
                    shared_workspace: false,
                    deleted_at: None,
                    slot_tab_id: format!("{id}-slot"),
                    provider: ProviderKind::new("claude"),
                    title: None,
                    started_providers: Vec::new(),
                    desired_running: false,
                    auto_reopen_enabled: true,
                    status: SessionStatus::Active,
                    created_at: now,
                    updated_at: now,
                    last_focused_tab: None,
                    workspace: yaran_core::model::AgentWorkspace::Managed(
                        yaran_core::model::ManagedWorkspace {
                            project_id: "proj".to_string(),
                            project_path: None,
                            source_branch: "main".to_string(),
                            branch_name: format!("branch-{id}"),
                            initial_branch: format!("branch-{id}"),
                            branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                            worktree_path: worktree.to_string_lossy().to_string(),
                        },
                    ),
                })
                .expect("session");
            worktree
        }
    }

    /// A factory reset resets what yaran made. An agent attached to a branch the
    /// user already had gives up its worktree and keeps its branch: deleting
    /// `develop` because an agent once pointed at it is data loss, not a reset.
    #[test]
    fn factory_reset_keeps_a_branch_the_agent_did_not_create() {
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |cwd: &Path, args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "Test User"]);
        git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        git(&repo, &["branch", "develop"]);

        let worktrees_root = tempdir.path().join("worktrees");
        fs::create_dir_all(&worktrees_root).expect("worktrees root");
        let worktree = worktrees_root.join("wt");
        git(
            &repo,
            &["worktree", "add", worktree.to_str().unwrap(), "develop"],
        );

        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let now = Utc::now();
        let session = AgentSession {
            id: "wt".to_string(),
            agent_handle: "wt".to_string(),
            shared_workspace: false,
            deleted_at: None,
            slot_tab_id: "wt-slot".to_string(),
            provider: ProviderKind::new("claude"),
            title: None,
            started_providers: Vec::new(),
            desired_running: false,
            auto_reopen_enabled: true,
            status: SessionStatus::Active,
            created_at: now,
            updated_at: now,
            last_focused_tab: None,
            workspace: yaran_core::model::AgentWorkspace::Managed(
                yaran_core::model::ManagedWorkspace {
                    project_id: "proj".to_string(),
                    project_path: Some(repo.to_string_lossy().to_string()),
                    source_branch: "main".to_string(),
                    branch_name: "develop".to_string(),
                    initial_branch: "develop".to_string(),
                    branch_provenance: yaran_core::model::BranchProvenance::AttachedExisting,
                    worktree_path: worktree.to_string_lossy().to_string(),
                },
            ),
        };

        remove_session_worktree(
            &paths,
            session
                .workspace
                .as_managed()
                .expect("the fixture builds a managed agent"),
            &yaran_core::branch_history::unasked_plan(
                session
                    .workspace
                    .as_managed()
                    .expect("the fixture builds a managed agent"),
                session.created_at,
                &[],
            ),
            &[],
            &[],
            &mut ResetReport::discarding(),
        );

        assert!(!worktree.exists(), "the worktree directory must be removed");
        let branches = yaran_core::test_git::fixture_git()
            .args(["-C", repo.to_str().unwrap(), "branch", "--list", "develop"])
            .output()
            .expect("git branch --list");
        assert!(
            String::from_utf8_lossy(&branches.stdout).contains("develop"),
            "a branch that existed before the agent must survive a factory reset",
        );
    }

    /// Convergence regression: factory-reset worktree removal must prune the
    /// repo's worktree registration and delete the branch, exactly as core
    /// `git::remove_worktree` does. The old CLI copy ran `git worktree remove`
    /// WITHOUT `-C <repo>` (so it hit the wrong repo, failed, and fell back to a
    /// bare `fs::remove_dir_all`) and never pruned, leaving a stale worktree ref
    /// that made the branch undeletable. This proves the branch is gone.
    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one scenario walked in order on one repository, each step asserting on what the previous step left"
    )]
    fn factory_reset_worktree_removal_prunes_and_deletes_the_branch() {
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |cwd: &Path, args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "Test User"]);
        git(&repo, &["commit", "--allow-empty", "-m", "initial"]);

        let worktrees_root = tempdir.path().join("worktrees");
        fs::create_dir_all(&worktrees_root).expect("worktrees root");
        let worktree = worktrees_root.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "branch-wt",
                worktree.to_str().unwrap(),
            ],
        );

        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let now = Utc::now();
        let session = AgentSession {
            id: "wt".to_string(),
            slot_tab_id: "wt-slot".to_string(),
            provider: ProviderKind::new("claude"),
            title: None,
            started_providers: Vec::new(),
            desired_running: false,
            auto_reopen_enabled: true,
            status: SessionStatus::Active,
            created_at: now,
            updated_at: now,
            last_focused_tab: None,
            workspace: yaran_core::model::AgentWorkspace::Managed(
                yaran_core::model::ManagedWorkspace {
                    project_id: "proj".to_string(),
                    project_path: Some(repo.to_string_lossy().to_string()),
                    source_branch: "main".to_string(),
                    branch_name: "branch-wt".to_string(),
                    initial_branch: "branch-wt".to_string(),
                    branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                    worktree_path: worktree.to_string_lossy().to_string(),
                },
            ),
            agent_handle: "wt".to_string(),
            deleted_at: None,
            shared_workspace: false,
        };

        remove_session_worktree(
            &paths,
            session
                .workspace
                .as_managed()
                .expect("the fixture builds a managed agent"),
            &yaran_core::branch_history::unasked_plan(
                session
                    .workspace
                    .as_managed()
                    .expect("the fixture builds a managed agent"),
                session.created_at,
                &[],
            ),
            &[],
            &[],
            &mut ResetReport::discarding(),
        );

        assert!(!worktree.exists(), "the worktree directory must be removed");
        let branches = yaran_core::test_git::fixture_git()
            .args([
                "-C",
                repo.to_str().unwrap(),
                "branch",
                "--list",
                "branch-wt",
            ])
            .output()
            .expect("git branch --list");
        assert!(
            String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
            "the branch must be deleted (a stale worktree ref would keep it undeletable)",
        );
        let worktrees = yaran_core::test_git::fixture_git()
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "list",
                "--porcelain",
            ])
            .output()
            .expect("git worktree list");
        // Match the removed worktree's FULL path, never the bare "wt" dir name:
        // `git worktree list` always names the main worktree, whose path is the
        // random tempfile dir, and a 2-char substring like "wt" matches that
        // random path by chance (a rare-but-real CI flake). The full path is
        // unique to the removed registration, so its absence is the real signal.
        let removed_registration = worktree.to_string_lossy();
        assert!(
            !String::from_utf8_lossy(&worktrees.stdout).contains(removed_registration.as_ref()),
            "no stale worktree registration for the removed path may remain in the repo",
        );
    }

    /// A reset nobody was asked about deletes only the branch yaran can prove it
    /// made: an agent that moved onto the user's own `develop` leaves it.
    #[test]
    fn factory_reset_of_a_drifted_agent_deletes_its_birth_branch_and_keeps_the_users() {
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |cwd: &Path, args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "Test User"]);
        git(&repo, &["commit", "--allow-empty", "-m", "initial"]);

        let worktrees_root = tempdir.path().join("worktrees");
        fs::create_dir_all(&worktrees_root).expect("worktrees root");
        let worktree = worktrees_root.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "branch-wt",
                worktree.to_str().unwrap(),
            ],
        );
        // The worktree moved onto the user's own branch, which predates it.
        git(&repo, &["branch", "develop", "main"]);
        git(&worktree, &["switch", "develop"]);

        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let now = Utc::now();
        let session = AgentSession {
            id: "wt".to_string(),
            slot_tab_id: "wt-slot".to_string(),
            provider: ProviderKind::new("claude"),
            title: None,
            started_providers: Vec::new(),
            desired_running: false,
            auto_reopen_enabled: true,
            status: SessionStatus::Active,
            created_at: now,
            updated_at: now,
            last_focused_tab: None,
            workspace: yaran_core::model::AgentWorkspace::Managed(
                yaran_core::model::ManagedWorkspace {
                    project_id: "proj".to_string(),
                    project_path: Some(repo.to_string_lossy().to_string()),
                    source_branch: "main".to_string(),
                    branch_name: "develop".to_string(),
                    initial_branch: "branch-wt".to_string(),
                    branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                    worktree_path: worktree.to_string_lossy().to_string(),
                },
            ),
            agent_handle: "wt".to_string(),
            deleted_at: None,
            shared_workspace: false,
        };

        remove_session_worktree(
            &paths,
            session
                .workspace
                .as_managed()
                .expect("the fixture builds a managed agent"),
            &yaran_core::branch_history::unasked_plan(
                session
                    .workspace
                    .as_managed()
                    .expect("the fixture builds a managed agent"),
                session.created_at,
                &[],
            ),
            &[],
            &[],
            &mut ResetReport::discarding(),
        );

        assert!(!worktree.exists(), "the worktree directory must be removed");
        let listed = |name: &str| {
            let out = yaran_core::test_git::fixture_git()
                .args(["-C", repo.to_str().unwrap(), "branch", "--list", name])
                .output()
                .expect("git branch --list");
            !String::from_utf8_lossy(&out.stdout).trim().is_empty()
        };
        assert!(
            !listed("branch-wt"),
            "the branch yaran made for the agent goes"
        );
        assert!(
            listed("develop"),
            "the user's branch the agent moved onto stays"
        );
    }

    /// A branch a left-over folder kept outlives the agent row it came from,
    /// so the reset reads the left-over records too and deletes the branches
    /// provenance gives it, at the commit each was recorded on, keeping one
    /// that predates its agent.
    #[test]
    fn factory_reset_deletes_the_branches_yaran_kept_with_a_left_over_folder() {
        use std::os::unix::fs::MetadataExt;
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-b", "main"]);
        git(&["commit", "--allow-empty", "-m", "initial"]);
        git(&["branch", "made"]);
        git(&["branch", "theirs"]);
        let head = git(&["rev-parse", "HEAD"]);
        let worktrees_root = tempdir.path().join("worktrees");
        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .upsert_project(&yaran_core::config::ProjectConfig {
                id: "proj".to_string(),
                path: repo.to_string_lossy().into_owned(),
                name: Some("repo".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: std::collections::BTreeMap::new(),
                workspace_mode: None,
            })
            .expect("project");
        for (folder, branch, provenance) in [
            (
                "a",
                "made",
                yaran_core::model::BranchProvenance::CreatedByYaran,
            ),
            (
                "b",
                "theirs",
                yaran_core::model::BranchProvenance::AttachedExisting,
            ),
        ] {
            let path = worktrees_root.join("repo").join(folder);
            fs::create_dir_all(path.join(".astro")).expect("left-over folder");
            let meta = fs::symlink_metadata(&path).expect("metadata");
            store
                .record_leftover_folder(&yaran_core::leftover_folders::LeftoverFolderRecord {
                    path: path.to_string_lossy().into_owned(),
                    project_id: "proj".to_string(),
                    branches: vec![git::KeptBranch {
                        name: branch.to_string(),
                        oid: Some(head.clone()),
                        provenance: Some(provenance),
                    }],
                    provenance: Some(provenance),
                    identity: yaran_core::leftover_folders::FolderIdentity {
                        dev: meta.dev(),
                        ino: meta.ino(),
                        birth_ns: None,
                    },
                })
                .expect("record");
        }
        drop(store);

        reset_agent_data(&paths, &mut ResetReport::discarding()).expect("reset");

        assert!(!worktrees_root.join("repo/a").exists());
        assert!(
            git(&["branch", "--list", "made"]).is_empty(),
            "the branch yaran created is deleted"
        );
        assert_eq!(
            git(&["branch", "--list", "theirs"]),
            "theirs",
            "a branch that predates its agent is kept"
        );
    }

    /// A folder git has already let go of (a delete something kept writing
    /// into) keeps its branch in core; the reset deletes the folder itself and
    /// then the branch yaran created, so it still leaves nothing of yaran's.
    #[test]
    fn factory_reset_of_a_left_over_folder_deletes_the_folder_and_the_branch() {
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git");
            assert!(out.status.success(), "git {args:?} failed");
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        git(&["init", "-b", "main"]);
        git(&["commit", "--allow-empty", "-m", "initial"]);
        let worktrees_root = tempdir.path().join("worktrees");
        let worktree = worktrees_root.join("wt");
        git(&[
            "worktree",
            "add",
            "-b",
            "branch-wt",
            worktree.to_str().unwrap(),
        ]);
        git(&["worktree", "remove", "--force", worktree.to_str().unwrap()]);
        fs::create_dir_all(worktree.join(".astro")).expect("left-over contents");
        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let managed = yaran_core::model::ManagedWorkspace {
            project_id: "proj".to_string(),
            project_path: Some(repo.to_string_lossy().to_string()),
            source_branch: "main".to_string(),
            branch_name: "branch-wt".to_string(),
            initial_branch: "branch-wt".to_string(),
            branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
            worktree_path: worktree.to_string_lossy().to_string(),
        };

        remove_session_worktree(
            &paths,
            &managed,
            &yaran_core::branch_history::unasked_plan(&managed, chrono::Utc::now(), &[]),
            &[],
            &[],
            &mut ResetReport::discarding(),
        );

        assert!(!worktree.exists(), "the reset deletes the left-over folder");
        assert!(
            git(&["branch", "--list", "branch-wt"]).trim().is_empty(),
            "the branch yaran created goes too"
        );
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one scenario walked in order on one repository, each step asserting on what the previous step left"
    )]
    fn factory_reset_of_a_locked_worktree_still_forgets_it_and_deletes_the_branch() {
        let tempdir = TempDir::new().expect("tempdir");
        let repo = tempdir.path().join("repo");
        fs::create_dir_all(&repo).expect("repo dir");
        let git = |cwd: &Path, args: &[&str]| {
            let out = yaran_core::test_git::fixture_git()
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "Test User"]);
        git(&repo, &["commit", "--allow-empty", "-m", "initial"]);

        let worktrees_root = tempdir.path().join("worktrees");
        fs::create_dir_all(&worktrees_root).expect("worktrees root");
        let worktree = worktrees_root.join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "branch-wt",
                worktree.to_str().unwrap(),
            ],
        );
        // git refuses to remove a locked worktree while it is still
        // registered: the reset deletes the folder itself, then forgets this
        // registration and deletes the branch the way a removal does.
        git(&repo, &["worktree", "lock", worktree.to_str().unwrap()]);

        let paths = YaranPaths {
            config_path: tempdir.path().join("config.toml"),
            sessions_db_path: tempdir.path().join("sessions.sqlite3"),
            worktrees_root: worktrees_root.clone(),
            lock_path: tempdir.path().join("dux.lock"),
            socket_path: tempdir.path().join("yaran.sock"),
            root: tempdir.path().to_path_buf(),
        };
        let now = Utc::now();
        let session = AgentSession {
            id: "wt".to_string(),
            agent_handle: "wt".to_string(),
            shared_workspace: false,
            deleted_at: None,
            slot_tab_id: "wt-slot".to_string(),
            provider: ProviderKind::new("claude"),
            title: None,
            started_providers: Vec::new(),
            desired_running: false,
            auto_reopen_enabled: true,
            status: SessionStatus::Active,
            created_at: now,
            updated_at: now,
            last_focused_tab: None,
            workspace: yaran_core::model::AgentWorkspace::Managed(
                yaran_core::model::ManagedWorkspace {
                    project_id: "proj".to_string(),
                    project_path: Some(repo.to_string_lossy().to_string()),
                    source_branch: "main".to_string(),
                    branch_name: "branch-wt".to_string(),
                    initial_branch: "branch-wt".to_string(),
                    branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                    worktree_path: worktree.to_string_lossy().to_string(),
                },
            ),
        };

        remove_session_worktree(
            &paths,
            session
                .workspace
                .as_managed()
                .expect("the fixture builds a managed agent"),
            &yaran_core::branch_history::unasked_plan(
                session
                    .workspace
                    .as_managed()
                    .expect("the fixture builds a managed agent"),
                session.created_at,
                &[],
            ),
            &[],
            &[],
            &mut ResetReport::discarding(),
        );

        assert!(!worktree.exists(), "the worktree directory must be removed");
        let branches = yaran_core::test_git::fixture_git()
            .args([
                "-C",
                repo.to_str().unwrap(),
                "branch",
                "--list",
                "branch-wt",
            ])
            .output()
            .expect("git branch --list");
        assert!(
            String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
            "the branch must be deleted (a stale worktree ref would keep it undeletable)",
        );
        let worktrees = yaran_core::test_git::fixture_git()
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "list",
                "--porcelain",
            ])
            .output()
            .expect("git worktree list");
        // Match the removed worktree's FULL path, never the bare "wt" dir name:
        // `git worktree list` always names the main worktree, whose path is the
        // random tempfile dir, and a 2-char substring like "wt" matches that
        // random path by chance (a rare-but-real CI flake). The full path is
        // unique to the removed registration, so its absence is the real signal.
        let removed_registration = worktree.to_string_lossy();
        assert!(
            !String::from_utf8_lossy(&worktrees.stdout).contains(removed_registration.as_ref()),
            "no stale worktree registration for the removed path may remain in the repo",
        );
    }

    #[test]
    fn the_factory_reset_summary_counts_the_worktrees() {
        assert_eq!(removed_worktrees_line(0), "removed 0 session worktrees");
        assert_eq!(removed_worktrees_line(1), "removed 1 session worktree");
        assert_eq!(removed_worktrees_line(3), "removed 3 session worktrees");
    }

    fn session_args(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_string()).collect()
    }

    fn run_session_reading(harness: &ResetHarness, args: &[&str], stdin: &str) -> Result<i32> {
        let mut input = std::io::Cursor::new(stdin.as_bytes().to_vec());
        run_session_with_input(&session_args(args), &harness.paths, &mut input)
    }

    #[test]
    fn session_purge_requires_hard_a_target_and_known_exclusive_flags() {
        let harness = ResetHarness::new();
        harness.create_session("agent-1");
        let cases: &[(&[&str], &str)] = &[
            (&["purge", "agent-1"], "requires --hard"),
            (&["purge", "--hard"], "missing target"),
            (
                &["purge", "--hard", "agent-1", "agent-2"],
                "unexpected positional",
            ),
            (&["purge", "--hard", "--wat", "agent-1"], "unknown flag"),
            (
                &[
                    "purge",
                    "--hard",
                    "--accept-residual-data",
                    "--workspace-wide-provider-history",
                    "agent-1",
                ],
                "mutually exclusive",
            ),
            (&["purge-all", "extra"], "unexpected positional"),
            (&["wat"], "unknown session subcommand"),
        ];
        for (args, expected) in cases {
            let error =
                run_session_reading(&harness, args, "").expect_err("invalid arguments must error");
            assert!(error.to_string().contains(expected), "{args:?}: {error}");
        }
        assert!(harness.paths.worktrees_root.join("agent-1").exists());
    }

    #[test]
    fn session_purge_aborts_on_wrong_phrase_and_dry_run_changes_nothing() {
        let harness = ResetHarness::new();
        harness.write_config_with_log_path("yaran.log");
        let worktree = harness.create_session("agent-1");
        // The AMQ step needs the durable store identity even in a dry run: a
        // missing one fails the purge closed rather than disowning inboxes.
        yaran_core::storage::load_or_create_store_id(&harness.paths.root).unwrap();

        let code = run_session_reading(
            &harness,
            &["purge", "--hard", "agent-1"],
            "PURGE something-else\n",
        )
        .expect("aborting is not an error");
        assert_eq!(code, EXIT_PURGE_ABORTED);
        assert!(worktree.exists());

        let code = run_session_reading(&harness, &["purge-all"], "PURGE\n").expect("abort");
        assert_eq!(code, EXIT_PURGE_ABORTED);
        assert!(worktree.exists());

        let code = run_session_reading(&harness, &["purge", "--hard", "--dry-run", "agent-1"], "")
            .expect("dry run");
        assert_eq!(code, 0);
        assert!(worktree.exists());
        let store = SessionStore::open(&harness.paths.sessions_db_path).unwrap();
        assert_eq!(store.load_sessions_including_deleted().unwrap().len(), 1);
    }

    /// A config that does not parse must stop a purge before anything is
    /// planned: the lenient loader would fall back to defaults, register no
    /// projects, and so protect none of them.
    #[test]
    fn session_purge_fails_closed_on_an_unparseable_config() {
        let harness = ResetHarness::new();
        let worktree = harness.create_session("agent-1");
        fs::write(&harness.paths.config_path, "not = [valid").unwrap();

        let error = run_session_reading(&harness, &["purge", "--hard", "--yes", "agent-1"], "")
            .expect_err("corrupt config must refuse");
        assert!(
            format!("{error:#}").contains(&harness.paths.config_path.display().to_string()),
            "{error:#}"
        );
        assert!(worktree.exists());

        let no_db = ResetHarness::new();
        let error = run_session_reading(&no_db, &["purge-all", "--yes"], "")
            .expect_err("missing database must refuse");
        assert!(error.to_string().contains("nothing to purge"), "{error}");
    }

    /// A link in the worktrees root (worktrees kept on another disk, say)
    /// points at a folder outside it. The reset only unlinks the link and
    /// keeps the folder, but a terminal's recorded job working there is still
    /// stopped, like every program yaran started.
    #[test]
    fn a_factory_reset_stops_a_job_in_the_target_of_a_link_it_only_unlinks() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).expect("elsewhere");
        fs::write(elsewhere.join("keep.txt"), "mine\n").expect("seed");
        fs::create_dir_all(&paths.worktrees_root).expect("root");
        std::os::unix::fs::symlink(&elsewhere, paths.worktrees_root.join("ssd")).expect("link");
        let home = tmp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        let mut command = std::process::Command::new("sleep");
        command.arg("60").current_dir(&elsewhere);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn the job");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some(yaran_core::process_sessions::UNOWNED_PTYS.to_string()),
                session,
                folder: home.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("a standalone terminal".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        let _ = reset_agent_data(&paths, &mut ResetReport::discarding());

        let alive = job.try_wait().expect("try_wait").is_none();
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            elsewhere.join("keep.txt").exists(),
            "the link's target is kept"
        );
        assert!(
            !alive,
            "a terminal's job working in {}, a folder the reset keeps, was left running",
            elsewhere.display()
        );
    }

    /// An agent's terminal session started in its worktree left a job the
    /// user moved into their own project's repository (which the reset keeps).
    /// The job is stopped too: the reset stops everything yaran started.
    #[test]
    fn a_factory_reset_stops_a_job_in_a_kept_repository_whose_session_started_in_a_worktree() {
        use std::os::unix::process::CommandExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = YaranPaths {
            root: tmp.path().to_path_buf(),
            config_path: tmp.path().join("config.toml"),
            sessions_db_path: tmp.path().join("sessions.sqlite3"),
            worktrees_root: tmp.path().join("worktrees"),
            lock_path: tmp.path().join("dux.lock"),
            socket_path: tmp.path().join("yaran.sock"),
        };
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        let worktree = paths.worktrees_root.join("proj").join("feat");
        fs::create_dir_all(&worktree).expect("worktree");
        // Leader in the worktree; its job in the user's repository.
        let mut command = std::process::Command::new("sh");
        command
            .arg("-c")
            .arg(format!(
                "(cd '{}' && exec sleep 61) & exec sleep 62",
                repo.display()
            ))
            .current_dir(&worktree);
        // SAFETY: the hook runs in the forked child before exec and calls only
        // `setsid`, which is async-signal-safe and touches no Rust state.
        unsafe {
            command.pre_exec(|| {
                rustix::process::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
        let mut job = command.spawn().expect("spawn");
        let session = yaran_core::process_sessions::ProcessSession::started_now(job.id());
        std::thread::sleep(std::time::Duration::from_millis(300));
        let child_pid = yaran_core::process_sessions::read_process_table()
            .into_iter()
            .find(|row| row.ppid == Some(job.id()))
            .map(|row| row.pid)
            .expect("the job in the repository");
        let store = SessionStore::open(&paths.sessions_db_path).expect("store");
        store
            .replace_process_registry(&[yaran_core::process_sessions::StoredSession {
                owner: Some("m1".to_string()),
                session,
                folder: worktree.clone(),
                standalone: false,
                survivors: Vec::new(),
                label: Some("terminal of agent m1".to_string()),
            }])
            .expect("save the registry");
        drop(store);

        let _ = reset_agent_data(&paths, &mut ResetReport::discarding());

        std::thread::sleep(std::time::Duration::from_millis(200));
        let repo_job_alive = yaran_core::process_sessions::read_process_table()
            .iter()
            .any(|row| row.pid == child_pid && !row.exited);
        let _ = rustix::process::kill_process_group(
            rustix::process::Pid::from_raw(job.id().cast_signed()).unwrap(),
            rustix::process::Signal::KILL,
        );
        let _ = job.kill();
        let _ = job.wait();
        assert!(
            !repo_job_alive,
            "a job (pid {child_pid}) working in the kept repository {} was left running",
            repo.display()
        );
    }
}

#[cfg(test)]
mod config_diff_names_tests {
    use super::*;
    const TOKEN: &str = "sk-proj-AbCdEf0123456789";

    /// `yaran config diff` (the summary that is safe to paste into a bug
    /// report) must not print a provider name that breaks the provider-name
    /// rule: such a name may be a token pasted in the wrong place.
    #[test]
    fn config_diff_does_not_print_a_rule_breaking_provider_name() {
        let text = format!("[providers.\"{TOKEN} x\"]\ncommand = \"a\"\n");
        let config: Config = toml::from_str(&text).unwrap();
        let changes = collect_config_changes(&config).join("\n");
        assert!(!changes.contains(TOKEN), "{changes}");
    }

    /// The same for a `[keys]` name that is no action.
    #[test]
    fn config_diff_does_not_print_a_rule_breaking_keys_name() {
        let text = format!("[keys]\n\"{TOKEN} x\" = [\"ctrl-q\"]\n");
        let config: Config = toml::from_str(&text).unwrap();
        let changes = collect_config_changes(&config).join("\n");
        assert!(!changes.contains(TOKEN), "{changes}");
    }
}

#[cfg(test)]
#[path = "cli/preview_leak_tests.rs"]
mod preview_leak_tests;

#[cfg(test)]
#[path = "cli/plaintext_shape_preview_tests.rs"]
mod plaintext_shape_preview_tests;

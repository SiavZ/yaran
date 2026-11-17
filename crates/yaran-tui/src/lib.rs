//! Yaran TUI library: the terminal user-interface surface over `yaran-core`.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! lib.rs
//! ├── app
//! ├── cli
//! ├── clipboard
//! ├── config
//! ├── config_cli
//! ├── config_saver
//! ├── config_spec
//! ├── diff
//! ├── doctor
//! ├── host_keys
//! ├── key_decode
//! ├── key_encode
//! ├── keybindings
//! ├── numeric
//! ├── raw_input
//! ├── server_screen
//! ├── theme
//! ├── tui_color
//! ├── yaran-core::background_serve
//! ├── yaran-core::editor
//! ├── yaran-core::engine
//! ├── yaran-core::file_modes
//! ├── yaran-core::focus
//! ├── yaran-core::git
//! ├── yaran-core::io_retry
//! ├── yaran-core::lockfile
//! ├── yaran-core::logger
//! ├── yaran-core::model
//! ├── yaran-core::pty
//! ├── yaran-core::reload_handoff
//! ├── yaran-core::reload_signal
//! ├── yaran-core::serve_log
//! ├── yaran-core::startup
//! ├── yaran-core::statusline
//! ├── yaran-core::storage
//! └── yaran-core::term_identity
//! External: anyhow, std, tempfile
//!
//! Used by:
//! lib.rs
//! ├── app
//! ├── app::attachment_presence
//! ├── app::background_server
//! ├── app::changes_tree
//! ├── app::debug_input
//! ├── app::diff_comments::delivery_tests
//! ├── app::diff_comments::tests
//! ├── app::dock
//! ├── app::ellipsis_rows
//! ├── app::first_load
//! ├── app::hangup
//! ├── app::hint_lines
//! ├── app::human_board
//! ├── app::human_board::tests
//! ├── app::human_board_relay
//! ├── app::input
//! ├── app::input::host_selection_regression_tests
//! ├── app::modal
//! ├── app::name_chip_dialogs
//! ├── app::picker_lists
//! ├── app::pr_clone
//! ├── app::presize
//! ├── app::project_actions
//! ├── app::pty_ownership
//! ├── app::pull_requests
//! ├── app::redraw
//! ├── app::render
//! ├── app::sessions
//! ├── app::test_support
//! ├── app::ui_jobs
//! ├── app::workers
//! ├── app::worktree_manager
//! ├── cli
//! ├── config
//! ├── config_saver
//! ├── diff
//! ├── theme
//! ├── yaran[bin yaran]
//! ├── yaran[bin yaran]::cli_reference
//! ├── yaran[bin yaran]::client_commands
//! └── yaran[test config_resources]::support
//! ```
//! <module-headers:end>

mod app;
mod cli;
mod clipboard;
mod config;
mod config_cli;
mod config_saver;
mod config_spec;
mod diff;
mod doctor;
mod host_keys;
// The terminal-focus grace state machine is core-owned (`yaran_core::focus`),
// shared by rule with the web's viewed-ping grace.
pub(crate) use yaran_core::focus;
mod key_decode;
mod key_encode;
mod keybindings;
mod numeric;
mod raw_input;
mod server_screen;
mod theme;
mod tui_color;

pub(crate) use config_saver::TuiConfigSurface;

/// Server status screen shown by the binary while serving after a TUI↔server
/// flip. Re-exported so `crates/yaran/src/main.rs` can drive it as the
/// `serve_with_engine` tick.
pub use server_screen::{ServerScreenTick, ServerStatusScreen, restore_terminal};

/// Register the fully-commented config renderer with `yaran-core`, so that any
/// surface which CREATES `config.toml` writes the documented template rather
/// than a bare one. Re-exported so `crates/yaran/src/main.rs` can call it on the
/// `yaran server` path, which never goes through the TUI's `ensure_config`.
pub use config::install_canonical_renderer;
pub use config_spec::config_command;

/// The hidden password prompt `yaran remote login` signs in with.
pub use config_cli::{SecretInput, read_env_value, read_sign_in_password};

// Domain modules now live in yaran-core. Re-export them at the crate root so
// existing `crate::<mod>::…` paths across the binary keep resolving unchanged.
pub(crate) use yaran_core::{
    editor, git, io_retry, lockfile, logger, model, pty, startup, statusline, storage,
};

use std::io::Write as _;
use std::path::Path;

use anyhow::Result;

use yaran_core::engine::Engine;

/// How the TUI surface exited. `Done` ends the process; `FlipToServer` hands
/// the live engine (PTYs still running, single-instance lock held inside the
/// engine) and pre-bound listeners to the binary so the web server can take
/// over the same process. The binary resumes the TUI via
/// [`resume_after_server`] when the server stops. LOCAL MODE may bind more than
/// one address (loopback + Tailscale), so `listeners`/`urls` are vectors.
pub enum TuiExit {
    /// The user quit: the process ends.
    Done,
    /// The user switched to the web server, which takes over this process.
    FlipToServer {
        /// The live engine, its PTYs still running and the single-instance lock
        /// inside it.
        engine: Box<Engine>,
        /// The listeners already bound for the server to accept on.
        listeners: Vec<std::net::TcpListener>,
        /// The URL each listener is reached at, in the same order.
        urls: Vec<String>,
        /// What the pre-flight learned (its warnings, the Tailscale bind
        /// failures, whether an address was detected), so the server's log opens
        /// with the same lines `yaran server` prints.
        startup: yaran_core::serve_log::StartupNotes,
    },
    /// Exec onto a newer yaran, keeping the running agents alive.
    ///
    /// The engine rides along, and holding it here is what makes the reload
    /// safe: nothing is dropped, so no `PtyClient` closes a master the next
    /// image is about to inherit. The binary writes the handoff, then execs; if
    /// either step fails it still owns a fully working engine and can carry on.
    Reload {
        /// The engine, carried across the exec.
        engine: Box<Engine>,
        /// What the next image adopts.
        handoff: yaran_core::reload_handoff::Handoff,
    },
}

impl std::fmt::Debug for TuiExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Done => f.write_str("Done"),
            Self::FlipToServer { urls, .. } => f
                .debug_struct("FlipToServer")
                .field("urls", urls)
                .finish_non_exhaustive(),
            Self::Reload { .. } => f.debug_struct("Reload").finish_non_exhaustive(),
        }
    }
}

/// Run `yaran config <args>`, given the arguments after the word `config` exactly
/// as typed; every message and exit code is the config code's own.
///
/// # Errors
///
/// When the config folder cannot be located or locked, or when the
/// subcommand refuses or fails; the error carries the message it prints.
pub fn run_config(config_args: &[String]) -> Result<()> {
    cli::finish_config(run_config_command(config_args))
}

/// [`run_config`] before a result it could not print is told apart.
fn run_config_command(config_args: &[String]) -> Result<()> {
    let paths = config::YaranPaths::discover()?;
    // Help anywhere in a config command (before a literal `--`) prints the
    // config help, before any lock is taken.
    if cli::asks_for_help(config_args) {
        return cli::run(&["--help".to_string()], &paths);
    }
    let _lock = match lock_for_config_subcommand(config_args, &paths)? {
        ConfigLock::Held(lock) => Some(lock),
        ConfigLock::NotNeeded => None,
        // The one look at whether there is anything to reset. A reset that
        // went on would look again without the lock.
        ConfigLock::NothingToReset => {
            writeln!(
                cli::ResultOut(std::io::stdout()),
                "nothing to reset: {} does not exist",
                paths.root.display()
            )?;
            return Ok(());
        }
    };

    cli::run(config_args, &paths)
}

/// `yaran doctor [--json] [--anonymize]`: the operator's diagnostic dump. It
/// changes nothing; its database section reads only while no yaran holds the
/// lock (see `doctor`).
///
/// # Errors
///
/// When the config folder cannot be located, or an argument is not one of the two flags.
pub fn run_doctor(args: &[String]) -> Result<()> {
    if let Some(unknown) = args
        .iter()
        .find(|a| !matches!(a.as_str(), "--json" | "--anonymize"))
    {
        anyhow::bail!("unknown argument to yaran doctor: {unknown}");
    }
    let paths = config::YaranPaths::discover()?;
    doctor::run_doctor(
        &paths,
        if args.iter().any(|a| a == "--json") {
            doctor::DoctorFormat::Json
        } else {
            doctor::DoctorFormat::Text
        },
        if args.iter().any(|a| a == "--anonymize") {
            doctor::Privacy::Anonymized
        } else {
            doctor::Privacy::Shown
        },
    )
}

/// `yaran session purge|purge-all`: the hard purge of an agent's stored data.
/// Every mutating form takes the single-instance lock first, so a purge never
/// races a running yaran that would recreate what it deletes, and only the lock
/// holder ever opens `sessions.sqlite3`. `--help` and a missing root need no
/// lock and must not create the root just to take one. Returns the exit code.
///
/// # Errors
///
/// When the config folder cannot be located or the purge fails.
pub fn run_session(session_args: &[String]) -> Result<i32> {
    let paths = config::YaranPaths::discover()?;
    let _lock = match purge_lock(session_args, &paths) {
        Ok(lock) => lock,
        Err(err) => {
            line_to_stderr(format_args!("{err}"));
            std::process::exit(1);
        }
    };
    cli::run_session(session_args, &paths)
}

/// A purge opens the session database, which only the holder of `dux.lock`
/// may: it takes the lock, and is refused while a running yaran holds it.
/// Anything else `yaran session` does needs no lock.
fn purge_lock(
    session_args: &[String],
    paths: &config::YaranPaths,
) -> Result<Option<lockfile::SingleInstanceLock>> {
    match session_args.first().map(String::as_str) {
        Some("purge" | "purge-all") if paths.root.exists() => Ok(Some(
            lockfile::SingleInstanceLock::acquire(&paths.lock_path)?,
        )),
        _ => Ok(None),
    }
}

/// Run the terminal UI; the `yaran` binary calls it when no command was given.
/// `companion` is the background web server it may serve through, which the binary implements.
///
/// # Errors
///
/// When the config folder cannot be located or created, when the terminal UI
/// cannot start (the config, the session database or the terminal refuses),
/// or when its event loop stops on an error.
pub fn run(
    companion: Box<dyn yaran_core::background_serve::BackgroundServeCompanion>,
) -> Result<TuiExit> {
    let paths = config::YaranPaths::discover()?;

    // Before the lock: `kill -USR1` reaches whoever holds it, and the signal's
    // default action would end this process. Idempotent.
    if let Err(err) = yaran_core::reload_signal::install() {
        // backtick-ok: printed to the terminal yaran was started from, never a status.
        line_to_stderr(format_args!(
            "warning: {err}; `kill -USR1` cannot reload this yaran, use Reload config in it"
        ));
    }

    // TUI: always create the root directory (so the lockfile can be
    // opened), acquire the lock, then let bootstrap create everything
    // else. A losing process never touches shared state beyond the
    // empty root.
    create_private_root(&paths)?;
    let lock = acquire_lock_or_exit(&paths.lock_path);
    let app = app::App::bootstrap_with_lock(paths, lock)?;
    run_app(app, companion)
}

/// Resume the TUI after the web server hands the engine back. The engine still
/// owns the live providers and the single-instance lock, so this rebuilds the
/// App view state around it (no session relaunch) and runs the loop. A resumed
/// TUI can flip to the server again, so the flip↔serve cycle repeats.
///
/// # Errors
///
/// When the terminal cannot be taken back or the event loop stops on an
/// error.
pub fn resume_after_server(
    mut engine: Box<Engine>,
    companion: Box<dyn yaran_core::background_serve::BackgroundServeCompanion>,
) -> Result<TuiExit> {
    // Back under the TUI: `auto`/`mirror` identity resolves against the real host
    // terminal again. Already-running PTYs keep their spawn-time env until they
    // are relaunched.
    engine.surface_kind = yaran_core::term_identity::SurfaceKind::Tui;
    // Capture stayed on while the server owned the host; drop whatever accumulated
    // so the resumed TUI does not replay a stale passthrough backlog to the host
    // terminal it is only now taking back.
    engine.discard_passthrough_backlog();
    let app = app::App::resume(*engine)?;
    run_app(app, companion)
}

/// Resume the TUI after a reload's `exec` failed, with `reason` on the status
/// line.
///
/// The engine never left this process, so this is the same rebuild as coming
/// back from the web server: no session relaunch, every provider still live.
/// The handoff had already stopped every PTY's reader thread, so they are
/// restarted first. Without that, the resumed TUI would show terminals that
/// never update again.
///
/// # Errors
///
/// Fails when the terminal UI cannot be set up again.
pub fn resume_after_failed_reload(
    mut engine: Box<Engine>,
    companion: Box<dyn yaran_core::background_serve::BackgroundServeCompanion>,
    reason: String,
    selected_session: Option<String>,
) -> Result<TuiExit> {
    engine.resume_all_pty_readers();
    let mut app = app::App::resume(*engine)?;
    // Back on the agent the user was looking at, not "No agent selected".
    app.reload_selected_session = selected_session;
    app.restore_selection_after_reload();
    app.set_error(reason);
    run_app(app, companion)
}

/// Run an App's event loop and translate its [`app::RunExit`] into a
/// [`TuiExit`] for the binary's orchestration loop. On a flip, the engine is
/// moved out of the App (no `Drop` runs on the providers, since neither `App`
/// nor `Engine` has a `Drop` impl, so this is a plain move) and boxed for the
/// caller; the single-instance lock rides along inside the engine.
fn run_app(
    mut app: app::App,
    companion: Box<dyn yaran_core::background_serve::BackgroundServeCompanion>,
) -> Result<TuiExit> {
    // Installed here, before the loop, so `App::run` can honor
    // `[server] serve_while_tui` on its very first iteration.
    app.companion = Some(companion);
    match app.run()? {
        app::RunExit::Quit => Ok(TuiExit::Done),
        app::RunExit::FlipToServer {
            listeners,
            urls,
            startup,
        } => {
            // Serving headless: `auto` identity now resolves to the forced
            // ghostty identity for agents launched under the server. Existing
            // PTYs keep their spawn-time env until relaunch.
            let mut engine = app.into_engine();
            engine.surface_kind = yaran_core::term_identity::SurfaceKind::WebHeadless;
            // Drop any TUI-era passthrough backlog so the server does not inherit a
            // stale ring; capture continues under the server for the web bridge.
            engine.discard_passthrough_backlog();
            Ok(TuiExit::FlipToServer {
                engine: Box::new(engine),
                listeners,
                urls,
                startup,
            })
        }
        app::RunExit::Reload { handoff } => {
            // The engine is MOVED OUT rather than dropped, for the same reason
            // the flip does it: dropping an `Engine` drops every `PtyClient`,
            // which closes the masters the next image is about to inherit and
            // takes the agents down with them. Holding it alive until the exec
            // is what makes the reload seamless.
            Ok(TuiExit::Reload {
                engine: Box::new(app.into_engine()),
                handoff,
            })
        }
    }
}

/// What the lock decision for a `config` subcommand came to.
enum ConfigLock {
    Held(lockfile::SingleInstanceLock),
    NotNeeded,
    /// A reset with no config folder to reset: nothing to lock or do.
    NothingToReset,
}

/// Take the single-instance lock for the `config` subcommands that mutate shared
/// on-disk state, creating the config folder owner-only first.
fn lock_for_config_subcommand(
    config_args: &[String],
    paths: &config::YaranPaths,
) -> Result<ConfigLock> {
    let sub = config_args.first().map_or("", std::string::String::as_str);
    Ok(match sub {
        // Decided here, so a missing root is not created just to take a lock.
        "reset" if !paths.root.exists() => ConfigLock::NothingToReset,
        "reset" => {
            create_private_root(paths)?;
            ConfigLock::Held(acquire_lock_or_exit(&paths.lock_path))
        }

        // Locked before any write, so a TUI cannot start between creating
        // the root and writing the config.
        "regenerate" if config_args.iter().any(|a| a == "--yes") => {
            create_private_root(paths)?;
            ConfigLock::Held(acquire_lock_or_exit(&paths.lock_path))
        }

        // `set` runs beside a live yaran, which holds this lock for its whole
        // life; its write takes the config file's own lock instead.
        _ => ConfigLock::NotNeeded,
    })
}

/// One line on standard error, for what the terminal UI says on its way in or
/// out. A line that cannot be written is dropped: there is nowhere else to say it.
pub(crate) fn line_to_stderr(line: std::fmt::Arguments<'_>) {
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

/// Create the config folder owner-only, before any path opens the lock file in it.
fn create_private_root(paths: &config::YaranPaths) -> Result<()> {
    yaran_core::file_modes::create_private_dir_all(&paths.root)?;
    Ok(())
}

fn acquire_lock_or_exit(path: &Path) -> lockfile::SingleInstanceLock {
    match lockfile::SingleInstanceLock::acquire(path) {
        Ok(lock) => lock,
        Err(err) => {
            line_to_stderr(format_args!("{err}"));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purge_refuses_while_yaran_holds_the_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = config::YaranPaths {
            config_path: dir.path().join("config.toml"),
            sessions_db_path: dir.path().join("sessions.sqlite3"),
            worktrees_root: dir.path().join("worktrees"),
            lock_path: dir.path().join("dux.lock"),
            socket_path: dir.path().join("yaran.sock"),
            root: dir.path().to_path_buf(),
        };
        let args = |words: &[&str]| words.iter().map(ToString::to_string).collect::<Vec<_>>();
        let running = lockfile::SingleInstanceLock::acquire(&paths.lock_path).expect("yaran");
        for purge in [&["purge", "--hard", "x"][..], &["purge-all"][..]] {
            assert!(
                purge_lock(&args(purge), &paths).is_err(),
                "{purge:?} must not open the database under a running yaran"
            );
        }
        assert!(
            purge_lock(&args(&["--help"]), &paths)
                .expect("help")
                .is_none()
        );
        drop(running);
        assert!(
            purge_lock(&args(&["purge-all"]), &paths)
                .expect("stopped")
                .is_some()
        );
    }

    #[test]
    fn config_reset_tightens_an_existing_loose_folder_and_a_missing_one_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("restored-home");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let paths = config::YaranPaths {
            root: root.clone(),
            config_path: root.join("config.toml"),
            sessions_db_path: root.join("sessions.sqlite3"),
            worktrees_root: root.join("worktrees"),
            lock_path: root.join("dux.lock"),
            socket_path: root.join("yaran.sock"),
        };

        let lock = lock_for_config_subcommand(&["reset".to_string()], &paths).unwrap();
        assert!(matches!(lock, ConfigLock::Held(_)));
        drop(lock);
        let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);

        let missing = dir.path().join("never-created");
        let absent = config::YaranPaths {
            root: missing.clone(),
            lock_path: missing.join("dux.lock"),
            socket_path: missing.join("yaran.sock"),
            ..paths
        };
        assert!(matches!(
            lock_for_config_subcommand(&["reset".to_string()], &absent).unwrap(),
            ConfigLock::NothingToReset
        ));
        assert!(!missing.exists());
    }

    #[test]
    fn the_config_folder_is_created_owner_only_before_the_lock_file_exists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fresh-home");
        let paths = config::YaranPaths {
            root: root.clone(),
            config_path: root.join("config.toml"),
            sessions_db_path: root.join("sessions.sqlite3"),
            worktrees_root: root.join("worktrees"),
            lock_path: root.join("dux.lock"),
            socket_path: root.join("yaran.sock"),
        };

        create_private_root(&paths).unwrap();

        let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert!(!paths.lock_path.exists());
    }
}

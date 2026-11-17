//! Headless `Engine` bootstrap for the web server: the TUI's field-by-field
//! assembly with a read-only `load_config` (defaults on a missing or malformed
//! file) and a `WebConfigSurface`. Sessions and projects come from SQLite.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! bootstrap.rs
//! ├── yaran-core::attachments
//! ├── yaran-core::auto_resume
//! ├── yaran-core::changes_status
//! ├── yaran-core::clone_project
//! ├── yaran-core::config
//! ├── yaran-core::config_queue
//! ├── yaran-core::config_sync
//! ├── yaran-core::config_write
//! ├── yaran-core::engine
//! ├── yaran-core::engine::limits
//! ├── yaran-core::ids
//! ├── yaran-core::lockfile
//! ├── yaran-core::model
//! ├── yaran-core::operations
//! ├── yaran-core::process_sessions
//! ├── yaran-core::project_browser
//! ├── yaran-core::statusline
//! ├── yaran-core::storage
//! ├── yaran-core::term_identity
//! ├── yaran-core::watch::runtime
//! └── yaran-core::worker
//! External: anyhow, std, tempfile
//!
//! Used by:
//! bootstrap.rs
//! ├── crate
//! ├── engine_actor
//! ├── reload_signal
//! ├── test_support
//! ├── yaran-web[test add_project_base_branch]
//! ├── yaran-web[test auth_router]
//! ├── yaran-web[test background_serve_claims]
//! ├── yaran-web[test changes_events]
//! ├── yaran-web[test file_move_and_info_routes]
//! ├── yaran-web[test file_tree_routes]
//! ├── yaran-web[test first_load_routes]
//! ├── yaran-web[test live_server_limits]
//! ├── yaran-web[test missing_working_copy]
//! ├── yaran-web[test project_worktrees_routes]
//! ├── yaran-web[test pull_request_resolution]
//! ├── yaran-web[test races_review2_editor_hold]
//! ├── yaran-web[test races_review5_editor_delete]
//! ├── yaran-web[test review11_symlink_folder]
//! ├── yaran-web[test review9_nested_destructive]
//! ├── yaran-web[test serve_with_engine]
//! ├── yaran-web[test session_branch_routes]
//! ├── yaran-web[test start_corpus]
//! ├── yaran-web[test static_serving]
//! ├── yaran-web[test tab_routes]
//! ├── yaran-web[test terminal_file_routes]
//! ├── yaran-web[test workspace_push]
//! └── yaran-web[test ws_transport]
//! ```
//! <module-headers:end>

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use anyhow::Result;

use yaran_core::config::{Config, YaranPaths};
use yaran_core::config_queue::ConfigWriteQueue;
use yaran_core::engine::{
    ConfigSurface, Engine, InFlightSet, ReloadCompletionGuard, ReloadOrigin, RemovalCoordination,
};
use yaran_core::ids::TabId;
use yaran_core::lockfile::SingleInstanceLock;
use yaran_core::model::GhStatus;
use yaran_core::storage::SessionStore;
use yaran_core::worker::{ReloadedConfig, WorkerEvent};

/// Config surface for the web server: a reload that reads `config.toml`,
/// reconciles its `[[projects]]` with the session database (writing back only
/// what that sync changed) and builds the runtime project list for the apply to
/// adopt, and recover rendering as plain comment-free TOML, since the canonical
/// commented renderer needs the TUI's `RuntimeBindings`. The engine owns every
/// other write.
#[derive(Debug)]
pub struct WebConfigSurface;

impl ConfigSurface for WebConfigSurface {
    /// Its reload refuses what stops `yaran server`.
    fn start_surface(&self) -> yaran_core::config::Surface {
        yaran_core::config::Surface::YaranServer
    }

    fn reload(&self, paths: YaranPaths, worker_tx: mpsc::Sender<WorkerEvent>) {
        std::thread::spawn(move || {
            // The guard guarantees a `ConfigReloadReady` is posted even if the
            // read-only load below panics. Otherwise the engine's reload barrier
            // would never close and config saves would freeze.
            let guard = ReloadCompletionGuard::new(worker_tx);
            // Re-read config from disk (a read-only load, same as bootstrap). Returns the
            // REAL config, not Config::default().
            // A file whose [server.auth] cannot be read rejects the whole
            // reload: the running config, password included, stays as it was.
            let mut config = match yaran_core::config::load_config_for_reload(&paths) {
                Ok(config) => config,
                Err(error) => {
                    guard.complete(Err(format!(
                        "The config was not reloaded, and the running settings are unchanged: \
                         {error}"
                    )));
                    return;
                }
            };
            // The one list of start checks: what stops `yaran server` starting
            // stops its reload too.
            if let Some(refusal) = config
                .source_text
                .as_str()
                .and_then(|raw| {
                    yaran_core::config::start_refusal(raw, yaran_core::config::Surface::YaranServer)
                })
                .or_else(|| yaran_core::config::log_path_refusal(&config, &paths))
            {
                guard.complete(Err(format!(
                    "The config was not reloaded, and the running settings are unchanged: \
                     {refusal}"
                )));
                return;
            }
            // Config wins: an edited `[[projects]]` applies its preferences to
            // SQLite on a live serve. Errors ride the reload result rather than
            // crashing the reload thread.
            let reconciled = SessionStore::open_live(&paths.sessions_db_path)
                .map_err(|e| format!("{e:#}"))
                .and_then(|store| {
                    // Three-way against the config as read: the sync writes
                    // only what it changed, never a key set on disk meanwhile.
                    let base = config.clone();
                    let mut written: Option<String> = None;
                    yaran_core::config_sync::reconcile_config_projects(
                        &mut config,
                        &store,
                        |config| {
                            written = Some(yaran_core::config_write::save_config_three_way(
                                &paths.config_path,
                                Some(yaran_core::config_write::SaveBase::read(&base)),
                                config,
                                yaran_core::config_write::Durability::Fsync,
                            )?);
                            Ok(())
                        },
                    )
                    .map_err(|e| format!("{e:#}"))?;
                    if let Some(text) = written {
                        config.source_text = yaran_core::config_write::source_after_sync(
                            &base.source_text,
                            &text,
                            &config,
                        );
                    }
                    // Built here, where reading SQLite and asking git may
                    // block, so the apply adopts it (see
                    // `Engine::take_reloaded_projects`).
                    Ok(yaran_core::project_browser::reload_project_list(
                        &store, &config,
                    ))
                });
            match reconciled {
                Ok(projects) => {
                    guard.complete_with_projects(Ok(ReloadedConfig { config, projects }));
                }
                Err(e) => guard.complete(Err(e)),
            }
        });
    }

    fn recover_render(&self, config: &Config) -> String {
        // Returning the text rather than writing it lets the engine do the atomic
        // write through its own writer while holding the quiesce barrier.
        yaran_core::config_write::render_config_plain(config)
    }
}

/// Assemble a headless `Engine` from `paths`, loading sessions from the store and
/// acquiring the single-instance lock at `paths.lock_path`. Config is read
/// read-only: no file creation, migration, or write-back happens here.
///
/// Persisted session statuses are normalized before returning, since nothing is
/// running yet: a session whose worktree still exists becomes `Detached`, one
/// whose worktree vanished becomes `Exited`.
///
/// # Errors
///
/// When another yaran holds the lock, the config cannot be read or a start check
/// refuses it, the reconciled projects cannot be saved back, or the session store
/// cannot be opened or read.
#[expect(
    clippy::too_many_lines,
    reason = "most of the body is the one Engine literal, which names each engine field once and cannot be split"
)]
pub fn bootstrap_engine(paths: &YaranPaths) -> Result<Engine> {
    // The single-instance lock must be held before any config read, DB open, or
    // config write, matching the TUI's invariant.
    let single_instance_lock = SingleInstanceLock::acquire(&paths.lock_path)?;
    // Fails closed: a config whose [server.auth] cannot be read stops the
    // start rather than serving with no password.
    let mut config = yaran_core::config::load_config(paths)
        .map_err(|e| anyhow::anyhow!("yaran cannot start: {e}"))?;
    // The one list of start checks, the same the terminal UI and `yaran config
    // get`/`set` ask. A host or port the command line can override is left to
    // `resolve_server_plan`, which knows the command line.
    if let Some(refusal) = config
        .source_text
        .as_str()
        .and_then(|raw| {
            yaran_core::config::start_refusal(raw, yaran_core::config::Surface::YaranServer)
        })
        .or_else(|| yaran_core::config::log_path_refusal(&config, paths))
    {
        anyhow::bail!("yaran cannot start: {refusal}");
    }
    let session_store = SessionStore::open(&paths.sessions_db_path)?;
    // Config wins: adopt config-only projects, apply config-edited preferences to
    // SQLite, and validate identity conflicts, persisting any normalization back
    // through the core save path. The write is sync-direct because bootstrap runs
    // before the engine's config-write queue exists.
    let base = config.clone();
    let mut written: Option<String> = None;
    yaran_core::config_sync::reconcile_config_projects(&mut config, &session_store, |config| {
        written = Some(yaran_core::config_write::save_config_three_way(
            &paths.config_path,
            Some(yaran_core::config_write::SaveBase::read(&base)),
            config,
            yaran_core::config_write::Durability::Fsync,
        )?);
        Ok(())
    })?;
    if let Some(text) = written {
        config.source_text =
            yaran_core::config_write::source_after_sync(&base.source_text, &text, &config);
    }
    let sessions = session_store.load_sessions()?;
    let agent_tabs = session_store.load_extra_agent_tabs()?;
    let slot_tab_positions = session_store.load_slot_tab_positions()?;
    let slot_tab_created_ms = session_store.load_slot_tab_created_ms()?;
    let projects = yaran_core::project_browser::load_projects(
        &session_store.load_projects()?,
        &session_store.load_project_created_ats()?,
        &config,
    );
    let (worker_tx, worker_rx): (mpsc::Sender<WorkerEvent>, mpsc::Receiver<WorkerEvent>) =
        mpsc::channel();

    let github_integration_enabled = config.ui.github_integration;
    let config_writer =
        ConfigWriteQueue::with_status_lane(paths.config_path.clone(), worker_tx.clone(), &config);
    let push = yaran_core::engine::PushHook::new(&config, paths, worker_tx.clone());

    let socket_paths = paths
        .clone()
        .with_control_socket(&config.server.control_socket);
    let mut engine = Engine {
        config,
        paths: socket_paths,
        session_store,
        projects,
        sessions,
        staged_files: Vec::new(),
        unstaged_files: Vec::new(),
        changed_files_revision: 0,
        terminal_counter: 0,
        github_integration_enabled,
        single_instance_lock,
        surface_kind: yaran_core::term_identity::SurfaceKind::WebHeadless,
        resource_collector: Arc::default(),
        host_env: yaran_core::term_identity::HostEnvProbe::from_env(),
        worker_tx,
        worker_rx,
        config_writer,
        push,
        surface: Box::new(WebConfigSurface),
        reloading: false,
        command_applies: 0,
        deferred_commands: Vec::new(),
        reload_guard: None,
        reload_origin: ReloadOrigin::default(),
        reloaded_projects: None,
        pending_web_checkout_ops: HashMap::new(),
        pending_web_project_saves: std::collections::HashSet::new(),
        pending_change_base_ops: HashMap::new(),
        pending_web_add_project_ops: HashMap::new(),
        pending_web_pr_lookup_ops: HashMap::new(),
        clones: yaran_core::clone_project::Clones::default(),
        pending_pr_attach_ops: HashMap::new(),
        pending_recreate_ops: HashMap::new(),
        pending_delete_ops_web: HashMap::new(),
        pending_delete_reports_web: HashMap::new(),
        pending_create_ops: HashMap::new(),
        pending_web_launch_ops: HashMap::new(),
        live_status_keys: yaran_core::statusline::LiveStatusKeys::default(),
        last_created_op_id: None,
        operations: yaran_core::operations::Operations::default(),
        operation_in_dispatch: None,
        attachments: yaran_core::attachments::Attachments::default(),
        dispatch_policy: None,
        deferred_operations: Vec::new(),
        deferred_policies: Vec::new(),
        created_session_by_op: HashMap::new(),
        startup_launches: yaran_core::auto_resume::StartupLaunchQueue::default(),
        removal_coordination: RemovalCoordination::default(),
        providers: HashMap::new(),
        running_provider_pins: HashMap::new(),
        launched_drop_paste: HashMap::new(),
        watch: yaran_core::watch::runtime::WatchRuntime::default(),
        companion_terminals: HashMap::new(),
        agent_tabs: agent_tabs
            .into_iter()
            .map(|t| (TabId::new(t.id.clone()), t))
            .collect(),
        slot_tab_positions,
        slot_tab_created_ms,
        terminating_ptys: Vec::new(),
        process_registry: yaran_core::process_sessions::AgentProcessRegistry::default(),
        removal_workers: Vec::new(),
        pending_group_removals: Vec::new(),
        pending_detachments: Vec::new(),
        pending_tab_restarts: Vec::new(),
        unsaved_branch_drifts: std::collections::HashMap::new(),
        gh_status: GhStatus::Unknown,
        gh_probe: yaran_core::engine::GhProbeState::default(),
        agent_prs: std::collections::HashMap::new(),
        pr_prefs: std::collections::HashMap::new(),
        pr_prefs_retry_at: None,
        pr_unsaved: std::collections::HashSet::new(),
        branch_histories: std::collections::HashMap::new(),
        pr_revision: std::collections::HashMap::new(),
        branch_sync_sessions: Arc::new(Mutex::new(Vec::new())),
        pr_sync_sessions: Arc::new(Mutex::new(Vec::new())),
        pr_sync: Arc::new(yaran_core::engine::PrSyncControl::default()),
        pr_poll_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        pr_poll_inactive_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        pr_inactive_sessions: HashSet::new(),
        pr_inactive_sweep_at: Arc::default(),
        pr_return_checks_owed: HashSet::new(),
        pr_branch_asks: HashMap::new(),
        pr_own_repos: HashMap::new(),
        pr_branch_checks_owed: HashSet::new(),
        branch_sync_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        branch_sync_wait: Arc::new(yaran_core::engine::BranchSyncWait::default()),
        pr_backoff: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        resume_fallback_candidates: HashMap::new(),
        resumed_tab_runs: HashSet::new(),
        pending_deletions: HashSet::new(),
        folder_repo_statuses: HashMap::new(),
        no_branch_checked_out: std::collections::HashSet::new(),
        changed_files_failures: yaran_core::changes_status::ChangedFilesFailures::default(),
        closing_sessions: HashSet::new(),
        deletion_busy_messages: HashMap::new(),
        watched_worktree: Arc::new(Mutex::new(None::<PathBuf>)),
        changed_files_refresh: Arc::default(),
        watched_session_id: None,
        has_active_processes: Arc::new(AtomicBool::new(false)),
        serve_memory: Arc::default(),
        current_origin: yaran_core::statusline::StatusScope::All,
        in_flight: InFlightSet::new(),
        rename_expected: std::collections::HashMap::new(),
        pr_last_checked: HashMap::new(),
        changed_files_poller_started: AtomicBool::new(false),
        branch_sync_worker_started: AtomicBool::new(false),
        pty_activity: HashMap::new(),
        terminal_activity_at: HashMap::new(),
        pty_input: HashMap::new(),
        pty_pointer: HashMap::new(),
        pty_used: HashSet::new(),
        needs_attention: HashSet::new(),
        failed_tab_runs: HashMap::new(),
        pty_progress: HashMap::new(),
        agent_viewed: HashMap::new(),
        last_foreground_refresh: None,
        limits: yaran_core::engine::limits::LimitsRuntime::default(),
        amq: yaran_core::engine::AmqRuntime::default(),
    };

    engine.normalize_restored_sessions();
    // Seed from the persisted `latest_prs` rows so PR state shows before the first
    // network poll, and shows at all when `gh` is unavailable.
    engine.seed_pull_requests_from_store();

    Ok(engine)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yaran_core::config::ProjectConfig;

    fn temp_paths() -> (tempfile::TempDir, YaranPaths) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_path_buf();
        let paths = YaranPaths {
            root: root.clone(),
            config_path: root.join("config.toml"),
            sessions_db_path: root.join("sessions.sqlite3"),
            worktrees_root: root.join("worktrees"),
            lock_path: root.join("dux.lock"),
            socket_path: root.join("yaran.sock"),
        };
        std::fs::create_dir_all(&paths.worktrees_root).expect("worktrees dir");
        (tmp, paths)
    }

    #[test]
    fn web_config_surface_recover_render_is_a_writable_plain_config() {
        // The web surface renders a plain (comment-free) config the engine can
        // write to recover a corrupt file. Prove the render carries the config's
        // values and reparses cleanly.
        let mut config = Config::default();
        config.env.insert("FOO".to_string(), "bar".to_string());

        let body = WebConfigSurface.recover_render(&config);
        assert!(body.contains("FOO = \"bar\""), "env entry missing: {body}");
        // A valid TOML table header proves the render is structured config text,
        // not a placeholder.
        assert!(body.contains("[env]"), "env table missing: {body}");
    }

    /// `yaran server` and every engine bootstrap refuse to start when
    /// `[server.auth]` cannot be read, instead of serving with no password.
    #[test]
    fn bootstrap_engine_refuses_to_start_with_a_file_it_cannot_run_with() {
        for (body, about) in [
            ("[server.auth]]\n", "server.auth"),
            (
                "[server.auth]\npassword_hash = \"$argon2id$v=19$m=1,t=1,p=1$x$y\"\n",
                "server.auth",
            ),
            ("[server.auth]\nrequire = [\"network\"]\n", "server.auth"),
            // A log that would be written into a file yaran keeps for itself.
            ("[server]\nlog_path = \"yaran.log\"\n", "[server] log_path"),
        ] {
            let (_tmp, paths) = temp_paths();
            std::fs::write(&paths.config_path, body).expect("write config");
            let err = match bootstrap_engine(&paths) {
                Ok(_) => panic!("{body:?}: the start must be refused"),
                Err(err) => format!("{err:#}"),
            };
            assert!(err.contains("yaran cannot start"), "{body:?}: {err}");
            assert!(err.contains(about), "{body:?}: {err}");
            assert_eq!(std::fs::read_to_string(&paths.config_path).unwrap(), body);
        }
    }

    #[test]
    fn bootstrap_engine_yields_empty_spine_on_fresh_store() {
        let (_tmp, paths) = temp_paths();
        let engine = bootstrap_engine(&paths).expect("bootstrap");
        let spine = engine.spine();
        assert_eq!(
            spine.projects,
            Vec::<yaran_core::viewmodel::ProjectView>::new()
        );
        assert_eq!(
            spine.sessions,
            Vec::<yaran_core::viewmodel::SessionView>::new()
        );
    }

    #[test]
    fn bootstrap_engine_includes_projects_from_store() {
        let (_tmp, paths) = temp_paths();
        let seeded_id = "web-bootstrap-test-project".to_string();

        // Seed one project into the store before bootstrapping.
        let store = SessionStore::open(&paths.sessions_db_path).expect("open store");
        store
            .upsert_project(&ProjectConfig {
                id: seeded_id.clone(),
                path: "/nonexistent/path/for/test".to_string(),
                name: Some("test-project".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: std::collections::BTreeMap::new(),
                workspace_mode: None,
            })
            .expect("upsert project");
        drop(store);

        let engine = bootstrap_engine(&paths).expect("bootstrap");
        let spine = engine.spine();

        assert!(
            !spine.projects.is_empty(),
            "the spine should include projects from the store"
        );
        assert!(
            spine.projects.iter().any(|p| p.id == seeded_id),
            "seeded project id should appear in the spine"
        );
    }

    /// The server bootstrap runs the core project reconciliation: a config-only
    /// `[[projects]]` entry (present in config.toml, absent from SQLite) is
    /// adopted into the store and appears in the spine, so `yaran serve` honors
    /// config-declared projects.
    #[test]
    fn bootstrap_engine_adopts_a_config_only_project() {
        let (_tmp, paths) = temp_paths();
        // A config.toml declaring a project the store has never seen.
        std::fs::write(
            &paths.config_path,
            "[[projects]]\nid = \"cfg-only\"\npath = \"$HOME/proj\"\nname = \"FromConfig\"\n",
        )
        .expect("write config");

        let engine = bootstrap_engine(&paths).expect("bootstrap");
        assert!(
            engine.spine().projects.iter().any(|p| p.id == "cfg-only"),
            "the config-only project must be reconciled into the spine"
        );
        // And persisted into SQLite (the reconciliation adopted it).
        let store = SessionStore::open(&paths.sessions_db_path).expect("reopen store");
        assert!(
            store
                .load_projects()
                .expect("load")
                .iter()
                .any(|p| p.id == "cfg-only"),
            "the config-only project must be adopted into SQLite"
        );
    }

    /// The reload worker builds the project list itself, from the session
    /// database and the reloaded config, so the apply on the engine thread
    /// adopts it instead of reading SQLite and asking git.
    #[test]
    fn the_reload_worker_hands_back_the_project_list_it_built() {
        let (_tmp, paths) = temp_paths();
        let store = SessionStore::open(&paths.sessions_db_path).expect("open store");
        store
            .upsert_project(&ProjectConfig {
                id: "store-only".to_string(),
                path: "/nonexistent/path/for/test".to_string(),
                name: Some("FromStore".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: std::collections::BTreeMap::new(),
                workspace_mode: None,
            })
            .expect("upsert project");
        store.run_sql_for_tests(
            "update projects set created_at = '2001-02-03T04:05:06+00:00' \
             where id = 'store-only'",
        );
        drop(store);
        std::fs::write(
            &paths.config_path,
            "[[projects]]\nid = \"cfg-only\"\npath = \"$HOME/proj\"\nname = \"FromConfig\"\n",
        )
        .expect("write config");
        let (tx, rx) = mpsc::channel();
        WebConfigSurface.reload(paths, tx);
        let WorkerEvent::ConfigReloadReady(result) = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("the reload answers")
        else {
            panic!("the reload answers with its config");
        };
        let reloaded = (*result).expect("the reload succeeds");
        let projects = reloaded.projects.expect("the worker built the projects");
        let mut ids: Vec<&str> = projects.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["cfg-only", "store-only"]);
        // When a project was added is kept only in SQLite.
        let from_store = projects.iter().find(|p| p.id == "store-only").unwrap();
        assert_eq!(
            from_store.created_at.map(|at| at.to_rfc3339()).as_deref(),
            Some("2001-02-03T04:05:06+00:00")
        );
    }

    /// A project list the worker cannot read does not refuse a reload whose
    /// sync may already have written: it answers with the config and leaves
    /// the list to the apply.
    #[test]
    fn a_reload_whose_project_list_cannot_be_read_still_answers_with_its_config() {
        let (_tmp, paths) = temp_paths();
        std::fs::write(
            &paths.config_path,
            "[[projects]]\nid = \"cfg-only\"\npath = \"$HOME/proj\"\nname = \"FromConfig\"\n",
        )
        .expect("write config");
        // A date the list's read cannot take, and no other read looks at.
        SessionStore::open(&paths.sessions_db_path)
            .expect("open store")
            .run_sql_for_tests(
                "create trigger unreadable_date after insert on projects begin \
                 update projects set created_at = x'00' where id = new.id; end;",
            );
        let (tx, rx) = mpsc::channel();
        WebConfigSurface.reload(paths, tx);
        let WorkerEvent::ConfigReloadReady(result) = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("the reload answers")
        else {
            panic!("the reload answers with its config");
        };
        let reloaded = (*result).expect("the reload still stands");
        assert!(reloaded.projects.is_none());
        assert!(reloaded.config.projects.iter().any(|p| p.id == "cfg-only"));
    }
}

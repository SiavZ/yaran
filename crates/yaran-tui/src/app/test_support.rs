//! Shared test fixtures used by more than one `app` submodule's test module
//! (currently `input.rs` and `render.rs`). Render-behaviour tests live next to
//! the render code, but they need the same `App` builder and PTY-cursor polling
//! helper as the input tests, so those fixtures live here rather than being
//! duplicated. Compiled only under `#[cfg(test)]` (see the module declaration
//! in `mod.rs`).
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! app/test_support.rs
//! ├── app
//! ├── app::background_server
//! ├── app::cloud_commands
//! ├── app::debug_input
//! ├── app::diff_comments
//! ├── app::human_board
//! ├── app::presize
//! ├── app::ui_jobs
//! ├── clipboard
//! ├── config
//! ├── crate
//! ├── diff
//! ├── host_keys
//! ├── keybindings
//! ├── raw_input
//! ├── theme
//! ├── yaran-core::attachments
//! ├── yaran-core::auto_resume
//! ├── yaran-core::changes_status
//! ├── yaran-core::clone_project
//! ├── yaran-core::config
//! ├── yaran-core::config_queue
//! ├── yaran-core::engine
//! ├── yaran-core::engine::amq
//! ├── yaran-core::engine::limits
//! ├── yaran-core::ids
//! ├── yaran-core::model
//! ├── yaran-core::operations
//! ├── yaran-core::process_sessions
//! ├── yaran-core::pty
//! ├── yaran-core::term_identity
//! ├── yaran-core::test_git
//! ├── yaran-core::test_provider
//! └── yaran-core::watch::runtime
//! External: jiff, std, tempfile
//!
//! Used by:
//! app/test_support.rs
//! ├── app
//! ├── app::attachment_presence
//! ├── app::background_server
//! ├── app::changes_tree
//! ├── app::cloud_crumb
//! ├── app::cloud_mode
//! ├── app::cloud_tests
//! ├── app::command_palette::tests
//! ├── app::confirm_dialog
//! ├── app::debug_input
//! ├── app::diff_comments::tests
//! ├── app::dock
//! ├── app::ellipsis_rows
//! ├── app::first_load
//! ├── app::grouped_sidebar_tests
//! ├── app::hint_lines
//! ├── app::human_board::tests
//! ├── app::input
//! ├── app::input::host_click_regression_tests
//! ├── app::input::host_selection_regression_tests
//! ├── app::modal
//! ├── app::name_chip_dialogs
//! ├── app::new_agent_settings
//! ├── app::no_branch_notice
//! ├── app::orphan_worktrees
//! ├── app::overlay_dismiss
//! ├── app::picker_lists
//! ├── app::presize
//! ├── app::project_actions
//! ├── app::pty_ownership
//! ├── app::pull_requests
//! ├── app::redraw
//! ├── app::render
//! ├── app::session_settings
//! ├── app::sessions
//! ├── app::shared_workspace_tests
//! ├── app::tab_reorder
//! ├── app::ui_audit_tests
//! ├── app::ui_jobs
//! ├── app::workers
//! └── app::worktree_manager
//! ```
//! <module-headers:end>

use crate::app::ChangesTreeState;
use crate::app::background_server::ReloadListenerChanges;
use crate::app::{
    App, CenterMode, ChangeAgentProviderMode, ChangeAgentProviderOption, ChangeAgentProviderPrompt,
    ChangeDefaultProviderOption, ChangeDefaultProviderPrompt, ChangeProjectDefaultProviderOption,
    ChangeProjectDefaultProviderPrompt, FocusPane, FullscreenOverlay, InactiveTailState,
    InputTarget, LeftRowsState, MouseLayoutState, OneShotNotes, OverlayMouseLayoutState, PaneFlags,
    PromptState, RawPaste, RedrawGate, RightSection, ServingFlags, TextInput, ViewPrefs,
    WelcomeLogo,
};
use crate::clipboard::Clipboard;
use crate::config::{ProjectConfig, YaranPaths};
use crate::keybindings::{BINDING_DEFS, RuntimeBindings};
use crate::model::{AgentSession, Project, ProjectBranchStatus, ProviderKind, SessionStatus};
use crate::statusline::KeyedStatusController;
use crate::statusline::LiveStatusKeys;
use crate::statusline::StatusScope;
use crate::storage::SessionStore;
use crate::theme::Theme;
use jiff::Timestamp;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, mpsc};
use tempfile::tempdir;
use yaran_core::attachments::Attachments;
use yaran_core::changes_status::ChangedFilesFailures;
use yaran_core::clone_project::Clones;
use yaran_core::engine::BranchSyncWait;
use yaran_core::engine::GhProbeState;
use yaran_core::engine::PrSyncControl;
use yaran_core::engine::ReloadOrigin;
use yaran_core::engine::RemovalCoordination;
use yaran_core::operations::Operations;
use yaran_core::process_sessions::AgentProcessRegistry;

/// Whether a worktree a test builds has uncommitted changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorktreeState {
    /// It has uncommitted changes.
    Dirty,
    /// It has none.
    Clean,
}

pub(crate) fn default_bindings() -> RuntimeBindings {
    RuntimeBindings::new(|action| {
        BINDING_DEFS
            .iter()
            .find(|d| d.action == action)
            .map_or_default(|d| d.default_keys.to_vec())
    })
}

pub(crate) fn run_git(cwd: &std::path::Path, args: &[&str]) {
    run_git_output(cwd, args);
}

/// [`run_git`], returning the command's trimmed stdout.
pub(crate) fn run_git_output(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = yaran_core::test_git::fixture_git()
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub(crate) fn init_test_repo(path: &std::path::Path) {
    run_git(path, &["init", "-b", "main"]);
    run_git(path, &["config", "user.name", "test"]);
    run_git(path, &["config", "user.email", "t@t"]);
    run_git(path, &["commit", "--allow-empty", "-m", "init"]);
}

#[expect(
    clippy::too_many_lines,
    reason = "one field initializer per App field, the test twin of the production constructor"
)]
pub(crate) fn test_app(bindings: RuntimeBindings) -> App {
    let tmp = tempdir().expect("tempdir");
    let root = tmp.path().to_path_buf();
    init_test_repo(&root);

    let paths = YaranPaths {
        config_path: root.join("config.toml"),
        sessions_db_path: root.join("sessions.sqlite3"),
        worktrees_root: root.join("worktrees"),
        lock_path: root.join("dux.lock"),
        socket_path: root.join("yaran.sock"),
        root: root.clone(),
    };
    std::fs::create_dir_all(&paths.worktrees_root).expect("worktrees dir");
    let session_store = SessionStore::open(&paths.sessions_db_path).expect("session store");
    let now = Timestamp::now();
    let project = Project {
        id: "project-1".to_string(),
        name: "demo".to_string(),
        path: root.to_string_lossy().to_string(),
        explicit_default_provider: None,
        default_provider: ProviderKind::from_str("codex"),
        leading_branch: Some("main".to_string()),
        auto_reopen_agents: None,
        startup_command: None,
        env: std::collections::BTreeMap::default(),
        current_branch: "main".to_string(),
        branch_status: ProjectBranchStatus::Unknown,
        path_missing: false,
        created_at: None,
    };
    session_store
        .upsert_project(&ProjectConfig {
            id: project.id.clone(),
            path: project.path.clone(),
            name: Some(project.name.clone()),
            default_provider: None,
            leading_branch: project.leading_branch.clone(),
            auto_reopen_agents: project.auto_reopen_agents,
            startup_command: project.startup_command.clone(),
            env: project.env.clone(),
            workspace_mode: None,
        })
        .expect("seed project");
    let session = AgentSession {
        id: "session-1".to_string(),
        agent_handle: "session-1".to_string(),
        shared_workspace: false,
        deleted_at: None,
        slot_tab_id: "session-1-slot".to_string(),
        provider: ProviderKind::from_str("codex"),
        title: None,
        started_providers: Vec::new(),
        desired_running: false,
        auto_reopen_enabled: true,
        status: SessionStatus::Detached,
        created_at: now,
        updated_at: now,
        last_focused_tab: None,
        workspace: yaran_core::model::AgentWorkspace::Managed(
            yaran_core::model::ManagedWorkspace {
                project_id: project.id.clone(),
                project_path: Some(project.path.clone()),
                source_branch: "main".to_string(),
                branch_name: "agent-branch".to_string(),
                initial_branch: "agent-branch".to_string(),
                branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                worktree_path: paths.worktrees_root.to_string_lossy().to_string(),
            },
        ),
    };
    let (worker_tx, worker_rx) = mpsc::channel();
    let single_instance_lock = crate::lockfile::SingleInstanceLock::acquire(&paths.lock_path)
        .expect("single-instance lock for test App");
    let config_writer = yaran_core::config_queue::ConfigWriteQueue::with_status_lane(
        paths.config_path.clone(),
        worker_tx.clone(),
        &yaran_core::config::Config::default(),
    );
    let engine = yaran_core::engine::Engine {
        // An existing install (no `[workspace]` section), so the harness keeps
        // upstream's worktree create flow. Shared-mode tests opt in explicitly.
        // Harmless provider commands, so no test in this crate execs the
        // developer's real agent CLI.
        config: {
            let mut config = yaran_core::test_provider::harmless_config();
            config.workspace = None;
            // The harness's row geometry (indexes, the Inactive tail) is the
            // FLAT sidebar's; those tests are the flat mode's regression suite.
            // Grouped-mode tests opt in explicitly.
            config.ui.sidebar_style = "flat".to_string();
            // Likewise the COMFORTABLE row heights (three-line agent rows);
            // compact-density tests opt in explicitly.
            config.ui.sidebar_density = "comfortable".to_string();
            config
        },
        paths,
        session_store,
        projects: vec![project],
        sessions: vec![session],
        staged_files: Vec::new(),
        unstaged_files: Vec::new(),
        changed_files_revision: 0,
        terminal_counter: 0,
        github_integration_enabled: false,
        single_instance_lock,
        surface_kind: yaran_core::term_identity::SurfaceKind::Tui,
        resource_collector: Arc::default(),
        host_env: yaran_core::term_identity::HostEnvProbe::default(),
        worker_tx,
        worker_rx,
        config_writer,
        push: yaran_core::engine::PushHook::off(),
        surface: Box::new(crate::TuiConfigSurface),
        reloading: false,
        command_applies: 0,
        deferred_commands: Vec::new(),
        reload_guard: None,
        reload_origin: ReloadOrigin::default(),
        reloaded_projects: None,
        providers: std::collections::HashMap::new(),
        running_provider_pins: std::collections::HashMap::new(),
        launched_drop_paste: HashMap::default(),
        watch: yaran_core::watch::runtime::WatchRuntime::default(),
        companion_terminals: std::collections::HashMap::new(),
        agent_tabs: std::collections::HashMap::new(),
        slot_tab_positions: std::collections::HashMap::new(),
        slot_tab_created_ms: std::collections::HashMap::new(),
        terminating_ptys: Vec::new(),
        process_registry: AgentProcessRegistry::default(),
        removal_workers: Vec::new(),
        pending_group_removals: Vec::new(),
        pending_detachments: Vec::new(),
        pending_tab_restarts: Vec::new(),
        unsaved_branch_drifts: std::collections::HashMap::new(),
        gh_status: crate::model::GhStatus::Unknown,
        gh_probe: GhProbeState::default(),
        agent_prs: std::collections::HashMap::new(),
        pr_prefs: std::collections::HashMap::new(),
        pr_prefs_retry_at: None,
        pr_unsaved: std::collections::HashSet::new(),
        branch_histories: std::collections::HashMap::new(),
        pr_revision: std::collections::HashMap::new(),
        branch_sync_sessions: Arc::new(Mutex::new(Vec::new())),
        pr_sync_sessions: Arc::new(Mutex::new(Vec::new())),
        pr_sync: Arc::new(PrSyncControl::default()),
        pr_poll_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        pr_poll_inactive_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        pr_inactive_sessions: HashSet::default(),
        pr_inactive_sweep_at: Arc::default(),
        pr_return_checks_owed: HashSet::default(),
        pr_branch_asks: HashMap::default(),
        pr_own_repos: HashMap::default(),
        pr_branch_checks_owed: HashSet::default(),
        branch_sync_interval_secs: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        branch_sync_wait: Arc::new(BranchSyncWait::default()),
        pr_backoff: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        resume_fallback_candidates: std::collections::HashMap::new(),
        resumed_tab_runs: std::collections::HashSet::new(),
        pending_deletions: std::collections::HashSet::new(),
        folder_repo_statuses: std::collections::HashMap::new(),
        no_branch_checked_out: std::collections::HashSet::new(),
        changed_files_failures: ChangedFilesFailures::default(),
        closing_sessions: std::collections::HashSet::new(),
        deletion_busy_messages: std::collections::HashMap::new(),
        watched_worktree: Arc::new(Mutex::new(None::<PathBuf>)),
        changed_files_refresh: Arc::default(),
        watched_session_id: None,
        current_origin: StatusScope::default(),
        has_active_processes: Arc::new(AtomicBool::new(false)),
        serve_memory: Arc::default(),
        in_flight: std::collections::HashSet::new(),
        rename_expected: std::collections::HashMap::new(),
        pr_last_checked: std::collections::HashMap::new(),
        changed_files_poller_started: AtomicBool::new(false),
        branch_sync_worker_started: AtomicBool::new(false),
        pty_activity: std::collections::HashMap::new(),
        terminal_activity_at: std::collections::HashMap::new(),
        pty_input: std::collections::HashMap::new(),
        pty_pointer: std::collections::HashMap::new(),
        pty_used: std::collections::HashSet::new(),
        needs_attention: std::collections::HashSet::new(),
        failed_tab_runs: std::collections::HashMap::new(),
        pty_progress: std::collections::HashMap::new(),
        agent_viewed: std::collections::HashMap::new(),
        last_foreground_refresh: None,
        limits: yaran_core::engine::limits::LimitsRuntime::default(),
        amq: yaran_core::engine::amq::AmqRuntime::default(),
        pending_web_checkout_ops: std::collections::HashMap::new(),
        pending_web_project_saves: std::collections::HashSet::new(),
        pending_change_base_ops: std::collections::HashMap::new(),
        pending_web_add_project_ops: std::collections::HashMap::new(),
        pending_web_pr_lookup_ops: std::collections::HashMap::new(),
        clones: Clones::default(),
        pending_pr_attach_ops: std::collections::HashMap::new(),
        pending_recreate_ops: std::collections::HashMap::new(),
        pending_delete_ops_web: std::collections::HashMap::new(),
        pending_delete_reports_web: std::collections::HashMap::new(),
        pending_create_ops: std::collections::HashMap::new(),
        pending_web_launch_ops: std::collections::HashMap::new(),
        live_status_keys: LiveStatusKeys::default(),
        last_created_op_id: None,
        operations: Operations::default(),
        operation_in_dispatch: None,
        attachments: Attachments::default(),
        dispatch_policy: None,
        deferred_operations: Vec::new(),
        deferred_policies: Vec::new(),
        created_session_by_op: std::collections::HashMap::new(),
        startup_launches: yaran_core::auto_resume::StartupLaunchQueue::default(),
        removal_coordination: RemovalCoordination::default(),
    };
    let app_live_status_keys = engine.live_status_keys.clone();
    let mut app = App {
        engine,
        bindings,
        selected_left: 0,
        left_scroll_offset: 0,
        left_terminals: Vec::new(),
        dock_layouts: std::collections::HashMap::new(),
        dock_active: std::collections::HashMap::new(),
        stopped_layout: None,
        last_dock_strip: None,
        right_section: RightSection::Unstaged,
        files_index: 0,
        files_search: TextInput::new(),
        files_search_active: false,
        commit_input: TextInput::new()
            .with_multiline(4)
            .with_placeholder("Type your commit message\u{2026}"),
        pending_commit: None,
        left_width_pct: 20,
        right_width_pct: 23,
        terminal_dock_pct: 35,
        staged_pane_height_pct: 50,
        commit_pane_height_pct: 40,
        focus: FocusPane::Left,
        center_mode: CenterMode::Agent,
        resize_mode: false,
        help_scroll: None,
        last_help_height: 0,
        last_help_lines: 0,
        last_first_load_height: 0,
        last_first_load_lines: 0,
        last_error_dialog_height: 0,
        last_error_dialog_lines: 0,
        pending_first_load: None,
        unpushed_count_rx: None,
        project_worktree_files: None,
        rename_pushed_rx: None,
        pr_clone_check_rx: None,
        ui_jobs: crate::app::ui_jobs::UiJobs::default(),
        path_completion: crate::app::PathCompletion::default(),
        browser_add: crate::app::BrowserAdd::default(),
        theme_previews: None,
        diff_wrap_ask: None,
        pr_clone_awaiting: None,
        notes_fetch_rx: None,
        orphan_worktrees_rx: None,
        cloud: crate::app::cloud_commands::CloudState::default(),
        deferred_first_load_notes: None,
        notes_fetch_explicit_request: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        )),
        fullscreen_overlay: FullscreenOverlay::None,
        startup_log_viewer: None,
        server_log_viewer: None,
        // The production default from `ui.status_clear_seconds`, deliberately
        // NOT zero: zero switches the status line out of its queue and into
        // most-recent-wins, so a test app built that way exercises a path almost
        // no user runs and would let a queueing bug through untouched.
        status: KeyedStatusController::with_clear_after(std::time::Duration::from_secs(u64::from(
            yaran_core::config::Config::default()
                .ui
                .status_clear_seconds,
        )))
        .with_live_keys(app_live_status_keys),
        missing_project_warning_gen: None,
        palette_hint_gen: None,
        palette_opened_over: super::PaletteOpenedOver::NotRecorded,
        prompt: PromptState::None,
        input_target: InputTarget::None,
        session_surface: crate::model::SessionSurface::Agent,
        // Fixtures must never start the platform pasteboard worker. Tests that
        // need copy results replace this with their own in-memory callback.
        clipboard: Clipboard::from_fn(|_| Ok(())),
        active_terminal_id: None,
        focused_tabs: std::collections::HashMap::new(),
        host_forward_carry: Vec::new(),
        extended_keys: crate::keybindings::ExtendedKeys::Off,
        host_keys: crate::host_keys::HostKeysState::default(),
        host_forward_error_logged_at: None,
        agent_tab_regions: Vec::new(),
        pty_sizes: std::collections::HashMap::new(),
        part_targets: crate::app::PartTargets::default(),
        tui_launched_ptys: HashSet::default(),
        pull_request_create: None,
        clone_draft: None,
        macro_editor_version: None,
        pending_new_agent_settings: None,
        armed_new_agent_settings: None,
        presize: crate::app::presize::PresizeState::default(),
        scroll_mode: std::collections::HashSet::new(),
        last_diff_height: 0,
        last_diff_visual_lines: 0,
        diff_rows: None,
        diff_comments: crate::app::diff_comments::DiffCommentsUi::default(),
        theme: Theme::default_dark(),
        tick_count: 0,
        start_time: std::time::Instant::now(),
        refusal_blink: None,
        inactive_search_dismissed: None,
        left_items_cache: Vec::new(),
        left_groups_cache: Vec::new(),
        collapsed_groups: std::collections::HashSet::new(),
        mouse_layout: MouseLayoutState::default(),
        overlay_layout: OverlayMouseLayoutState::default(),
        mouse_drag: None,
        row_drag: None,
        tab_drag: None,
        last_tab_strip: None,
        center_mouse_forward: None,
        last_mouse_click: None,
        pressed_button: None,
        dormant_tab_press: None,
        interactive_patterns: crate::keybindings::InteractiveBytePatterns {
            bindings: Vec::new(),
        },
        raw_input_parser: crate::raw_input::RawInputParser::default(),
        debug_raw_input: super::debug_input::DebugRawInput::default(),
        raw_input_buf: Vec::new(),
        loading_input_buf: Vec::new(),
        terminal_focus: crate::focus::TerminalFocus::new(),
        macro_bar: None,
        sigwinch_flag: Arc::new(AtomicBool::new(false)),
        sigwinch_sig_id: None,
        shutdown_flag: Arc::new(AtomicBool::new(false)),
        shutdown_sig_ids: Vec::new(),
        redraw: RedrawGate::default(),
        welcome_tip_index: 0,
        welcome_tip_selection: usize::MAX,
        syntax_cache: std::sync::Arc::new(crate::diff::SyntaxCache::new()),
        pending_diff: None,
        human_board: super::human_board::HumanBoardState::default(),
        changes_tree: ChangesTreeState::default(),
        diff_request_seq: 0,
        part_snapshots: crate::app::PartSnapshots::default(),
        terminal_selection: None,
        pending_link_click: None,
        pending_pr_banner_press: None,
        pr_cursors: std::collections::HashMap::new(),
        last_link_open: None,
        url_opener: crate::app::default_url_opener(),
        startup_log_selection: None,
        pending_server_flip: None,
        pending_reload: None,
        reload_selected_session: None,
        reload_target: None,
        drawn_ptys: Vec::new(),
        published_ptys: None,
        companion: None,
        left_rows: Vec::new(),
        tui_fallback_tabs: HashSet::default(),
        pending_background_server_start: None,
        pending_tailscale_mode_op: None,
        pending_cloud_mode_op: None,
        tailscale_answer_from: crate::app::TailscaleAnswerFrom::Serve,
        reload_listener_changes: ReloadListenerChanges::default(),
        pending_persist_ops: std::collections::HashMap::new(),
        configure_save_op: None,
        pending_worktree_ops: std::collections::HashMap::new(),
        pending_pr_lookup_ops: std::collections::HashMap::new(),
        pending_pr_reference: None,
        pending_pr_reference_op: None,
        dispatched_pr_lookups: Vec::new(),
        pending_delete_ops: std::collections::HashMap::new(),
        pending_reconnect_ops: std::collections::HashMap::new(),
        pending_checkout_inspect_ops: std::collections::HashMap::new(),
        pending_changed_files_refresh: None,
        pending_server_flip_op: None,
        pending_config_reload_op: None,
        pending_branch_listing: None,
        agent_filter: None,
        test_scratch_dirs: tmp.into(),
        panes: PaneFlags {
            left_collapsed: false,
            right_collapsed: false,
            right_hidden: false,
        },
        inactive_tail: InactiveTailState {
            collapsed: false,
            overridden: false,
        },
        raw_paste: RawPaste {
            in_bracket: false,
            normalize: false,
            newlines: crate::raw_input::PasteNewlines::default(),
        },
        welcome_logo: WelcomeLogo {
            visible: false,
            alt: false,
        },
        view_prefs: ViewPrefs {
            show_diff_line_numbers: false,
            pr_banner_at_bottom: true,
        },
        serving: ServingFlags {
            flip_preflight_pending: false,
            background_preflight_pending: false,
            background_wanted: false,
        },
        left_list: LeftRowsState {
            built: false,
            cursor_parked: false,
        },
        notes: OneShotNotes {
            force_redraw: false,
            companion_followup_ran: false,
            create_agent_started_here: false,
        },
    };
    app.interactive_patterns = app.bindings.interactive_byte_patterns();
    app.rebuild_left_items();
    app.selected_left = 1;
    app
}

impl App {
    /// Record `size` as the geometry last sent to the focused part's pty, as a
    /// render would, which is what a page of scrolling is measured against.
    pub(crate) fn set_focused_pty_size(&mut self, size: (u16, u16)) {
        if let Some(id) = self.selected_terminal_surface_id() {
            self.pty_sizes.insert(id, size);
        }
    }
}

/// A browser tab at 10.0.0.7 watching `pty_id`, a terminal of `agent`, as
/// the attachment registry records one.
pub(crate) fn watch_from_a_browser(app: &App, pty_id: &str, agent: &str) -> u64 {
    use yaran_core::attachments::{ConnectionFacts, Surface, Target, TargetKind};
    app.engine.attachments.register(
        "browser-tab",
        ConnectionFacts {
            surface: Surface::Browser,
            device: Some("Firefox".to_string()),
            address: Some("10.0.0.7".parse().unwrap()),
            verified: false,
            events: true,
            browser: None,
        },
        None,
    );
    app.engine
        .attachments
        .attach(
            "browser-tab",
            Target {
                kind: TargetKind::Tab,
                id: pty_id.to_string(),
                agent: Some(agent.to_string()),
            },
            None,
            None,
        )
        .unwrap()
}

/// The browser tab [`watch_from_a_browser`] opened closes its terminal.
pub(crate) fn stop_watching(app: &App, token: u64) {
    app.engine.attachments.detach(
        token,
        yaran_core::attachments::Ending::Deliberate,
        std::time::Instant::now(),
        std::time::Duration::ZERO,
    );
}

/// Whether the selected terminal surface has raised its has-output flag, the
/// one the renderer checks before it draws the grid rather than the loading
/// card. A frame drawn while it is down leaves the snapshot the test then
/// inspects unrefreshed, so a wait on the child's text, cursor or history
/// that a render follows waits on this too, rather than relying on the
/// reader to have raised it in the same step it parsed that output.
pub(crate) fn surface_has_output(app: &App) -> bool {
    app.selected_terminal_surface_client()
        .is_some_and(yaran_core::pty::PtyClient::has_output)
}

/// Block until the selected terminal surface has parsed `marker` into its
/// visible grid and is ready to be drawn (see [`surface_has_output`]). Pass the
/// LAST thing the child prints, so a test that scrolls or measures afterwards
/// is not racing output that is still arriving. Panics if that has not
/// happened within 10s.
pub(crate) fn wait_for_parsed_output(app: &mut App, marker: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        app.refresh_snapshot_buf();
        let screen: String = app
            .part_snapshots
            .main
            .buf
            .cells
            .iter()
            .map(|cell| cell.symbol.as_str())
            .collect();
        if screen.contains(marker) && surface_has_output(app) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "test setup: the child's output {marker:?} was not parsed and drawable within 10s"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Put the selected terminal surface into SCROLL MODE the way a user does:
/// wait until the child has actually produced scrollback history, scroll up by
/// `lines`, and record the gesture through the same entry point the scroll keys
/// and the wheel use. Polls instead of sleeping a fixed amount, so the test is
/// waiting on the fact it depends on (real history) rather than on a guess.
/// Also waits until the surface is drawable (see [`surface_has_output`]).
/// Panics if no history appears within ~2s.
pub(crate) fn enter_scroll_mode(app: &mut App, lines: usize) {
    for _ in 0..200 {
        if !surface_has_output(app) {
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }
        if let Some(provider) = app.selected_terminal_surface_client() {
            provider.scroll(yaran_core::pty::ScrollDirection::Up, lines);
            if provider.scrollback_offset() > 0 {
                app.note_user_scroll();
                assert!(
                    app.scroll_mode_active(),
                    "a user scroll above the live edge must enter scroll mode"
                );
                return;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("PTY produced no scrollback to scroll into within 2s");
}

/// Deterministically wait until the PTY child for the active terminal surface
/// has parked its cursor at the given (row, col), polling the live snapshot
/// instead of guessing a fixed sleep. The caller must have set up the surface
/// so `refresh_snapshot_buf` resolves a provider: either `session_surface ==
/// Agent` with the session's provider in `app.engine.providers`, or
/// `session_surface == Terminal` with `active_terminal_id` pointing at an
/// `app.engine.companion_terminals` entry. Also waits until the surface is
/// drawable (see [`surface_has_output`]). Panics with the observed cursor if
/// the child does not reach the expected position within ~2s.
pub(crate) fn wait_for_agent_cursor(app: &mut App, row: u16, col: u16) {
    for _ in 0..200 {
        app.refresh_snapshot_buf();
        if matches!(app.part_snapshots.get(app.focused_part()).buf.cursor, Some(c) if c.row == row && c.col == col)
            && surface_has_output(app)
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!(
        "PTY did not park its cursor at row {row}, col {col} within 2s (got {:?})",
        app.part_snapshots.get(app.focused_part()).buf.cursor
    );
}

/// Block until the PTY client keyed by `key` is in the exact state the exit
/// prune requires, END OF INPUT plus a REAPED EXIT STATUS, then return so the
/// caller can `drain_events()` exactly ONCE and assert the prune happened.
///
/// Both arms are load-bearing, and waiting on either alone has raced in the
/// past. They are different facts arriving from different places: `is_exited` is
/// set by the reader thread when the read side EOFs, while `try_wait` reaps the
/// child and stamps the reap instant. The prune policy is
/// `yaran_core::engine::agent_pty_ready_to_prune(exit_status_known, since_eof,
/// since_reap)`, which REFUSES to prune until it holds both, until
/// `REAPED_DRAIN_GRACE` (250ms) expires on either clock. Each fact is read
/// exactly once and cannot be recovered afterwards, so pruning early loses one:
/// without the drain the crash excerpt comes off a half-filled buffer, and
/// without the status `exit_success` is `None`, which stops a clean exit from
/// closing its tab row. Break on `is_exited` alone and the test lands inside the
/// window where the reader has `EOFed` but the child is not yet waitable (the
/// kernel closes a dying task's descriptors before it makes the task waitable),
/// one drain sees nothing, and the prune assertion fires: that is the roughly
/// 1-in-40 flake this helper exists to remove.
///
/// `try_wait` is memoized on `PtyClient`, so polling it here does not steal the
/// status from the prune that follows.
///
/// A single drain, rather than a retry loop, is also deliberate: with both facts
/// in hand the prune MUST fire. That is a product guarantee, and a loop would
/// stop pinning it.
pub(crate) fn wait_for_pty_eof(app: &mut App, key: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while !app
        .engine
        .providers
        .get_mut(yaran_core::ids::TabIdRef::new(key))
        .is_some_and(|c| c.is_exited() && c.try_wait().is_some())
    {
        assert!(
            std::time::Instant::now() < deadline,
            "PTY {key} never reached end of input with a reaped exit status"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Build the three provider pickers in a state a user can really reach:
/// two options, the FIRST one already active (so it is the no-op row) and
/// the second one a real change.
pub(crate) fn agent_provider_prompt() -> ChangeAgentProviderPrompt {
    ChangeAgentProviderPrompt {
        session_id: "s1".to_string(),
        tab_id: "s1".to_string(),
        session_label: "agent".to_string(),
        worktree_path: "/tmp/wt".to_string(),
        options: vec![
            ChangeAgentProviderOption {
                provider: ProviderKind::new("claude"),
                supports_resume: true,
                resume_available: false,
                is_current: true,
            },
            ChangeAgentProviderOption {
                provider: ProviderKind::new("codex"),
                supports_resume: true,
                resume_available: false,
                is_current: false,
            },
        ],
        selected: 0,
        mode: ChangeAgentProviderMode::Retarget,
    }
}

pub(crate) fn default_provider_prompt() -> ChangeDefaultProviderPrompt {
    ChangeDefaultProviderPrompt {
        current: ProviderKind::new("claude"),
        options: vec![
            ChangeDefaultProviderOption {
                provider: ProviderKind::new("claude"),
                is_current: true,
            },
            ChangeDefaultProviderOption {
                provider: ProviderKind::new("codex"),
                is_current: false,
            },
        ],
        selected: 0,
    }
}

pub(crate) fn project_default_provider_prompt(
    project_id: String,
    project_name: String,
) -> ChangeProjectDefaultProviderPrompt {
    ChangeProjectDefaultProviderPrompt {
        return_to: None,
        project_id,
        project_name,
        current: ProviderKind::new("claude"),
        global_default: ProviderKind::new("claude"),
        inherits_global_default: true,
        options: vec![
            ChangeProjectDefaultProviderOption {
                provider: None,
                is_current: true,
            },
            ChangeProjectDefaultProviderOption {
                provider: Some(ProviderKind::new("codex")),
                is_current: false,
            },
        ],
        selected: 0,
    }
}

/// Loopback addresses this host actually has, other than `127.0.0.1`, in the
/// order they were found.
///
/// A fixture that needs a SECOND local address (to hold one leg of a two-leg
/// bind busy while leaving the other free) cannot simply name `127.0.0.2`.
/// That works on Linux, where the whole `127.0.0.0/8` range is loopback and
/// bindable without configuration, and fails on macOS, which configures only
/// `127.0.0.1` on `lo0` and answers any other `127.x` with `EADDRNOTAVAIL`.
/// Adding an alias needs root, which a test may not assume.
///
/// So the host is ASKED rather than assumed. `ifconfig` is read because it
/// needs no new dependency and no `unsafe` FFI for what is a test-only
/// question; a machine that happens to carry extra `127.x` aliases (some do,
/// for unrelated reasons) is discovered correctly rather than being ruled out
/// by a hardcoded guess. An empty result is a legitimate answer and means the
/// caller must skip: there is no second address to stage the state with.
pub(crate) fn bindable_secondary_loopbacks() -> Vec<std::net::IpAddr> {
    let Ok(output) = std::process::Command::new("ifconfig").output() else {
        return Vec::new();
    };
    let Ok(text) = std::str::from_utf8(&output.stdout) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix("inet ") else {
            continue;
        };
        let Some(token) = rest.split_whitespace().next() else {
            continue;
        };
        let Ok(ip) = token.parse::<std::net::IpAddr>() else {
            continue;
        };
        // Loopback only: a routable address would make the "busy leg" reachable
        // from off the machine, which is not what the fixture is staging.
        if ip.is_loopback() && ip != std::net::IpAddr::from([127, 0, 0, 1]) && !found.contains(&ip)
        {
            found.push(ip);
        }
    }
    found
}

/// A test app's scratch root must go when the app does. Every test in this
/// crate builds one, so a helper that keeps the directory past the app fills the
/// temp directory one repository at a time (a RAM-backed `/tmp` runs out of
/// inodes long before it runs out of bytes).
#[test]
fn test_app_removes_its_scratch_root_when_dropped() {
    let app = test_app(default_bindings());
    let root = app.engine.paths.root.clone();
    assert!(root.join(".git").exists(), "the fixture repository exists");
    drop(app);
    assert!(
        !root.exists(),
        "the scratch root {} outlived the app",
        root.display()
    );
}

/// Every test in this crate builds its engine here, so a stock provider table
/// in the fixture would let any launching test exec the developer's real agent
/// CLI.
#[test]
fn test_app_cannot_launch_a_real_agent_cli() {
    let app = test_app(default_bindings());
    yaran_core::test_provider::assert_fixture_config_is_harmless(&app.engine.config);
}

/// Run every job a key put on a worker to its end, continuation included.
pub(crate) fn finish_ui_jobs(app: &mut App) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !app.ui_jobs.is_idle() {
        assert!(
            std::time::Instant::now() < deadline,
            "a worker job never answered; status: {}",
            app.status.text()
        );
        app.drain_ui_jobs();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Opening a worktree "in an editor" from this crate's tests resolves to the
/// stand-in and opens nothing, and a real editor command is refused rather
/// than launched on the developer's desktop.
#[test]
fn test_app_opens_worktrees_only_in_the_stand_in_editor() {
    let mut app = test_app(default_bindings());
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().to_string_lossy().into_owned();
    let editors = crate::editor::detect_installed_editors();
    let editor = crate::editor::preferred_editor(&editors, &app.engine.config.editor.default)
        .expect("the fixture always has a stand-in editor");
    assert_eq!(
        editor.command,
        yaran_core::test_provider::HARMLESS_EDITOR_COMMAND
    );
    app.open_worktree_in_editor(&path, "agent", &editor)
        .expect("the stand-in launches");

    let mut real = editor.clone();
    real.command = "code".to_string();
    let err = app
        .open_worktree_in_editor(&path, "agent", &real)
        .unwrap_err();
    assert!(err.to_string().starts_with("test guard:"), "{err}");
}

/// The Pull requests modal as it opens for `session_id`.
pub(crate) fn pull_requests_prompt(session_id: &str) -> crate::app::PullRequestsPrompt {
    crate::app::PullRequestsPrompt {
        session_id: session_id.to_string(),
        view: crate::app::PullRequestsView::PullRequests,
        cursor: 0,
        show_hidden: false,
    }
}

/// A pull request yaran found, as the sync would record it: `owner/repo#number`
/// on github.com, titled `title`.
pub(crate) fn found_pr(
    owner_repo: &str,
    number: u64,
    state: yaran_core::model::PrState,
    title: &str,
) -> crate::model::AgentPr {
    crate::model::AgentPr::found(
        &yaran_core::model::PrInfo {
            number,
            state,
            title: title.to_string(),
            host: "github.com".to_string(),
            owner_repo: owner_repo.to_string(),
            url: format!("https://github.com/{owner_repo}/pull/{number}"),
            ..Default::default()
        },
        Timestamp::now(),
    )
}

/// The repository every test app is built on never signs a commit, even for a
/// developer whose global config signs everything: the app's own git commands
/// inherit that global config, so the answer has to live in the repository.
#[test]
fn the_shared_fixture_repository_never_signs_under_a_signing_global_config() {
    let dir = tempfile::tempdir().expect("tempdir");
    let global = dir.path().join("global-gitconfig");
    std::fs::write(
        &global,
        "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n",
    )
    .expect("write the simulated global config");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(&repo).expect("repo dir");
    init_test_repo(&repo);
    for key in ["commit.gpgsign", "tag.gpgsign"] {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "--get", key])
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .output()
            .expect("run git config");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "false",
            "{key} in the shared fixture repository"
        );
    }
}

/// Run a sleeping shell as terminal `id` owned by `owner`, placed after every
/// terminal already running, and rebuild the agents list. A project or
/// standalone terminal becomes a row of the list; a session's lives in its
/// agent's dock.
pub(crate) fn add_terminal(app: &mut App, id: &str, owner: yaran_core::model::TerminalOwner) {
    let client = crate::pty::PtyClient::spawn(
        "/bin/sh",
        &["-c".to_string(), "sleep 30".to_string()],
        std::path::Path::new("."),
        24,
        80,
        100,
    )
    .expect("spawn pty");
    let sort_order = app
        .engine
        .companion_terminals
        .values()
        .map(|terminal| terminal.sort_order + 1)
        .max()
        .unwrap_or(0);
    app.engine.companion_terminals.insert(
        id.to_string(),
        yaran_core::model::CompanionTerminal {
            owner,
            label: id.to_string(),
            foreground_cmd: None,
            client,
            sort_order,
            created_at: Timestamp::now(),
            list_after: None,
        },
    );
    app.rebuild_left_items();
}

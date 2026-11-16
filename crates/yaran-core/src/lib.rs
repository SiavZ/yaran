//! yaran-core: the headless domain layer for yaran.
//!
//! This crate must not depend on `ratatui`, `crossterm`, or any web/server
//! crate. Surfaces (TUI, web) depend on `yaran-core`, never the reverse.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! lib.rs
//! ├── action
//! ├── activity
//! ├── add_project_plan
//! ├── add_project_prose
//! ├── agent_env
//! ├── agent_job
//! ├── agent_search
//! ├── agent_tabs
//! ├── amq
//! ├── atomic_update
//! ├── attached_prose
//! ├── attachments
//! ├── attention
//! ├── auth
//! ├── auto_resume
//! ├── background_serve
//! ├── base_branch
//! ├── bidi
//! ├── bounded_command
//! ├── branch_history
//! ├── brand_env
//! ├── browser
//! ├── changes_lane
//! ├── changes_status
//! ├── checkout_move
//! ├── client
//! ├── clone_project
//! ├── cloud
//! ├── config
//! ├── config_auth
//! ├── config_effective
//! ├── config_keys
//! ├── config_migrate
//! ├── config_queue
//! ├── config_reload_status
//! ├── config_resources
//! ├── config_sync
//! ├── config_write
//! ├── container
//! ├── control_socket
//! ├── delete_agent_prose
//! ├── destructive
//! ├── device_label
//! ├── diff
//! ├── duration_text
//! ├── editor
//! ├── engine
//! ├── file_drop
//! ├── file_follow
//! ├── file_modes
//! ├── first_load
//! ├── flat_list
//! ├── focus
//! ├── gh
//! ├── git
//! ├── gitignore_seed
//! ├── home_path
//! ├── human_board
//! ├── ids
//! ├── io_retry
//! ├── leftover_folders
//! ├── lockfile
//! ├── logger
//! ├── macros
//! ├── model
//! ├── numeric
//! ├── operations
//! ├── orphan_worktrees
//! ├── palette
//! ├── peer
//! ├── poller_status
//! ├── pr_list
//! ├── pr_reference
//! ├── private_file
//! ├── process_sessions
//! ├── project_browser
//! ├── project_order
//! ├── project_prose
//! ├── prose
//! ├── provider
//! ├── pty
//! ├── pty_adopt_child
//! ├── pty_owners
//! ├── pty_reattach
//! ├── purge
//! ├── purge_amq
//! ├── purge_encoding
//! ├── qr
//! ├── quiet_tail
//! ├── release_notes
//! ├── reload_handoff
//! ├── reload_policy
//! ├── reload_signal
//! ├── resource_stats
//! ├── resume_recovery
//! ├── review27_tests
//! ├── route_checks
//! ├── row_state
//! ├── sanitize
//! ├── scroll_hint
//! ├── scroll_margins
//! ├── serve_log
//! ├── session_settings
//! ├── shell_quote
//! ├── sidebar
//! ├── start_check_fixtures
//! ├── startup
//! ├── status_text
//! ├── statusline
//! ├── storage
//! ├── tab_verdict
//! ├── tailscale
//! ├── term_identity
//! ├── terminal_title
//! ├── test_git
//! ├── test_provider
//! ├── test_scratch
//! ├── text
//! ├── text_encoding
//! ├── theme
//! ├── urls
//! ├── version
//! ├── viewmodel
//! ├── watch
//! ├── web_sessions
//! ├── welcome
//! ├── welcome_screen
//! ├── wire
//! ├── worker
//! ├── working_copy
//! ├── working_cue
//! ├── worktree_file
//! ├── worktree_manager
//! └── worktree_ops
//! External: std
//!
//! Used by:
//! lib.rs
//! ├── brand_env
//! ├── config
//! ├── viewmodel
//! ├── yaran-tui::app
//! ├── yaran-tui::app::first_load
//! ├── yaran-web
//! ├── yaran-web::background
//! ├── yaran-web::build_routes
//! ├── yaran-web::engine_actor
//! ├── yaran-web::first_load_routes
//! ├── yaran-web[test first_load_routes]
//! └── yaran[bin yaran]
//! ```
//! <module-headers:end>

pub mod action;
pub mod activity;
pub mod add_project_plan;
pub mod add_project_prose;
pub mod agent_env;
pub mod agent_job;
pub mod agent_search;
pub mod agent_tabs;
pub mod atomic_update;
pub mod attached_prose;
pub mod attachments;
pub mod attention;
pub mod auth;
pub mod background_serve;
pub mod base_branch;
pub mod bidi;
pub(crate) mod bounded_command;
/// Kill the process groups of the bounded git, gh and tailscale calls still
/// running, on yaran's way out.
pub use bounded_command::kill_live_child_groups;
pub mod branch_history;
pub mod brand_env;
pub mod browser;
pub mod changes_lane;
pub mod changes_status;
pub(crate) mod checkout_move;
pub mod client;
pub mod clone_project;
pub mod cloud;
pub mod config;
pub mod config_auth;
pub mod config_effective;
pub mod config_keys;
pub mod config_migrate;
pub mod config_queue;
pub mod config_reload_status;
pub mod config_resources;
pub mod config_sync;
pub mod config_write;
pub mod container;
pub mod control_socket;
pub mod delete_agent_prose;
pub mod destructive;
pub mod device_label;
pub mod diff;
pub(crate) mod duration_text;
pub mod editor;
pub mod engine;
pub mod file_drop;
pub mod file_follow;
pub mod file_modes;
pub mod first_load;
pub mod flat_list;
pub mod focus;
pub mod gh;
pub mod git;
pub mod gitignore_seed;
pub mod home_path;
pub mod human_board;
pub mod ids;
pub mod io_retry;
pub mod leftover_folders;
pub mod lockfile;
pub mod logger;
pub mod macros;
pub mod model;
pub(crate) mod numeric;
pub mod operations;
pub mod palette;
pub mod peer;
pub mod poller_status;
pub mod pr_list;
pub mod pr_reference;
pub mod private_file;
pub mod process_sessions;
pub mod project_browser;
pub mod project_order;
pub mod project_prose;
pub mod prose;
pub mod provider;
pub mod pty;
pub mod pty_adopt_child;
pub mod pty_owners;
pub mod pty_reattach;
// Hard purge (GDPR erasure) and the opt-in orphan-worktree cleaner, ported
// from the fork (purge workstream).
pub mod orphan_worktrees;
pub mod purge;
pub mod purge_amq;
pub mod purge_encoding;
pub mod qr;
pub mod quiet_tail;
pub mod release_notes;
pub mod reload_handoff;
pub mod reload_policy;
pub mod reload_signal;
pub mod resource_stats;
#[cfg(all(test, target_os = "linux"))]
mod review27_tests;
pub mod route_checks;
pub mod row_state;
pub mod sanitize;
pub mod scroll_hint;
pub(crate) mod scroll_margins;
pub mod serve_log;
pub mod shell_quote;
pub mod sidebar;
#[cfg(any(test, feature = "test-support"))]
pub mod start_check_fixtures;
pub mod startup;
pub mod status_text;
pub mod statusline;
pub mod storage;
pub mod tab_verdict;
pub mod tailscale;
pub mod term_identity;
pub mod terminal_title;
#[cfg(any(test, feature = "test-support"))]
pub mod test_git;
#[cfg(any(test, feature = "test-support"))]
pub mod test_provider;
#[cfg(any(test, feature = "test-support"))]
pub mod test_scratch;
pub mod text;
pub mod text_encoding;
pub mod theme;
pub mod urls;
pub mod version;
pub mod viewmodel;
pub mod watch;
pub mod web_sessions;
pub mod welcome;
pub mod welcome_screen;
pub mod wire;
pub mod worker;
pub mod working_copy;
pub mod working_cue;
pub mod worktree_file;
pub mod worktree_manager;
// Resume-by-provider-session-id and startup auto-resume (resume port).
pub mod auto_resume;
pub mod resume_recovery;
// Fork port: AMQ inject/orchestrator and per-session settings.
pub mod amq;
pub mod session_settings;
pub mod worktree_ops;

/// Display version string ('vX.Y.Z' for release builds, 'development' otherwise), set by build.rs, mirroring the TUI's `YARAN_DISPLAY_VERSION`.
pub fn display_version() -> &'static str {
    env!("YARAN_DISPLAY_VERSION")
}

/// Serializes the tests that set process environment variables (fork
/// e393c1d1, P1-L, which used `serial_test`). `set_var` is unsafe precisely
/// because a parallel test reading the environment can race it; every test
/// that sets one holds this for its whole body.
#[cfg(test)]
pub(crate) fn env_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

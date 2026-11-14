//! yaran-core: the headless domain layer for yaran.
//!
//! This crate must not depend on `ratatui`, `crossterm`, or any web/server
//! crate. Surfaces (TUI, web) depend on `yaran-core`, never the reverse.
//!
//! <module-headers:begin>
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
//! ├── attention
//! ├── auto_resume
//! ├── background_serve
//! ├── bidi
//! ├── bounded_command
//! ├── brand_env
//! ├── browser
//! ├── changes_status
//! ├── cloud
//! ├── config
//! ├── config_migrate
//! ├── config_queue
//! ├── config_reload_status
//! ├── config_sync
//! ├── config_write
//! ├── device_label
//! ├── diff
//! ├── editor
//! ├── engine
//! ├── file_drop
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
//! ├── lockfile
//! ├── logger
//! ├── macros
//! ├── model
//! ├── orphan_worktrees
//! ├── palette
//! ├── peer
//! ├── poller_status
//! ├── pr_reference
//! ├── private_file
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
//! ├── quiet_tail
//! ├── release_notes
//! ├── reload_handoff
//! ├── reload_policy
//! ├── resource_stats
//! ├── resume_recovery
//! ├── row_state
//! ├── sanitize
//! ├── scroll_hint
//! ├── scroll_margins
//! ├── session_settings
//! ├── shell_quote
//! ├── sidebar
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
//! ├── theme
//! ├── urls
//! ├── version
//! ├── viewmodel
//! ├── watch
//! ├── welcome
//! ├── welcome_screen
//! ├── wire
//! ├── worker
//! ├── working_copy
//! ├── working_cue
//! ├── worktree_file
//! └── worktree_manager
//! External: std
//!
//! Used by:
//! lib.rs
//! ├── brand_env
//! ├── config
//! ├── startup
//! ├── viewmodel
//! ├── yaran-tui::app::first_load
//! ├── yaran-web::build_routes
//! ├── yaran-web::engine_actor
//! ├── yaran-web::first_load_routes
//! ├── yaran-web[test first_load_routes]
//! └── yaran[bin yaran]
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
pub mod attention;
pub mod background_serve;
pub mod bidi;
pub mod bounded_command;
pub mod brand_env;
pub mod browser;
pub mod changes_status;
pub mod cloud;
pub mod config;
pub mod config_migrate;
pub mod config_queue;
pub mod config_reload_status;
pub mod config_sync;
pub mod config_write;
pub mod device_label;
pub mod diff;
pub mod editor;
pub mod engine;
pub mod file_drop;
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
pub mod lockfile;
pub mod logger;
pub mod macros;
pub mod model;
pub mod palette;
pub mod peer;
pub mod poller_status;
pub mod pr_reference;
pub mod private_file;
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
pub mod quiet_tail;
pub mod release_notes;
pub mod reload_handoff;
pub mod reload_policy;
pub mod resource_stats;
pub mod row_state;
pub mod sanitize;
pub mod scroll_hint;
pub mod scroll_margins;
pub mod shell_quote;
pub mod sidebar;
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
pub mod theme;
pub mod urls;
pub mod version;
pub mod viewmodel;
pub mod watch;
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

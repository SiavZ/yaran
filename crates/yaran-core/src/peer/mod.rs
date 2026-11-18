//! Yaran peer router: agent-to-agent message routing between Yaran sessions, and
//! the globally locked AMQ registry lifecycle that keeps every Yaran store's
//! agent handles unique inside one shared AMQ root.
//!
//! Ported from the fork's monolithic `src/peer.rs`. The logic lives here, in
//! `yaran-core`, so both surfaces can use it: the TUI and the web server run the
//! startup reconciliation ([`sync_amq_agents_for_bootstrap`]), every agent
//! launch exports the session identity ([`append_session_env`]), and the
//! `yaran peer` CLI ([`run_peer`]) is dispatched from the binary's argument
//! router.
//!
//! The router speaks in [`PeerSession`], a small projection of
//! [`crate::model::AgentSession`] (its persisted immutable `agent_handle`,
//! `shared_workspace` flag and soft-delete state). Everything the router
//! decides is a function of that projection, and the one place that builds
//! it from the session store is [`session_store`].

mod amq;
mod handle;
pub(crate) mod router;
pub mod session_store;

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

pub use amq::{
    AmqSyncReport, amq_cleanup_requires_worker, amq_handle_is_exact_owner,
    amq_handle_is_exact_owner_at_root, free_amq_handle, free_amq_handle_at_root, optional_amq_root,
    reserve_and_persist_session, reserve_and_persist_session_at_root, sync_amq_agents,
    sync_amq_agents_for_bootstrap, tombstone_amq_session, tombstone_amq_session_at_root,
};
pub use handle::{
    AGENT_HANDLE_MAX_LEN, amq_handle, derive_agent_handle, is_valid_agent_handle,
    next_unique_agent_handle, normalize_agent_handle,
};
pub use router::{PeerSnapshot, routable_sessions, run_peer, sync_and_list};
pub use session_store::{
    append_session_env, init_for_process, launch_env_for_session, load_or_create_store_id,
};

/// What the peer router needs to know about one Yaran agent session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerSession {
    /// The Yaran session id.
    pub id: String,
    /// Provider name as configured (`claude`, `codex`, ...).
    pub provider: String,
    /// Where the agent runs: its worktree, or its folder for a standalone agent.
    pub directory: String,
    /// The branch the agent tracks, when it has one. An alias for targeting.
    pub branch: Option<String>,
    /// The agent's durable title, when it has one. An alias for targeting.
    pub title: Option<String>,
    /// The agent's AMQ identity: its inbox name under the shared AMQ root.
    pub agent_handle: String,
    /// Several agents share one working directory. Mixed-provider routes from
    /// such endpoints use AMQ. Claude-to-Claude routes still use Claude Peers.
    pub shared_workspace: bool,
    /// Ordinary-deleted row kept as a tombstone so its handle stays reserved.
    pub deleted: bool,
    /// The agent's process has exited.
    pub exited: bool,
}

impl PeerSession {
    /// The handle messages address this agent by.
    pub fn agent_handle(&self) -> &str {
        &self.agent_handle
    }

    /// Whether the agent runs Claude.
    pub fn is_claude(&self) -> bool {
        self.provider == "claude"
    }

    /// Whether Claude Peers can reach the agent: Claude always, and jcode
    /// outside a shared workspace, where its registration is found by
    /// directory because jcode's MCP servers run under the jcode daemon.
    pub fn takes_claude_peers(&self) -> bool {
        self.is_claude() || (self.provider == "jcode" && !self.shared_workspace)
    }

    /// A session a message can actually reach: live, and its directory still
    /// exists. Exited agents and agents whose worktree is gone are hidden from
    /// `yaran peer list` and cannot be targeted.
    pub fn is_routable(&self) -> bool {
        !self.deleted && !self.exited && Path::new(&self.directory).exists()
    }
}

/// Persistence the AMQ registry lifecycle needs from a Yaran session store.
///
/// The fork implemented these directly on its `SessionStore`. Here they sit
/// behind a trait so the lifecycle is testable against an in-memory store;
/// production is [`session_store::SqlitePeerStore`], backed by the persisted
/// `agent_handle` column and soft-delete tombstones.
pub trait PeerStore {
    /// Every session this store knows, tombstones included, so a deleted row's
    /// handle is never handed to a new session.
    ///
    /// # Errors
    ///
    /// Fails when the store cannot be read.
    fn load_sessions_including_deleted(&self) -> Result<Vec<PeerSession>>;

    /// Insert a brand-new session with its reserved handle.
    ///
    /// # Errors
    ///
    /// Fails when the row cannot be written.
    fn persist_new_session(&self, session: &PeerSession) -> Result<()>;

    /// Compare-and-swap a session's handle during global deconfliction. Called
    /// only while the AMQ registry lock proves `expected` is owned by someone
    /// else and `replacement` is free.
    ///
    /// # Errors
    ///
    /// Fails when the row cannot be written or no longer holds `expected`.
    fn reassign_agent_handle_for_global_backfill(
        &self,
        id: &str,
        expected: &str,
        replacement: &str,
    ) -> Result<()>;
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    use super::PeerSession;

    /// A live, non-shared session whose handle is its normalized branch.
    pub(crate) fn session(id: &str, provider: &str, branch: &str, directory: &Path) -> PeerSession {
        PeerSession {
            id: id.to_string(),
            provider: provider.to_string(),
            directory: directory.display().to_string(),
            branch: Some(branch.to_string()),
            title: None,
            agent_handle: super::normalize_agent_handle(branch),
            shared_workspace: false,
            deleted: false,
            exited: false,
        }
    }

    /// Spawn an `amq wake --me <handle> --root <root>` stand-in that spins
    /// until SIGTERM, returning once it reports ready. Ready means it runs in
    /// its final image with the TERM trap installed: macOS `/bin/sh` re-execs
    /// bash, and during that exec its argv reads back empty, so a wake
    /// recorded any earlier is (correctly) not identifiable as a wake yet. A
    /// real wake has long been running by the time anything stops it.
    pub(crate) fn spawn_ready_wake_stand_in(
        dir: &Path,
        root: &Path,
        handle: &str,
    ) -> std::process::Child {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};
        let fake_amq = dir.join("amq-wake-test");
        let ready = dir.join("amq-wake-test.ready");
        std::fs::write(
            &fake_amq,
            "#!/bin/sh\ntrap 'exit 0' TERM\n: > \"$WAKE_READY_FILE\"\nwhile :; do :; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_amq, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = std::process::Command::new(&fake_amq)
            .args(["wake", "--me", handle, "--root"])
            .arg(root)
            .env("WAKE_READY_FILE", &ready)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        // A hang guard only: readiness is an event, not a clock.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("wake stand-in exited before it was ready: {status}");
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("wake stand-in never became ready");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        child
    }
}

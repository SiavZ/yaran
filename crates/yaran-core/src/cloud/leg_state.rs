//! The tunnel leg's runtime state file, `<root>/cloud/leg-state.json`.
//!
//! The format is owned here; Phase 10's leg writes it (and its stale-orphan reaper reads
//! it), and the separate `yaran cloud status` process reads it to see a running leg
//! without IPC. A record whose pid is no longer alive reads as not running.
//!
//! - Written owner-only and atomically through `private_file`; read without a lock.
//! - Holds no secret.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_state.rs
//! ├── cloud::paths
//! └── private_file
//! External: anyhow, rustix, serde, serde_json, std, tempfile
//!
//! Used by:
//! cloud/leg_state.rs
//! ├── cloud
//! ├── cloud::cli::login
//! └── cloud::status
//! <module-headers:end>

use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use crate::cloud::paths::CloudPaths;

pub const LEG_STATE_SCHEMA: u32 = 1;

/// One running leg as Phase 10 records it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegState {
    pub schema: u32,
    /// The cloudflared child's pid and process group.
    pub pid: u32,
    pub pgid: u32,
    /// The binary actually spawned.
    pub binary: String,
    /// cloudflared's loopback metrics address (`127.0.0.1:<port>`).
    pub metrics_addr: String,
    /// The leg's state word (`CloudLegState` token from Phase 10, e.g. `ready`).
    pub state: String,
    /// RFC 3339 time the state was entered.
    pub since: String,
}

/// The state word Phase 10 writes once cloudflared reports ready.
pub const READY: &str = "ready";

/// What `status` makes of the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegStatus {
    /// No file, an unreadable one, or a dead pid.
    NotRunning,
    Running(LegState),
}

impl LegStatus {
    pub fn is_ready(&self) -> bool {
        match self {
            Self::Running(s) => s.state == READY,
            Self::NotRunning => false,
        }
    }
}

/// Write the record (Phase 10).
pub fn write(paths: &CloudPaths, state: &LegState) -> anyhow::Result<()> {
    paths.ensure_dir()?;
    let mut body = serde_json::to_vec_pretty(state)?;
    body.push(b'\n');
    crate::private_file::write_private_atomic(&paths.leg_state, &body)
}

/// Remove the record when the leg stops (Phase 10). Missing is fine.
pub fn remove(paths: &CloudPaths) -> io::Result<()> {
    match fs::remove_file(&paths.leg_state) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The raw record, if any and readable.
pub fn read(paths: &CloudPaths) -> Option<LegState> {
    let bytes = fs::read(&paths.leg_state).ok()?;
    serde_json::from_slice::<LegState>(&bytes)
        .ok()
        .filter(|s| s.schema == LEG_STATE_SCHEMA)
}

/// Whether `pid` names a live process (signal 0).
pub fn pid_alive(pid: u32) -> bool {
    i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .is_some_and(|p| rustix::process::test_kill_process(p).is_ok())
}

/// The leg as `status` reports it, pid verified alive.
pub fn status(paths: &CloudPaths) -> LegStatus {
    match read(paths) {
        Some(s) if pid_alive(s.pid) => LegStatus::Running(s),
        _ => LegStatus::NotRunning,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(pid: u32) -> LegState {
        LegState {
            schema: LEG_STATE_SCHEMA,
            pid,
            pgid: pid,
            binary: "/usr/bin/cloudflared".into(),
            metrics_addr: "127.0.0.1:41234".into(),
            state: READY.into(),
            since: "2026-11-14T12:00:00Z".into(),
        }
    }

    #[test]
    fn a_live_pid_reads_as_running_and_a_dead_one_does_not() {
        let root = tempfile::tempdir().unwrap();
        let paths = CloudPaths::from_root(root.path());
        assert_eq!(status(&paths), LegStatus::NotRunning);
        write(&paths, &sample(std::process::id())).unwrap();
        assert!(status(&paths).is_ready());
        // A child that has exited and been reaped leaves a dead pid.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        write(&paths, &sample(dead)).unwrap();
        assert_eq!(status(&paths), LegStatus::NotRunning);
        remove(&paths).unwrap();
        remove(&paths).unwrap();
        assert_eq!(read(&paths), None);
    }
}

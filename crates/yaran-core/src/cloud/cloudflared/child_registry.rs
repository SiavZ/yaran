//! The process-global list of live cloudflared process groups, so no exit path of yaran
//! leaves a tunnel child behind.
//!
//! - `shutdown()` is non-blocking: SIGTERM to every group.
//! - `wait_all(deadline)` waits for the supervisors to reap their children, then SIGKILLs
//!   whatever is left. Called after every serve mode's wind-down, and before a reload exec.
//! - `kill_all_now()` SIGKILLs at once, for the paths that call `exit` without running
//!   destructors (a second signal, the quit watchdog).
//! - `reap_stale(..)` handles the last case, a parent that was SIGKILLed: at the next start
//!   a child recorded in `leg-state.json` is killed only if its pid still runs the same
//!   executable with the same start time.
//!
//! <module-headers:begin>
//! Uses: none
//! External: rustix, std, sysinfo
//!
//! Used by:
//! cloud/cloudflared/child_registry.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::supervisor
//! ├── cloud::leg_run
//! ├── cloud::leg_start
//! ├── yaran-tui::app::hangup
//! ├── yaran-web
//! └── yaran-web::cloud_loop
//! <module-headers:end>

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process_group};

static GROUPS: Mutex<Vec<i32>> = Mutex::new(Vec::new());

fn groups() -> std::sync::MutexGuard<'static, Vec<i32>> {
    GROUPS.lock().unwrap_or_else(|p| p.into_inner())
}

fn signal_group(pgid: i32, sig: Signal) {
    if let Some(pid) = Pid::from_raw(pgid) {
        let _ = kill_process_group(pid, sig);
    }
}

/// Record a live group (the child's pid, since it leads its own group).
pub fn register(pgid: i32) {
    groups().push(pgid);
}

/// Forget a group once its leader has been reaped.
pub fn unregister(pgid: i32) {
    groups().retain(|g| *g != pgid);
}

/// The groups still recorded.
pub fn live() -> Vec<i32> {
    groups().clone()
}

/// SIGTERM every recorded group; returns at once.
pub fn shutdown() {
    for pgid in live() {
        signal_group(pgid, Signal::TERM);
    }
}

/// Wait up to `deadline` for every group to be reaped by its supervisor, then SIGKILL the
/// rest. Answers whether everything ended inside the deadline.
pub fn wait_all(deadline: Duration) -> bool {
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        if groups().is_empty() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    kill_all_now();
    false
}

/// SIGKILL every recorded group now.
pub fn kill_all_now() {
    for pgid in live() {
        signal_group(pgid, Signal::KILL);
    }
}

/// What `leg-state.json` says about the child a previous yaran ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleChild<'a> {
    pub pid: u32,
    pub pgid: u32,
    pub exe: &'a Path,
    pub start_time: u64,
}

/// The identity of a running process, for the stale check.
pub fn process_identity(pid: u32) -> Option<(std::path::PathBuf, u64)> {
    use sysinfo::{Pid as SysPid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    let pid = SysPid::from_u32(pid);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    let process = sys.process(pid)?;
    Some((process.exe()?.to_path_buf(), process.start_time()))
}

/// Kill a stale child's group, but only when its pid still runs the recorded executable
/// with the recorded start time (a reused pid is left alone). Answers whether it killed.
pub fn reap_stale(stale: &StaleChild<'_>, grace: Duration) -> bool {
    let matches = |id: Option<(std::path::PathBuf, u64)>| {
        id.is_some_and(|(exe, start)| {
            start == stale.start_time
                && (exe == stale.exe || exe.canonicalize().ok() == stale.exe.canonicalize().ok())
        })
    };
    if !matches(process_identity(stale.pid)) {
        return false;
    }
    let pgid = i32::try_from(stale.pgid).unwrap_or(0);
    signal_group(pgid, Signal::TERM);
    let until = Instant::now() + grace;
    while Instant::now() < until {
        if !matches(process_identity(stale.pid)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    signal_group(pgid, Signal::KILL);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    #[test]
    fn a_stale_reap_kills_only_a_matching_process() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let (exe, start) = process_identity(pid).expect("the child is visible");
        let wrong_start = StaleChild {
            pid,
            pgid: pid,
            exe: &exe,
            start_time: start + 1000,
        };
        assert!(!reap_stale(&wrong_start, Duration::from_millis(100)));
        let wrong_exe = StaleChild {
            exe: Path::new("/usr/bin/true"),
            start_time: start,
            ..wrong_start.clone()
        };
        assert!(!reap_stale(&wrong_exe, Duration::from_millis(100)));
        assert!(
            child.try_wait().unwrap().is_none(),
            "a mismatch must not kill"
        );
        let right = StaleChild {
            start_time: start,
            ..wrong_start
        };
        let status = std::thread::scope(|s| {
            let killer = s.spawn(|| reap_stale(&right, Duration::from_millis(500)));
            let status = child.wait().unwrap();
            assert!(killer.join().unwrap());
            status
        });
        assert!(!status.success());
    }

    #[test]
    fn the_registry_records_and_forgets() {
        register(-424242);
        assert!(live().contains(&-424242));
        unregister(-424242);
        assert!(!live().contains(&-424242));
    }
}

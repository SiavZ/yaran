//! The clone tests' stand-in `ssh`, run once before a test hands it to git.
//!
//! A clone's stall clock starts with git, so whatever delays the stand-in's
//! first run counts as git being silent. A freshly written script pays two
//! such costs on its first exec, and this helper pays both before returning:
//! - macOS assesses a new executable on its first run, one at a time across
//!   the whole system. Behind a busy test run that queue took seconds, so a
//!   one-second stall stopped git before the stand-in had even started.
//! - Another test forking while the write handle is open makes exec fail with
//!   `ETXTBSY` until that child execs (the window `gh.rs`'s stand-in warms
//!   through too).

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

/// The first argument the stand-in answers by exiting before its body runs.
const WARMUP_ARG: &str = "--yaran-stand-in-warmup";

/// A stand-in for `ssh` at `dir/ssh`, running `body`, already run once.
pub(super) fn fake_ssh(dir: &Path, body: &str) -> String {
    let path = dir.join("ssh");
    let script = format!("#!/bin/sh\ncase \"$1\" in {WARMUP_ARG}) exit 0 ;; esac\n{body}\n");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let busy_until = Instant::now() + Duration::from_secs(5);
    loop {
        match std::process::Command::new(&path).arg(WARMUP_ARG).status() {
            Ok(status) => {
                assert!(status.success(), "the stand-in's warm-up failed: {status}");
                return path.to_string_lossy().into_owned();
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && Instant::now() < busy_until =>
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("the stand-in cannot run: {error}"),
        }
    }
}

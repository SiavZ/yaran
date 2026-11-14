//! Whole-file replacement and writer locking for files yaran keeps for itself.
//!
//! Extracted from the human board's store so the board and the cloud credentials
//! store (and Phase 10's tunnel-token file) share one implementation: a write lands
//! through a hidden temporary sibling, `sync_all` and a rename, then the parent
//! directory is synced so the rename itself survives a crash; a writers' lock is an
//! exclusive `flock(2)` on a sibling lock file, released when the handle drops.
//!
//! - A failed write removes its temporary file and never replaces the target.
//! - `write_private_atomic` creates the file `0600` (`file_modes::PRIVATE_FILE_MODE`).
//! - Blocking I/O: call from a worker or CLI thread, never the UI thread.
//!
//! <module-headers:begin>
//! <module-headers:end>

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use anyhow::{Context, Result};

use crate::file_modes::PRIVATE_FILE_MODE;

/// Replace `path` with `body` as an owner-only (`0600`) file.
pub fn write_private_atomic(path: &Path, body: &[u8]) -> Result<()> {
    write_atomic(path, body, Some(PRIVATE_FILE_MODE))
}

/// Replace `path` with `body` through a temporary sibling and a rename.
/// `mode` is the new file's permission bits; `None` leaves them to the umask.
/// The temporary file is hidden (a leading dot), so a notes app or a folder
/// watcher that happens to look mid-write does not take it for a real file.
pub fn write_atomic(path: &Path, body: &[u8], mode: Option<u32>) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        if let Some(mode) = mode {
            options.mode(mode);
        }
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("could not create {}", tmp.display()))?;
        file.write_all(body)
            .with_context(|| format!("could not write {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("could not sync {}", tmp.display()))?;
        fs::rename(&tmp, path).with_context(|| {
            format!(
                "could not replace {} with {}",
                path.display(),
                tmp.display()
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    // The rename is durable only once the directory entry is; best effort, since
    // some filesystems refuse to open a directory for syncing.
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Open (creating, `0600`) and exclusively `flock` `lock_path`. The lock is held
/// until the returned file is dropped.
pub fn lock_exclusive(lock_path: &Path) -> Result<File> {
    use rustix::fs::{FlockOperation, flock};
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(PRIVATE_FILE_MODE)
        .open(lock_path)
        .with_context(|| format!("could not open {}", lock_path.display()))?;
    crate::io_retry::retry_on_interrupt_errno(|| flock(&file, FlockOperation::LockExclusive))
        .with_context(|| format!("could not lock {}", lock_path.display()))?;
    Ok(file)
}

/// Run `work` while holding the exclusive lock on `lock_path`.
pub fn with_exclusive_lock<T>(lock_path: &Path, work: impl FnOnce() -> Result<T>) -> Result<T> {
    let _lock = lock_exclusive(lock_path)?;
    work()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_private_write_is_owner_only_and_replaces_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.json");
        fs::write(&path, "old").unwrap();
        write_private_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // No temporary sibling is left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_write_never_replaces_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target");
        fs::write(&path, "kept").unwrap();
        // A directory where the parent should be makes the temp create fail.
        let bad = dir.path().join("missing-dir").join("target");
        assert!(write_private_atomic(&bad, b"x").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"kept");
        // A rename onto a directory fails after the temp was written: it is removed.
        let occupied = dir.path().join("occupied");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("f"), "x").unwrap();
        assert!(write_private_atomic(&occupied, b"x").is_err());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn two_threads_contending_on_the_lock_serialize() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("x.lock");
        let log = Arc::new(Mutex::new(Vec::new()));
        let handles: Vec<_> = (0..2)
            .map(|i| {
                let lock = lock.clone();
                let log = Arc::clone(&log);
                std::thread::spawn(move || {
                    with_exclusive_lock(&lock, || {
                        log.lock().unwrap().push(format!("in{i}"));
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        log.lock().unwrap().push(format!("out{i}"));
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let log = log.lock().unwrap();
        // Each holder leaves before the next enters.
        assert!(log[0].starts_with("in") && log[1].starts_with("out"));
        assert_eq!(log[0][2..], log[1][3..]);
    }
}

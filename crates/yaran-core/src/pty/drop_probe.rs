//! Drop-test probes observe kernel EOF independently of the reload stop flag.
//! The descriptor stays owned until the probe ends, so concurrent tests cannot
//! reuse its number after the client closes its own master.

use std::fs::File;
use std::io::Read as _;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::time::{Duration, Instant};

use super::{PtyClient, wait_readable};

pub(super) fn reader_for_drop(client: &mut PtyClient) -> File {
    // Leave only this probe reading, so readiness cannot be consumed by another reader.
    client
        .join_quiesced_reader_for_reload()
        .expect("quiesce the reader before probing kernel EOF");
    let fd = client.master.as_raw_fd().expect("a real PTY master");
    // SAFETY: the borrowed client owns this descriptor throughout the duplicate.
    let fd = unsafe { BorrowedFd::borrow_raw(fd) };
    File::from(fd.try_clone_to_owned().expect("duplicate the PTY master"))
}

pub(super) fn eof_after_drop(mut reader: File) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buffer = [0; 4096];
    while Instant::now() < deadline {
        if !wait_readable(reader.as_raw_fd(), 100) {
            continue;
        }
        match crate::io_retry::retry_on_interrupt(|| reader.read(&mut buffer)) {
            Ok(0) => return true,
            // Linux PTY masters report a closed slave as EIO.
            Err(error) if error.raw_os_error() == Some(libc::EIO) => return true,
            Ok(_) => {}
            Err(error) => panic!("could not probe the PTY for EOF: {error}"),
        }
    }
    false
}

#[test]
fn a_quiet_reader_stop_is_not_eof_while_the_child_holds_the_slave() {
    let mut client = PtyClient::spawn(
        "/bin/sh",
        &["-c".to_string(), "sleep 120".to_string()],
        std::path::Path::new("."),
        5,
        40,
        100,
    )
    .expect("spawn child holding the slave");
    let reader = reader_for_drop(&mut client);
    let after_drop = reader.try_clone().expect("retain the probe");
    assert!(
        !eof_after_drop(reader),
        "a quiet stop must not look like EOF"
    );
    drop(client);
    assert!(
        eof_after_drop(after_drop),
        "killing the child must yield EOF"
    );
}

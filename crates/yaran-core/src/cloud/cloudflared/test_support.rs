//! Test doubles for the cloudflared leg: `/bin/sh` stand-ins for the binary and a
//! std-thread loopback HTTP stub for downloads, `/ready` and the like.
//!
//! - Test-only (`#[cfg(test)]`); nothing here touches the network beyond 127.0.0.1.
//!
//! <module-headers:begin>
//! Uses: none
//! External: std
//!
//! Used by:
//! cloud/cloudflared/test_support.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::acquire::tests
//! ├── cloud::cloudflared::ready
//! ├── cloud::cloudflared::supervisor::tests
//! ├── cloud::cloudflared::version
//! └── cloud::leg::tests
//! <module-headers:end>

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Write an executable `/bin/sh` script and wait until it can actually run (another test
/// thread forking while the write handle was open makes exec fail with "text file busy").
pub(crate) fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write the stand-in");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Err(err) = std::process::Command::new("/bin/sh")
        .arg("-n")
        .arg(&path)
        .output()
        .and_then(|_| std::fs::File::open(&path).map(drop))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "stand-in never ready: {err}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    path
}

/// One canned HTTP answer.
#[derive(Clone)]
pub(crate) struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    /// Advertise this length instead of the body's (a truncated download).
    pub claimed_len: Option<usize>,
}

impl Reply {
    pub(crate) fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            body: body.into(),
            claimed_len: None,
        }
    }
}

/// A loopback HTTP stub answering every request with whatever `reply` currently holds.
/// Answers `(base url, reply cell, request counter)`; the thread lives as long as the
/// test process.
pub(crate) fn http_stub(reply: Reply) -> (String, Arc<Mutex<Reply>>, Arc<Mutex<usize>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let cell = Arc::new(Mutex::new(reply));
    let hits = Arc::new(Mutex::new(0usize));
    let (thread_cell, thread_hits) = (cell.clone(), hits.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                head.push(byte[0]);
            }
            *thread_hits.lock().unwrap() += 1;
            let reply = thread_cell.lock().unwrap().clone();
            let len = reply.claimed_len.unwrap_or(reply.body.len());
            let _ = write!(
                stream,
                "HTTP/1.1 {} X\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n",
                reply.status
            );
            let _ = stream.write_all(&reply.body);
        }
    });
    (base, cell, hits)
}

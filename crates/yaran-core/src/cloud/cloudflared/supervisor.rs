//! One running cloudflared child: spawn it in its own process group, read its stderr,
//! and stop it with SIGTERM, a grace period, SIGKILL and a reap.
//!
//! - The child is recorded in `child_registry` from spawn until it is reaped, so every
//!   exit path of yaran can reach it.
//! - Stderr is parsed on a reader thread; the leg receives only the lines that matter
//!   (`Registered`, `Unauthorized`). Stdout is drained and discarded.
//! - Dropping a `RunningChild` that was never stopped SIGKILLs its group and reaps it.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/supervisor.rs
//! ├── cloud::cloudflared::child_registry
//! ├── cloud::cloudflared::command
//! ├── cloud::cloudflared::log_lines
//! ├── cloud::cloudflared::policy
//! └── cloud::cloudflared::supervisor::tests
//! External: rustix, std
//!
//! Used by:
//! cloud/cloudflared/supervisor.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::supervisor::tests
//! └── cloud::leg_run
//! <module-headers:end>

use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ExitStatus};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::child_registry;
use super::command::ChildSpec;
use super::log_lines::{self, LogSignal, MAX_LINE_BYTES};
use super::policy::ChildExit;

/// A live cloudflared.
pub struct RunningChild {
    child: Child,
    pgid: i32,
    readers: Vec<JoinHandle<()>>,
    signals: Receiver<LogSignal>,
    reaped: bool,
}

/// Spawn the child described by `spec`. `token` is only used to redact log lines.
pub fn spawn(spec: &ChildSpec, token: &str) -> std::io::Result<RunningChild> {
    let mut child = spec.command().spawn()?;
    let pgid = i32::try_from(child.id()).unwrap_or(i32::MAX);
    child_registry::register(pgid);
    let (tx, signals) = channel();
    let mut readers = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        let token = token.to_string();
        readers.push(std::thread::spawn(move || read_stderr(stderr, &token, &tx)));
    }
    if let Some(mut stdout) = child.stdout.take() {
        readers.push(std::thread::spawn(move || {
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
        }));
    }
    Ok(RunningChild {
        child,
        pgid,
        readers,
        signals,
        reaped: false,
    })
}

fn read_stderr(stderr: impl Read, token: &str, tx: &Sender<LogSignal>) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        // An oversize line: drop the rest of it.
        if !line.ends_with(b"\n") && line.len() > MAX_LINE_BYTES {
            let mut rest = Vec::new();
            let _ = reader.read_until(b'\n', &mut rest);
        }
        let parsed = log_lines::parse_line(&line, token);
        log_lines::log(&parsed);
        if parsed.signal != LogSignal::Other {
            let _ = tx.send(parsed.signal);
        }
    }
}

fn exit_of(status: ExitStatus) -> ChildExit {
    match (status.code(), status.signal()) {
        (Some(code), _) => ChildExit::Code(code),
        (None, Some(sig)) => ChildExit::Signal(sig),
        (None, None) => ChildExit::Code(-1),
    }
}

impl RunningChild {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The stderr signals that arrived since the last call.
    pub fn drain_signals(&self) -> Vec<LogSignal> {
        self.signals.try_iter().collect()
    }

    /// How the child ended, if it has.
    pub fn try_exit(&mut self) -> Option<ChildExit> {
        let status = self.child.try_wait().ok().flatten()?;
        self.finish();
        Some(exit_of(status))
    }

    /// SIGTERM the group, wait `grace`, SIGKILL the group, reap. Every ending after our own
    /// SIGTERM is `AfterOurStop`, whatever the code; one that had already ended is not.
    pub fn stop(mut self, grace: Duration) -> ChildExit {
        if let Some(exit) = self.try_exit() {
            return exit;
        }
        self.signal(rustix::process::Signal::TERM);
        let until = Instant::now() + grace;
        while Instant::now() < until {
            if let Ok(Some(_)) = self.child.try_wait() {
                self.finish();
                return ChildExit::AfterOurStop;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.signal(rustix::process::Signal::KILL);
        let _ = self.child.wait();
        self.finish();
        ChildExit::AfterOurStop
    }

    fn signal(&self, sig: rustix::process::Signal) {
        if let Some(pid) = rustix::process::Pid::from_raw(self.pgid) {
            let _ = rustix::process::kill_process_group(pid, sig);
        }
    }

    /// Reaped: kill any grandchild still in the group, join the readers, unregister.
    fn finish(&mut self) {
        if self.reaped {
            return;
        }
        self.reaped = true;
        self.signal(rustix::process::Signal::KILL);
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        child_registry::unregister(self.pgid);
    }
}

impl Drop for RunningChild {
    fn drop(&mut self) {
        if !self.reaped {
            self.signal(rustix::process::Signal::KILL);
            let _ = self.child.wait();
            self.finish();
        }
    }
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;

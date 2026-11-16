//! Tests for one supervised child, driven by `/bin/sh` stand-ins for cloudflared.
//!
//! - Test-only; spawns real processes and kills their groups.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/supervisor_tests.rs
//! ├── cloud::cloudflared::command
//! ├── cloud::cloudflared::supervisor
//! └── cloud::cloudflared::test_support
//! External: rustix, std, tempfile
//!
//! Used by:
//! cloud/cloudflared/supervisor_tests.rs
//! └── cloud::cloudflared::supervisor
//! <module-headers:end>

use super::*;
use crate::cloud::cloudflared::command::ChildSpec;
use crate::cloud::cloudflared::test_support::script;

fn spec(binary: std::path::PathBuf, dir: &std::path::Path) -> ChildSpec {
    ChildSpec {
        binary,
        metrics_port: 1,
        loglevel: "info".into(),
        grace_seconds: 1,
        management_diagnostics: false,
        token_file: dir.join("tunnel-token"),
    }
}

fn wait_exit(child: &mut RunningChild) -> ChildExit {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(exit) = child.try_exit() {
            return exit;
        }
        assert!(Instant::now() < until, "the child never exited");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn alive(pid: u32) -> bool {
    rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()).is_ok()
}

#[test]
fn exit_codes_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    for code in [1, 255, 11] {
        let bin = script(dir.path(), &format!("exit{code}"), &format!("exit {code}"));
        let mut child = spawn(&spec(bin, dir.path()), "").unwrap();
        assert_eq!(wait_exit(&mut child), ChildExit::Code(code));
        assert!(!child_registry::live().contains(&(child.pid() as i32)));
    }
}

#[test]
fn registered_json_on_stderr_reaches_the_leg() {
    let dir = tempfile::tempdir().unwrap();
    let bin = script(
        dir.path(),
        "registered",
        r#"echo '{"level":"info","message":"Registered tunnel connection","connIndex":0}' >&2
echo '{"level":"error","error":"Unauthorized: x","message":"Register tunnel error"}' >&2
exit 0"#,
    );
    let mut child = spawn(&spec(bin, dir.path()), "").unwrap();
    wait_exit(&mut child);
    assert_eq!(
        child.drain_signals(),
        vec![LogSignal::Registered, LogSignal::Unauthorized]
    );
}

#[test]
fn a_child_ignoring_sigterm_is_killed_after_the_grace() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("trapped");
    let bin = script(
        dir.path(),
        "stubborn",
        &format!(
            "trap '' TERM\ntouch {}\nwhile true; do sleep 0.05; done",
            marker.to_str().unwrap()
        ),
    );
    let child = spawn(&spec(bin, dir.path()), "").unwrap();
    let pid = child.pid();
    let until = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(Instant::now() < until, "the stand-in never set its trap");
        std::thread::sleep(Duration::from_millis(10));
    }
    let started = Instant::now();
    assert_eq!(
        child.stop(Duration::from_millis(300)),
        ChildExit::AfterOurStop
    );
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "{:?}",
        started.elapsed()
    );
    assert!(!alive(pid));
    assert!(!child_registry::live().contains(&(pid as i32)));
}

#[test]
fn a_group_kill_reaches_a_grandchild() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("grandchild.pid");
    let bin = script(
        dir.path(),
        "parent",
        &format!("sleep 30 &\necho $! > {}\nwait", pidfile.to_str().unwrap()),
    );
    let child = spawn(&spec(bin, dir.path()), "").unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let grandchild: u32 = loop {
        if let Some(pid) = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < until, "the grandchild never started");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(alive(grandchild));
    child.stop(Duration::from_secs(1));
    let until = Instant::now() + Duration::from_secs(5);
    while alive(grandchild) {
        assert!(
            Instant::now() < until,
            "the grandchild outlived the group kill"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_missing_binary_is_a_spawn_error() {
    let dir = tempfile::tempdir().unwrap();
    let err = spawn(&spec(dir.path().join("nope"), dir.path()), "")
        .err()
        .expect("no binary, no child");
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
}

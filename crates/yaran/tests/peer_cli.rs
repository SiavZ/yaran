//! End-to-end checks of `yaran peer` through the real binary, with `YARAN_HOME` and
//! the AMQ root pointed at a temp dir so the host's real state is untouched.
//!
//! `yaran peer` is a client: its agents and its AMQ registry pass come from the
//! yaran running on its config folder, so this journey serves one in this
//! process (and is a test binary of its own, since that yaran runs until the
//! process ends).

#[allow(dead_code)]
mod support;

use std::path::Path;
use std::process::{Command, Output};

use yaran_core::model::{
    AgentSession, AgentWorkspace, FolderWorkspace, ProviderKind, SessionStatus,
};
use yaran_core::storage::SessionStore;

fn yaran(home: &Path, amq: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_yaran"))
        .args(args)
        .env("YARAN_HOME", home)
        .env("AMQ_GLOBAL_ROOT", amq)
        .env_remove("AM_ROOT")
        .env_remove("YARAN_SESSION_ID")
        .env_remove("YARAN_AMQ_HANDLE")
        .env_remove("AM_ME")
        // No broker on this port, so Claude Peers is reliably "unavailable".
        .env("CLAUDE_PEERS_PORT", "9")
        .output()
        .expect("run yaran")
}

fn session(id: &str, provider: &str, folder: &Path, status: SessionStatus) -> AgentSession {
    AgentSession {
        id: id.to_string(),
        // What the create job assigns: the folder's basename, normalized.
        agent_handle: yaran_core::model::derive_agent_handle(&folder.display().to_string(), "", id),
        shared_workspace: false,
        deleted_at: None,
        slot_tab_id: format!("{id}-slot"),
        provider: ProviderKind::new(provider),
        workspace: AgentWorkspace::Folder(FolderWorkspace {
            folder_path: folder.display().to_string(),
        }),
        title: None,
        started_providers: Vec::new(),
        // Served below: a session yaran would relaunch at start would launch a
        // real agent CLI, which the test guard refuses.
        desired_running: false,
        auto_reopen_enabled: false,
        status,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        last_focused_tab: None,
    }
}

#[test]
fn peer_commands_ask_the_running_yaran() {
    let tmp = tempfile::tempdir().unwrap();
    let home = support::home("peer", "journey");
    let amq = tmp.path().join("amq");
    let live = tmp.path().join("Live Agent");
    let gone = tmp.path().join("gone-agent");
    let worker = tmp.path().join("worker");
    for dir in [&live, &worker] {
        std::fs::create_dir_all(dir).unwrap();
    }
    {
        let store = SessionStore::open(&home.join("sessions.sqlite3")).unwrap();
        for (id, provider, dir, status) in [
            ("s1", "claude", &live, SessionStatus::Active),
            ("s2", "codex", &gone, SessionStatus::Active),
            ("s4", "claude", &worker, SessionStatus::Active),
        ] {
            store
                .upsert_session(&session(id, provider, dir, status))
                .unwrap();
        }
    }

    // With no yaran on the folder the command says so and reads nothing.
    let alone = yaran(&home, &amq, &["peer", "list"]);
    assert!(!alone.status.success());
    assert!(
        String::from_utf8_lossy(&alone.stderr).contains("yaran isn't running"),
        "{alone:?}"
    );

    // The yaran serving this folder reconciles the registry it is pointed at.
    for (name, value) in [
        ("AMQ_GLOBAL_ROOT", Some(amq.as_os_str())),
        ("AM_ROOT", None),
        // A terminal runs the developer's login shell otherwise.
        ("SHELL", Some("/bin/sh".as_ref())),
    ] {
        // SAFETY: this binary runs this one test, and the serve that reads
        // the environment starts after this.
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
    support::serve(&home);

    let help = yaran(&home, &amq, &["peer", "--help"]);
    assert!(help.status.success());
    let help = String::from_utf8_lossy(&help.stdout);
    assert!(help.contains("yaran peer send [--from <handle>] [--transport auto|amq|claude-peers]"));

    let sync = yaran(&home, &amq, &["peer", "sync-amq"]);
    assert!(sync.status.success(), "{sync:?}");
    let sync = String::from_utf8_lossy(&sync.stdout);
    assert!(
        sync.contains(&format!("AMQ sync: {}", amq.display())),
        "{sync}"
    );
    assert!(sync.contains("configured agents added:"), "{sync}");
    assert!(amq.join("agents/live-agent/.dux-amq-source").is_file());

    let list = yaran(&home, &amq, &["peer", "list"]);
    assert!(list.status.success(), "{list:?}");
    let list = String::from_utf8_lossy(&list.stdout);
    assert!(list.contains("live-agent"), "{list}");
    // An unroutable session is hidden: its directory is gone. (An exited one
    // is too, but the yaran serving this folder settles every stored status
    // when it starts, so the router's own tests hold that case.)
    assert!(!list.contains("gone-agent"), "{list}");
    assert!(list.contains("Claude Peers broker: unavailable"), "{list}");

    let unknown = yaran(&home, &amq, &["peer", "send", "nobody", "hi"]);
    assert!(!unknown.status.success());
    assert!(
        String::from_utf8_lossy(&unknown.stderr).contains("does not exist or is not reachable"),
        "{unknown:?}"
    );

    // A stand-in `amq` records the hand-off, so the test needs no AMQ install.
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let sent = tmp.path().join("amq-sent.log");
    std::fs::write(
        bin.join("amq"),
        format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n", sent.display()),
    )
    .unwrap();
    std::fs::set_permissions(
        bin.join("amq"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let send = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_yaran"))
            .args(args)
            .env("YARAN_HOME", &home)
            .env("AMQ_GLOBAL_ROOT", &amq)
            .env("PATH", &path)
            .env_remove("AM_ROOT")
            .env_remove("YARAN_SESSION_ID")
            .env_remove("YARAN_AMQ_HANDLE")
            .env_remove("AM_ME")
            .env("CLAUDE_PEERS_PORT", "9")
            .output()
            .expect("run yaran")
    };

    // With the broker down a Claude target still gets the message, over AMQ,
    // and the output says why.
    let claude = send(&["peer", "send", "worker", "--status", "please"]);
    let out = String::from_utf8_lossy(&claude.stdout);
    assert!(
        claude.status.success(),
        "{out}{}",
        String::from_utf8_lossy(&claude.stderr)
    );
    assert!(out.contains("sent via amq:"), "{out}");
    assert!(out.contains("broker is not answering"), "{out}");
    let handed = std::fs::read_to_string(&sent).unwrap();
    assert!(handed.contains("--status please"), "{handed}");

    // Asking for Claude Peers explicitly refuses rather than falling back.
    let explicit = send(&[
        "peer",
        "send",
        "--transport",
        "claude-peers",
        "worker",
        "hi",
    ]);
    assert!(!explicit.status.success());
    let err = String::from_utf8_lossy(&explicit.stderr);
    assert!(
        err.contains("omit --transport to deliver over AMQ"),
        "{err}"
    );
}

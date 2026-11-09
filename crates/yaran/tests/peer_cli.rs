//! End-to-end checks of `yaran peer` through the real binary, with YARAN_HOME and
//! the AMQ root pointed at a temp dir so the host's real state is untouched.

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
        desired_running: true,
        auto_reopen_enabled: true,
        status,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        last_focused_tab: None,
    }
}

#[test]
fn peer_help_list_and_sync_run_through_the_binary() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let amq = tmp.path().join("amq");
    std::fs::create_dir_all(&home).unwrap();
    let live = tmp.path().join("Live Agent");
    let gone = tmp.path().join("gone-agent");
    let exited = tmp.path().join("exited-agent");
    std::fs::create_dir_all(&live).unwrap();
    std::fs::create_dir_all(&exited).unwrap();
    let store = SessionStore::open(&home.join("sessions.sqlite3")).unwrap();
    store
        .upsert_session(&session("s1", "claude", &live, SessionStatus::Active))
        .unwrap();
    store
        .upsert_session(&session("s2", "codex", &gone, SessionStatus::Active))
        .unwrap();
    store
        .upsert_session(&session("s3", "codex", &exited, SessionStatus::Exited))
        .unwrap();

    let help = yaran(&home, &amq, &["peer", "--help"]);
    assert!(help.status.success());
    let help = String::from_utf8_lossy(&help.stdout);
    assert!(help.contains("yaran peer send [--from <handle>] [--transport auto|amq|claude-peers]"));

    let sync = yaran(&home, &amq, &["peer", "sync-amq"]);
    assert!(sync.status.success(), "{sync:?}");
    let sync = String::from_utf8_lossy(&sync.stdout);
    assert!(sync.contains("configured agents added: 3"), "{sync}");
    assert!(amq.join("agents/live-agent/.dux-amq-source").is_file());

    let list = yaran(&home, &amq, &["peer", "list"]);
    assert!(list.status.success(), "{list:?}");
    let list = String::from_utf8_lossy(&list.stdout);
    assert!(list.contains("live-agent"), "{list}");
    // Unroutable sessions are hidden: a missing directory, an exited agent.
    assert!(!list.contains("gone-agent"), "{list}");
    assert!(!list.contains("exited-agent"), "{list}");
    assert!(list.contains("Claude Peers broker: unavailable"), "{list}");
}

#[test]
fn peer_send_refuses_unknown_targets_and_falls_back_to_amq_without_the_broker() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let amq = tmp.path().join("amq");
    std::fs::create_dir_all(&home).unwrap();
    let live = tmp.path().join("worker");
    std::fs::create_dir_all(&live).unwrap();
    SessionStore::open(&home.join("sessions.sqlite3"))
        .unwrap()
        .upsert_session(&session("s1", "claude", &live, SessionStatus::Active))
        .unwrap();

    let unknown = yaran(&home, &amq, &["peer", "send", "nobody", "hi"]);
    assert!(!unknown.status.success());
    assert!(
        String::from_utf8_lossy(&unknown.stderr).contains("does not exist or is not reachable")
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

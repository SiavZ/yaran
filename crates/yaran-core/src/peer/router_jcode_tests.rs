//! jcode routing: a jcode agent takes Claude Peers, shared workspace or not,
//! and only the claude-peers server jcode runs for that session receives.

use super::tests::peer;
use super::*;
use crate::peer::test_support::session;
use std::fs;
use tempfile::tempdir;

/// Observed live: an orchestrator and its jcode workers all run in shared
/// workspaces, and every message to a worker went to an AMQ inbox jcode never reads.
#[test]
fn jcode_targets_route_via_claude_peers_even_in_a_shared_workspace() {
    let dir = tempdir().unwrap();
    let mut sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", dir.path())),
    };
    sender.session.as_mut().unwrap().shared_workspace = true;
    let mut target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "jcode", "target", dir.path())),
    };
    assert_eq!(
        choose_transport(TransportPreference::Auto, &sender, &target).unwrap(),
        ChosenTransport::ClaudePeers
    );
    target.session.as_mut().unwrap().shared_workspace = true;
    assert_eq!(
        choose_transport(TransportPreference::Auto, &sender, &target).unwrap(),
        ChosenTransport::ClaudePeers
    );
    target.session.as_mut().unwrap().provider = "codex".to_string();
    assert_eq!(
        choose_transport(TransportPreference::Auto, &sender, &target).unwrap(),
        ChosenTransport::Amq
    );
}

/// Older jcode ran one claude-peers server for the whole daemon and dropped
/// every push, so only a registration jcode marks per session is reachable.
/// Observed live: the `claude` backends a jcode daemon spawns inherit the
/// daemon's `YARAN_SESSION_ID` and register too; naming the agent is not enough.
#[test]
fn a_jcode_target_takes_only_its_marked_registration() {
    let dir = tempdir().unwrap();
    let wt = dir.path().join("worktree");
    fs::create_dir_all(&wt).unwrap();
    let target = session("s1", "jcode", "feature", &wt);
    let mut marked = Command::new(std::env::current_exe().unwrap())
        .args([
            "peer::router::tests::env_probe_helper",
            "--exact",
            "--test-threads=1",
        ])
        .env("YARAN_ENV_PROBE_SLEEP", "1")
        .env("YARAN_SESSION_ID", "")
        .env("JCODE_MCP_CHANNEL_SESSION", "session_fox_1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut phantom = Command::new(std::env::current_exe().unwrap())
        .args(["peer::router::tests::env_probe_helper", "--exact"])
        .env("YARAN_ENV_PROBE_SLEEP", "1")
        .env("YARAN_SESSION_ID", "s1")
        .env_remove("JCODE_MCP_CHANNEL_SESSION")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let processes = ProcessTable::snapshot(None);
    let legacy = peer("legacy", &wt, std::process::id(), "2026-11-18T10:00:00Z");
    let backend = peer("backend", &wt, phantom.id(), "2026-11-18T11:00:00Z");
    let current = peer("current", &wt, marked.id(), "2026-11-18T09:00:00Z");

    let second = peer("second", &wt, marked.id(), "2026-11-18T08:00:00Z");

    let picked = reachable_claude_peer(
        &target,
        &[legacy.clone(), backend, current.clone()],
        &processes,
    );
    let unmarked = reachable_claude_peer(&target, &[legacy], &processes);
    // Two jcode sessions in one directory cannot be told apart.
    let ambiguous = reachable_claude_peer(&target, &[current, second], &processes);
    for child in [&mut marked, &mut phantom] {
        let _ = child.kill();
        let _ = child.wait();
    }

    assert_eq!(picked, Ok("current".to_string()));
    assert_eq!(unmarked, Err(Unreachable::Unregistered));
    assert_eq!(ambiguous, Err(Unreachable::Ambiguous));
}

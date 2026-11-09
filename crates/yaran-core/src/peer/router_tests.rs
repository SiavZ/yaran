use super::*;
use std::fs;
use tempfile::tempdir;

use crate::peer::test_support::session;

fn peer(id: &str, cwd: &Path, pid: u32, registered_at: &str) -> ClaudePeer {
    ClaudePeer {
        id: id.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        pid: Some(pid),
        last_seen: Some("2026-09-16T00:00:00Z".to_string()),
        registered_at: Some(registered_at.to_string()),
    }
}

fn worktree_session(dir: &tempfile::TempDir) -> (PathBuf, PeerSession) {
    let wt = dir.path().join("worktree");
    fs::create_dir_all(&wt).unwrap();
    let session = session("s1", "claude", "feature", &wt);
    (wt, session)
}

/// Observed live: the pane's original process (a yaran child, oldest
/// registration) kept queueing channel messages nobody drained after
/// Claude Code continued the conversation into a daemon-hosted session.
/// A pre-warmed spare in the same worktree was newer than both.
#[test]
fn peer_selection_prefers_the_daemon_hosted_session() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let peers = vec![
        peer("pane-shell", &wt, 100, "2026-09-15T07:24:00Z"),
        peer("spare", &wt, 200, "2026-09-15T23:00:00Z"),
        peer("daemon-host", &wt, 300, "2026-09-15T21:13:00Z"),
    ];
    let host_of = |pid: u32| match pid {
        100 => PeerHost::Pane,
        200 => PeerHost::Spare,
        300 => PeerHost::DaemonSession,
        _ => PeerHost::Client,
    };
    assert_eq!(
        select_claude_peer_id(&session, &peers, host_of, |_| None),
        Some("daemon-host".to_string()),
    );
}

/// Without a daemon in the picture the pane yaran spawned must still beat
/// a spare listed first and heartbeating more recently.
#[test]
fn peer_selection_prefers_the_pane_over_spares_and_strangers() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let peers = vec![
        peer("spare", &wt, 4242, "2026-09-16T00:00:09Z"),
        peer("stranger", &wt, 7, "2026-09-16T00:00:05Z"),
        peer("pane", &wt, 1001, "2026-09-16T00:00:01Z"),
    ];
    let host_of = |pid: u32| match pid {
        1001 => PeerHost::Pane,
        4242 => PeerHost::Spare,
        _ => PeerHost::Client,
    };
    assert_eq!(
        select_claude_peer_id(&session, &peers, host_of, |_| None),
        Some("pane".to_string()),
    );
}

#[test]
fn peer_selection_takes_newest_registration_among_equal_hosts() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let peers = vec![
        peer("old-host", &wt, 1, "2026-09-15T21:13:00Z"),
        peer("new-host", &wt, 2, "2026-09-16T01:00:00Z"),
    ];
    assert_eq!(
        select_claude_peer_id(&session, &peers, |_| PeerHost::DaemonSession, |_| None),
        Some("new-host".to_string()),
    );
    // Only spares left (TUI gone, or a broker without pids): still
    // deterministic rather than list order.
    assert_eq!(
        select_claude_peer_id(&session, &peers, |_| PeerHost::Spare, |_| None),
        Some("new-host".to_string()),
    );
}

#[test]
fn peer_selection_ignores_other_worktrees_and_reports_no_match() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let other = dir.path().join("other");
    fs::create_dir_all(&other).unwrap();
    let peers = vec![peer("elsewhere", &other, 1001, "2026-09-16T00:00:09Z")];
    assert_eq!(
        select_claude_peer_id(&session, &peers, |_| PeerHost::DaemonSession, |_| None),
        None
    );
    // A single match needs no disambiguation at all, spare or not.
    let peers = vec![peer("only", &wt, 1, "2026-09-16T00:00:01Z")];
    assert_eq!(
        select_claude_peer_id(&session, &peers, |_| PeerHost::Spare, |_| None),
        Some("only".to_string()),
    );
}

/// Observed live: the orchestrator's pane `/resume`d a conversation recorded
/// under contracts-engineer's directory, so its registration sat there. Its
/// own directory had none (every message fell back to AMQ), and contracts
/// had two candidates. The agent named in the registration's environment
/// decides both.
#[test]
fn peer_selection_follows_the_agent_named_in_the_registration() {
    let dir = tempdir().unwrap();
    let own = dir.path().join("Jobzy");
    let other = dir.path().join("Jobzy-Contracts");
    fs::create_dir_all(&own).unwrap();
    fs::create_dir_all(&other).unwrap();
    let orchestrator = session("orch", "claude", "jobzy-orchestrator", &own);
    let contracts = session("contracts", "claude", "contracts-engineer", &other);
    let peers = vec![
        peer("orch-peer", &other, 10, "2026-11-09T10:21:00Z"),
        peer("contracts-peer", &other, 20, "2026-11-09T10:20:00Z"),
    ];
    let owner = |pid: u32| match pid {
        10 => Some("orch".to_string()),
        20 => Some("contracts".to_string()),
        _ => None,
    };
    assert_eq!(
        select_claude_peer_id(&orchestrator, &peers, |_| PeerHost::Pane, owner),
        Some("orch-peer".to_string()),
    );
    // The orchestrator's registration is newer, and still not contracts'.
    assert_eq!(
        select_claude_peer_id(&contracts, &peers, |_| PeerHost::Pane, owner),
        Some("contracts-peer".to_string()),
    );
}

/// The directory fallback serves registrations that name no agent, and never
/// one that names a different agent.
#[test]
fn directory_fallback_never_takes_another_agents_registration() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let peers = vec![
        peer("someone-else", &wt, 10, "2026-11-09T10:21:00Z"),
        peer("unnamed", &wt, 20, "2026-11-09T10:20:00Z"),
    ];
    let owner = |pid: u32| (pid == 10).then(|| "another-agent".to_string());
    assert_eq!(
        select_claude_peer_id(&session, &peers, |_| PeerHost::Pane, owner),
        Some("unnamed".to_string()),
    );
    let only_foreign = vec![peer("someone-else", &wt, 10, "2026-11-09T10:21:00Z")];
    assert_eq!(
        select_claude_peer_id(&session, &only_foreign, |_| PeerHost::Pane, owner),
        None,
    );
}

/// Not a check on its own: the process `a_registrations_agent_is_read_from_its_process_environment`
/// spawns. macOS hides the environment of its own platform binaries (`sh`,
/// `sleep`) from other processes, so the probe is this test binary.
#[test]
fn env_probe_helper() {
    if std::env::var_os("YARAN_ENV_PROBE_SLEEP").is_some() {
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}

/// The agent id comes from the real process table: a process launched with
/// `YARAN_SESSION_ID` names it, as a claude-peers server inherits it.
#[test]
fn a_registrations_agent_is_read_from_its_process_environment() {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "peer::router::tests::env_probe_helper",
            "--exact",
            "--test-threads=1",
        ])
        .env("YARAN_ENV_PROBE_SLEEP", "1")
        .env("YARAN_SESSION_ID", "agent-7")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let processes = ProcessTable::snapshot(None);
    let named = processes.yaran_session_of(child.id());
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(named, Some("agent-7".to_string()));
}

#[test]
fn the_yaran_session_id_wins_over_the_legacy_name() {
    let env = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
    assert_eq!(
        session_id_in_environ(&env(&["DUX_SESSION_ID=old", "YARAN_SESSION_ID=new"])),
        Some("new".to_string())
    );
    assert_eq!(
        session_id_in_environ(&env(&["DUX_SESSION_ID=old"])),
        Some("old".to_string())
    );
    assert_eq!(
        session_id_in_environ(&env(&["YARAN_SESSION_ID_X=nope"])),
        None
    );
    assert_eq!(session_id_in_environ(&env(&["YARAN_SESSION_ID="])), None);
}

/// A broker that predates `pid` / `registered_at` still parses, and its
/// registrations rank as ordinary clients.
#[test]
fn broker_peers_without_optional_fields_still_parse() {
    let peers: Vec<ClaudePeer> =
        serde_json::from_value(json!([{ "id": "a", "cwd": "/x" }])).unwrap();
    assert_eq!(peers[0].pid, None);
    assert_eq!(peers[0].registered_at, None);
}

#[test]
fn daemon_roles_are_recognised_from_command_lines() {
    let cmd = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
    assert_eq!(
        daemon_host_kind(&cmd(&[
            "claude",
            "bg-spare",
            "--bg-spare",
            "/tmp/x.claim.sock"
        ])),
        Some(PeerHost::Spare)
    );
    assert_eq!(
        daemon_host_kind(&cmd(&[
            "claude",
            "bg-pty-host",
            "--bg-pty-host",
            "/tmp/x.pty.sock",
            "200",
            "50",
            "--",
            "/x/claude",
            "--session-id",
            "11111111-2222-4333-8444-555555555555",
            "--fork-session",
        ])),
        Some(PeerHost::DaemonSession)
    );
    assert_eq!(
        daemon_host_kind(&cmd(&[
            "claude",
            "--dangerously-skip-permissions",
            "--continue"
        ])),
        None
    );
    assert_eq!(daemon_host_kind(&[]), None);
}

/// The classifier walks real process ancestry: a child of this test
/// process, with this process standing in for the yaran TUI, is its pane.
#[test]
fn host_classifier_finds_the_yaran_pane_by_ancestry() {
    let mut child = Command::new("sleep").arg("5").spawn().unwrap();
    let classify = ProcessTable::snapshot(Some(std::process::id()));
    assert_eq!(classify.host_of(child.id()), PeerHost::Pane);
    let unrelated = ProcessTable::snapshot(None);
    assert_eq!(unrelated.host_of(child.id()), PeerHost::Client);
    assert_eq!(unrelated.host_of(u32::MAX - 7), PeerHost::Client);
    let _ = child.kill();
    let _ = child.wait();
}

/// Claude Code's in-place relaunch rebuilt these lanes' argv without the
/// channel flag (observed live: `claude --resume <id> --model default ...`).
#[test]
fn peers_channel_flag_is_recognised_from_command_lines() {
    let cmd = |parts: &[&str]| parts.iter().map(OsString::from).collect::<Vec<_>>();
    assert!(command_loads_peers_channel(&cmd(&[
        "claude",
        "--dangerously-skip-permissions",
        "--dangerously-load-development-channels",
        "server:claude-peers",
        "--effort",
        "high",
    ])));
    assert!(command_loads_peers_channel(&cmd(&[
        "claude",
        "--dangerously-load-development-channels",
        "server:other",
        "server:claude-peers",
    ])));
    assert!(command_loads_peers_channel(&cmd(&[
        "claude",
        "--dangerously-load-development-channels=server:claude-peers",
    ])));
    assert!(!command_loads_peers_channel(&cmd(&[
        "/Users/x/.local/bin/claude",
        "--resume",
        "22ef48c4-2bee-43ff-9330-093af217a8d6",
        "--allow-dangerously-skip-permissions",
        "--model",
        "default",
        "--permission-mode",
        "bypassPermissions",
    ])));
    // The channel name only counts as the flag's value.
    assert!(!command_loads_peers_channel(&cmd(&[
        "claude",
        "--dangerously-load-development-channels",
        "server:other",
        "--append-system-prompt",
        "server:claude-peers",
    ])));
}

/// A `claude` process standing in for a pane: `sh` exec'd as `claude`, with
/// or without the channel flag in its argv.
fn fake_claude(extra: &[&str]) -> std::process::Child {
    use std::os::unix::process::CommandExt;
    Command::new("/bin/sh")
        .arg0("claude")
        .args(["-c", "sleep 5; :", "claude"])
        .args(extra)
        .spawn()
        .unwrap()
}

/// The silent-lanes incident: the broker held one registration per lane,
/// so every message was "delivered" into a Claude that had dropped the
/// channel and discarded it. Such a target must read as unreachable.
#[test]
fn registration_hosted_by_a_claude_without_the_channel_is_unreachable() {
    let dir = tempdir().unwrap();
    let (wt, session) = worktree_session(&dir);
    let mut deaf = fake_claude(&["--resume", "abc", "--model", "default"]);
    let mut listening = fake_claude(&[
        "--dangerously-load-development-channels",
        "server:claude-peers",
    ]);
    let processes = ProcessTable::snapshot(None);

    assert_eq!(processes.loads_peers_channel(deaf.id()), Some(false));
    assert_eq!(processes.loads_peers_channel(listening.id()), Some(true));
    assert_eq!(
        reachable_claude_peer(
            &session,
            &[peer("deaf", &wt, deaf.id(), "2026-11-03T13:15:00Z")],
            &processes
        ),
        Err(Unreachable::ChannelOff)
    );
    assert_eq!(
        reachable_claude_peer(
            &session,
            &[peer("ok", &wt, listening.id(), "2026-11-03T13:15:00Z")],
            &processes
        ),
        Ok("ok".to_string())
    );
    // No pid from the broker: nothing to inspect, so the registration is trusted.
    let mut unknown = peer("unknown", &wt, 1, "2026-11-03T13:15:00Z");
    unknown.pid = None;
    assert_eq!(
        reachable_claude_peer(&session, &[unknown], &processes),
        Ok("unknown".to_string())
    );
    assert_eq!(
        reachable_claude_peer(&session, &[], &processes),
        Err(Unreachable::Unregistered)
    );

    // A deaf sender must not sign as itself: the reply would be dropped too.
    let sender = SenderContext {
        handle: "deaf-lane".to_string(),
        session: Some(session.clone()),
    };
    let (from_id, message) = claude_peers_sender(
        &sender,
        &[peer("deaf", &wt, deaf.id(), "2026-11-03T13:15:00Z")],
        "status?",
        &processes,
    );
    assert_eq!(from_id, "deaf-lane");
    assert!(message.contains("yaran peer send deaf-lane"));

    for child in [&mut deaf, &mut listening] {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Observed after a reboot: every lane's claude-peers server had died, and
/// sends to them failed. An outage now costs Claude Peers, not the message.
#[test]
fn a_target_claude_peers_cannot_reach_gets_the_message_over_amq() {
    for why in [
        PeersUnavailable::Broker,
        PeersUnavailable::Target(Unreachable::Unregistered),
        PeersUnavailable::Target(Unreachable::ChannelOff),
    ] {
        let reason = amq_fallback_reason(TransportPreference::Auto, &why, "infra").unwrap();
        assert_eq!(reason, why.reason("infra"));
    }
    assert!(
        PeersUnavailable::Target(Unreachable::Unregistered)
            .reason("infra")
            .contains("/mcp")
    );
    assert!(
        PeersUnavailable::Broker
            .reason("infra")
            .contains("not answering")
    );
}

/// Asking for Claude Peers explicitly means Claude Peers or nothing.
#[test]
fn explicit_claude_peers_is_refused_with_the_reason_when_it_cannot_reach() {
    let err = amq_fallback_reason(
        TransportPreference::ClaudePeers,
        &PeersUnavailable::Target(Unreachable::Unregistered),
        "infra",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("infra has no Claude Peers registration"));
    assert!(err.contains("omit --transport to deliver over AMQ"));
}

#[test]
fn yaran_pid_is_read_from_the_lockfile() {
    let dir = tempdir().unwrap();
    let paths = YaranPaths {
        config_path: dir.path().join("config.toml"),
        sessions_db_path: dir.path().join("sessions.sqlite3"),
        worktrees_root: dir.path().join("worktrees"),
        lock_path: dir.path().join("yaran.lock"),
        root: dir.path().to_path_buf(),
    };
    assert_eq!(yaran_tui_pid(&paths), None);
    fs::write(&paths.lock_path, "4321\n").unwrap();
    assert_eq!(yaran_tui_pid(&paths), Some(4321));
    fs::write(&paths.lock_path, "").unwrap();
    assert_eq!(yaran_tui_pid(&paths), None);
}

#[test]
fn target_resolution_uses_persisted_agent_handle() {
    let dir = tempdir().unwrap();
    let worktree = dir.path().join("Feature Login");
    fs::create_dir_all(&worktree).unwrap();
    let s = session("s1", "claude", "renamed", &worktree);

    let target = resolve_target("renamed", &[s]).unwrap();

    assert_eq!(target.handle, "renamed");
    assert_eq!(target.session.unwrap().id, "s1");
}

#[test]
fn target_resolution_matches_directory_title_and_id_aliases() {
    let dir = tempdir().unwrap();
    let worktree = dir.path().join("Feature Login");
    let mut s = session("s1", "claude", "renamed", &worktree);
    s.title = Some("My Title".to_string());
    let sessions = [s];
    for alias in ["Feature Login", "feature-login", "My Title", "s1"] {
        assert_eq!(resolve_target(alias, &sessions).unwrap().handle, "renamed");
    }
}

#[test]
fn target_resolution_rejects_ambiguous_aliases() {
    let dir = tempdir().unwrap();
    let a = session("s1", "claude", "one", &dir.path().join("x/same"));
    let b = session("s2", "codex", "two", &dir.path().join("y/same"));
    let err = resolve_target("same", &[a, b]).unwrap_err().to_string();
    assert!(err.contains("ambiguous peer target"), "{err}");
}

#[test]
fn target_resolution_rejects_unknown_agent() {
    let err = resolve_target("missing-branch", &[])
        .expect_err("unknown targets must fail before transport selection");

    assert_eq!(
        err.to_string(),
        "agent \"missing-branch\" does not exist or is not reachable; run `yaran peer list` and retry with a listed handle"
    );
}

#[test]
fn routable_sessions_exclude_exited_and_missing_worktrees() {
    let dir = tempdir().unwrap();
    let live_wt = dir.path().join("live");
    fs::create_dir_all(&live_wt).unwrap();
    let mut exited = session("s2", "codex", "exited", &live_wt);
    exited.exited = true;
    let missing = session("s3", "claude", "missing", &dir.path().join("missing"));
    let mut deleted = session("s4", "claude", "deleted", &live_wt);
    deleted.deleted = true;

    assert!(session("s1", "claude", "live", &live_wt).is_routable());
    assert!(!exited.is_routable());
    assert!(!missing.is_routable());
    assert!(!deleted.is_routable());
}

#[test]
fn explicit_claude_peers_refuses_codex_target() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session(
            "s1",
            "claude",
            "sender",
            &dir.path().join("sender"),
        )),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "codex", "target", &dir.path().join("target"))),
    };

    let err = choose_transport(TransportPreference::ClaudePeers, &sender, &target)
        .unwrap_err()
        .to_string();

    assert!(err.contains("cannot target provider codex"));
}

#[test]
fn explicit_amq_is_honoured_for_a_claude_target() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: None,
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "claude", "target", dir.path())),
    };
    assert_eq!(
        choose_transport(TransportPreference::Amq, &sender, &target).unwrap(),
        ChosenTransport::Amq
    );
}

#[test]
fn auto_routes_a_non_claude_target_via_amq() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", dir.path())),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "codex", "target", dir.path())),
    };
    assert_eq!(
        choose_transport(TransportPreference::Auto, &sender, &target).unwrap(),
        ChosenTransport::Amq
    );
}

#[test]
fn shared_claude_sender_to_worktree_claude_target_routes_via_claude_peers() {
    let dir = tempdir().unwrap();
    let mut sender_session = session("s1", "claude", "sender", dir.path());
    sender_session.shared_workspace = true;
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(sender_session),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "claude", "target", dir.path())),
    };

    let transport = choose_transport(TransportPreference::Auto, &sender, &target).unwrap();

    assert_eq!(transport, ChosenTransport::ClaudePeers);
}

#[test]
fn shared_claude_sender_to_worktree_codex_target_routes_via_amq() {
    let dir = tempdir().unwrap();
    let mut sender_session = session("s1", "claude", "sender", dir.path());
    sender_session.shared_workspace = true;
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(sender_session),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "codex", "target", dir.path())),
    };

    assert_eq!(
        choose_transport(TransportPreference::Auto, &sender, &target).unwrap(),
        ChosenTransport::Amq
    );
}

#[test]
fn worktree_claude_sender_to_shared_claude_target_routes_via_claude_peers() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", dir.path())),
    };
    let mut target_session = session("s2", "claude", "target", dir.path());
    target_session.shared_workspace = true;
    let target = PeerTarget {
        handle: target_session.agent_handle().to_string(),
        session: Some(target_session),
    };

    let transport = choose_transport(TransportPreference::Auto, &sender, &target).unwrap();

    assert_eq!(transport, ChosenTransport::ClaudePeers);
    assert_eq!(target.handle, "target");
}

#[test]
fn shared_claude_sender_to_shared_claude_target_routes_via_claude_peers() {
    let dir = tempdir().unwrap();
    let mut sender_session = session("s1", "claude", "sender", dir.path());
    sender_session.shared_workspace = true;
    let mut target_session = session("s2", "claude", "target", dir.path());
    target_session.shared_workspace = true;
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(sender_session),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(target_session),
    };

    let transport = choose_transport(TransportPreference::Auto, &sender, &target).unwrap();

    assert_eq!(transport, ChosenTransport::ClaudePeers);
}

#[test]
fn explicit_amq_rejects_claude_to_claude_route() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", dir.path())),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "claude", "target", dir.path())),
    };

    let err = choose_transport(TransportPreference::Amq, &sender, &target)
        .unwrap_err()
        .to_string();

    assert!(err.contains("Claude-to-Claude"));
    assert!(err.contains("claude-peers"));
}

/// Default Claude targets go to Claude Peers whatever the sender's provider
/// (fork commit "Default Claude targets to Claude Peers").
#[test]
fn worktree_endpoints_still_prefer_claude_peers() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "codex", "sender", &dir.path().join("sender"))),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session(
            "s2",
            "claude",
            "target",
            &dir.path().join("target"),
        )),
    };

    let transport = choose_transport(TransportPreference::Auto, &sender, &target).unwrap();

    assert_eq!(transport, ChosenTransport::ClaudePeers);
}

#[test]
fn explicit_claude_peers_accepts_shared_claude_sender() {
    let dir = tempdir().unwrap();
    let mut sender_session = session("s1", "claude", "sender", dir.path());
    sender_session.shared_workspace = true;
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(sender_session),
    };
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(session("s2", "claude", "target", dir.path())),
    };

    assert_eq!(
        choose_transport(TransportPreference::ClaudePeers, &sender, &target).unwrap(),
        ChosenTransport::ClaudePeers
    );
}

#[test]
fn explicit_claude_peers_accepts_shared_claude_target() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", dir.path())),
    };
    let mut target_session = session("s2", "claude", "target", dir.path());
    target_session.shared_workspace = true;
    let target = PeerTarget {
        handle: "target".to_string(),
        session: Some(target_session),
    };

    assert_eq!(
        choose_transport(TransportPreference::ClaudePeers, &sender, &target).unwrap(),
        ChosenTransport::ClaudePeers
    );
}

#[test]
fn ambiguous_cwd_sender_is_rejected_with_from_hint() {
    let dir = tempdir().unwrap();
    let sessions = vec![
        session("s1", "claude", "sender-one", dir.path()),
        session("s2", "claude", "sender-two", dir.path()),
    ];

    let err = session_for_cwd(dir.path(), &sessions)
        .unwrap_err()
        .to_string();

    assert!(err.contains("multiple Yaran sessions share this workspace"));
    assert!(err.contains("--from <agent_handle>"));
}

#[test]
fn cwd_sender_still_prefers_the_deepest_worktree() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("nested");
    let child = nested.join("src");
    fs::create_dir_all(&child).unwrap();
    let sessions = vec![
        session("parent", "claude", "parent", dir.path()),
        session("nested", "claude", "nested", &nested),
    ];

    let sender = session_for_cwd(&child, &sessions).unwrap().unwrap();

    assert_eq!(sender.id, "nested");
}

#[test]
fn explicit_from_resolves_exact_agent_handle_before_aliases() {
    let dir = tempdir().unwrap();
    let mut alias = session("s1", "claude", "other-handle", dir.path());
    alias.branch = Some("stable-handle".to_string());
    let exact = session("s2", "claude", "stable-handle", dir.path());

    let sender = infer_sender(Some("stable-handle"), &[alias, exact]).unwrap();

    assert_eq!(sender.handle, "stable-handle");
    assert_eq!(sender.session.unwrap().id, "s2");
}

#[test]
fn explicit_from_that_sanitises_to_nothing_is_rejected() {
    let err = infer_sender(Some("!!!"), &[]).unwrap_err().to_string();
    assert!(err.contains("empty AMQ handle"));
}

#[test]
fn non_claude_sender_gets_yaran_reply_hint_for_claude_peers() {
    let dir = tempdir().unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "codex", "sender", &dir.path().join("sender"))),
    };

    let (from_id, message) =
        claude_peers_sender(&sender, &[], "status?", &ProcessTable::snapshot(None));

    assert_eq!(from_id, "sender");
    assert!(message.contains("yaran peer send sender"));
    assert!(message.ends_with("status?"));
}

#[test]
fn registered_claude_sender_sends_as_itself_without_preamble() {
    let dir = tempdir().unwrap();
    let wt = dir.path().join("sender");
    fs::create_dir_all(&wt).unwrap();
    let sender = SenderContext {
        handle: "sender".to_string(),
        session: Some(session("s1", "claude", "sender", &wt)),
    };
    let mut registration = peer("peer-7", &wt, 1, "2026-09-16T00:00:00Z");
    registration.pid = None;

    let (from_id, message) = claude_peers_sender(
        &sender,
        &[registration],
        "status?",
        &ProcessTable::snapshot(None),
    );

    assert_eq!(from_id, "peer-7");
    assert_eq!(message, "status?");
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

#[test]
fn send_arg_parser_allows_message_words_that_look_like_flags() {
    let parsed = parse_send_args(&args(&[
        "--transport",
        "amq",
        "worker",
        "--please",
        "respond",
    ]))
    .unwrap()
    .unwrap();

    assert_eq!(parsed.target, "worker");
    assert_eq!(parsed.message, "--please respond");
    assert_eq!(parsed.transport, TransportPreference::Amq);
}

/// `yaran peer send` keeps the fork's exact CLI; the orchestrator prompt
/// tells agents to call it with these arguments.
#[test]
fn send_arg_parser_accepts_the_fork_cli_shape() {
    let parsed = parse_send_args(&args(&[
        "--from",
        "Me",
        "--transport",
        "claude-peers",
        "worker",
        "multi",
        "word",
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(parsed.from.as_deref(), Some("Me"));
    assert_eq!(parsed.transport, TransportPreference::ClaudePeers);
    assert_eq!(parsed.target, "worker");
    assert_eq!(parsed.message, "multi word");

    let dashed = parse_send_args(&args(&["--", "--odd-target", "hi"]))
        .unwrap()
        .unwrap();
    assert_eq!(dashed.target, "--odd-target");
    assert_eq!(dashed.transport, TransportPreference::Auto);

    assert!(parse_send_args(&args(&["--help"])).unwrap().is_none());
    for bad in [
        &["worker"][..],
        &["--from"][..],
        &["--transport", "carrier-pigeon", "w", "m"][..],
        &["--bogus", "w", "m"][..],
    ] {
        assert!(parse_send_args(&args(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn peer_subcommands_reject_unknown_flags_and_subcommands() {
    let dir = tempdir().unwrap();
    let paths = YaranPaths {
        config_path: dir.path().join("config.toml"),
        sessions_db_path: dir.path().join("sessions.sqlite3"),
        worktrees_root: dir.path().join("worktrees"),
        lock_path: dir.path().join("yaran.lock"),
        root: dir.path().to_path_buf(),
    };
    assert!(run_peer(&args(&["bogus"]), &paths).is_err());
    assert!(run_peer(&args(&["list", "--nope"]), &paths).is_err());
    assert!(run_peer(&args(&["sync-amq", "--nope"]), &paths).is_err());
    assert!(run_peer(&args(&["--help"]), &paths).is_ok());
}

#[test]
fn broker_response_parsing_checks_status_and_json() {
    assert_eq!(
        parse_broker_response("HTTP/1.1 200 OK\r\nX: y\r\n\r\n{\"ok\":true}").unwrap(),
        json!({ "ok": true })
    );
    let err = parse_broker_response("HTTP/1.1 500 Oops\r\n\r\n\u{1b}]0;x\u{7}boom")
        .unwrap_err()
        .to_string();
    assert!(err.contains("HTTP 500"));
    assert!(!err.contains('\u{1b}'), "broker body must be sanitised");
    assert!(parse_broker_response("garbage").is_err());
    assert!(parse_broker_response("HTTP/1.1 200 OK\r\n\r\nnot json").is_err());
}

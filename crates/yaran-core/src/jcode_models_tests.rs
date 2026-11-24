use super::*;
use std::os::unix::fs::PermissionsExt;

fn client(root: &Path) -> crate::pty::PtyClient {
    crate::pty::PtyClient::spawn_with_env("cat", &[], root, 24, 80, 1000, &[]).unwrap()
}

fn target(id: &str, root: &Path, pid: u32) -> ModelTarget {
    ModelTarget {
        tab_id: id.into(),
        label: id.into(),
        command: root.join("jcode").display().to_string(),
        process: crate::process_sessions::ProcessSession::started_now(pid),
        env: vec![("JCODE_HOME".into(), root.display().to_string())],
        args: Vec::new(),
    }
}

#[test]
fn selected_tabs_use_exact_client_registrations_and_report_partial_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let clients = [client(root), client(root), client(root)];
    let pids = clients
        .each_ref()
        .map(|client| client.child_process_id().unwrap());
    let all = vec![
        target("a", root, pids[0]),
        target("b", root, pids[1]),
        target("c", root, pids[2]),
    ];
    std::fs::create_dir(root.join("client_sessions")).unwrap();
    for (pid, id) in [
        (pids[0], "session_fox_1_ab"),
        (pids[1], "session_owl_2_cd"),
        (pids[2], "session_elk_3_ef"),
    ] {
        std::fs::write(root.join("client_sessions").join(pid.to_string()), id).unwrap();
    }
    let script = r#"#!/bin/sh
if [ "$3" = sessions ]; then
    printf '%s' '[{"session_id":"session_fox_1_ab"},{"session_id":"session_owl_2_cd"},{"session_id":"session_elk_3_ef"}]'
else
    printf '%s\n' "$4 $5 $6" >> "$JCODE_HOME/calls"
    if [ "$4" = session_elk_3_ef ]; then echo 'model unavailable' >&2; exit 1; fi
    printf '%s' '{"model":"test-model"}'
fi
"#;
    std::fs::write(root.join("jcode"), script).unwrap();
    std::fs::set_permissions(root.join("jcode"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let result = change_models(&all, &["a".into(), "c".into()], "test-model").unwrap();
    assert_eq!(result.len(), 2);
    assert!(result[0].error.is_none());
    assert!(
        result[1]
            .error
            .as_ref()
            .unwrap()
            .contains("model unavailable")
    );
    let calls = std::fs::read_to_string(root.join("calls")).unwrap();
    assert!(calls.contains("session_fox_1_ab set_model test-model"));
    assert!(calls.contains("session_elk_3_ef set_model test-model"));
    assert!(
        !calls.contains("session_owl"),
        "unselected conversations stay untouched"
    );
    change_models(&all, &["a".into(), "b".into(), "c".into()], "test-model").unwrap();
    assert!(
        std::fs::read_to_string(root.join("calls"))
            .unwrap()
            .contains("session_owl_2_cd")
    );
}

#[test]
fn stale_pid_markers_never_select_another_conversation() {
    let tmp = tempfile::tempdir().unwrap();
    let client = client(tmp.path());
    let t = target("a", tmp.path(), client.child_process_id().unwrap());
    std::fs::write(
        tmp.path().join(t.process.sid.to_string()),
        "session_fox_1_ab",
    )
    .unwrap();
    std::fs::File::options()
        .write(true)
        .open(tmp.path().join(t.process.sid.to_string()))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
        .unwrap();
    assert!(registered_session(&t, tmp.path()).is_err());
    std::fs::write(
        tmp.path().join(t.process.sid.to_string()),
        "session_fox_1_ab",
    )
    .unwrap();
    assert_eq!(
        registered_session(&t, tmp.path()).unwrap(),
        "session_fox_1_ab"
    );
    std::fs::write(tmp.path().join(t.process.sid.to_string()), "--untrusted").unwrap();
    assert!(registered_session(&t, tmp.path()).is_err());
}

#[test]
fn invalid_input_and_stale_selection_never_launch_a_command() {
    let tmp = tempfile::tempdir().unwrap();
    let all = vec![target("a", tmp.path(), 999_999_999)];
    for model in ["", " ", "model\nnext", "model\u{1b}"] {
        assert!(change_models(&all, &["a".into()], model).is_err());
    }
    assert!(change_models(&all, &[], "model").is_err());
    assert!(change_models(&all, &["missing".into()], "model").is_err());
}

#[test]
fn target_inventory_includes_extra_tabs_and_uses_the_running_provider() {
    use crate::engine::test_support::{sample_session, sample_tab, test_engine};
    use crate::ids::TabId;
    use crate::model::ProviderKind;
    let (mut engine, tmp) = test_engine();
    let mut session = sample_session("s1", "p1", "agent");
    session.provider = ProviderKind::new("jcode");
    let slot = session.slot_tab_id().as_str().to_string();
    engine.sessions.push(session);
    engine
        .providers
        .insert(TabId::new(&slot), client(tmp.path()));
    engine
        .providers
        .insert(TabId::new("extra"), client(tmp.path()));
    engine
        .agent_tabs
        .insert(TabId::new("extra"), sample_tab("extra", "s1", "jcode", 1));
    let targets = engine.jcode_model_targets();
    assert_eq!(targets.len(), 2, "both tabs in one folder are offered");
    let json = serde_json::to_value(&targets).unwrap();
    assert_eq!(
        json[0].as_object().unwrap().len(),
        2,
        "runtime state and environment never reach the browser"
    );
    engine
        .running_provider_pins
        .insert(TabId::new(&slot), ProviderKind::new("codex"));
    assert_eq!(
        engine.jcode_model_targets().len(),
        1,
        "a pending retarget cannot disguise a live non-jcode provider"
    );
}

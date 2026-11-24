use super::*;
use std::os::unix::fs::PermissionsExt;

fn client(root: &Path) -> crate::pty::PtyClient {
    crate::pty::PtyClient::spawn_with_env("cat", &[], root, 24, 80, 1000, &[]).unwrap()
}

fn target(id: &str, root: &Path, pid: u32) -> ModelTarget {
    ModelTarget {
        tab_id: id.into(),
        label: id.into(),
        run_id: pid.to_string(),
        directory: root.to_path_buf(),
        command: root.join("jcode").display().to_string(),
        process: crate::process_sessions::ProcessSession::started_now(pid),
        env: vec![("JCODE_HOME".into(), root.display().to_string())],
        args: Vec::new(),
    }
}

fn selection(all: &[ModelTarget], ids: &[&str]) -> BTreeMap<String, String> {
    all.iter()
        .filter(|target| ids.contains(&target.tab_id.as_str()))
        .map(|target| (target.tab_id.clone(), target.run_id.clone()))
        .collect()
}

fn native_choice(id: &str, method: &str, levels: &[&str]) -> serde_json::Value {
    serde_json::json!({ "id": id, "name": "future-model-2099", "provider": "Native provider", "api_method": method,
        "available": true, "detail": "from jcode", "selection": { "native_exact_route": method, "model": "future-model-2099" },
        "reasoning_effort": levels.last(), "reasoning_levels": levels.iter().map(|level| serde_json::json!({ "value": level, "label": format!("Native {level}") })).collect::<Vec<_>>() })
}

fn native_clients() -> (
    tempfile::TempDir,
    [crate::pty::PtyClient; 3],
    Vec<ModelTarget>,
) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let clients = [client(root), client(root), client(root)];
    let all: Vec<_> = clients
        .iter()
        .enumerate()
        .map(|(i, client)| target(["a", "b", "c"][i], root, client.child_process_id().unwrap()))
        .collect();
    std::fs::create_dir(root.join("client_sessions")).unwrap();
    for (i, target) in all.iter().enumerate() {
        let session = ["session_fox_1_ab", "session_owl_2_cd", "session_elk_3_ef"][i];
        std::fs::write(
            root.join("client_sessions")
                .join(target.process.sid.to_string()),
            session,
        )
        .unwrap();
        std::fs::write(root.join(format!("{session}.json")), serde_json::json!({ "choices": [native_choice("route-oauth", "oauth", &["low", "high"]), native_choice("route-api", "api", &["low", "high"])], "client_pid": target.process.sid, "client_id": format!("connection-{session}"), "session_id": session }).to_string()).unwrap();
    }
    std::fs::write(
        root.join("ack.json"),
        r#"{"id":"route-oauth","model":"future-model-2099","reasoning_effort":"high"}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("jcode"),
        r#"#!/bin/sh
[ "$1" = debug ] && [ "$2" = --no-update ] && [ "$3" = --session ] || exit 42
case "$5" in
    client:model-options) cat "$JCODE_HOME/$4.json" ;;
    set_model_choice)
        [ "$6" = -- ] || exit 43
        printf '%s\n' "$4 $7" >> "$JCODE_HOME/calls"
        if [ "$4" = session_elk_3_ef ]; then echo 'model unavailable' >&2; exit 1; fi
        cat "$JCODE_HOME/ack.json" ;;
    *) exit 44 ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(root.join("jcode"), std::fs::Permissions::from_mode(0o700)).unwrap();
    (tmp, clients, all)
}

#[test]
fn selected_tabs_send_native_provider_and_reasoning_without_guessing() {
    let (tmp, _clients, all) = native_clients();
    let root = tmp.path();
    let bindings = model_catalog(&all, &selection(&all, &["a", "b", "c"]))
        .unwrap()
        .bindings;
    let outcomes = change_models(
        &all,
        &selection(&all, &["a", "c"]),
        &bindings,
        "route-oauth",
        Some("high"),
    )
    .unwrap();
    assert!(outcomes[0].error.is_none());
    assert!(
        outcomes[1]
            .error
            .as_ref()
            .unwrap()
            .contains("model unavailable")
    );
    let calls = std::fs::read_to_string(root.join("calls")).unwrap();
    assert!(!calls.contains("session_owl"));
    let request: serde_json::Value =
        serde_json::from_str(calls.lines().next().unwrap().split_once(' ').unwrap().1).unwrap();
    assert_eq!(
        request["selection"],
        native_choice("route-oauth", "oauth", &["high"])["selection"]
    );
    assert_eq!(request["reasoning_effort"], "high");
    assert_eq!(request["client_id"], "connection-session_fox_1_ab");
    change_models(
        &all,
        &selection(&all, &["a", "b", "c"]),
        &bindings,
        "route-oauth",
        Some("high"),
    )
    .unwrap();
    let before = std::fs::read_to_string(root.join("calls")).unwrap();
    assert!(before.contains("session_owl"));
    let mut selected = selection(&all, &["a", "b", "c"]);
    selected.insert("b".into(), "previous-run".into());
    selected.insert("stopped".into(), "previous-run".into());
    let mut relative = all.clone();
    for target in &mut relative {
        target.env[0].1 = ".".into();
        target.command = "./jcode".into();
    }
    let outcomes =
        change_models(&relative, &selected, &bindings, "route-oauth", Some("high")).unwrap();
    assert_eq!(outcomes.len(), 4);
    assert!(outcomes[0].error.is_none());
    assert!(
        outcomes[1]
            .error
            .as_ref()
            .unwrap()
            .contains("stopped or restarted")
    );
    assert!(
        outcomes[3]
            .error
            .as_ref()
            .unwrap()
            .contains("stopped or restarted")
    );
    let after = std::fs::read_to_string(root.join("calls")).unwrap();
    assert!(!after[before.len()..].contains("session_owl"));
    let before = after;
    for (id, effort) in [
        ("not-an-offered-route", Some("high")),
        ("route-oauth", Some("invented-level")),
        ("route-oauth", None),
    ] {
        assert!(
            change_models(&all, &selection(&all, &["a"]), &bindings, id, effort).unwrap()[0]
                .error
                .is_some()
        );
    }
    assert_eq!(std::fs::read_to_string(root.join("calls")).unwrap(), before);
}

#[test]
fn invalid_native_acknowledgements_are_reported() {
    let (tmp, _clients, all) = native_clients();
    let root = tmp.path();
    let bindings = model_catalog(&all, &selection(&all, &["a"]))
        .unwrap()
        .bindings;
    std::fs::write(root.join("ack.json"), "help").unwrap();
    assert!(
        change_models(
            &all,
            &selection(&all, &["a"]),
            &bindings,
            "route-oauth",
            Some("high")
        )
        .unwrap()[0]
            .error
            .as_ref()
            .unwrap()
            .contains("did not acknowledge")
    );
    std::fs::write(
        root.join("ack.json"),
        r#"{"id":"route-api","model":"future-model-2099","reasoning_effort":"low"}"#,
    )
    .unwrap();
    assert!(
        change_models(
            &all,
            &selection(&all, &["a"]),
            &bindings,
            "route-oauth",
            Some("high")
        )
        .unwrap()[0]
            .error
            .is_some()
    );
}

#[test]
fn catalog_preserves_routes_and_intersects_native_reasoning_levels() {
    let (tmp, _clients, all) = native_clients();
    let selected = selection(&all, &["a", "b"]);
    let mut single = native_choice("route-oauth", "oauth", &["low"]);
    single["reasoning_effort"] = "low".into();
    std::fs::write(
        tmp.path().join("session_owl_2_cd.json"),
        serde_json::json!({ "choices": [single, native_choice("route-api", "api", &[])], "client_pid": all[1].process.sid, "client_id": "connection-session_owl_2_cd", "session_id": "session_owl_2_cd" })
            .to_string(),
    )
    .unwrap();
    let choices = model_catalog(&all, &selected).unwrap().choices;
    assert_eq!(
        choices.len(),
        2,
        "same model on different providers remains two choices"
    );
    assert_eq!(choices[0].reasoning_levels.len(), 1);
    assert_eq!(choices[0].reasoning_effort.as_deref(), Some("low"));
    assert!(
        !choices[1].available,
        "incompatible reasoning ladders cannot silently fall back"
    );
    assert!(
        serde_json::to_value(&choices).unwrap()[0]
            .get("selection")
            .is_none(),
        "native routing payload stays in core"
    );
    assert!(
        !tmp.path().join("calls").exists(),
        "reading choices never changes a model"
    );
    std::fs::write(
        tmp.path().join("session_owl_2_cd.json"),
        "old jcode cannot export model-options",
    )
    .unwrap();
    assert!(
        model_catalog(&all, &selected)
            .unwrap_err()
            .to_string()
            .contains("Update jcode")
    );
}

#[test]
fn catalog_rejects_a_different_client_or_conversation_before_mutation() {
    let (tmp, _clients, all) = native_clients();
    let bindings = model_catalog(&all, &selection(&all, &["a"]))
        .unwrap()
        .bindings;
    let path = tmp.path().join("session_fox_1_ab.json");
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("client_pid", serde_json::json!(all[1].process.sid)),
        ("session_id", serde_json::json!("another-conversation")),
        ("client_id", serde_json::json!("")),
    ] {
        let mut catalog = original.clone();
        catalog[field] = value;
        std::fs::write(&path, catalog.to_string()).unwrap();
        assert!(model_catalog(&all, &selection(&all, &["a"])).is_err());
        assert!(
            change_models(
                &all,
                &selection(&all, &["a"]),
                &bindings,
                "route-oauth",
                Some("high")
            )
            .unwrap()[0]
                .error
                .is_some()
        );
        assert!(!tmp.path().join("calls").exists());
    }
}

#[test]
fn catalog_binding_survives_until_apply_and_routes_without_levels_keep_native_effort() {
    let (tmp, _clients, all) = native_clients();
    let selected = selection(&all, &["a"]);
    let snapshot = model_catalog(&all, &selected).unwrap();
    let path = tmp.path().join("session_fox_1_ab.json");
    let mut catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    catalog["client_id"] = "reconnected-client".into();
    std::fs::write(&path, catalog.to_string()).unwrap();
    assert!(model_catalog(&all, &selected).is_ok());
    let changes = change_models(
        &all,
        &selected,
        &snapshot.bindings,
        "route-oauth",
        Some("high"),
    )
    .unwrap();
    assert!(
        changes[0]
            .error
            .as_ref()
            .unwrap()
            .contains("since its choices were loaded")
    );
    assert!(!tmp.path().join("calls").exists());

    let new_session = "session_fox_2_ab";
    catalog["session_id"] = new_session.into();
    std::fs::write(
        tmp.path()
            .join("client_sessions")
            .join(all[0].process.sid.to_string()),
        new_session,
    )
    .unwrap();
    std::fs::write(
        tmp.path().join(format!("{new_session}.json")),
        catalog.to_string(),
    )
    .unwrap();
    assert!(model_catalog(&all, &selected).is_ok());
    let changes = change_models(
        &all,
        &selected,
        &snapshot.bindings,
        "route-oauth",
        Some("high"),
    )
    .unwrap();
    assert!(
        changes[0]
            .error
            .as_ref()
            .unwrap()
            .contains("since its choices were loaded")
    );
    assert!(!tmp.path().join("calls").exists());

    catalog["choices"] = serde_json::json!([native_choice("route-oauth", "oauth", &[])]);
    std::fs::write(
        tmp.path().join(format!("{new_session}.json")),
        catalog.to_string(),
    )
    .unwrap();
    let snapshot = model_catalog(&all, &selected).unwrap();
    let changes = change_models(&all, &selected, &snapshot.bindings, "route-oauth", None).unwrap();
    assert!(
        changes[0].error.is_none(),
        "native routes without a level step may retain their default effort"
    );
}

#[test]
fn invalid_input_and_stale_selection_never_launch_a_command() {
    let tmp = tempfile::tempdir().unwrap();
    let all = vec![target("a", tmp.path(), 999_999_999)];
    let bindings = BTreeMap::new();
    for id in ["", "model\nnext", "model\u{1b}"] {
        assert!(change_models(&all, &selection(&all, &["a"]), &bindings, id, None).is_err());
    }
    assert!(change_models(&all, &BTreeMap::new(), &bindings, "route", None).is_err());
    let selected = BTreeMap::from([
        ("missing".into(), "old-run".into()),
        ("a".into(), "old-run".into()),
    ]);
    let outcomes = change_models(&all, &selected, &bindings, "route", None).unwrap();
    assert!(outcomes.iter().all(|outcome| {
        outcome
            .error
            .as_ref()
            .unwrap()
            .contains("stopped or restarted")
    }));
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
    assert!(registered_client(&t, tmp.path()).is_err());
    std::fs::write(
        tmp.path().join(t.process.sid.to_string()),
        "session_fox_1_ab",
    )
    .unwrap();
    assert_eq!(
        registered_client(&t, tmp.path()).unwrap().0,
        "session_fox_1_ab"
    );
    std::fs::write(tmp.path().join(t.process.sid.to_string()), "--untrusted").unwrap();
    assert!(registered_client(&t, tmp.path()).is_err());
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
        3,
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

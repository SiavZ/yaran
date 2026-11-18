//! Adversarial review (fifth pass): see the test.
//! Derived from the second pass: an editor write holds its editor ROOT,
//! never the path it writes. A terminal's editor is rooted at the folder the
//! terminal started in, and that folder can contain an agent's worktree (a
//! standalone terminal starts in the home folder, which holds yaran's worktrees
//! root by default; a project terminal starts at the repository root, which
//! holds any worktree kept inside the repository, such as `.worktrees/`). A
//! write through such an editor into a worktree whose removal has begun is
//! neither refused nor waited for, and a folder created there after git
//! removed the worktree brings the worktree's folder back.

use std::net::SocketAddr;

use axum::Router;
use yaran_core::config::{ProjectConfig, YaranPaths};
use yaran_core::storage::SessionStore;
use yaran_web::bootstrap::bootstrap_engine;
use yaran_web::engine_actor::spawn_engine_thread;
use yaran_web::server::{AppState, RouterParams, build_app};

fn session(id: &str, worktree: &str) -> yaran_core::model::AgentSession {
    let n = jiff::Timestamp::now();
    yaran_core::model::AgentSession {
        id: id.to_string(),
        agent_handle: yaran_core::model::normalize_agent_handle(id),
        shared_workspace: false,
        deleted_at: None,
        slot_tab_id: format!("{id}-slot"),
        provider: yaran_core::model::ProviderKind::new("claude"),
        title: None,
        started_providers: Vec::new(),
        desired_running: true,
        auto_reopen_enabled: false,
        status: yaran_core::model::SessionStatus::Detached,
        created_at: n,
        updated_at: n,
        last_focused_tab: None,
        workspace: yaran_core::model::AgentWorkspace::Managed(
            yaran_core::model::ManagedWorkspace {
                project_id: "p1".to_string(),
                project_path: None,
                source_branch: "main".to_string(),
                branch_name: "agent".to_string(),
                initial_branch: "agent".to_string(),
                branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                worktree_path: worktree.to_string(),
            },
        ),
    }
}

struct Fixture {
    _tmp: yaran_core::test_scratch::ScratchDir,
    worktree: std::path::PathBuf,
    repo: std::path::PathBuf,
    client: reqwest::Client,
    prefix: String,
}

async fn fixture() -> Fixture {
    let tmp = yaran_core::test_scratch::ScratchDir::new();
    let root = tmp.path().to_path_buf();
    let repo = root.join("repo");
    let worktree = repo.join(".worktrees").join("agent");
    std::fs::create_dir_all(&worktree).expect("create the test directory");
    std::fs::write(worktree.join("a.txt"), "a\n").expect("write the test file");
    let paths = YaranPaths {
        root: root.clone(),
        config_path: root.join("config.toml"),
        sessions_db_path: root.join("sessions.sqlite3"),
        worktrees_root: root.join("worktrees"),
        lock_path: root.join("dux.lock"),
        socket_path: root.join("yaran.sock"),
    };
    std::fs::create_dir_all(&paths.worktrees_root).expect("create the test directory");
    {
        let store = SessionStore::open(&paths.sessions_db_path).expect("open the session store");
        store
            .upsert_project(&ProjectConfig {
                id: "p1".to_string(),
                path: repo.to_string_lossy().into_owned(),
                name: Some("p1".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: std::collections::BTreeMap::new(),
                workspace_mode: None,
            })
            .expect("save the test project");
        store
            .create_session(&session("s1", worktree.to_string_lossy().as_ref()))
            .expect("save the test agent");
    }
    let mut engine = bootstrap_engine(&paths).expect("bootstrap the test engine");
    yaran_core::test_provider::defuse_config(&mut engine.config);
    engine.config.terminal.command = "cat".to_string();
    engine.config.terminal.args = vec![];
    let _ops = engine.worktree_ops().clone();
    let (handle, _join) = spawn_engine_thread(engine);
    let app = build_app(
        handle,
        Router::<AppState>::new(),
        RouterParams::plain_http(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a loopback port");
    let addr: SocketAddr = listener.local_addr().expect("read the bound address");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve the test router");
    });
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/api/v1/projects/p1/terminals"))
        .send()
        .await
        .expect("send the request");
    assert_eq!(resp.status(), 201);
    let body: serde_json::Value = resp.json().await.expect("the response body is JSON");
    let tid = body["terminal_id"]
        .as_str()
        .expect("the response names the terminal")
        .to_string();
    let prefix = format!("http://{addr}/api/v1/projects/p1/terminals/{tid}/files");

    Fixture {
        _tmp: tmp,
        worktree,
        repo,
        client,
        prefix,
    }
}

#[tokio::test]
async fn a_terminal_editor_does_not_delete_a_live_agents_worktree() {
    let Fixture {
        _tmp,
        worktree,
        client,
        prefix,
        ..
    } = fixture().await;
    // Nothing is being removed. The user deletes the folder `.worktrees/agent`
    // from the project terminal's file tree: that folder IS agent s1's
    // worktree, and the agent record is the first occupant the one occupancy
    // question names. Nothing asks it.
    let resp = client
        .post(format!("{prefix}/delete"))
        .json(&serde_json::json!({ "path": ".worktrees/agent" }))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    assert!(
        worktree.exists(),
        "the project terminal's editor deleted {} (answered {status}), the worktree of agent \
         s1, which is still in the sidebar; no occupancy check stood in the way",
        worktree.display()
    );
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    let text = resp.text().await.unwrap();
    assert!(
        text.contains("did not delete"),
        "the refusal names what it did not do: {text}"
    );
}

#[tokio::test]
async fn a_terminal_editor_does_not_move_a_live_agents_worktree() {
    let Fixture {
        _tmp,
        worktree,
        repo,
        client,
        prefix,
    } = fixture().await;
    // Moving the worktree away removes it from under the agent just as much
    // as deleting it.
    let resp = client
        .post(format!("{prefix}/rename"))
        .json(&serde_json::json!({ "from": ".worktrees/agent", "to": "moved" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);
    let text = resp.text().await.unwrap();
    assert!(text.contains("did not move"), "{text}");
    assert!(worktree.exists() && !repo.join("moved").exists());

    // Writing INTO a live worktree is ordinary editing, not a removal of
    // anything that lives there, so a move whose ends hold nothing still
    // works.
    std::fs::write(repo.join("loose.txt"), "x\n").unwrap();
    // An ordinary move outside any occupied folder still works.
    let resp = client
        .post(format!("{prefix}/rename"))
        .json(&serde_json::json!({ "from": "loose.txt", "to": "free.txt" }))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    assert!(
        status.is_success(),
        "{status}: {}",
        resp.text().await.unwrap()
    );
    assert!(repo.join("free.txt").exists());
}

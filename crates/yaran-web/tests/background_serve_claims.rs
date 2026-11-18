//! Switching the background server on from the terminal UI, seen from a browser.
//!
//! A start somebody at the terminal UI's keyboard asked for claims every running
//! pty for the terminal UI BEFORE any listener accepts a connection. This drives
//! that for real: a real engine with a running agent and a running terminal, a
//! real `BackgroundServer` on a loopback port serviced the way the terminal UI's
//! run loop services it, and a real browser on the pty sockets.
//!
//! What is not real is the terminal UI itself: `yaran-tui` cannot be linked into a
//! `yaran-web` test (the web layer never sees the terminal UI), so the flag it
//! passes for such a start is passed here by hand. Its own tests cover which
//! starts pass it.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use yaran_core::background_serve::TUI_DEVICE_LABEL;
use yaran_core::config::{ProjectConfig, YaranPaths};
use yaran_core::engine::Engine;
use yaran_core::ids::{TabId, TabIdRef};
use yaran_core::storage::SessionStore;
use yaran_web::background::BackgroundServer;
use yaran_web::bootstrap::bootstrap_engine;

type ClientWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn sample_session(id: &str, worktree: &str) -> yaran_core::model::AgentSession {
    let now = jiff::Timestamp::now();
    yaran_core::model::AgentSession {
        id: id.to_string(),
        slot_tab_id: format!("{id}-slot"),
        provider: yaran_core::model::ProviderKind::new("claude"),
        title: Some(format!("{id}-title")),
        started_providers: Vec::new(),
        desired_running: true,
        auto_reopen_enabled: false,
        status: yaran_core::model::SessionStatus::Active,
        created_at: now,
        updated_at: now,
        last_focused_tab: None,
        workspace: yaran_core::model::AgentWorkspace::Managed(
            yaran_core::model::ManagedWorkspace {
                project_id: "p1".to_string(),
                project_path: None,
                source_branch: "main".to_string(),
                branch_name: "feat".to_string(),
                initial_branch: "feat".to_string(),
                branch_provenance: yaran_core::model::BranchProvenance::CreatedByYaran,
                worktree_path: worktree.to_string(),
            },
        ),
        // Worktree mode, no AMQ identity: this fixture only drives the claim
        // handshake, and a default handle keeps it representative of a row the
        // engine itself would persist.
        agent_handle: yaran_core::model::derive_agent_handle(worktree, "feat", id),
        shared_workspace: false,
        deleted_at: None,
    }
}

/// An engine with agent `s1` running (`cat`, so typing echoes) and a standalone
/// terminal running, in the state the terminal UI leaves it in before serving:
/// its global workers already up.
fn engine_with_an_agent_and_a_terminal_running()
-> (Engine, String, yaran_core::test_scratch::ScratchDir) {
    let tmp = yaran_core::test_scratch::ScratchDir::new();
    let root = tmp.path().to_path_buf();
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
                path: root.to_string_lossy().into_owned(),
                name: Some("p1-name".to_string()),
                default_provider: None,
                leading_branch: None,
                auto_reopen_agents: None,
                startup_command: None,
                env: std::collections::BTreeMap::new(),
                workspace_mode: None,
            })
            .expect("save the test project");
        store
            .create_session(&sample_session("s1", root.to_string_lossy().as_ref()))
            .expect("save the test agent");
    }
    let mut engine = bootstrap_engine(&paths).expect("bootstrap the test engine");
    yaran_core::test_provider::defuse_config(&mut engine.config);
    engine
        .changed_files_poller_started
        .store(true, std::sync::atomic::Ordering::Relaxed);
    engine.providers.insert(
        TabId::new("s1-slot"),
        yaran_core::pty::PtyClient::spawn("cat", &[], &root, 24, 80, 1000).expect("spawn cat"),
    );
    engine.config.terminal.command = "cat".to_string();
    engine.config.terminal.args = vec![];
    let (terminal, _) = engine
        .create_standalone_terminal(24, 80)
        .expect("standalone terminal");
    (engine, terminal, tmp)
}

/// What the browser thread asks the thread holding the engine to do.
enum Ask {
    /// Type `bytes` into the agent from the terminal UI's seat.
    TuiTypes(&'static [u8]),
}

async fn next_event_frame(
    ws: &mut ClientWs,
    event: &str,
    within: Duration,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + within;
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(Message::Text(t)))) =
            tokio::time::timeout(Duration::from_millis(200), ws.next()).await
            && let Ok(v) = serde_json::from_str::<serde_json::Value>(&t)
            && v["event"].as_str() == Some(event)
        {
            return Some(v);
        }
    }
    None
}

async fn accumulate_until(ws: &mut ClientWs, needle: &str, within: Duration) -> String {
    let mut acc = Vec::new();
    let deadline = tokio::time::Instant::now() + within;
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(m))) = tokio::time::timeout(Duration::from_millis(200), ws.next()).await {
            if let Message::Binary(b) = m {
                acc.extend_from_slice(&b);
            }
            if String::from_utf8_lossy(&acc).contains(needle) {
                break;
            }
        }
    }
    String::from_utf8_lossy(&acc).into_owned()
}

/// Open a pty socket and read its `connected` handshake.
async fn attach(url: &str) -> (ClientWs, serde_json::Value) {
    let (mut pty, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect the pty socket");
    let hello = next_event_frame(&mut pty, "connected", Duration::from_secs(8))
        .await
        .expect("the pty handshake");
    (pty, hello)
}

/// Start a serve over `engine` on a fresh loopback port.
fn serve(
    engine: &mut Engine,
    claims: yaran_core::background_serve::ServeClaims,
) -> (BackgroundServer, std::net::SocketAddr) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind");
    let addr = listener.local_addr().expect("bound address");
    // Not a test about Tailscale: on any other mode every request waits on the
    // first Funnel check, which would consult this machine's real CLI.
    engine.config.server.tailscale = "no".to_string();
    let server = BackgroundServer::start(
        engine,
        vec![listener],
        vec![format!("http://{addr}")],
        claims,
        &yaran_core::serve_log::StartupNotes::default(),
    )
    .expect("the serve starts");
    (server, addr)
}

/// Service the serve the way the terminal UI's run loop does until `browser`
/// finishes, acting on what it asks for in between, and re-raise its panic.
fn run_browser(
    engine: &mut Engine,
    server: &mut BackgroundServer,
    browser: std::thread::JoinHandle<()>,
    asks: &mpsc::Receiver<Ask>,
) {
    let seat = server
        .ownership()
        .expect("a web serve gives the terminal UI a seat");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !browser.is_finished() {
        assert!(
            Instant::now() < deadline,
            "the journey did not finish in time"
        );
        server.service(engine);
        match asks.try_recv() {
            Ok(Ask::TuiTypes(bytes)) => {
                let client = engine
                    .providers
                    .get(TabIdRef::new("s1-slot"))
                    .expect("the agent is running");
                let verdict = seat.owners.note_write(
                    "s1-slot",
                    seat.conn_id,
                    yaran_core::pty::classify_pty_write(bytes),
                    Some(TUI_DEVICE_LABEL),
                    |_| {},
                );
                assert!(verdict.forward, "the terminal UI types into its agent");
                client.enqueue_bytes(bytes);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    if let Err(panic) = browser.join() {
        std::panic::resume_unwind(panic);
    }
}

/// Run a browser's journey on its own thread and runtime, because the engine
/// is `!Send` and stays on the test thread.
fn on_its_own_runtime<F: std::future::Future<Output = ()> + Send + 'static>(
    journey: F,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("browser runtime")
            .block_on(journey);
    })
}

/// The browser's half of the journey. It connects the moment the serve is up,
/// with nothing to wait for.
async fn browser(
    addr: std::net::SocketAddr,
    terminal: String,
    tui_conn: u64,
    ask: mpsc::Sender<Ask>,
) {
    let tui = tui_conn.to_string();

    // The terminal: its handshake already names the terminal UI.
    let (_terminal_pty, hello) = attach(&format!("ws://{addr}/ws/terminals/{terminal}/pty")).await;
    assert_eq!(hello["owner"].as_str(), Some(tui.as_str()), "{hello}");
    assert_eq!(hello["owner_device"].as_str(), Some(TUI_DEVICE_LABEL));

    // The agent: the same.
    let (mut pty, hello) = attach(&format!("ws://{addr}/ws/sessions/s1/pty")).await;
    assert_eq!(hello["owner"].as_str(), Some(tui.as_str()), "{hello}");
    assert_eq!(hello["owner_device"].as_str(), Some(TUI_DEVICE_LABEL));

    // The terminal UI keeps typing into it, and the browser watches it arrive.
    ask.send(Ask::TuiTypes(b"yaran-tui-still-types\n"))
        .expect("the terminal UI thread is listening");
    let seen = accumulate_until(&mut pty, "yaran-tui-still-types", Duration::from_secs(8)).await;
    assert!(seen.contains("yaran-tui-still-types"), "{seen:?}");

    // A plain attach resize is recorded and moves nothing; the browser's
    // typing reaches the agent and moves its size to the browser.
    pty.send(Message::Text(r#"{"rows":30,"cols":100}"#.into()))
        .await
        .expect("send the resize frame");
    pty.send(Message::Binary(b"yaran-browser-types\n".to_vec().into()))
        .await
        .expect("send the typed bytes");
    let typed = accumulate_until(&mut pty, "yaran-browser-types", Duration::from_secs(8)).await;
    assert!(
        typed.contains("yaran-browser-types"),
        "every attached device may type: {typed:?}"
    );
}

/// THE JOURNEY. The user has an agent and a terminal running in the terminal
/// UI and switches serving on. Both are the terminal UI's the moment the serve
/// is up, before any browser has connected. A browser that opens is told the
/// terminal UI holds both, sees the terminal UI's typing arrive, does not move
/// the size by merely attaching, and does by typing.
#[test]
fn a_browser_finds_everything_sized_by_the_tui_until_it_types() {
    let (mut engine, terminal, _tmp) = engine_with_an_agent_and_a_terminal_running();
    let (mut server, addr) = serve(
        &mut engine,
        yaran_core::background_serve::ServeClaims::UndrivenPtys,
    );
    let seat = server
        .ownership()
        .expect("a web serve gives the terminal UI a seat");

    // Before anything has connected, and before the run loop has turned once.
    assert!(seat.owners.is_owner("s1-slot", seat.conn_id));
    assert!(seat.owners.is_owner(&terminal, seat.conn_id));
    assert_eq!(
        seat.owners.current_owner("s1-slot").2.as_deref(),
        Some(TUI_DEVICE_LABEL)
    );

    let (ask_tx, ask_rx) = mpsc::channel();
    let journey = browser(addr, terminal.clone(), seat.conn_id, ask_tx);
    run_browser(
        &mut engine,
        &mut server,
        on_its_own_runtime(journey),
        &ask_rx,
    );

    let still_mine = seat.owners.is_owner("s1-slot", seat.conn_id);
    let terminal_mine = seat.owners.is_owner(&terminal, seat.conn_id);
    server.stop();
    assert!(!still_mine, "typing moved the agent's size to the browser");
    assert!(
        terminal_mine,
        "and left the terminal it never touched with the TUI"
    );
}

/// The startup autostart asks for no claim, so everything running is free the
/// moment the serve is up and the first browser's handshake says nobody drives
/// it.
#[test]
fn a_serve_started_without_the_claim_leaves_everything_free() {
    let (mut engine, terminal, _tmp) = engine_with_an_agent_and_a_terminal_running();
    let (mut server, addr) = serve(
        &mut engine,
        yaran_core::background_serve::ServeClaims::Nothing,
    );
    let seat = server
        .ownership()
        .expect("a web serve gives the terminal UI a seat");

    assert_eq!(seat.owners.current_owner("s1-slot").0, None);
    assert_eq!(seat.owners.current_owner(&terminal).0, None);

    let (_ask_tx, ask_rx) = mpsc::channel();
    let journey = async move {
        let (_pty, hello) = attach(&format!("ws://{addr}/ws/sessions/s1/pty")).await;
        assert_eq!(hello["owner"], serde_json::Value::Null, "{hello}");
    };
    run_browser(
        &mut engine,
        &mut server,
        on_its_own_runtime(journey),
        &ask_rx,
    );
    server.stop();
}

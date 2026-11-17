//! The journeys that work today, with no password anywhere: they prove the
//! harness itself (the container, the three kinds of client, the sockets, the
//! sidecars and the browser) before any login journey leans on it.

use std::net::Ipv4Addr;
use std::time::Duration;

use yaran_journeys::api::{add_demo_project, create_agent, projects, session_id};
use yaran_journeys::browser::{Browser, WEBDRIVER_PORT};
use yaran_journeys::container::published_bindings;
use yaran_journeys::image::JourneyNetwork;
use yaran_journeys::sidecars::{
    PROXY_PORT, SERVE_PORT, Sidecar, held_issuance_lock, serve_and_proxy_caddyfile,
    serve_and_proxy_sites, serve_client,
};
use yaran_journeys::util::suffix;
use yaran_journeys::ws::connect_ok;
use yaran_journeys::{
    Client, TAILNET_IP, TAILNET_NAME, TAILNET_PEER_IP, YARAN_PORT, Yaran, YaranOptions, eventually,
    journey,
};

/// Whether `address` is in Tailscale's CGNAT range (100.64.0.0/10).
fn is_tailnet(address: &str) -> bool {
    address
        .parse::<Ipv4Addr>()
        .is_ok_and(|ip| ip.octets()[0] == 100 && (ip.octets()[1] & 0xC0) == 64)
}

/// Assert that yaran, right now, holds a connection from `peer` on `local`.
async fn assert_yaran_sees(yaran: &Yaran, local: Option<&str>, peer: &str, what: &str) {
    let seen = yaran.observed_peers().await;
    assert!(
        seen.iter()
            .any(|(l, p)| p == peer && local.is_none_or(|local| l == local)),
        "{what}: yaran should hold a connection from {peer}; it holds {seen:?}"
    );
}

/// Situation: a fresh `yaran server` with no password, reachable from the
/// network, with the fake provider configured and a demo repository on disk.
///
/// Task: a person on another machine wants to see yaran is alive, add their
/// repository, start an agent on it and talk to that agent.
///
/// Action: check `/healthz`; list projects (none yet); add the demo repository
/// as a project on the fake provider; create an agent; open the agent's
/// terminal socket, claim it, type `hello` and Enter; while it is open, look at
/// the connection from yaran's side; then close the socket.
///
/// Result: `/healthz` says ok; the project list grows from empty to the demo
/// project; the agent appears with a tab; the terminal shows the fake agent
/// answering `you typed hello`, which proves the keystrokes reached the process
/// and its output came back; yaran holds that connection from the host's address
/// as the container sees it, which is neither loopback nor a tailnet address,
/// so every journey using this client really is a client from the network; and
/// the socket closes cleanly.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_add_a_project_start_an_agent_and_say_hello() {
    journey("smoke", Duration::from_secs(240), async {
        let yaran =
            Yaran::start(YaranOptions::exposed().with_env("YARAN_FAKE_FIXTURE", "quit-on-command"))
                .await;
        let client = yaran.client().await;

        let health = client.get("/healthz").await;
        assert_eq!(health.status, 200, "{}", health.describe());
        assert_eq!(health.body.trim(), "ok");

        assert!(
            projects(&client).await.is_empty(),
            "a fresh yaran starts with no projects"
        );
        let project = add_demo_project(&client).await;
        let listed = projects(&client).await;
        assert!(
            listed
                .iter()
                .any(|p| p["id"].as_str() == Some(project.as_str())),
            "the new project is listed: {listed:?}"
        );

        let name = format!("smoke-{}", suffix());
        let session = create_agent(&client, &project, &name).await;
        let id = session_id(&session);

        let mut pty = connect_ok(&client, &format!("/ws/sessions/{id}/pty")).await;
        let hello = pty
            .next_event("connected", Duration::from_secs(20))
            .await
            .expect("the PTY socket says it is connected");
        assert!(
            hello["id"].is_string(),
            "the handshake names this connection: {hello}"
        );
        pty.claim(24, 80).await;
        assert!(
            pty.read_until("type \"quit\"", Duration::from_secs(20))
                .await,
            "the fake agent greets the terminal; got {:?}",
            pty.output_text()
        );
        pty.send_bytes(b"hello\r").await;
        assert!(
            pty.read_until("you typed hello", Duration::from_secs(20))
                .await,
            "the agent answers what was typed; got {:?}",
            pty.output_text()
        );

        let host = yaran.host_client_address().await;
        let host_ip: Ipv4Addr = host.parse().expect("an IPv4 gateway address");
        assert!(!host_ip.is_loopback() && !is_tailnet(&host), "{host}");
        assert_yaran_sees(&yaran, None, &host, "the host's open terminal socket").await;
        pty.close().await;
    })
    .await;
}

/// Situation: a yaran with relays, a published sidecar port and a browser on a
/// journey network, all started the way every journey starts them.
///
/// Task: nothing a journey starts may be reachable from beyond this machine:
/// yaran has no password in most journeys, and chromedriver obeys anyone who can
/// reach it.
///
/// Action: read every port binding Docker reports for the yaran container and the
/// browser container.
///
/// Result: every published port is bound to `127.0.0.1` on the host (none on
/// `0.0.0.0` or `::`), and each container publishes exactly the ports asked of it.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_every_published_port_binds_the_hosts_loopback_only() {
    journey("smoke-loopback-ports", Duration::from_secs(240), async {
        let network = JourneyNetwork::create();
        let yaran = Yaran::start(
            YaranOptions::exposed()
                .with_network(&network)
                .with_tailnet(4100)
                .with_loopback_relay(4200)
                .with_published(8080),
        )
        .await;
        let browser = Browser::on_network(&network).await;

        for (what, bindings, expected) in [
            (
                "the yaran container",
                yaran.published_bindings().await,
                vec!["3890/tcp", "4100/tcp", "4200/tcp", "8080/tcp"],
            ),
            (
                "the browser container",
                published_bindings(browser.container_id()).await,
                vec!["4444/tcp"],
            ),
        ] {
            let mut ports: Vec<&str> = bindings.iter().map(|(p, _, _)| p.as_str()).collect();
            ports.sort_unstable();
            ports.dedup();
            assert_eq!(
                ports, expected,
                "{what} publishes exactly these: {bindings:?}"
            );
            for (port, host_ip, host_port) in &bindings {
                assert_eq!(
                    host_ip, "127.0.0.1",
                    "{what} publishes {port} beyond loopback: {bindings:?}"
                );
                assert!(!host_port.is_empty(), "{what}: {port} has a host port");
            }
        }
        browser.quit().await;
    })
    .await;
}

/// Situation: a `yaran server` listening the way an unconfigured one does
/// (loopback, plus the Tailscale leg), on a machine where the stand-in
/// `tailscale` reports a tailnet address, with one port relayed onto that
/// address from a tailnet peer's own address and one relayed onto loopback.
///
/// Task: the harness has to be able to reach yaran as this machine, as a tailnet
/// peer, and through a headerless forward, before any journey can ask how yaran
/// treats each of them.
///
/// Action: ask `/healthz` from inside the container on loopback, through the
/// tailnet relay, and through the loopback relay; open the events socket
/// through each relay and look at those connections from yaran's side.
///
/// Result: all three answer `ok`; yaran holds the tailnet connection on its
/// Tailscale listener from the peer's address (a tailnet address that is not
/// its own), and the relayed one on loopback from loopback; and the events
/// socket stays open.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_this_machine_tailnet_and_relay_clients_all_reach_yaran() {
    journey("smoke-reach", Duration::from_secs(180), async {
        let yaran = Yaran::start(
            YaranOptions::local()
                .with_tailnet(4100)
                .with_loopback_relay(4200),
        )
        .await;

        let inside = yaran.inside().get("/healthz").await;
        assert_eq!((inside.status, inside.body.trim()), (200, "ok"));

        let tailnet = yaran.client_on(4100).await;
        tailnet.wait_answering().await;
        let relay = yaran.client_on(4200).await;
        let relayed = relay.get("/healthz").await;
        assert_eq!((relayed.status, relayed.body.trim()), (200, "ok"));

        let mut from_tailnet = connect_ok(&tailnet, "/ws/events").await;
        assert_yaran_sees(
            &yaran,
            Some(TAILNET_IP),
            TAILNET_PEER_IP,
            "the tailnet peer",
        )
        .await;
        assert_ne!(TAILNET_PEER_IP, TAILNET_IP);
        let from_relay = connect_ok(&relay, "/ws/events").await;
        assert_yaran_sees(&yaran, Some("127.0.0.1"), "127.0.0.1", "the loopback relay").await;

        assert_eq!(
            from_tailnet.hold_open(Duration::from_secs(3)).await,
            None,
            "the events socket stays open"
        );
        from_tailnet.close().await;
        from_relay.close().await;
    })
    .await;
}

fn nginx_conf() -> String {
    format!(
        "server {{\n  listen 8080;\n  location / {{\n    proxy_pass http://127.0.0.1:{YARAN_PORT};\n    proxy_set_header Host $http_host;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n  }}\n}}\n"
    )
}

/// Situation: yaran on loopback with a stand-in Tailscale, and nginx and Caddy
/// beside it (sharing its network namespace, as a proxy on the same machine
/// does): nginx on plain HTTP, Caddy terminating TLS both as the stand-in for a
/// `tailscale serve` route on this machine's tailnet name and as an ordinary
/// HTTPS proxy.
///
/// Task: the proxy journeys need every proxy to really carry requests to yaran,
/// and the serve stand-in to deliver the tailnet name yaran's Host guard admits.
///
/// Action: ask `/healthz` through nginx, through the serve stand-in as a
/// browser at `https://<tailnet name>/` would, and through the ordinary proxy.
///
/// Result: all three answer `ok` (so yaran admitted the forwarded tailnet name).
#[tokio::test(flavor = "multi_thread")]
async fn smoke_nginx_and_caddy_carry_requests_to_yaran() {
    journey("smoke-proxies", Duration::from_secs(240), async {
        let yaran = Yaran::start(
            YaranOptions::local()
                .with_tailnet(4100)
                .with_published(8080)
                .with_published(SERVE_PORT)
                .with_published(PROXY_PORT),
        )
        .await;
        yaran.client_on(4100).await.wait_answering().await;
        let _nginx = Sidecar::nginx(&yaran, &nginx_conf(), &[8080]).await;
        let caddy = Sidecar::caddy(
            &yaran,
            &serve_and_proxy_caddyfile(),
            &serve_and_proxy_sites(),
        )
        .await;
        let root = caddy.caddy_root().await;

        let plain = yaran.client_on(8080).await.get("/healthz").await;
        assert_eq!((plain.status, plain.body.trim()), (200, "ok"));

        let served = serve_client(&yaran, &root).await;
        let through_serve = eventually(
            "yaran to admit its own tailnet name",
            Duration::from_secs(30),
            || async {
                let answer = served.get("/healthz").await;
                (answer.status == 200).then_some(answer)
            },
        )
        .await;
        assert_eq!(through_serve.body.trim(), "ok");

        let port = yaran.host_port(PROXY_PORT).await;
        let tls = Client::with_root(&format!("https://127.0.0.1:{port}"), &root)
            .get("/healthz")
            .await;
        assert_eq!((tls.status, tls.body.trim()), (200, "ok"));
    })
    .await;
}

/// Situation: yaran on loopback and Caddy beside it, with Caddy's storage
/// holding a fresh lock on issuing the serve stand-in's certificate, so Caddy
/// listens, and has its authority's root, seconds before it can complete a
/// handshake for that name. A loaded machine opens the same window by
/// accident, which is how journey 08 once got "no response" from Caddy.
///
/// Task: a journey must be able to use a Caddy sidecar the moment the harness
/// hands it over.
///
/// Action: start Caddy, then send one request through the serve stand-in.
///
/// Result: the very first request gets an answer.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_caddy_is_ready_only_once_its_sites_handshake() {
    journey("smoke-caddy-ready", Duration::from_secs(240), async {
        let yaran = Yaran::start(
            YaranOptions::local()
                .with_tailnet(4100)
                .with_published(SERVE_PORT)
                .with_published(PROXY_PORT),
        )
        .await;
        yaran.client_on(4100).await.wait_answering().await;
        let caddy = Sidecar::caddy_with(
            &yaran,
            &serve_and_proxy_caddyfile(),
            &serve_and_proxy_sites(),
            &[held_issuance_lock(TAILNET_NAME)],
        )
        .await;
        let root = caddy.caddy_root().await;
        // Any answer at all: a handshake in the window gets none (the client
        // panics with the TLS alert), and whether yaran admits the tailnet name
        // yet is another journey's question.
        serve_client(&yaran, &root).await.get("/healthz").await;
    })
    .await;
}

/// Situation: no password anywhere; one yaran exposed on a journey network with a
/// browser container on the same network, and one yaran on loopback with a
/// browser in its own network namespace.
///
/// Task: the browser journeys need a real browser that loads yaran's web UI both
/// from another machine and from this one.
///
/// Action: open yaran's address in each Chromium.
///
/// Result: both pages load yaran's single-page app (its root element renders).
#[tokio::test(flavor = "multi_thread")]
async fn smoke_a_browser_loads_the_web_ui_from_the_network_and_this_machine() {
    // Boxed: the yaranes and browsers it holds across awaits make a large future.
    journey(
        "smoke-browser",
        Duration::from_secs(300),
        Box::pin(async {
            let network = JourneyNetwork::create();
            let yaran = Yaran::start(YaranOptions::exposed().with_network(&network)).await;
            let browser = Browser::on_network(&network).await;
            let address = yaran.address().await;
            browser
                .goto(&format!("http://{address}:{YARAN_PORT}/"))
                .await;
            browser.wait_for("#root > *", "the web UI's root").await;
            browser.quit().await;

            let local = Yaran::start(YaranOptions::local().with_published(WEBDRIVER_PORT)).await;
            let browser = Browser::beside(&local).await;
            browser
                .goto(&format!("http://127.0.0.1:{YARAN_PORT}/"))
                .await;
            browser
                .wait_for("#root > *", "the web UI's root on loopback")
                .await;
            browser.quit().await;
        }),
    )
    .await;
}

/// What only yaran's terminal UI draws: the agent list's frame title.
pub(crate) const TUI_MARKER: &str = "Agents & Terminals";

/// Situation: yaran served from the terminal UI, the two ways a TUI serves:
/// `[server] serve_while_tui = true`, and the `start-web-server` palette
/// command (the flip).
///
/// Task: the serving-mode journeys need both TUI modes to really serve, on the
/// port every relay and published port points at.
///
/// Action: start the TUI with `serve_while_tui` on and ask `/healthz` from this
/// machine; start a second TUI, check it serves nothing, run `start-web-server`
/// from its palette, and ask `/healthz` again; read what each listens on.
///
/// Result: both answer `ok`, and both listen on `127.0.0.1:3890`, the port the
/// harness publishes and relays to.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_both_terminal_ui_serving_modes_serve() {
    journey("smoke-tui-modes", Duration::from_secs(300), async {
        let background = Yaran::start(
            YaranOptions::local()
                .with_tui()
                // A hand edit rather than `yaran config set`: this journey has
                // to pass before that command exists.
                .with_hook(
                    "set -e\n\
                     sed -i 's/^serve_while_tui = false$/serve_while_tui = true/' \"$YARAN_HOME/config.toml\"\n\
                     grep -q '^serve_while_tui = true$' \"$YARAN_HOME/config.toml\"\n",
                ),
        )
        .await;
        background.wait_for_screen(TUI_MARKER, Duration::from_secs(30)).await;
        background.wait_healthy().await;

        let flip = Yaran::start(YaranOptions::local().with_tui()).await;
        flip.wait_for_screen(TUI_MARKER, Duration::from_secs(30)).await;
        assert!(
            !flip.answers_healthz().await,
            "the terminal UI serves nothing until it is asked to"
        );
        start_web_server(&flip).await;
        flip.wait_healthy().await;

        let expected = format!("127.0.0.1:{YARAN_PORT}");
        for (mode, yaran) in [("serve_while_tui", &background), ("the flip", &flip)] {
            let listening = yaran.listening().await;
            assert!(
                listening.contains(&expected),
                "{mode} serves on {expected}, the published port: {listening:?}"
            );
        }
    })
    .await;
}

/// Run `start-web-server` from the terminal UI's command palette.
pub(crate) async fn start_web_server(yaran: &Yaran) {
    yaran
        .wait_for_screen(TUI_MARKER, Duration::from_secs(30))
        .await;
    yaran.tmux_keys(&["C-p"]).await;
    yaran
        .wait_for_screen("Command Palette", Duration::from_secs(15))
        .await;
    // The text and the Enter reach the palette in order through one PTY, and
    // the palette filters when it handles the Enter.
    yaran.tmux_type("start-web-server").await;
    yaran.tmux_keys(&["Enter"]).await;
}

/// Situation: `yaran server` reachable from the network, run under the restart
/// loop, with one project added.
///
/// Task: the restart journeys need to stop yaran inside its container, briefly
/// and for a chosen stretch, and get a new run back behind the same port with
/// the same state.
///
/// Action: restart the yaran process; list projects; stop it for three seconds;
/// list projects again.
///
/// Result: each time a new yaran process answers on the same published port and
/// the project is still listed.
#[tokio::test(flavor = "multi_thread")]
async fn smoke_yaran_restarts_behind_the_same_port_with_the_same_state() {
    journey("smoke-restart", Duration::from_secs(180), async {
        let yaran = Yaran::start(YaranOptions::exposed().with_restart_loop()).await;
        let client = yaran.client().await;
        let project = add_demo_project(&client).await;
        let listed = |list: Vec<serde_json::Value>| {
            list.iter()
                .any(|p| p["id"].as_str() == Some(project.as_str()))
        };

        let first = yaran.yaran_pid().await.expect("yaran is running");
        yaran.restart_process().await;
        let second = yaran.yaran_pid().await.expect("yaran is running again");
        assert_ne!(first, second, "a new yaran process");
        assert!(
            listed(projects(&client).await),
            "the project survives a restart"
        );

        yaran.stop_process_for(Duration::from_secs(3)).await;
        assert!(
            listed(projects(&client).await),
            "the project survives an outage"
        );
    })
    .await;
}

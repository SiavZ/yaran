//! Integration tests for the cloud ingress (Phase 11 §2, §3, §5, §6), driven through
//! `build_app` with a fixture JWKS source.
//!
//! - Test-only (`#[cfg(test)]`); never touches the network beyond loopback.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_ingress_tests.rs
//! ├── cloud_ingress
//! ├── cloud_test_support
//! ├── yaran-core::cloud::access_jwt
//! └── yaran-core::cloud::protocol
//! External: axum, futures_util, std, tokio, tokio_tungstenite
//!
//! Used by:
//! cloud_ingress_tests.rs
//! └── crate
//! <module-headers:end>

use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use yaran_core::cloud::access_jwt::AccessRejection;
use yaran_core::cloud::protocol::RefusalCode;

use crate::cloud_ingress::{BindRefusal, CloudBindingInput, CloudIngress, IngressSettings};
use crate::cloud_test_support::*;

async fn get(h: &Harness, uri: &str, host: &str, jwt: Option<&str>) -> Response<Body> {
    send(
        &h.app,
        request("GET", uri, host, jwt).body(Body::empty()).unwrap(),
    )
    .await
}

#[tokio::test]
async fn a_cloud_request_without_an_assertion_is_refused() {
    let h = harness();
    let r = get(&h, "/healthz", HOST, None).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(refusal(&r), Some("access-missing"));
    assert_eq!(r.headers()["cache-control"], "no-store");
}

#[tokio::test]
async fn a_valid_owner_token_reaches_every_route() {
    let h = harness();
    let valid = token("valid");
    for uri in ["/healthz", "/api/v1/build"] {
        assert_eq!(
            get(&h, uri, HOST, Some(&valid)).await.status(),
            StatusCode::OK,
            "{uri}"
        );
    }
    let post = request("POST", "/probe", HOST, Some(&valid))
        .header("Origin", "https://Laptop-Ada.example.com")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&h.app, post).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn each_bad_token_is_refused_with_its_own_code() {
    let h = harness();
    for (name, status, code) in [
        ("expired", 401, "access-expired"),
        ("wrong aud", 401, "access-wrong-audience"),
        ("service token", 401, "access-service-token"),
        ("alg none", 401, "access-bad-algorithm"),
        ("unknown kid", 401, "access-unknown-kid"),
        ("other email", 403, "access-not-owner"),
    ] {
        let r = get(&h, "/healthz", HOST, Some(&token(name))).await;
        assert_eq!(r.status().as_u16(), status, "{name}");
        assert_eq!(refusal(&r), Some(code), "{name}");
    }
}

#[tokio::test]
async fn an_unreachable_jwks_fails_closed_with_503() {
    let h = harness_with(Some(HOST), Err("connection refused".into()));
    let r = get(&h, "/healthz", HOST, Some(&token("valid"))).await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refusal(&r), Some("access-keys-unavailable"));
    assert!(text(r).await.contains("fixture-team.cloudflareaccess.com"));
}

#[tokio::test]
async fn local_hosts_are_untouched_and_need_no_token() {
    let h = harness();
    for host in ["localhost", "127.0.0.1:3890"] {
        let r = get(&h, "/healthz", host, None).await;
        assert_eq!(r.status(), StatusCode::OK, "{host}");
        assert_eq!(refusal(&r), None);
    }
}

#[tokio::test]
async fn unbinding_turns_the_hostname_into_an_unknown_host() {
    let h = harness();
    h.ingress.unbind();
    let r = get(&h, "/healthz", HOST, Some(&token("valid"))).await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(refusal(&r), Some("host-not-served"));
    let none = send(
        &h.app,
        Request::builder()
            .uri("/healthz")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(refusal(&none), Some("host-missing"));
    h.ingress
        .bind(binding_input(HOST), Box::new(|_| {}))
        .unwrap();
    assert_eq!(
        get(&h, "/healthz", HOST, Some(&token("valid")))
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_bound_host_matches_regardless_of_case_port_or_trailing_dot() {
    let h = harness();
    for host in [
        "LAPTOP-ADA.example.com",
        "laptop-ada.example.com.",
        "laptop-ada.example.com:443",
    ] {
        assert!(h.ingress.is_bound_host(host), "{host}");
        assert_eq!(
            refusal(&get(&h, "/healthz", host, None).await),
            Some("access-missing")
        );
    }
    assert!(!h.ingress.is_bound_host("other.example.com"));
}

#[tokio::test]
async fn bind_refuses_bad_inputs_with_a_sentence_each() {
    let ingress = CloudIngress::default();
    let mut sentences = std::collections::HashSet::new();
    for (mutate, want) in [
        (
            Box::new(|i: &mut CloudBindingInput| i.hostname = "127.0.0.1".into())
                as Box<dyn Fn(&mut _)>,
            BindRefusal::InvalidHostname,
        ),
        (
            Box::new(|i: &mut CloudBindingInput| i.hostname = "bad host".into()),
            BindRefusal::InvalidHostname,
        ),
        (
            Box::new(|i: &mut CloudBindingInput| i.team_domain = "evil.com".into()),
            BindRefusal::InvalidTeamDomain,
        ),
        (
            Box::new(|i: &mut CloudBindingInput| i.aud = " ".into()),
            BindRefusal::EmptyAud,
        ),
        (
            Box::new(|i: &mut CloudBindingInput| i.owner_email = String::new()),
            BindRefusal::EmptyOwnerEmail,
        ),
    ] {
        let mut input = binding_input(HOST);
        mutate(&mut input);
        assert_eq!(ingress.bind(input, Box::new(|_| {})).unwrap_err(), want);
        sentences.insert(want.sentence());
        assert!(ingress.binding().is_none());
    }
    assert_eq!(sentences.len(), 4);
}

#[tokio::test]
async fn bind_reports_the_prewarm_outcome() {
    let h = harness();
    let (tx, rx) = tokio::sync::oneshot::channel();
    h.ingress
        .bind(binding_input(HOST), Box::new(move |o| drop(tx.send(o))))
        .unwrap();
    assert_eq!(
        rx.await.unwrap(),
        crate::cloud_ingress::JwksOutcome::Ready { keys: 2 }
    );
}

#[test]
fn every_refusal_yaran_emits_is_registered_and_the_sets_are_equal() {
    let mut emitted: std::collections::HashSet<&str> =
        AccessRejection::ALL.iter().map(|r| r.code()).collect();
    for extra in [
        RefusalCode::AccessKeysUnavailable,
        RefusalCode::HostNotServed,
        RefusalCode::HostMissing,
    ] {
        emitted.insert(extra.as_str());
    }
    let registry = fx("registry/refusals.json");
    let registered: std::collections::HashSet<&str> = registry["refusals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["code"].as_str().unwrap())
        .collect();
    assert_eq!(emitted, registered);
}

/// Serves the harness on loopback and opens a WebSocket to `path` as `host`.
async fn ws(
    h: &Harness,
    path: &str,
    host: &str,
    jwt: &str,
) -> tokio_tungstenite::WebSocketStream<tokio::net::TcpStream> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = h.app.clone();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = Request::builder()
        .uri(format!("ws://{host}{path}"))
        .header("Host", host)
        .header("Cf-Access-Jwt-Assertion", jwt)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .unwrap();
    tokio_tungstenite::client_async(request, stream)
        .await
        .unwrap()
        .0
}

/// The close code the socket ends with within `wait`, or `None` if it stays open.
async fn close_code(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    wait: Duration,
) -> Option<u16> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;
    let read = async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Close(frame) = message {
                return frame.map(|f| u16::from(f.code));
            }
        }
        None
    };
    tokio::time::timeout(wait, read).await.ok().flatten()
}

/// Puts the clock one second before the valid token's `exp + skew`.
fn near_expiry(h: &Harness) {
    let skew = IngressSettings::default().clock_skew.as_secs() as i64;
    h.clock
        .store(fixture_now() + 3600 + skew - 1, Ordering::SeqCst);
}

#[tokio::test]
async fn an_events_socket_closes_with_4401_when_its_token_expires() {
    let h = harness();
    near_expiry(&h);
    let mut socket = ws(&h, "/ws/events", HOST, &token("valid")).await;
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(5)).await,
        Some(4401)
    );
}

#[tokio::test]
async fn with_the_setting_off_the_socket_stays_open() {
    let h = harness();
    h.ingress.update_settings(IngressSettings {
        close_sockets_at_access_expiry: false,
        ..h.ingress.settings()
    });
    near_expiry(&h);
    let mut socket = ws(&h, "/ws/events", HOST, &token("valid")).await;
    assert_eq!(
        close_code(&mut socket, Duration::from_millis(1500)).await,
        None
    );
}

#[tokio::test]
async fn a_websocket_upgrade_without_a_token_is_refused_before_the_origin_check() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let h = harness();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = h.app.clone();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    for (host, origin, want) in [
        (HOST.to_string(), "https://evil.example.com", "HTTP/1.1 401"),
        // The canonical-origin fix end to end: a case and default-port difference
        // used to fail the WebSocket origin check; a different port still does.
        (
            format!("localhost:{}", addr.port()),
            &*format!("http://LOCALHOST:{}", addr.port()),
            "HTTP/1.1 101",
        ),
        (
            format!("localhost:{}", addr.port()),
            "http://localhost:8000",
            "HTTP/1.1 403",
        ),
    ] {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let raw = format!(
            "GET /ws/events HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        stream.write_all(raw.as_bytes()).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        let response = String::from_utf8_lossy(&buf[..n]);
        assert!(response.starts_with(want), "{host} {origin}: {response}");
    }
}

#[tokio::test]
async fn refusal_logs_never_carry_the_token() {
    let captured = Captured::default();
    let _guard = captured.install();
    let h = harness();
    for name in ["other email", "expired", "signature flipped"] {
        let _ = get(&h, "/healthz", HOST, Some(&token(name))).await;
        let token = token(name);
        assert!(
            !captured.joined().contains(&token[token.len() - 20..]),
            "{name}"
        );
    }
    assert!(captured.joined().contains("access-not-owner"));
}

#[test]
fn the_ingress_clock_defaults_to_the_wall_clock() {
    let now = CloudIngress::default().now_secs();
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert!((now - wall).abs() < 5);
}

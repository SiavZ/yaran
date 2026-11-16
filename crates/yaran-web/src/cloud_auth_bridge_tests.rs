//! The Cloudflare Access owner and the optional web password, against the real
//! router: a verified Access owner on the tunnel is signed in for
//! `[server.auth]` without a second password wall, and nothing else is.
//!
//! - The credit is per request and stateless: no session, no cookie.
//! - It holds only for a loopback-to-loopback arrival (cloudflared dialing the
//!   loopback primary) with no Funnel marker, never for a header.
//! - Access refusals, the blocklist and a broken `[server.auth]` still apply.

use std::net::SocketAddr;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use yaran_core::auth::{Password, hash_password};
use yaran_core::config::{AuthRequire, ServerAuthConfig};

use crate::auth::Arrival;
use crate::cloud_jwks_cache::tests::fixture_jwks;
use crate::cloud_test_support::*;

const PASSWORD: &str = "orbit velvet quarry lantern cobalt";
/// The client cloudflared names in `X-Forwarded-For`.
const EDGE_CLIENT: &str = "198.51.100.9";

/// cloudflared's connection: loopback onto the loopback primary.
const TUNNEL: Arrival = Arrival::Tcp {
    peer: SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 50000),
    local: SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 3890),
};
/// A LAN client reaching the LAN listener.
const LAN: Arrival = Arrival::Tcp {
    peer: SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(198, 51, 100, 7)),
        50000,
    ),
    local: SocketAddr::new(
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, 10)),
        3890,
    ),
};

fn hash() -> String {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| hash_password(&Password::new(PASSWORD.into())).expect("hash"))
        .clone()
}

fn with_password(require: AuthRequire) -> ServerAuthConfig {
    ServerAuthConfig {
        password_hash: hash(),
        require,
        ..ServerAuthConfig::default()
    }
}

/// The cloud harness with `auth` as the live `[server.auth]`.
fn harness_with_auth(jwks_ok: bool, auth: &ServerAuthConfig) -> Harness {
    let jwks = if jwks_ok {
        Ok(fixture_jwks("jwks.json"))
    } else {
        Err("offline".to_string())
    };
    let h = harness_with(Some(HOST), jwks);
    h.engine.live_limits().auth().store(auth, None);
    h
}

/// A request from `from`, the way cloudflared forwards it: the edge client in
/// `X-Forwarded-For`, and the Access assertion when `jwt` is given.
fn tunnel_request(
    method: &str,
    uri: &str,
    host: &str,
    jwt: Option<&str>,
    from: Arrival,
) -> axum::http::request::Builder {
    let mut b = request(method, uri, host, jwt).header("X-Forwarded-For", EDGE_CLIENT);
    if let Some(ext) = b.extensions_mut() {
        ext.insert(axum::extract::ConnectInfo(from));
    }
    b
}

async fn json(response: Response<Body>) -> serde_json::Value {
    serde_json::from_str(&text(response).await).expect("a JSON body")
}

async fn assert_auth_required(response: Response<Body>, what: &str) {
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{what}");
    assert_eq!(json(response).await["error"], "auth_required", "{what}");
}

/// Row 1: a verified owner on the tunnel gets through with a password set.
#[tokio::test]
async fn a_verified_owner_on_the_tunnel_meets_no_second_password_wall() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    let jwt = token("valid");
    let r = send(
        &h.app,
        tunnel_request("GET", "/api/v1/build", HOST, Some(&jwt), TUNNEL)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK, "{}", text(r).await);
    let r = send(
        &h.app,
        tunnel_request("POST", "/probe", HOST, Some(&jwt), TUNNEL)
            .header("Origin", format!("https://{HOST}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(text(r).await, "ok");
}

/// Row 2: the handoff and its consent page work through the password, and the
/// envelope still opens.
#[tokio::test]
async fn the_handoff_works_through_a_password() {
    let mut h = harness_with_auth(true, &with_password(AuthRequire::Network));
    // The handoff helpers send no connection; every request here is the tunnel's.
    h.app = h.app.layer(axum::middleware::map_request(
        |mut r: Request<Body>| async move {
            r.extensions_mut()
                .insert(axum::extract::ConnectInfo(TUNNEL));
            r
        },
    ));
    let mut a = ask(&h, &device(), STATE);
    let r = consent(&h, &a, "continue", None).await;
    assert_eq!(r.status(), StatusCode::SEE_OTHER);
    let loc = location(&r);
    assert!(
        loc.starts_with(&format!("{CALLBACK}?state={STATE}&jwe=")),
        "{loc}"
    );
    let payload = open(a.key.take().unwrap(), &param(&loc, "jwe").unwrap(), STATE);
    assert_eq!(payload["jwt"], token("valid"));
}

/// Row 3: the status a verified owner reads, under `require = "everywhere"`.
#[tokio::test]
async fn the_status_says_access_signed_the_owner_in() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Everywhere));
    let r = send(
        &h.app,
        tunnel_request(
            "GET",
            "/api/v1/auth/status",
            HOST,
            Some(&token("valid")),
            TUNNEL,
        )
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert!(
        r.headers().get("set-cookie").is_none(),
        "no session cookie is minted for the owner"
    );
    let doc = json(r).await;
    assert_eq!(doc["required_here"], false, "{doc}");
    assert_eq!(doc["signed_in"], false, "{doc}");
    assert_eq!(doc["access_verified"], true, "{doc}");
    assert_eq!(doc["client_class"], "network", "{doc}");
    assert_eq!(doc["can_set_first_password"], false, "{doc}");
}

/// Row 4: with no password, the owner is not warned, and a tunnel request is
/// never this machine, whatever cloudflared forwarded (no XFF here).
#[tokio::test]
async fn without_a_password_the_owner_is_not_warned_and_is_never_this_machine() {
    let h = harness_with_auth(true, &ServerAuthConfig::default());
    let mut b = request("GET", "/api/v1/auth/status", HOST, Some(&token("valid")));
    b.extensions_mut()
        .unwrap()
        .insert(axum::extract::ConnectInfo(TUNNEL));
    let r = send(&h.app, b.body(Body::empty()).unwrap()).await;
    assert!(r.headers().get("set-cookie").is_none());
    let doc = json(r).await;
    assert_eq!(doc["no_auth_warning"], false, "{doc}");
    assert_eq!(doc["can_set_first_password"], false, "{doc}");
    assert_eq!(doc["client_class"], "network", "{doc}");
    assert_eq!(doc["access_verified"], true, "{doc}");
}

/// Row 5: every Access refusal is answered by the ingress before the auth
/// layer, with or without a password, for a request and an upgrade alike.
#[tokio::test]
async fn access_refusals_come_before_the_auth_layer() {
    for auth in [
        with_password(AuthRequire::Network),
        ServerAuthConfig::default(),
    ] {
        let h = harness_with_auth(true, &auth);
        for (jwt, code) in [
            (None, "access-missing"),
            (Some("two segments"), "access-malformed"),
            (Some("expired"), "access-expired"),
            (Some("wrong aud"), "access-wrong-audience"),
            (Some("wrong iss"), "access-wrong-issuer"),
            (Some("other email"), "access-not-owner"),
            (Some("service token"), "access-service-token"),
        ] {
            let jwt = jwt.map(token);
            for upgrade in [false, true] {
                let mut b = tunnel_request("GET", "/ws/events", HOST, jwt.as_deref(), TUNNEL);
                if upgrade {
                    b = b
                        .header("Connection", "Upgrade")
                        .header("Upgrade", "websocket")
                        .header("Sec-WebSocket-Version", "13")
                        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==");
                }
                let r = send(&h.app, b.body(Body::empty()).unwrap()).await;
                assert_eq!(refusal(&r), Some(code), "{code} upgrade={upgrade}");
                let body = text(r).await;
                assert!(!body.contains("auth_required"), "{code}: {body}");
            }
        }
    }
}

/// Row 6: with the Access keys unavailable, the owner is refused 503 even with
/// a password set.
#[tokio::test]
async fn unavailable_access_keys_refuse_before_the_password() {
    let h = harness_with_auth(false, &with_password(AuthRequire::Network));
    let r = send(
        &h.app,
        tunnel_request(
            "GET",
            "/api/v1/projects",
            HOST,
            Some(&token("valid")),
            TUNNEL,
        )
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refusal(&r), Some("access-keys-unavailable"));
}

/// Rows 7 and 8: the same assertion replayed to a LAN listener, or arriving
/// with Tailscale's Funnel marker, is not credited.
#[tokio::test]
async fn a_replayed_assertion_off_loopback_or_through_a_funnel_still_needs_the_password() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    let jwt = token("valid");
    let r = send(
        &h.app,
        tunnel_request("GET", "/api/v1/projects", HOST, Some(&jwt), LAN)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_auth_required(r, "a LAN replay").await;
    let r = send(
        &h.app,
        tunnel_request("GET", "/api/v1/projects", HOST, Some(&jwt), TUNNEL)
            .header("tailscale-funnel-request", "?1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_auth_required(r, "a Funnel-marked request").await;
}

/// Row 9: a spoofed assertion header on a Host the ingress does not serve is
/// ignored, so it credits nothing.
#[tokio::test]
async fn a_spoofed_assertion_on_another_host_credits_nothing() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    let r = send(
        &h.app,
        tunnel_request(
            "GET",
            "/api/v1/projects",
            "localhost",
            Some(&token("valid")),
            TUNNEL,
        )
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_auth_required(r, "a spoofed header on localhost").await;
}

/// Row 10: a plain loopback request with no forwarding header is this machine,
/// exactly as without Cloud Connect.
#[tokio::test]
async fn plain_loopback_is_unchanged() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    let mut b = request("GET", "/api/v1/projects", "localhost", None);
    b.extensions_mut()
        .unwrap()
        .insert(axum::extract::ConnectInfo(TUNNEL));
    let r = send(&h.app, b.body(Body::empty()).unwrap()).await;
    assert_eq!(r.status(), StatusCode::OK, "{}", text(r).await);
}

/// Row 11: an owner's events socket survives every auth revision bump (a new
/// password, a ban of somebody else) and closes 4401 only at Access expiry.
#[tokio::test]
async fn an_owners_socket_outlives_auth_changes_and_closes_at_access_expiry() {
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    before_expiry(&h, 3);
    let mut socket = ws(&h.app, "/ws/events", HOST, &token("valid")).await;
    let auth = h.engine.live_limits().auth();
    let other = hash_password(&Password::new(
        "harbor cinnamon glacier tundra mosaic".into(),
    ))
    .expect("hash");
    assert!(auth.store(
        &ServerAuthConfig {
            password_hash: other.clone(),
            ..with_password(AuthRequire::Network)
        },
        None
    ));
    assert!(auth.store(
        &ServerAuthConfig {
            password_hash: other,
            blocked_addresses: vec!["203.0.113.4".to_string()],
            ..with_password(AuthRequire::Network)
        },
        None
    ));
    assert_eq!(
        close_code(&mut socket, Duration::from_millis(500)).await,
        None,
        "the auth changes leave the owner's socket open"
    );
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(6)).await,
        Some(4401),
        "it closes when the Access session expires"
    );
}

/// Row 12: the blocklist still applies to a verified owner, request and socket.
#[tokio::test]
async fn the_blocklist_still_applies_to_a_verified_owner() {
    let h = harness_with_auth(
        true,
        &ServerAuthConfig {
            blocked_addresses: vec![EDGE_CLIENT.to_string()],
            ..with_password(AuthRequire::Network)
        },
    );
    let r = send(
        &h.app,
        tunnel_request(
            "GET",
            "/api/v1/projects",
            HOST,
            Some(&token("valid")),
            TUNNEL,
        )
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(json(r).await["error"], "blocked");

    // The socket path: an owner's socket whose forwarded client is banned
    // after it opened closes 4403.
    let h = harness_with_auth(true, &with_password(AuthRequire::Network));
    let mut socket = ws_with(
        &h.app,
        "/ws/events",
        HOST,
        &token("valid"),
        &[("X-Forwarded-For", EDGE_CLIENT)],
    )
    .await;
    assert_eq!(
        close_code(&mut socket, Duration::from_millis(300)).await,
        None,
        "the owner's socket opens"
    );
    h.engine.live_limits().auth().store(
        &ServerAuthConfig {
            blocked_addresses: vec![EDGE_CLIENT.to_string()],
            ..with_password(AuthRequire::Network)
        },
        None,
    );
    assert_eq!(
        close_code(&mut socket, Duration::from_secs(3)).await,
        Some(4403)
    );
}

/// Row 13: a broken `[server.auth]` refuses a verified owner too, without
/// telling the network why.
#[tokio::test]
async fn a_broken_auth_section_refuses_the_owner_without_detail() {
    let h = harness_with_auth(
        true,
        &ServerAuthConfig {
            session_idle_seconds: 0,
            ..with_password(AuthRequire::Network)
        },
    );
    let r = send(
        &h.app,
        tunnel_request(
            "GET",
            "/api/v1/projects",
            HOST,
            Some(&token("valid")),
            TUNNEL,
        )
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(r).await;
    assert_eq!(body["error"], "auth_config_invalid", "{body}");
    assert!(body.get("detail").is_none(), "{body}");
}

/// Row 14: the handoff routes are not public; they rely on the credit.
#[test]
fn the_handoff_routes_are_not_public() {
    use axum::http::Method;
    for path in ["/__yaran/handoff", "/__yaran/signed-in"] {
        assert!(
            !crate::auth::middleware::is_public(&Method::GET, path),
            "{path}"
        );
        assert!(
            !crate::auth::middleware::is_public(&Method::POST, path),
            "{path}"
        );
    }
}

//! Tests for the loopback listener and the pasted-URL parser.
//!
//! <module-headers:begin>
//! <module-headers:end>

use super::*;

const STATE: &str = "state-state-state-state-0123456789";
const CODE: &str = "cccccccccccccccccccccccccccccccccccccccccc1";

/// Send `request` and serve it; returns the listener's verdict and the response text.
fn exchange(l: &LoopbackListener, request: &[u8]) -> (Option<CallbackResult>, String) {
    let mut client = TcpStream::connect(l.local_addr().unwrap()).unwrap();
    client.write_all(request).unwrap();
    let mut verdict = None;
    for _ in 0..100 {
        verdict = l.poll(STATE);
        if verdict.is_some() {
            break;
        }
        // A served-but-refused request has a response waiting.
        client
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut peek = [0u8; 1];
        if client.peek(&mut peek).is_ok() {
            break;
        }
    }
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut out = String::new();
    let _ = client.read_to_string(&mut out);
    (verdict, out)
}

#[test]
fn the_listener_binds_loopback_only() {
    let l = LoopbackListener::bind().unwrap();
    assert!(l.local_addr().unwrap().ip().is_loopback());
    assert_eq!(
        l.callback_url(),
        format!("http://127.0.0.1:{}/callback", l.port())
    );
    assert!(crate::cloud::protocol::pairing::loopback_callback_port(&l.callback_url()).is_some());
}

#[test]
fn other_paths_get_404_and_the_listener_keeps_waiting() {
    let l = LoopbackListener::bind().unwrap();
    let (v, out) = exchange(&l, b"GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n");
    assert_eq!(v, None);
    assert!(out.starts_with("HTTP/1.1 404"), "{out}");
    let (v, out) = exchange(&l, b"POST /callback HTTP/1.1\r\nHost: x\r\n\r\n");
    assert_eq!(v, None);
    assert!(out.starts_with("HTTP/1.1 404"));
    let ok = format!("GET /callback?code={CODE}&state={STATE} HTTP/1.1\r\nHost: x\r\n\r\n");
    let (v, out) = exchange(&l, ok.as_bytes());
    assert_eq!(v, Some(CallbackResult::Code(CODE.into())));
    assert!(out.contains("yaran is paired") && out.contains("Cache-Control: no-store"));
}

#[test]
fn a_bad_state_gets_400_and_the_listener_keeps_waiting() {
    let l = LoopbackListener::bind().unwrap();
    let bad =
        format!("GET /callback?code={CODE}&state=other-other-other-other-00 HTTP/1.1\r\n\r\n");
    let (v, out) = exchange(&l, bad.as_bytes());
    assert_eq!(v, None);
    assert!(out.starts_with("HTTP/1.1 400"));
    let denied = format!("GET /callback?error=pair_denied&state={STATE} HTTP/1.1\r\n\r\n");
    assert_eq!(
        exchange(&l, denied.as_bytes()).0,
        Some(CallbackResult::Denied("pair_denied".into()))
    );
}

#[test]
fn an_oversized_head_is_rejected() {
    let l = LoopbackListener::bind().unwrap();
    let mut req = b"GET /callback?".to_vec();
    req.extend(std::iter::repeat_n(b'a', MAX_HEAD_BYTES + 100));
    let (v, out) = exchange(&l, &req);
    assert_eq!(v, None);
    assert!(out.starts_with("HTTP/1.1 431"), "{out}");
}

#[test]
fn pasted_url_table() {
    let port = 53682;
    let good = format!("http://127.0.0.1:{port}/callback?code={CODE}&state={STATE}");
    assert_eq!(
        parse_pasted_callback(&good, port, STATE),
        Ok(CallbackResult::Code(CODE.into()))
    );
    assert_eq!(
        parse_pasted_callback(&format!("  {good}\n"), port, STATE),
        Ok(CallbackResult::Code(CODE.into()))
    );
    for (bad, why) in [
        (
            format!("http://127.0.0.1:1234/callback?code={CODE}&state={STATE}"),
            "callback",
        ),
        (
            format!("http://localhost:{port}/callback?code={CODE}&state={STATE}"),
            "callback",
        ),
        (
            format!("https://127.0.0.1:{port}/callback?code={CODE}&state={STATE}"),
            "callback",
        ),
        (
            format!("http://127.0.0.1:{port}/other?code={CODE}&state={STATE}"),
            "callback",
        ),
        (
            format!("http://127.0.0.1:{port}/callback?code={CODE}&state=nope-nope-nope-nope-nope"),
            "different login",
        ),
        (
            format!("http://127.0.0.1:{port}/callback?state={STATE}"),
            "missing",
        ),
        ("not a url".to_string(), "whole address"),
    ] {
        let err = parse_pasted_callback(&bad, port, STATE).unwrap_err();
        assert!(err.contains(why), "{bad}: {err}");
    }
}

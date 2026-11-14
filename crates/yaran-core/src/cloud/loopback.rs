//! The login's loopback redirect listener (RFC 8252 §7.3, §8.3) and the pasted-URL parser.
//!
//! A std `TcpListener` on `127.0.0.1:0`, alive only for the login. Each `poll` serves
//! at most one waiting connection: it reads at most 8 KiB of request head, answers 404
//! to anything but `GET /callback?…` (a favicon included), 400 to a wrong `state` (and
//! keeps waiting, so a stray tab cannot end the login), and a self-contained "paired"
//! page with `Cache-Control: no-store` to the real callback. The pasted-URL parser
//! accepts the same address typed back from a browser that could not reach this machine.
//!
//! - Trust boundary: everything in a request is browser input; `state` is compared in
//!   constant time and `error` codes are validated before they go anywhere.
//! - Binds loopback only; never a wildcard address.
//!
//! <module-headers:begin>
//! <module-headers:end>

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use crate::cloud::pkce::constant_time_eq;
use crate::cloud::protocol::rules::{is_b64url_43, is_error_code};

/// The most request head the listener reads.
pub const MAX_HEAD_BYTES: usize = 8 * 1024;

/// What a callback carried once its `state` matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallbackResult {
    /// The pair code to claim.
    Code(String),
    /// The confirm page sent `?error=<code>` (for example `pair_denied`).
    Denied(String),
}

/// Why a callback query was not accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryError {
    BadState,
    Malformed,
}

/// Interpret a callback query string against the pending login's `state`.
pub fn callback_from_query(
    query: &str,
    expected_state: &str,
) -> Result<CallbackResult, QueryError> {
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => return Err(QueryError::Malformed),
        }
    }
    if !state.is_some_and(|s| constant_time_eq(&s, expected_state)) {
        return Err(QueryError::BadState);
    }
    match (code, error) {
        (Some(c), None) if is_b64url_43(&c) => Ok(CallbackResult::Code(c)),
        (None, Some(e)) if is_error_code(&e) => Ok(CallbackResult::Denied(e)),
        _ => Err(QueryError::Malformed),
    }
}

/// Parse an address pasted from a browser: `http://127.0.0.1:<port>/callback?code=…&state=…`.
/// The port must be ours, the path `/callback`, and the state must match.
pub fn parse_pasted_callback(
    pasted: &str,
    port: u16,
    expected_state: &str,
) -> Result<CallbackResult, String> {
    let url = url::Url::parse(pasted.trim())
        .map_err(|_| "That is not the address your browser landed on; paste the whole address, starting with http://127.0.0.1.".to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(port)
        || url.path() != "/callback"
    {
        return Err(format!(
            "That address is not this login's callback; it should start with http://127.0.0.1:{port}/callback."
        ));
    }
    callback_from_query(url.query().unwrap_or_default(), expected_state).map_err(|e| match e {
        QueryError::BadState => "That address belongs to a different login attempt; paste the address from the browser tab this login opened.".to_string(),
        QueryError::Malformed => "That address is missing the pairing code; paste the whole address your browser landed on.".to_string(),
    })
}

const PAIRED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>yaran is paired</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style></head><body><h1>yaran is paired</h1><p>This machine is finishing its connection to Yaran Cloud. You can close this tab.</p></body></html>";
const DENIED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Pairing not completed</title></head><body><h1>Pairing not completed</h1><p>The control plane did not approve this machine. You can close this tab; yaran shows why in the terminal.</p></body></html>";

/// The loopback listener for one login.
pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    /// Bind `127.0.0.1` on an ephemeral port.
    pub fn bind() -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// `http://127.0.0.1:<port>/callback`, the authorize query's `callback`.
    pub fn callback_url(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Serve one waiting connection, if any. `Some` only for an accepted callback.
    pub fn poll(&self, expected_state: &str) -> Option<CallbackResult> {
        let (stream, _) = self.listener.accept().ok()?;
        serve(stream, expected_state)
    }
}

fn respond(mut stream: &TcpStream, status: &str, content_type: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn read_head(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        if head.len() > MAX_HEAD_BYTES {
            return None;
        }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    (head.len() <= MAX_HEAD_BYTES).then_some(head)
}

fn serve(mut stream: TcpStream, expected_state: &str) -> Option<CallbackResult> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let Some(head) = read_head(&mut stream) else {
        respond(
            &stream,
            "431 Request Header Fields Too Large",
            "text/plain; charset=utf-8",
            "Request head too large.\n",
        );
        return None;
    };
    let line = String::from_utf8_lossy(&head);
    let mut parts = line.lines().next().unwrap_or_default().split(' ');
    let (method, target) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" || path != "/callback" {
        respond(
            &stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "Not found.\n",
        );
        return None;
    }
    match callback_from_query(query, expected_state) {
        Ok(result) => {
            let page = match result {
                CallbackResult::Code(_) => PAIRED_PAGE,
                CallbackResult::Denied(_) => DENIED_PAGE,
            };
            respond(&stream, "200 OK", "text/html; charset=utf-8", page);
            Some(result)
        }
        Err(QueryError::BadState) => {
            respond(
                &stream,
                "400 Bad Request",
                "text/plain; charset=utf-8",
                "This address does not belong to the login yaran is waiting for. Use the tab the login opened.\n",
            );
            None
        }
        Err(QueryError::Malformed) => {
            respond(
                &stream,
                "400 Bad Request",
                "text/plain; charset=utf-8",
                "This callback is missing its pairing code.\n",
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "loopback_tests.rs"]
mod tests;

//! The Claude Peers broker's HTTP client: list the registrations and send a
//! message, over loopback to the broker's port (`CLAUDE_PEERS_PORT`, default
//! 7899). Which registration a message goes to is the router's decision.

use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use super::handle::truncate;

const DEFAULT_CLAUDE_PEERS_PORT: u16 = 7899;

/// One registration as the broker lists it.
#[derive(Clone, Debug, Deserialize)]
pub(super) struct ClaudePeer {
    pub(super) id: String,
    pub(super) cwd: String,
    /// Peer process id. Absent on brokers that predate the field; the
    /// registration then ranks as an ordinary client, decided by recency.
    #[serde(default)]
    pub(super) pid: Option<u32>,
    /// Broker heartbeat, ISO-8601. Lexicographically sortable.
    #[serde(default)]
    pub(super) last_seen: Option<String>,
    /// When this registration was created, ISO-8601. Continuing or forking a
    /// conversation registers afresh, so among equals the newest is current.
    #[serde(default)]
    pub(super) registered_at: Option<String>,
}

pub(super) fn claude_peers_send(from_id: &str, to_id: &str, message: &str) -> Result<()> {
    let body = json!({
        "from_id": from_id,
        "to_id": to_id,
        "text": message,
    });
    let value = claude_peers_post("/send-message", &body)?;
    if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(());
    }
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown broker error");
    bail!("Claude Peers send failed: {error}");
}

pub(super) fn claude_peers_list() -> Result<Vec<ClaudePeer>> {
    let body = json!({
        "scope": "machine",
        "cwd": "/",
        "git_root": Value::Null,
    });
    let value = claude_peers_post("/list-peers", &body)?;
    serde_json::from_value(value).context("Claude Peers broker returned malformed peer list")
}
fn claude_peers_post(path: &str, body: &Value) -> Result<Value> {
    let port = env::var("CLAUDE_PEERS_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_CLAUDE_PEERS_PORT);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(750))
        .with_context(|| format!("Claude Peers broker unavailable on {addr}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;

    let body = serde_json::to_string(body)?;
    let request = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    stream.write_all(request.as_bytes())?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    parse_broker_response(&response)
}

fn parse_broker_response(response: &str) -> Result<Value> {
    let (headers, response_body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("malformed response from Claude Peers broker"))?;
    let status_line = headers.lines().next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&status) {
        bail!(
            "Claude Peers broker returned HTTP {status}: {}",
            truncate(response_body, 300)
        );
    }
    serde_json::from_str(response_body).context("Claude Peers broker returned non-JSON response")
}

#[cfg(test)]
mod tests {
    use super::*;

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
}

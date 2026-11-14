//! cloudflared's readiness: `GET http://127.0.0.1:<metrics port>/ready`.
//!
//! cloudflared answers 200 `{"status","readyConnections","connectorId"}` with at least one
//! edge connection and 503 otherwise. `readyConnections > 0` is Ready.
//!
//! - Blocking; called from the leg's supervisor thread. Loopback only, proxy disabled.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/ready.rs
//! └── cloud::cloudflared::test_support
//! External: serde_json, std, ureq
//!
//! Used by:
//! cloud/cloudflared/ready.rs
//! ├── cloud::cloudflared
//! ├── cloud::leg
//! ├── cloud::leg::tests
//! └── cloud::leg_run
//! <module-headers:end>

use std::time::Duration;

/// What one probe found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    Ready {
        connections: u32,
    },
    NotReady,
    /// Nothing answered (cloudflared still starting, or gone).
    Unreachable,
}

/// Poll every second until Ready, every five after.
pub const POLL_UNTIL_READY: Duration = Duration::from_secs(1);
pub const POLL_WHILE_READY: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Probe the metrics port once.
pub fn probe(port: u16) -> Readiness {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    match agent.get(format!("http://127.0.0.1:{port}/ready")).call() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response
                .into_body()
                .with_config()
                .limit(64 * 1024)
                .read_to_string()
                .unwrap_or_default();
            judge(status, &body)
        }
        Err(_) => Readiness::Unreachable,
    }
}

/// The pure half of the probe.
pub fn judge(status: u16, body: &str) -> Readiness {
    if status != 200 {
        return Readiness::NotReady;
    }
    let connections = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("readyConnections").and_then(|n| n.as_u64()))
        .unwrap_or(0);
    match u32::try_from(connections) {
        Ok(0) => Readiness::NotReady,
        Ok(connections) => Readiness::Ready { connections },
        Err(_) => Readiness::Ready {
            connections: u32::MAX,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::cloudflared::test_support::{Reply, http_stub};

    #[test]
    fn judge_table() {
        assert_eq!(
            judge(
                200,
                r#"{"status":200,"readyConnections":4,"connectorId":"x"}"#
            ),
            Readiness::Ready { connections: 4 }
        );
        assert_eq!(judge(200, r#"{"readyConnections":0}"#), Readiness::NotReady);
        assert_eq!(judge(503, r#"{"readyConnections":0}"#), Readiness::NotReady);
        assert_eq!(judge(200, "garbage"), Readiness::NotReady);
    }

    #[test]
    fn probes_a_loopback_stub() {
        let (base, cell, _) = http_stub(Reply::ok(br#"{"readyConnections":2}"#.to_vec()));
        let port: u16 = base.rsplit(':').next().unwrap().parse().unwrap();
        assert_eq!(probe(port), Readiness::Ready { connections: 2 });
        cell.lock().unwrap().status = 503;
        assert_eq!(probe(port), Readiness::NotReady);
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = free.local_addr().unwrap().port();
        drop(free);
        assert_eq!(probe(dead), Readiness::Unreachable);
    }
}

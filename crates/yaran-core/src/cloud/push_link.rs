//! The emitter's seam to Phase 09: pairing state, the signed client and the revocation signal.
//!
//! `MachineLink` is the four things the `cloud-push` thread needs from 09 (read the
//! credentials at flush time, signed W5 `GET /v1/machine/config`, signed W6
//! `POST /v1/machine/events`, report a revocation to 09's `RevocationSignal`, which 10's
//! leg subscribes to). `LinkError` mirrors 09's `MachineApiError`. `HttpMachineLink` is
//! the interim implementation over ureq and 02's `signing::sign_now`, fed by closures
//! where 09's credentials store and revocation signal plug in.
//!
//! - Runs on the `cloud-push` thread only, never the engine tick.
//! - Server text crosses a trust boundary: sanitized and truncated to 200 chars here.
//! - Logs method, path and status only; never headers, bodies or the key.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_link.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::signing
//! └── sanitize
//! External: ring, serde, serde_json, std, tracing, ureq
//!
//! Used by:
//! cloud/push_link.rs
//! ├── cloud
//! ├── cloud::push_emitter
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_runner
//! └── yaran-core[test cloud_push_emitter]
//! <module-headers:end>

use std::sync::Arc;
use std::time::Duration;

use ring::signature::Ed25519KeyPair;
use serde::de::DeserializeOwned;

use super::protocol::machine::{EventBatch, EventBatchResult, MachineConfig};
use super::protocol::signing::{RequestParts, sign_now};
use super::protocol::{ErrorCode, ErrorEnvelope, PROTOCOL_MAX, Validate};

/// 09's `MachineApiError`, as far as the emitter needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    /// `410 machine_revoked`.
    Revoked,
    /// `401 signature_expired`; `server_time` from `details` or the `Date` header.
    ClockSkew {
        server_time: Option<String>,
    },
    /// Any other registered error envelope.
    Refused {
        code: ErrorCode,
        message: String,
        retryable: bool,
        retry_after: Option<Duration>,
    },
    /// A non-2xx answer with no readable envelope.
    Server {
        status: u16,
        retry_after: Option<Duration>,
    },
    Network(String),
    Malformed(String),
}

impl LinkError {
    /// A short sanitized sentence fragment for statuses and logs.
    pub fn describe(&self) -> String {
        match self {
            Self::Revoked => "the machine was revoked".into(),
            Self::ClockSkew { .. } => "the request signature was outside the clock window".into(),
            Self::Refused { code, message, .. } => format!("{}: {message}", code.as_str()),
            Self::Server { status, .. } => format!("HTTP {status}"),
            Self::Network(e) | Self::Malformed(e) => e.clone(),
        }
    }
}

/// What the emitter needs from Phase 09.
pub trait MachineLink: Send {
    /// The paired org's name, read from the credentials now; `None` when unpaired.
    fn org_name(&mut self) -> Option<String>;
    fn machine_config(&mut self) -> Result<MachineConfig, LinkError>;
    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, LinkError>;
    /// Hand a revocation verdict to 09's `RevocationSignal` (10 stops the leg on it).
    fn report_revoked(&mut self);
}

/// The pairing-derived values a signed request needs (09's credentials file).
pub struct LinkCredentials {
    pub org_url: String,
    pub org_name: String,
    pub machine_id: String,
    pub key: Arc<Ed25519KeyPair>,
}

type CredentialsFn = Box<dyn FnMut() -> Option<LinkCredentials> + Send>;
type RevokedFn = Box<dyn FnMut() + Send>;

/// 09's `request_timeout_seconds` default.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 09's body cap.
const MAX_BODY_BYTES: u64 = 64 * 1024;
const MAX_SERVER_TEXT: usize = 200;

// shortcut: a stand-in for 09's `MachineApi` (signed_request + credentials::read); once
// 09 lands, implement `MachineLink` over `MachineApi` and delete this type.
pub struct HttpMachineLink {
    credentials: CredentialsFn,
    on_revoked: RevokedFn,
}

fn agent_for(loopback: bool) -> ureq::Agent {
    let mut builder = ureq::Agent::config_builder()
        .timeout_connect(Some(REQUEST_TIMEOUT))
        .timeout_global(Some(REQUEST_TIMEOUT))
        .http_status_as_error(false);
    // Nobody proxies a request to their own machine (the release-notes precedent).
    if loopback {
        builder = builder.proxy(None);
    }
    builder.build().into()
}

impl HttpMachineLink {
    pub fn new(credentials: CredentialsFn, on_revoked: RevokedFn) -> Self {
        Self {
            credentials,
            on_revoked,
        }
    }

    /// Unpaired forever: what the engine runs until 09's credentials store exists.
    pub fn unpaired() -> Self {
        Self::new(Box::new(|| None), Box::new(|| {}))
    }

    fn request<T: DeserializeOwned + Validate>(
        &mut self,
        method: &'static str,
        path: &'static str,
        body: Vec<u8>,
    ) -> Result<T, LinkError> {
        let creds = (self.credentials)().ok_or_else(|| LinkError::Network("not paired".into()))?;
        let host = creds
            .org_url
            .split_once("://")
            .map_or(creds.org_url.as_str(), |(_, rest)| rest)
            .split('/')
            .next()
            .unwrap_or_default()
            .to_string();
        let loopback = matches!(
            crate::cloud::protocol::signing::signed_host(&host).as_str(),
            "127.0.0.1" | "localhost" | "[::1]"
        );
        if !creds.org_url.starts_with("https://") && !loopback {
            return Err(LinkError::Malformed(
                "the control-plane URL is not https; refusing to send signed requests".into(),
            ));
        }
        let parts = RequestParts {
            method,
            path,
            host: &host,
            protocol: PROTOCOL_MAX as u32,
            machine_id: Some(&creds.machine_id),
        };
        // Signed per attempt: a fresh timestamp and nonce every time (02 §7).
        let signed =
            sign_now(&creds.key, &parts, &body).map_err(|e| LinkError::Malformed(e.to_string()))?;
        let url = format!("{}{path}", creds.org_url.trim_end_matches('/'));
        let agent = agent_for(loopback);
        let response = if method == "GET" {
            let mut req = agent.get(&url);
            for (name, value) in signed.pairs() {
                req = req.header(name, value);
            }
            req.call()
        } else {
            let mut req = agent.post(&url).header("content-type", "application/json");
            for (name, value) in signed.pairs() {
                req = req.header(name, value);
            }
            req.send(&body[..])
        };
        let mut response = response.map_err(|e| {
            LinkError::Network(crate::sanitize::truncate(&e.to_string(), MAX_SERVER_TEXT))
        })?;
        let status = response.status().as_u16();
        tracing::debug!(target: "yaran::cloud::push", method, path, status, "control-plane answer");
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let retry_after = header("retry-after")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let date = header("date");
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .map_err(|e| {
                LinkError::Network(crate::sanitize::truncate(&e.to_string(), MAX_SERVER_TEXT))
            })?;
        if (200..300).contains(&status) {
            let value: T = serde_json::from_str(&text)
                .map_err(|e| LinkError::Malformed(format!("unreadable {path} answer: {e}")))?;
            value
                .validate()
                .map_err(|e| LinkError::Malformed(format!("invalid {path} answer: {}", e.0)))?;
            return Ok(value);
        }
        let Ok(envelope) = serde_json::from_str::<ErrorEnvelope>(&text) else {
            return Err(LinkError::Server {
                status,
                retry_after,
            });
        };
        let code = envelope.error.code();
        Err(match code {
            ErrorCode::MachineRevoked => LinkError::Revoked,
            ErrorCode::SignatureExpired => LinkError::ClockSkew {
                server_time: envelope
                    .error
                    .details
                    .as_ref()
                    .and_then(|d| d.get("server_time"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or(date),
            },
            _ => LinkError::Refused {
                code,
                message: crate::sanitize::truncate(&envelope.error.message, MAX_SERVER_TEXT),
                retryable: envelope.is_retryable(status),
                retry_after,
            },
        })
    }
}

impl MachineLink for HttpMachineLink {
    fn org_name(&mut self) -> Option<String> {
        (self.credentials)().map(|c| c.org_name)
    }

    fn machine_config(&mut self) -> Result<MachineConfig, LinkError> {
        self.request("GET", "/v1/machine/config", Vec::new())
    }

    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, LinkError> {
        // Serialized once; the signature covers exactly these bytes.
        let body = serde_json::to_vec(batch).map_err(|e| LinkError::Malformed(e.to_string()))?;
        self.request("POST", "/v1/machine/events", body)
    }

    fn report_revoked(&mut self) {
        (self.on_revoked)();
    }
}

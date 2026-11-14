//! The signed control-plane client every yaran phase reuses (`MachineApi`).
//!
//! Calls: `meta` (W1, unsigned), `claim` (W4, signed without a machine id), and the
//! machine routes `config` (W5), `rotate` (W7), `unpair` (W8), `set_origin` (W32) and
//! `events` (W6, for Phase 12). Signed calls read the credentials fresh each time, so a
//! rotation by another process is used at once, and write their results back under the
//! credentials lock (`rotate`: token and version; `set_origin`: origin port).
//!
//! - HTTPS only; plain `http://127.0.0.1` exists only behind `with_test_transport`
//!   (tests and the `test-support` feature).
//! - Any `410 machine_revoked` on a signed call raises the process-wide
//!   `RevocationSignal` and stamps `revoked_at`.
//! - Blocking ureq calls: worker or CLI threads only, never the UI thread.
//! - Logs method, path, status and request id under `yaran::cloud`; never headers or
//!   bodies.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/machine_api.rs
//! ├── cloud::credentials
//! ├── cloud::identity
//! ├── cloud::machine_api::tests
//! ├── cloud::machine_api_error
//! ├── cloud::paths
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::rules
//! ├── cloud::protocol::signing
//! ├── cloud::revocation
//! └── cloud::signed_request
//! External: serde, serde_json, std, tracing, ureq, url
//!
//! Used by:
//! cloud/machine_api.rs
//! ├── cloud
//! ├── cloud::actions
//! ├── cloud::cli
//! ├── cloud::cli::tests
//! ├── cloud::leg_identity
//! ├── cloud::login
//! ├── cloud::login_session
//! ├── cloud::machine_api::tests
//! ├── cloud::push_link
//! ├── cloud::status
//! ├── yaran-core[test cloud_login]
//! ├── yaran-core[test cloud_machine_api]
//! ├── yaran-core[test cloud_push_emitter]
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_tests
//! ├── yaran-web::cloud_routes
//! ├── yaran-web::cloud_routes::actions_routes
//! └── yaran-web::cloud_routes::tests
//! <module-headers:end>

use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::cloud::credentials::{self, Credentials};
use crate::cloud::identity::MachineIdentity;
pub use crate::cloud::machine_api_error::MachineApiError;
use crate::cloud::machine_api_error::{map_error, server_text};
use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::{
    ClaimRequest, ClaimResponse, EventBatch, EventBatchResult, MachineConfig, OriginUpdate,
    OriginUpdateResult, RotateReason, RotateRequest, RotateResponse, TeardownStarted,
};
use crate::cloud::protocol::meta::Meta;
use crate::cloud::protocol::rules::Validate;
use crate::cloud::protocol::signing::RequestParts;
use crate::cloud::protocol::{PROTOCOL_MAX, negotiate};
use crate::cloud::revocation::RevocationSignal;
use crate::cloud::signed_request::{self, body_bytes};

/// The response body cap.
pub const MAX_BODY_BYTES: u64 = 64 * 1024;

/// Builds the client for an org; injectable so tests can point it at a mock Worker.
pub type ApiFactory =
    std::sync::Arc<dyn Fn(&str, &CloudPaths) -> Result<MachineApi, MachineApiError> + Send + Sync>;

/// The production factory: HTTPS to the org itself, `request_timeout` per request.
pub fn default_api_factory(request_timeout: Duration) -> ApiFactory {
    std::sync::Arc::new(move |org, paths| MachineApi::new(org, paths, request_timeout))
}

/// A factory sending every request to `base` (a loopback mock Worker).
#[cfg(any(test, feature = "test-support"))]
pub fn test_api_factory(base: String) -> ApiFactory {
    std::sync::Arc::new(move |org, paths| {
        Ok(MachineApi::new(org, paths, Duration::from_secs(5))?.with_test_transport(&base))
    })
}

/// What W8 did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unpaired {
    /// `202 TeardownStarted`.
    TeardownStarted,
    /// `410 machine_revoked`: already gone; yaran forgets its credentials all the same.
    AlreadyRevoked,
}

/// A control-plane client for one org.
pub struct MachineApi {
    org_url: String,
    transport: String,
    agent: ureq::Agent,
    paths: CloudPaths,
}

fn agent(timeout: Duration, loopback: bool) -> ureq::Agent {
    let mut builder = ureq::Agent::config_builder()
        .timeout_connect(Some(timeout))
        .timeout_global(Some(timeout))
        .http_status_as_error(false);
    if loopback {
        builder = builder.proxy(None);
    }
    builder.build().into()
}

impl MachineApi {
    /// A client for `org_url` (an https origin), keeping credentials under `paths`.
    pub fn new(
        org_url: &str,
        paths: &CloudPaths,
        timeout: Duration,
    ) -> Result<Self, MachineApiError> {
        if !org_url.starts_with("https://") {
            return Err(MachineApiError::Malformed(format!(
                "{} is not an https control-plane URL",
                server_text(org_url)
            )));
        }
        Ok(Self {
            org_url: org_url.to_string(),
            transport: org_url.to_string(),
            agent: agent(timeout, false),
            paths: paths.clone(),
        })
    }

    /// A client for the org this machine is paired with.
    pub fn paired(paths: &CloudPaths, timeout: Duration) -> Result<Self, MachineApiError> {
        let creds = credentials::read(paths)?.ok_or(MachineApiError::NotPaired)?;
        Self::new(&creds.org_url, paths, timeout)
    }

    /// Send requests to `base` (e.g. a loopback mock Worker) instead of the org URL.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_test_transport(mut self, base: &str) -> Self {
        let timeout = Duration::from_secs(5);
        self.transport = base.trim_end_matches('/').to_string();
        self.agent = agent(timeout, true);
        self
    }

    pub fn org_url(&self) -> &str {
        &self.org_url
    }

    pub fn paths(&self) -> &CloudPaths {
        &self.paths
    }

    /// W1: the org's self-description, with the protocol negotiated.
    pub fn meta(&self) -> Result<Meta, MachineApiError> {
        let meta: Meta = self.exchange("GET", "/v1/meta", None, Vec::new())?;
        negotiate(crate::cloud::protocol::CLIENT_RANGE, meta.protocol).map_err(|_| {
            MachineApiError::ProtocolUnsupported {
                min: meta.protocol.min,
                max: meta.protocol.max,
                ours: PROTOCOL_MAX,
            }
        })?;
        Ok(meta)
    }

    /// W4: redeem a pair code with the key named at authorize.
    pub fn claim(
        &self,
        identity: &MachineIdentity,
        request: &ClaimRequest,
    ) -> Result<ClaimResponse, MachineApiError> {
        self.exchange(
            "POST",
            "/v1/machine/claim",
            Some((identity, None)),
            body_bytes(Some(request)),
        )
    }

    /// W5: the machine's config (never the token).
    pub fn config(&self) -> Result<MachineConfig, MachineApiError> {
        self.signed("GET", "/v1/machine/config", Vec::new())
            .map(|(_, c)| c)
    }

    /// W7: rotate (`User`) or fetch a newer token (`Sync`); stores the answer.
    pub fn rotate(&self, reason: RotateReason) -> Result<RotateResponse, MachineApiError> {
        let creds = self.credentials()?;
        let body = body_bytes(Some(&RotateRequest {
            known_token_version: creds.token_version,
            reason,
        }));
        let (machine_id, resp): (String, RotateResponse) =
            self.signed("POST", "/v1/machine/rotate", body)?;
        credentials::update(&self.paths, |c| {
            Ok(c.map(|mut c| {
                if c.machine_id == machine_id {
                    c.tunnel_token = resp.tunnel.token.clone();
                    c.token_version = resp.tunnel.token_version;
                }
                c
            }))
        })?;
        Ok(resp)
    }

    /// W8: start teardown. A `410` counts as done.
    pub fn unpair(&self) -> Result<Unpaired, MachineApiError> {
        match self.signed::<TeardownStarted>("POST", "/v1/machine/unpair", Vec::new()) {
            Ok(_) => Ok(Unpaired::TeardownStarted),
            Err(MachineApiError::Revoked) => Ok(Unpaired::AlreadyRevoked),
            Err(e) => Err(e),
        }
    }

    /// W32: retarget the ingress to `port`; stores the answer's `origin_port`.
    pub fn set_origin(&self, port: u16) -> Result<OriginUpdateResult, MachineApiError> {
        let body = body_bytes(Some(&OriginUpdate {
            origin_port: i64::from(port),
        }));
        let (machine_id, resp): (String, OriginUpdateResult) =
            self.signed("PUT", "/v1/machine/origin", body)?;
        let stored = u16::try_from(resp.origin_port).unwrap_or(port);
        credentials::update(&self.paths, |c| {
            Ok(c.map(|mut c| {
                if c.machine_id == machine_id {
                    c.origin_port = stored;
                }
                c
            }))
        })?;
        Ok(resp)
    }

    /// W6: deliver attention events (Phase 12).
    pub fn events(&self, batch: &EventBatch) -> Result<EventBatchResult, MachineApiError> {
        self.signed("POST", "/v1/machine/events", body_bytes(Some(batch)))
            .map(|(_, r)| r)
    }

    fn credentials(&self) -> Result<Credentials, MachineApiError> {
        credentials::read(&self.paths)?.ok_or(MachineApiError::NotPaired)
    }

    /// A signed machine call; returns the machine id it was signed for and the answer.
    fn signed<T: DeserializeOwned + Validate>(
        &self,
        method: &str,
        path: &str,
        body: Vec<u8>,
    ) -> Result<(String, T), MachineApiError> {
        let creds = self.credentials()?;
        let identity = MachineIdentity::from_pkcs8(&creds.machine_key_der()?).map_err(|e| {
            MachineApiError::Credentials(credentials::CredentialsError::Malformed(e))
        })?;
        let result = self.exchange(
            method,
            path,
            Some((&identity, Some(&creds.machine_id))),
            body,
        );
        if matches!(result, Err(MachineApiError::Revoked)) {
            RevocationSignal::global().raise();
            if let Err(e) = credentials::stamp_revoked(&self.paths) {
                tracing::warn!(target: "yaran::cloud", error = %e, "could not stamp revoked_at");
            }
        }
        result.map(|r| (creds.machine_id, r))
    }

    fn exchange<T: DeserializeOwned + Validate>(
        &self,
        method: &str,
        path: &str,
        sign: Option<(&MachineIdentity, Option<&str>)>,
        body: Vec<u8>,
    ) -> Result<T, MachineApiError> {
        let url = format!("{}{path}", self.transport);
        let host = url::Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        let mut headers: Vec<(String, String)> = Vec::new();
        let body = match sign {
            Some((identity, machine_id)) => {
                let parts = RequestParts {
                    method,
                    path,
                    host: &host,
                    protocol: PROTOCOL_MAX as u32,
                    machine_id,
                };
                let signed = signed_request::prepare(identity.key_pair(), &parts, body)
                    .map_err(|e| MachineApiError::Malformed(e.to_string()))?;
                headers.extend(
                    signed
                        .headers
                        .pairs()
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string())),
                );
                signed.body
            }
            None => body,
        };
        let sent = self.send(method, &url, &headers, body);
        let mut response = match sent {
            Ok(r) => r,
            Err(e) => {
                let why = server_text(&e.to_string());
                tracing::warn!(target: "yaran::cloud", method, path, error = %why, "control-plane request failed");
                return Err(MachineApiError::Network(why));
            }
        };
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let (retry_after, date, header_id) = (
            header("Retry-After"),
            header("Date"),
            header("Yaran-Request-Id"),
        );
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .map_err(|e| MachineApiError::Malformed(server_text(&e.to_string())))?;
        if (200..300).contains(&status) {
            tracing::info!(target: "yaran::cloud", method, path, status, "control-plane request");
            let value: T = serde_json::from_str(&text)
                .map_err(|e| MachineApiError::Malformed(server_text(&e.to_string())))?;
            value
                .validate()
                .map_err(|e| MachineApiError::Malformed(e.to_string()))?;
            return Ok(value);
        }
        let (err, body_id) = map_error(
            status,
            &text,
            retry_after.as_deref(),
            date.as_deref(),
            PROTOCOL_MAX,
        );
        let request_id = body_id
            .or_else(|| header_id.as_deref().map(server_text))
            .unwrap_or_default();
        tracing::warn!(target: "yaran::cloud", method, path, status, request_id = %request_id, error = %err, "control-plane request refused");
        Err(err)
    }

    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        macro_rules! with_headers {
            ($req:expr) => {{
                let mut req = $req;
                for (k, v) in headers {
                    req = req.header(k.as_str(), v.as_str());
                }
                req
            }};
        }
        match method {
            "GET" => with_headers!(self.agent.get(url)).call(),
            "PUT" => with_headers!(self.agent.put(url))
                .header("Content-Type", "application/json")
                .send(&body[..]),
            _ if body.is_empty() => with_headers!(self.agent.post(url)).send_empty(),
            _ => with_headers!(self.agent.post(url))
                .header("Content-Type", "application/json")
                .send(&body[..]),
        }
    }
}

#[cfg(test)]
#[path = "machine_api_tests.rs"]
mod tests;

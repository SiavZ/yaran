//! What the emitter needs from the machine's identity: pairing state, the signed client
//! and the revocation signal.
//!
//! `MachineLink` is the four things the `cloud-push` thread needs (read the org name from
//! the credentials at flush time, signed W5 `GET /v1/machine/config`, signed W6
//! `POST /v1/machine/events`, raise the `RevocationSignal`). `PairedLink` is the
//! production implementation over the credentials store and `MachineApi`; tests drive the
//! emitter with a fake link.
//!
//! - Runs on the `cloud-push` thread only, never the engine tick.
//! - Server text is sanitized and truncated by `MachineApi` and again in `describe`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_link.rs
//! ├── cloud::credentials
//! ├── cloud::machine_api
//! ├── cloud::paths
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::push_emitter
//! ├── cloud::revocation
//! └── sanitize
//! External: std, tempfile
//!
//! Used by:
//! cloud/push_link.rs
//! ├── cloud
//! ├── cloud::push_emitter
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_runner
//! ├── engine::push_hook
//! └── yaran-core[test cloud_push_emitter]
//! <module-headers:end>

use std::sync::Arc;
use std::time::Duration;

use super::credentials;
pub use super::machine_api::MachineApiError;
use super::machine_api::{ApiFactory, MachineApi, default_api_factory};
use super::paths::CloudPaths;
use super::protocol::ErrorCode;
use super::protocol::machine::{EventBatch, EventBatchResult, MachineConfig};
use super::revocation::RevocationSignal;

/// A short sanitized sentence fragment for statuses and logs.
pub fn describe(err: &MachineApiError) -> String {
    crate::sanitize::truncate(&err.to_string(), 200)
}

/// Whether an answer says this machine is no longer paired (`machine_unknown` included).
pub fn says_revoked(err: &MachineApiError) -> bool {
    match err {
        MachineApiError::Revoked => true,
        MachineApiError::Refused { code, .. } => {
            ErrorCode::parse(code) == ErrorCode::MachineUnknown
        }
        MachineApiError::ProtocolUnsupported { .. }
        | MachineApiError::ClockSkew { .. }
        | MachineApiError::Server { .. }
        | MachineApiError::Network(_)
        | MachineApiError::Malformed(_)
        | MachineApiError::NotPaired
        | MachineApiError::Credentials(_) => false,
    }
}

/// What the emitter needs from the identity.
pub trait MachineLink: Send {
    /// The paired org's name, read from the credentials now; `None` when unpaired.
    fn org_name(&mut self) -> Option<String>;
    fn machine_config(&mut self) -> Result<MachineConfig, MachineApiError>;
    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, MachineApiError>;
    /// Raise the process-wide `RevocationSignal` (the cloud leg stops on it).
    fn report_revoked(&mut self);
}

/// The production link: a client for whatever org the credentials name, built per call so
/// a re-pair is picked up at the next flush.
pub struct PairedLink {
    pub paths: CloudPaths,
    pub api: ApiFactory,
}

impl PairedLink {
    fn api(&self) -> Result<MachineApi, MachineApiError> {
        let creds = credentials::read(&self.paths)?.ok_or(MachineApiError::NotPaired)?;
        (self.api)(&creds.org_url, &self.paths)
    }
}

impl MachineLink for PairedLink {
    fn org_name(&mut self) -> Option<String> {
        credentials::read(&self.paths)
            .ok()
            .flatten()
            .map(|c| c.org_name)
    }

    fn machine_config(&mut self) -> Result<MachineConfig, MachineApiError> {
        self.api()?.config()
    }

    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, MachineApiError> {
        self.api()?.events(batch)
    }

    fn report_revoked(&mut self) {
        RevocationSignal::global().raise();
    }
}

/// The factory the engine's emitter starts each `cloud-push` thread with.
pub fn paired_link_factory(
    root: &std::path::Path,
    request_timeout: Duration,
) -> super::push_emitter::LinkFactory {
    let paths = CloudPaths::from_root(root);
    let api = default_api_factory(request_timeout);
    Arc::new(move || {
        Box::new(PairedLink {
            paths: paths.clone(),
            api: api.clone(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_unknown_reads_as_revoked_and_nothing_else_does() {
        let refused = |code: &str| MachineApiError::Refused {
            code: code.into(),
            message: "m".into(),
            retry_after: None,
        };
        assert!(says_revoked(&MachineApiError::Revoked));
        assert!(says_revoked(&refused("machine_unknown")));
        assert!(!says_revoked(&refused("rate_limited")));
        assert!(!says_revoked(&MachineApiError::NotPaired));
    }

    #[test]
    fn an_unpaired_link_names_no_org_and_sends_nothing() {
        let root = tempfile::tempdir().unwrap();
        let mut link = PairedLink {
            paths: CloudPaths::from_root(root.path()),
            api: default_api_factory(Duration::from_secs(1)),
        };
        assert_eq!(link.org_name(), None);
        assert!(matches!(
            link.machine_config(),
            Err(MachineApiError::NotPaired)
        ));
    }
}

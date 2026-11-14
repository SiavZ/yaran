//! The confirmed actions every surface runs: logout, token rotation, consent-key rotation.
//!
//! The CLI, the TUI palette and the web dialog confirm first (each its own way), then
//! call one of these and report the returned outcome through
//! `CloudActionOutcome::report`, so behaviour and words match on all three.
//!
//! - Blocking (credentials I/O, and a signed request except for the consent key):
//!   worker or CLI threads only.
//!
//! <module-headers:begin>
//! <module-headers:end>

use crate::cloud::credentials::{self, CredentialsError};
use crate::cloud::machine_api::{ApiFactory, Unpaired};
use crate::cloud::outcome::CloudActionOutcome;
use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::RotateReason;

fn unreadable(e: CredentialsError) -> CloudActionOutcome {
    CloudActionOutcome::CredentialsUnreadable {
        reason: e.to_string(),
    }
}

/// Unpair (W8) and delete the credentials on 202 or 410. A failed request keeps the
/// credentials and returns its outcome. `local_only` never contacts the control plane
/// and also forgets an unreadable file.
pub fn logout(paths: &CloudPaths, api: &ApiFactory, local_only: bool) -> CloudActionOutcome {
    let creds = match credentials::read(paths) {
        Ok(Some(c)) => Some(c),
        Ok(None) => return CloudActionOutcome::NotPaired,
        Err(_) if local_only => None,
        Err(e) => return unreadable(e),
    };
    let hostname = creds
        .as_ref()
        .map_or_else(|| "this machine".to_string(), |c| c.hostname.clone());
    if !local_only && let Some(c) = &creds {
        match api(&c.org_url, paths).and_then(|api| api.unpair()) {
            Ok(Unpaired::TeardownStarted | Unpaired::AlreadyRevoked) => {}
            Err(e) => return CloudActionOutcome::from_api_error(e, &hostname),
        }
    }
    if let Err(e) = credentials::delete(paths) {
        return unreadable(e);
    }
    if local_only {
        CloudActionOutcome::UnpairedLocallyOnly { hostname }
    } else {
        CloudActionOutcome::Unpaired { hostname }
    }
}

/// Rotate the tunnel token (W7, `reason: user`). The consent key is untouched.
pub fn rotate_token(paths: &CloudPaths, api: &ApiFactory) -> CloudActionOutcome {
    let creds = match credentials::read(paths) {
        Ok(Some(c)) => c,
        Ok(None) => return CloudActionOutcome::NotPaired,
        Err(e) => return unreadable(e),
    };
    match api(&creds.org_url, paths).and_then(|api| api.rotate(RotateReason::User)) {
        Ok(_) => CloudActionOutcome::Rotated {
            hostname: creds.hostname,
        },
        Err(e) => CloudActionOutcome::from_api_error(e, &creds.hostname),
    }
}

/// Replace the D24 consent key locally (no network call).
pub fn rotate_consent_key(paths: &CloudPaths) -> CloudActionOutcome {
    match credentials::rotate_consent_key(paths) {
        Ok(Some(c)) => CloudActionOutcome::ConsentKeyRotated {
            hostname: c.hostname,
        },
        Ok(None) => CloudActionOutcome::NotPaired,
        Err(e) => unreadable(e),
    }
}

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
//! ```text
//! Uses:
//! cloud/actions.rs
//! ├── cloud::credentials
//! ├── cloud::machine_api
//! ├── cloud::outcome
//! ├── cloud::paths
//! ├── cloud::protocol::machine
//! └── cloud::test_support
//! External: serde_json, tempfile
//!
//! Used by:
//! cloud/actions.rs
//! ├── cloud
//! ├── cloud::cli::manage
//! ├── yaran-tui::app::cloud_commands
//! └── yaran-web::cloud_routes::actions_routes
//! ```
//! <module-headers:end>

use crate::cloud::credentials::{self, CredentialsError};
use crate::cloud::machine_api::{ApiFactory, Unpaired};
use crate::cloud::outcome::CloudActionOutcome;
use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::RotateReason;

/// Whether a logout tells the control plane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogoutScope {
    /// Unpair with the control plane, then forget the credentials.
    ControlPlane,
    /// Forget the credentials here without telling anyone.
    LocalOnly,
}

fn unreadable(e: &CredentialsError) -> CloudActionOutcome {
    CloudActionOutcome::CredentialsUnreadable {
        reason: e.to_string(),
    }
}

/// Unpair (W8) and delete the credentials on 202 or 410, unless a login replaced them
/// meanwhile (`PairingChanged`). A failed request keeps the credentials and returns its
/// outcome. [`LogoutScope::LocalOnly`] never contacts the control plane
/// and also forgets an unreadable file.
pub fn logout(paths: &CloudPaths, api: &ApiFactory, scope: LogoutScope) -> CloudActionOutcome {
    let local_only = scope == LogoutScope::LocalOnly;
    let creds = match credentials::read(paths) {
        Ok(Some(c)) => Some(c),
        Ok(None) => return CloudActionOutcome::NotPaired,
        Err(_) if local_only => None,
        Err(e) => return unreadable(&e),
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
    let forgotten = match &creds {
        // Only the pairing just unpaired: one a login made meanwhile is kept.
        Some(signed_for) => credentials::update(paths, |current| match current {
            Some(c) if !c.same_pairing(signed_for) => Ok(Some(c)),
            _ => Ok(None),
        })
        .map(|kept| kept.is_none()),
        None => credentials::delete(paths).map(|()| true),
    };
    match forgotten {
        Ok(true) => {}
        Ok(false) => return CloudActionOutcome::PairingChanged,
        Err(e) => return unreadable(&e),
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
        Err(e) => return unreadable(&e),
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
        Err(e) => unreadable(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::machine_api::test_api_factory;
    use crate::cloud::test_support::{
        MockResponse, MockWorker, SAMPLE_MACHINE_ID, SAMPLE_ORG, pair_sample, sample_credentials,
    };

    #[test]
    fn a_logout_never_deletes_a_pairing_made_while_it_ran() {
        let root = tempfile::tempdir().unwrap();
        let paths = CloudPaths::from_root(root.path());
        pair_sample(&paths, SAMPLE_ORG);
        let mut fresh = sample_credentials(SAMPLE_ORG);
        fresh.machine_id = "22afdb39-9d90-49a8-9ef5-b9482c1bdf61".into();
        let (repair_paths, repaired) = (paths.clone(), fresh.clone());
        let worker = MockWorker::start(move |_| {
            credentials::update(&repair_paths, |_| Ok(Some(repaired.clone()))).unwrap();
            let body =
                serde_json::json!({"machine_id": SAMPLE_MACHINE_ID, "state": "tearing_down"});
            MockResponse::json(202, &body)
        });
        let out = logout(
            &paths,
            &test_api_factory(worker.base_url()),
            LogoutScope::ControlPlane,
        );
        assert_eq!(out, CloudActionOutcome::PairingChanged);
        assert_eq!(credentials::read(&paths).unwrap(), Some(fresh));
    }
}

//! The browser login (D7): one engine-free function the CLI, TUI and web all drive.
//!
//! normalize org URL, `GET /v1/meta`, refuse a different paired org, generate the
//! machine key, PKCE verifier and state, bind the loopback listener, build the
//! authorize URL, open the browser (a failure only shows the URL, 19 hook H1), then take
//! the first of: the loopback callback, a pasted callback address, cancel, timeout.
//! Then the signed claim, a freshly minted D24 consent key, and one atomic credentials
//! write. Old credentials are replaced only after a successful claim.
//!
//! - Blocking: runs on a worker or CLI thread. `LoginIo` is how a front end sees it.
//! - The listener lives only for the duration of the call (RFC 8252 §8.3).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/login.rs
//! ├── cloud::credentials
//! ├── cloud::identity
//! ├── cloud::loopback
//! ├── cloud::machine_api
//! ├── cloud::machine_api_error
//! ├── cloud::org_url
//! ├── cloud::outcome
//! ├── cloud::paths
//! ├── cloud::pkce
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::pairing
//! └── cloud::protocol::rules
//! External: chrono, std, url
//!
//! Used by:
//! cloud/login.rs
//! ├── cloud
//! ├── cloud::cli::login
//! ├── cloud::login_session
//! ├── yaran-core[test cloud_login]
//! ├── yaran-tui::app::cloud_commands
//! └── yaran-web::cloud_routes
//! <module-headers:end>

use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use crate::cloud::credentials::{self, Credentials, HandoffConsentKey};
use crate::cloud::identity::{MachineIdentity, check_machine_name, default_machine_name};
use crate::cloud::loopback::{CallbackResult, LoopbackListener, parse_pasted_callback};
use crate::cloud::machine_api::{ApiFactory, MachineApiError};
use crate::cloud::machine_api_error::server_text;
use crate::cloud::org_url::normalize_org_url;
use crate::cloud::outcome::CloudActionOutcome;
use crate::cloud::paths::CloudPaths;
use crate::cloud::pkce::Pkce;
use crate::cloud::protocol::machine::ClaimRequest;
use crate::cloud::protocol::meta::SetupState;
use crate::cloud::protocol::pairing::{CODE_CHALLENGE_METHOD, PairAuthorizeQuery};
use crate::cloud::protocol::rules::Validate;

/// How often the wait checks the listener, the paste channel, cancel and timeout.
pub const POLL: Duration = Duration::from_millis(250);

/// What a login needs.
pub struct LoginParams {
    /// As typed; normalized here.
    pub org_url: String,
    /// `--name`; `None` uses the slugified short hostname.
    pub machine_name: Option<String>,
    /// The effective `[server] port`, sent at authorize and in the claim.
    pub origin_port: u16,
    pub timeout: Duration,
    pub paths: CloudPaths,
    pub api: ApiFactory,
}

/// Progress a front end may show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginStep {
    CheckingOrg {
        org_url: String,
    },
    /// The browser could not be opened; the URL was shown, keep waiting.
    BrowserUnavailable {
        url: String,
    },
    Waiting,
    /// A pasted address was not this login's callback; keep waiting.
    PasteRejected {
        reason: String,
    },
    Claiming,
}

/// The front end's side of a login.
pub trait LoginIo {
    fn open_browser(&mut self, url: &str) -> Result<(), String>;
    /// Show the authorize URL and the fingerprint the confirm page must match.
    fn show_authorize(&mut self, url: &str, fingerprint: &str, org_name: &str, machine_name: &str);
    /// A channel of pasted callback addresses; may never yield.
    fn pasted_callback(&mut self) -> Receiver<String>;
    fn cancelled(&mut self) -> bool;
    fn progress(&mut self, step: LoginStep);
}

pub type LoginOutcome = CloudActionOutcome;

fn claim_refusal(err: MachineApiError) -> CloudActionOutcome {
    match err {
        MachineApiError::Refused { code, message, .. } => {
            CloudActionOutcome::ClaimRefused { code, message }
        }
        other => CloudActionOutcome::from_api_error(other, ""),
    }
}

/// The authorize URL for `query` (02 §6 W2).
pub fn authorize_url(org_url: &str, query: &PairAuthorizeQuery) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("v", &query.v.to_string())
        .append_pair("state", &query.state)
        .append_pair("code_challenge", &query.code_challenge)
        .append_pair("code_challenge_method", &query.code_challenge_method)
        .append_pair("machine_pubkey", &query.machine_pubkey)
        .append_pair("machine_name", &query.machine_name)
        .append_pair("callback", &query.callback)
        .append_pair("yaran_version", &query.yaran_version);
    if let Some(port) = query.origin_port {
        q.append_pair("origin_port", &port.to_string());
    }
    format!("{org_url}/v1/pair/authorize?{}", q.finish())
}

/// Run one login to completion.
pub fn run_login(params: LoginParams, io: &mut dyn LoginIo) -> LoginOutcome {
    let org_url = match normalize_org_url(&params.org_url) {
        Ok(u) => u,
        Err(reason) => return CloudActionOutcome::InvalidInput { reason },
    };
    let machine_name = match params.machine_name {
        Some(name) => match check_machine_name(&name) {
            Ok(()) => name,
            Err(reason) => return CloudActionOutcome::InvalidInput { reason },
        },
        None => default_machine_name(),
    };
    match credentials::read(&params.paths) {
        Ok(Some(c)) if c.org_url != org_url => {
            return CloudActionOutcome::AlreadyPairedElsewhere { org: c.org_name };
        }
        Ok(_) => {}
        Err(e) => {
            return CloudActionOutcome::CredentialsUnreadable {
                reason: e.to_string(),
            };
        }
    }
    io.progress(LoginStep::CheckingOrg {
        org_url: org_url.clone(),
    });
    let api = match (params.api)(&org_url, &params.paths) {
        Ok(api) => api,
        Err(e) => return CloudActionOutcome::from_api_error(e, ""),
    };
    let meta = match api.meta() {
        Ok(m) => m,
        Err(e) => return CloudActionOutcome::from_api_error(e, ""),
    };
    if meta.setup != SetupState::Closed {
        return CloudActionOutcome::ClaimRefused {
            code: "setup_incomplete".into(),
            message: "the organization has not finished its Yaran Cloud setup yet".into(),
        };
    }
    let org_name = meta
        .org
        .as_ref()
        .map_or_else(|| org_url.clone(), |o| server_text(&o.name));

    let (identity, pkce, listener) = match (
        MachineIdentity::generate(),
        Pkce::generate(),
        LoopbackListener::bind(),
    ) {
        (Ok(i), Ok(p), Ok(l)) => (i, p, l),
        (Err(e), _, _) | (_, Err(e), _) => return CloudActionOutcome::Network { detail: e },
        (_, _, Err(e)) => {
            return CloudActionOutcome::Network {
                detail: format!("could not listen on 127.0.0.1 for the browser's answer: {e}"),
            };
        }
    };
    let yaran_version = env!("CARGO_PKG_VERSION").to_string();
    let query = PairAuthorizeQuery {
        v: crate::cloud::protocol::PROTOCOL_MAX,
        state: pkce.state.clone(),
        code_challenge: pkce.challenge.clone(),
        code_challenge_method: CODE_CHALLENGE_METHOD.to_string(),
        machine_pubkey: identity.public_key_b64(),
        machine_name: machine_name.clone(),
        callback: listener.callback_url(),
        yaran_version: yaran_version.clone(),
        origin_port: Some(i64::from(params.origin_port)),
    };
    if let Err(e) = query.validate() {
        return CloudActionOutcome::InvalidInput {
            reason: e.to_string(),
        };
    }
    let url = authorize_url(&org_url, &query);
    io.show_authorize(&url, &identity.fingerprint(), &org_name, &machine_name);
    if io.open_browser(&url).is_err() {
        io.progress(LoginStep::BrowserUnavailable { url: url.clone() });
    }
    io.progress(LoginStep::Waiting);

    let pasted = io.pasted_callback();
    let deadline = Instant::now() + params.timeout;
    let result = loop {
        if io.cancelled() {
            return CloudActionOutcome::LoginCancelled;
        }
        if let Some(r) = listener.poll(&pkce.state) {
            break r;
        }
        match pasted.try_recv() {
            Ok(text) => match parse_pasted_callback(&text, listener.port(), &pkce.state) {
                Ok(r) => break r,
                Err(reason) => io.progress(LoginStep::PasteRejected { reason }),
            },
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
        }
        if Instant::now() >= deadline {
            return CloudActionOutcome::LoginTimedOut;
        }
        std::thread::sleep(POLL);
    };
    drop(listener);
    let code = match result {
        CallbackResult::Code(code) => code,
        CallbackResult::Denied(code) => {
            return CloudActionOutcome::ClaimRefused {
                code,
                message: "the pairing was not approved in the browser".into(),
            };
        }
    };

    io.progress(LoginStep::Claiming);
    let request = ClaimRequest {
        code,
        code_verifier: pkce.verifier.clone(),
        yaran_version,
        origin_port: i64::from(params.origin_port),
    };
    let mut claim = match api.claim(&identity, &request) {
        Ok(c) => c,
        Err(e) => return claim_refusal(e),
    };
    // Server text crossed a trust boundary; it is shown on every surface (T53).
    claim.org.name = server_text(&claim.org.name);
    let paired_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let stored = credentials::update(&params.paths, |previous| {
        let same_org = previous.filter(|p| p.org_url == claim.org.url);
        let consent = HandoffConsentKey::for_claim(same_org.as_ref())?;
        Ok(Some(Credentials::from_claim(
            &claim,
            identity.pkcs8(),
            &consent,
            paired_at,
        )))
    });
    match stored {
        Ok(_) => CloudActionOutcome::Paired {
            hostname: claim.hostname,
            org_name: claim.org.name,
        },
        Err(e) => CloudActionOutcome::CredentialsUnreadable {
            reason: e.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_authorize_url_carries_every_query_field() {
        let q = PairAuthorizeQuery {
            v: 1,
            state: "s".repeat(43),
            code_challenge: "c".repeat(43),
            code_challenge_method: "S256".into(),
            machine_pubkey: "k".repeat(43),
            machine_name: "laptop".into(),
            callback: "http://127.0.0.1:53682/callback".into(),
            yaran_version: "0.1.0".into(),
            origin_port: Some(3890),
        };
        let url = authorize_url("https://cloud.example.com", &q);
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/v1/pair/authorize");
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs["callback"], "http://127.0.0.1:53682/callback");
        assert_eq!(pairs["origin_port"], "3890");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs.len(), 9);
    }
}

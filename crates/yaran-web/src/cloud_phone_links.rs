//! The phone app's two ways to a machine that do not need a pairing code:
//! `GET /api/v1/phone/machine-qr` (add this machine directly, by its HTTPS address) and
//! `GET /api/v1/phone/link-target` (what a "Copy phone link" names).
//!
//! - machine-qr answers `{host, uri, svg}`: `yaranapp://add-machine?u=https://<host>`
//!   for the Host this request arrived on, drawn by the shared QR encoder. Only for a
//!   transport yaran itself knows is HTTPS (a confirmed `tailscale serve` HTTPS route or
//!   a Funnel; never a client's `X-Forwarded-Proto`), a public DNS name on the default
//!   port, and never the Cloud Connect hostname (a phone adds that through its org).
//!   Otherwise 409 `{error, message}` saying why and what to do instead.
//! - link-target answers `{publisher_domain, target}` for the browser to build
//!   `https://<publisher_domain>/open#…` with `agentLinkUrl`, synchronously inside the
//!   click that copies it. An org target when this machine is paired and its org's
//!   `MachineConfig` names a publisher domain; else a direct target when this machine's
//!   own `[cloud] app_callback_urls` implies one and the request passes the machine-qr
//!   rules. Otherwise 409. The domain is configuration, never invented; nothing here is
//!   a credential, and a link proves nothing about who opens it.
//! - The org's answer is cached per pairing for ten minutes; the W5 call runs off the
//!   runtime. Answer and cache are bound to one pairing snapshot: the credentials file is
//!   read before W5 and again after it, and only an unchanged pairing is cached or
//!   answered for. A re-pair in between is retried once, then refused in words, so a link
//!   never pairs one org's domain with another pairing's machine.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud_phone_links.rs
//! ├── auth
//! ├── cloud_phone_links::tests
//! ├── server
//! ├── yaran-core::cloud::credentials
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::protocol::links
//! ├── yaran-core::cloud::push_link
//! └── yaran-core::cloud::qr
//! External: axum, serde, serde_json, std, tokio
//!
//! Used by:
//! cloud_phone_links.rs
//! ├── cloud_phone_links::tests
//! ├── crate
//! └── server
//! ```
//! <module-headers:end>

use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    Extension, Json, Router,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use serde_json::json;
use yaran_core::cloud::credentials;
use yaran_core::cloud::machine_api::MachineApi;
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::protocol::links::{
    AgentLink, AgentLinkTarget, add_machine_uri, agent_link_url, is_public_host,
    publisher_domain_from_callbacks,
};
use yaran_core::cloud::push_link::describe;
use yaran_core::cloud::qr::Qr;

use crate::auth::RequestAuth;
use crate::server::AppState;

/// Pixels per QR module, as the org code uses.
const MODULE_PX: u32 = 4;
/// How long an org's publisher domain is reused before W5 is asked again.
const ORG_DOMAIN_TTL: Duration = Duration::from_secs(600);

/// The phone routes, merged into the main router.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/phone/machine-qr", get(get_machine_qr))
        .route("/api/v1/phone/link-target", get(get_link_target))
}

/// What the request itself proves about how a phone could reach this machine.
#[derive(Clone, Debug)]
pub(crate) struct Arrived {
    /// The `Host` header, as sent (the host guard has already allowed it).
    pub(crate) host: Option<String>,
    /// Whether yaran knows the transport was HTTPS (serve HTTPS route or Funnel).
    pub(crate) https: bool,
}

/// The unrevoked pairing, when there is one. Equal snapshots are the same pairing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Paired {
    pub(crate) org_url: String,
    pub(crate) machine_id: String,
    /// The Cloud Connect hostname.
    pub(crate) hostname: String,
    /// When this pairing was made; a re-pair to the same machine id still differs here.
    pub(crate) made_at: String,
}

/// A refusal: a stable code for the browser and a sentence for the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        no_store(
            StatusCode::CONFLICT,
            json!({ "error": self.code, "message": self.message }),
        )
    }
}

fn no_store(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

/// The host a phone may add this machine by, from what the request proves.
pub(crate) fn direct_host(arrived: &Arrived, paired: Option<&Paired>) -> Result<String, Refusal> {
    if !arrived.https {
        return Err(refuse(
            "not_https",
            "This page did not reach yaran over an HTTPS address yaran can vouch for, and the \
             phone app only opens machines over HTTPS. Open this page through tailscale serve \
             (or a Tailscale Funnel) and try again; behind your own HTTPS proxy, type its \
             address into the app instead.",
        ));
    }
    let host = arrived.host.as_deref().unwrap_or_default();
    if !is_public_host(host) {
        return Err(refuse(
            "not_a_public_host",
            "This page's address is not a DNS name on the default HTTPS port, so a phone \
             could not open it. Open this page through its tailscale serve name and try again.",
        ));
    }
    if paired.is_some_and(|p| p.hostname == host) {
        return Err(refuse(
            "cloud_hostname",
            "This is the machine's Cloud Connect address, which a phone opens through its \
             organisation, never as a machine of its own. Use the organisation code instead.",
        ));
    }
    Ok(host.to_string())
}

#[derive(Serialize, Debug)]
struct MachineQr {
    host: String,
    uri: String,
    svg: String,
}

/// The add-machine code for this request, or why there is none.
pub(crate) fn machine_qr(arrived: &Arrived, paired: Option<&Paired>) -> Result<Response, Refusal> {
    let host = direct_host(arrived, paired)?;
    let uri = add_machine_uri(&host).ok_or_else(|| {
        refuse(
            "not_a_public_host",
            "This address cannot go in a phone code.",
        )
    })?;
    let svg = Qr::encode(&uri)
        .map(|qr| qr.to_svg(MODULE_PX))
        .map_err(|_| refuse("qr_failed", "yaran could not draw the phone code."))?;
    Ok(no_store(
        StatusCode::OK,
        json!(MachineQr { host, uri, svg }),
    ))
}

/// What an org's W5 said about the publisher domain, or why it could not be asked.
pub(crate) type OrgDomain = Result<Option<String>, String>;

/// The link target for this request: the org form when the org names a domain, else the
/// direct form when this machine's own callbacks imply one and the request allows it.
pub(crate) fn link_target(
    arrived: &Arrived,
    paired: Option<&Paired>,
    org_domain: Option<&OrgDomain>,
    callbacks: &[String],
) -> Result<serde_json::Value, Refusal> {
    let (domain, target) = if let (Some(p), Some(Ok(Some(domain)))) = (paired, org_domain) {
        let target = AgentLinkTarget::Org {
            org_url: p.org_url.clone(),
            machine_id: p.machine_id.clone(),
        };
        (domain.clone(), target)
    } else if let Some(domain) = publisher_domain_from_callbacks(callbacks) {
        let host = direct_host(arrived, paired).map_err(|r| match paired {
            Some(_) => refuse(
                r.code,
                format!("{} {}", org_sentence(org_domain), r.message),
            ),
            None => r,
        })?;
        (domain, AgentLinkTarget::Direct { host })
    } else {
        let config = "This machine's [cloud] app_callback_urls names no single https \
                      callback of the phone app, so yaran does not know which domain the \
                      app opens links on.";
        let message = match paired {
            Some(_) => format!("{} {config}", org_sentence(org_domain)),
            None => config.to_string(),
        };
        return Err(refuse("no_publisher_domain", message));
    };
    // Never hand the browser a target the strict parser would refuse.
    let probe = AgentLink {
        target: target.clone(),
        agent_id: "a".into(),
        tab_id: None,
    };
    if agent_link_url(&domain, &probe).is_none() {
        return Err(refuse(
            "no_publisher_domain",
            "yaran could not make a valid phone link from this machine's pairing.",
        ));
    }
    let target = match target {
        AgentLinkTarget::Org {
            org_url,
            machine_id,
        } => {
            json!({ "kind": "org", "orgUrl": org_url, "machineId": machine_id })
        }
        AgentLinkTarget::Direct { host } => json!({ "kind": "direct", "host": host }),
    };
    Ok(json!({ "publisher_domain": domain, "target": target }))
}

/// Why the org form was not available, as the first sentence of a refusal.
fn org_sentence(org_domain: Option<&OrgDomain>) -> String {
    match org_domain {
        Some(Err(why)) => format!(
            "yaran could not ask this machine's organisation which domain the phone app opens \
             links on ({why})."
        ),
        _ => "This machine's organisation does not name the phone app's link domain (its \
              control plane needs one https APP_CALLBACK_URLS entry, and an older control \
              plane never names one)."
            .to_string(),
    }
}

fn arrived(auth: &RequestAuth) -> Arrived {
    Arrived {
        host: auth.0.facts.host.clone(),
        https: auth.0.classification.https_serve_route,
    }
}

fn paired_of(paths: &CloudPaths) -> Option<Paired> {
    credentials::read(paths)
        .ok()
        .flatten()
        .filter(|c| !c.is_revoked())
        .map(|c| Paired {
            org_url: c.org_url,
            machine_id: c.machine_id,
            hostname: c.hostname,
            made_at: c.paired_at,
        })
}

/// The last W5 answer that named (or did not name) a domain, with the pairing it was for.
pub(crate) type DomainCache = Mutex<Option<(Paired, Instant, Option<String>)>>;
static ORG_DOMAIN: DomainCache = Mutex::new(None);

/// The pairing to answer for and its org's publisher domain, both from one pairing that did
/// not change while the domain was looked up. `read` is the credentials file; `fetch` is W5
/// for one pairing. A change between the two reads is retried once, then refused in words.
pub(crate) fn pairing_and_domain(
    read: impl Fn() -> Option<Paired>,
    fetch: impl Fn(&Paired) -> OrgDomain,
    cache: &DomainCache,
) -> (Option<Paired>, Option<OrgDomain>) {
    let lock = || {
        cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    for _ in 0..2 {
        let Some(paired) = read() else {
            return (None, None);
        };
        let cached = lock()
            .as_ref()
            .filter(|(k, at, _)| *k == paired && at.elapsed() < ORG_DOMAIN_TTL)
            .map(|(_, _, domain)| domain.clone());
        let answer = match &cached {
            Some(domain) => Ok(domain.clone()),
            None => fetch(&paired),
        };
        // W5 signs with whatever key the file holds when it is sent: if the pairing moved
        // meanwhile, this answer may be the new pairing's, so it is neither kept nor used.
        if read().as_ref() != Some(&paired) {
            continue;
        }
        if let (None, Ok(domain)) = (&cached, &answer) {
            *lock() = Some((paired.clone(), Instant::now(), domain.clone()));
        }
        return (Some(paired), Some(answer));
    }
    let latest = read();
    let changed = latest.as_ref().map(|_| {
        Err(
            "this machine's pairing changed while yaran was asking; open the menu again"
                .to_string(),
        )
    });
    (latest, changed)
}

/// W5 for exactly `paired`'s org. Blocking.
fn org_domain(paths: &CloudPaths, paired: &Paired, timeout: Duration) -> OrgDomain {
    MachineApi::new(&paired.org_url, paths, timeout)
        .and_then(|api| api.config())
        .map(|config| config.publisher_domain)
        .map_err(|e| describe(&e))
}

fn unavailable() -> Response {
    no_store(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": "unavailable", "message": "The engine is unavailable; try again shortly." }),
    )
}

async fn get_machine_qr(
    State(state): State<AppState>,
    Extension(auth): Extension<RequestAuth>,
) -> Response {
    let Some(inputs) = state.engine.cloud_inputs().await else {
        return unavailable();
    };
    let arrived = arrived(&auth);
    tokio::task::spawn_blocking(move || {
        let paired = paired_of(&inputs.paths);
        machine_qr(&arrived, paired.as_ref()).unwrap_or_else(IntoResponse::into_response)
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

async fn get_link_target(
    State(state): State<AppState>,
    Extension(auth): Extension<RequestAuth>,
) -> Response {
    let Some(inputs) = state.engine.cloud_inputs().await else {
        return unavailable();
    };
    let arrived = arrived(&auth);
    tokio::task::spawn_blocking(move || {
        let timeout = Duration::from_secs(inputs.cloud.request_timeout_seconds.max(1));
        let (paired, org) = pairing_and_domain(
            || paired_of(&inputs.paths),
            |p| org_domain(&inputs.paths, p, timeout),
            &ORG_DOMAIN,
        );
        match link_target(
            &arrived,
            paired.as_ref(),
            org.as_ref(),
            &inputs.cloud.app_callback_urls,
        ) {
            Ok(body) => no_store(StatusCode::OK, body),
            Err(refusal) => refusal.into_response(),
        }
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

#[cfg(test)]
#[path = "cloud_phone_links_tests.rs"]
mod tests;

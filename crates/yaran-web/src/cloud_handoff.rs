//! The sealed handoff and sign-in routes on the tunnel hostname (Phase 11 §7, D8, D24):
//! `GET /__yaran/handoff` (Y1), `POST /__yaran/handoff` (Y1b), `GET /__yaran/signed-in` (Y2).
//!
//! Y1 validates the request in 02's order, then either shows the one-tap consent page
//! or, when a remembered-consent cookie, the same device key, a verifying device
//! signature and a fresh `dts` all agree (02 §8.1), seals at once. Y1b redeems the page's
//! single-use CSRF token and, on Continue, seals the verified Access JWT to the phone's
//! ephemeral key and redirects to the callback 02's allowlist accepts. Nothing is ever
//! redirected to an unvalidated target: a bad `build`, `redirect` or `state` is a 400.
//!
//! - The routes exist only behind Access: without the middleware's `VerifiedAccess`
//!   (any non-cloud Host) they answer 404, so loopback can never mint an envelope.
//! - No token, key, state, csrf, cookie, `dk` or `dsig` is ever logged (T36, T58).
//!
//! <module-headers:begin>
//! Uses:
//! cloud_handoff.rs
//! ├── cloud_ingress
//! ├── handoff_consent_page
//! ├── handoff_csrf
//! ├── yaran_core::cloud::access_jwt
//! └── yaran_core::cloud::protocol
//! External: axum, std, uuid
//!
//! Used by:
//! cloud_handoff.rs
//! └── server
//! <module-headers:end>

use std::collections::HashMap;
use std::time::UNIX_EPOCH;

use axum::extract::rejection::FormRejection;
use axum::extract::{Extension, Form, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use yaran_core::cloud::access_jwt::VerifiedAccess;
use yaran_core::cloud::protocol::errors::{ErrorBody, ErrorEnvelope};
use yaran_core::cloud::protocol::handoff::{
    HandoffBuild, HandoffKind, HandoffMode, HandoffPayload, parse_recipient_point, seal,
};
use yaran_core::cloud::protocol::handoff_consent::{
    self as consent, ConsentDecision, ConsentSide, DeviceFieldError, RememberedInput,
};
use yaran_core::cloud::protocol::rules::{self, decode_p256_point};
use yaran_core::cloud::protocol::uri::redirect_allowed;
use yaran_core::cloud::protocol::{ErrorCode, PROTOCOL_MAX, PROTOCOL_MIN};

use crate::cloud_ingress::{CloudBinding, CloudIngress};
use crate::handoff_consent_page::{self as pages, ConsentView};
use crate::handoff_csrf::CsrfBinding;

/// Flipped by the PR that records gate G1's outcome L1 (03): the `CF_Authorization`
/// cookie then becomes mandatory in the envelope.
pub(crate) const COOKIE_REQUIRED: bool = false;
const ACCESS_COOKIE: &str = "CF_Authorization";

/// The three routes, carrying their own state so `build_app` merges them in one line.
pub(crate) fn cloud_routes<S: Clone + Send + Sync + 'static>(ingress: CloudIngress) -> Router<S> {
    Router::new()
        .route("/__yaran/handoff", get(handoff_get).post(handoff_post))
        .route("/__yaran/signed-in", get(signed_in))
        .with_state(ingress)
}

type Params = HashMap<String, String>;
type Access = Option<Extension<VerifiedAccess>>;

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Query or form pairs as a map; a repeated field makes the request ambiguous.
fn unique(pairs: Vec<(String, String)>) -> Option<Params> {
    let mut map = Params::new();
    for (k, v) in pairs {
        if map.insert(k, v).is_some() {
            return None;
        }
    }
    Some(map)
}

/// A 400 `handoff_request_invalid`: the §4 envelope, or a page when a browser asks.
fn bad_request(headers: &HeaderMap, message: &str) -> Response {
    let code = ErrorCode::HandoffRequestInvalid.as_str();
    let wants_html = headers
        .get(header::ACCEPT)
        .and_then(|a| a.to_str().ok())
        .is_some_and(|a| a.contains("text/html"));
    if wants_html {
        return pages::refused_page(code, message);
    }
    let envelope = ErrorEnvelope {
        error: ErrorBody {
            code: code.to_string(),
            message: message.to_string(),
            retryable: false,
            details: None,
        },
        request_id: uuid::Uuid::new_v4().simple().to_string(),
    };
    let mut response = (StatusCode::BAD_REQUEST, Json(envelope)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The validated target of every later answer.
struct Target {
    redirect: String,
    state: String,
    build: Option<HandoffBuild>,
    mode: Option<HandoffMode>,
    mode_ok: bool,
}

/// `build`, `redirect` and `state`: until these pass nothing may be redirected to.
fn target(p: &Params, callbacks: &[String]) -> Result<Target, &'static str> {
    let build = match p.get("build").map(String::as_str) {
        None => None,
        Some("release") => Some(HandoffBuild::Release),
        Some("dev") => Some(HandoffBuild::Dev),
        Some(_) => return Err("the build parameter must be release or dev"),
    };
    let redirect = p.get("redirect").cloned().unwrap_or_default();
    if !redirect_allowed(&redirect, build, callbacks) {
        return Err("the redirect is not a callback this machine may send a sign-in to");
    }
    let state = p.get("state").cloned().unwrap_or_default();
    if !rules::is_state(&state) {
        return Err("the state parameter is malformed");
    }
    let (mode, mode_ok) = match p.get("mode").map(String::as_str) {
        None => (None, true),
        Some("query") => (Some(HandoffMode::Query), true),
        Some("fragment") => (Some(HandoffMode::Fragment), true),
        Some(_) => (None, false),
    };
    Ok(Target {
        redirect,
        state,
        build,
        mode,
        mode_ok,
    })
}

/// A redirect failure: the §4 code plus extra query pairs.
type Failure = (ErrorCode, Vec<(&'static str, String)>);

fn invalid() -> Failure {
    (ErrorCode::HandoffRequestInvalid, Vec::new())
}

fn is_bidi(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// `v`, `mode`, `device` and `pk`, shared by both methods.
fn common(p: &Params, t: &Target) -> Result<(), Failure> {
    let v: i64 = p
        .get("v")
        .and_then(|v| v.parse().ok())
        .ok_or_else(invalid)?;
    if !(PROTOCOL_MIN..=PROTOCOL_MAX).contains(&v) {
        let range = vec![
            ("min", PROTOCOL_MIN.to_string()),
            ("max", PROTOCOL_MAX.to_string()),
        ];
        return Err((ErrorCode::ProtocolUnsupported, range));
    }
    let device = p.get("device").map(String::as_str).unwrap_or("");
    let device_ok = rules::chars_between(device, 1, 64)
        && !device.chars().any(|c| c.is_control() || is_bidi(c));
    if !t.mode_ok || !device_ok {
        return Err(invalid());
    }
    parse_recipient_point(p.get("pk").map(String::as_str).unwrap_or("")).map_err(|_| invalid())?;
    Ok(())
}

/// A 302/303 to the callback carrying `pairs` after `?` (or `#` with `mode=fragment`).
fn to_callback(status: StatusCode, t: &Target, pairs: &[(&str, String)]) -> Response {
    let sep = match t.mode {
        Some(HandoffMode::Fragment) => '#',
        _ if t.redirect.contains('?') => '&',
        _ => '?',
    };
    let query: Vec<String> = std::iter::once(("state", t.state.clone()))
        .chain(pairs.iter().map(|(k, v)| (*k, v.clone())))
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    let location = format!("{}{sep}{}", t.redirect, query.join("&"));
    let body = format!("<a href=\"{0}\">{0}</a>", pages::escape(&location));
    let mut response = (status, body).into_response();
    let h = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&location) {
        h.insert(header::LOCATION, v);
    }
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn fail(status: StatusCode, t: &Target, (code, mut extra): Failure) -> Response {
    extra.insert(0, ("error", code.as_str().to_string()));
    to_callback(status, t, &extra)
}

/// The value of the first cookie called `name`.
fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
}

/// The seal-and-redirect step shared by Continue and the remembered-consent skip.
#[allow(clippy::too_many_arguments)]
async fn issue(
    ingress: &CloudIngress,
    binding: &CloudBinding,
    access: &VerifiedAccess,
    t: &Target,
    pk: &str,
    headers: &HeaderMap,
    status: StatusCode,
    set_cookie_for: Option<&str>,
) -> Response {
    let now = ingress.now_secs();
    let settings = ingress.settings();
    if let Err(retry) = ingress
        .rate()
        .try_admit(now.max(0) as u64, settings.handoff_per_minute)
    {
        let mut response = fail(status, t, (ErrorCode::RateLimited, Vec::new()));
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from(retry));
        return response;
    }
    let access_cookie = match cookie(headers, ACCESS_COOKIE) {
        Some(raw) => match ingress.verify_token(binding, raw).await {
            Ok(c) if c.sub == access.sub && c.email == access.email && c.aud == access.aud => {
                Some(raw.to_string())
            }
            other => {
                let code = other.err().map_or("access-mismatch", |c| c.as_str());
                tracing::warn!(target: "yaran::cloud::handoff", code, "refused a handoff whose CF_Authorization cookie does not match its Access assertion");
                return fail(status, t, invalid());
            }
        },
        None if COOKIE_REQUIRED => return fail(status, t, invalid()),
        None => None,
    };
    let payload = HandoffPayload {
        v: 1,
        kind: HandoffKind::Machine,
        host: binding.hostname.clone(),
        jwt: access.jwt.clone(),
        email: access.email.clone(),
        exp: access
            .exp
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64),
        iat: now,
        cookie: access_cookie,
    };
    let jwe = match seal(pk, &binding.hostname, &t.state, &payload) {
        Ok(jwe) => jwe,
        Err(e) => {
            tracing::warn!(target: "yaran::cloud::handoff", error = %e, "could not seal a handoff envelope");
            return fail(status, t, invalid());
        }
    };
    let mut response = to_callback(status, t, &[("jwe", jwe)]);
    if let Some(fp24) = set_cookie_for
        && let Some(key) = ingress.consent_key().await
    {
        let value =
            consent::build_consent_cookie(&key.key, key.version, &binding.hostname, fp24, now);
        let line = consent::consent_set_cookie(&value, consent::MACHINE_HANDOFF_PATH);
        if let Ok(v) = HeaderValue::from_str(&line) {
            response.headers_mut().insert(header::SET_COOKIE, v);
        }
    }
    let kind = if status == StatusCode::FOUND {
        "remembered"
    } else {
        "explicit"
    };
    tracing::info!(target: "yaran::cloud::handoff", consent = kind, "handoff issued");
    response
}

async fn handoff_get(
    State(ingress): State<CloudIngress>,
    access: Access,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let (Some(Extension(access)), Some(binding)) = (access, ingress.binding()) else {
        return not_found();
    };
    let Some(p) = Query::<Vec<(String, String)>>::try_from_uri(&uri)
        .ok()
        .and_then(|q| unique(q.0))
    else {
        return bad_request(
            &headers,
            "the handoff query is malformed or repeats a field",
        );
    };
    let t = match target(&p, &ingress.settings().app_callback_urls) {
        Ok(t) => t,
        Err(message) => return bad_request(&headers, message),
    };
    if let Err(f) = common(&p, &t) {
        return fail(StatusCode::FOUND, &t, f);
    }
    let now = ingress.now_secs();
    let field = |name: &str| p.get(name).map(String::as_str);
    if let Err(e) = consent::check_device_fields(field("dk"), field("dts"), field("dsig"), now) {
        let extra = match e {
            DeviceFieldError::TimestampSkewed { server_time } => {
                vec![("server_time", server_time.to_string())]
            }
            DeviceFieldError::DeviceKeyInvalid | DeviceFieldError::SignatureMalformed => Vec::new(),
        };
        return fail(StatusCode::FOUND, &t, (e.code(), extra));
    }
    let (pk, dk) = (&p["pk"], &p["dk"]);
    let verified = consent::verify_device_signature(
        &binding.hostname,
        pk,
        &t.state,
        &p["dts"],
        dk,
        &p["dsig"],
    );
    let Some(dk_fp24) = decode_p256_point(dk).map(|point| consent::device_key_fp24(&point)) else {
        return fail(
            StatusCode::FOUND,
            &t,
            (ErrorCode::HandoffDeviceKeyInvalid, Vec::new()),
        );
    };
    if verified
        && let Some(cookie) = cookie(&headers, consent::CONSENT_COOKIE_NAME)
        && let Some(key) = ingress.consent_key().await
    {
        let decision = consent::decide_remembered(&RememberedInput {
            side: ConsentSide::Yaran,
            cookie: Some(cookie),
            host: &binding.hostname,
            dk_fp24: &dk_fp24,
            verified,
            dts_fresh: true,
            device_revoked: false,
            key: &key.key,
            current_kv: key.version,
            now,
        });
        match decision {
            ConsentDecision::Skip => {
                return issue(
                    &ingress,
                    &binding,
                    &access,
                    &t,
                    pk,
                    &headers,
                    StatusCode::FOUND,
                    None,
                )
                .await;
            }
            ConsentDecision::ConsentPage => {}
        }
    }
    let binding_for_csrf = CsrfBinding::new(&t.state, pk, &dk_fp24, verified);
    let Some(csrf) = ingress.csrf().mint(binding_for_csrf, now.max(0) as u64) else {
        return fail(StatusCode::FOUND, &t, invalid());
    };
    let mut hidden: Vec<(&'static str, String)> = [
        "v", "pk", "state", "redirect", "build", "mode", "device", "dk",
    ]
    .into_iter()
    .filter_map(|k| p.get(k).map(|v| (k, v.clone())))
    .collect();
    hidden.push(("csrf", csrf));
    let form_action = match t.build {
        Some(HandoffBuild::Dev) => "yaranapp:".to_string(),
        Some(HandoffBuild::Release) | None => callback_origin(&t.redirect),
    };
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    pages::consent_page(ConsentView {
        device: &p["device"],
        platform: pages::platform_label(user_agent),
        host: &binding.hostname,
        email: &access.email,
        dev_build: t.build == Some(HandoffBuild::Dev),
        hidden,
        form_action,
    })
}

/// `https://host[:port]` of an allowlisted https callback.
fn callback_origin(redirect: &str) -> String {
    let rest = redirect.strip_prefix("https://").unwrap_or(redirect);
    format!(
        "https://{}",
        rest.split(['/', '?', '#']).next().unwrap_or(rest)
    )
}

async fn handoff_post(
    State(ingress): State<CloudIngress>,
    access: Access,
    headers: HeaderMap,
    form: Result<Form<Vec<(String, String)>>, FormRejection>,
) -> Response {
    let (Some(Extension(access)), Some(binding)) = (access, ingress.binding()) else {
        return not_found();
    };
    let Some(p) = form.ok().and_then(|f| unique(f.0)) else {
        return bad_request(&headers, "the consent form is malformed or repeats a field");
    };
    let t = match target(&p, &ingress.settings().app_callback_urls) {
        Ok(t) => t,
        Err(message) => return bad_request(&headers, message),
    };
    if let Err(f) = common(&p, &t) {
        return fail(StatusCode::SEE_OTHER, &t, f);
    }
    let Some(dk_fp24) = p
        .get("dk")
        .and_then(|dk| decode_p256_point(dk))
        .map(|pt| consent::device_key_fp24(&pt))
    else {
        return fail(
            StatusCode::SEE_OTHER,
            &t,
            (ErrorCode::HandoffDeviceKeyInvalid, Vec::new()),
        );
    };
    let csrf = p.get("csrf").filter(|c| rules::is_state(c));
    let decision = p.get("decision").map(String::as_str);
    let (Some(csrf), Some("continue" | "cancel")) = (csrf, decision) else {
        return fail(StatusCode::SEE_OTHER, &t, invalid());
    };
    let now = ingress.now_secs();
    let Some(verified) =
        ingress
            .csrf()
            .redeem(csrf, &t.state, &p["pk"], &dk_fp24, now.max(0) as u64)
    else {
        return fail(StatusCode::SEE_OTHER, &t, invalid());
    };
    if decision == Some("cancel") {
        tracing::info!(target: "yaran::cloud::handoff", "handoff declined");
        return fail(
            StatusCode::SEE_OTHER,
            &t,
            (ErrorCode::HandoffDeclined, Vec::new()),
        );
    }
    let set_cookie = verified.then_some(dk_fp24.as_str());
    issue(
        &ingress,
        &binding,
        &access,
        &t,
        &p["pk"],
        &headers,
        StatusCode::SEE_OTHER,
        set_cookie,
    )
    .await
}

async fn signed_in(State(ingress): State<CloudIngress>, access: Access) -> Response {
    match (access, ingress.binding()) {
        (Some(_), Some(binding)) => pages::signed_in_page(&binding.hostname),
        _ => not_found(),
    }
}

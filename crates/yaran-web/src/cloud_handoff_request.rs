//! Parsing and answering for the handoff routes (Phase 11 §7): the query/form map,
//! 02's validation order, the 400 that guards every redirect, and the callback
//! redirect builder (query and fragment forms) with its no-store, no-referrer headers.
//!
//! - Trust boundary: every parameter is attacker input. Until `build`, `redirect` and
//!   `state` pass, the only possible answer is a 400; nothing is redirected to.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_handoff_request.rs
//! ├── handoff_consent_page
//! ├── yaran-core::cloud::protocol
//! ├── yaran-core::cloud::protocol::errors
//! ├── yaran-core::cloud::protocol::handoff
//! ├── yaran-core::cloud::protocol::rules
//! └── yaran-core::cloud::protocol::uri
//! External: axum, std, uuid
//!
//! Used by:
//! cloud_handoff_request.rs
//! ├── cloud_handoff
//! └── crate
//! <module-headers:end>

use std::collections::HashMap;

use axum::Json;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use yaran_core::cloud::protocol::errors::{ErrorBody, ErrorEnvelope};
use yaran_core::cloud::protocol::handoff::{HandoffBuild, HandoffMode, parse_recipient_point};
use yaran_core::cloud::protocol::rules;
use yaran_core::cloud::protocol::uri::redirect_allowed;
use yaran_core::cloud::protocol::{ErrorCode, PROTOCOL_MAX, PROTOCOL_MIN};

use crate::handoff_consent_page as pages;

pub(crate) type Params = HashMap<String, String>;

/// Query or form pairs as a map; a repeated field makes the request ambiguous.
pub(crate) fn unique(pairs: Vec<(String, String)>) -> Option<Params> {
    let mut map = Params::new();
    for (k, v) in pairs {
        if map.insert(k, v).is_some() {
            return None;
        }
    }
    Some(map)
}

/// A 400 `handoff_request_invalid`: the §4 envelope, or a page when a browser asks.
pub(crate) fn bad_request(headers: &HeaderMap, message: &str) -> Response {
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
pub(crate) struct Target {
    pub redirect: String,
    pub state: String,
    pub build: Option<HandoffBuild>,
    pub mode: Option<HandoffMode>,
    pub mode_ok: bool,
}

/// `build`, `redirect` and `state`: until these pass nothing may be redirected to.
pub(crate) fn target(p: &Params, callbacks: &[String]) -> Result<Target, &'static str> {
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
pub(crate) type Failure = (ErrorCode, Vec<(&'static str, String)>);

pub(crate) fn invalid() -> Failure {
    (ErrorCode::HandoffRequestInvalid, Vec::new())
}

pub(crate) fn is_bidi(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// `v`, `mode`, `device` and `pk`, shared by both methods.
pub(crate) fn common(p: &Params, t: &Target) -> Result<(), Failure> {
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
pub(crate) fn to_callback(status: StatusCode, t: &Target, pairs: &[(&str, String)]) -> Response {
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

pub(crate) fn fail(status: StatusCode, t: &Target, (code, mut extra): Failure) -> Response {
    extra.insert(0, ("error", code.as_str().to_string()));
    to_callback(status, t, &extra)
}

/// The value of the first cookie called `name`.
pub(crate) fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
}

/// `https://host[:port]` of an allowlisted https callback.
pub(crate) fn callback_origin(redirect: &str) -> String {
    let rest = redirect.strip_prefix("https://").unwrap_or(redirect);
    format!(
        "https://{}",
        rest.split(['/', '?', '#']).next().unwrap_or(rest)
    )
}

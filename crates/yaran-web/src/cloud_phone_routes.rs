//! `GET /api/v1/cloud/phone-qr`: the paired machine's phone QR code for the web UI's
//! "Connect a phone…" dialog.
//!
//! Answers `{url, uri, svg}`: the org URL a person can type, the
//! `yaranapp://add-org?u=…` payload built by Phase 02's `add_org_uri`, and that payload
//! rendered as SVG by the one encoder the CLI and TUI use (Phase 09), so the three
//! codes cannot differ. 409 with a sentence when the machine is not paired.
//!
//! - The org URL and the renderer come through [`PhoneQrSource`], installed once by the
//!   serve path that owns the credentials. Until something installs one, the machine
//!   reads as not paired.
//! - Read-only and cheap: no remote call, `no-store`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_phone_routes.rs
//! ├── server
//! └── yaran-core::cloud::protocol::uri
//! External: axum, serde, serde_json, std, tokio
//!
//! Used by:
//! cloud_phone_routes.rs
//! ├── crate
//! └── server
//! <module-headers:end>

use std::sync::{Arc, OnceLock};

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use yaran_core::cloud::protocol::uri::add_org_uri;

use crate::server::AppState;

/// What the route needs from the cloud credentials and the QR encoder.
pub trait PhoneQrSource: Send + Sync {
    /// The paired org's control-plane URL, or `None` when the machine is not paired.
    fn org_url(&self) -> Option<String>;
    /// The payload as an SVG document with its quiet zone drawn in.
    fn render_svg(&self, payload: &str) -> Option<String>;
}

static SOURCE: OnceLock<Arc<dyn PhoneQrSource>> = OnceLock::new();

/// Install the process's source. The first install wins; returns false after that.
pub fn install_phone_qr_source(source: Arc<dyn PhoneQrSource>) -> bool {
    SOURCE.set(source).is_ok()
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v1/cloud/phone-qr", get(get_phone_qr))
}

async fn get_phone_qr() -> Response {
    phone_qr_response(SOURCE.get().map(|s| s.as_ref()))
}

#[derive(Serialize, Debug)]
struct PhoneQr {
    url: String,
    uri: String,
    svg: String,
}

fn refuse(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        message.to_string(),
    )
        .into_response()
}

/// The whole decision, for a given source (or none installed).
pub(crate) fn phone_qr_response(source: Option<&dyn PhoneQrSource>) -> Response {
    let Some(url) = source.and_then(|s| s.org_url()) else {
        return refuse(
            StatusCode::CONFLICT,
            "This machine is not connected to a yaran org, so there is no phone code to show. Connect it with yaran cloud login, then try again.",
        );
    };
    let Some(uri) = add_org_uri(&url) else {
        return refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The org URL this machine is paired with cannot be put in a phone code. Run yaran cloud login again to repair the pairing.",
        );
    };
    let Some(svg) = source.and_then(|s| s.render_svg(&uri)) else {
        return refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "yaran could not draw the phone code. Run yaran cloud pair-phone in a terminal on this machine to show it there.",
        );
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(PhoneQr { url, uri, svg }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Option<String>);

    impl PhoneQrSource for Fake {
        fn org_url(&self) -> Option<String> {
            self.0.clone()
        }
        fn render_svg(&self, payload: &str) -> Option<String> {
            Some(format!("<svg data-payload=\"{payload}\"></svg>"))
        }
    }

    async fn body(resp: Response) -> (StatusCode, String) {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, String::from_utf8(bytes.to_vec()).expect("utf8"))
    }

    #[tokio::test]
    async fn an_unpaired_machine_is_refused_with_a_sentence() {
        for source in [None, Some(&Fake(None) as &dyn PhoneQrSource)] {
            let (status, text) = body(phone_qr_response(source)).await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert!(text.contains("yaran cloud login"), "{text}");
        }
    }

    /// The payload is Phase 02's `add_org_uri` for every case in its fixture.
    #[tokio::test]
    async fn the_payload_matches_the_add_org_fixture() {
        let doc: serde_json::Value = serde_json::from_str(include_str!(
            "../../../cloud/protocol/fixtures/uri/add-org.json"
        ))
        .expect("fixture");
        for case in doc["build"].as_array().expect("build cases") {
            let org = case["org_url"].as_str().expect("org_url").to_string();
            let (status, text) = body(phone_qr_response(Some(&Fake(Some(org.clone()))))).await;
            match case["expect"].as_str() {
                Some(uri) => {
                    assert_eq!(status, StatusCode::OK, "{org}");
                    let v: serde_json::Value = serde_json::from_str(&text).expect("json");
                    assert_eq!(v["uri"], uri);
                    assert_eq!(v["url"], org.as_str());
                    assert!(v["svg"].as_str().expect("svg").starts_with("<svg"));
                }
                None => assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{org}"),
            }
        }
    }
}

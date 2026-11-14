//! The HTML pages behind the handoff routes (Phase 11 §7): the one-tap consent page,
//! the signed-in page, and the plain page a browser gets for a refused request.
//!
//! The pages are script-free and every interpolated value is HTML-escaped. Names
//! (device, platform, host, email) render as chips. The consent page's CSP allows only
//! its own style element (by hash), posts only to itself and to the callback's origin
//! (a form post's redirect is checked against `form-action`), and refuses framing; its
//! `Referrer-Policy` is `same-origin`, because `no-referrer` would make the browser send
//! `Origin: null` on the Continue post and the origin check would refuse it.
//!
//! - Colours come from the shared token names (`--background`, `--primary`, ...); until
//!   Phase 14's `packages/ui-kit/src/tokens.css` exists the pages fall back to CSS system
//!   colours, so no colour is hard-coded.
//!
//! <module-headers:begin>
//! Uses:
//! handoff_consent_page.rs
//! ├── yaran-core::cloud::protocol::rules
//! ├── yaran-core::cloud::protocol::ua
//! └── yaran-core::device_label
//! External: axum, ring, std
//!
//! Used by:
//! handoff_consent_page.rs
//! ├── cloud_handoff
//! ├── cloud_handoff_request
//! ├── cloud_handoff_tests
//! └── crate
//! <module-headers:end>

use std::sync::OnceLock;

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use ring::digest::{SHA256, digest};
use yaran_core::cloud::protocol::rules::b64url_encode;
use yaran_core::cloud::protocol::ua::{AppForm, AppOs, parse_yaran_app_ua};

// shortcut: system-colour fallbacks stand in for ui-kit's tokens.css; embed it with
// include_str! here once Phase 14 lands `packages/ui-kit/src/tokens.css`.
const STYLE: &str = ":root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:var(--background,Canvas);color:var(--foreground,CanvasText)}main{max-width:28rem;margin:16px;padding:24px;border:1px solid var(--border,GrayText);border-radius:var(--radius,12px)}h1{font-size:1.25rem;margin:0 0 12px}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;margin:16px 0}dt{color:var(--muted-foreground,GrayText)}dd{margin:0}.chip{font-family:ui-monospace,monospace;padding:0 4px;border-radius:4px;background:var(--foreground,CanvasText);color:var(--background,Canvas);white-space:nowrap}.warn{border-left:3px solid var(--destructive,Mark);padding-left:12px}.actions{display:flex;gap:24px;margin-top:24px}button{min-height:40px;min-width:96px;padding:0 16px;font:inherit;border-radius:var(--radius,8px);border:1px solid var(--border,ButtonBorder);background:var(--secondary,ButtonFace);color:var(--secondary-foreground,ButtonText)}button.primary{background:var(--primary,Highlight);color:var(--primary-foreground,HighlightText);border-color:transparent}";

/// HTML-escapes text and attribute values.
pub(crate) fn escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn chip(name: &str) -> String {
    format!("<code class=\"chip\">{}</code>", escape(name))
}

fn style_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        // CSP wants standard, padded base64; convert from the base64url helper.
        let url = b64url_encode(digest(&SHA256, STYLE.as_bytes()).as_ref());
        let std: String = url
            .chars()
            .map(|c| match c {
                '-' => '+',
                '_' => '/',
                c => c,
            })
            .collect();
        format!("sha256-{std}{}", "=".repeat((4 - std.len() % 4) % 4))
    })
}

/// The CSP of a page whose form may post to `form_action` besides itself.
pub(crate) fn csp(form_action: Option<&str>) -> String {
    let extra = form_action.map(|a| format!(" {a}")).unwrap_or_default();
    format!(
        "default-src 'none'; style-src '{}'; form-action 'self'{extra}; frame-ancestors 'none'; base-uri 'none'",
        style_hash()
    )
}

/// The platform chip: the app's UA token when present, else the browser's label.
pub(crate) fn platform_label(user_agent: Option<&str>) -> Option<String> {
    let ua = user_agent?;
    if let Some(app) = parse_yaran_app_ua(ua) {
        let os = match app.os {
            AppOs::Android => "Android",
            AppOs::Ios => "iOS",
        };
        let form = match app.form {
            AppForm::Phone => "phone",
            AppForm::Tablet => "tablet",
        };
        return Some(format!("yaran app on an {os} {form}"));
    }
    yaran_core::device_label::short_device_label(ua)
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\" class=\"dark\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{STYLE}</style></head><body><main>{body}</main></body></html>",
        escape(title)
    )
}

fn html_response(status: StatusCode, html: String, form_action: Option<&str>) -> Response {
    let mut response = (status, html).into_response();
    let h: &mut HeaderMap = response.headers_mut();
    let set = |h: &mut HeaderMap, name, value: &str| {
        if let Ok(v) = HeaderValue::from_str(value) {
            h.insert(name, v);
        }
    };
    set(h, header::CONTENT_TYPE, "text/html; charset=utf-8");
    set(h, header::CACHE_CONTROL, "no-store");
    set(h, header::CONTENT_SECURITY_POLICY, &csp(form_action));
    set(h, header::X_FRAME_OPTIONS, "DENY");
    set(h, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(h, header::REFERRER_POLICY, "same-origin");
    response
}

/// What the consent page shows and carries back.
pub(crate) struct ConsentView<'a> {
    pub device: &'a str,
    pub platform: Option<String>,
    pub host: &'a str,
    pub email: &'a str,
    pub dev_build: bool,
    /// Every field the POST re-sends, `csrf` included.
    pub hidden: Vec<(&'static str, String)>,
    /// The callback's origin (`https://…`), or `yaranapp:` for a dev build.
    pub form_action: String,
}

pub(crate) fn consent_page(view: ConsentView<'_>) -> Response {
    let platform = view
        .platform
        .as_deref()
        .map(|p| format!("<dt>Platform</dt><dd>{}</dd>", chip(p)))
        .unwrap_or_default();
    let warning = if view.dev_build {
        "<p class=\"warn\">This request comes from a development build of the yaran app. Continue only if you built or installed that build yourself.</p>"
    } else {
        ""
    };
    let hidden: String = view
        .hidden
        .iter()
        .map(|(name, value)| {
            format!(
                "<input type=\"hidden\" name=\"{name}\" value=\"{}\">",
                escape(value)
            )
        })
        .collect();
    let body = format!(
        "<h1>Sign this device in to {host}?</h1><p>Continue only if you just asked the yaran app to connect to this machine.</p><dl><dt>Device</dt><dd>{device}</dd>{platform}<dt>Machine</dt><dd>{host}</dd><dt>Signed in as</dt><dd>{email}</dd></dl>{warning}<form method=\"post\" action=\"/__yaran/handoff\">{hidden}<div class=\"actions\"><button class=\"primary\" type=\"submit\" name=\"decision\" value=\"continue\">Continue</button><button type=\"submit\" name=\"decision\" value=\"cancel\">Cancel</button></div></form>",
        host = chip(view.host),
        device = chip(view.device),
        email = chip(view.email),
    );
    html_response(
        StatusCode::OK,
        page("Sign in to this machine", &body),
        Some(&view.form_action),
    )
}

/// Y2: the page Access lands a re-signed-in browser on (Phase 13 opens it in a new tab).
pub(crate) fn signed_in_page(host: &str) -> Response {
    let body = format!(
        "<h1>You're back in.</h1><p>This browser is signed in to {} again. Close this tab: the yaran tab you came from reconnects by itself.</p>",
        chip(host)
    );
    html_response(StatusCode::OK, page("Signed in to yaran", &body), None)
}

/// The page a browser gets instead of the JSON envelope for a refused handoff request.
pub(crate) fn refused_page(code: &str, message: &str) -> Response {
    let body = format!(
        "<h1>This sign-in request can't be used</h1><p>{}</p><p>Error code: {}</p>",
        escape(message),
        chip(code)
    );
    html_response(
        StatusCode::BAD_REQUEST,
        page("Sign-in request refused", &body),
        None,
    )
}

//! The phone app's User-Agent token (Design §11): `YaranApp/<version> (<os>; <form>)`,
//! appended to the WebView UA in machine-view and sent alone on native HTTP calls.
//!
//! yaran parses it to label a connected device (Phase 13 owns the visible wording, which
//! must fit `device_label::SHORT_LABEL_MAX_CHARS`). Pinned by `fixtures/ua/ua.json`.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/ua.rs
//! └── cloud::protocol::test_fixtures
//! External: regex, serde_json, std
//!
//! Used by:
//! cloud/protocol/ua.rs
//! ├── cloud::protocol
//! └── yaran-web::handoff_consent_page
//! └── device_label
//! <module-headers:end>

use std::sync::LazyLock;

use regex::Regex;

static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^| )YaranApp/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?) \((android|ios); (phone|tablet)\)(?: |$)",
    )
    .expect("UA token pattern compiles")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppOs {
    Android,
    Ios,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppForm {
    Phone,
    Tablet,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YaranAppUa {
    pub version: String,
    pub os: AppOs,
    pub form: AppForm,
}

/// Finds the token anywhere in a User-Agent string.
pub fn parse_yaran_app_ua(ua: &str) -> Option<YaranAppUa> {
    let m = TOKEN.captures(ua)?;
    let os = match &m[2] {
        "android" => AppOs::Android,
        _ => AppOs::Ios,
    };
    let form = match &m[3] {
        "phone" => AppForm::Phone,
        _ => AppForm::Tablet,
    };
    Some(YaranAppUa {
        version: m[1].to_string(),
        os,
        form,
    })
}

/// Builds the token.
pub fn yaran_app_token(ua: &YaranAppUa) -> String {
    let os = match ua.os {
        AppOs::Android => "android",
        AppOs::Ios => "ios",
    };
    let form = match ua.form {
        AppForm::Phone => "phone",
        AppForm::Tablet => "tablet",
    };
    format!("YaranApp/{} ({os}; {form})", ua.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::fixture;

    fn expected(v: &serde_json::Value) -> Option<YaranAppUa> {
        v.as_object()?;
        Some(YaranAppUa {
            version: v["version"].as_str()?.to_string(),
            os: if v["os"] == "android" {
                AppOs::Android
            } else {
                AppOs::Ios
            },
            form: if v["form"] == "phone" {
                AppForm::Phone
            } else {
                AppForm::Tablet
            },
        })
    }

    #[test]
    fn the_ua_fixture_passes() {
        let f = fixture("ua/ua.json");
        for c in f["parse"].as_array().unwrap() {
            let ua = c["ua"].as_str().unwrap();
            assert_eq!(parse_yaran_app_ua(ua), expected(&c["expect"]), "{ua}");
        }
        for c in f["build"].as_array().unwrap() {
            assert_eq!(yaran_app_token(&expected(&c["input"]).unwrap()), c["token"]);
        }
    }
}

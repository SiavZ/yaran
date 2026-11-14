//! Normalizes the control-plane URL a person types into 02's `OrgUrl`.
//!
//! https only (a bare host gets `https://`), lowercased host with IDN converted by
//! the `url` crate, no userinfo, port, query or fragment, and a path of `/` or
//! nothing (the trailing slash is dropped). The result must pass `rules::is_org_url`.
//!
//! - Pure; the error is a sentence a surface can show as is.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/org_url.rs
//! ├── cloud::protocol::rules
//! └── sanitize
//! External: url
//!
//! Used by:
//! cloud/org_url.rs
//! ├── cloud
//! ├── cloud::cli::pair_phone
//! ├── cloud::login
//! └── yaran-tui::app::cloud_commands
//! <module-headers:end>

use crate::cloud::protocol::rules::is_org_url;

/// The normalized `OrgUrl`, or a sentence saying what is wrong with `input`.
pub fn normalize_org_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(
            "Enter your organization's Yaran Cloud address, such as https://cloud.example.com."
                .into(),
        );
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let shown = crate::sanitize::truncate(trimmed, 120);
    let url = url::Url::parse(&with_scheme)
        .map_err(|_| format!("{shown:?} is not a web address yaran can use."))?;
    if url.scheme() != "https" {
        return Err(format!(
            "{shown:?} must use https://; Yaran Cloud never pairs over plain http."
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "{shown:?} must not contain a user name or password."
        ));
    }
    if url.port().is_some() {
        return Err(format!("{shown:?} must not name a port."));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!("{shown:?} must not have a query or fragment."));
    }
    if !matches!(url.path(), "" | "/") {
        return Err(format!(
            "{shown:?} must be the bare address of the control plane, with no path."
        ));
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    let normalized = format!("https://{host}");
    if !is_org_url(&normalized) {
        return Err(format!(
            "{shown:?} is not a valid Yaran Cloud address (a domain name such as cloud.example.com)."
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_table() {
        for (input, want) in [
            ("https://cloud.example.com", Ok("https://cloud.example.com")),
            (
                "https://Cloud.Example.COM/",
                Ok("https://cloud.example.com"),
            ),
            ("  cloud.example.com  ", Ok("https://cloud.example.com")),
            (
                "https://bücher.example",
                Ok("https://xn--bcher-kva.example"),
            ),
            ("http://cloud.example.com", Err("https")),
            ("https://u:p@cloud.example.com", Err("user name")),
            ("https://cloud.example.com:8443", Err("port")),
            ("https://cloud.example.com/?x=1", Err("query")),
            ("https://cloud.example.com/#f", Err("query")),
            ("https://cloud.example.com/org", Err("no path")),
            ("https://localhost", Err("valid")),
            ("https://127.0.0.1", Err("valid")),
            ("", Err("Enter")),
        ] {
            match (normalize_org_url(input), want) {
                (Ok(got), Ok(w)) => assert_eq!(got, w, "{input:?}"),
                (Err(got), Err(w)) => assert!(got.contains(w), "{input:?}: {got}"),
                (got, w) => panic!("{input:?}: got {got:?}, want {w:?}"),
            }
        }
    }
}

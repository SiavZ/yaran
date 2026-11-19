//! The two strict app URIs a machine hands a phone without Cloud Connect pairing: the
//! add-machine QR payload and the verified agent link (docs/operations/
//! mobile-parity-contracts.md section 5).
//!
//! The Rust twin of `addMachineUri`, `parseAddMachineUri`, `agentLinkUrl`,
//! `parseAgentLink` and `isPublicHost` in `cloud/protocol/src/uri.ts`, held to the same
//! fixtures (`fixtures/uri/add-machine.json`, `fixtures/uri/agent-link.json`). Strict:
//! a parameter the form does not name, an empty pair, a query or fragment it does not
//! use, or a non-canonical value refuses the whole URI. Lengths count UTF-16 units, as
//! JavaScript's `length` does.
//!
//! - Pure. Nothing here is a credential: a link names a machine and an agent, and the
//!   phone opens it only for a machine it already has.
//! - `publisher_domain_from_callbacks` is the one rule, shared with the org Worker's
//!   `MachineConfig.publisher_domain`, that turns `app_callback_urls` into the domain a
//!   link may name.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/protocol/links.rs
//! ├── cloud::protocol::rules
//! ├── cloud::protocol::test_fixtures
//! └── cloud::protocol::uri
//! External: percent_encoding, regex, serde_json, std
//!
//! Used by:
//! cloud/protocol/links.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── yaran-web::cloud_phone_links
//! └── yaran-web::cloud_phone_links::tests
//! ```
//! <module-headers:end>

use std::collections::HashMap;
use std::sync::LazyLock;

use percent_encoding::utf8_percent_encode;
use regex::Regex;

use super::rules;
use super::uri::URI_COMPONENT;

/// The longest add-machine URI, in UTF-16 units.
pub const ADD_MACHINE_MAX_CHARS: usize = 512;
/// The longest agent link, in UTF-16 units.
pub const AGENT_LINK_MAX_CHARS: usize = 1024;

/// `uri.ts`'s `URI_RE`: scheme, authority, path, query, fragment.
static URI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$")
        .expect("uri pattern compiles")
});

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// A host the app may load or link to: lowercase, two or more labels, an alphabetic
/// TLD, no port, no IP literal and no IDN (`xn--`) label.
pub fn is_public_host(host: &str) -> bool {
    host.len() <= 253
        && rules::is_org_url(&format!("https://{host}"))
        && !host.split('.').any(|label| label.starts_with("xn--"))
}

/// JavaScript's `decodeURIComponent`, or `None` where it would throw: a `%` without
/// two hex digits after it, or bytes that are not UTF-8.
fn decode_component(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            // `from_str_radix` would take a sign ("%+1"); JavaScript throws on it.
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `uri.ts`'s `strictParams`: every pair has a key and an `=`, escapes are well formed,
/// keys are unique and only `allowed` ones appear.
fn strict_params(text: &str, allowed: &[&str]) -> Option<HashMap<String, String>> {
    let mut out = HashMap::new();
    for pair in text.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key.is_empty() {
            return None;
        }
        let key = decode_component(key)?;
        let value = decode_component(value)?;
        if !allowed.contains(&key.as_str()) || out.contains_key(&key) {
            return None;
        }
        out.insert(key, value);
    }
    Some(out)
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// The add-machine QR payload for a direct machine, or `None` when `host` is not a
/// public host or the URI would exceed [`ADD_MACHINE_MAX_CHARS`].
pub fn add_machine_uri(host: &str) -> Option<String> {
    if !is_public_host(host) {
        return None;
    }
    let uri = format!(
        "yaranapp://add-machine?u={}",
        encode(&format!("https://{host}"))
    );
    (utf16_len(&uri) <= ADD_MACHINE_MAX_CHARS).then_some(uri)
}

/// The host an add-machine URI names, or `None` for anything the strict form refuses.
pub fn parse_add_machine_uri(uri: &str) -> Option<String> {
    if utf16_len(uri) > ADD_MACHINE_MAX_CHARS || uri.contains('#') {
        return None;
    }
    let m = URI.captures(uri)?;
    if !m[1].eq_ignore_ascii_case("yaranapp") || &m[2] != "add-machine" || m.get(3).is_some() {
        return None;
    }
    let u = strict_params(m.get(4)?.as_str(), &["u"])?.remove("u")?;
    let host = u.strip_prefix("https://")?;
    is_public_host(host).then(|| host.to_string())
}

/// Which known machine an agent link names. Neither form carries a credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentLinkTarget {
    /// A Cloud Connect machine, by its organization and its id there.
    Org {
        /// The organization's control-plane `OrgUrl`.
        org_url: String,
        /// The machine's `Uuid` in that organization.
        machine_id: String,
    },
    /// A machine the phone added by its HTTPS address.
    Direct {
        /// The machine's public host.
        host: String,
    },
}

/// A link to one agent, and optionally one of its tabs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentLink {
    /// The machine.
    pub target: AgentLinkTarget,
    /// The agent's id (`YaranId`).
    pub agent_id: String,
    /// The tab's id; `None` for the agent's slot tab.
    pub tab_id: Option<String>,
}

/// `https://<publisher_domain>/open#…` for `link`, or `None` for any value the parser
/// would refuse. `publisher_domain` comes from configuration, never from a link.
pub fn agent_link_url(publisher_domain: &str, link: &AgentLink) -> Option<String> {
    if !is_public_host(publisher_domain) {
        return None;
    }
    let head = match &link.target {
        AgentLinkTarget::Org {
            org_url,
            machine_id,
        } => {
            format!("o={}&m={}", encode(org_url), encode(machine_id))
        }
        AgentLinkTarget::Direct { host } => format!("d={}", encode(host)),
    };
    let tab = link
        .tab_id
        .as_deref()
        .map_or_else(String::new, |t| format!("&t={}", encode(t)));
    let url = format!(
        "https://{publisher_domain}/open#{head}&a={}{tab}",
        encode(&link.agent_id)
    );
    parse_agent_link(&url, publisher_domain)
        .is_some()
        .then_some(url)
}

/// The link an agent URL names, or `None` for anything the strict form refuses: the
/// authority must equal `publisher_domain` exactly, the path is exactly `/open`, there is
/// no query, and the fragment holds one target form, `a` and an optional `t`.
pub fn parse_agent_link(url: &str, publisher_domain: &str) -> Option<AgentLink> {
    if utf16_len(url) > AGENT_LINK_MAX_CHARS || !is_public_host(publisher_domain) {
        return None;
    }
    let m = URI.captures(url)?;
    if !m[1].eq_ignore_ascii_case("https")
        || &m[2] != publisher_domain
        || m.get(3).map(|p| p.as_str()) != Some("/open")
        || m.get(4).is_some()
    {
        return None;
    }
    let fragment = m.get(5)?.as_str();
    // Chosen on the raw text, as uri.ts does: an encoded key cannot pick the form.
    let direct = fragment.starts_with("d=") || fragment.contains("&d=");
    let keys: &[&str] = if direct {
        &["d", "a", "t"]
    } else {
        &["o", "m", "a", "t"]
    };
    let mut p = strict_params(fragment, keys)?;
    let agent_id = p.remove("a").filter(|a| rules::is_yaran_id(a))?;
    let tab_id = p.remove("t");
    if tab_id.as_deref().is_some_and(|t| !rules::is_yaran_id(t)) {
        return None;
    }
    let target = if direct {
        let host = p.remove("d").filter(|h| is_public_host(h))?;
        AgentLinkTarget::Direct { host }
    } else {
        let org_url = p.remove("o").filter(|o| rules::is_org_url(o))?;
        let machine_id = p.remove("m").filter(|m| rules::is_uuid(m))?;
        AgentLinkTarget::Org {
            org_url,
            machine_id,
        }
    };
    Some(AgentLink {
        target,
        agent_id,
        tab_id,
    })
}

/// The one publisher domain a list of app callback URLs implies: the host of every
/// `https://<host>/auth/callback` among them, when they all agree on one public host.
/// `None` for no such callback, or callbacks on different hosts (which domain a phone
/// verifies links on is then not this machine's to guess). Shared rule: the org Worker
/// derives `MachineConfig.publisher_domain` from `APP_CALLBACK_URLS` the same way.
pub fn publisher_domain_from_callbacks<S: AsRef<str>>(callbacks: &[S]) -> Option<String> {
    let mut found: Option<&str> = None;
    for url in callbacks {
        let Some(host) = url
            .as_ref()
            .strip_prefix("https://")
            .and_then(|rest| rest.strip_suffix("/auth/callback"))
            .filter(|host| is_public_host(host))
        else {
            continue;
        };
        match found {
            Some(seen) if seen != host => return None,
            _ => found = Some(host),
        }
    }
    found.map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::cloud::protocol::test_fixtures::fixture;

    fn link_of(v: &Value) -> AgentLink {
        let t = &v["target"];
        let s = |v: &Value| v.as_str().unwrap().to_string();
        let target = match t["kind"].as_str().unwrap() {
            "org" => AgentLinkTarget::Org {
                org_url: s(&t["orgUrl"]),
                machine_id: s(&t["machineId"]),
            },
            "direct" => AgentLinkTarget::Direct {
                host: s(&t["host"]),
            },
            other => panic!("unknown target {other}"),
        };
        AgentLink {
            target,
            agent_id: s(&v["agentId"]),
            tab_id: v.get("tabId").map(s),
        }
    }

    #[test]
    fn add_machine_matches_the_fixture() {
        let f = fixture("uri/add-machine.json");
        for c in f["build"].as_array().unwrap() {
            let host = c["host"].as_str().unwrap();
            assert_eq!(
                add_machine_uri(host).as_deref(),
                c["expect"].as_str(),
                "{host}"
            );
        }
        for c in f["parse"].as_array().unwrap() {
            let uri = c["uri"].as_str().unwrap();
            let want = c["expect"]["host"].as_str();
            assert_eq!(parse_add_machine_uri(uri).as_deref(), want, "{uri}");
        }
    }

    #[test]
    fn agent_links_match_the_fixture() {
        let f = fixture("uri/agent-link.json");
        let domain = f["publisher_domain"].as_str().unwrap();
        for c in f["build"].as_array().unwrap() {
            let link = link_of(&c["link"]);
            assert_eq!(
                agent_link_url(domain, &link).as_deref(),
                c["expect"].as_str(),
                "{link:?}"
            );
        }
        let any = link_of(&f["build"][0]["link"]);
        for bad in f["build_bad_domain"].as_array().unwrap() {
            let bad = bad.as_str().unwrap();
            assert_eq!(agent_link_url(bad, &any), None, "{bad}");
        }
        for c in f["parse"].as_array().unwrap() {
            let url = c["url"].as_str().unwrap();
            let want = c["expect"].is_object().then(|| link_of(&c["expect"]));
            assert_eq!(parse_agent_link(url, domain), want, "{url}");
        }
        let without = &f["parse_without_domain"];
        for d in without["domains"].as_array().unwrap() {
            let url = without["url"].as_str().unwrap();
            assert_eq!(parse_agent_link(url, d.as_str().unwrap()), None, "{d}");
        }
    }

    #[test]
    fn the_publisher_domain_is_the_one_callback_host() {
        let d = |urls: &[&str]| publisher_domain_from_callbacks(urls);
        assert_eq!(d(&[]), None);
        assert_eq!(
            d(&["https://app.example.org/auth/callback"]).as_deref(),
            Some("app.example.org")
        );
        assert_eq!(
            d(&[
                "yaranapp://auth/callback",
                "https://app.example.org/auth/callback",
                "https://app.example.org/auth/callback",
            ])
            .as_deref(),
            Some("app.example.org"),
            "the dev scheme and repeats are not a second host"
        );
        for refused in [
            &[
                "https://a.example.org/auth/callback",
                "https://b.example.org/auth/callback",
            ][..],
            &["https://<publisher-domain>/auth/callback"],
            &["https://app.example.org:8443/auth/callback"],
            &["https://App.example.org/auth/callback"],
            &["https://app.example.org/other"],
            &["http://app.example.org/auth/callback"],
            &["https://user@app.example.org/auth/callback"],
            &["https://10.0.0.5/auth/callback"],
        ] {
            assert_eq!(d(refused), None, "{refused:?}");
        }
    }
}

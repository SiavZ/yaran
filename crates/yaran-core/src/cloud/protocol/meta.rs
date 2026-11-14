//! `GET /v1/meta` (W1): the org Worker's public self-description, read by `yaran cloud
//! login` before anything else to negotiate the protocol and learn whether setup is done.
//!
//! A response type, so unknown fields are ignored and the open `setup` enum decodes an
//! unknown value to `Unknown` (which `validate` refuses, because this build cannot act
//! on it). With `setup: closed` the org, access, capabilities and push blocks are required.
//!
//! - Pure data; no I/O.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/meta.rs
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: serde
//!
//! Used by:
//! cloud/protocol/meta.rs
//! ├── cloud::protocol
//! └── cloud::protocol::machine
//! <module-headers:end>

use serde::{Deserialize, Serialize};

use super::rules::{self, Checked, Validate, check, check_opt};

/// A server's supported protocol versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolRange {
    pub min: i64,
    pub max: i64,
}

impl Validate for ProtocolRange {
    fn validate(&self) -> Checked {
        check(
            self.min >= 1 && self.max >= 1 && self.max >= self.min,
            "protocol",
        )
    }
}

/// An org's display name and control-plane origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgRef {
    pub name: String,
    pub url: String,
}

impl Validate for OrgRef {
    fn validate(&self) -> Checked {
        check(rules::chars_between(&self.name, 1, 80), "org.name")?;
        check(rules::is_org_url(&self.url), "org.url")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupState {
    Open,
    Closed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deprecation {
    pub protocol: i64,
    pub after: String,
}

impl Validate for Deprecation {
    fn validate(&self) -> Checked {
        check(self.protocol >= 1, "deprecations.protocol")?;
        check(rules::is_date(&self.after), "deprecations.after")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetaAccess {
    pub team_domain: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerInfo {
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetaPush {
    pub enabled: bool,
    /// The org's VAPID public key, or null while push is off.
    #[serde(deserialize_with = "rules::nullable")]
    pub vapid_public_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub service: String,
    pub protocol: ProtocolRange,
    pub setup: SetupState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deprecations: Option<Vec<Deprecation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<OrgRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<MetaAccess>,
    pub worker: WorkerInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<MetaPush>,
}

/// `Meta.service` for the org Worker.
pub const META_SERVICE: &str = "yaran-cloud";

impl Validate for Meta {
    fn validate(&self) -> Checked {
        check(self.service == META_SERVICE, "service")?;
        self.protocol.validate()?;
        check(self.setup != SetupState::Unknown, "setup")?;
        for d in self.deprecations.iter().flatten() {
            d.validate()?;
        }
        if let Some(org) = &self.org {
            org.validate()?;
        }
        check_opt(
            &self.access,
            |a| rules::is_hostname(&a.team_domain),
            "access.team_domain",
        )?;
        check(rules::is_semver(&self.worker.version), "worker.version")?;
        check_opt(
            &self.capabilities,
            |caps| caps.iter().all(|c| is_capability(c)),
            "capabilities",
        )?;
        check_opt(
            &self.push,
            |p| {
                p.vapid_public_key
                    .as_deref()
                    .is_none_or(rules::is_p256_point)
            },
            "push.vapid_public_key",
        )?;
        if self.setup == SetupState::Closed {
            check(self.org.is_some(), "org")?;
            check(self.access.is_some(), "access")?;
            check(self.capabilities.is_some(), "capabilities")?;
            check(self.push.is_some(), "push")?;
        }
        Ok(())
    }
}

/// `^[a-z_]+(\.[a-z0-9_]+)*$`
fn is_capability(c: &str) -> bool {
    let mut parts = c.split('.');
    let head = parts.next().unwrap_or_default();
    !head.is_empty()
        && head.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_')
        && parts.all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::assert_api_type;

    #[test]
    fn meta_types_match_the_schema_fixtures() {
        assert_api_type::<Meta>("Meta");
        assert_api_type::<ProtocolRange>("ProtocolRange");
        assert_api_type::<OrgRef>("OrgRef");
        assert_api_type::<Deprecation>("Deprecation");
    }
}

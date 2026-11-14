//! The owner-only credentials store: `<root>/cloud/credentials.json` (D5).
//!
//! One schema-versioned JSON record holds every secret (the tunnel token, the machine
//! key's PKCS#8 document, the D24 handoff consent key) and every pairing-derived value
//! (machine id, hostname, Access team domain and AUD, owner email, org, origin port).
//! Writers serialize on an exclusive `flock` of `credentials.lock` and replace the file
//! atomically at `0600`; readers take no lock, since the rename makes every read whole.
//!
//! Public API (Phases 10, 11 and 12 depend on exactly this):
//! - `read(&CloudPaths) -> Result<Option<Credentials>, CredentialsError>`
//! - `update(&CloudPaths, |Option<Credentials>| -> Result<Option<Credentials>, _>)`:
//!   read-modify-write under the lock; returning `None` deletes the file.
//! - `delete(&CloudPaths)`, `revision(&CloudPaths) -> Option<CredentialsRevision>`
//! - `stamp_revoked(&CloudPaths)`, `rotate_consent_key(&CloudPaths)`
//! - `read_handoff_consent_key(&CloudPaths) -> Result<Option<HandoffConsentKey>, _>`
//!   (lock-free, call per request: a rotation by another process applies at once)
//!
//! - Secrets never reach `Debug`, logs, config or SQLite. There is deliberately no
//!   `Display` for `Credentials`.
//! - A symlinked file is refused; a file with group/other bits is tightened and warned.
//! - Blocking I/O: worker or CLI threads only.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/credentials.rs
//! ├── cloud::credentials::tests
//! ├── cloud::paths
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::rules
//! ├── file_modes
//! └── private_file
//! External: chrono, ring, serde, serde_json, std, tracing
//!
//! Used by:
//! cloud/credentials.rs
//! ├── cloud
//! ├── cloud::actions
//! ├── cloud::cli::manage
//! ├── cloud::cli::pair_phone
//! ├── cloud::cli::tests
//! ├── cloud::credentials::tests
//! ├── cloud::leg_identity
//! ├── cloud::login
//! ├── cloud::machine_api
//! ├── cloud::machine_api_error
//! ├── cloud::push_link
//! ├── cloud::status
//! ├── cloud::test_support
//! ├── yaran-core[test cloud_login]
//! ├── yaran-core[test cloud_machine_api]
//! ├── yaran-core[test cloud_push_emitter]
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-web::cloud_ingress
//! ├── yaran-web::cloud_phone_routes
//! └── yaran-web::cloud_routes::tests
//! <module-headers:end>

use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::ClaimResponse;
use crate::cloud::protocol::rules::{b64url_decode, b64url_encode};

/// The only schema this build reads and writes.
pub const CREDENTIALS_SCHEMA: u64 = 1;

/// The paired machine's record. Field names are the on-disk names.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub schema: u64,
    pub org_url: String,
    pub machine_id: String,
    pub hostname: String,
    pub team_domain: String,
    pub aud: String,
    /// `ClaimResponse.owner_email`: the only email Phase 11's JWT check accepts (D3).
    pub owner_email: String,
    pub org_name: String,
    pub origin_port: u16,
    pub protocol: u32,
    /// RFC 3339.
    pub paired_at: String,
    /// Stamped on any `410 machine_revoked`; the record is kept for `status`.
    pub revoked_at: Option<String>,
    /// Secret: base64url PKCS#8 v2 of the Ed25519 machine key.
    pub machine_key_pkcs8: String,
    /// Secret: the cloudflared tunnel token.
    pub tunnel_token: String,
    pub token_version: i64,
    /// Secret (D24): base64url of 32 random bytes.
    pub handoff_consent_key: String,
    /// The consent cookie's `kv`, >= 1.
    pub handoff_consent_key_version: u32,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("schema", &self.schema)
            .field("org_url", &self.org_url)
            .field("machine_id", &self.machine_id)
            .field("hostname", &self.hostname)
            .field("team_domain", &self.team_domain)
            .field("aud", &self.aud)
            .field("owner_email", &self.owner_email)
            .field("org_name", &self.org_name)
            .field("origin_port", &self.origin_port)
            .field("protocol", &self.protocol)
            .field("paired_at", &self.paired_at)
            .field("revoked_at", &self.revoked_at)
            .field("machine_key_pkcs8", &"<redacted>")
            .field("tunnel_token", &"<redacted>")
            .field("token_version", &self.token_version)
            .field("handoff_consent_key", &"<redacted>")
            .field(
                "handoff_consent_key_version",
                &self.handoff_consent_key_version,
            )
            .finish()
    }
}

/// The D24 consent MAC key and its version (the cookie's `kv`).
#[derive(Clone, PartialEq, Eq)]
pub struct HandoffConsentKey {
    pub key: [u8; 32],
    pub version: u32,
}

impl fmt::Debug for HandoffConsentKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HandoffConsentKey")
            .field("key", &"<redacted>")
            .field("version", &self.version)
            .finish()
    }
}

impl HandoffConsentKey {
    /// A fresh random key at `version`.
    pub fn generate(version: u32) -> Result<Self, CredentialsError> {
        let mut key = [0u8; 32];
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| CredentialsError::Io("the system random source failed".into()))?;
        Ok(Self { key, version })
    }

    /// The key for a new claim: version one above `previous`, or 1.
    pub fn for_claim(previous: Option<&Credentials>) -> Result<Self, CredentialsError> {
        let version = previous.map_or(1, |c| c.handoff_consent_key_version.saturating_add(1));
        Self::generate(version)
    }
}

/// Why the credentials could not be read or written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialsError {
    /// A newer yaran wrote it; never rewritten.
    NewerSchema(u64),
    /// The path is a symlink; refused rather than followed.
    Symlink,
    /// Not a record this build can use (bad JSON, a missing field, a bad key).
    Malformed(String),
    Io(String),
}

impl fmt::Display for CredentialsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NewerSchema(found) => write!(
                f,
                "the cloud credentials file was written by a newer yaran (schema {found}); \
                 upgrade yaran or run `yaran cloud logout --local-only`"
            ),
            Self::Symlink => write!(
                f,
                "the cloud credentials file is a symlink, which yaran refuses to follow; \
                 replace it with a regular file or run `yaran cloud logout --local-only`"
            ),
            Self::Malformed(why) => write!(
                f,
                "the cloud credentials file is unreadable ({why}); run \
                 `yaran cloud logout --local-only` and log in again"
            ),
            Self::Io(why) => write!(f, "the cloud credentials file could not be used: {why}"),
        }
    }
}

impl std::error::Error for CredentialsError {}

fn io_err(e: impl fmt::Display) -> CredentialsError {
    CredentialsError::Io(e.to_string())
}

impl Credentials {
    /// The record for a successful claim (`ClaimResponse` mapping, 02 §6).
    pub fn from_claim(
        claim: &ClaimResponse,
        machine_key_pkcs8: &[u8],
        consent: &HandoffConsentKey,
        paired_at: String,
    ) -> Self {
        Self {
            schema: CREDENTIALS_SCHEMA,
            org_url: claim.org.url.clone(),
            machine_id: claim.machine_id.clone(),
            hostname: claim.hostname.clone(),
            team_domain: claim.access.team_domain.clone(),
            aud: claim.access.aud.clone(),
            owner_email: claim.owner_email.clone(),
            org_name: claim.org.name.clone(),
            origin_port: u16::try_from(claim.origin_port).unwrap_or(0),
            protocol: u32::try_from(claim.protocol).unwrap_or(1),
            paired_at,
            revoked_at: None,
            machine_key_pkcs8: b64url_encode(machine_key_pkcs8),
            tunnel_token: claim.tunnel.token.clone(),
            token_version: claim.tunnel.token_version,
            handoff_consent_key: b64url_encode(&consent.key),
            handoff_consent_key_version: consent.version,
        }
    }

    /// The decoded PKCS#8 machine key.
    pub fn machine_key_der(&self) -> Result<Vec<u8>, CredentialsError> {
        b64url_decode(&self.machine_key_pkcs8)
            .ok_or_else(|| CredentialsError::Malformed("machine_key_pkcs8 is not base64url".into()))
    }

    /// The D24 consent key.
    pub fn consent_key(&self) -> Result<HandoffConsentKey, CredentialsError> {
        let key: [u8; 32] = b64url_decode(&self.handoff_consent_key)
            .and_then(|k| k.try_into().ok())
            .ok_or_else(|| {
                CredentialsError::Malformed("handoff_consent_key is not 32 bytes".into())
            })?;
        if self.handoff_consent_key_version == 0 {
            return Err(CredentialsError::Malformed(
                "handoff_consent_key_version is 0".into(),
            ));
        }
        Ok(HandoffConsentKey {
            key,
            version: self.handoff_consent_key_version,
        })
    }

    /// Replace the consent key (D24).
    pub fn set_consent_key(&mut self, consent: &HandoffConsentKey) {
        self.handoff_consent_key = b64url_encode(&consent.key);
        self.handoff_consent_key_version = consent.version;
    }

    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }

    fn check(&self) -> Result<(), CredentialsError> {
        self.machine_key_der()?;
        self.consent_key()?;
        Ok(())
    }
}

/// Cheap change detection: `(dev, ino, len, mtime_ns)` of the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CredentialsRevision {
    pub dev: u64,
    pub ino: u64,
    pub len: u64,
    pub mtime_ns: i128,
}

/// The current revision, or `None` when there is no file.
pub fn revision(paths: &CloudPaths) -> Option<CredentialsRevision> {
    let meta = fs::symlink_metadata(&paths.credentials).ok()?;
    Some(CredentialsRevision {
        dev: meta.dev(),
        ino: meta.ino(),
        len: meta.len(),
        mtime_ns: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
    })
}

/// Read the record, or `None` when the machine is not paired. Takes no lock.
pub fn read(paths: &CloudPaths) -> Result<Option<Credentials>, CredentialsError> {
    let meta = match fs::symlink_metadata(&paths.credentials) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(e)),
    };
    if meta.file_type().is_symlink() {
        return Err(CredentialsError::Symlink);
    }
    if meta.permissions().mode() & 0o077 != 0 {
        tracing::warn!(
            target: "yaran::cloud",
            path = %paths.credentials.display(),
            "the cloud credentials file was readable by others; tightening it to 0600"
        );
        crate::file_modes::restrict_to_owner_best_effort(&paths.credentials, "credentials file");
    }
    let bytes = match fs::read(&paths.credentials) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(e)),
    };
    parse(&bytes).map(Some)
}

fn parse(bytes: &[u8]) -> Result<Credentials, CredentialsError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| CredentialsError::Malformed(e.to_string()))?;
    match value.get("schema").and_then(serde_json::Value::as_u64) {
        Some(CREDENTIALS_SCHEMA) => {}
        Some(found) if found > CREDENTIALS_SCHEMA => {
            return Err(CredentialsError::NewerSchema(found));
        }
        _ => return Err(CredentialsError::Malformed("unknown schema".into())),
    }
    let creds: Credentials =
        serde_json::from_value(value).map_err(|e| CredentialsError::Malformed(e.to_string()))?;
    creds.check()?;
    Ok(creds)
}

fn write_locked(paths: &CloudPaths, creds: &Credentials) -> Result<(), CredentialsError> {
    let mut body = serde_json::to_vec_pretty(creds).map_err(io_err)?;
    body.push(b'\n');
    crate::private_file::write_private_atomic(&paths.credentials, &body).map_err(io_err)
}

/// Read-modify-write under the writers' lock. `f` sees the current record (or `None`);
/// it returns the record to store, or `None` to delete the file. Returns what was stored.
pub fn update<F>(paths: &CloudPaths, f: F) -> Result<Option<Credentials>, CredentialsError>
where
    F: FnOnce(Option<Credentials>) -> Result<Option<Credentials>, CredentialsError>,
{
    paths.ensure_dir().map_err(io_err)?;
    let _lock = crate::private_file::lock_exclusive(&paths.lock).map_err(io_err)?;
    let next = f(read(paths)?)?;
    match &next {
        Some(creds) => write_locked(paths, creds)?,
        None => remove_file(paths)?,
    }
    Ok(next)
}

fn remove_file(paths: &CloudPaths) -> Result<(), CredentialsError> {
    match fs::remove_file(&paths.credentials) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

/// Forget the credentials (logout). Works on an unreadable file too, so
/// `logout --local-only` is always a way out.
pub fn delete(paths: &CloudPaths) -> Result<(), CredentialsError> {
    paths.ensure_dir().map_err(io_err)?;
    let _lock = crate::private_file::lock_exclusive(&paths.lock).map_err(io_err)?;
    remove_file(paths)
}

/// Stamp `revoked_at` (any `410 machine_revoked`). A no-op when unpaired or already stamped.
pub fn stamp_revoked(paths: &CloudPaths) -> Result<(), CredentialsError> {
    update(paths, |current| {
        Ok(current.map(|mut c| {
            if c.revoked_at.is_none() {
                c.revoked_at = Some(chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string());
            }
            c
        }))
    })
    .map(|_| ())
}

/// `yaran cloud rotate --consent-key` (D24): fresh key, version + 1, no network call.
/// `Ok(None)` when not paired.
pub fn rotate_consent_key(paths: &CloudPaths) -> Result<Option<Credentials>, CredentialsError> {
    update(paths, |current| {
        let Some(mut c) = current else {
            return Ok(None);
        };
        let next = HandoffConsentKey::generate(c.handoff_consent_key_version.saturating_add(1))?;
        c.set_consent_key(&next);
        Ok(Some(c))
    })
}

/// The D24 consent key for Phase 11, read per request without a lock.
pub fn read_handoff_consent_key(
    paths: &CloudPaths,
) -> Result<Option<HandoffConsentKey>, CredentialsError> {
    read(paths)?.map(|c| c.consent_key()).transpose()
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;

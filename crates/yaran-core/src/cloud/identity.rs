//! The machine's identity: its Ed25519 key, the key's fingerprint, and its name.
//!
//! The key is generated at login (`ring`, PKCS#8 v2), stored base64url in the
//! credentials, and reloaded for every signed request. The fingerprint is 02 §7.1's
//! `MachineKeyFingerprint`, computed by `cloud::protocol::fingerprint`; this module
//! never re-derives it. The machine name is 02's `MachineName`, slugified from the
//! short hostname unless `--name` gives one.
//!
//! - The private key never leaves the `Ed25519KeyPair` and is never logged.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/identity.rs
//! ├── cloud::protocol::fingerprint
//! └── cloud::protocol::rules
//! External: ring, std, sysinfo
//!
//! Used by:
//! cloud/identity.rs
//! ├── cloud
//! ├── cloud::login
//! ├── cloud::machine_api
//! └── yaran-core[test cloud_machine_api]
//! <module-headers:end>

use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};

use crate::cloud::protocol::fingerprint::machine_key_fingerprint;
use crate::cloud::protocol::rules::{b64url_encode, is_machine_name};

/// A loaded machine key and its PKCS#8 document.
pub struct MachineIdentity {
    pkcs8: Vec<u8>,
    key: Ed25519KeyPair,
}

impl std::fmt::Debug for MachineIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MachineIdentity")
            .field("fingerprint", &self.fingerprint())
            .finish_non_exhaustive()
    }
}

impl MachineIdentity {
    /// A fresh key.
    pub fn generate() -> Result<Self, String> {
        let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "the system random source failed while generating the machine key")?;
        Self::from_pkcs8(doc.as_ref())
    }

    /// Load a stored PKCS#8 document.
    pub fn from_pkcs8(pkcs8: &[u8]) -> Result<Self, String> {
        let key = Ed25519KeyPair::from_pkcs8(pkcs8)
            .map_err(|_| "the stored machine key is not a valid Ed25519 PKCS#8 document")?;
        Ok(Self {
            pkcs8: pkcs8.to_vec(),
            key,
        })
    }

    pub fn key_pair(&self) -> &Ed25519KeyPair {
        &self.key
    }

    pub fn pkcs8(&self) -> &[u8] {
        &self.pkcs8
    }

    pub fn public_key(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.key.public_key().as_ref());
        out
    }

    /// `Ed25519PublicKey` for the authorize query (base64url, 43 chars).
    pub fn public_key_b64(&self) -> String {
        b64url_encode(&self.public_key())
    }

    /// 02 §7.1 display form, e.g. `K7QF-3MZD-W2PA-HX5R-LC4N-TB6E`.
    pub fn fingerprint(&self) -> String {
        machine_key_fingerprint(&self.public_key())
    }
}

/// The default machine name: the short hostname, slugified.
pub fn default_machine_name() -> String {
    slugify_machine_name(&sysinfo::System::host_name().unwrap_or_default())
}

/// Slugify a hostname into a `MachineName`: first label only, lowercase, every run of
/// other characters one `-`, no leading/trailing `-`, at most 32; empty → `machine`.
pub fn slugify_machine_name(host: &str) -> String {
    let short = host.split('.').next().unwrap_or_default();
    let mut out = String::new();
    for c in short.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(32).collect();
    let trimmed = trimmed.trim_end_matches('-');
    if trimmed.is_empty() {
        "machine".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Check a `--name`: it must already be a `MachineName`. The error names the rule and
/// suggests the slugified form.
pub fn check_machine_name(name: &str) -> Result<(), String> {
    if is_machine_name(name) {
        return Ok(());
    }
    Err(format!(
        "{name:?} is not a valid machine name: use 1 to 32 lowercase letters, digits and \
         hyphens, starting and ending with a letter or digit (try --name {})",
        slugify_machine_name(name)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ED25519, UnparsedPublicKey};

    #[test]
    fn a_reloaded_key_signs_identically_and_verifies() {
        let id = MachineIdentity::generate().unwrap();
        let again = MachineIdentity::from_pkcs8(id.pkcs8()).unwrap();
        let msg = b"yaran";
        let sig = id.key_pair().sign(msg);
        assert_eq!(sig.as_ref(), again.key_pair().sign(msg).as_ref());
        UnparsedPublicKey::new(&ED25519, id.public_key())
            .verify(msg, sig.as_ref())
            .unwrap();
        assert_eq!(id.public_key_b64().len(), 43);
        assert!(crate::cloud::protocol::rules::is_fingerprint(
            &id.fingerprint()
        ));
        assert!(!format!("{id:?}").contains(&b64url_encode(id.pkcs8())));
        assert!(MachineIdentity::from_pkcs8(b"junk").is_err());
    }

    #[test]
    fn machine_name_slug_table() {
        let long = "a".repeat(40);
        for (host, want) in [
            ("laptop.local", "laptop"),
            ("Sams-MacBook-Pro", "sams-macbook-pro"),
            ("büro_rechner", "b-ro-rechner"),
            ("--x--", "x"),
            ("!!!", "machine"),
            ("", "machine"),
            (long.as_str(), &long[..32]),
            (
                "abcdefghijklmnopqrstuvwxyz01234-5",
                "abcdefghijklmnopqrstuvwxyz01234",
            ),
        ] {
            let got = slugify_machine_name(host);
            assert_eq!(got, want, "{host:?}");
            assert!(is_machine_name(&got), "{got}");
        }
    }

    #[test]
    fn a_bad_name_is_refused_with_the_slug_suggested() {
        assert!(check_machine_name("laptop-2").is_ok());
        let err = check_machine_name("My Laptop").unwrap_err();
        assert!(err.contains("--name my-laptop"), "{err}");
    }
}

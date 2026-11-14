//! The handoff consent page's CSRF store (Phase 11 §7): the token the consent page's form
//! carries back, minted only for a verified owner and redeemable once.
//!
//! Each token is bound to the request it was minted for (`state`, the SHA-256 of `pk`,
//! the device key's fingerprint) and records whether that GET's device signature
//! verified, which decides whether the Continue may set the remembered-consent cookie.
//!
//! - Single use: a redeem removes the entry whether or not it matches.
//! - At most 64 pending, oldest evicted; each valid for 10 minutes on the injected clock.
//!
//! <module-headers:begin>
//! Uses:
//! handoff_csrf.rs
//! └── yaran-core::cloud::protocol::rules
//! External: ring, std
//!
//! Used by:
//! handoff_csrf.rs
//! ├── cloud_handoff
//! ├── cloud_ingress
//! └── crate
//! <module-headers:end>

use std::collections::VecDeque;
use std::sync::Mutex;

use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};

pub(crate) const CSRF_TTL_SECS: u64 = 600;
pub(crate) const CSRF_MAX_PENDING: usize = 64;

/// What a token was minted for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CsrfBinding {
    pub state: String,
    pub pk_hash: [u8; 32],
    pub dk_fp24: String,
    pub verified: bool,
}

impl CsrfBinding {
    pub(crate) fn new(state: &str, pk: &str, dk_fp24: &str, verified: bool) -> Self {
        Self {
            state: state.to_string(),
            pk_hash: pk_hash(pk),
            dk_fp24: dk_fp24.to_string(),
            verified,
        }
    }
}

fn pk_hash(pk: &str) -> [u8; 32] {
    digest(&SHA256, pk.as_bytes())
        .as_ref()
        .try_into()
        .expect("SHA-256 is 32 bytes")
}

#[derive(Debug, Default)]
pub(crate) struct CsrfStore {
    pending: Mutex<VecDeque<(String, CsrfBinding, u64)>>,
}

impl CsrfStore {
    /// Mints a 43-character base64url token (32 random bytes) for `binding` at `now`.
    /// `None` only when the system random source fails.
    pub(crate) fn mint(&self, binding: CsrfBinding, now: u64) -> Option<String> {
        let mut raw = [0u8; 32];
        SystemRandom::new().fill(&mut raw).ok()?;
        let token = yaran_core::cloud::protocol::rules::b64url_encode(&raw);
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        while pending.len() >= CSRF_MAX_PENDING {
            pending.pop_front();
        }
        pending.push_back((token.clone(), binding, now));
        Some(token)
    }

    /// Takes `token` out of the store and returns its recorded signature verdict when
    /// it is unexpired and bound to this `state`, `pk` and device key.
    pub(crate) fn redeem(
        &self,
        token: &str,
        state: &str,
        pk: &str,
        dk_fp24: &str,
        now: u64,
    ) -> Option<bool> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let at = pending.iter().position(|(t, _, _)| t == token)?;
        let (_, binding, minted) = pending.remove(at)?;
        let fresh = now >= minted && now - minted < CSRF_TTL_SECS;
        let bound =
            binding.state == state && binding.pk_hash == pk_hash(pk) && binding.dk_fp24 == dk_fp24;
        (fresh && bound).then_some(binding.verified)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "aGFuZG9mZi1zdGF0ZS1maXh0dXJl";

    fn mint(store: &CsrfStore, verified: bool, now: u64) -> String {
        store
            .mint(CsrfBinding::new(STATE, "PK", "FP", verified), now)
            .unwrap()
    }

    #[test]
    fn a_token_is_43_characters_and_redeems_once_with_its_verdict() {
        let store = CsrfStore::default();
        let token = mint(&store, true, 100);
        assert_eq!(token.len(), 43);
        assert_eq!(store.redeem(&token, STATE, "PK", "FP", 100), Some(true));
        assert_eq!(store.redeem(&token, STATE, "PK", "FP", 100), None);
        let token = mint(&store, false, 100);
        assert_eq!(store.redeem(&token, STATE, "PK", "FP", 100), Some(false));
    }

    #[test]
    fn it_expires_at_ten_minutes() {
        let store = CsrfStore::default();
        let token = mint(&store, true, 1_000);
        assert_eq!(store.redeem(&token, STATE, "PK", "FP", 1_599), Some(true));
        let token = mint(&store, true, 1_000);
        assert_eq!(store.redeem(&token, STATE, "PK", "FP", 1_600), None);
    }

    #[test]
    fn a_mismatched_state_pk_or_device_key_is_refused_and_burns_the_token() {
        let store = CsrfStore::default();
        for (state, pk, fp) in [
            ("other-state-other-state-1", "PK", "FP"),
            (STATE, "PK2", "FP"),
            (STATE, "PK", "FP2"),
        ] {
            let token = mint(&store, true, 0);
            assert_eq!(store.redeem(&token, state, pk, fp, 0), None);
            assert_eq!(store.redeem(&token, STATE, "PK", "FP", 0), None);
        }
    }

    #[test]
    fn the_oldest_is_evicted_past_64_pending() {
        let store = CsrfStore::default();
        let first = mint(&store, true, 0);
        let rest: Vec<_> = (0..CSRF_MAX_PENDING)
            .map(|_| mint(&store, true, 0))
            .collect();
        assert_eq!(store.redeem(&first, STATE, "PK", "FP", 0), None);
        assert_eq!(store.redeem(&rest[0], STATE, "PK", "FP", 0), Some(true));
        assert_eq!(store.redeem("never-minted", STATE, "PK", "FP", 0), None);
    }
}

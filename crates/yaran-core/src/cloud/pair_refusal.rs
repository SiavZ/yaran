//! Why a pairing came back refused from the browser, in words the person can act on.
//!
//! The confirm page redirects to the loopback callback with only `?error=<code>`, and
//! the page it lands on tells the person the terminal explains why. This is that
//! explanation: one sentence per code in the Phase 02 registry, matched
//! exhaustively so a new code cannot ship without one.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/pair_refusal.rs
//! └── cloud::protocol::errors
//! External: none
//!
//! Used by:
//! cloud/pair_refusal.rs
//! ├── cloud
//! └── cloud::login
//! <module-headers:end>

use crate::cloud::protocol::errors::ErrorCode;

/// The reason behind a refused pairing whose callback carried `code`, phrased to sit
/// inside "The control plane refused to pair this machine: <reason> (<code>)".
pub fn pair_refusal_reason(code: &str) -> &'static str {
    match ErrorCode::parse(code) {
        ErrorCode::PairDenied => {
            "someone pressed Deny on the confirm page in the browser, so this machine was not added; start the login again and choose Approve if that was a mistake"
        }
        ErrorCode::PairingNotAllowed => {
            "the organization's pairing policy does not let your account pair machines; ask an administrator to add your email address or domain to the pairing policy, then start the login again"
        }
        ErrorCode::PairRequestExpired => {
            "the pairing request expired before it was approved in the browser; start the login again and approve it in the tab that opens"
        }
        ErrorCode::PairCodeInvalid => {
            "the one-time pairing code was no longer valid when this machine claimed it; start the login again"
        }
        ErrorCode::PkceMismatch => {
            "the pairing code belongs to a different login attempt than this one; start the login again from this machine"
        }
        ErrorCode::PairRequestInvalid | ErrorCode::PairCallbackInvalid => {
            "the control plane could not accept this login's request or its callback address, which usually means this yaran and the control plane disagree about the protocol; update yaran, start the login again, and tell your administrator if it keeps happening"
        }
        ErrorCode::MachineNameInvalid => {
            "the control plane refused this machine's name; start the login again with a different machine name"
        }
        ErrorCode::MachineCapReached => {
            "your account already has as many machines as the organization allows; remove one you no longer use from the console, or ask an administrator to raise the limit, then start the login again"
        }
        ErrorCode::AccountQuotaReached => {
            "the organization's Cloudflare account has no room for another tunnel; ask an administrator to free one or raise the account's quota, then start the login again"
        }
        ErrorCode::HostnameConflict => {
            "another machine already holds the address this one would get; start the login again with a different machine name, or choose Replace in the browser if the old machine is gone"
        }
        ErrorCode::ProvisioningInProgress | ErrorCode::MachineNotReady => {
            "the control plane is still setting up a tunnel for this machine; wait a minute and start the login again"
        }
        ErrorCode::ProvisioningFailed
        | ErrorCode::CloudflareApiFailed
        | ErrorCode::CloudflareUnavailable
        | ErrorCode::CloudflareRateLimited => {
            "the control plane could not set up this machine's tunnel with Cloudflare just now; start the login again in a few minutes, and ask an administrator to check the console if it keeps failing"
        }
        ErrorCode::CloudflarePermissionDenied => {
            "the control plane's Cloudflare token is missing a permission pairing needs; ask an administrator to fix the token in the console, then start the login again"
        }
        ErrorCode::OriginPortInvalid => {
            "the control plane refused the port this machine's yaran serves on; check the server port in your yaran config, then start the login again"
        }
        ErrorCode::Unauthenticated => {
            "the browser was not signed in to the organization when the pairing was confirmed; sign in through the organization's login page and start the login again"
        }
        ErrorCode::UserDisabled => {
            "your account is disabled in this organization; ask an administrator to enable it, then start the login again"
        }
        ErrorCode::Forbidden => {
            "your account is not allowed to pair machines in this organization; ask an administrator for access, then start the login again"
        }
        ErrorCode::MachineUnknown | ErrorCode::MachineRevoked => {
            "the control plane no longer knows the machine this login was pairing, for example because an administrator removed it meanwhile; start the login again"
        }
        ErrorCode::SignatureMissing | ErrorCode::SignatureInvalid | ErrorCode::NonceReplayed => {
            "the control plane could not verify this machine's signature; start the login again, and update yaran if it keeps happening"
        }
        ErrorCode::SignatureExpired => {
            "this machine's signature arrived outside the allowed time window, which usually means its clock is wrong; correct the system clock and start the login again"
        }
        ErrorCode::ProtocolUnsupported => {
            "this yaran and the control plane speak different protocol versions; update yaran, or ask your administrator to update the control plane if yaran is the newer one"
        }
        ErrorCode::RateLimited => {
            "the control plane is limiting how often pairing can be tried; wait a few minutes and start the login again"
        }
        ErrorCode::Internal | ErrorCode::Unavailable | ErrorCode::IdentityUnavailable => {
            "the control plane hit a temporary problem; start the login again in a few minutes, and tell your administrator if it keeps happening"
        }
        ErrorCode::SetupIncomplete => {
            "the organization's setup is not finished; ask the administrator to complete the setup wizard, then start the login again"
        }
        ErrorCode::OriginMismatch | ErrorCode::MisdirectedHost => {
            "the request reached the control plane under an address it does not answer for; check the organization address you logged in with and start the login again"
        }
        ErrorCode::Conflict => {
            "the pairing collided with another change made at the same moment; start the login again"
        }
        ErrorCode::BadRequest
        | ErrorCode::ValidationFailed
        | ErrorCode::NotFound
        | ErrorCode::MethodNotAllowed
        | ErrorCode::PayloadTooLarge
        | ErrorCode::UnsupportedMediaType => {
            "the control plane could not understand this login's request, which points at a version mismatch between yaran and the control plane; update yaran, start the login again, and tell your administrator if it keeps happening"
        }
        // Codes from other parts of the protocol: the confirm page should never send
        // them, so the honest sentence is that something is wrong on its side.
        ErrorCode::ServiceTokenRejected
        | ErrorCode::DeviceRevoked
        | ErrorCode::SetupClosed
        | ErrorCode::SetupCodeInvalid
        | ErrorCode::SetupLocked
        | ErrorCode::SetupClaimInvalid
        | ErrorCode::TunnelDeleteBlocked
        | ErrorCode::HandoffRequestInvalid
        | ErrorCode::HandoffDeclined
        | ErrorCode::HandoffDeviceKeyInvalid
        | ErrorCode::HandoffSignatureMalformed
        | ErrorCode::HandoffTimestampSkewed
        | ErrorCode::HandoffJwtMissing
        | ErrorCode::HandoffOwnerMismatch
        | ErrorCode::DeviceCapReached
        | ErrorCode::PushEndpointInvalid
        | ErrorCode::PushRelayDisallowed
        | ErrorCode::PushDisabled
        | ErrorCode::LastAdmin
        | ErrorCode::RelayAppUnknown
        | ErrorCode::RelayVapidInvalid
        | ErrorCode::RelayVapidMismatch
        | ErrorCode::RelayEndpointInvalid
        | ErrorCode::RelayUpstreamFailed
        | ErrorCode::PushEndpointGone => {
            "the control plane answered with a reason that has nothing to do with pairing, which points at a problem on its side; start the login again, and give your administrator this code if it repeats"
        }
        ErrorCode::Unknown => {
            "the control plane gave a reason this yaran does not know, probably because the control plane is newer; update yaran to see an explanation, and start the login again"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_code_gets_an_actionable_sentence() {
        let codes = ErrorCode::ALL.iter().map(|c| c.as_str());
        for code in codes.chain(["not_a_registry_code"]) {
            let reason = pair_refusal_reason(code);
            // A reason says what to do next, and never repeats the raw code it explains.
            assert!(reason.contains("; "), "{code}: {reason}");
            assert!(!reason.contains(code), "{code}: {reason}");
            assert!(
                !reason.ends_with('.'),
                "{code}: the report adds the punctuation"
            );
        }
    }

    #[test]
    fn the_codes_the_confirm_page_sends_get_their_own_sentence() {
        let generic = pair_refusal_reason("relay_app_unknown");
        for code in [
            "pair_denied",
            "pairing_not_allowed",
            "pair_request_expired",
            "machine_cap_reached",
            "hostname_conflict",
            "user_disabled",
            "rate_limited",
        ] {
            assert_ne!(pair_refusal_reason(code), generic, "{code}");
        }
        assert!(pair_refusal_reason("pair_denied").contains("pressed Deny"));
    }
}

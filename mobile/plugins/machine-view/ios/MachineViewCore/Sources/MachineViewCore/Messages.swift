/// The one failure table, as the native machine window and sign-in client show it.
///
/// A copy of `fixtures/messages.json` (the Phase 15 failure matrix and overlays) kept word for
/// word by a test, so the shell (which renders the same file directly), the Android twin and
/// this file cannot drift. `fill` substitutes `{host}`, `{machine}`, `{email}`, `{domain}`
/// and `{code}`.
///
/// - Pure constants. Names are substituted as plain text; a caller never passes a credential.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/Messages
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineView/OverlayView (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// └── MachineViewCoreTests/FormatTests (inferred)
/// <module-headers:end>
import Foundation

public enum Messages {
    public struct Row: Equatable {
        public let message: String
        public let actions: [String]

        public init(message: String, actions: [String]) { (self.message, self.actions) = (message, actions) }
    }

    public static let signIn: [String: Row] = [
        "cancelled": Row(message: "Sign-in was cancelled.", actions: ["try_again"]),
        "declined": Row(message: "You chose Cancel on the sign-in page, so this phone wasn't signed in.", actions: ["try_again"]),
        "interrupted": Row(message: "The app was closed while you were signing in, so that sign-in can't finish. Start it again.", actions: ["try_again"]),
        "verification_failed": Row(message: "This copy of the app couldn't prove it owns the sign-in link for {domain}. Install the app from an official channel, or try again later.", actions: ["try_again"]),
        "rate_limited": Row(message: "Too many sign-ins in a short time. Wait a minute and try again.", actions: ["try_again"]),
        "protocol_unsupported": Row(message: "This app and {host} don't speak the same protocol version. Update whichever side is older, then try again.", actions: ["back"]),
        "clock_skewed": Row(message: "This phone's clock is more than five minutes off from {host}, so the sign-in was refused. Set the clock automatically and try again.", actions: ["try_again"]),
        "device_key_rejected": Row(message: "The sign-in page refused this request ({code}). Update the app.", actions: ["back"]),
        "refused": Row(message: "The sign-in page refused this request ({code}). Update the app.", actions: ["back"]),
        "no_browser": Row(message: "Install or enable a browser (Chrome, Firefox, Brave, Vanadium…) to sign in.", actions: ["open_settings"]),
        "mismatch": Row(message: "That sign-in reply didn't match a sign-in from this phone, so it was ignored.", actions: ["try_again"]),
        "decrypt_failed": Row(message: "The sign-in reply couldn't be decrypted. Update the app and yaran on the machine.", actions: ["try_again"]),
        "envelope_expired": Row(message: "The sign-in reply had already expired. Check that this phone's clock is right, then try again.", actions: ["try_again"]),
        "not_owner": Row(message: "{email} isn't the owner of {machine}.", actions: ["back_to_machines"]),
        "offline": Row(message: "No connection. Check your network and try again.", actions: ["retry"]),
        "tls_error": Row(message: "The connection to {host} isn't secure, so the app stopped.", actions: ["back"]),
        "vault_locked": Row(message: "Unlock the app to sign in.", actions: ["unlock"]),
        "secure_storage_failed": Row(message: "This phone's secure storage couldn't create or use the sign-in key, or save the sign-in. Try again; if it keeps failing, restart the phone.", actions: ["try_again"])
    ]

    public static let overlay: [String: Row] = [
        "reauth": Row(message: "Sign-in needed for {machine}", actions: ["sign_in", "back_to_machines"]),
        "not_owner": Row(message: "{email} isn't the owner of {machine}.", actions: ["back_to_machines"]),
        "keys_unavailable": Row(message: "yaran on {machine} can't reach Cloudflare's key service, so signing in again won't help. Try again in a minute.", actions: ["retry"]),
        "unavailable": Row(message: "yaran on {machine} is temporarily unavailable, so signing in again won't help. Try again in a minute.", actions: ["retry"]),
        "host_disconnected": Row(message: "{machine} is no longer connected to the cloud. Check yaran cloud status on the machine.", actions: ["retry", "back_to_machines"]),
        "code_overlay": Row(message: "yaran on {machine} refused this page ({code}).", actions: ["retry", "back_to_machines"]),
        "offline": Row(message: "{machine} is offline or its tunnel isn't connected", actions: ["retry"]),
        "tls_error": Row(message: "The connection to {host} isn't secure, so the app stopped.", actions: ["back_to_machines"]),
        "banner": Row(message: "Your session for {machine} ends in 10 minutes", actions: ["renew"]),
        "download_refused": Row(message: "Downloads aren't supported in the app. Open it in the yaran web UI on your computer.", actions: []),
        "renderer_crashed": Row(message: "The page crashed and was reloaded", actions: []),
        "session_unreadable": Row(message: "The saved sign-in for {machine} can't be read on this phone. Sign in again to replace it.", actions: ["sign_in", "back_to_machines"]),
        "access_on_direct": Row(message: "{machine} is behind Cloudflare Access. Add it through its organization instead.", actions: ["back_to_machines"]),
        "not_yaran": Row(message: "{host} didn't answer as a yaran machine.", actions: ["retry", "back_to_machines"]),
        "redirected": Row(message: "{host} answered with a redirect, so the app stopped before sending anything.", actions: ["back_to_machines"]),
        "direct_offline": Row(message: "{machine} didn't answer. Check that it's on and that this phone can reach it.", actions: ["retry"]),
        "offline_routes": Row(message: "{machine} isn't answering on this route.", actions: ["retry", "try_another_route"]),
        "no_other_route": Row(message: "No other route to {machine} answered.", actions: []),
        "password_sheet": Row(message: "Enter the yaran password for {host}. It goes only to {host}, and the app keeps the sign-in, not the password.", actions: ["sign_in", "cancel"]),
        "share_ready": Row(message: "{count} shared files are ready. Open an agent and choose Attach a file.", actions: ["discard"]),
        "share_confirm": Row(message: "Attach the {count} shared files here?", actions: ["attach_shared", "choose_other"]),
        "share_confirm_single": Row(message: "This page takes one file. Attach the first of the {count} shared files here?", actions: ["attach_shared", "choose_other"]),
        "share_unsupported": Row(message: "This version of iOS can't hand shared files to the page. Update to iOS 18.4 or later.", actions: [])
    ]

    /// The machine window's own sentence for a failed direct sign-in, keyed by `DirectSignInOutcome` kind.
    public static let direct: [String: String] = [
        "cancelled": "Sign-in was cancelled.",
        "wrong_password": "{host} didn't accept that password.",
        "rate_limited": "{host} is refusing sign-ins for a while. Wait, then try again.",
        "no_password": "{host} has no password set. Set one on the machine first.",
        "server_refused": "{host} refused the sign-in ({code}).",
        "not_yaran": "{host} didn't answer as a yaran machine.",
        "access_required": "{host} is behind Cloudflare Access. Add it through its organization instead.",
        "upgrade_required": "yaran on {host} is too old for the app. Update yaran on that machine, then try again.",
        "redirected": "{host} answered with a redirect, so the password wasn't sent.",
        "offline": "No connection to {host}. Check your network and try again.",
        "tls_error": "The connection to {host} isn't secure, so the app stopped.",
        "vault_locked": "Unlock the app to sign in.",
        "refused": "The app refused this sign-in ({code}).",
        "secure_storage_failed": "This phone's secure storage couldn't save the sign-in. Try again; if it keeps failing, restart the phone."
    ]

    public static func fill(_ template: String, _ vars: [String: String]) -> String {
        var out = template
        for key in ["host", "machine", "email", "domain", "code", "count"] {
            out = out.replacingOccurrences(of: "{\(key)}", with: vars[key] ?? key)
        }
        return out
    }
}

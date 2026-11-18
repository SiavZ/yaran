/**
 * The one failure table (Phase 15 Failure matrix): sign-in outcomes and machine-window overlays.
 *
 * Every row is a sentence and its action, word for word as `fixtures/messages.json`, which
 * the TypeScript shell and the Swift twin read too; a test pins this copy to that file.
 * Placeholders `{host}`, `{machine}`, `{email}`, `{domain}` and `{code}` are filled by [fill].
 *
 * - Pure constants. Keys are the outcome and overlay kinds used across the plugin.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Messages
 * ├── io.github.siavz.yaran.machineview.HandoffFailureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.OverlayView (inferred)
 * ├── io.github.siavz.yaran.machineview.PasswordSheet (inferred)
 * ├── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * └── io.github.siavz.yaran.machineview.ShareChooser (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal object Messages {
    data class Row(val message: String, val action: String)

    data class OverlayRow(val message: String, val actions: List<String>)

    val signIn: Map<String, Row> = linkedMapOf(
        "cancelled" to Row("Sign-in was cancelled.", "try_again"),
        "declined" to Row("You chose Cancel on the sign-in page, so this phone wasn't signed in.", "try_again"),
        "interrupted" to Row("The app was closed while you were signing in, so that sign-in can't finish. Start it again.", "try_again"),
        "verification_failed" to Row("This copy of the app couldn't prove it owns the sign-in link for {domain}. Install the app from an official channel, or try again later.", "try_again"),
        "rate_limited" to Row("Too many sign-ins in a short time. Wait a minute and try again.", "try_again"),
        "protocol_unsupported" to Row("This app and {host} don't speak the same protocol version. Update whichever side is older, then try again.", "back"),
        "clock_skewed" to Row("This phone's clock is more than five minutes off from {host}, so the sign-in was refused. Set the clock automatically and try again.", "try_again"),
        "device_key_rejected" to Row("The sign-in page refused this request ({code}). Update the app.", "back"),
        "refused" to Row("The sign-in page refused this request ({code}). Update the app.", "back"),
        "no_browser" to Row("Install or enable a browser (Chrome, Firefox, Brave, Vanadium…) to sign in.", "open_settings"),
        "mismatch" to Row("That sign-in reply didn't match a sign-in from this phone, so it was ignored.", "try_again"),
        "decrypt_failed" to Row("The sign-in reply couldn't be decrypted. Update the app and yaran on the machine.", "try_again"),
        "envelope_expired" to Row("The sign-in reply had already expired. Check that this phone's clock is right, then try again.", "try_again"),
        "not_owner" to Row("{email} isn't the owner of {machine}.", "back_to_machines"),
        "offline" to Row("No connection. Check your network and try again.", "retry"),
        "tls_error" to Row("The connection to {host} isn't secure, so the app stopped.", "back"),
        "vault_locked" to Row("Unlock the app to sign in.", "unlock"),
        "secure_storage_failed" to Row("This phone's secure storage couldn't create or use the sign-in key, or save the sign-in. Try again; if it keeps failing, restart the phone.", "try_again"),
    )

    val overlay: Map<String, OverlayRow> = linkedMapOf(
        "reauth" to OverlayRow("Sign-in needed for {machine}", listOf("sign_in", "back_to_machines")),
        "not_owner" to OverlayRow("{email} isn't the owner of {machine}.", listOf("back_to_machines")),
        "keys_unavailable" to OverlayRow("yaran on {machine} can't reach Cloudflare's key service, so signing in again won't help. Try again in a minute.", listOf("retry")),
        "unavailable" to OverlayRow("yaran on {machine} is temporarily unavailable, so signing in again won't help. Try again in a minute.", listOf("retry")),
        "host_disconnected" to OverlayRow("{machine} is no longer connected to the cloud. Check yaran cloud status on the machine.", listOf("retry", "back_to_machines")),
        "code_overlay" to OverlayRow("yaran on {machine} refused this page ({code}).", listOf("retry", "back_to_machines")),
        "offline" to OverlayRow("{machine} is offline or its tunnel isn't connected", listOf("retry")),
        "tls_error" to OverlayRow("The connection to {host} isn't secure, so the app stopped.", listOf("back_to_machines")),
        "banner" to OverlayRow("Your session for {machine} ends in 10 minutes", listOf("renew")),
        "download_refused" to OverlayRow("Downloads aren't supported in the app. Open it in the yaran web UI on your computer.", listOf()),
        "renderer_crashed" to OverlayRow("The page crashed and was reloaded", listOf()),
        "session_unreadable" to OverlayRow("The saved sign-in for {machine} can't be read on this phone. Sign in again to replace it.", listOf("sign_in", "back_to_machines")),
        "access_on_direct" to OverlayRow("{machine} is behind Cloudflare Access. Add it through its organization instead.", listOf("back_to_machines")),
        "not_yaran" to OverlayRow("{host} didn't answer as a yaran machine.", listOf("retry", "back_to_machines")),
        "redirected" to OverlayRow("{host} answered with a redirect, so the app stopped before sending anything.", listOf("back_to_machines")),
        "direct_offline" to OverlayRow("{machine} didn't answer. Check that it's on and that this phone can reach it.", listOf("retry")),
        "offline_routes" to OverlayRow("{machine} isn't answering on this route.", listOf("retry", "try_another_route")),
        "no_other_route" to OverlayRow("No other route to {machine} answered.", listOf()),
        "password_sheet" to OverlayRow("Enter the yaran password for {host}. It goes only to {host}, and the app keeps the sign-in, not the password.", listOf("sign_in", "cancel")),
        "share_ready" to OverlayRow("{count} shared files are ready. Open an agent and choose Attach a file.", listOf("discard")),
        "share_confirm" to OverlayRow("Attach the {count} shared files here?", listOf("attach_shared", "choose_other")),
        "share_confirm_single" to OverlayRow("This page takes one file. Attach the first of the {count} shared files here?", listOf("attach_shared", "choose_other")),
        "share_unsupported" to OverlayRow("This version of iOS can't hand shared files to the page. Update to iOS 18.4 or later.", listOf()),
    )

    /** The machine window's own sentence for a failed direct sign-in, keyed by `DirectSignInOutcome` kind. */
    val direct: Map<String, String> = linkedMapOf(
        "cancelled" to "Sign-in was cancelled.",
        "wrong_password" to "{host} didn't accept that password.",
        "rate_limited" to "{host} is refusing sign-ins for a while. Wait, then try again.",
        "no_password" to "{host} has no password set. Set one on the machine first.",
        "server_refused" to "{host} refused the sign-in ({code}).",
        "not_yaran" to "{host} didn't answer as a yaran machine.",
        "access_required" to "{host} is behind Cloudflare Access. Add it through its organization instead.",
        "upgrade_required" to "yaran on {host} is too old for the app. Update yaran on that machine, then try again.",
        "redirected" to "{host} answered with a redirect, so the password wasn't sent.",
        "offline" to "No connection to {host}. Check your network and try again.",
        "tls_error" to "The connection to {host} isn't secure, so the app stopped.",
        "vault_locked" to "Unlock the app to sign in.",
        "refused" to "The app refused this sign-in ({code}).",
        "secure_storage_failed" to "This phone's secure storage couldn't save the sign-in. Try again; if it keeps failing, restart the phone.",
    )

    private val PLACEHOLDER = Regex("\\{(host|machine|email|domain|code|count)\\}")

    fun fill(template: String, vars: Map<String, String>): String =
        PLACEHOLDER.replace(template) { vars[it.groupValues[1]] ?: it.groupValues[1] }
}

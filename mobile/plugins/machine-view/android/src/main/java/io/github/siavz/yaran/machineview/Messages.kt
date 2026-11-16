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
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.OverlayView (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
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
    )

    private val PLACEHOLDER = Regex("\\{(host|machine|email|domain|code)\\}")

    fun fill(template: String, vars: Map<String, String>): String =
        PLACEHOLDER.replace(template) { vars[it.groupValues[1]] ?: it.groupValues[1] }
}

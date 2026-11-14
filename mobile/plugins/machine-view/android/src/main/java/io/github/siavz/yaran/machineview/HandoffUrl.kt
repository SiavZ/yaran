/**
 * Builds the sealed-handoff URL the system browser opens (02 §8, §8.1; W16 and Y1).
 *
 * Control-plane handoffs go to `<orgUrl>/v1/handoff`, machine handoffs to
 * `https://<host>/__yaran/handoff`. The redirect is the build's own callback: the verified
 * https one in release builds, `yaranapp://auth/callback` plus `build=dev` otherwise. The
 * device key, timestamp and signature always ride along so a renewal can skip a consent page
 * already answered (D24). Pinned by `fixtures/handoff-url-cases.json`.
 *
 * - Pure. Values are percent-encoded keeping only RFC 3986 unreserved characters.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffUrl
 * └── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.HandoffUrl
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * └── io.github.siavz.yaran.machineview.HandoffUrlFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal sealed interface HandoffTarget {
    /** The control plane at [orgUrl]; the signed host is the org URL's host. */
    data class ControlPlane(val orgUrl: String) : HandoffTarget
    data class Machine(val host: String) : HandoffTarget
}

internal data class HandoffParams(val pk: String, val state: String, val dk: String, val dts: Long, val dsig: String)

internal object HandoffUrl {
    const val DEV_REDIRECT = "yaranapp://auth/callback"

    fun redirect(mode: CallbackMode): String = when (mode) {
        is CallbackMode.Https -> "https://${mode.domain}/auth/callback"
        CallbackMode.Dev -> DEV_REDIRECT
    }

    /** The `<host>` line of the device signature: the host being opened. */
    fun signedHost(target: HandoffTarget): String = when (target) {
        is HandoffTarget.ControlPlane -> target.orgUrl.removePrefix("https://").lowercase()
        is HandoffTarget.Machine -> target.host.lowercase()
    }

    fun build(target: HandoffTarget, mode: CallbackMode, fragment: Boolean, device: String, p: HandoffParams): String {
        val base = when (target) {
            is HandoffTarget.ControlPlane -> "${target.orgUrl}/v1/handoff"
            is HandoffTarget.Machine -> "https://${target.host}/__yaran/handoff"
        }
        val q = StringBuilder("v=1")
            .append("&pk=").append(enc(p.pk))
            .append("&state=").append(enc(p.state))
            .append("&redirect=").append(enc(redirect(mode)))
            .append("&device=").append(enc(device))
            .append("&dk=").append(enc(p.dk))
            .append("&dts=").append(p.dts)
            .append("&dsig=").append(enc(p.dsig))
        if (mode == CallbackMode.Dev) q.append("&build=dev")
        if (fragment) q.append("&mode=fragment")
        return "$base?$q"
    }

    fun enc(s: String): String {
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            if (c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code || c == '-'.code || c == '_'.code || c == '.'.code || c == '~'.code) {
                out.append(c.toChar())
            } else {
                out.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 15])
            }
        }
        return out.toString()
    }
}

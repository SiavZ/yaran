/**
 * What the machine window shows for a main-frame error response (02 §13 `Yaran-Refusal`).
 *
 * A 401 or 403 without the header came from Access and means sign in again; with it, yaran
 * itself refused and the code picks the overlay. 530 is a disconnected tunnel. Unknown codes
 * fall back by prefix, then by status, and write a diagnostics line. Subresource and fetch
 * refusals are the page's own business (Phase 13). Pinned by `fixtures/refusal-cases.json`
 * and, for completeness, by `cloud/protocol/registry/refusals.json`.
 *
 * - Pure. KNOWN lists every registry code explicitly, so a new one fails the registry test.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RefusalPolicy
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewClient (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

enum class RefusalOverlay { NONE, REAUTH, NOT_OWNER, KEYS_UNAVAILABLE, UNAVAILABLE, HOST_DISCONNECTED, CODE_OVERLAY, OFFLINE }

data class RefusalDecision(val overlay: RefusalOverlay, val diagnostic: Boolean)

internal object RefusalPolicy {
    const val HEADER = "Yaran-Refusal"

    val KNOWN = setOf(
        "access-missing", "access-malformed", "access-bad-algorithm", "access-unknown-kid",
        "access-bad-signature", "access-wrong-issuer", "access-wrong-audience", "access-expired",
        "access-not-yet-valid", "access-not-app-token", "access-service-token", "access-not-owner",
        "access-keys-unavailable", "host-not-served", "host-missing",
    )

    fun decide(status: Int, refusal: String?): RefusalDecision {
        if (status < 400) return RefusalDecision(RefusalOverlay.NONE, false)
        if (status == 530) return RefusalDecision(RefusalOverlay.OFFLINE, false)
        if (refusal == null) {
            val overlay = if (status == 401 || status == 403) RefusalOverlay.REAUTH else RefusalOverlay.NONE
            return RefusalDecision(overlay, false)
        }
        val overlay = when {
            refusal == "access-not-owner" -> RefusalOverlay.NOT_OWNER
            refusal == "access-keys-unavailable" -> RefusalOverlay.KEYS_UNAVAILABLE
            refusal.startsWith("access-") -> RefusalOverlay.REAUTH
            refusal.startsWith("host-") -> RefusalOverlay.HOST_DISCONNECTED
            status == 401 -> RefusalOverlay.REAUTH
            status == 503 -> RefusalOverlay.UNAVAILABLE
            else -> RefusalOverlay.CODE_OVERLAY
        }
        return RefusalDecision(overlay, refusal !in KNOWN)
    }
}

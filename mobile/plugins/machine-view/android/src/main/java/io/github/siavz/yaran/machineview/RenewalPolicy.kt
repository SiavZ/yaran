/**
 * When a machine or control-plane session must be renewed, warned about, or blocked.
 *
 * A pure function of now, the token's iat and exp, the context (opening, resuming or
 * viewing) and visibility. Opening or resuming with less than the margin left renews before
 * loading, because a system-browser sheet only belongs next to a user's gesture; while
 * viewing, a banner appears 10 minutes before exp and a full overlay at exp, even with the
 * WebSocket still open (G12). Pinned by `fixtures/renewal-cases.json`.
 *
 * - Pure; wall-clock Unix seconds, never tick counts.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RenewalPolicy
 * ├── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * └── io.github.siavz.yaran.machineview.RenewalCoordinator (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal enum class RenewalContext { OPEN, RESUME, VIEW }

internal enum class RenewalAction { NONE, RENEW_BEFORE_LOAD, BANNER, OVERLAY }

internal data class RenewalDecision(val action: RenewalAction, val nextCheckAt: Long?)

internal object RenewalPolicy {
    /** At most two hours of margin, so a 24 h Access session renews about once a day. */
    const val PRE_OPEN_MAX_S = 7200L
    const val PRE_OPEN_DIVISOR = 4L
    const val BANNER_S = 600L

    fun margin(iat: Long?, exp: Long): Long =
        if (iat != null && exp > iat) minOf(PRE_OPEN_MAX_S, (exp - iat) / PRE_OPEN_DIVISOR) else PRE_OPEN_MAX_S

    fun decide(now: Long, iat: Long?, exp: Long, context: RenewalContext, visible: Boolean): RenewalDecision =
        when (context) {
            RenewalContext.OPEN, RenewalContext.RESUME ->
                if (exp - now < margin(iat, exp)) RenewalDecision(RenewalAction.RENEW_BEFORE_LOAD, null)
                else RenewalDecision(RenewalAction.NONE, exp - BANNER_S)
            RenewalContext.VIEW -> when {
                !visible -> RenewalDecision(RenewalAction.NONE, null)
                now >= exp -> RenewalDecision(RenewalAction.OVERLAY, null)
                exp - now <= BANNER_S -> RenewalDecision(RenewalAction.BANNER, exp)
                else -> RenewalDecision(RenewalAction.NONE, exp - BANNER_S)
            }
        }
}

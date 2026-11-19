/**
 * Which of a machine's user-approved routes to load (G2), as a pure decision over probes.
 *
 * At open the routes are probed in the user's order; at resume after the page was away and
 * from the offline overlay ("revisit") the current route is probed first and kept when it
 * still answers, so a healthy page is never moved. A route counts only when its status
 * answers the recorded instance; that groups routes and authorizes nothing, because every
 * route signs in on its own. An org route with no session cannot be probed (Access is in
 * front), so it is the fallback to sign in to, after every verifiable route failed. Pinned by
 * `fixtures/direct-cases.json`; the Swift twin is `RouteSelector.swift`.
 *
 * - Pure; the probe is the caller's (blocking, on the io executor).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.RouteSelector
 * └── io.github.siavz.yaran.machineview.Direct (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RouteSelector
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * └── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal enum class Probe { MATCH, MATCH_SIGN_IN, MISMATCH, UNREACHABLE, SIGN_IN_FIRST }

internal sealed interface Selection {
    /** Load route [index] (a direct route may still need its password). */
    data class Chosen(val index: Int) : Selection
    /** The current route still answers: leave the page alone. */
    data class Kept(val index: Int) : Selection
    /** No route was verified; [index] is an org route to sign in to first. */
    data class SignInFirst(val index: Int) : Selection
    data object NoRoute : Selection
}

internal object RouteSelector {
    /** [current] is null at open; at a revisit it is the route the window is on. */
    fun select(count: Int, current: Int?, probe: (Int) -> Probe): Selection {
        val order = if (current == null) (0 until count).toList() else listOf(current) + (0 until count).filter { it != current }
        var signInFirst: Int? = null
        for (i in order) {
            when (probe(i)) {
                Probe.MATCH, Probe.MATCH_SIGN_IN -> return if (i == current) Selection.Kept(i) else Selection.Chosen(i)
                Probe.SIGN_IN_FIRST -> if (signInFirst == null) signInFirst = i
                Probe.MISMATCH, Probe.UNREACHABLE -> Unit
            }
        }
        return signInFirst?.let { Selection.SignInFirst(it) } ?: Selection.NoRoute
    }

    /** A status answer against the recorded [instance] (null: nothing recorded, any yaran matches). */
    fun probeOf(status: DirectStatus, instance: String?): Probe = when (status) {
        is DirectStatus.Yaran -> when {
            instance != null && status.instance != instance -> Probe.MISMATCH
            status.requiredHere && !status.signedIn -> Probe.MATCH_SIGN_IN
            else -> Probe.MATCH
        }
        else -> Probe.UNREACHABLE
    }
}

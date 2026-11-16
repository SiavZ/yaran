/**
 * Connects [RenewalPolicy] to the machine window: visibility, resume, a one-shot timer.
 *
 * Checks the session's absolute `exp` against wall time on open, on resume and when its
 * one-shot timer fires, never by counting ticks. It shows the banner 10 minutes ahead, the
 * reauth overlay at `exp` (even with the WebSocket still open) or on a reauth signal (the
 * `yaranapp://reauth` control URL Phase 13 sends after a 4401, an Access redirect, or a
 * refusal), and after a successful renewal re-injects and reloads the same URL.
 *
 * - Main-thread only. The renewal itself (a system-browser handoff) is injected.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.RenewalCoordinator
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalPolicy (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RenewalCoordinator
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.RenewalCoordinatorTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal interface RenewalUi {
    fun showBanner()

    fun hideBanner()

    fun showReauthOverlay()

    fun hideOverlay()

    /** Re-inject the cookie and reload the URL the page was on. */
    fun reloadSameUrl()
}

/** Schedules [task] at the wall-clock instant [atEpochSeconds]; null cancels the pending one. */
internal fun interface OneShotScheduler {
    fun schedule(atEpochSeconds: Long?, task: () -> Unit)
}

internal class RenewalCoordinator(
    private val session: () -> Session?,
    private val now: () -> Long,
    private val scheduler: OneShotScheduler,
    private val ui: RenewalUi,
    private val renew: ((SignInOutcome) -> Unit) -> Unit,
) {
    private var visible = true

    /** True when the window must renew before it loads anything. */
    fun onOpen(): Boolean = needsRenewal(RenewalContext.OPEN)

    fun onResume(): Boolean {
        visible = true
        return needsRenewal(RenewalContext.RESUME).also { if (!it) evaluate() }
    }

    fun onVisibilityChanged(visible: Boolean) {
        this.visible = visible
        if (visible) evaluate() else scheduler.schedule(null) {}
    }

    fun onReauthSignal() {
        scheduler.schedule(null) {}
        ui.hideBanner()
        ui.showReauthOverlay()
    }

    /** Runs the renewal (a user gesture: Renew or Sign in); on success reloads the same URL. */
    fun renewNow(done: (SignInOutcome) -> Unit) {
        renew { outcome ->
            if (outcome is SignInOutcome.SignedIn) {
                ui.hideOverlay()
                ui.hideBanner()
                ui.reloadSameUrl()
                evaluate()
            }
            done(outcome)
        }
    }

    fun evaluate() {
        val s = session()
        if (s == null) {
            onReauthSignal()
            return
        }
        val d = RenewalPolicy.decide(now(), s.iat.takeIf { it > 0 }, s.exp, RenewalContext.VIEW, visible)
        when (d.action) {
            RenewalAction.BANNER -> ui.showBanner()
            RenewalAction.OVERLAY -> {
                ui.hideBanner()
                ui.showReauthOverlay()
            }
            RenewalAction.NONE -> ui.hideBanner()
            RenewalAction.RENEW_BEFORE_LOAD -> Unit
        }
        scheduler.schedule(d.nextCheckAt) { evaluate() }
    }

    private fun needsRenewal(context: RenewalContext): Boolean {
        val s = session() ?: return true
        return RenewalPolicy.decide(now(), s.iat.takeIf { it > 0 }, s.exp, context, true).action == RenewalAction.RENEW_BEFORE_LOAD
    }
}

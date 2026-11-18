/**
 * The direct-machine flows behind `Session.directStatus/directSignIn/directSignOut` and the
 * machine window's own sign-in (G1, D1a).
 *
 * Sign-in: refuse a host that holds an org session (`org_host`), probe the public status with
 * nothing attached, and only for a yaran that wants a password on this route show the native
 * sheet; then POST `cli-login` with redirects off, keep `{token, cookie_name, instance}` under
 * `session-direct/<host>` and answer an outcome that carries none of it. A token the phone
 * could not keep is revoked on the machine at once. Sign-out ends the session on the machine
 * (best effort), deletes the record and clears every cookie and the web storage of the host.
 *
 * - io work on the runtime's executor; `done` runs on the main thread.
 * - The password is zeroed after the POST, in both its char and byte forms.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DirectFlow
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.PasswordSheet (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, android.os
 *
 * Used by:
 * io.github.siavz.yaran.machineview.DirectFlow
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.os.Handler
import android.os.Looper

internal object DirectFlow {
    private val main = Handler(Looper.getMainLooper())

    /** True when [host] holds an org (`session/<host>`) record; a locked or unreadable one still counts. */
    fun hasOrgSession(rt: PluginRuntime, host: String): Boolean = try {
        rt.core.vault.read("${SessionStore.PREFIX}$host") != null
    } catch (e: Exception) {
        true
    }

    fun status(rt: PluginRuntime, host: String): DirectStatus {
        if (!DirectWire.isPublicHost(host)) return DirectStatus.Refused("invalid_host")
        if (hasOrgSession(rt, host)) return DirectStatus.Refused("org_host")
        val session = try {
            rt.directSessions.get(host)
        } catch (e: DirectRecordUnreadableException) {
            rt.core.diagnostics.append("machine-view direct session unreadable host=$host")
            null
        }
        return rt.directAuth.status(host, session)
    }

    /** [onSheet] hands the window the sheet it may have to dismiss (a replaced or closed window). */
    fun signIn(
        activity: Activity,
        host: String,
        owned: () -> Boolean = { true },
        onSheet: (android.app.AlertDialog) -> Unit = {},
        done: (DirectSignInOutcome) -> Unit,
    ) {
        val rt = PluginRuntime.get(activity)
        val finish = { o: DirectSignInOutcome -> main.post { done(o) }; Unit }
        rt.io.execute { guarded(rt, finish) {
            val first = when {
                !DirectWire.isPublicHost(host) -> DirectStatus.Refused("invalid_host")
                hasOrgSession(rt, host) -> DirectStatus.Refused("org_host")
                else -> rt.directAuth.status(host, null) // nothing attached before the answer proves a yaran
            }
            if (first !is DirectStatus.Yaran) return@execute finish(first.asSignIn())
            if (!first.requiredHere) return@execute finish(DirectSignInOutcome.NotRequired)
            main.post {
                // [owned] false: the window moved on (another open) while the probe ran; no sheet for it.
                if (activity.isFinishing || activity.isDestroyed || !owned()) return@post done(DirectSignInOutcome.Cancelled)
                onSheet(PasswordSheet.show(activity, host, onSubmit = { chars ->
                    if (!owned()) {
                        chars.fill('\u0000')
                        return@show done(DirectSignInOutcome.Cancelled)
                    }
                    rt.io.execute {
                        try {
                            guarded(rt, finish) { finish(if (owned()) post(rt, host, chars, first.instance, owned) else DirectSignInOutcome.Cancelled) }
                        } finally {
                            chars.fill('\u0000')
                        }
                    }
                }, onCancel = { done(DirectSignInOutcome.Cancelled) }))
            }
        } }
    }

    /** Nothing thrown on the io thread may kill the app or leave the caller waiting. */
    private inline fun guarded(rt: PluginRuntime, crossinline finish: (DirectSignInOutcome) -> Unit, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            rt.core.diagnostics.append("machine-view direct sign-in failed error=${e.javaClass.simpleName}")
            finish(if (e is VaultLockedException) DirectSignInOutcome.VaultLocked else DirectSignInOutcome.SecureStorageFailed)
        }
    }

    /**
     * [owned] is asked again once the login answered, before anything is saved: a window closed
     * or replaced while it was on the wire holds nobody's session, so the token it got is revoked
     * and nothing is stored or revoked besides it. (Sign-in, removal and keep share the one io
     * thread, so no other change to the host's record can land during the login itself.)
     */
    private fun post(rt: PluginRuntime, host: String, chars: CharArray, instance: String?, owned: () -> Boolean): DirectSignInOutcome {
        val body = try {
            DirectWire.loginBody(chars, "yaran phone (${rt.deviceLabel})")
        } finally {
            chars.fill('\u0000')
        }
        val answer = try {
            rt.directAuth.login(host, body)
        } finally {
            body.fill(0)
        }
        val token = when (answer) {
            is LoginAnswer.Failed -> return answer.outcome
            is LoginAnswer.Token -> answer
        }
        if (!owned()) {
            rt.core.diagnostics.append("machine-view direct sign-in answered after its window moved on host=$host")
            rt.directAuth.logout(host, token.token)
            return DirectSignInOutcome.Cancelled
        }
        return keep(rt, DirectSession(host, token.token, token.cookieName, instance, System.currentTimeMillis() / 1000, DirectSessionStore.newSignInId()))
    }

    /**
     * Keeps [s] as the host's one session and revokes the session it replaces (best effort):
     * a superseded sign-in never stays live on the machine with nobody holding its cleanup.
     */
    internal fun keep(rt: PluginRuntime, s: DirectSession): DirectSignInOutcome {
        val host = s.host
        val superseded = try {
            rt.directSessions.get(host)
        } catch (e: Exception) {
            null // a locked or unreadable record has no token to revoke; the write below says what it can
        }
        try {
            rt.directSessions.put(s)
        } catch (e: Exception) {
            rt.core.diagnostics.append("machine-view direct session save failed error=${e.javaClass.simpleName} host=$host")
            rt.directAuth.logout(host, s.token) // a session nobody holds must not live on the machine
            return if (e is VaultLockedException) DirectSignInOutcome.VaultLocked else DirectSignInOutcome.SecureStorageFailed
        }
        if (superseded != null && superseded.token != s.token) rt.directAuth.logout(host, superseded.token)
        rt.core.diagnostics.append("machine-view direct signed in host=$host")
        return DirectSignInOutcome.SignedIn(host, s.instance, s.signInId!!)
    }

    /**
     * One route probe for [RouteSelector] (G2), each with its own credential only: a direct
     * route its `session-direct` record (attached only after the open answer), an org route its
     * `CF_Authorization`, without which Access stands in front and the route is unverifiable.
     */
    fun probeRoute(rt: PluginRuntime, route: Route, instance: String?): Pair<Probe, DirectStatus?> {
        val timeout = DirectAuth.probeTimeoutMs(route.host)
        return when (route) {
            is Route.Direct -> {
                val session = try {
                    rt.directSessions.get(route.host)
                } catch (e: Exception) {
                    null // locked or unreadable: probe without it; loading decides what that means
                }
                val st = rt.directAuth.status(route.host, session, timeout, expected = instance)
                RouteSelector.probeOf(st, instance) to st
            }
            is Route.Org -> (try { orgRouteStatus(rt, route, timeout) } catch (e: VaultLockedException) { null }).let { st -> (st?.let { RouteSelector.probeOf(it, instance) } ?: Probe.SIGN_IN_FIRST) to st }
        }
    }

    /**
     * An org route's status at its exact host, carrying only that host's own `CF_Authorization`
     * from a session of the route's own org, redirects off. Null is `sign_in_required`: no usable
     * session (none, expired, another org's, unreadable), or Access answered instead of yaran.
     * Throws [VaultLockedException] while the vault is locked.
     */
    fun orgRouteStatus(rt: PluginRuntime, route: Route.Org, timeoutMs: Int = DirectAuth.TIMEOUT_MS): DirectStatus? {
        val s = try {
            rt.sessions.status(route.host, System.currentTimeMillis() / 1000)
        } catch (e: VaultLockedException) {
            throw e
        } catch (e: Exception) {
            rt.core.diagnostics.append("machine-view org session unreadable error=${e.javaClass.simpleName} host=${route.host}")
            null
        }?.takeIf { it.orgId == route.orgId } ?: return null
        val value = CookieSpec.value(s.jwt, s.cookie, s.credentialKind) ?: return null
        val st = rt.directAuth.get(route.host, "CF_Authorization=$value", timeoutMs)
        return if (st is DirectStatus.AccessRequired || st is DirectStatus.Redirected) null else st
    }

    /** `Session.routeStatus`: a direct route is `directStatus`; an org route is [orgRouteStatus], null as `sign_in_required`. */
    fun routeStatus(rt: PluginRuntime, route: Route): Map<String, Any?> = when (route) {
        is Route.Direct -> status(rt, route.host).toJs()
        is Route.Org -> orgRouteStatus(rt, route)?.toJs() ?: linkedMapOf("kind" to "sign_in_required")
    }

    /**
     * Ends [host]'s direct session. With [signInId] it ends only that sign-in: when the host's
     * current record is another one (a later sign-in, an older build's record, or none at all),
     * nothing is touched and the answer is `not_current`. Without it, whatever is current goes
     * (removing the machine). All direct operations share this one io thread, so nothing can
     * replace the record between the check and the delete.
     */
    fun signOut(rt: PluginRuntime, host: String, signInId: String? = null): DirectSignOutOutcome {
        if (!DirectWire.isPublicHost(host)) return DirectSignOutOutcome.Refused
        val session = try {
            rt.directSessions.get(host)
        } catch (e: VaultLockedException) {
            return DirectSignOutOutcome.VaultLocked
        } catch (e: DirectRecordUnreadableException) {
            if (signInId != null) return DirectSignOutOutcome.NotCurrent // cannot prove it is the caller's
            null // an unreadable token cannot be revoked; the record and web data still go
        }
        if (signInId != null && session?.signInId != signInId) return DirectSignOutOutcome.NotCurrent
        val ended = session?.let { rt.directAuth.logout(host, it.token) } ?: false
        try {
            rt.directSessions.delete(host)
        } catch (e: VaultLockedException) {
            return DirectSignOutOutcome.VaultLocked
        } catch (e: Exception) {
            rt.core.diagnostics.append("machine-view direct session delete failed error=${e.javaClass.simpleName} host=$host")
            rt.cookies.clearHost(host)
            return DirectSignOutOutcome.SecureStorageFailed
        }
        rt.cookies.clearHost(host)
        rt.core.diagnostics.append("machine-view direct signed out host=$host server_ended=$ended")
        return DirectSignOutOutcome.SignedOut(ended)
    }
}

sealed class DirectSignOutOutcome(val kind: String) {
    data class SignedOut(val serverEnded: Boolean) : DirectSignOutOutcome("signed_out")
    data object VaultLocked : DirectSignOutOutcome("vault_locked")
    data object SecureStorageFailed : DirectSignOutOutcome("secure_storage_failed")
    data object Refused : DirectSignOutOutcome("refused")

    /** The sign-in named is no longer the host's current one: nothing was ended or cleared. */
    data object NotCurrent : DirectSignOutOutcome("not_current")

    fun toJs(): Map<String, Any> = when (this) {
        is SignedOut -> linkedMapOf("kind" to kind, "serverEnded" to serverEnded)
        Refused -> linkedMapOf("kind" to kind, "reason" to "invalid_host")
        VaultLocked, SecureStorageFailed, NotCurrent -> linkedMapOf("kind" to kind)
    }
}

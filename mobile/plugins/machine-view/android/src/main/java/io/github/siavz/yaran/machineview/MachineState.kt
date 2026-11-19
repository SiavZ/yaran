/**
 * What the machine window needs to come back after rotation or process death.
 *
 * The open form (org, direct or routes), its routes, the chosen route, the recorded instance
 * and the last URL, under 2 KB; the URL is kept only while it is on the chosen route's host:
 * yaran's URL is its position (CLAUDE.md "The URL is the source of truth"). A route switch
 * carries the agent route over to the new origin and nothing else. Built from the plugin's
 * intent extras on open, validated the same way both times.
 *
 * - Pure apart from Bundle and Intent accessors.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineState
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteFragment (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: android.content, android.os, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineState
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** One way to reach a machine; each signs in on its own. */
internal sealed interface Route {
    val host: String

    data class Org(val orgId: String, val machineId: String, override val host: String) : Route
    data class Direct(override val host: String) : Route
}

internal enum class OpenKind(val wire: String) { ORG("org"), DIRECT("direct"), ROUTES("routes") }

internal data class MachineState(val kind: OpenKind, val routes: List<Route>, val chosen: Int, val instance: String?, val url: String) {
    val route: Route get() = routes[chosen]
    val host: String get() = route.host
    val orgId: String? get() = (route as? Route.Org)?.orgId

    /** The same position on route [index]: the agent route, if any, on the new origin. */
    fun switchTo(index: Int): MachineState {
        val fragment = url.substringAfter('#', "").let { "#$it" }.takeIf { RouteFragment.isValid(it) } ?: ""
        return copy(chosen = index, url = root(routes[index].host) + fragment)
    }

    fun toBundle(b: Bundle) {
        b.putString(K_KIND, kind.wire)
        b.putString(K_ROUTES, routesJson(routes))
        b.putInt(K_CHOSEN, chosen)
        instance?.let { b.putString(K_INSTANCE, it) }
        if (keepUrl(host, url)) b.putString(K_URL, url)
    }

    companion object {
        const val K_ORG = "orgId"
        const val K_MACHINE = "machineId"
        const val K_HOST = "host"
        const val K_ROUTE = "route"
        const val K_URL = "lastUrl"
        const val K_KIND = "kind"
        const val K_ROUTES = "routes"
        const val K_CHOSEN = "chosen"
        const val K_INSTANCE = "instance"
        const val MAX_ROUTES = 4
        private const val MAX_URL = 900
        private const val MAX_ORG = 261
        private val ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
        private val INSTANCE = Regex("^[\\x21-\\x7e]{1,128}$")

        fun root(host: String) = "https://$host/"

        fun keepUrl(host: String, url: String): Boolean {
            if (url.length > MAX_URL) return false
            val u = UrlParts.parse(url) ?: return false
            val hp = u.authority?.let { HostRules.hostPort(it) } ?: return false
            return u.scheme == "https" && hp.first == host && HostRules.isDefaultHttpsPort(hp.second)
        }

        private fun orgRoute(orgId: String?, machineId: String?, host: String?): Route.Org? {
            if (orgId == null || machineId == null || host == null) return null
            // orgId is the org's canonical OrgUrl (`https://…`), the key every other native call takes.
            if (orgId.length > MAX_ORG || !HostRules.ORG_URL.matches(orgId)) return null
            if (!ID.matches(machineId) || !HostRules.HOSTNAME.matches(host)) return null
            return Route.Org(orgId, machineId, host)
        }

        /** The original org form. */
        fun of(orgId: String?, machineId: String?, host: String?, route: String?): MachineState? {
            val r = orgRoute(orgId, machineId, host) ?: return null
            return build(OpenKind.ORG, listOf(r), 0, null, route)
        }

        /** Any form; [routes] is a JSON array of `{kind, host[, orgId, machineId]}` for direct and routes. */
        fun parse(kind: String?, routes: String?, instance: String?, route: String?): MachineState? {
            val k = OpenKind.entries.firstOrNull { it.wire == kind } ?: return null
            val list = parseRoutes(routes) ?: return null
            if (instance != null && !INSTANCE.matches(instance)) return null
            return when (k) {
                OpenKind.ORG -> if (list.size == 1 && list[0] is Route.Org && instance == null) build(k, list, 0, null, route) else null
                OpenKind.DIRECT -> if (list.size == 1 && list[0] is Route.Direct) build(k, list, 0, instance, route) else null
                OpenKind.ROUTES -> if (instance != null) build(k, list, 0, instance, route) else null
            }
        }

        private fun build(kind: OpenKind, routes: List<Route>, chosen: Int, instance: String?, route: String?): MachineState? {
            if (route != null && !RouteFragment.isValid(route)) return null
            if (chosen !in routes.indices) return null
            return MachineState(kind, routes, chosen, instance, root(routes[chosen].host) + (route ?: ""))
        }

        fun parseRoutes(json: String?): List<Route>? {
            if (json == null || json.length > 4096) return null
            val a = try {
                JSONArray(json)
            } catch (e: JSONException) {
                return null
            }
            if (a.length() !in 1..MAX_ROUTES) return null
            val out = (0 until a.length()).map { i ->
                val o = a.optJSONObject(i) ?: return null
                when (o.opt("kind")) {
                    "org" -> orgRoute(o.opt("orgId") as? String, o.opt("machineId") as? String, o.opt("host") as? String) ?: return null
                    "direct" -> (o.opt("host") as? String)?.takeIf { DirectWire.isPublicHost(it) }?.let { Route.Direct(it) } ?: return null
                    else -> return null
                }
            }
            return out.takeIf { r -> r.map { it.host }.toSet().size == r.size }
        }

        fun routesJson(routes: List<Route>): String = JSONArray(routes.map { r ->
            when (r) {
                is Route.Org -> JSONObject().put("kind", "org").put("orgId", r.orgId).put("machineId", r.machineId).put("host", r.host)
                is Route.Direct -> JSONObject().put("kind", "direct").put("host", r.host)
            }
        }).toString()

        fun fromIntent(i: Intent): MachineState? =
            if (i.hasExtra(K_KIND)) parse(i.getStringExtra(K_KIND), i.getStringExtra(K_ROUTES), i.getStringExtra(K_INSTANCE), i.getStringExtra(K_ROUTE))
            else of(i.getStringExtra(K_ORG), i.getStringExtra(K_MACHINE), i.getStringExtra(K_HOST), i.getStringExtra(K_ROUTE))

        fun fromBundle(b: Bundle): MachineState? {
            val s = parse(b.getString(K_KIND), b.getString(K_ROUTES), b.getString(K_INSTANCE), null) ?: return null
            val chosen = b.getInt(K_CHOSEN, 0).takeIf { it in s.routes.indices } ?: return null
            val at = s.copy(chosen = chosen, url = root(s.routes[chosen].host))
            val url = b.getString(K_URL)
            return if (url != null && keepUrl(at.host, url)) at.copy(url = url) else at
        }
    }
}

/**
 * What the machine window needs to come back after rotation or process death.
 *
 * `{orgId, machineId, host, lastUrl}`, under 1 KB, the URL kept only while it is on the pinned
 * host: yaran's URL is its position (CLAUDE.md "The URL is the source of truth"). Built from
 * the plugin's intent extras on open, validated the same way both times.
 *
 * - Pure apart from Bundle and Intent accessors.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineState
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteFragment (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: android.content, android.os
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineState
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * └── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.os.Bundle

internal data class MachineState(val orgId: String, val machineId: String, val host: String, val url: String) {
    fun toBundle(b: Bundle) {
        b.putString(K_ORG, orgId)
        b.putString(K_MACHINE, machineId)
        b.putString(K_HOST, host)
        if (keepUrl(host, url)) b.putString(K_URL, url)
    }

    companion object {
        const val K_ORG = "orgId"
        const val K_MACHINE = "machineId"
        const val K_HOST = "host"
        const val K_ROUTE = "route"
        const val K_URL = "lastUrl"
        private const val MAX_URL = 900
        private val ID = Regex("^[A-Za-z0-9._:-]{1,128}$")

        fun root(host: String) = "https://$host/"

        fun keepUrl(host: String, url: String): Boolean {
            if (url.length > MAX_URL) return false
            val u = UrlParts.parse(url) ?: return false
            val hp = u.authority?.let { HostRules.hostPort(it) } ?: return false
            return u.scheme == "https" && hp.first == host && HostRules.isDefaultHttpsPort(hp.second)
        }

        fun of(orgId: String?, machineId: String?, host: String?, route: String?): MachineState? {
            if (orgId == null || machineId == null || host == null) return null
            if (!ID.matches(orgId) || !ID.matches(machineId) || !HostRules.HOSTNAME.matches(host)) return null
            if (route != null && !RouteFragment.isValid(route)) return null
            return MachineState(orgId, machineId, host, root(host) + (route ?: ""))
        }

        fun fromIntent(i: Intent) = of(i.getStringExtra(K_ORG), i.getStringExtra(K_MACHINE), i.getStringExtra(K_HOST), i.getStringExtra(K_ROUTE))

        fun fromBundle(b: Bundle): MachineState? {
            val s = of(b.getString(K_ORG), b.getString(K_MACHINE), b.getString(K_HOST), null) ?: return null
            val url = b.getString(K_URL)
            return if (url != null && keepUrl(s.host, url)) s.copy(url = url) else s
        }
    }
}

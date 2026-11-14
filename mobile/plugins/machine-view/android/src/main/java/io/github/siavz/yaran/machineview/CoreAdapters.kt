/**
 * Phase 14's native core behind this plugin's [CoreBindings] seams.
 *
 * The app's Application calls `CoreBindings.install(CoreAdapters.from(context))`. The vault
 * adapter maps this plugin's names (`handoff`, `session/<host>`, `install/<orgId>`) onto the
 * core vault's namespace and key: the part before the first `/` is the namespace (one of the
 * native-only ones the secure-store plugin refuses to JS), and the rest, which can be longer
 * than a vault key and hold `:` or `/`, is stored under its SHA-256 and listed through a
 * standard-class index of names in the same namespace.
 *
 * - Values are UTF-8 text: every caller in this plugin writes JSON.
 * - The org directory reads the shell's org list (`orgs/list`), the records written at
 *   onboarding, so an org URL never comes from a JS argument.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CoreAdapters
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.core.Diagnostics
 * ├── io.github.siavz.yaran.core.ScreenPrivacy
 * ├── io.github.siavz.yaran.core.Vault
 * └── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * External: android.content, java.security, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.CoreAdapters
 * ├── io.github.siavz.yaran.app.YaranApplication
 * └── io.github.siavz.yaran.machineview.CoreAdaptersTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Context
import io.github.siavz.yaran.core.AppLock
import io.github.siavz.yaran.core.CoreError
import io.github.siavz.yaran.core.Diagnostics
import io.github.siavz.yaran.core.Protection
import io.github.siavz.yaran.core.ScreenPrivacy
import io.github.siavz.yaran.core.Vault
import org.json.JSONArray
import org.json.JSONException
import java.security.MessageDigest

object CoreAdapters {
    fun from(context: Context): CoreBindings {
        val app = context.applicationContext
        val vault = Vault.shared(app)
        return CoreBindings(
            vault = VaultSecrets(vault),
            diagnostics = { line -> Diagnostics.shared(app).append(Diagnostics.Level.INFO, line) },
            orgs = OrgList(vault),
            appLock = object : AppLockState {
                override fun lockEnabled() = vault.isLockWrapped()

                override fun isLocked() = AppLock.shared(app).locked
            },
            screenPrivacy = { ScreenPrivacy.shared(app).enabled },
        )
    }
}

internal class VaultSecrets(private val vault: Vault) : SecretVault {
    private class Name(val namespace: String, val key: String, val name: String?)

    private fun split(ns: String): Name {
        val slash = ns.indexOf('/')
        if (slash < 0) return Name(ns, SINGLE_KEY, null)
        val name = ns.substring(slash + 1)
        return Name(ns.substring(0, slash), sha256(name), name)
    }

    override fun read(ns: String): ByteArray? =
        locked {
            val n = split(ns)
            vault.get(n.namespace, n.key)?.toByteArray(Charsets.UTF_8)
        }

    @Synchronized
    override fun write(ns: String, value: ByteArray, cls: ProtectionClass) =
        locked {
            val n = split(ns)
            val protection = when (cls) {
                ProtectionClass.STANDARD -> Protection.STANDARD
                ProtectionClass.LOCKED -> Protection.LOCKED
            }
            vault.set(n.namespace, n.key, String(value, Charsets.UTF_8), protection)
            n.name?.let { name -> saveNames(n.namespace, names(n.namespace) + name) }
            Unit
        }

    @Synchronized
    override fun delete(ns: String) =
        locked {
            val n = split(ns)
            vault.remove(n.namespace, n.key)
            n.name?.let { name -> saveNames(n.namespace, names(n.namespace) - name) }
            Unit
        }

    /** Every `<namespace>/<name>` under [prefix], which must be `<namespace>/`. */
    override fun list(prefix: String): List<String> {
        require(prefix.endsWith("/") && prefix.indexOf('/') == prefix.length - 1) { "list takes a \"<namespace>/\" prefix" }
        return locked { names(prefix.dropLast(1)).sorted().map { prefix + it } }
    }

    private fun names(namespace: String): Set<String> =
        vault.get(namespace, INDEX_KEY)?.split('\n')?.filter { it.isNotEmpty() }?.toSet().orEmpty()

    private fun saveNames(namespace: String, names: Set<String>) {
        if (names.isEmpty()) vault.remove(namespace, INDEX_KEY) else vault.set(namespace, INDEX_KEY, names.joinToString("\n"), Protection.STANDARD)
    }

    private inline fun <T> locked(block: () -> T): T =
        try {
            block()
        } catch (e: CoreError.Locked) {
            throw VaultLockedException()
        }

    private companion object {
        const val SINGLE_KEY = "value"
        const val INDEX_KEY = "names"

        fun sha256(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}

/** The org URL of an onboarded org; the shell keeps its org list in the vault at `orgs/list`. */
internal class OrgList(private val vault: Vault) : OrgDirectory {
    override fun orgUrl(orgId: String): String? {
        val list = vault.get("orgs", "list") ?: return null
        return try {
            val orgs = JSONArray(list)
            (0 until orgs.length()).map { orgs.optJSONObject(it)?.optString("id") }.firstOrNull { it == orgId }
        } catch (e: JSONException) {
            null
        }
    }
}

/**
 * BuildOutputsTest: checks the flags that must hold in the built app, read from Gradle outputs.
 *
 * Gradle passes the fossDebug and fossE2e merged manifests and the generated BuildConfig
 * directory (see `app/build.gradle.kts`). The fossDebug manifest must keep backup off, cleartext
 * off, the network security config, the add-org deep link and the predictive-back opt-in, and
 * carry the plugin's runtime publisher domain and exactly the callback alias this build's domain
 * picks (the https one on that host, or the dev scheme when empty). The fossE2e manifest must
 * carry the app's e2e flag into the plugin. `E2E_WEBVIEW_DEBUG` must be true in the e2e build
 * type and false in debug and every release variant, which is what Phase 19's
 * `check-release-flags.sh` relies on.
 *
 * - Parses XML with the JDK; the BuildConfig check reads the generated Java source.
 *
 * <module-headers:begin>
 * Uses: none
 * External: java.io, javax.xml.parsers, org.junit, org.junit.Assert, org.w3c.dom
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class BuildOutputsTest {
    private val android = "http://schemas.android.com/apk/res/android"

    private fun property(name: String) = System.getProperty(name) ?: error("$name not set; run through Gradle")

    private fun elements(
        root: Element,
        tag: String,
    ): List<Element> = root.getElementsByTagName(tag).let { list -> (0 until list.length).map { list.item(it) as Element } }

    @Test
    fun mergedManifestKeepsTheHardeningFlags() {
        val doc =
            DocumentBuilderFactory
                .newInstance()
                .apply { isNamespaceAware = true }
                .newDocumentBuilder()
                .parse(File(property("yaran.mergedManifest")))
        val root = doc.documentElement
        val application = elements(root, "application").single()
        mapOf(
            "allowBackup" to "false",
            "usesCleartextTraffic" to "false",
            "enableOnBackInvokedCallback" to "true",
        ).forEach { (name, value) -> assertEquals(name, value, application.getAttributeNS(android, name)) }
        listOf("dataExtractionRules", "fullBackupContent", "networkSecurityConfig", "localeConfig").forEach {
            assertTrue("$it is set", application.getAttributeNS(android, it).isNotEmpty())
        }
        val permissions = elements(root, "uses-permission").map { it.getAttributeNS(android, "name") }
        assertTrue(permissions.contains("android.permission.CAMERA"))
        val queried = elements(root, "action").map { it.getAttributeNS(android, "name") }
        assertTrue(queried.contains("android.support.customtabs.action.CustomTabsService"))
        val main = elements(root, "activity").single { it.getAttributeNS(android, "name").endsWith(".MainActivity") }
        val addOrg =
            elements(main, "data").any {
                it.getAttributeNS(android, "scheme") == "yaranapp" && it.getAttributeNS(android, "host") == "add-org"
            }
        assertTrue("yaranapp://add-org filter", addOrg)
        listOf("orientation", "screenSize", "uiMode").forEach {
            assertTrue("configChanges has $it", main.getAttributeNS(android, "configChanges").split('|').contains(it))
        }
        // The core bindings are installed by the Application, before any plugin activity runs.
        assertEquals("io.github.siavz.yaran.app.YaranApplication", application.getAttributeNS(android, "name"))
        // Exactly one callback alias, the one this build's publisher domain picks (empty = dev scheme).
        val domain = buildConfigValue("foss/debug", "String PUBLISHER_DOMAIN").trim('"')
        val aliases =
            elements(root, "activity-alias").associate {
                it.getAttributeNS(android, "name").substringAfterLast('.') to it.getAttributeNS(android, "enabled")
            }
        val release = domain.isNotEmpty()
        assertEquals(mapOf("AuthCallbackHttps" to "$release", "AuthCallbackDev" to "${!release}"), aliases)
        val https = elements(root, "activity-alias").single { it.getAttributeNS(android, "name").endsWith(".AuthCallbackHttps") }
        val hosts = elements(https, "data").map { it.getAttributeNS(android, "host") }
        assertEquals(listOf(domain, domain), hosts)
        // The plugin picks its callback mode from this value at runtime (PluginRuntime), not from the aliases.
        val runtimeDomainName = "io.github.siavz.yaran.machineview.publisherDomain"
        val runtimeDomain = elements(application, "meta-data").single { it.getAttributeNS(android, "name") == runtimeDomainName }
        assertEquals(domain, runtimeDomain.getAttributeNS(android, "value"))
        val flavor = elements(application, "meta-data").single { it.getAttributeNS(android, "name") == "io.github.siavz.yaran.FLAVOR" }
        assertEquals("foss", flavor.getAttributeNS(android, "value"))
    }

    /** The value of `<declaration> = <value>;` in a variant's generated BuildConfig (`<flavor>/<buildType>`). */
    private fun buildConfigValue(
        variant: String,
        declaration: String,
    ): String {
        val source = File(property("yaran.buildConfigRoot"), "$variant/io/github/siavz/yaran/app/BuildConfig.java").readText()
        return Regex("${Regex.escape(declaration)} = (.*);").find(source)?.groupValues?.get(1) ?: error("no $declaration in $variant")
    }

    @Test
    fun webViewDebuggingIsOnOnlyInE2e() {
        val flag = { variant: String -> buildConfigValue(variant, "boolean E2E_WEBVIEW_DEBUG") }
        assertEquals("true", flag("foss/e2e"))
        listOf("foss/debug", "foss/release", "play/release").forEach { assertEquals(it, "false", flag(it)) }
    }

    // A plugin library that gives its own placeholders values bakes them in before the app merge,
    // shadowing the app's; the e2e flag is the one that differs from such a default in every build.
    @Test
    fun appPlaceholdersReachPluginManifests() {
        val root =
            DocumentBuilderFactory
                .newInstance()
                .apply { isNamespaceAware = true }
                .newDocumentBuilder()
                .parse(File(property("yaran.mergedE2eManifest")))
                .documentElement
        val metaName = "io.github.siavz.yaran.machineview.e2eWebViewDebug"
        val meta = elements(root, "meta-data").single { it.getAttributeNS(android, "name") == metaName }
        assertEquals("true", meta.getAttributeNS(android, "value"))
    }
}

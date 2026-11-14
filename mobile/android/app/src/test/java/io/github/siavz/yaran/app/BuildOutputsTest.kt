/**
 * BuildOutputsTest: checks the flags that must hold in the built app, read from Gradle outputs.
 *
 * Gradle passes the fossDebug merged manifest and the generated BuildConfig directory (see
 * `app/build.gradle.kts`). The manifest must keep backup off, cleartext off, the network
 * security config, the add-org deep link and the predictive-back opt-in; `E2E_WEBVIEW_DEBUG`
 * must be true in the e2e build type and false in debug and every release variant, which is
 * what Phase 19's `check-release-flags.sh` relies on.
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
        val flavor = elements(application, "meta-data").single { it.getAttributeNS(android, "name") == "io.github.siavz.yaran.FLAVOR" }
        assertEquals("foss", flavor.getAttributeNS(android, "value"))
    }

    @Test
    fun webViewDebuggingIsOnOnlyInE2e() {
        val root = File(property("yaran.buildConfigRoot"))

        // AGP writes each variant's BuildConfig under <flavor>/<buildType>/.
        fun flag(variant: String): String {
            val source = File(root, "$variant/io/github/siavz/yaran/app/BuildConfig.java").readText()
            return Regex("boolean E2E_WEBVIEW_DEBUG = (\\w+);").find(source)?.groupValues?.get(1) ?: error("no flag in $variant")
        }
        assertEquals("true", flag("foss/e2e"))
        listOf("foss/debug", "foss/release", "play/release").forEach { assertEquals(it, "false", flag(it)) }
    }
}

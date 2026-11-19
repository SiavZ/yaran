/**
 * The plugin manifest's callback aliases: one enabled per build, never both (D8, work item 1).
 *
 * Parses `src/main/AndroidManifest.xml`: the https alias is `autoVerify`, off by default and
 * bound to the publisher-domain paths; the dev alias is on by default and owns the custom
 * scheme (the app manifest replaces both `enabled` values per build); both target the exported,
 * `noHistory` callback activity; the machine window is `singleTask`, not exported, and keeps the
 * page across size, orientation, uiMode and density changes. The library's `android` block gives
 * no placeholder values, which would shadow the app's, and no source file calls a WebView
 * bridge API (D9). The library asks for `ACCESS_NETWORK_STATE`, without which Chromium's
 * WebView never watches connectivity, so the page gets no `online` event (G3). The app's merged-manifest check (one build per variant) belongs to Phase 14's app.
 *
 * - Pure JVM XML parsing.
 *
 * <module-headers:begin>
 * Uses: none
 * External: java.io, javax.xml.parsers, org.junit, org.junit.Assert, org.w3c.dom
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class ManifestTest {
    private val manifest = File(System.getProperty("machineview.manifest")!!)
    private val ns = "http://schemas.android.com/apk/res/android"
    private val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        .newDocumentBuilder().parse(manifest)

    private fun elements(tag: String) = doc.getElementsByTagName(tag).let { l -> (0 until l.length).map { l.item(it) as Element } }

    private fun Element.a(name: String) = getAttributeNS(ns, name)

    private fun alias(name: String) = elements("activity-alias").single { it.a("name") == name }

    private fun dataOf(e: Element) = e.getElementsByTagName("data").let { l -> (0 until l.length).map { l.item(it) as Element } }
        .map { "${it.a("scheme")}://${it.a("host")}${it.a("path")}" }

    @Test
    fun httpsAliasIsVerifiedAndOffByDefault() {
        val https = alias(".AuthCallbackHttps")
        assertEquals("false", https.a("enabled"))
        assertEquals(".AuthCallbackActivity", https.a("targetActivity"))
        val filter = https.getElementsByTagName("intent-filter").item(0) as Element
        assertEquals("true", filter.a("autoVerify"))
        assertEquals(listOf("https://\${publisherDomain}/auth/callback", "https://\${publisherDomain}/oauth/callback"), dataOf(https))
    }

    // G6: verified agent links, off by default like the https callback; the app enables both together.
    @Test
    fun openLinkAliasIsVerifiedAndOffByDefault() {
        val open = alias(".OpenLinkHttps")
        assertEquals("false", open.a("enabled"))
        assertEquals(".OpenLinkActivity", open.a("targetActivity"))
        assertEquals("true", (open.getElementsByTagName("intent-filter").item(0) as Element).a("autoVerify"))
        assertEquals(listOf("https://\${publisherDomain}/open"), dataOf(open))
        val forwarder = elements("activity").single { it.a("name") == ".OpenLinkActivity" }
        assertEquals("only the verified alias reaches it", "false", forwarder.a("exported"))
    }

    @Test
    fun devAliasIsTheOnlyCustomSchemeAndOnByDefault() {
        val dev = alias(".AuthCallbackDev")
        assertEquals("true", dev.a("enabled"))
        assertEquals(listOf("yaranapp://auth/callback", "yaranapp://oauth/callback"), dataOf(dev))
        val schemes = elements("data").map { it.a("scheme") }
        assertEquals(2, schemes.count { it == "yaranapp" })
    }

    // G3: Chromium's WebView registers its network-change notifier only when this is granted.
    @Test
    fun asksForNetworkStateSoTheWebViewFiresOnline() {
        val permissions = elements("uses-permission").map { it.a("name") }.toSet()
        assertEquals(setOf("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"), permissions)
    }

    @Test
    fun callbackActivityAndMachineWindow() {
        val acts = elements("activity")
        val cb = acts.single { it.a("name") == ".AuthCallbackActivity" }
        assertEquals("true", cb.a("exported"))
        assertEquals("true", cb.a("noHistory"))
        val mv = acts.single { it.a("name") == ".MachineViewActivity" }
        assertEquals("false", mv.a("exported"))
        assertEquals("singleTask", mv.a("launchMode"))
        val changes = mv.a("configChanges").split('|').toSet()
        assertTrue(changes.containsAll(setOf("orientation", "screenSize", "smallestScreenSize", "screenLayout", "uiMode", "density")))
    }

    // Values given in the library's android block are substituted before the app merge and win
    // over the app's (a release shipped the dev domain that way); only test manifests get them.
    @Test
    fun libraryGivesNoPlaceholderValuesToItsOwnManifest() {
        val gradle = manifest.parentFile!!.parentFile!!.parentFile!!.resolve("build.gradle").readText()
        val androidBlock = gradle.substringBefore("androidComponents {")
        assertTrue(androidBlock.contains("defaultConfig {"))
        assertFalse(androidBlock.contains("manifestPlaceholders"))
    }

    @Test
    fun noSourceOpensABridgeIntoTheMachineWebView() {
        val src = manifest.parentFile!!.resolve("java")
        val bridge = Regex("addJavascriptInterface|addWebMessageListener|addDocumentStartJavaScript|evaluateJavascript|postWebMessage|createWebMessageChannel")
        val hits = src.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { f -> f.readLines().filter { l -> !l.trimStart().startsWith("*") && bridge.containsMatchIn(l) }.map { "${f.name}: $it" } }.toList()
        assertEquals(emptyList<String>(), hits)
    }
}

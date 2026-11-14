/**
 * JUnit pin for the in-process requirement of machine-view (G6 "cookies not visible" root cause).
 *
 * Parses `app/src/main/AndroidManifest.xml` and asserts the MachineViewSpikeActivity entry has
 * no `android:process` attribute (a separate process would get its own CookieManager and miss
 * the injected cookie) and is not exported.
 *
 * - Reads the source manifest from the module directory, Gradle's unit-test working directory.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.MachineViewManifestTest
 * External: junit, javax.xml.parsers
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.MachineViewManifestTest
 * └── entry point (JUnit)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class MachineViewManifestTest {
    private val androidNs = "http://schemas.android.com/apk/res/android"

    @Test
    fun machineViewActivityIsInProcessAndNotExported() {
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val doc = factory.newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activities = doc.getElementsByTagName("activity")
        val matches = (0 until activities.length)
            .map { activities.item(it) as Element }
            .filter { it.getAttributeNS(androidNs, "name").endsWith("MachineViewSpikeActivity") }
        assertEquals("exactly one MachineViewSpikeActivity entry", 1, matches.size)
        val entry = matches.single()
        assertFalse("android:process must be absent", entry.hasAttributeNS(androidNs, "process"))
        assertEquals("false", entry.getAttributeNS(androidNs, "exported"))
    }
}

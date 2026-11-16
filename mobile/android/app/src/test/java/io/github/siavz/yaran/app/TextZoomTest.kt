/**
 * TextZoomTest: the font-scale to WebView text-zoom mapping.
 *
 * The shell follows the system font size through `WebSettings.textZoom`; this pins the pure
 * mapping, including the clamps and the fallback for a nonsensical scale.
 *
 * - Plain JUnit; no Android classes are touched.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.TextZoomTest
 * └── io.github.siavz.yaran.app.MainActivity (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import org.junit.Assert.assertEquals
import org.junit.Test

class TextZoomTest {
    @Test
    fun mapsFontScaleToPercent() {
        mapOf(
            1.0f to 100,
            0.85f to 85,
            1.15f to 115,
            1.3f to 130,
            2.0f to 200,
            0.1f to 50,
            5.0f to 300,
            0f to 100,
            -1f to 100,
            Float.NaN to 100,
        ).forEach { (scale, zoom) -> assertEquals("scale $scale", zoom, textZoomFor(scale)) }
    }
}

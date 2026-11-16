/**
 * The `YaranApp/<version> (android; phone|tablet)` user-agent token (02 §11).
 *
 * Appended to the WebView's own user agent so yaran recognises the app (Phase 13), and sent
 * alone as the org API client's `User-Agent`. Pinned by `cloud/protocol/fixtures/ua/ua.json`.
 *
 * - Pure. A version the grammar does not allow throws, so a bad build fails loudly.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.UaToken
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal object UaToken {
    private val VERSION = Regex("^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$")

    fun token(version: String, os: String, form: String): String {
        require(VERSION.matches(version)) { "invalid app version" }
        require(os == "android" || os == "ios") { "invalid os" }
        require(form == "phone" || form == "tablet") { "invalid form" }
        return "YaranApp/$version ($os; $form)"
    }

    fun formFor(smallestScreenWidthDp: Int) = if (smallestScreenWidthDp >= 600) "tablet" else "phone"
}

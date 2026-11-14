/**
 * The gate-selected switches (Phase 03 G1, G6, G13): one constant each, decided at build time.
 *
 * Every gate verdict is OPEN, so each switch holds the primary path. Adopting a fallback is
 * a one-line change here plus its tests; nothing else in the plugin changes shape.
 *
 * - G1 step 2 (Managed OAuth with headers or the loopback proxy) is not built: the plan
 *   builds it only once Phase 03 records it adopted; `CredentialKind.MANAGED_OAUTH` exists.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.Fallbacks
 * └── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Fallbacks
 * ├── io.github.siavz.yaran.machineview.CookieInjector (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal object Fallbacks {
    /** G1: ACCESS_JWT injects the assertion; ACCESS_COOKIE (rung 1) injects HandoffPayload.cookie. */
    val CREDENTIAL_RUNG = CredentialKind.ACCESS_JWT

    /** G13: ask the handoff server to return the result in the fragment instead of the query. */
    const val HANDOFF_MODE_FRAGMENT = false

    /** G6: force the padding insets mode whatever the WebView version. */
    const val FORCE_PADDING_INSETS = false

    /** G6: when above zero, poll the cookie store this long for the injected cookie before loading. */
    const val COOKIE_POLL_MS = 0L
}

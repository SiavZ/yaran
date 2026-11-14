/**
 * The `CF_Authorization` cookie the machine window injects, and the cookies that clear it.
 *
 * A host-only session cookie (no `Domain`, no `Expires`), so the JWT never lands in the
 * WebView's on-disk cookie database and the vault stays its only home at rest (D8, T37).
 * The value is the handoff's JWT, or under G1 rung 1 its `cookie` field when present.
 * Pinned by `fixtures/cookie-cases.json`.
 *
 * - Pure. A value outside `[A-Za-z0-9._-]{1,4096}` is refused, so nothing can add attributes.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.CookieSpec
 * ├── io.github.siavz.yaran.machineview.CookieInjector (inferred)
 * ├── io.github.siavz.yaran.machineview.Fallbacks (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinatorTest (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal enum class CredentialKind(val wire: String) {
    ACCESS_JWT("accessJwt"),
    ACCESS_COOKIE("accessCookie"),
    MANAGED_OAUTH("managedOAuth");

    companion object {
        fun fromWire(s: String?): CredentialKind? = entries.firstOrNull { it.wire == s }
    }
}

internal data class InjectedCookie(val setCookie: String, val usedCookieField: Boolean, val diagnostic: Boolean)

internal object CookieSpec {
    private val VALUE = Regex("^[A-Za-z0-9._-]{1,4096}$")
    private const val ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax"
    private const val EXPIRED = "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"

    val clearCookies = listOf(
        "CF_Authorization=; $ATTRS; $EXPIRED",
        "CF_AppSession=; $ATTRS; $EXPIRED",
    )

    fun cookieUrl(host: String) = "https://$host/"

    /** The Set-Cookie value to inject, or null when the chosen value is unsafe. */
    fun setCookie(jwt: String, cookie: String?, rung: CredentialKind): InjectedCookie? {
        val useCookie = rung == CredentialKind.ACCESS_COOKIE && cookie != null
        val value = if (useCookie) cookie else jwt
        if (!VALUE.matches(value)) return null
        val diagnostic = rung == CredentialKind.ACCESS_COOKIE && cookie == null
        return InjectedCookie("CF_Authorization=$value; $ATTRS", useCookie, diagnostic)
    }

    /** The bare cookie value (for the org API client's `Cookie` header), same rules. */
    fun value(jwt: String, cookie: String?, rung: CredentialKind): String? =
        setCookie(jwt, cookie, rung)?.setCookie?.substringAfter('=')?.substringBefore(';')
}

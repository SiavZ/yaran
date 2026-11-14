/**
 * JUnit pins for the machine-view cookie string (G1 step 4 attributes, L0 primary path).
 *
 * Checks that [buildAccessCookie] emits a host-only `CF_Authorization` cookie with `Path=/`,
 * Secure, HttpOnly, the requested SameSite and an `Expires` equal to the JWT's own `exp`, and
 * that it refuses anything that is not a JWT or would inject extra cookie attributes.
 *
 * - Pure JVM: no Android runtime, no network.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.AccessCookieTest
 * └── io.github.siavz.yaran.gatespike.MachineViewSpike   (buildAccessCookie, jwtExp)
 * External: junit, java.util.Base64
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.AccessCookieTest
 * └── entry point (JUnit)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class AccessCookieTest {
    private fun b64(s: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray())

    // exp 1767225600 = Thu, 01 Jan 2026 00:00:00 GMT
    private val jwt = b64("""{"alg":"RS256","kid":"k1"}""") + "." +
        b64("""{"aud":["a1"],"email":"owner@example.invalid","exp":1767225600,"iat":1767225420,"type":"app"}""") +
        ".c2lnbmF0dXJl"

    @Test
    fun emitsExactAttributesWithExpiresFromJwtExp() {
        assertEquals(
            "CF_Authorization=$jwt; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 2026 00:00:00 GMT",
            buildAccessCookie(jwt, "Lax"),
        )
    }

    @Test
    fun isHostOnly() {
        assertFalse(buildAccessCookie(jwt, "Lax").contains("Domain", ignoreCase = true))
    }

    @Test
    fun passesSameSiteThrough() {
        for (s in listOf("Strict", "Lax", "None")) {
            assertTrue(buildAccessCookie(jwt, s).contains("; SameSite=$s;"))
        }
    }

    @Test
    fun explicitExpOverridesThePayload() {
        assertTrue(buildAccessCookie(jwt, "None", 0L).endsWith("Expires=Thu, 01 Jan 1970 00:00:00 GMT"))
    }

    @Test
    fun decodesExp() {
        assertEquals(1767225600L, jwtExp(jwt))
    }

    @Test
    fun rejectsNonJwts() {
        for (bad in listOf("", "not-a-jwt", "a.b", "a.b.c.d", "$jwt; Domain=evil.example", "a.b.")) {
            assertThrows(IllegalArgumentException::class.java) { buildAccessCookie(bad, "Lax") }
        }
    }

    @Test
    fun rejectsJwtWithoutExp() {
        val noExp = b64("""{"alg":"none"}""") + "." + b64("""{"aud":"a"}""") + ".sig"
        assertThrows(IllegalArgumentException::class.java) { buildAccessCookie(noExp, "Lax") }
    }

    @Test
    fun rejectsUnknownSameSite() {
        assertThrows(IllegalArgumentException::class.java) { buildAccessCookie(jwt, "Lax; Domain=x") }
    }
}

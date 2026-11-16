/**
 * Tests for PushGateway's mapping of Phase 15's org API results into the push plugin's terms.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.PushGatewayTest
 * ├── io.github.siavz.yaran.app.PushGateway (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes
 * └── io.github.siavz.yaran.push.PushBindings
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import io.github.siavz.yaran.machineview.ApiResult
import io.github.siavz.yaran.push.OrgApiResult
import org.junit.Assert.assertEquals
import org.junit.Test

class PushGatewayTest {
    @Test
    fun mapsEveryResultAndKeepsTheEnvelopeCode() {
        assertEquals(OrgApiResult.Ok(201, "{}"), toPush(ApiResult.Ok(201, "{}")))
        assertEquals(OrgApiResult.Ok(204, "null"), toPush(ApiResult.Ok(204, null)))
        val envelope = """{"error":{"code":"rate_limited","message":"slow","retryable":true},"request_id":"r"}"""
        assertEquals(OrgApiResult.ApiError(429, "rate_limited"), toPush(ApiResult.ApiError(429, envelope)))
        assertEquals(OrgApiResult.ApiError(500, "unknown"), toPush(ApiResult.ApiError(500, "<html>")))
        assertEquals(OrgApiResult.SessionExpired, toPush(ApiResult.SessionExpired))
        assertEquals(OrgApiResult.DeviceRevoked, toPush(ApiResult.DeviceRevoked))
        assertEquals(OrgApiResult.Offline, toPush(ApiResult.Offline))
        assertEquals(OrgApiResult.TlsError, toPush(ApiResult.TlsError))
        assertEquals(OrgApiResult.Refused, toPush(ApiResult.Refused("body_device_key")))
        assertEquals(OrgApiResult.ProtocolUnsupported, toPush(ApiResult.ProtocolUnsupported(2, 3)))
    }
}

/**
 * The Kotlin side of the plugin's exhaustive result unions (`src/outcomes.ts`).
 *
 * `SignInOutcome` and `ApiResult` mirror the TypeScript kinds one for one; [toJs] gives the
 * map the plugin adapters resolve with. No variant can hold a JWT, cookie or key (D22).
 *
 * - Pure.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Outcomes
 * ├── io.github.siavz.yaran.app.PushGateway
 * ├── io.github.siavz.yaran.app.PushGatewayTest
 * ├── io.github.siavz.yaran.machineview.AndroidKeyStoreBackend (inferred)
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeOrgApi (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinator (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinatorTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

enum class SecurityLevel(val wire: String) { STRONGBOX("strongbox"), TEE("tee"), SECURE_ENCLAVE("secure_enclave"), SOFTWARE("software") }

sealed class SignInOutcome(val kind: String) {
    data class SignedIn(val host: String, val email: String, val expiresAt: Long) : SignInOutcome("signed_in")
    data object Cancelled : SignInOutcome("cancelled")
    data object Declined : SignInOutcome("declined")
    data object Interrupted : SignInOutcome("interrupted")
    data class VerificationFailed(val domain: String) : SignInOutcome("verification_failed")
    data object RateLimited : SignInOutcome("rate_limited")
    data class ProtocolUnsupported(val min: Int?, val max: Int?) : SignInOutcome("protocol_unsupported")
    data class ClockSkewed(val serverTime: Long?) : SignInOutcome("clock_skewed")
    data class DeviceKeyRejected(val code: String, val securityLevel: SecurityLevel) : SignInOutcome("device_key_rejected")
    data class Refused(val code: String) : SignInOutcome("refused")
    data object NoBrowser : SignInOutcome("no_browser")
    data object Mismatch : SignInOutcome("mismatch")
    data class DecryptFailed(val code: String) : SignInOutcome("decrypt_failed")
    data object EnvelopeExpired : SignInOutcome("envelope_expired")
    data class NotOwner(val email: String?) : SignInOutcome("not_owner")
    data object Offline : SignInOutcome("offline")
    data object TlsError : SignInOutcome("tls_error")
    data object VaultLocked : SignInOutcome("vault_locked")

    fun toJs(): Map<String, Any> {
        val m = linkedMapOf<String, Any>("kind" to kind)
        when (this) {
            is SignedIn -> m += mapOf("host" to host, "email" to email, "expiresAt" to expiresAt)
            is VerificationFailed -> m["domain"] = domain
            is ProtocolUnsupported -> { min?.let { m["min"] = it }; max?.let { m["max"] = it } }
            is ClockSkewed -> serverTime?.let { m["serverTime"] = it }
            is DeviceKeyRejected -> m += mapOf("code" to code, "securityLevel" to securityLevel.wire)
            is Refused -> m["code"] = code
            is DecryptFailed -> m["code"] = code
            is NotOwner -> email?.let { m["email"] = it }
            Cancelled, Declined, Interrupted, RateLimited, NoBrowser, Mismatch, EnvelopeExpired, Offline, TlsError, VaultLocked -> Unit
        }
        return m
    }
}

/** JSON values travel as validated JSON text, so no parse tree crosses into the adapter. */
sealed class ApiResult(val kind: String) {
    data class Ok(val status: Int, val bodyJson: String?) : ApiResult("ok")
    data class ApiError(val status: Int, val envelopeJson: String) : ApiResult("api_error")
    data object SessionExpired : ApiResult("session_expired")
    data object DeviceRevoked : ApiResult("device_revoked")
    data object Offline : ApiResult("offline")
    data object TlsError : ApiResult("tls_error")
    data class Refused(val reason: String) : ApiResult("refused")
    data class ProtocolUnsupported(val min: Int?, val max: Int?) : ApiResult("protocol_unsupported")
}

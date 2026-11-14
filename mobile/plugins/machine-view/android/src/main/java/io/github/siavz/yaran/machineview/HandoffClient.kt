/**
 * The sealed-handoff orchestrator: steps 1-8 of the Phase 15 design, platform-free.
 *
 * [begin] mints a fresh in-memory P-256 key and state, records a key-free marker in the
 * vault, signs the request with the org's device key (D24) and returns the URL for the system
 * browser. The browser leg ends in exactly one of [onRedirect], [onCancelled],
 * [onVerificationFailed] or [onNoBrowser]; each consumes the single pending entry and returns
 * the outcome. A callback after process death finds the marker but no key and ends
 * "interrupted": the key never touched storage (02 §8 obligation 8).
 *
 * - One pending handoff at a time; a new [begin] replaces the old one. Thread-safe.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffClient
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fallbacks (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.security, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.HandoffClient
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONObject
import java.security.SecureRandom

internal sealed interface SignInTarget {
    data object ControlPlane : SignInTarget
    data class Machine(val host: String) : SignInTarget
}

internal sealed interface Begin {
    data class Launch(val url: String) : Begin
    data class Failed(val outcome: SignInOutcome) : Begin
}

internal class HandoffClient(
    private val vault: SecretVault,
    private val orgs: OrgDirectory,
    private val sessions: SessionStore,
    private val deviceKeys: DeviceKeyStore,
    private val mode: CallbackMode,
    private val deviceLabel: String,
    private val now: () -> Long,
    private val diagnostics: DiagnosticsSink,
    private val random: SecureRandom = SecureRandom(),
) {
    private class Pending(
        val orgId: String,
        val target: HandoffTarget,
        val host: String,
        val kind: String,
        val recipient: Recipient,
        val state: String,
        val createdAt: Long,
    )

    private var pending: Pending? = null

    @Synchronized
    fun begin(orgId: String, target: SignInTarget): Begin {
        val (handoffTarget, kind) = when (target) {
            SignInTarget.ControlPlane -> {
                val orgUrl = orgs.orgUrl(orgId)?.takeIf { HostRules.ORG_URL.matches(it) }
                    ?: return Begin.Failed(SignInOutcome.Refused("unknown_org"))
                HandoffTarget.ControlPlane(orgUrl) to SealedEnvelope.KIND_CONTROL_PLANE
            }
            is SignInTarget.Machine -> {
                if (!HostRules.HOSTNAME.matches(target.host)) return Begin.Failed(SignInOutcome.Refused("host_invalid"))
                HandoffTarget.Machine(target.host) to SealedEnvelope.KIND_MACHINE
            }
        }
        val host = HandoffUrl.signedHost(handoffTarget)
        return try {
            val identity = deviceKeys.ensure(orgId)
            val recipient = SealedEnvelope.generateRecipient()
            val state = B64url.encode(ByteArray(32).also { random.nextBytes(it) })
            val createdAt = now()
            val marker = JSONObject().put("state", state).put("host", host).put("target", kind).put("created_at", createdAt)
            vault.write(MARKER_NS, marker.toString().toByteArray(Charsets.UTF_8), ProtectionClass.STANDARD)
            val dsig = deviceKeys.sign(orgId, HandoffSignature.canonical(host, recipient.pk, state, createdAt))
            pending = Pending(orgId, handoffTarget, host, kind, recipient, state, createdAt)
            diagnostics.append("machine-view handoff start target=$kind host=$host")
            val params = HandoffParams(recipient.pk, state, identity.publicKey, createdAt, dsig)
            Begin.Launch(HandoffUrl.build(handoffTarget, mode, Fallbacks.HANDOFF_MODE_FRAGMENT, deviceLabel, params))
        } catch (e: VaultLockedException) {
            Begin.Failed(SignInOutcome.VaultLocked)
        }
    }

    @Synchronized
    fun hasPending() = pending != null

    @Synchronized
    fun onRedirect(uri: String): SignInOutcome {
        val p = pending
        pending = null
        val marker = readMarker()
        vault.delete(MARKER_NS)
        if (p == null) {
            val ref = marker ?: return finish(SignInOutcome.Mismatch, "no pending handoff")
            return when (CallbackUrl.parse(mode, uri, ref, now())) {
                is CallbackResult.Success, is CallbackResult.Error -> finish(SignInOutcome.Interrupted, null)
                is CallbackResult.Refused -> finish(SignInOutcome.Mismatch, "no pending handoff")
            }
        }
        return when (val r = CallbackUrl.parse(mode, uri, PendingRef(p.state, p.createdAt), now())) {
            is CallbackResult.Refused -> finish(SignInOutcome.Mismatch, "callback refused reason=${r.reason.name.lowercase()}")
            is CallbackResult.Error -> finish(errorOutcome(p, r), null)
            is CallbackResult.Success -> when (val o = SealedEnvelope.open(r.jwe, p.recipient, p.host, p.state, p.kind, now())) {
                is OpenResult.Failed -> finish(
                    when (o.code) {
                        "jwe_state_mismatch" -> SignInOutcome.Mismatch
                        "jwe_expired" -> SignInOutcome.EnvelopeExpired
                        else -> SignInOutcome.DecryptFailed(o.code)
                    },
                    "envelope refused code=${o.code}",
                )
                is OpenResult.Opened -> try {
                    sessions.put(p.orgId, o.payload)
                    finish(SignInOutcome.SignedIn(p.host, o.payload.email, sessions.get(p.host)?.exp ?: o.payload.exp), null)
                } catch (e: VaultLockedException) {
                    finish(SignInOutcome.VaultLocked, null)
                }
            }
        }
    }

    @Synchronized
    fun onCancelled(): SignInOutcome? = consume()?.let { finish(SignInOutcome.Cancelled, null) }

    @Synchronized
    fun onVerificationFailed(): SignInOutcome? = consume()?.let {
        finish(SignInOutcome.VerificationFailed((mode as? CallbackMode.Https)?.domain ?: ""), null)
    }

    @Synchronized
    fun onNoBrowser(): SignInOutcome? = consume()?.let { finish(SignInOutcome.NoBrowser, null) }

    private fun consume(): Pending? {
        val p = pending ?: return null
        pending = null
        vault.delete(MARKER_NS)
        return p
    }

    private fun errorOutcome(p: Pending, e: CallbackResult.Error): SignInOutcome = when (e.code) {
        "handoff_declined" -> SignInOutcome.Declined
        "rate_limited" -> SignInOutcome.RateLimited
        "protocol_unsupported" -> SignInOutcome.ProtocolUnsupported(e.min, e.max)
        "handoff_timestamp_skewed" -> SignInOutcome.ClockSkewed(e.serverTime)
        "handoff_device_key_invalid", "handoff_signature_malformed" -> {
            val level = runCatching { deviceKeys.level(p.orgId) }.getOrDefault(SecurityLevel.SOFTWARE)
            diagnostics.append("machine-view handoff device key refused code=${e.code} level=${level.wire}")
            SignInOutcome.DeviceKeyRejected(e.code, level)
        }
        "handoff_owner_mismatch" -> SignInOutcome.NotOwner(null)
        else -> SignInOutcome.Refused(e.code)
    }

    private fun readMarker(): PendingRef? = try {
        vault.read(MARKER_NS)?.let { JSONObject(String(it, Charsets.UTF_8)) }?.let { PendingRef(it.getString("state"), it.getLong("created_at")) }
    } catch (e: Exception) {
        null
    }

    private fun finish(outcome: SignInOutcome, why: String?): SignInOutcome {
        diagnostics.append("machine-view handoff outcome kind=${outcome.kind}" + (why?.let { " ($it)" } ?: ""))
        return outcome
    }

    companion object {
        const val MARKER_NS = "handoff"
    }
}

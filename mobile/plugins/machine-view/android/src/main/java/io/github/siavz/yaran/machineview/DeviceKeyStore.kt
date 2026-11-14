/**
 * The per-org, non-exportable P-256 device key (D24) and its unit rule with the `InstallId`.
 *
 * One signing key per org registration (alias `yaran.device.<orgId>`), minted and deleted
 * together with that org's `InstallId`, so two orgs cannot link the phone by its key and the
 * Worker never sees a new key under an old install id. If either half is missing while the
 * other is present, both are deleted and reminted. Minting writes one diagnostics line with
 * the security level and the key's `DeviceKeyFingerprint`, never the key.
 *
 * - The private key never leaves the [DeviceKeyBackend]; only signatures and the public point do.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DeviceKeyStore
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * └── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.DeviceKeyStore
 * ├── io.github.siavz.yaran.machineview.AndroidKeyStoreBackend (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

/** Where the keys live: AndroidKeyStore on a device, a software JCA key in JVM tests. */
interface DeviceKeyBackend {
    fun exists(alias: String): Boolean

    /** Creates a key under [alias] and reports where it lives. */
    fun generate(alias: String): SecurityLevel

    fun level(alias: String): SecurityLevel

    /** The 65-byte uncompressed SEC1 public point. */
    fun publicPoint(alias: String): ByteArray

    /** SHA256withECDSA over [data], DER-encoded. */
    fun signDer(alias: String, data: ByteArray): ByteArray

    fun delete(alias: String)
}

internal data class DeviceIdentity(val installId: String, val publicKey: String, val registered: Boolean)

internal class DeviceKeyStore(
    private val backend: DeviceKeyBackend,
    private val installIds: InstallIdStore,
    private val diagnostics: DiagnosticsSink,
) {
    fun alias(orgId: String) = "yaran.device.$orgId"

    @Synchronized
    fun ensure(orgId: String): DeviceIdentity {
        val alias = alias(orgId)
        var record = installIds.get(orgId)
        val hasKey = backend.exists(alias)
        if (record == null || !hasKey) {
            if (record != null || hasKey) {
                diagnostics.append("machine-view device identity reminted: one of install id and device key was missing")
                backend.delete(alias)
                installIds.delete(orgId)
            }
            val level = backend.generate(alias)
            record = installIds.mint(orgId)
            val fp = HandoffSignature.displayFingerprint(HandoffSignature.fingerprint24(backend.publicPoint(alias)))
            diagnostics.append("machine-view device key minted level=${level.wire} fp=$fp")
        }
        return DeviceIdentity(record.installId, B64url.encode(backend.publicPoint(alias)), record.registered)
    }

    /** The public key (P256Point) when this org has a whole identity, else null. */
    fun publicKey(orgId: String): String? =
        if (installIds.get(orgId) != null && backend.exists(alias(orgId))) B64url.encode(backend.publicPoint(alias(orgId))) else null

    fun level(orgId: String): SecurityLevel = backend.level(alias(orgId))

    /** The raw `EcdsaP256Sig` over [canonical] (02 §8.1). */
    fun sign(orgId: String, canonical: String): String =
        HandoffSignature.derToRawB64(backend.signDer(alias(orgId), canonical.toByteArray(Charsets.UTF_8)))
            ?: throw IllegalStateException("the key store returned a malformed signature")

    @Synchronized
    fun delete(orgId: String) {
        backend.delete(alias(orgId))
        installIds.delete(orgId)
    }
}

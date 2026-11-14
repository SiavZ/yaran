/**
 * The relay-held FCM fallback: the wrapped key store's round trip, Tink decryption against
 * RFC 8291 Appendix A and 02's `webpush/payload-vectors.json`, FCM data-message parsing against
 * `push/relay-wrapping.json`, the `FcmMintRequest` body, and the relay client's refusals.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.relay.RelayFcmTest
 * ├── io.github.siavz.yaran.push.DeviceRegistrar
 * ├── io.github.siavz.yaran.push.Fixtures
 * ├── io.github.siavz.yaran.push.SubscriptionStore
 * ├── io.github.siavz.yaran.push.relay.FcmRelayKeyStore (inferred)
 * ├── io.github.siavz.yaran.push.relay.RelayEndpointClient (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport (inferred)
 * External: android.content, com.google.crypto.tink.apps.fixed_webpush, javax.crypto, org.junit, org.junit.Assert, org.junit.runner, org.robolectric
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * io.github.siavz.yaran.push.relay.RelayFcmTest
 * └── io.github.siavz.yaran.push.relay.RelayEndpointClient (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.relay

import android.content.Context
import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridDecrypt
import io.github.siavz.yaran.push.Fixtures
import io.github.siavz.yaran.push.SubscribeResult
import io.github.siavz.yaran.push.SubscriptionStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import javax.crypto.KeyGenerator

private const val VAPID = "BGuXrBERTW6sUC8-SWAenyGmbmQg3GyikfpRKoD9PWtulg4KijYaQ6d6wd5EVYTC12m3K0K5IRf66r20urk2rG0"
private const val ENDPOINT = "https://relay.example.com/w/v1.k1.AAAAAAAAAAAAAAAAAAAAAAAA"

private class ScriptedTransport(val answer: (String, String) -> HttpResponse) : RelayTransport {
    val sent = mutableListOf<Pair<String, String?>>()
    override fun send(method: String, url: java.net.URL, body: String?): HttpResponse {
        sent += url.path to body
        return answer(method, url.path)
    }
}

private fun meta(apps: String = "\"com.example.yaran\"", channels: String = "\"fcm\"") =
    HttpResponse(200, null, """{"service":"yaran-push-relay","protocol":{"min":1,"max":1},"apps":[$apps],"channels":[$channels],"endpoint_key_id":"k1"}""")

@RunWith(RobolectricTestRunner::class)
class RelayFcmTest {
    private lateinit var context: Context
    private val softwareKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private lateinit var keys: FcmRelayKeyStore

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        keys = FcmRelayKeyStore(context) { softwareKey }
    }

    private fun decrypt(body: ByteArray, publicKey: ByteArray, privateScalar: ByteArray, auth: ByteArray): ByteArray =
        WebPushHybridDecrypt.Builder().withAuthSecret(auth).withRecipientPublicKey(publicKey).withRecipientPrivateKey(privateScalar)
            .build().decrypt(body, null)

    @Test
    fun keyStoreRoundTripAndSelectionByRegistrationId() {
        val a = keys.getOrCreate("org-a")
        val b = keys.getOrCreate("org-b")
        val reloaded = FcmRelayKeyStore(context) { softwareKey }.load("org-a")!!
        assertEquals(a.registrationId, reloaded.registrationId)
        assertArrayEquals(a.publicKey, reloaded.publicKey)
        assertArrayEquals(a.auth, reloaded.auth)
        assertArrayEquals(FcmRelayKeyStore.scalar(a.privateKey), FcmRelayKeyStore.scalar(reloaded.privateKey))
        assertEquals(65, a.publicKey.size)
        assertEquals("org-b", keys.find(b.registrationId)?.orgId)
        assertNotEquals(a.registrationId, b.registrationId)
        keys.delete("org-a")
        assertNull(keys.find(a.registrationId))
        val otherDevice = FcmRelayKeyStore(context) { KeyGenerator.getInstance("AES").apply { init(256) }.generateKey() }
        assertNull("a blob wrapped by another key never unwraps", otherDevice.load("org-b"))
    }

    @Test
    fun tinkDecryptsRfc8291AppendixA() {
        val v = Fixtures.json("fixtures/webpush/rfc8291-appendix-a.json")
        val plain = decrypt(Fixtures.b64(v.getString("body")), Fixtures.b64(v.getString("ua_public")), Fixtures.b64(v.getString("ua_private")), Fixtures.b64(v.getString("auth_secret")))
        assertArrayEquals(Fixtures.b64(v.getString("plaintext")), plain)
    }

    @Test
    fun tinkDecryptsThePayloadVectors() {
        val v = Fixtures.json("fixtures/webpush/payload-vectors.json")
        val cases = Fixtures.objects(v.getJSONArray("cases"))
        assertEquals(3, cases.size)
        for (c in cases) {
            val plain = decrypt(Fixtures.b64(c.getString("body_b64url")), Fixtures.b64(v.getString("ua_public")), Fixtures.b64(v.getString("ua_private")), Fixtures.b64(v.getString("auth_secret")))
            assertArrayEquals(c.getString("name"), Fixtures.b64(c.getString("plaintext_b64url")), plain)
        }
    }

    @Test
    fun fcmDataMessagesFromTheFixture() {
        val wrapping = Fixtures.json("fixtures/push/relay-wrapping.json")
        val transport = RelayFcmTransport(keys, SubscriptionStore(context), null) { null }
        for (c in Fixtures.objects(wrapping.getJSONArray("fcm"))) {
            val data = c.getJSONObject("message").getJSONObject("data")
            val map = data.keys().asSequence().associateWith { data.getString(it) }
            // Nobody holds the fixture's registration id here: nothing is selected.
            assertNull(transport.open(map))
        }
        assertNull(transport.open(mapOf("v" to "2", "r" to wrapping.getString("registration_id"), "y" to "AA")))
        assertNull(transport.open(mapOf("v" to "1", "r" to "nope", "y" to "AA")))
        // A known registration id with an undecryptable body selects the org and shows the generic text.
        val mine = keys.getOrCreate("org-1")
        assertEquals("org-1" to null, transport.open(mapOf("v" to "1", "r" to mine.registrationId, "y" to wrapping.getString("body_b64url"))))
    }

    @Test
    fun mintBodyIsTheFcmMintRequest() {
        val fixture = Fixtures.objects(Fixtures.json("fixtures/api/FcmMintRequest.json").getJSONArray("valid"))[0].getJSONObject("value")
        val client = RelayEndpointClient("https://relay.example.com", fixture.getString("app_id"), ScriptedTransport { _, _ -> meta() })
        val body = client.fcmMintBody(fixture.getString("fcm_token"), fixture.getString("vapid_public_key"), fixture.getString("registration_id"))
        assertEquals(fixture.keys().asSequence().toSet(), body.keys().asSequence().toSet())
        for (k in fixture.keys()) assertEquals(k, fixture.get(k), body.get(k))
    }

    @Test
    fun subscribeMintsOnceAndReusesUntilSomethingChanges() {
        var token = "token-1"
        val transport = ScriptedTransport { _, path -> if (path.endsWith("/v1/meta")) meta() else HttpResponse(201, null, """{"endpoint":"$ENDPOINT"}""") }
        val client = RelayEndpointClient("https://relay.example.com", "com.example.yaran", transport)
        val store = SubscriptionStore(context)
        val relay = RelayFcmTransport(keys, store, client) { token }
        val first = (relay.subscribe("org-1", VAPID) as SubscribeResult.Ok).subscription
        assertEquals("fcm_relay", first.channel)
        assertEquals(ENDPOINT, first.endpoint)
        assertNull(first.distributor)
        relay.subscribe("org-1", VAPID)
        assertEquals(1, transport.sent.count { it.first.endsWith("/v1/endpoints") })
        token = "token-2"
        relay.subscribe("org-1", VAPID)
        assertEquals(2, transport.sent.count { it.first.endsWith("/v1/endpoints") })
        val minted = transport.sent.last { it.first.endsWith("/v1/endpoints") }.second!!
        assertTrue(minted.contains("\"kind\":\"fcm\"") && minted.contains("token-2"))
    }

    @Test
    fun relayClientRefusals() {
        assertThrows(RelayError.InsecureBaseUrl::class.java) { RelayEndpointClient("http://relay.example.com", "a") }
        fun client(r: HttpResponse, metaResponse: HttpResponse = meta()) =
            RelayEndpointClient("https://relay.example.com", "com.example.yaran", ScriptedTransport { _, p -> if (p.endsWith("/v1/meta")) metaResponse else r })
        assertThrows(RelayError.AppNotServed::class.java) { client(meta(), meta(apps = "\"other\"")).endpointKeyId("fcm") }
        assertThrows(RelayError.ChannelNotServed::class.java) { client(meta(), meta(channels = "\"apns\"")).endpointKeyId("fcm") }
        assertEquals(RelayError.RateLimited(30), runCatching { client(HttpResponse(429, "30", "")).mint(org.json.JSONObject()) }.exceptionOrNull())
        assertEquals(RelayError.Unavailable(503), runCatching { client(HttpResponse(503, null, "")).mint(org.json.JSONObject()) }.exceptionOrNull())
        assertEquals(RelayError.Unavailable(500), runCatching { client(HttpResponse(500, null, "oops")).mint(org.json.JSONObject()) }.exceptionOrNull())
        val unknown = HttpResponse(400, null, """{"error":{"code":"relay_app_unknown","message":"x","retryable":false},"request_id":"r"}""")
        assertEquals(RelayError.Api(400, "relay_app_unknown"), runCatching { client(unknown).mint(org.json.JSONObject()) }.exceptionOrNull())
        assertEquals(RelayError.Malformed, runCatching { client(HttpResponse(201, null, """{"endpoint":"https://evil.example/x"}""")).mint(org.json.JSONObject()) }.exceptionOrNull())
    }
}

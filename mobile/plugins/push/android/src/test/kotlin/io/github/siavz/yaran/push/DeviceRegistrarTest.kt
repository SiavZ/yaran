/**
 * `DeviceRegistrar` against a stub of Phase 15's org client and a fake transport: the W12 body
 * has exactly 02's `DeviceRegistration` fields, `device_key` is the org's device key (push off
 * included), push off sends `{kind: none}`, and `device_revoked` is surfaced and forgets the
 * subscription. Also the local stores: mutes, the pending queue across process death, and the
 * subscription store.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.DeviceRegistrarTest
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.Fixtures (inferred)
 * ├── io.github.siavz.yaran.push.MuteStore (inferred)
 * ├── io.github.siavz.yaran.push.PendingRegistrationStore (inferred)
 * ├── io.github.siavz.yaran.push.PushBindings (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * └── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * External: android.content, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/push/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

private const val DEVICE_KEY = "BGuXrBERTW6sUC8-SWAenyGmbmQg3GyikfpRKoD9PWtulg4KijYaQ6d6wd5EVYTC12m3K0K5IRf66r20urk2rG0"
private const val VAPID = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
private const val MACHINE = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"

private class StubOrgApi(var result: OrgApiResult = OrgApiResult.Ok(201, """{"id":"c0ffee00-1234-4abc-bdef-0123456789ab"}""")) : OrgApiGateway {
    val bodies = mutableListOf<JSONObject>()
    override fun devicePublicKey(orgId: String) = DEVICE_KEY
    override fun registerDevice(orgId: String, body: JSONObject): OrgApiResult = result.also { bodies += body }
}

private class FakeSource(var result: SubscribeResult) : SubscriptionSource {
    val forgotten = mutableListOf<String>()
    override fun subscribe(orgId: String, vapidPublicKey: String) = result
    override fun forget(orgId: String) {
        forgotten += orgId
    }
}

@RunWith(RobolectricTestRunner::class)
class DeviceRegistrarTest {
    private lateinit var context: Context
    private lateinit var store: SubscriptionStore
    private val app = AppInfo("com.example.yaran", "foss", "1.0.0", PushTransport.UNIFIED_PUSH, null)
    private val subscription = Subscription(
        "https://ntfy.example.com/up/abc", "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg", "unifiedpush", "io.heckel.ntfy", VAPID,
    )

    private fun request(pushOff: Boolean = false) = RegisterRequest(
        "org-1", "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d", "Pixel", "en-GB",
        JSONObject().put("mute_all", false).put("muted_until", "2026-11-14T13:00:00Z").put("muted_machine_ids", JSONArray(listOf(MACHINE))),
        pushOff, VAPID,
    )

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        store = SubscriptionStore(context)
    }

    private fun assertMatchesSchema(body: JSONObject) {
        val (required, allowed) = Fixtures.schemaFields("devices.schema.json", "DeviceRegistration")
        val keys = body.keys().asSequence().toSet()
        assertTrue("missing ${required - keys}", keys.containsAll(required))
        assertTrue("extra ${keys - allowed}", allowed.containsAll(keys))
        assertTrue(Regex("B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]").matches(body.getString("device_key")))
        val push = body.getJSONObject("push")
        val pushDef = if (push.getString("kind") == "none") "PushNone" else "PushWebpush"
        val (pushRequired, pushAllowed) = Fixtures.schemaFields("devices.schema.json", pushDef)
        val pushKeys = push.keys().asSequence().toSet()
        assertTrue(pushKeys.containsAll(pushRequired) && pushAllowed.containsAll(pushKeys))
    }

    @Test
    fun registersWithTheSubscriptionAndTheDeviceKey() {
        val api = StubOrgApi()
        val outcome = DeviceRegistrar(api, FakeSource(SubscribeResult.Ok(subscription)), store, app, "phone").register(request())
        assertTrue(outcome is RegisterOutcome.Ok)
        val body = api.bodies.single()
        assertMatchesSchema(body)
        assertEquals(DEVICE_KEY, body.getString("device_key"))
        assertEquals("android", body.getString("platform"))
        assertEquals("foss", body.getString("flavor"))
        val push = body.getJSONObject("push")
        assertEquals("unifiedpush", push.getString("channel"))
        assertEquals("io.heckel.ntfy", push.getString("distributor"))
        assertEquals(subscription.endpoint, push.getString("endpoint"))
        assertEquals("2026-11-14T13:00:00Z", body.getString("muted_until"))
    }

    @Test
    fun pushOffSendsNoneWithTheSameDeviceKeyAndForgets() {
        val api = StubOrgApi()
        val source = FakeSource(SubscribeResult.Ok(subscription))
        store.save("org-1", subscription)
        DeviceRegistrar(api, source, store, app, "phone").register(request(pushOff = true))
        val body = api.bodies.single()
        assertMatchesSchema(body)
        assertEquals(JSONObject().put("kind", "none").toString(), body.getJSONObject("push").toString())
        assertEquals(DEVICE_KEY, body.getString("device_key"))
        assertEquals(listOf("org-1"), source.forgotten)
        assertNull(store.load("org-1"))
    }

    @Test
    fun deviceRevokedIsSurfacedAndForgetsTheSubscription() {
        val api = StubOrgApi(OrgApiResult.DeviceRevoked)
        val source = FakeSource(SubscribeResult.Ok(subscription))
        store.save("org-1", subscription)
        val outcome = DeviceRegistrar(api, source, store, app, "phone").register(request())
        assertEquals(RegisterOutcome.Api(OrgApiResult.DeviceRevoked), outcome)
        assertEquals("device_revoked", PushPlugin.outcomeJson(outcome).getString("outcome"))
        assertNull(store.load("org-1"))
    }

    @Test
    fun transportFailuresNeverReachTheWorker() {
        val api = StubOrgApi()
        assertEquals(RegisterOutcome.NoDistributor, DeviceRegistrar(api, FakeSource(SubscribeResult.NoDistributor), store, app, "phone").register(request()))
        val unavailable = DeviceRegistrar(api, FakeSource(SubscribeResult.Unavailable("no Play services")), store, app, "phone").register(request())
        assertEquals("push_unavailable", PushPlugin.outcomeJson(unavailable).getString("outcome"))
        assertTrue(api.bodies.isEmpty())
    }

    @Test
    fun outcomeJsonNeverCarriesKeyMaterial() {
        val device = JSONObject().put("push", JSONObject().put("kind", "webpush").put("endpoint_host", "ntfy.example.com"))
        val json = PushPlugin.outcomeJson(RegisterOutcome.Ok(device)).toString()
        assertFalse(json.contains("\"endpoint\"") || json.contains("p256dh") || json.contains("\"auth\""))
    }

    @Test
    fun localMutesFollowTheWorkersRule() {
        val mutes = LocalMutes.fromJson(JSONObject().put("mute_all", false).put("muted_until", "2024-11-14T08:01:00Z").put("muted_machine_ids", JSONArray(listOf(MACHINE))))
        assertTrue(mutes.isMuted("other", 1_731_571_200))
        assertFalse(mutes.isMuted("other", 1_731_571_260))
        assertTrue(mutes.isMuted(MACHINE, 1_731_571_260))
        val muteStore = MuteStore(context)
        muteStore.setMutes("o", mutes)
        assertEquals(mutes, MuteStore(context).mutes("o"))
        muteStore.forget("o")
        assertEquals(LocalMutes(), muteStore.mutes("o"))
    }

    @Test
    fun pendingQueueSurvivesProcessDeath() {
        PendingRegistrationStore(context).add("org-1")
        PendingRegistrationStore(context).add("org-2")
        // A new instance reads the committed file, as a restarted process would.
        val restarted = PendingRegistrationStore(context)
        assertEquals(setOf("org-1", "org-2"), restarted.drain())
        assertTrue(PendingRegistrationStore(context).orgIds().isEmpty())
    }

    @Test
    fun subscriptionStoreRoundTrip() {
        store.save("org-1", subscription.copy(relayKeyId = "k1", transportTag = "tag"))
        assertEquals(subscription.copy(relayKeyId = "k1", transportTag = "tag"), SubscriptionStore(context).load("org-1"))
        assertEquals("ntfy.example.com", store.load("org-1")?.endpointHost)
    }
}

/**
 * The presenter on Robolectric: tag = topic, replace and cancel, channel per kind, wording,
 * the immutable explicit `PendingIntent` and its extras, mutes, foreground suppression and the
 * generic text for a push the connector could not decrypt.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.NotificationPresenterTest
 * ├── io.github.siavz.yaran.push.MuteStore (inferred)
 * ├── io.github.siavz.yaran.push.NotificationActionActivity (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.PushPayloadParser (inferred)
 * ├── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * └── io.github.siavz.yaran.push.YaranPushService (inferred)
 * External: android.app, android.content, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.unifiedpush.android.connector.data
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/push/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.unifiedpush.android.connector.data.PushMessage
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class NotificationPresenterTest {
    private val m = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
    private lateinit var context: Context
    private lateinit var mutes: MuteStore
    private lateinit var presenter: NotificationPresenter
    private val manager get() = context.getSystemService(NotificationManager::class.java)

    private fun push(token: String = "needs_attention", tab: String? = null, label: String? = "fix the tests", project: String? = "yaran") =
        AgentPush(m, "agent-1", tab, token, project, label)

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        mutes = MuteStore(context)
        mutes.setDirectory("org-1", OrgDirectory("Acme", mapOf(m to "build-box")))
        presenter = NotificationPresenter(context, mutes) { 1_731_571_200 }
        presenter.ensureChannels()
    }

    @After
    fun tearDown() {
        NotificationPresenter.visibleAgent = null
    }

    @Test
    fun raisedIsTaggedByTopicAndWorded() {
        val n = presenter.compose("org-1", PushPayload.AttentionRaised(push(tab = "t2"), 1))!!
        assertEquals(pushTopic(m, "agent-1", "t2"), n.tag)
        assertEquals(NotificationPresenter.CHANNEL_ATTENTION, n.channel)
        assertEquals("fix the tests needs you", n.title)
        assertEquals("yaran · build-box", n.body)
        assertEquals("org-1/$m", n.group)
        assertEquals(mapOf("yaran.push.org" to "org-1", "yaran.push.machine" to m, "yaran.push.agent" to "agent-1", "yaran.push.kind" to "attention_raised", "yaran.push.tab" to "t2"), n.extras)
    }

    @Test
    fun exitsUseTheirChannelAndEveryEndingIsWorded() {
        val words = mapOf("launch_failed" to "failed to start", "exited" to "stopped with an error", "exited_unknown" to "stopped unexpectedly", "rapid_clean_exit" to "exited right after starting")
        for ((token, phrase) in words) {
            val n = presenter.compose("org-1", PushPayload.AgentExitedBadly(push(token), 1))!!
            assertEquals(NotificationPresenter.CHANNEL_EXITS, n.channel)
            assertEquals("fix the tests $phrase", n.title)
        }
        val anon = presenter.compose("org-1", PushPayload.AttentionRaised(push(label = null, project = null), 1))!!
        assertEquals("An agent needs you", anon.title)
        assertEquals("build-box", anon.body)
    }

    @Test
    fun unknownTokenAndUndecryptedShowTheGenericText() {
        assertEquals("An agent needs attention", presenter.compose("org-1", PushPayload.AttentionRaised(push("brand_new"), 1))!!.title)
        val generic = presenter.compose("org-1", null)!!
        assertEquals("generic/org-1", generic.tag)
        assertEquals("Open yaran to see which agent.", generic.body)
    }

    @Test
    fun repeatReplacesAndClearedCancels() {
        presenter.handle("org-1", PushPayload.AttentionRaised(push(), 1))
        presenter.handle("org-1", PushPayload.AttentionRaised(push(), 2))
        assertEquals(1, manager.activeNotifications.size)
        assertEquals(pushTopic(m, "agent-1", null), manager.activeNotifications[0].tag)
        presenter.handle("org-1", PushPayload.AttentionRaised(push().copy(agentId = "agent-2"), 3))
        assertEquals(2, manager.activeNotifications.size)
        presenter.handle("org-1", PushPayload.AttentionCleared(push("idle"), 4))
        assertEquals(listOf(pushTopic(m, "agent-2", null)), manager.activeNotifications.map { it.tag })
    }

    @Test
    fun contentIntentIsImmutableExplicitAndCarriesIds() {
        presenter.handle("org-1", PushPayload.AttentionRaised(push(tab = "t2"), 1))
        val notification = manager.activeNotifications.single().notification
        val pending: PendingIntent = notification.contentIntent
        val shadow = shadowOf(pending)
        assertTrue(shadow.isActivity)
        assertTrue(shadow.flags and PendingIntent.FLAG_IMMUTABLE != 0)
        val intent = shadow.savedIntent
        assertEquals(context.packageName, intent.`package`)
        assertEquals("open", intent.getStringExtra(NotificationPresenter.EXTRA_TAP_ACTION))
        assertEquals("t2", intent.getStringExtra(NotificationPresenter.EXTRA_TAB))
        assertNull(intent.data)
        val action = notification.actions.single()
        assertEquals("Mute this machine", action.title.toString())
        val actionShadow = shadowOf(action.actionIntent)
        assertTrue(actionShadow.flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertEquals(NotificationActionActivity::class.java.name, actionShadow.savedIntent.component?.className)
    }

    @Test
    fun mutedOrgsAndMachinesPostNothing() {
        for (local in listOf(LocalMutes(muteAll = true), LocalMutes(mutedUntil = 1_731_571_260), LocalMutes(mutedMachineIds = setOf(m)))) {
            mutes.setMutes("org-1", local)
            assertNull(presenter.compose("org-1", PushPayload.AttentionRaised(push(), 1)))
        }
        mutes.setMutes("org-1", LocalMutes(mutedUntil = 1_731_571_000))
        assertEquals("fix the tests needs you", presenter.compose("org-1", PushPayload.AttentionRaised(push(), 1))?.title)
    }

    @Test
    fun theTabOnScreenIsNotPosted() {
        NotificationPresenter.visibleAgent = VisibleAgent("org-1", m, "agent-1", "t2")
        assertNull(presenter.compose("org-1", PushPayload.AttentionRaised(push(tab = "t2"), 1)))
        assertEquals(pushTopic(m, "agent-1", null), presenter.compose("org-1", PushPayload.AttentionRaised(push(), 1))?.tag)
    }

    @Test
    fun cancelMatchingClearsAnAgentsTabs() {
        presenter.handle("org-1", PushPayload.AttentionRaised(push(tab = "t1"), 1))
        presenter.handle("org-1", PushPayload.AttentionRaised(push(tab = "t2"), 1))
        presenter.handle("org-2", PushPayload.AttentionRaised(push(tab = "t1"), 1))
        presenter.cancelMatching("org-1", m, "agent-1", null, anyTab = true)
        assertEquals(1, manager.activeNotifications.size)
        assertEquals("org-2", manager.activeNotifications[0].notification.extras.getString(NotificationPresenter.EXTRA_ORG))
    }

    @Test
    fun theServiceShowsOnlyGenericTextForAnUndecryptedPush() {
        SubscriptionStore(context).save("org-1", Subscription("https://ntfy.example.com/up/x", "p", "a", "unifiedpush", null, "v"))
        val service = Robolectric.buildService(YaranPushService::class.java).create().get()
        val raised = """{"v":1,"k":"attention_raised","m":"$m","a":"agent-1","s":"needs_attention","l":"secret","ts":1}"""
        service.onMessage(PushMessage(raised.toByteArray(), false), "org-1")
        val shown = manager.activeNotifications.single()
        assertEquals("generic/org-1", shown.tag)
        service.onMessage(PushMessage(raised.toByteArray(), true), "org-1")
        assertEquals(2, manager.activeNotifications.size)
        service.onMessage(PushMessage(raised.toByteArray(), true), "not-an-org")
        assertEquals(2, manager.activeNotifications.size)
    }
}

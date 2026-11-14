/**
 * Shows, replaces and removes yaran's notifications on Android.
 *
 * Words the decrypted payload (token to localized phrase, unknown token to the generic text),
 * posts it under tag = 02's `topic(m, a, t)` with one fixed id so a repeat replaces it and
 * `attention_cleared` cancels it, groups per machine, and attaches an explicit immutable
 * `PendingIntent` to the launcher plus the one "Mute this machine" action. It never posts for a
 * muted org or machine, or for the agent tab the shell reports on screen.
 *
 * - The org id travels in extras, never in the tag; extras carry ids only, never a host.
 * - A push the connector could not decrypt shows only the generic text and is never parsed.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.NotificationPresenter
 * ├── io.github.siavz.yaran.push.MuteStore (inferred)
 * ├── io.github.siavz.yaran.push.NotificationActionActivity (inferred)
 * └── io.github.siavz.yaran.push.PushPayloadParser (inferred)
 * External: android.app, android.content, android.os, androidx.core.app
 *
 * Used by:
 * io.github.siavz.yaran.push.NotificationPresenter
 * ├── io.github.siavz.yaran.push.NotificationActionActivity (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * └── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** The agent tab machine-view shows, as the shell reports it. */
data class VisibleAgent(val orgId: String, val machineId: String, val agentId: String, val tabId: String?)

/** What one post looks like; built purely so the tests pin it. */
data class PushNotification(
    val tag: String,
    val channel: String,
    val title: String,
    val body: String,
    val group: String?,
    val extras: Map<String, String>,
    val withMuteAction: Boolean,
)

class NotificationPresenter(
    private val context: Context,
    private val mutes: MuteStore = MuteStore(context),
    private val nowSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ATTENTION, context.getString(R.string.yaran_push_channel_attention), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_EXITS, context.getString(R.string.yaran_push_channel_exits), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    /** One push for `orgId`; `payload` null means it could not be decrypted or parsed. */
    fun handle(orgId: String, payload: PushPayload?) {
        if (payload is PushPayload.AttentionCleared) {
            val p = payload.push
            cancelMatching(orgId, p.machineId, p.agentId, p.tabId, anyTab = false)
            return
        }
        compose(orgId, payload)?.let(::post)
    }

    /** The notification a payload becomes, or null when nothing should show. */
    fun compose(orgId: String, payload: PushPayload?): PushNotification? {
        val agent = payload?.agent
        if (agent != null) {
            if (mutes.mutes(orgId).isMuted(agent.machineId, nowSeconds())) return null
            val visible = visibleAgent
            if (visible == VisibleAgent(orgId, agent.machineId, agent.agentId, agent.tabId)) return null
        }
        val directory = mutes.directory(orgId)
        return when (payload) {
            null -> generic(orgId)
            is PushPayload.Test -> PushNotification(
                tag = "test/$orgId", channel = CHANNEL_ATTENTION,
                title = context.getString(R.string.yaran_push_test_title, directory?.orgName?.let(::displayText)?.ifEmpty { null }
                    ?: context.getString(R.string.yaran_push_unknown_org)),
                body = context.getString(R.string.yaran_push_test_body),
                group = null, extras = mapOf(EXTRA_ORG to orgId, EXTRA_KIND to payload.kind), withMuteAction = false,
            )
            is PushPayload.AttentionCleared -> null
            is PushPayload.AttentionRaised, is PushPayload.AgentExitedBadly -> {
                val push = payload.agent ?: return null
                val title = title(payload, push) ?: return generic(orgId)
                val extras = buildMap {
                    put(EXTRA_ORG, orgId); put(EXTRA_MACHINE, push.machineId); put(EXTRA_AGENT, push.agentId)
                    put(EXTRA_KIND, payload.kind); push.tabId?.let { put(EXTRA_TAB, it) }
                }
                PushNotification(
                    tag = pushTopic(push.machineId, push.agentId, push.tabId),
                    channel = if (payload is PushPayload.AgentExitedBadly) CHANNEL_EXITS else CHANNEL_ATTENTION,
                    title = title, body = body(push, directory), group = "$orgId/${push.machineId}",
                    extras = extras, withMuteAction = true,
                )
            }
        }
    }

    private fun title(payload: PushPayload, push: AgentPush): String? {
        val (named, anonymous) = when (payload) {
            is PushPayload.AttentionRaised ->
                if (push.token == "needs_attention") R.string.yaran_push_needs_you to R.string.yaran_push_needs_you_anon else return null
            is PushPayload.AgentExitedBadly -> when (push.token) {
                "launch_failed" -> R.string.yaran_push_exit_launch_failed to R.string.yaran_push_exit_launch_failed_anon
                "exited" -> R.string.yaran_push_exit_error to R.string.yaran_push_exit_error_anon
                "exited_unknown" -> R.string.yaran_push_exit_unknown to R.string.yaran_push_exit_unknown_anon
                "rapid_clean_exit" -> R.string.yaran_push_exit_rapid to R.string.yaran_push_exit_rapid_anon
                else -> return null
            }
            is PushPayload.AttentionCleared, is PushPayload.Test -> return null
        }
        val label = push.label?.let(::displayText)?.ifEmpty { null }
        return if (label != null) context.getString(named, label) else context.getString(anonymous)
    }

    private fun body(push: AgentPush, directory: OrgDirectory?): String {
        val machine = directory?.machines?.get(push.machineId)?.let(::displayText)?.ifEmpty { null }
            ?: context.getString(R.string.yaran_push_unknown_machine)
        val project = push.project?.let(::displayText)?.ifEmpty { null } ?: return machine
        return context.getString(R.string.yaran_push_body_project_machine, project, machine)
    }

    private fun generic(orgId: String) = PushNotification(
        tag = "generic/$orgId", channel = CHANNEL_ATTENTION,
        title = context.getString(R.string.yaran_push_generic_title), body = context.getString(R.string.yaran_push_generic_body),
        group = null, extras = mapOf(EXTRA_ORG to orgId), withMuteAction = false,
    )

    /** "Notifications for <org> need a refresh": the endpoint changed while the app was closed. */
    fun postRefreshNeeded(orgId: String) {
        val org = mutes.directory(orgId)?.orgName?.let(::displayText)?.ifEmpty { null } ?: context.getString(R.string.yaran_push_unknown_org)
        post(
            PushNotification(
                tag = "refresh/$orgId", channel = CHANNEL_ATTENTION,
                title = context.getString(R.string.yaran_push_refresh_title, org), body = context.getString(R.string.yaran_push_refresh_body),
                group = null, extras = mapOf(EXTRA_ORG to orgId), withMuteAction = false,
            ),
        )
    }

    fun post(n: PushNotification) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val builder = NotificationCompat.Builder(context, n.channel)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(n.title)
            .setContentText(n.body)
            .setAutoCancel(true)
            .setContentIntent(launchIntent(n, ACTION_OPEN))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        n.group?.let(builder::setGroup)
        builder.addExtras(Bundle().apply { n.extras.forEach { (k, v) -> putString(k, v) } })
        if (n.withMuteAction) {
            builder.addAction(0, context.getString(R.string.yaran_push_action_mute_machine), muteIntent(n))
        }
        manager.notify(n.tag, NOTIFICATION_ID, builder.build())
    }

    /** Removes delivered notifications for an agent tab, an agent, or a whole machine. */
    fun cancelMatching(orgId: String, machineId: String, agentId: String?, tabId: String?, anyTab: Boolean) {
        for (active in manager.activeNotifications) {
            val e = active.notification.extras
            if (e.getString(EXTRA_ORG) != orgId || e.getString(EXTRA_MACHINE) != machineId) continue
            if (agentId != null && e.getString(EXTRA_AGENT) != agentId) continue
            if (!anyTab && e.getString(EXTRA_TAB) != tabId) continue
            manager.cancel(active.tag, active.id)
        }
        if (agentId != null && !anyTab) manager.cancel(pushTopic(machineId, agentId, tabId), NOTIFICATION_ID)
    }

    private fun launchIntent(n: PushNotification, action: String): PendingIntent {
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_TAP_ACTION, action)
        n.extras.forEach { (k, v) -> intent.putExtra(k, v) }
        return PendingIntent.getActivity(context, "$action/${n.tag}".hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun muteIntent(n: PushNotification): PendingIntent {
        val intent = Intent(context, NotificationActionActivity::class.java).putExtra(EXTRA_TAP_ACTION, ACTION_MUTE_MACHINE)
        n.extras.forEach { (k, v) -> intent.putExtra(k, v) }
        return PendingIntent.getActivity(context, "mute/${n.tag}".hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    companion object {
        const val CHANNEL_ATTENTION = "attention"
        const val CHANNEL_EXITS = "exits"
        const val NOTIFICATION_ID = 1
        const val EXTRA_ORG = "yaran.push.org"
        const val EXTRA_MACHINE = "yaran.push.machine"
        const val EXTRA_AGENT = "yaran.push.agent"
        const val EXTRA_TAB = "yaran.push.tab"
        const val EXTRA_KIND = "yaran.push.kind"
        const val EXTRA_TAP_ACTION = "yaran.push.action"
        const val ACTION_OPEN = "open"
        const val ACTION_MUTE_MACHINE = "mute_machine"

        /** Set by the plugin from the shell; read on the push service's thread. */
        @Volatile var visibleAgent: VisibleAgent? = null
    }
}

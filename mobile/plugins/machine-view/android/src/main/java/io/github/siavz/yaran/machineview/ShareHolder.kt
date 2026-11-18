/**
 * The files another app shared to yaran (G5), held in memory until a machine window takes them.
 *
 * The app's MainActivity hands every `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent to
 * [intake]. Only `content://` streams are kept, at most [MAX_FILES]; the rest are counted as
 * dropped and a share with no stream (text) is refused. JS hears a count and a state through
 * `shareReceived`, never a URI or a name, and only once the app is unlocked ([flush]). The
 * URIs are never persisted: process death, Discard or delivery forgets them. Nothing is opened
 * or uploaded here; the page's own file chooser receives them after a native confirm.
 *
 * - Thread-safe; main thread in practice.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.ShareHolder
 * └── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * External: android.content, android.net, android.os, java.util
 *
 * Used by:
 * io.github.siavz.yaran.machineview.ShareHolder
 * ├── io.github.siavz.yaran.app.MainActivity
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.ShareBatchRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.ShareChooser (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import java.util.UUID

sealed class ShareEvent {
    /** [batch] names the held share: a random UUID, minted per share, unrelated to its files. */
    data class Files(val count: Int, val dropped: Int, val batch: String) : ShareEvent()
    data class Refused(val reason: String) : ShareEvent()

    fun toJs(): Map<String, Any> = when (this) {
        is Files -> linkedMapOf("kind" to "files", "count" to count, "dropped" to dropped, "batch" to batch)
        is Refused -> linkedMapOf("kind" to "refused", "reason" to reason)
    }
}

object ShareHolder {
    const val MAX_FILES = 10
    private var uris: List<Uri> = emptyList()
    private var batch: String? = null
    private var waiting: ShareEvent? = null

    /** What a compare-and-take or compare-and-discard of a named share found. */
    sealed interface Claim {
        data class Taken(val uris: List<Uri>) : Claim

        /** Another share is held now; it was left exactly as it was. */
        data object Changed : Claim
        data object None : Claim
    }

    /** A batch id as JS hands it back: a UUID, the only shape this holder mints. */
    fun validBatch(id: String?): Boolean = id != null && BATCH.matches(id)

    private val BATCH = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** What a share intent carries: kept content URIs (in order, distinct) and how many were dropped. */
    internal fun select(streams: List<Uri?>): Pair<List<Uri>, Int> {
        val distinct = streams.filterNotNull().distinct()
        val content = distinct.filter { it.scheme == "content" }
        val kept = content.take(MAX_FILES)
        return kept to (distinct.size - kept.size)
    }

    /** Takes a share intent; false when [intent] is not one. The event waits for [flush]. */
    @Synchronized
    fun intake(intent: Intent?): Boolean {
        if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return false
        val (kept, dropped) = select(streams(intent))
        uris = kept
        batch = if (kept.isEmpty()) null else UUID.randomUUID().toString()
        waiting = batch?.let { ShareEvent.Files(kept.size, dropped, it) } ?: ShareEvent.Refused("no_files")
        return true
    }

    /** Emits the waiting event unless [locked]; it is retained by the bridge until JS listens. */
    @Synchronized
    fun flush(locked: Boolean) {
        val e = waiting ?: return
        if (locked) return
        if (MachineViewPlugin.emitShare(e)) waiting = null
    }

    @Synchronized
    fun count(): Int = uris.size

    /** The held share's count and batch; a null batch when none is held. */
    @Synchronized
    fun status(): Pair<Int, String?> = uris.size to batch

    /**
     * Takes the held files only if [named] is still the held share, in this one synchronized step,
     * so a share that arrived after the press it was named in is never taken in its place.
     */
    @Synchronized
    fun take(named: String): Claim {
        val held = batch ?: return Claim.None
        if (held != named) return Claim.Changed
        return Claim.Taken(uris).also {
            uris = emptyList()
            batch = null
        }
    }

    /**
     * Forgets the held share only if it is [named], with its event if that has not been told yet;
     * another held share, and its pending event, stay as they are.
     */
    @Synchronized
    fun discard(named: String): Claim {
        val held = batch ?: return Claim.None
        if (held != named) return Claim.Changed
        uris = emptyList()
        batch = null
        if ((waiting as? ShareEvent.Files)?.batch == named) waiting = null
        return Claim.Taken(emptyList())
    }

    /** Forgets everything held, unconditionally: native cleanup and tests only, never a JS command. */
    @Synchronized
    internal fun discard() {
        uris = emptyList()
        batch = null
        waiting = null
    }

    /** The event still waiting to be told, for tests. */
    @Synchronized
    internal fun waiting(): ShareEvent? = waiting

    @Suppress("DEPRECATION") // the typed getters are API 33+
    private fun streams(intent: Intent): List<Uri?> {
        val extra: List<Uri?> = when {
            intent.action == Intent.ACTION_SEND_MULTIPLE ->
                (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM)?.map { it as? Uri }).orEmpty()
            else -> listOf(
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri,
            )
        }
        val clip = intent.clipData?.let { c -> (0 until c.itemCount).map { c.getItemAt(it).uri } }.orEmpty()
        return extra + clip
    }
}

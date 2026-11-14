/**
 * Diagnostics: the local, sanitized log the user can preview and export from settings.
 *
 * Entries live in memory and are mirrored to one text file (production: `cacheDir/diag.log`)
 * so they survive a restart. The log is a ring: entries older than seven days and the oldest
 * entries beyond 1 MiB are dropped. Nothing leaves the phone unless the user exports it.
 *
 * - Every message passes [Sanitizer] before it is kept anywhere.
 * - One entry per line, `<UTC timestamp> <LEVEL> <message>`; continuation lines of a
 *   multi-line message are indented two spaces, so the file is also the export format.
 * - Thread-safe; an unreadable file starts an empty log rather than failing the app.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.Diagnostics
 * └── io.github.siavz.yaran.core.Sanitizer (inferred)
 * External: android.content, java.io, java.text, java.util
 *
 * Used by:
 * io.github.siavz.yaran.core.Diagnostics
 * ├── io.github.siavz.yaran.core.DiagnosticsTest (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdapters
 * ├── io.github.siavz.yaran.securestore.DiagnosticsPlugin
 * ├── io.github.siavz.yaran.securestore.Validation
 * └── io.github.siavz.yaran.securestore.ValidationTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.content.Context
import java.io.File
import java.io.IOException
import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class Diagnostics(
    private val file: File,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    enum class Level(
        val code: String,
    ) {
        INFO("info"),
        WARN("warn"),
        ERROR("error"),
        ;

        companion object {
            fun parse(code: String): Level? = entries.firstOrNull { it.code == code }
        }
    }

    private class Entry(
        val timeMs: Long,
        val text: String,
    ) {
        val bytes = text.encodeToByteArray().size + 1
    }

    private val entries = ArrayDeque<Entry>()
    private var totalBytes = 0L

    init {
        load()
    }

    /** Sanitizes and records one entry. */
    @Synchronized
    fun append(
        level: Level,
        message: String,
    ) {
        val now = clock()
        val clean = Sanitizer.sanitize(message).take(MAX_MESSAGE_CHARS)
        val text = "${format(now)} ${level.name} ${clean.replace("\n", "\n  ")}"
        val entry = Entry(now, text)
        entries.addLast(entry)
        totalBytes += entry.bytes
        if (prune(now)) rewrite() else appendToFile(entry)
    }

    /** The whole log as text, oldest first. */
    @Synchronized
    fun read(): String {
        if (prune(clock())) rewrite()
        return entries.joinToString("") { it.text + "\n" }
    }

    /** Drops expired and over-budget entries; true when anything was dropped. */
    private fun prune(now: Long): Boolean {
        var dropped = false
        while (entries.isNotEmpty() && (now - entries.first().timeMs > MAX_AGE_MS || totalBytes > MAX_BYTES)) {
            totalBytes -= entries.removeFirst().bytes
            dropped = true
        }
        return dropped
    }

    private fun load() {
        val lines =
            try {
                if (file.exists()) file.readLines() else emptyList()
            } catch (_: IOException) {
                emptyList()
            }
        val parser = dateFormat()
        var current: Pair<Long, StringBuilder>? = null

        fun flush() =
            current?.let { (time, text) ->
                Entry(time, text.toString()).also {
                    entries.addLast(it)
                    totalBytes += it.bytes
                }
            }
        for (line in lines) {
            val last = current
            if (line.startsWith("  ") && last != null) {
                last.second.append('\n').append(line)
                continue
            }
            flush()
            current =
                try {
                    parser.parse(line.substringBefore(' '))?.time?.let { it to StringBuilder(line) }
                } catch (_: ParseException) {
                    null
                }
        }
        flush()
        if (prune(clock())) rewrite()
    }

    private fun appendToFile(entry: Entry) {
        try {
            file.parentFile?.mkdirs()
            file.appendText(entry.text + "\n")
        } catch (_: IOException) {
            // The in-memory log still has the entry; the mirror catches up on the next rewrite.
        }
    }

    private fun rewrite() {
        try {
            file.parentFile?.mkdirs()
            file.writeText(entries.joinToString("") { it.text + "\n" })
        } catch (_: IOException) {
            // Same as above: memory stays authoritative for this run.
        }
    }

    private fun format(timeMs: Long): String = dateFormat().format(timeMs)

    companion object {
        const val MAX_BYTES = 1L shl 20
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        private const val MAX_MESSAGE_CHARS = 8192

        @Volatile private var instance: Diagnostics? = null

        fun shared(context: Context): Diagnostics =
            instance ?: synchronized(this) {
                instance ?: Diagnostics(File(context.cacheDir, "diag.log")).also { instance = it }
            }

        private fun dateFormat() =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
                isLenient = false
            }
    }
}

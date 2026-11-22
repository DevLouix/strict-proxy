package com.strictproxy.libbox_bridge

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * Recent engine output from this device, readable inside the app.
 *
 * The engine reports everything through [io.nekohasekai.libbox.PlatformInterface.writeDebugMessage],
 * which used to reach logcat and nothing else. That made the person holding the
 * phone the one person who could not see why a tunnel that says `connected`
 * carries no traffic: reading it needs a cable, a working `adb`, and developer
 * options. Diagnostics shows this instead, and it can be copied into a support
 * message from the phone.
 *
 * Both the buffer and the file are bounded. A session at `info` produces
 * thousands of lines, and a log that grows without limit is a storage bug on a
 * device with little to spare.
 */
internal object EngineLog {
    /** Lines kept in memory; the screen shows the tail of these. */
    private const val MAX_LINES = 500

    /** Size the on-disk copy is allowed to reach before it is rewritten. */
    private const val MAX_FILE_BYTES = 128 * 1024

    private const val FILE_NAME = "engine.log"

    private val lines = ArrayDeque<String>(MAX_LINES)
    private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    /** `null` until a [Context] has been seen; the memory buffer works regardless. */
    private var file: File? = null

    /**
     * Points the log at app-private storage and loads what the previous launch
     * wrote.
     *
     * Reading the old file matters most for the failure this exists to explain:
     * an engine abort takes the process down, so the lines that led to it are
     * gone from memory and only the file is left.
     */
    @Synchronized
    fun attach(context: Context) {
        if (file != null) return
        val target = File(context.filesDir, FILE_NAME)
        file = target
        runCatching {
            if (target.exists()) {
                target.readLines().takeLast(MAX_LINES).forEach { lines.addLast(it) }
            }
        }
    }

    /** Records one engine message, stamping each of its lines. */
    @Synchronized
    fun append(message: String) {
        val text = message.trim()
        if (text.isEmpty()) return
        val stamp = clock.format(Date())
        val added = text.lineSequence()
            .filter { it.isNotBlank() }
            .map { "$stamp ${it.trim()}" }
            .toList()
        if (added.isEmpty()) return
        for (entry in added) {
            while (lines.size >= MAX_LINES) lines.removeFirst()
            lines.addLast(entry)
        }
        val target = file ?: return
        runCatching {
            val bytes = added.sumOf { it.length + 1 }
            if (target.length() + bytes > MAX_FILE_BYTES) {
                // Rewrite the whole window instead of truncating a line at a
                // time: the file is a rolling record and every line that
                // survives is already in `lines`.
                target.writeText(lines.joinToString("\n", postfix = "\n"))
            } else {
                target.appendText(added.joinToString("\n", postfix = "\n"))
            }
        }
    }

    /** Everything currently held, oldest first. */
    @Synchronized
    fun snapshot(): String = lines.joinToString("\n")

    @Synchronized
    fun clear() {
        lines.clear()
        runCatching { file?.delete() }
    }
}

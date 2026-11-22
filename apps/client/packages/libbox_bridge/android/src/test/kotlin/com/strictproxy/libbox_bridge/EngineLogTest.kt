package com.strictproxy.libbox_bridge

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The buffer behind Diagnostics. Only the in-memory part is exercised here: a
 * `Context` is what turns on persistence, and the rules worth pinning down are
 * the timestamps and the cap.
 */
class EngineLogTest {
    @After
    fun tearDown() {
        EngineLog.clear()
    }

    @Test
    fun `every line of a multi-line engine message is recorded`() {
        // libbox hands over the formatted message, which can span lines.
        EngineLog.append("outbound connection to 1.1.1.1:443\ninbound connection from 10.0.0.2")

        val lines = EngineLog.snapshot().lines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].endsWith(" outbound connection to 1.1.1.1:443"))
        assertTrue(lines[1].endsWith(" inbound connection from 10.0.0.2"))
    }

    @Test
    fun `the buffer keeps only the newest lines`() {
        // A session at info level produces far more than the buffer holds; the
        // part worth reading is the end, where the failure is.
        repeat(600) { EngineLog.append("line $it") }

        val lines = EngineLog.snapshot().lines()
        assertEquals(500, lines.size)
        assertTrue(lines.first().endsWith(" line 100"))
        assertTrue(lines.last().endsWith(" line 599"))
    }

    @Test
    fun `a blank message records nothing`() {
        EngineLog.append("   \n  ")

        assertTrue(EngineLog.snapshot().isEmpty())
    }
}

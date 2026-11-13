package com.strictproxy.libbox_bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two rules that made "connect" fail silently and "disconnect" fail loudly.
 *
 * A plain JVM test, on purpose: these are decisions, not Android behaviour, and
 * CI can run them without an emulator.
 */
class ServiceLatchTest {
    @Test
    fun `an unanswered start is reported as refused`() {
        val latch = ServiceLatch()
        latch.startRequested()

        assertTrue(latch.ackExpired())
    }

    @Test
    fun `a refusal is reported once, not on every later deadline`() {
        val latch = ServiceLatch()
        latch.startRequested()
        assertTrue(latch.ackExpired())

        assertFalse(latch.ackExpired())
    }

    @Test
    fun `a start the service acknowledged is never reported as refused`() {
        val latch = ServiceLatch()
        latch.startRequested()
        latch.heard()

        assertFalse(latch.ackExpired())
    }

    @Test
    fun `an idle bridge reports no refusal`() {
        assertFalse(ServiceLatch().ackExpired())
    }

    @Test
    fun `stop is sent to a service that has spoken`() {
        val latch = ServiceLatch()
        latch.startRequested()
        latch.heard()

        assertTrue(latch.stopRequested())
    }

    @Test
    fun `stop is sent for a start that is still in flight`() {
        val latch = ServiceLatch()
        latch.startRequested()

        // Nothing has answered yet, but the service is being launched: leaving
        // it running would keep a tunnel up that nothing can close.
        assertTrue(latch.stopRequested())
    }

    @Test
    fun `stop is not sent to a service that was never started`() {
        // The regression: this used to return true, so every disconnect cold
        // started `:vpn` — the one thing Android refuses after an engine crash.
        assertFalse(ServiceLatch().stopRequested())
    }

    @Test
    fun `a failed start leaves nothing to stop`() {
        val latch = ServiceLatch()
        latch.startRequested()
        latch.startFailed()

        assertFalse(latch.stopRequested())
    }

    @Test
    fun `a second stop after the first still finds the spoken service`() {
        val latch = ServiceLatch()
        latch.startRequested()
        latch.heard()
        assertTrue(latch.stopRequested())

        // The service is still around until it finishes shutting down, and a
        // second stop request must not be swallowed into a no-op.
        assertTrue(latch.stopRequested())
    }
}

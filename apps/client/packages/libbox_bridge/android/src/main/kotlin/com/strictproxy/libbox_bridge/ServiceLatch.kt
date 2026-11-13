package com.strictproxy.libbox_bridge

/**
 * What the bridge remembers about its conversation with the `:vpn` process.
 *
 * Both rules encoded here exist because the two facts they use were previously
 * inferred wrongly:
 *
 * - A start that the system refused is indistinguishable from a slow start at
 *   the call site — `startForegroundService` returns a component either way —
 *   so "no first broadcast yet" is the only evidence that the process was never
 *   launched at all.
 * - Sending a stop intent to a service that is not running is not a no-op: it
 *   *starts* the process so it can receive the intent, which is exactly what
 *   Android has just marked bad. Disconnecting then failed for a reason that had
 *   nothing to do with the tunnel.
 *
 * Kept free of Android types on purpose: the rules are the part worth testing,
 * and a plain JVM test can run them in CI without an emulator or Robolectric.
 */
internal class ServiceLatch {
    /** True between a start request and the service's first broadcast. */
    var awaitingService = false
        private set

    /** True once this app process heard anything from the service. */
    var heardFromService = false
        private set

    /** A start was sent and the service has not answered yet. */
    fun startRequested() {
        awaitingService = true
    }

    /** The service spoke, which settles [awaitingService] for good. */
    fun heard() {
        awaitingService = false
        heardFromService = true
    }

    /**
     * True when the deadline passed with the start still unanswered, i.e. the
     * system never launched the process. Consumes the wait, so a late deadline
     * cannot report the same refusal twice.
     */
    fun ackExpired(): Boolean {
        if (!awaitingService) return false
        awaitingService = false
        return true
    }

    /**
     * True when there is a service worth telling to stop: one that has spoken,
     * or a start still in flight (it must be stopped too, or it would come up
     * with nothing left able to stop it).
     */
    fun stopRequested(): Boolean {
        val send = heardFromService || awaitingService
        awaitingService = false
        return send
    }

    /** The start threw: nothing was launched, so nothing is awaited. */
    fun startFailed() {
        awaitingService = false
    }
}

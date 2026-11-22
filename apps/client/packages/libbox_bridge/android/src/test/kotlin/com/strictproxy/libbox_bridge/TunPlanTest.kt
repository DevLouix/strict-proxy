package com.strictproxy.libbox_bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two tunnelling decisions that produced a tunnel nobody could use, plus the
 * DNS rule that used to abort the start outright.
 *
 * A plain JVM test on purpose: these are decisions, not Android behaviour, and
 * CI runs them without an emulator.
 */
class TunPlanTest {
    @Test
    fun `a scoped IPv6 DNS server loses its interface suffix`() {
        assertEquals(
            listOf("fe80::1", "1.1.1.1"),
            TunPlan.dnsServers(listOf("fe80::1%wlan0", " 1.1.1.1 ")),
        )
    }

    @Test
    fun `no usable DNS servers fall back to the hijacked-in-tunnel resolver`() {
        // An interface with no DNS server resolves nothing on the device, even
        // though the tunnel itself is up. The fallback addresses are delivered
        // into the tun and hijacked there.
        assertEquals(TunPlan.fallbackDnsServers, TunPlan.dnsServers(listOf("", "   ", "%wlan0")))
    }

    @Test
    fun `a custom fallback replaces the default one`() {
        assertEquals(listOf("9.9.9.9"), TunPlan.dnsServers(emptyList(), listOf("9.9.9.9")))
    }

    @Test
    fun `the engine MTU is capped to the phone path MTU`() {
        // sing-box defaults to 9000, which no phone radio can carry.
        assertEquals(1400, TunPlan.mtu(9000))
        assertEquals(1400, TunPlan.mtu(0))
        assertEquals(1350, TunPlan.mtu(1350))
        assertEquals(1280, TunPlan.mtu(1200))
    }

    @Test
    fun `vpn interfaces are ignored as default upstream updates`() {
        // libbox has no isVpn flag on updateDefaultInterface (the 4th arg is
        // isConstrained), so VPN interfaces must never be reported as upstream.
        assertEquals(null, TunPlan.defaultInterfaceUpdate("tun0", isVpn = true))
        assertEquals(
            TunPlan.DefaultInterface("wlan0", isConstrained = false),
            TunPlan.defaultInterfaceUpdate("wlan0", isVpn = false),
        )
        assertEquals(null, TunPlan.defaultInterfaceUpdate(null, isVpn = false))
        assertEquals(null, TunPlan.defaultInterfaceUpdate("   ", isVpn = false))
    }

    @Test
    fun `no advertised routes falls back to a default route`() {
        assertEquals(
            listOf(TunPlan.Prefix("0.0.0.0", 0)),
            TunPlan.routes(emptyList(), "0.0.0.0", hasAddress = true),
        )
    }

    @Test
    fun `an interface without an address in that family gets no default route`() {
        // An IPv6 default route over an interface with no IPv6 address is a
        // route to nowhere, and Android rejects the tun device for it.
        assertTrue(TunPlan.routes(emptyList(), "::", hasAddress = false).isEmpty())
    }

    @Test
    fun `advertised routes are kept exactly as the engine listed them`() {
        val advertised = listOf(TunPlan.Prefix("10.0.0.0", 8), TunPlan.Prefix("192.168.0.0", 16))

        assertEquals(advertised, TunPlan.routes(advertised, "0.0.0.0", hasAddress = true))
    }

    @Test
    fun `pre-API-33 routing prefers engine routeRanges over default fallback`() {
        val ranges = listOf(TunPlan.Prefix("1.0.0.0", 8), TunPlan.Prefix("11.0.0.0", 8))
        assertEquals(
            ranges,
            TunPlan.routesForPreApi33(ranges, emptyList(), "0.0.0.0", hasAddress = true),
        )
        assertEquals(
            listOf(TunPlan.Prefix("0.0.0.0", 0)),
            TunPlan.routesForPreApi33(emptyList(), emptyList(), "0.0.0.0", hasAddress = true),
        )
    }
}

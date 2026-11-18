package com.strictproxy.libbox_bridge

/**
 * What the engine asked for, turned into the values a `VpnService.Builder`
 * takes.
 *
 * Kept free of Android types so the rules can run as plain JVM tests: each one
 * came from a tunnel that came up dead. An empty route list with `auto_route`
 * left the interface without a route, a DNS server carrying a `%wlan0` scope
 * suffix is rejected by the engine's own address parser, a VPN interface with
 * no DNS server at all leaves every app on the phone unable to resolve, and an
 * interface MTU larger than the radio's path MTU stalls every TCP connection
 * while the tunnel still reports `connected`.
 */
internal object TunPlan {
    /** One address or route, as the engine reported it. */
    data class Prefix(val address: String, val prefix: Int)

    /**
     * Resolvers to put on the VPN interface when the engine reports none.
     *
     * Android resolves names through the DNS servers of the active network, and
     * this app's resolvers are DoH-over-the-proxy entries that carry no
     * interface address. Without a server here every lookup on the device fails
     * even though the tunnel is up. Queries sent to these addresses are routed
     * into the tun and hijacked by the config's `hijack-dns` rule, so the
     * addresses are only a delivery target, never the real resolver.
     */
    val fallbackDnsServers: List<String> = listOf("1.1.1.1", "1.0.0.1")

    /**
     * DNS servers to hand the builder.
     *
     * A scoped IPv6 server is trimmed to the bare address, because
     * `fe80::1%wlan0` is not an address Android accepts. Blanks are dropped:
     * they would become a server entry that never resolves. An empty result is
     * replaced by [fallback] rather than passed on as "no DNS".
     */
    fun dnsServers(
        servers: List<String>,
        fallback: List<String> = fallbackDnsServers,
    ): List<String> {
        val cleaned = servers
            .map { it.substringBefore('%').trim() }
            .filter { it.isNotEmpty() }
        return if (cleaned.isEmpty()) fallback else cleaned
    }

    /**
     * Routes to hand the builder when the engine asked for automatic routing.
     *
     * Falls back to a default route only when the engine listed none *and* the
     * tunnel has an address in that family — a default route over a family the
     * interface does not have is a route to nowhere.
     */
    fun routes(advertised: List<Prefix>, fallback: String?, hasAddress: Boolean): List<Prefix> {
        if (advertised.isNotEmpty()) return advertised
        if (!hasAddress || fallback == null) return emptyList()
        return listOf(Prefix(fallback, 0))
    }

    /** Largest MTU this app will put on a VPN interface. */
    const val maxMtu = 1400

    /** Smallest IPv6-capable MTU Android accepts without odd edge cases. */
    const val minMtu = 1280

    /**
     * Interface MTU to request from Android.
     *
     * sing-box defaults its TUN to 9000, which is larger than a phone's radio
     * path; path-MTU discovery cannot work from inside a VPN, so oversized
     * segments are dropped invisibly and every TCP connection (including DNS
     * over the tunnel) hangs. Clamping here covers configs that do not set an
     * MTU, not just the ones this app writes.
     */
    fun mtu(reported: Int): Int = when {
        reported <= 0 -> maxMtu
        reported > maxMtu -> maxMtu
        reported < minMtu -> minMtu
        else -> reported
    }
}

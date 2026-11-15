package com.strictproxy.libbox_bridge

/**
 * What the engine asked for, turned into the values a `VpnService.Builder`
 * takes.
 *
 * Kept free of Android types so the rules can run as plain JVM tests: each one
 * came from a tunnel that came up dead. An empty route list with `auto_route`
 * left the interface without a route, and a DNS server carrying a `%wlan0`
 * scope suffix is rejected by the engine's own address parser.
 */
internal object TunPlan {
    /** One address or route, as the engine reported it. */
    data class Prefix(val address: String, val prefix: Int)

    /**
     * DNS servers to hand the builder.
     *
     * A scoped IPv6 server is trimmed to the bare address, because
     * `fe80::1%wlan0` is not an address Android accepts. Blanks are dropped:
     * they would become a server entry that never resolves.
     */
    fun dnsServers(servers: List<String>): List<String> = servers
        .map { it.substringBefore('%').trim() }
        .filter { it.isNotEmpty() }

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
}

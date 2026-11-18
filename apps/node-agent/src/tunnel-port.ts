/**
 * Choosing the port the engine listens on.
 *
 * On a host install `install-node.sh` resolves this once. In a container the
 * agent gets whatever `NODE_TUNNEL_PORT` the deployment set — usually 443 — and
 * a VPS that already runs nginx on 443 leaves sing-box unable to bind. The
 * engine then dies, the node heartbeats as healthy, and clients connect into
 * nothing. A managed engine therefore resolves the port at startup the same
 * way the installer does.
 */

/** Preferred ports, in order. 443 first: it looks like ordinary HTTPS. */
export const PREFERRED_TUNNEL_PORTS = [443, 8443, 2053, 2083, 2087, 2096, 8880, 9443, 10443];

export interface TunnelPortChoice {
  /** The port to listen on. */
  port: number;
  /** True when the configured port was taken and a different one was picked. */
  changed: boolean;
  /** Why the port changed, or why none could be found. Null when all is well. */
  reason: string | null;
}

/**
 * Keeps [configured] when it is free, otherwise the first free preferred port.
 *
 * The order is deterministic, so a container restarted against the same host
 * settles on the same port instead of drifting every boot.
 */
export function chooseTunnelPort(
  configured: number,
  isListening: (port: number) => boolean,
  preferred: number[] = PREFERRED_TUNNEL_PORTS,
): TunnelPortChoice {
  if (!isListening(configured)) return { port: configured, changed: false, reason: null };
  for (const candidate of preferred) {
    if (candidate === configured || isListening(candidate)) continue;
    return {
      port: candidate,
      changed: true,
      reason: `port ${configured} is already in use; switched to ${candidate}`,
    };
  }
  return {
    port: configured,
    changed: false,
    reason: `port ${configured} is already in use and no preferred alternative is free`,
  };
}

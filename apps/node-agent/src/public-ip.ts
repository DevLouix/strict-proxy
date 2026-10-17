/**
 * Public-IP detection for the node agent.
 *
 * The fleet IP list that origins trust is built from what nodes report, so the
 * agent should advertise the address the outside world actually sees for it —
 * its provider-assigned egress address — not whatever happened to be baked into
 * its config at install time. Querying an echo service is what makes a node
 * whose provider re-addressed it heal itself on the next heartbeat.
 */
import { isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';
import type { AgentConfig } from './config.js';

/** What the fleet should advertise, or null when nothing usable is known. */
export async function detectPublicIp(cfg: AgentConfig): Promise<string | null> {
  if (!cfg.publicIpEchoUrl) return cfg.publicIp;

  try {
    const res = await fetch(cfg.publicIpEchoUrl, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'text/plain' },
    });
    if (!res.ok) return cfg.publicIp;

    const body = (await res.text()).trim();
    // ipify returns a bare address; some echo services return JSON or a line of
    // text, so take the first whitespace-delimited token and normalise it.
    const candidate = normalizeIpAddress(body.split(/\s+/)[0] ?? '');
    if (candidate && isPublicIpAddress(candidate)) return candidate;
    return cfg.publicIp;
  } catch {
    // Detection is best-effort: fall back to whatever the operator configured.
    return cfg.publicIp;
  }
}

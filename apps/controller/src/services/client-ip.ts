/**
 * Deriving a request's public source address.
 *
 * The Gatekeeper trusts the IP list built from `nodes.public_ip`, so a node's
 * address must never be taken from an untrusted header by accident. Express has
 * already applied the deployment's `trust proxy` setting (see
 * `TRUST_PROXY_HOPS`) by the time we read `req.ip`, so this only has to
 * normalise the value and refuse anything that cannot be a public address.
 */
import type { Request } from 'express';
import { isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';

/**
 * The requesting client's public IP, or null when it is absent or not a public
 * address (loopback, RFC 1918, link-local, CGNAT, ...).
 *
 * `req.ip` is preferred because it honours `trust proxy`; the socket address is
 * the fallback for requests that never went through Express's proxy handling.
 */
export function publicIpFromRequest(req: Request): string | null {
  for (const candidate of [req.ip, req.socket?.remoteAddress]) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeIpAddress(candidate);
    if (normalized && isPublicIpAddress(normalized)) return normalized;
  }
  return null;
}

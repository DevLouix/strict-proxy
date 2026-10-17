/**
 * IP-address normalisation and public-address classification.
 *
 * Shared by the controller and the node agent so both sides agree on what
 * counts as a "public" address. This matters because `nodes.public_ip` is
 * published in the Gatekeeper IP list that origins trust, and a private or
 * loopback address there is worse than useless: it silently allowlists an
 * address that only exists on the node's own network.
 */
import { isIP } from 'node:net';

/**
 * Normalises a raw address string, or returns null when it is not an IP.
 *
 * Accepts the shapes that reach us in practice: bare addresses, bracketed
 * IPv6 literals (`[2001:db8::1]`), bracketed literals with a port
 * (`[2001:db8::1]:443`), and IPv4-mapped IPv6 (`::ffff:203.0.113.9`).
 */
export function normalizeIpAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1]!.trim();

  // Express reports IPv4 peers as `::ffff:a.b.c.d` on a dual-stack socket.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1]!;

  return isIP(value) ? value : null;
}

function isPublicIpv4(ip: string): boolean {
  const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];

  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 IETF assignments
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a >= 224) return false; // multicast + reserved + broadcast

  // RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
  // are deliberately *allowed*: they are not private, and they are the
  // conventional addresses for tests and examples.
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return false; // unspecified / loopback
  if (/^f[cd]/.test(lower)) return false; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return false; // fe80::/10 link-local
  if (/^ff/.test(lower)) return false; // ff00::/8 multicast
  return true;
}

/**
 * True when `raw` is a globally routable unicast address (or a documentation
 * address, which is allowed for tests and examples).
 *
 * Deliberately returns false for private, loopback, link-local, CGNAT,
 * multicast and reserved ranges — none of which can ever be a node's public
 * address as seen by a client.
 */
export function isPublicIpAddress(raw: string): boolean {
  const ip = normalizeIpAddress(raw);
  if (!ip) return false;
  return isIP(ip) === 4 ? isPublicIpv4(ip) : isPublicIpv6(ip);
}

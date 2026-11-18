/**
 * Choosing the tunnel port when the configured one is already held.
 *
 * A node that keeps 443 while nginx owns it starts an engine that exits
 * immediately: the container looks healthy and clients connect into nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTunnelPort, PREFERRED_TUNNEL_PORTS } from '../../apps/node-agent/src/tunnel-port.js';

test('keeps the configured port when it is free', () => {
  assert.deepEqual(chooseTunnelPort(443, () => false), { port: 443, changed: false, reason: null });
});

test('falls back to the first free preferred port when the configured one is taken', () => {
  const taken = new Set([443, 8443]);
  const choice = chooseTunnelPort(443, (port) => taken.has(port));
  assert.equal(choice.port, 2053);
  assert.equal(choice.changed, true);
  assert.match(choice.reason ?? '', /443 is already in use/);
});

test('a fallback never picks a port that is also taken', () => {
  const taken = new Set(PREFERRED_TUNNEL_PORTS);
  const choice = chooseTunnelPort(443, (port) => taken.has(port));
  assert.equal(choice.port, 443, 'keeping the configured port beats a port known to be busy');
  assert.equal(choice.changed, false);
  assert.match(choice.reason ?? '', /no preferred alternative is free/);
});

test('a configured non-preferred port still falls back to the preferred list', () => {
  const choice = chooseTunnelPort(2443, (port) => port === 2443);
  assert.equal(choice.port, 443);
  assert.equal(choice.changed, true);
});

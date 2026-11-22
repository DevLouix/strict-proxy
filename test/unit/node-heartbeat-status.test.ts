/**
 * The heartbeat writes a node's status, and two different drains share the
 * `draining` value: an operator's (no expiry) and the agent's self-drain before
 * an engine restart (expires). Conflating them silently put manually drained
 * nodes back into rotation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusAfterHeartbeat } from '../../apps/controller/src/services/nodes.js';

const now = new Date('2026-11-22T12:00:00.000Z');

test("an operator's drain survives every heartbeat", () => {
  // No expiry: an admin set this deliberately and nothing should undo it.
  const result = statusAfterHeartbeat({ status: 'draining', autoDrainUntil: null }, 10, now);
  assert.deepEqual(result, { status: 'draining', clearAutoDrain: false });
  assert.deepEqual(
    statusAfterHeartbeat({ status: 'draining', autoDrainUntil: null }, 99, now),
    { status: 'draining', clearAutoDrain: false },
    'load does not override a deliberate drain either',
  );
});

test("an agent's active self-drain keeps the node out of rotation", () => {
  const until = new Date(now.getTime() + 60_000);
  assert.deepEqual(statusAfterHeartbeat({ status: 'draining', autoDrainUntil: until }, 5, now), {
    status: 'draining',
    clearAutoDrain: false,
  });
});

test("an expired self-drain returns the node to rotation and clears the marker", () => {
  const until = new Date(now.getTime() - 1_000);
  assert.deepEqual(statusAfterHeartbeat({ status: 'draining', autoDrainUntil: until }, 10, now), {
    status: 'online',
    clearAutoDrain: true,
  });
  assert.deepEqual(statusAfterHeartbeat({ status: 'draining', autoDrainUntil: until }, 95, now), {
    status: 'degraded',
    clearAutoDrain: true,
  });
});

test('a healthy node follows its load', () => {
  assert.deepEqual(statusAfterHeartbeat({ status: 'online', autoDrainUntil: null }, 40, now), {
    status: 'online',
    clearAutoDrain: false,
  });
  assert.deepEqual(statusAfterHeartbeat({ status: 'online', autoDrainUntil: null }, 91, now), {
    status: 'degraded',
    clearAutoDrain: false,
  });
});

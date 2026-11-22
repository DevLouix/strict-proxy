/**
 * How much of the engine's output an operator gets to keep.
 *
 * The engine logs every refused handshake from the internet's scanners. While
 * eviction was decided by line count, a burst pushed out the client's own
 * REALITY rejection within seconds — the one line the operator clicked Logs to
 * find.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAdminLines, EngineLogRing } from '../../apps/node-agent/src/logbuffer.js';

const line = (msg: string) => ({ at: new Date(0).toISOString(), level: 'warn', msg });

test('a scanner burst cannot evict a line that is still inside the window', () => {
  const ring = new EngineLogRing(60_000, 1000);
  const started = 1_000_000;
  ring.push(line('refused 203.0.113.7'), started);
  for (let i = 0; i < 500; i += 1) ring.push(line(`scanner ${i}`), started + 1);
  const tail = ring.tail(started + 2).map((entry) => entry.msg);
  assert.ok(tail.includes('refused 203.0.113.7'), 'the client line must survive the burst');
});

test('engine output is dropped once it is older than the retention window', () => {
  const ring = new EngineLogRing(60_000);
  ring.push(line('old'), 0);
  ring.push(line('new'), 61_000);
  assert.deepEqual(ring.tail(61_000).map((entry) => entry.msg), ['new']);
});

test('the hard cap bounds memory when a flood outruns the window', () => {
  const ring = new EngineLogRing(60_000, 10);
  for (let i = 0; i < 25; i += 1) ring.push(line(`line ${i}`), 1);
  const tail = ring.tail(2);
  assert.equal(tail.length, 10);
  assert.equal(tail[0].msg, 'line 15');
});

test('each source keeps its own budget, so engine noise cannot push out agent lines', () => {
  const out = composeAdminLines({
    recent: [line('applied 1 credential(s)'), line('could not post log lines: 401')],
    snapshot: [line('tunnel port 8443: listening')],
    engine: Array.from({ length: 500 }, (_, i) => line(`engine ${i}`)),
    tail: [line('journal line')],
  });
  assert.deepEqual(
    out.slice(0, 3).map((entry) => entry.msg),
    ['applied 1 credential(s)', 'could not post log lines: 401', 'tunnel port 8443: listening'],
  );
  assert.ok(out.some((entry) => entry.msg === 'journal line'), 'the journal tail must be included');
  assert.equal(out.filter((entry) => entry.msg.startsWith('engine ')).length, 180);
  assert.equal(out.at(-1)?.msg, 'journal line');
});

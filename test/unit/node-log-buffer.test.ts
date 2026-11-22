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
import { composeAdminLines, EngineLogRing, recentRefusedPeers } from '../../apps/node-agent/src/logbuffer.js';

const line = (msg: string, at = new Date(0).toISOString()) => ({ at, level: 'warn', msg });

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

test('refused peers are pinned by host, with retry ports folded into a count', () => {
  const peers = recentRefusedPeers([
    line('[sing-box] +0000 2026-11-22 04:01:09 INFO inbound/vless[vless-reality-in]: process connection from 45.33.83.23:40001: reality: processed invalid connection', '2026-11-22T04:01:09.000Z'),
    line('[sing-box] +0000 2026-11-22 04:01:11 INFO inbound/vless[vless-reality-in]: process connection from 45.33.83.23:40002: reality: processed invalid connection', '2026-11-22T04:01:11.000Z'),
    line('[sing-box] +0000 2026-11-22 04:01:12 INFO inbound/vless[vless-reality-in]: process connection from 138.197.113.179:5555: reality: processed invalid connection', '2026-11-22T04:01:12.000Z'),
  ]);
  assert.deepEqual(peers.map((p) => p.host), ['138.197.113.179', '45.33.83.23']);
  const retried = peers.find((p) => p.host === '45.33.83.23');
  assert.equal(retried?.attempts, 2);
  assert.equal(retried?.endpoint, '45.33.83.23:40002', 'the newest port is the one shown');
});

test('a successful connection is not pinned as refused', () => {
  const peers = recentRefusedPeers([
    line('[sing-box] +0000 2026-11-22 04:01:09 INFO inbound/vless[vless-reality-in]: process connection from 203.0.113.9:1234'),
    line('[sing-box] +0000 2026-11-22 04:01:09 INFO inbound/vless[vless-reality-in]: inbound connection to outbound'),
  ]);
  assert.deepEqual(peers, []);
});

test('pinned peers are bounded and IPv6 addresses stay readable', () => {
  const engine = Array.from({ length: 15 }, (_, i) =>
    line(`[sing-box] INFO inbound/vless[in]: process connection from [2001:db8::${i + 1}]:443: reality: processed invalid connection`),
  );
  const peers = recentRefusedPeers(engine);
  assert.equal(peers.length, 10);
  assert.match(peers[0].endpoint, /^\[2001:db8::\d+\]:443$/);
});

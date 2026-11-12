/**
 * The stats API is bound a moment after sing-box starts, so a first query
 * legitimately fails with gRPC UNAVAILABLE. The agent retries only that status:
 * retrying anything else would hide a real misconfiguration, and retrying after
 * a partial reset would lose counters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withStatsApiReady } from '../../apps/node-agent/src/usage.js';

function unavailable(): Error {
  return Object.assign(new Error('14 UNAVAILABLE: No connection established. Last error: connect ECONNREFUSED 127.0.0.1:10085'), { code: 14 });
}

test('withStatsApiReady returns the first successful result', async () => {
  assert.equal(await withStatsApiReady(async () => 'ok'), 'ok');
});

test('withStatsApiReady rides out UNAVAILABLE while the engine binds the port', async () => {
  let calls = 0;
  const value = await withStatsApiReady(async () => {
    calls += 1;
    if (calls < 3) throw unavailable();
    return 'ready';
  }, 5, 1);
  assert.equal(value, 'ready');
  assert.equal(calls, 3);
});

test('withStatsApiReady gives up after the attempt budget and keeps the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withStatsApiReady(async () => {
      calls += 1;
      throw unavailable();
    }, 3, 1),
    /UNAVAILABLE/,
  );
  assert.equal(calls, 3);
});

test('withStatsApiReady rethrows a non-UNAVAILABLE failure immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withStatsApiReady(async () => {
      calls += 1;
      throw Object.assign(new Error('2 UNKNOWN: no such file'), { code: 2 });
    }, 5, 1),
    /no such file/,
  );
  assert.equal(calls, 1);
});

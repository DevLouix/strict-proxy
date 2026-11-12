/**
 * Unit tests for the tier catalog, node load scoring and enrollment tokens.
 * These decide access limits, so an off-by-one here is a security-relevant bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierDefinition, isKnownTier, nextPeriodEnd, TIERS } from '../../apps/controller/src/services/tiers.js';
import { computeLoadScore, createNodeEnrollmentToken, hashNodeEnrollmentToken } from '../../apps/controller/src/services/nodes.js';
import { rankNodesForAssignment } from '../../apps/controller/src/services/config.js';
import { SUBSCRIPTION_TIERS } from '@strict-proxy/types';

test('node ranking prefers healthy nodes over degraded ones', () => {
  const ranked = rankNodesForAssignment([
    { id: 'a', loadScore: 0, status: 'degraded' },
    { id: 'b', loadScore: 90, status: 'online' },
  ]);
  assert.deepEqual(ranked.map((n) => n.id), ['b', 'a']);
});

test('node ranking prefers the least loaded node at equal status', () => {
  const ranked = rankNodesForAssignment([
    { id: 'a', loadScore: 90, status: 'online' },
    { id: 'b', loadScore: 10, status: 'online' },
    { id: 'c', loadScore: 50, status: 'online' },
  ]);
  assert.deepEqual(ranked.map((n) => n.id), ['b', 'c', 'a']);
});

test('health outranks load: a less loaded degraded node still loses', () => {
  const ranked = rankNodesForAssignment([
    { id: 'deg', loadScore: 0, status: 'degraded' },
    { id: 'ok', loadScore: 100, status: 'online' },
  ]);
  assert.deepEqual(ranked.map((n) => n.id), ['ok', 'deg']);
});

test('node ranking breaks exact ties deterministically by id', () => {
  const candidates = [
    { id: 'ccc', loadScore: 50, status: 'online' },
    { id: 'aaa', loadScore: 50, status: 'online' },
    { id: 'bbb', loadScore: 50, status: 'online' },
  ];
  const once = rankNodesForAssignment(candidates).map((n) => n.id);
  const again = rankNodesForAssignment([...candidates].reverse()).map((n) => n.id);
  assert.deepEqual(once, ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(once, again, 'input order must not change the outcome');
});

test('node ranking does not mutate its input', () => {
  const candidates = [
    { id: 'a', loadScore: 90, status: 'online' },
    { id: 'b', loadScore: 10, status: 'online' },
  ];
  rankNodesForAssignment(candidates);
  assert.deepEqual(candidates.map((n) => n.id), ['a', 'b'], 'input order must be preserved');
});

test('node ranking handles the empty and single-element cases', () => {
  assert.deepEqual(rankNodesForAssignment([]), []);
  const one = [{ id: 'a', loadScore: 0, status: 'online' }];
  assert.deepEqual(rankNodesForAssignment(one), one);
});

test('every declared tier resolves to a definition', () => {
  for (const tier of SUBSCRIPTION_TIERS) {
    assert.ok(isKnownTier(tier));
    assert.equal(tierDefinition(tier).tier, tier);
  }
});

test('unknown tiers are rejected and fall back to the most restrictive tier', () => {
  assert.ok(!isKnownTier('enterprise'));
  assert.ok(!isKnownTier(''));
  const fallback = tierDefinition('enterprise');
  assert.equal(fallback.tier, 'free');
  assert.equal(fallback.deviceSeats, TIERS.free.deviceSeats);
  assert.equal(fallback.maxNodes, TIERS.free.maxNodes);
});

test('access limits are monotonic across tiers', () => {
  assert.ok(TIERS.standard.deviceSeats > TIERS.free.deviceSeats);
  assert.ok(TIERS.pro.deviceSeats > TIERS.standard.deviceSeats);
  assert.ok(TIERS.standard.maxNodes > TIERS.free.maxNodes);
  assert.ok(TIERS.pro.maxNodes > TIERS.standard.maxNodes);
});

test('paid tiers are uncapped and the free row keeps a legacy quota', () => {
  assert.equal(typeof TIERS.free.bandwidthQuotaBytes, 'number');
  assert.ok((TIERS.free.bandwidthQuotaBytes ?? 0) > 0);
  assert.equal(TIERS.standard.bandwidthQuotaBytes, null);
  assert.equal(TIERS.pro.bandwidthQuotaBytes, null);
});

test('nextPeriodEnd is about 30 days out', () => {
  const delta = nextPeriodEnd().getTime() - Date.now();
  const thirtyDays = 30 * 24 * 3600 * 1000;
  assert.ok(Math.abs(delta - thirtyDays) < 60_000, `expected ~30 days, got ${delta}ms`);
});

test('computeLoadScore clamps to 0..100 and weights cpu over memory', () => {
  assert.equal(computeLoadScore(0, 0), 0);
  assert.equal(computeLoadScore(100, 100), 100);
  assert.equal(computeLoadScore(-50, -50), 0);
  assert.equal(computeLoadScore(1000, 1000), 100);
  // 60% cpu + 40% memory => cpu changes move the score more than memory changes do.
  const baseline = computeLoadScore(50, 50);
  assert.ok(computeLoadScore(60, 50) - baseline > computeLoadScore(50, 60) - baseline);
});

test('computeLoadScore returns an integer', () => {
  for (const [cpu, mem] of [[1, 1], [33.3, 66.7], [12.5, 87.25]]) {
    assert.equal(Number.isInteger(computeLoadScore(cpu, mem)), true);
  }
});

test('enrollment tokens are unique and stored only as a hash', () => {
  const a = createNodeEnrollmentToken();
  const b = createNodeEnrollmentToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, hashNodeEnrollmentToken(a.token));
  assert.ok(!a.token.includes(a.tokenHash));
});

test('enrollment token hashes are deterministic and collision-free across tokens', () => {
  const a = createNodeEnrollmentToken();
  const b = createNodeEnrollmentToken();
  assert.equal(hashNodeEnrollmentToken(a.token), a.tokenHash);
  assert.notEqual(hashNodeEnrollmentToken(a.token), hashNodeEnrollmentToken(b.token));
});
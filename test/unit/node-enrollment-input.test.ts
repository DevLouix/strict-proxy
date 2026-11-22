/**
 * Unit tests for enrollment payload validation.
 *
 * The agent supplies these fields and they are rendered straight into the
 * node's sing-box config, so a malformed value used to enroll successfully and
 * then produce a config the engine refuses to load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EnrollmentValidationError,
  validateEnrollmentInput,
} from '../../apps/controller/src/services/nodes.js';

const valid = {
  token: 'one-time-token',
  hostname: 'node-a.example.com',
  realityServerName: 'www.microsoft.com',
  realityShortIds: ['a1b2c3d4', 'e5f60718'],
  tunnelPort: 8443,
};

function rejects(patch: Record<string, unknown>, pattern: RegExp) {
  assert.throws(
    () => validateEnrollmentInput({ ...valid, ...patch }),
    (err: unknown) => err instanceof EnrollmentValidationError && pattern.test((err as Error).message),
  );
}

test('accepts a well-formed payload and defaults the tunnel port', () => {
  const input = validateEnrollmentInput({ ...valid, tunnelPort: undefined });
  assert.equal(input.tunnelPort, 443);
  assert.equal(input.hostname, 'node-a.example.com');
  assert.deepEqual(input.realityShortIds, ['a1b2c3d4', 'e5f60718']);
  assert.equal(input.label, null);
  assert.equal(input.engineVersion, 'unknown');
});

test('normalises short ids to lower case', () => {
  const input = validateEnrollmentInput({ ...valid, realityShortIds: ['A1B2C3D4'] });
  assert.deepEqual(input.realityShortIds, ['a1b2c3d4']);
});

test('refuses short ids sing-box cannot use', () => {
  // Not hex.
  rejects({ realityShortIds: ['zzzz'] }, /hex/);
  // Odd length: half a byte.
  rejects({ realityShortIds: ['abc'] }, /hex/);
  // Empty means "accept any short id", which disables that handshake check.
  rejects({ realityShortIds: [''] }, /hex/);
  // Longer than 8 bytes.
  rejects({ realityShortIds: ['a'.repeat(18)] }, /hex/);
  // A non-string would have been rendered as `undefined` in the config.
  rejects({ realityShortIds: [1234] }, /hex/);
});

test('refuses duplicate and missing short id lists', () => {
  rejects({ realityShortIds: ['a1b2', 'a1b2'] }, /unique/);
  rejects({ realityShortIds: [] }, /non-empty/);
  rejects({ realityShortIds: undefined }, /non-empty/);
  rejects({ realityShortIds: Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(2, '0')) }, /at most 16/);
});

test('refuses a tunnel port instead of coercing it to NaN', () => {
  rejects({ tunnelPort: 'not-a-port' }, /tunnelPort/);
  rejects({ tunnelPort: 0 }, /tunnelPort/);
  rejects({ tunnelPort: 70_000 }, /tunnelPort/);
  rejects({ tunnelPort: 443.5 }, /tunnelPort/);
});

test('refuses hostnames that are not names or addresses', () => {
  rejects({ hostname: '' }, /hostname/);
  rejects({ hostname: 'two words' }, /hostname/);
  rejects({ hostname: `${'a'.repeat(254)}` }, /hostname/);
  rejects({ realityServerName: '<script>' }, /realityServerName/);
});

test('caps the label so a display field cannot grow unbounded', () => {
  rejects({ label: 'x'.repeat(101) }, /label/);
  assert.equal(validateEnrollmentInput({ ...valid, label: '  Frankfurt 1  ' }).label, 'Frankfurt 1');
  assert.equal(validateEnrollmentInput({ ...valid, label: '   ' }).label, null);
});

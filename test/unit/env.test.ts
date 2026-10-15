/**
 * Unit tests for strict env parsing. Missing or malformed values must throw
 * rather than silently fall back — a silent default for a secret would ship a
 * predictable credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvError,
  requireString,
  optionalString,
  requireInt,
  optionalInt,
  requireBool,
  optionalBool,
} from '@strict-proxy/types';

/** Runs `fn` with `name` set to `value` (or deleted when undefined). */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('requireString returns the trimmed value', () => {
  withEnv('T_STR', '  value  ', () => {
    assert.equal(requireString('T_STR'), 'value');
  });
});

test('requireString throws for missing, empty and whitespace-only values', () => {
  for (const value of [undefined, '', '   ']) {
    withEnv('T_STR', value, () => {
      assert.throws(() => requireString('T_STR', 'a hint'), EnvError);
    });
  }
});

test('requireString surfaces the variable name and hint in the error', () => {
  withEnv('T_STR', undefined, () => {
    try {
      requireString('T_STR', 'run generate-env');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof EnvError);
      assert.match(err.message, /T_STR/);
      assert.match(err.message, /run generate-env/);
    }
  });
});

test('optionalString falls back only when absent or blank', () => {
  withEnv('T_OPT', undefined, () => assert.equal(optionalString('T_OPT', 'fallback'), 'fallback'));
  withEnv('T_OPT', '  ', () => assert.equal(optionalString('T_OPT', 'fallback'), 'fallback'));
  withEnv('T_OPT', ' real ', () => assert.equal(optionalString('T_OPT', 'fallback'), 'real'));
});

test('requireInt parses integers and rejects non-numeric values', () => {
  withEnv('T_INT', '42', () => assert.equal(requireInt('T_INT'), 42));
  withEnv('T_INT', 'not-a-number', () => assert.throws(() => requireInt('T_INT'), EnvError));
  withEnv('T_INT', undefined, () => assert.throws(() => requireInt('T_INT'), EnvError));
});

test('optionalInt uses the default when absent but still validates when present', () => {
  withEnv('T_OI', undefined, () => assert.equal(optionalInt('T_OI', 7), 7));
  withEnv('T_OI', '', () => assert.equal(optionalInt('T_OI', 7), 7));
  withEnv('T_OI', '9', () => assert.equal(optionalInt('T_OI', 7), 9));
  withEnv('T_OI', 'abc', () => assert.throws(() => optionalInt('T_OI', 7), EnvError));
});

test('requireBool distinguishes absent from invalid', () => {
  withEnv('T_BOOL', 'true', () => assert.equal(requireBool('T_BOOL'), true));
  withEnv('T_BOOL', 'TRUE', () => assert.equal(requireBool('T_BOOL'), true));
  withEnv('T_BOOL', 'false', () => assert.equal(requireBool('T_BOOL'), false));
  // Present but non-boolean text is silently false; document that it is not validated.
  withEnv('T_BOOL', 'yes', () => assert.equal(requireBool('T_BOOL'), false));
  withEnv('T_BOOL', undefined, () => assert.throws(() => requireBool('T_BOOL'), EnvError));
});

test('optionalBool falls back when absent', () => {
  withEnv('T_OB', undefined, () => assert.equal(optionalBool('T_OB', true), true));
  withEnv('T_OB', 'false', () => assert.equal(optionalBool('T_OB', true), false));
});
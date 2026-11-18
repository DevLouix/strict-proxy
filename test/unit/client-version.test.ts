import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clientMeetsMinimum,
  clientUpdateRequiredBody,
  parseClientBuild,
} from '../../apps/controller/src/services/client-version.js';

/// The gate is the difference between retiring a build and merely asking people
/// to update: a build below the minimum must not receive tunnel credentials.
void test('no minimum allows every build, including one that sends nothing', () => {
  assert.equal(clientMeetsMinimum(null, null), true);
  assert.equal(clientMeetsMinimum(12, null), true);
});

void test('a build older than the minimum is refused', () => {
  assert.equal(clientMeetsMinimum(66, 67), false);
});

void test('the minimum itself and anything newer is allowed', () => {
  assert.equal(clientMeetsMinimum(67, 67), true);
  assert.equal(clientMeetsMinimum(68, 67), true);
});

void test('a client that reports no build is treated as too old', () => {
  assert.equal(clientMeetsMinimum(null, 67), false);
});

void test('junk build headers parse as missing rather than as zero', () => {
  assert.equal(parseClientBuild('abc'), null);
  assert.equal(parseClientBuild('0'), null);
  assert.equal(parseClientBuild('-4'), null);
  assert.equal(parseClientBuild('1.2.3'), null);
  assert.equal(parseClientBuild(undefined), null);
  assert.equal(parseClientBuild(' 67 '), 67);
});

void test('the refusal body names the build the user needs', () => {
  const body = clientUpdateRequiredBody(67, 61);
  assert.equal(body.code, 'CLIENT_UPDATE_REQUIRED');
  assert.equal(body.minimumBuild, 67);
  assert.equal(body.currentBuild, 61);
  assert.match(body.error, /build 67 or newer/);
});

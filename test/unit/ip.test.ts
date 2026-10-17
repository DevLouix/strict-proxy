/**
 * Unit tests for the shared IP classification used on both sides of node
 * enrollment. `nodes.public_ip` feeds the Gatekeeper allowlist origins trust,
 * so accepting a private address here would silently allowlist something that
 * only exists on the node's own network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIpAddress, normalizeIpAddress } from '@strict-proxy/types';

test('normalizeIpAddress strips brackets, ports and IPv4-mapped prefixes', () => {
  assert.equal(normalizeIpAddress('203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIpAddress('  203.0.113.9  '), '203.0.113.9');
  assert.equal(normalizeIpAddress('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIpAddress('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeIpAddress('[2001:db8::1]:443'), '2001:db8::1');
});

test('normalizeIpAddress rejects things that are not addresses', () => {
  assert.equal(normalizeIpAddress(''), null);
  assert.equal(normalizeIpAddress('not-an-ip'), null);
  assert.equal(normalizeIpAddress('203.0.113.999'), null);
  assert.equal(normalizeIpAddress('203.0.113.9:443'), null);
});

test('public addresses are accepted', () => {
  assert.equal(isPublicIpAddress('203.0.113.9'), true);
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('private, loopback, link-local and CGNAT addresses are rejected', () => {
  for (const ip of [
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(isPublicIpAddress(ip), false, `${ip} must not be treated as public`);
  }
});

test('a private address is rejected even when IPv4-mapped', () => {
  assert.equal(isPublicIpAddress('::ffff:10.0.0.5'), false);
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false);
});

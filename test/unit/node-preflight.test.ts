/**
 * The self-check that runs before the node agent starts, and the /proc parser
 * behind the heartbeat's "is the tunnel port actually listening?" answer. A
 * node that heartbeats while its port is held by nginx is exactly the failure
 * these guard against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeAccess, formatChecks, listeningPorts } from '../../apps/node-agent/src/preflight.js';

// Header + one established socket (not listening) + 443 and 0x20FB (8443) listening.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1
   1: 0100007F:9C40 0100007F:0035 01 00000000:00000000 00:00000000 00000000     0        0 2
   2: 00000000:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3`;

const TCP6 = `  sl  local_address rem_address   st
   0: 00000000000000000000000000000000:20FB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4`;

test('listening ports are read from both address families, established sockets ignored', () => {
  assert.deepEqual([...listeningPorts(TCP, TCP6)].sort((a, b) => a - b), [53, 443, 8443]);
});

test('a missing or empty proc table yields no ports', () => {
  assert.equal(listeningPorts('', '').size, 0);
});

test('a usable node passes the self-check', () => {
  const checks = checkNodeAccess({ singBoxBinaryPath: '/usr/local/bin/sing-box', tunnelPort: 443 }, () => true);
  assert.deepEqual(checks.map((c) => c.ok), [true, true]);
});

test('a missing engine binary fails with the fix in the message', () => {
  const checks = checkNodeAccess({ singBoxBinaryPath: '/opt/sing-box', tunnelPort: 443 }, () => false);
  const binary = checks.find((c) => c.name === 'sing-box binary');
  assert.equal(binary?.ok, false);
  assert.match(binary?.detail ?? '', /install sing-box or set SING_BOX_BINARY/);
  assert.match(formatChecks(checks), /^FAIL sing-box binary/m);
});

test('an impossible tunnel port is rejected', () => {
  const checks = checkNodeAccess({ singBoxBinaryPath: '/bin/true', tunnelPort: 70000 }, () => true);
  assert.equal(checks.find((c) => c.name === 'tunnel port')?.ok, false);
});

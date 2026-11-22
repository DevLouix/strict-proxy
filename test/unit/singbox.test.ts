/**
 * Unit tests for the node agent's sing-box config renderer. A malformed render
 * would be written to disk and restart the tunnel, so the shape is asserted
 * structurally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderSingBoxConfig,
  liveCredentials,
  needsApply,
  writeConfigAtomic,
  writeConfigIfValid,
  loadAppliedFingerprint,
  saveAppliedFingerprint,
} from '../../apps/node-agent/src/singbox.js';
import type { AgentConfig } from '../../apps/node-agent/src/config.js';

const cfg = {
  tunnelPort: 443,
  statsApiListen: '127.0.0.1:10086',
} as AgentConfig;

const baseParams = {
  cfg,
  realityPrivateKey: 'priv-key',
  shortIds: ['aa', 'bb'],
  serverName: 'www.microsoft.com',
};

test('liveCredentials drops revoked entries and maps the expected fields', () => {
  const live = liveCredentials([
    { uuid: 'u1', shortId: 'aa', userEmail: 'a@example.test', expiresAt: null, revoked: false },
    { uuid: 'u2', shortId: 'bb', userEmail: 'b@example.test', expiresAt: null, revoked: true },
  ]);
  assert.deepEqual(live, [{ uuid: 'u1', shortId: 'aa', email: 'a@example.test' }]);
});

test('renderSingBoxConfig emits a VLESS + REALITY inbound with the configured port', () => {
  const rendered = renderSingBoxConfig({
    ...baseParams,
    users: [{ uuid: 'u1', shortId: 'aa', email: 'a@example.test' }],
  }) as any;

  assert.equal(rendered.inbounds.length, 1);
  const inbound = rendered.inbounds[0];
  assert.equal(inbound.type, 'vless');
  assert.equal(inbound.tag, 'vless-reality-in');
  assert.equal(inbound.listen_port, 443);
  assert.equal(inbound.tls.reality.enabled, true);
  assert.equal(inbound.tls.reality.private_key, 'priv-key');
  assert.deepEqual(inbound.tls.reality.short_id, ['aa', 'bb']);
  assert.equal(inbound.tls.reality.handshake.server, 'www.microsoft.com');
  assert.deepEqual(inbound.users, [{ name: 'a@example.test', uuid: 'u1', flow: 'xtls-rprx-vision' }]);
});

test('renderSingBoxConfig enables the V2Ray stats API for exactly the live users', () => {
  const rendered = renderSingBoxConfig({
    ...baseParams,
    users: [
      { uuid: 'u1', shortId: 'aa', email: 'a@example.test' },
      { uuid: 'u2', shortId: 'bb', email: 'b@example.test' },
    ],
  }) as any;

  assert.equal(rendered.experimental.v2ray_api.stats.enabled, true);
  assert.deepEqual(rendered.experimental.v2ray_api.stats.users, ['a@example.test', 'b@example.test']);
  assert.equal(rendered.experimental.v2ray_api.listen, '127.0.0.1:10086');
});

test('renderSingBoxConfig stays valid with zero users (all revoked)', () => {
  const rendered = renderSingBoxConfig({ ...baseParams, users: [] }) as any;
  assert.deepEqual(rendered.inbounds[0].users, []);
  assert.deepEqual(rendered.experimental.v2ray_api.stats.users, []);
});

test('the rendered log level follows the agent LOG_LEVEL', () => {
  // sing-box at `warn` says nothing about a connection that succeeded, so a node
  // log could not tell "the phone never reached us" from "the phone connected
  // and the traffic died behind us". The agent reads LOG_LEVEL (default `info`)
  // and the renderer used to ignore it, pinning sing-box to `warn`.
  const atInfo = renderSingBoxConfig({
    ...baseParams,
    cfg: { ...cfg, logLevel: 'info' },
    users: [],
  }) as any;
  assert.equal(atInfo.log.level, 'info');

  const atWarn = renderSingBoxConfig({
    ...baseParams,
    cfg: { ...cfg, logLevel: 'warn' },
    users: [],
  }) as any;
  assert.equal(atWarn.log.level, 'warn');

  // A config object without the field keeps the quiet default rather than
  // writing `undefined` into the sing-box config.
  const unset = renderSingBoxConfig({ ...baseParams, users: [] }) as any;
  assert.equal(unset.log.level, 'warn');
});

test('renderSingBoxConfig is deterministic for the same input', () => {
  const users = [{ uuid: 'u1', shortId: 'aa', email: 'a@example.test' }];
  assert.equal(JSON.stringify(renderSingBoxConfig({ ...baseParams, users })), JSON.stringify(renderSingBoxConfig({ ...baseParams, users })));
});

test('needsApply is true when the file is absent or differs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singbox-test-'));
  const target = path.join(dir, 'config.json');
  assert.equal(await needsApply(target, '{"a":1}'), true);
  await writeConfigAtomic(target, '{"a":1}');
  assert.equal(await needsApply(target, '{"a":1}'), false);
  assert.equal(await needsApply(target, '{"a":2}'), true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeConfigAtomic leaves no temp file behind and round-trips the fingerprint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singbox-test-'));
  const statePath = path.join(dir, 'nested', 'config.json.state');

  assert.equal(await loadAppliedFingerprint(statePath), null);
  await saveAppliedFingerprint(statePath, 'fp-1');
  assert.equal(await loadAppliedFingerprint(statePath), 'fp-1');

  const leftovers = (await fs.readdir(path.join(dir, 'nested'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await fs.rm(dir, { recursive: true, force: true });
});
test('a credential past its expiry is not rendered as a live user', () => {
  // `expiresAt` was carried end to end and never read, so an expired credential
  // stayed in the engine's user list. An unparseable date is treated as expired:
  // a credential whose validity cannot be established must not be accepted.
  const base = { shortId: 'aa', userEmail: 'a@example.test', revoked: false };
  const rows = [
    { ...base, uuid: 'past', expiresAt: new Date(Date.now() - 1_000).toISOString() },
    { ...base, uuid: 'future', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { ...base, uuid: 'never', expiresAt: null },
    { ...base, uuid: 'garbage', expiresAt: 'not-a-date' },
  ];
  assert.deepEqual(liveCredentials(rows).map((u) => u.uuid), ['future', 'never']);
});

test('writeConfigIfValid keeps the applied config when the candidate is rejected', async () => {
  // Write-then-validate left a rejected config on disk: the running engine kept
  // the old one, and the next sync saw the file already matching the render, so
  // it saved the fingerprint and reported an applied state it was not running.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singbox-test-'));
  const target = path.join(dir, 'config.json');
  await writeConfigAtomic(target, '{"old":true}');

  const accepted = await writeConfigIfValid(target, '{"broken":true}', async () => false);
  assert.equal(accepted, false);
  assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}', 'the applied config is untouched');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['config.json'], 'no candidate file is left behind');

  await fs.rm(dir, { recursive: true, force: true });
});

test('writeConfigIfValid treats a throwing validator as a refusal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singbox-test-'));
  const target = path.join(dir, 'config.json');
  await writeConfigAtomic(target, '{"old":true}');

  const accepted = await writeConfigIfValid(target, '{"broken":true}', async () => {
    throw new Error('validator crashed');
  });
  assert.equal(accepted, false);
  assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}');

  await fs.rm(dir, { recursive: true, force: true });
});

test('writeConfigIfValid replaces the config only after the candidate passes validation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singbox-test-'));
  const target = path.join(dir, 'config.json');
  await writeConfigAtomic(target, '{"old":true}');

  let seen = '';
  const accepted = await writeConfigIfValid(target, '{"new":true}', async (candidate) => {
    // The validator has to see the candidate, not the config that is live.
    seen = await fs.readFile(candidate, 'utf8');
    assert.ok(candidate.endsWith('.next'));
    return true;
  });

  assert.equal(accepted, true);
  assert.equal(seen, '{"new":true}');
  assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['config.json']);

  await fs.rm(dir, { recursive: true, force: true });
});

test('the rendered user list does not depend on the order rows arrive in', () => {
  // The controller's sync query had no ORDER BY and usage reporting rewrites the
  // credential rows every minute, so a user set that had not changed arrived in
  // a different order. The render differed, the agent restarted sing-box, and
  // every live tunnel connection died with it.
  const a = { uuid: '00000000-0000-4000-8000-00000000000a', shortId: 'aaaaaaaa', userEmail: 'a@example.com', expiresAt: null, revoked: false };
  const b = { uuid: '00000000-0000-4000-8000-00000000000b', shortId: 'bbbbbbbb', userEmail: 'b@example.com', expiresAt: null, revoked: false };

  assert.deepEqual(liveCredentials([b, a]), liveCredentials([a, b]));
  assert.deepEqual(liveCredentials([b, a]).map((u) => u.uuid), [a.uuid, b.uuid]);
});

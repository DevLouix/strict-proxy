/**
 * The in-app update feed.
 *
 * The app updates itself from the controller, so these routes are what a phone
 * hits to decide whether a newer build exists and to download it. They are
 * unauthenticated by design (an APK is public, and Android only accepts it when
 * signed with the release key), and they must answer 404 rather than half-serve
 * a release when the operator has not configured one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { buildAppReleaseRouter, type AppReleaseConfig } from '../../apps/controller/src/routes/app-release.js';

const APK_BYTES = Buffer.from('PK\u0003\u0004 not a real apk, but the bytes must round-trip');

async function start(cfg: AppReleaseConfig) {
  const app = express();
  app.use(buildAppReleaseRouter({ cfg }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function config(overrides: Partial<AppReleaseConfig> = {}): AppReleaseConfig {
  return {
    clientAndroidVersion: '',
    clientAndroidBuildNumber: 0,
    clientAndroidApkPath: '',
    clientAndroidNotes: '',
    ...overrides,
  };
}

test('no configured release answers 404 for both routes', async () => {
  const s = await start(config());
  try {
    assert.equal((await fetch(`${s.base}/api/v1/app/android`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/v1/app/android/download`)).status, 404);
  } finally {
    await s.close();
  }
});

test('a published build reports its version, size and download path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'client-apk-'));
  const apk = path.join(dir, 'client.apk');
  await writeFile(apk, APK_BYTES);

  const s = await start(
    config({
      clientAndroidVersion: '0.2.0',
      clientAndroidBuildNumber: 7,
      clientAndroidApkPath: apk,
      clientAndroidNotes: 'Faster connect',
    }),
  );
  try {
    const res = await fetch(`${s.base}/api/v1/app/android`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      version: '0.2.0',
      buildNumber: 7,
      sizeBytes: APK_BYTES.length,
      notes: 'Faster connect',
      url: '/api/v1/app/android/download',
      // An environment-configured APK is the single-APK fallback, so it is
      // described as universal and needs no checksum (it was never uploaded).
      artifacts: [
        {
          abi: 'universal',
          sizeBytes: APK_BYTES.length,
          sha256: '',
          url: '/api/v1/app/android/download?abi=universal',
        },
      ],
    });

    const download = await fetch(`${s.base}/api/v1/app/android/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type') ?? '', /android\.package-archive/);
    assert.match(download.headers.get('content-disposition') ?? '', /strict-proxy-7-universal\.apk/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), APK_BYTES);
  } finally {
    await s.close();
  }
});

test('feed status reports the published build, or 503 when none is published', async () => {
  const empty = await start(config());
  try {
    const res = await fetch(`${empty.base}/api/v1/app/android/status`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ok: boolean; published: boolean; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.published, false);
    assert.equal(body.code, 'CLIENT_RELEASE_UNAVAILABLE');
  } finally {
    await empty.close();
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'client-apk-status-'));
  const apk = path.join(dir, 'client.apk');
  await writeFile(apk, APK_BYTES);
  const s = await start(
    config({
      clientAndroidVersion: '0.3.0',
      clientAndroidBuildNumber: 12,
      clientAndroidApkPath: apk,
    }),
  );
  try {
    const res = await fetch(`${s.base}/api/v1/app/android/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.published, true);
    assert.equal(body.version, '0.3.0');
    assert.equal(body.buildNumber, 12);
    assert.deepEqual(body.abis, ['universal']);
  } finally {
    await s.close();
  }
});

test('a build whose APK is gone is reported as unavailable, not served', async () => {
  const s = await start(
    config({
      clientAndroidVersion: '0.2.0',
      clientAndroidBuildNumber: 7,
      clientAndroidApkPath: path.join(tmpdir(), 'missing-client.apk'),
    }),
  );
  try {
    assert.equal((await fetch(`${s.base}/api/v1/app/android`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/v1/app/android/download`)).status, 404);
  } finally {
    await s.close();
  }
});

/**
 * Client distribution from the dashboard.
 *
 * These routes are how an operator publishes a build and how the app finds it.
 * They matter beyond their happy path: an unpublished draft must never be
 * served, an ABI that was not built must be refused rather than silently
 * substituted, and a crash report must not be able to fill the table.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarness, type Harness } from '../helpers/harness.js';

const APK = (label: string) => `PK\u0003\u0004${label}`;

let h: Harness;
let storage: string;

before(async () => {
  storage = await mkdtemp(path.join(tmpdir(), 'client-apps-'));
  h = await createHarness({ clientAndroidStorageDir: storage });
});

after(async () => {
  await h.stop();
  await rm(storage, { recursive: true, force: true });
});

beforeEach(async () => {
  await h.resetDb();
});

async function upload(
  token: string,
  buildNumber: number,
  abi: string,
  bytes: string,
  version = '0.2.0',
): Promise<{ status: number; body: any }> {
  return h.request(
    'PUT',
    `/api/v1/admin/client-apps/android/releases/${buildNumber}/artifacts?version=${encodeURIComponent(version)}&abi=${abi}&notes=faster%20connect`,
    {
      token,
      rawBody: bytes,
      headers: { 'content-type': 'application/vnd.android.package-archive' },
    },
  );
}

test('a build stays a draft until an administrator publishes it', async () => {
  const admin = await h.adminToken();

  const created = await upload(admin, 7, 'arm64-v8a', APK('arm'));
  assert.equal(created.status, 201);
  assert.equal(created.body.release.status, 'draft');
  assert.equal(created.body.artifact.abi, 'arm64-v8a');
  assert.match(created.body.artifact.sha256, /^[0-9a-f]{64}$/);

  // Uploading is not releasing: clients must not see it yet.
  const beforePublish = await h.request('GET', '/api/v1/app/android');
  assert.equal(beforePublish.status, 404);

  const list = await h.request('GET', '/api/v1/admin/client-apps/android/releases', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.releases.length, 1);
  assert.equal(list.body.releases[0].status, 'draft');
  assert.equal(list.body.activeBuildNumber, null);

  const published = await h.request('POST', '/api/v1/admin/client-apps/android/releases/7/status', {
    token: admin,
    body: { status: 'published' },
  });
  assert.equal(published.status, 200);

  const feed = await h.request('GET', '/api/v1/app/android');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.buildNumber, 7);
  assert.equal(feed.body.version, '0.2.0');
  assert.equal(feed.body.notes, 'faster connect');
  assert.deepEqual(
    feed.body.artifacts.map((artifact: { abi: string }) => artifact.abi),
    ['arm64-v8a'],
  );
});

test('the download serves the APK built for the requested ABI', async () => {
  const admin = await h.adminToken();
  const arm64 = APK('arm64-build');
  const armv7 = APK('armv7-build');
  await upload(admin, 8, 'arm64-v8a', arm64);
  await upload(admin, 8, 'armeabi-v7a', armv7);
  await h.request('POST', '/api/v1/admin/client-apps/android/releases/8/status', {
    token: admin,
    body: { status: 'published' },
  });

  const wanted = await fetch(`${h.baseUrl}/api/v1/app/android/download?abi=armeabi-v7a`);
  assert.equal(wanted.status, 200);
  assert.match(wanted.headers.get('content-type') ?? '', /android\.package-archive/);
  assert.equal(await wanted.text(), armv7);

  const arm = await fetch(`${h.baseUrl}/api/v1/app/android/download?abi=arm64-v8a`);
  assert.equal(arm.status, 200);
  assert.equal(await arm.text(), arm64);

  // An ABI this build never included must fail loudly, not hand the phone an
  // APK its CPU cannot load.
  const unsupported = await h.request('GET', '/api/v1/app/android/download?abi=x86_64');
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.body.code, 'CLIENT_ABI_UNAVAILABLE');
});

test('a universal APK is offered to every ABI', async () => {
  const admin = await h.adminToken();
  await upload(admin, 9, 'universal', APK('universal'));
  await h.request('POST', '/api/v1/admin/client-apps/android/releases/9/status', {
    token: admin,
    body: { status: 'published' },
  });

  const res = await h.request('GET', '/api/v1/app/android/download?abi=arm64-v8a');
  assert.equal(res.status, 200);
  assert.equal(String(res.body), APK('universal'));
});

test('only an administrator can upload or publish', async () => {
  const user = await h.seedUser('client-apps-user@example.test');
  const tokens = await h.login(user.email, user.password, 'device-client-apps');

  assert.equal((await h.request('GET', '/api/v1/admin/client-apps/android/releases')).status, 401);
  assert.equal(
    (await upload(tokens.accessToken, 10, 'arm64-v8a', APK('nope'))).status,
    403,
  );
});

test('a body that is not an APK is rejected', async () => {
  const admin = await h.adminToken();
  const res = await upload(admin, 11, 'arm64-v8a', 'this is not a zip');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_APK');
});

test('publishing a build with no APK is refused', async () => {
  const admin = await h.adminToken();
  // A release row is only created by an upload, so publish an unknown build.
  const res = await h.request('POST', '/api/v1/admin/client-apps/android/releases/12/status', {
    token: admin,
    body: { status: 'published' },
  });
  assert.equal(res.status, 404);
});

test('crash reports are stored once and shown to administrators', async () => {
  const report = {
    reportId: 'crash-1',
    platform: 'android',
    appVersion: '0.1.0',
    buildNumber: 19,
    abi: 'arm64-v8a',
    device: 'Google Pixel 7',
    osVersion: '14',
    message: 'Unhandled Exception: engine failed to initialise',
    stack: '#0 main (package:strict_proxy_client/main.dart:1)',
    context: { fatal: true },
  };

  assert.equal((await h.request('POST', '/api/v1/client/crashes', { body: report })).status, 202);
  // A retry with the same client-generated id is accepted but not duplicated.
  assert.equal(
    (await h.request('POST', '/api/v1/client/crashes', { body: { ...report, message: 'retried' } })).status,
    202,
  );

  const admin = await h.adminToken();
  const list = await h.request('GET', '/api/v1/admin/client-apps/android/crashes', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.crashes.length, 1);
  assert.equal(list.body.crashes[0].message, report.message);
  assert.equal(list.body.crashes[0].abi, 'arm64-v8a');

  assert.equal((await h.request('GET', '/api/v1/admin/client-apps/android/crashes')).status, 401);
});

test('an empty crash report is refused', async () => {
  const res = await h.request('POST', '/api/v1/client/crashes', { body: { reportId: 'crash-2' } });
  assert.equal(res.status, 400);
});

test('deleting a build removes it from the feed', async () => {
  const admin = await h.adminToken();
  await upload(admin, 13, 'arm64-v8a', APK('deleted'));
  await h.request('POST', '/api/v1/admin/client-apps/android/releases/13/status', {
    token: admin,
    body: { status: 'published' },
  });
  assert.equal((await h.request('GET', '/api/v1/app/android')).status, 200);

  assert.equal(
    (await h.request('DELETE', '/api/v1/admin/client-apps/android/releases/13', { token: admin })).status,
    200,
  );
  assert.equal((await h.request('GET', '/api/v1/app/android')).status, 404);
});

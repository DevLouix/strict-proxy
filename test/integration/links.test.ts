/**
 * Integration tests for operator-published gated links.
 *
 * A link is a site already protected by the Gatekeeper. What is tested here is
 * the controller's half: publishing it, hiding it, and telling every plan
 * exactly which links it can open — without ever handing a locked link a usable
 * URL.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { verifyEntitlementToken } from '@strict-proxy/gatekeeper';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

let counter = 0;

function uniqueUrl(): string {
  counter += 1;
  return `https://partner-${counter}.example.com/portal`;
}

async function account(tier: string): Promise<{ token: string; userId: string }> {
  const user = await h.seedUser(`links-${tier}-${Math.random().toString(36).slice(2, 10)}@example.test`);
  await h.setTier(user.id, tier);
  const tokens = await h.login(user.email, user.password, `device-${tier}-${counter}`);
  return { token: tokens.accessToken, userId: user.id };
}

async function createLink(token: string, overrides: Record<string, unknown> = {}) {
  return h.request('POST', '/api/v1/admin/links', {
    token,
    body: {
      title: 'Partner portal',
      url: uniqueUrl(),
      requiredTier: 'standard',
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

test('links are admin-only and require authentication', async () => {
  assert.equal((await h.request('GET', '/api/v1/admin/links')).status, 401);

  const { token } = await account('pro');
  assert.equal((await h.request('GET', '/api/v1/admin/links', { token })).status, 403);
  assert.equal((await createLink(token)).status, 403);
});

test('an admin publishes a link and it is listed with its tier', async () => {
  const admin = await h.adminToken();
  const res = await createLink(admin, { title: 'Research desk', requiredTier: 'pro' });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.link.requiredTier, 'pro');
  assert.equal(res.body.link.active, true);

  const list = await h.request('GET', '/api/v1/admin/links', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.links.length, 1);
  assert.equal(list.body.links[0].title, 'Research desk');
});

test('an unusable URL or an unknown tier is rejected', async () => {
  const admin = await h.adminToken();

  const script = await createLink(admin, { url: 'javascript:alert(1)' });
  assert.equal(script.status, 400);
  assert.equal(script.body.code, 'VALIDATION');

  const freeTier = await createLink(admin, { requiredTier: 'free' });
  assert.equal(freeTier.status, 400);

  const noTitle = await createLink(admin, { title: '   ' });
  assert.equal(noTitle.status, 400);
});

test('the same URL cannot be published twice', async () => {
  const admin = await h.adminToken();
  const url = uniqueUrl();

  assert.equal((await createLink(admin, { url })).status, 201);
  const duplicate = await createLink(admin, { url });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'DUPLICATE_LINK');
});

test('editing and deleting a link are audited and reported', async () => {
  const admin = await h.adminToken();
  const created = await createLink(admin);
  const id = created.body.link.id;

  const patched = await h.request('PATCH', `/api/v1/admin/links/${id}`, {
    token: admin,
    body: { requiredTier: 'pro', active: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.link.requiredTier, 'pro');
  assert.equal(patched.body.link.active, false);

  const removed = await h.request('DELETE', `/api/v1/admin/links/${id}`, { token: admin });
  assert.equal(removed.status, 200);

  const gone = await h.request('PATCH', `/api/v1/admin/links/${id}`, {
    token: admin,
    body: { active: true },
  });
  assert.equal(gone.status, 404);

  const actions = await h.query<{ action: string }>(
    `SELECT action FROM admin_audit_log WHERE target_type = 'link' ORDER BY created_at`,
  );
  assert.deepEqual(
    actions.map((a) => a.action),
    ['link.created', 'link.updated', 'link.deleted'],
  );
});

// ---------------------------------------------------------------------------
// What each plan sees
// ---------------------------------------------------------------------------

test('a free account sees every link locked, with the plan that unlocks them', async () => {
  const admin = await h.adminToken();
  await createLink(admin, { title: 'Standard one', requiredTier: 'standard' });
  await createLink(admin, { title: 'Pro one', requiredTier: 'pro' });
  const { token } = await account('free');

  const res = await h.request('GET', '/api/v1/links', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.tier, 'free');
  assert.equal(res.body.counts.total, 2);
  assert.equal(res.body.counts.accessible, 0);
  assert.equal(res.body.counts.locked, 2);
  assert.equal(res.body.upgrade.tier, 'standard', 'the cheapest plan that reveals a link is named');
  assert.match(res.body.upgrade.message, /Standard unlocks 2 links/);

  for (const link of res.body.links) {
    assert.equal(link.locked, true, link.title);
    assert.equal(link.accessUrl, null, 'a locked link must not carry a usable URL');
    assert.ok(link.requiredTier === 'standard' || link.requiredTier === 'pro');
  }
});

test('a standard account opens standard links and is told Pro reveals more', async () => {
  const admin = await h.adminToken();
  await createLink(admin, { title: 'Standard one', requiredTier: 'standard' });
  await createLink(admin, { title: 'Pro one', requiredTier: 'pro' });
  const { token, userId } = await account('standard');

  const res = await h.request('GET', '/api/v1/links', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.accessible, 1);
  assert.equal(res.body.counts.locked, 1);
  assert.equal(res.body.upgrade.tier, 'pro');
  assert.match(res.body.upgrade.message, /You can see 1 of 2 links\. Pro unlocks 1 more/);

  const standard = res.body.links.find((l: any) => l.requiredTier === 'standard');
  const pro = res.body.links.find((l: any) => l.requiredTier === 'pro');
  assert.equal(standard.locked, false);
  assert.equal(pro.locked, true);

  // The ticket must be a real, verifiable entitlement for this account: the
  // Gatekeeper-protected site checks exactly this before admitting the browser.
  const ticket = new URL(standard.accessUrl).searchParams.get('sp_ticket');
  assert.ok(ticket, 'an unlocked link needs a gate ticket');
  const verified = verifyEntitlementToken(ticket, {
    [h.cfg.signingKeyId]: h.infra.signingPublicKeyPem,
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.entitlement?.tier, 'standard');
  assert.equal(verified.entitlement?.userId, userId, 'the ticket must belong to the caller');
});

test('a pro account opens everything and gets no upsell', async () => {
  const admin = await h.adminToken();
  await createLink(admin, { requiredTier: 'standard' });
  await createLink(admin, { requiredTier: 'pro' });
  const { token } = await account('pro');

  const res = await h.request('GET', '/api/v1/links', { token });
  assert.equal(res.body.counts.accessible, 2);
  assert.equal(res.body.counts.locked, 0);
  assert.equal(res.body.upgrade, null);
  assert.ok(res.body.links.every((l: any) => typeof l.accessUrl === 'string'));
});

test('a lapsed subscription is treated as free, not as its last paid tier', async () => {
  const admin = await h.adminToken();
  await createLink(admin, { requiredTier: 'standard' });
  const { token, userId } = await account('standard');
  await h.query(
    `UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE user_id = '${userId}'`,
  );

  const res = await h.request('GET', '/api/v1/links', { token });
  assert.equal(res.body.tier, 'free');
  assert.equal(res.body.counts.accessible, 0);
  assert.equal(res.body.links[0].accessUrl, null);
});

test('a hidden link is not shown to users but is kept for the operator', async () => {
  const admin = await h.adminToken();
  const created = await createLink(admin);
  await h.request('PATCH', `/api/v1/admin/links/${created.body.link.id}`, {
    token: admin,
    body: { active: false },
  });

  const { token } = await account('pro');
  const user = await h.request('GET', '/api/v1/links', { token });
  assert.equal(user.body.counts.total, 0);

  const operator = await h.request('GET', '/api/v1/admin/links', { token: admin });
  assert.equal(operator.body.links.length, 1, 'hiding is not deleting');
});

test('links require a signed-in account', async () => {
  const res = await h.request('GET', '/api/v1/links');
  assert.equal(res.status, 401);
});

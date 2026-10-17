/**
 * Dispute outcomes.
 *
 * `dispute.resolved` was previously unmapped because the verdict was assumed to
 * be absent from the envelope. It is not: the provider reports the outcome as
 * the dispute's `status` (`won` | `lost` | `resolved`) with `resolution` as free
 * text. That is verified against the provider's own `Dispute` type.
 *
 * The behaviour these tests pin is the asymmetry:
 *
 *   - Losing keeps access revoked, which is the safe default.
 *   - Winning restores the tier that was actually taken, not the current one.
 *   - An unstated outcome (`resolved`) changes nothing, in either direction.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.js';
import { mapOpenPayEvent } from '../../apps/controller/src/services/openpay.js';

let h: Harness;

before(async () => {
  h = await createHarness({ openpayApiKey: 'pk_test', openpayWebhookSecret: 'whsec_test' });
});

after(async () => {
  await h.stop();
});

beforeEach(async () => {
  await h.resetDb();
});

/** Resolves a signed webhook body and returns the response. */
async function deliver(body: unknown) {
  const raw = JSON.stringify(body);
  return h.request('POST', '/webhooks/payments', { rawBody: raw, headers: { [h.openpay.header]: h.openPaySignature(raw) } });
}

/**
 * A user who bought Pro, got a working credential, and then had it revoked by
 * a dispute. Returns the identifiers needed to resolve the dispute.
 */
async function disputedProCustomer(email = 'disputed@example.test') {
  await h.seedNode({ status: 'online' });
  const user = await h.seedUser(email);
  await h.setTier(user.id, 'free');
  const tokens = await h.login(user.email, user.password, 'device-1');
  await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });

  await deliver({
    id: `evt_paid_${email}`,
    type: 'charge.success',
    data: { object: { metadata: { user_id: user.id, tier: 'pro' } } },
  });
  // The checkout ledger row the purchase and the dispute both resolve against.
  await h.query(
    `INSERT INTO billing_checkouts (user_id, reference, provider_reference, tier, amount_minor, currency, status, paid_at)
     VALUES ('${user.id}', 'spx_${email}', 'op_${email}', 'pro', 750000, 'NGN', 'paid', now())`,
  );

  // The dispute opens: access goes.
  await deliver({
    id: `evt_disputed_${email}`,
    type: 'dispute.created',
    data: { object: { id: 'dp_1', transaction_id: `op_${email}`, status: 'open', metadata: { user_id: user.id } } },
  });

  return { user, checkout: { provider_reference: `op_${email}`, tier: 'pro' } };
}

/** A `dispute.resolved` delivery carrying a given verdict. */
function resolvedEvent(userId: string, transactionId: string, status: string, id: string) {
  return {
    id,
    type: 'dispute.resolved',
    data: {
      object: {
        id: 'dp_1',
        transaction_id: transactionId,
        status,
        resolution: status === 'won' ? 'evidence accepted' : status === 'lost' ? 'evidence rejected' : 'closed',
        metadata: { user_id: userId },
      },
    },
  };
}

async function subscriptionOf(userId: string) {
  const [row] = await h.query<any>(`SELECT tier, status, current_period_end FROM subscriptions WHERE user_id = '${userId}'`);
  return row;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('a dispute verdict is read from the dispute status', () => {
  const won = mapOpenPayEvent({ id: 'e1', type: 'dispute.resolved', data: { object: { status: 'won' } } });
  assert.equal(won?.type, 'charge.dispute_resolved');
  assert.equal(won?.disputeOutcome, 'won');
  assert.equal(won?.providerDisputeId, null, 'no id in this payload, so none is invented');

  const lost = mapOpenPayEvent({ id: 'e2', type: 'dispute.resolved', data: { object: { status: 'lost' } } });
  assert.equal(lost?.disputeOutcome, 'lost');

  const withId = mapOpenPayEvent({ id: 'e3', type: 'dispute.resolved', data: { object: { id: 'dp_9', status: 'won' } } });
  assert.equal(withId?.providerDisputeId, 'dp_9');
});

test('"resolved" is not treated as a win', () => {
  // The provider uses `resolved` for "closed without stating who prevailed".
  // Reading it as a win would hand back paid-for service on a lost dispute.
  const evt = mapOpenPayEvent({ id: 'e4', type: 'dispute.resolved', data: { object: { status: 'resolved' } } });
  assert.equal(evt?.disputeOutcome, null);
});

test('an absent or unrecognised status yields no outcome', () => {
  for (const payload of [{}, { status: 'in_review' }, { status: 'WEIRD' }, { status: '' }]) {
    const evt = mapOpenPayEvent({ id: 'e5', type: 'dispute.resolved', data: { object: payload } });
    assert.equal(evt?.disputeOutcome, null, JSON.stringify(payload));
  }
});

test('the free-text resolution does not decide anything', () => {
  // The narrative is free text and could contain the word "won".
  const evt = mapOpenPayEvent({
    id: 'e6',
    type: 'dispute.resolved',
    data: { object: { status: 'lost', resolution: 'customer said the charge was won at court' } },
  });
  assert.equal(evt?.disputeOutcome, 'lost');
});

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

test('winning a dispute restores the tier that was taken', async () => {
  const { user, checkout } = await disputedProCustomer();

  const before = await subscriptionOf(user.id);
  assert.equal(before.status, 'revoked');
  assert.equal(before.tier, 'free');

  const res = await deliver(resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_win_1'));
  assert.equal(res.status, 200);

  const after = await subscriptionOf(user.id);
  assert.equal(after.status, 'active', 'a won dispute must give access back');
  assert.equal(after.tier, checkout.tier, 'the tier restored is the one that was purchased');
  assert.ok(new Date(after.current_period_end).getTime() > Date.now(), 'a usable period is granted');

  // Access really works again: the tier gates credential minting.
  const tokens = await h.login(user.email, user.password, 'device-1');
  const config = await h.request('GET', '/api/v1/network/config', { token: tokens.accessToken });
  assert.equal(config.status, 200);
});

test('a won dispute restores the purchased tier, not whatever the row says now', async () => {
  // Guards against restoring from the current subscription row, which by then
  // has been flattened to `free` by the dispute itself.
  const { user, checkout } = await disputedProCustomer('purchased@example.test');
  await deliver(resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_win_2'));
  const after = await subscriptionOf(user.id);
  assert.equal(after.tier, 'pro');
  assert.notEqual(after.tier, 'free');
});

test('losing a dispute leaves access revoked', async () => {
  const { user, checkout } = await disputedProCustomer('loser@example.test');
  await deliver(resolvedEvent(user.id, checkout.provider_reference, 'lost', 'evt_lost_1'));

  const after = await subscriptionOf(user.id);
  assert.equal(after.status, 'revoked');
  assert.equal(after.tier, 'free');

  // Nothing changed, so the ledger says so rather than claiming a change. The
  // dashboard renders this as "ignored", which is the honest reading.
  const [ledger] = await h.query<{ applied: boolean; reason: string }>(
    `SELECT applied, reason FROM payment_events WHERE id = 'evt_lost_1'`,
  );
  assert.equal(ledger.applied, false);
  assert.match(ledger.reason, /access stays revoked/);
});

test('a dispute closed with no stated outcome changes nothing', async () => {
  // The dangerous case: `resolved` on a dispute we actually lost.
  const { user, checkout } = await disputedProCustomer('ambiguous@example.test');
  await deliver(resolvedEvent(user.id, checkout.provider_reference, 'resolved', 'evt_res_1'));

  const after = await subscriptionOf(user.id);
  assert.equal(after.status, 'revoked', 'an ambiguous signal must never restore access');
  assert.equal(after.tier, 'free');

  // And the record must distinguish "closed, no verdict" from "not understood".
  const [ledger] = await h.query<{ applied: boolean; reason: string }>(
    `SELECT applied, reason FROM payment_events WHERE id = 'evt_res_1'`,
  );
  assert.equal(ledger.applied, false);
  assert.match(ledger.reason, /no stated outcome/);
});

test('a win with no checkout to restore from leaves the revocation in place', async () => {
  // Restoring nothing would silently swallow the win; guessing the tier would
  // grant service that was never paid for.
  const { user, checkout } = await disputedProCustomer('orphan@example.test');
  await h.query(`DELETE FROM billing_checkouts WHERE user_id = '${user.id}'`);

  await deliver({
    id: 'evt_win_orphan',
    type: 'dispute.resolved',
    data: { object: { id: 'dp_orphan', status: 'won', metadata: { user_id: user.id } } },
  });

  const after = await subscriptionOf(user.id);
  assert.equal(after.status, 'revoked');
  assert.equal(after.tier, 'free');
  // Recorded as unapplied so an operator can find it.
  const events = await h.query<any>(`SELECT applied FROM payment_events WHERE id = 'evt_win_orphan'`);
  assert.equal(events[0].applied, false);
});

test('replaying a win does not extend the period each time', async () => {
  const { user, checkout } = await disputedProCustomer('replay@example.test');
  await deliver(resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_win_replay'));
  const first = (await subscriptionOf(user.id)).current_period_end;

  // A different delivery id for the same dispute: the provider can legitimately
  // send more than one, and a second must not buy extra time.
  await h.query(`UPDATE payment_events SET id = 'evt_win_replay_seen' WHERE id = 'evt_win_replay'`);
  await deliver(resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_win_replay'));
  const second = (await subscriptionOf(user.id)).current_period_end;

  assert.equal(new Date(first).getTime(), new Date(second).getTime(), 'the same event id is idempotent');
});

test('a repeated dispute.resolved delivery is accepted as a duplicate', async () => {
  const { user, checkout } = await disputedProCustomer('dupe@example.test');
  const evt = resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_win_dupe');
  assert.equal((await deliver(evt)).status, 200);
  assert.equal((await deliver(evt)).status, 200, 'a redelivery must not error');

  const events = await h.query<any>(`SELECT count(*)::int AS n FROM payment_events WHERE id = 'evt_win_dupe'`);
  assert.equal(events[0].n, 1, 'it is recorded once');
});

test('a forged dispute outcome is rejected', async () => {
  const { user, checkout } = await disputedProCustomer('forged@example.test');
  const raw = JSON.stringify(resolvedEvent(user.id, checkout.provider_reference, 'won', 'evt_forged'));

  const res = await h.request('POST', '/webhooks/payments', { rawBody: raw, headers: { [h.openpay.header]: 't=1,v1=deadbeef' } });
  assert.notEqual(res.status, 200);

  const after = await subscriptionOf(user.id);
  assert.equal(after.status, 'revoked', 'a forged win must not restore access');
});

test('dispute.resolved is now part of the authoritative event list', async () => {
  const { OPENPAY_EVENTS } = await import('../../apps/controller/src/services/openpay.js');
  assert.ok(OPENPAY_EVENTS.includes('dispute.resolved'));
});

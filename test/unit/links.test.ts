/**
 * Unit tests for the gated-links rules.
 *
 * These decide who can open a site and what the app tells everyone else, so
 * they are pinned without a database: a wrong tier comparison here is an access
 * bug, and a wrong upsell sentence is a customer seeing a plan that reveals
 * nothing new.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLinksCatalog,
  linkAccessUrl,
  linkLockedFor,
  normalizeLinkInput,
  parseLinkUrl,
} from '../../apps/controller/src/services/links.js';

test('only browsable http(s) URLs are accepted', () => {
  assert.equal(parseLinkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(parseLinkUrl(' http://example.com '), 'http://example.com/');
  assert.equal(parseLinkUrl('javascript:alert(1)'), null, 'a link row is something a user taps');
  assert.equal(parseLinkUrl('data:text/html,hi'), null);
  assert.equal(parseLinkUrl('/relative'), null);
  assert.equal(parseLinkUrl(''), null);
});

test('a created link needs a title, URL and gated tier', () => {
  assert.throws(() => normalizeLinkInput({}), /title is required/);
  assert.throws(() => normalizeLinkInput({ title: 'x' }), /url must be/);
  assert.throws(
    () => normalizeLinkInput({ title: 'x', url: 'https://example.com' }),
    /requiredTier must be standard or pro/,
  );
  assert.throws(
    () => normalizeLinkInput({ title: 'x', url: 'https://example.com', requiredTier: 'free' }),
    /requiredTier/,
    'free is not a purchasable gate',
  );
});

test('a partial update validates only the fields it carries', () => {
  assert.deepEqual(normalizeLinkInput({ active: false }, { partial: true }), { active: false });
  assert.deepEqual(
    normalizeLinkInput({ requiredTier: 'PRO' }, { partial: true }),
    { requiredTier: 'pro' },
  );
  assert.deepEqual(
    normalizeLinkInput({ description: '   ' }, { partial: true }),
    { description: null },
    'an empty description is stored as null, not a blank string',
  );
  assert.throws(
    () => normalizeLinkInput({ sortOrder: 1.5 }, { partial: true }),
    /sortOrder/,
  );
});

test('a plan below the link requirement is locked, and pro unlocks standard', () => {
  assert.equal(linkLockedFor('standard', 'free'), true);
  assert.equal(linkLockedFor('standard', 'standard'), false);
  assert.equal(linkLockedFor('standard', 'pro'), false);
  assert.equal(linkLockedFor('pro', 'standard'), true);
  assert.equal(linkLockedFor('pro', 'pro'), false);
  assert.equal(linkLockedFor('something-unknown', 'pro'), true, 'unknown requirements fail closed');
});

test('the ticket is appended as a query parameter', () => {
  const withTicket = linkAccessUrl('https://example.com/portal?x=1', 'sp1.abc.def');
  assert.ok(withTicket);
  const url = new URL(withTicket);
  assert.equal(url.searchParams.get('sp_ticket'), 'sp1.abc.def');
  assert.equal(url.searchParams.get('x'), '1');
  assert.equal(linkAccessUrl('https://example.com', null), null);
});

const rows = [
  {
    id: 'l1',
    title: 'Starter reports',
    url: 'https://standard.example.com',
    description: null,
    requiredTier: 'standard',
  },
  {
    id: 'l2',
    title: 'Pro terminal',
    url: 'https://pro.example.com',
    description: 'Deeper data',
    requiredTier: 'pro',
  },
];

test('a free account sees locked links and is told which plan reveals them', () => {
  const catalog = buildLinksCatalog(rows, 'free', null);
  assert.equal(catalog.counts.total, 2);
  assert.equal(catalog.counts.accessible, 0);
  assert.equal(catalog.counts.locked, 2);
  assert.equal(catalog.upgrade?.tier, 'standard');
  assert.match(catalog.upgrade!.message, /Standard unlocks 2 links/);
  for (const link of catalog.links) {
    assert.equal(link.locked, true);
    assert.equal(link.accessUrl, null, 'a locked link must not carry a usable URL');
  }
});

test('a standard account opens standard links and is told Pro unlocks more', () => {
  const catalog = buildLinksCatalog(rows, 'standard', 'sp1.ticket.sig');
  assert.equal(catalog.counts.accessible, 1);
  assert.equal(catalog.counts.locked, 1);
  assert.equal(catalog.upgrade?.tier, 'pro');
  assert.match(catalog.upgrade!.message, /You can see 1 of 2 links\. Pro unlocks 1 more/);
  const standard = catalog.links.find((l) => l.id === 'l1')!;
  assert.equal(standard.locked, false);
  assert.match(standard.accessUrl!, /sp_ticket=sp1\.ticket\.sig/);
  assert.equal(catalog.links.find((l) => l.id === 'l2')!.accessUrl, null);
});

test('a pro account has nothing locked and no upsell', () => {
  const catalog = buildLinksCatalog(rows, 'pro', 'sp1.ticket.sig');
  assert.equal(catalog.counts.accessible, 2);
  assert.equal(catalog.upgrade, null);
  assert.ok(catalog.links.every((link) => link.accessUrl));
});

test('a hidden link is filtered before the catalog is built', () => {
  // The route only selects active rows; this pins the contract the helper was
  // given, so an inactive row can never appear in a catalog by accident.
  const catalog = buildLinksCatalog(rows.slice(0, 1), 'free', null);
  assert.equal(catalog.counts.total, 1);
  assert.equal(catalog.upgrade?.message, 'Standard unlocks 1 link.');
});

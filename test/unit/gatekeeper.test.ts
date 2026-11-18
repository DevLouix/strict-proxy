/**
 * Unit tests for the Gatekeeper client-IP extraction. This function decides who
 * is admitted, so spoofing behaviour must be pinned down explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIpOf, entitlementTokenOf } from '@strict-proxy/gatekeeper';

function req(opts: { xff?: string; remoteAddress?: string }): any {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? opts.xff : undefined),
    socket: { remoteAddress: opts.remoteAddress },
  };
}

test('without trustForwardedFor the socket address is used', () => {
  assert.equal(clientIpOf(req({ xff: '9.9.9.9', remoteAddress: '1.2.3.4' }), false), '1.2.3.4');
});

test('with trustForwardedFor the first X-Forwarded-For hop is used', () => {
  assert.equal(clientIpOf(req({ xff: '9.9.9.9, 8.8.8.8, 1.1.1.1', remoteAddress: '127.0.0.1' }), true), '9.9.9.9');
});

test('with trustForwardedFor an absent header falls back to the socket', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '1.2.3.4' }), true), '1.2.3.4');
});

test('IPv6-mapped IPv4 addresses are normalized to bare IPv4', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '::ffff:203.0.113.7' }), false), '203.0.113.7');
});

test('native IPv6 addresses are preserved', () => {
  assert.equal(clientIpOf(req({ remoteAddress: '2001:db8::1' }), false), '2001:db8::1');
});

test('a missing remote address yields null rather than a bogus match', () => {
  assert.equal(clientIpOf(req({}), false), null);
});

test('an empty X-Forwarded-For entry does not produce an empty string result', () => {
  assert.equal(clientIpOf(req({ xff: ' , 8.8.8.8', remoteAddress: '1.2.3.4' }), true), '1.2.3.4');
});

// ---------------------------------------------------------------------------
// Entitlement token sources
// ---------------------------------------------------------------------------

function tokenReq(opts: { headers?: Record<string, string>; query?: Record<string, unknown> } = {}): any {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name.toLowerCase()],
    query: opts.query ?? {},
  };
}

test('the entitlement header is the primary source', () => {
  const r = tokenReq({ headers: { 'x-strict-proxy-entitlement': 'sp1.header.sig' } });
  assert.equal(entitlementTokenOf(r), 'sp1.header.sig');
});

test('a browser link ticket is accepted when no header is present', () => {
  // A top-level navigation cannot set a header; the controller mints a
  // short-lived ticket into the link instead.
  const r = tokenReq({ query: { sp_ticket: 'sp1.link.sig' } });
  assert.equal(entitlementTokenOf(r), 'sp1.link.sig');
});

test('the header wins over a ticket', () => {
  const r = tokenReq({
    headers: { 'x-strict-proxy-entitlement': 'sp1.header.sig' },
    query: { sp_ticket: 'sp1.link.sig' },
  });
  assert.equal(entitlementTokenOf(r), 'sp1.header.sig');
});

test('a cookie is the last fallback', () => {
  const r = tokenReq({ headers: { cookie: 'a=1; sp_entitlement=sp1.cookie.sig; b=2' } });
  assert.equal(entitlementTokenOf(r), 'sp1.cookie.sig');
});

test('no token anywhere yields undefined rather than an empty string', () => {
  assert.equal(entitlementTokenOf(tokenReq()), undefined);
  assert.equal(entitlementTokenOf(tokenReq({ headers: { cookie: 'other=1' } })), undefined);
  assert.equal(entitlementTokenOf(tokenReq({ query: { sp_ticket: '' } })), undefined);
});

test('source names can be overridden per deployment', () => {
  const r = tokenReq({
    headers: { 'x-my-plan': 'sp1.header.sig' },
    query: { plan_ticket: 'sp1.link.sig' },
  });
  assert.equal(
    entitlementTokenOf(r, 'x-my-plan', { queryParam: 'plan_ticket', cookieName: 'plan' }),
    'sp1.header.sig',
  );
  assert.equal(
    entitlementTokenOf(tokenReq({ query: { plan_ticket: 'sp1.link.sig' } }), 'x-my-plan', {
      queryParam: 'plan_ticket',
    }),
    'sp1.link.sig',
  );
});
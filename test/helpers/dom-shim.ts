/**
 * Minimal DOM shim for exercising the admin dashboard without a browser.
 *
 * Real browser testing would need a headless Chrome in CI. This shim is
 * deliberately small: it supports only the operations the dashboard actually
 * uses, which is enough to catch the failure modes that matter — typos,
 * undefined function references, and handlers that throw when clicked.
 */

// ---------------------------------------------------------------------------
// Shim
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  toggle(name, force) {
    const set = this.el._classes ?? new Set();
    if (force) set.add(name);
    else set.delete(name);
    this.el._classes = set;
    this.el.className = [...set].join(' ');
  }
  add(name) {
    this.toggle(name, true);
  }
  remove(name) {
    this.toggle(name, false);
  }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._listeners = new Map();
    this.classList = new FakeClassList(this);
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.disabled = false;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  addEventListener(type, fn) {
    this._listeners.set(type, fn);
  }
  dispatch(type, ev = {}) {
    const fn = this._listeners.get(type);
    return fn ? fn({ preventDefault() {}, target: this, ...ev }) : undefined;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.dispatch('close');
  }
  querySelector() {
    return null;
  }
  /** Concatenated text of this subtree. */
  text() {
    let out = this.textContent ?? '';
    for (const c of this.children) out += c instanceof FakeText ? c.data : c instanceof FakeElement ? c.text() : '';
    return out;
  }
  /** Every element in this subtree, depth-first. */
  *walk() {
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        yield c;
        yield* c.walk();
      }
    }
  }
}

class FakeText {
  constructor(data) {
    this.data = String(data);
  }
}

/** Installs the shim onto globalThis. Call before importing the dashboard. */
export function installDomShim() {
  const toasts = new FakeElement('div');
  globalThis.Node = FakeElement;
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
    getElementById: (id) => (id === 'toasts' ? toasts : null),
    // The dashboard only uses this to probe for an optional element; reporting
    // "not found" is the right answer for the selectors it passes.
    querySelector: () => null,
    querySelectorAll: () => [],
    body: new FakeElement('body'),
  };
  globalThis.window = { addEventListener: () => {} };
  globalThis.location = { hash: '', origin: 'https://admin.test' };
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  return { toasts };
}

/** Stub API returning representative admin payloads. */
export function stubApi() {
  const data = {
    overview: { users: 2, activeSubscriptions: 1, onlineNodes: 1, activeCredentials: 3 },
    billing: { checkouts: { total: 3, paid: 1, open: 1, expired: 1 }, revenue: { grossMinor: 750000, currency: 'NGN' }, gateway: 'openpay' },
    me: { user: { email: 'admin@x.test', role: 'admin' } },
    checkouts: {
      checkouts: [
        {
          reference: 'ref_1',
          providerReference: 'op_ref_1',
          tier: 'standard',
          amountMinor: 2000,
          currency: 'USD',
          status: 'paid',
          createdAt: '2026-03-01T00:00:00Z',
          paidAt: '2026-03-01T00:05:00Z',
          user: { id: 'u1', email: 'a@x.test' },
        },
      ],
    },
    audit: {
      entries: [
        {
          id: 'a1',
          actorId: 'u9',
          actorEmail: 'admin@x.test',
          action: 'user.updated',
          targetType: 'user',
          targetId: 'u1',
          summary: 'a@x.test disabled',
          metadata: { disabled: true },
          createdAt: '2026-03-04T00:00:00Z',
        },
      ],
    },
    userDetail: {
      user: {
        id: 'u1',
        email: 'a@x.test',
        role: 'user',
        disabledAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-03-04T00:00:00Z',
      },
      subscription: {
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: '2026-12-01T00:00:00Z',
        provider: 'openpay',
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        updatedAt: '2026-03-04T00:00:00Z',
      },
      devices: [
        { deviceId: 'device-1', deviceName: 'Pixel 7', lastSeenAt: new Date().toISOString(), createdAt: '2026-01-01T00:00:00Z' },
      ],
      credentials: [
        { nodeId: 'n1', hostname: 'fra-1', region: 'eu-central', revoked: false, bytesUsed: 2048, createdAt: '2026-01-01T00:00:00Z' },
      ],
      checkouts: [
        { reference: 'ref_1', tier: 'standard', amountMinor: 2000, currency: 'USD', status: 'paid', createdAt: '2026-03-01T00:00:00Z' },
      ],
      audit: [
        { id: 'a1', actorEmail: 'admin@x.test', action: 'user.updated', summary: 'a@x.test disabled', createdAt: '2026-03-04T00:00:00Z' },
      ],
    },
    users: {
      users: [
        { id: 'u1', email: 'a@x.test', role: 'user', tier: 'pro', subscriptionStatus: 'active', disabledAt: null, createdAt: '2026-01-01T00:00:00Z', currentPeriodEnd: '2026-12-01T00:00:00Z' },
        { id: 'u2', email: 'b@x.test', role: 'user', tier: 'free', subscriptionStatus: 'revoked', disabledAt: '2026-02-01T00:00:00Z', createdAt: '2026-01-02T00:00:00Z', currentPeriodEnd: null },
      ],
    },
    nodes: {
      nodes: [{ id: 'n1', hostname: 'fra-1', region: 'eu-central', label: 'Frankfurt 1', publicIp: '203.0.113.1', tunnelPort: 443, status: 'online', loadScore: 12, lastHeartbeatAt: new Date().toISOString(), engineVersion: '1.13.21' }],
    },
    enrollments: {
      enrollments: [
        { id: 'e1', region: 'eu-west', label: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), usedAt: null, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'e2', region: 'us-east', label: 'old', expiresAt: new Date(Date.now() - 60_000).toISOString(), usedAt: new Date(Date.now() - 120_000).toISOString(), createdAt: '2026-01-01T00:00:00Z' },
      ],
    },
    events: {
      events: [{ id: 'evt_1', type: 'checkout.completed', applied: true, reason: null, receivedAt: '2026-01-01T00:00:00Z' }],
    },
    clientReleases: {
      platform: 'android',
      abis: ['universal', 'arm64-v8a', 'armeabi-v7a', 'x86_64'],
      releases: [
        {
          id: 'r1',
          version: '0.2.0',
          buildNumber: 20,
          notes: 'Home screen fix',
          status: 'draft',
          createdAt: '2026-03-01T00:00:00Z',
          publishedAt: null,
          artifacts: [{ abi: 'arm64-v8a', sizeBytes: 52_000_000, sha256: 'a'.repeat(64) }],
        },
      ],
      activeBuildNumber: 19,
      activeSource: 'environment',
      environment: { configured: true, version: '0.1.0', buildNumber: 19 },
    },
    disputes: {
      disputes: [
        {
          id: 'd1',
          transaction_id: 'ref_1',
          provider: 'paystack',
          dispute_type: 'product_not_received',
          status: 'open',
          amount: 2000,
          currency: 'USD',
          reason: 'Customer claims no delivery',
          resolution: null,
          evidence_submitted_at: null,
          created_at: '2026-03-02T00:00:00Z',
        },
      ],
      hasMore: false,
    },
    disputeEvidence: {
      submissions: [
        {
          id: 's1',
          dispute_id: 'd1',
          submitted_by: 'admin',
          narrative: 'Credentials were issued and used for 14 days.',
          file_urls: [],
          submission_status: 'pending',
          provider_status: 'pending',
          created_at: '2026-03-03T00:00:00Z',
        },
      ],
    },
    crashes: {
      crashes: [
        {
          id: 'c1',
          createdAt: new Date().toISOString(),
          buildNumber: 19,
          appVersion: '0.1.0',
          abi: 'arm64-v8a',
          device: 'Google Pixel 7',
          osVersion: '14',
          message: 'Unhandled Exception: engine failed to initialise',
          stack: '#0 main (package:strict_proxy_client/main.dart:1)',
        },
      ],
    },
  };

  return {
    calls: [],
    async get(path) {
      this.calls.push(['GET', path]);
      if (path.startsWith('/api/v1/me')) return data.me;
      if (path.startsWith('/api/v1/admin/overview')) return data.overview;
      if (path.startsWith('/api/v1/admin/billing/summary')) return data.billing;
      if (path.startsWith('/api/v1/admin/billing/checkouts')) return data.checkouts;
      if (path.startsWith('/api/v1/admin/audit')) return data.audit;
      if (/^\/api\/v1\/admin\/users\/[^/?]+$/.test(path)) return data.userDetail;
      if (path.startsWith('/api/v1/admin/users')) return data.users;
      if (path.startsWith('/api/v1/admin/nodes')) return data.nodes;
      if (path.startsWith('/api/v1/admin/node-enrollments')) return data.enrollments;
      if (path.startsWith('/api/v1/admin/disputes')) {
        if (path.endsWith('/evidence')) return data.disputeEvidence;
        if (/^\/api\/v1\/admin\/disputes\/[^/?]+$/.test(path)) return { dispute: data.disputes.disputes[0] };
        return data.disputes;
      }
      if (path.startsWith('/api/v1/admin/payments/events')) return data.events;
      if (path.startsWith('/api/v1/admin/client-apps/android/crashes')) return data.crashes;
      if (path.startsWith('/api/v1/admin/client-apps/android/releases')) return data.clientReleases;
      throw new Error(`unstubbed GET ${path}`);
    },
    async post(path, body) {
      this.calls.push(['POST', path, body]);
      if (path.endsWith('/rotate-secret')) {
        return { nodeId: 'n1', secret: 'new-node-secret-value', previousValidUntil: new Date(Date.now() + 86_400_000).toISOString() };
      }
      return { token: 'tok', reference: 'ref_1', checkoutUrl: 'https://example.test/pay' };
    },
    async patch(path, body) {
      this.calls.push(['PATCH', path, body]);
      return { ok: true };
    },
    async del(path) {
      this.calls.push(['DELETE', path]);
      return { ok: true, deleted: 1 };
    },
    async uploadFile(path, file) {
      this.calls.push(['UPLOAD', path, file]);
      return { release: { buildNumber: 20 }, artifact: { abi: 'arm64-v8a', sha256: 'a'.repeat(64) } };
    },
  };
}
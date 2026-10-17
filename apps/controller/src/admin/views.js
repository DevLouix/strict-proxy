/**
 * Admin dashboard views.
 *
 * Each view is an async function that fetches its own data and returns a DOM
 * node, so the shell only has to swap the main region. Errors are surfaced as
 * toasts rather than blank screens.
 */
import { h, mount, bytes, money, date, ago, badge, toast, confirmDialog, copyText } from './dom.js';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overviewView(api) {
  const [stats, billing] = await Promise.all([
    api.get('/api/v1/admin/overview'),
    api.get('/api/v1/admin/billing/summary').catch(() => null),
  ]);

  const cards = [
    { label: 'Users', value: stats.users, hint: `${stats.activeSubscriptions} on a paid tier` },
    { label: 'Online nodes', value: stats.onlineNodes, hint: 'online or degraded' },
    { label: 'Active credentials', value: stats.activeCredentials, hint: 'issued VLESS identities' },
    {
      label: 'Gross revenue',
      value: billing ? money(billing.revenue.grossMinor, billing.revenue.currency) : '—',
      hint: billing ? `${billing.checkouts.paid} settled checkout(s)` : 'billing summary unavailable',
    },
  ];

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, 'Overview'),
        h('p', {}, 'Platform health, fleet reach and revenue at a glance.'),
      ),
      billing ? badge(`gateway: ${billing.gateway}`) : null,
    ),
    h('div', { class: 'stats' },
      ...cards.map((c) => h('div', { class: 'stat' },
        h('div', { class: 'label' }, c.label),
        h('div', { class: 'value' }, String(c.value ?? 0)),
        h('div', { class: 'hint' }, c.hint),
      )),
    ),
    h('div', { class: 'panel' },
      h('header', {}, h('h3', {}, 'Checkout pipeline')),
      h('div', { class: 'body' },
        billing
          ? h('div', { class: 'row' },
            badge(`open: ${billing.checkouts.open}`),
            badge(`paid: ${billing.checkouts.paid}`),
            badge(`expired: ${billing.checkouts.expired}`),
            h('span', { class: 'muted small' }, 'Abandoned checkouts are swept automatically.'),
          )
          : h('div', { class: 'muted' }, 'Billing summary unavailable.'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function usersView(api, rerender) {
  const host = h('div', {});
  let filter = '';
  let showDisabled = false;
  let rows = [];

  async function load() {
    const data = await api.get(`/api/v1/admin/users?limit=200`);
    rows = data.users ?? [];
    draw();
  }

  function visible() {
    const needle = filter.trim().toLowerCase();
    return rows.filter((u) => {
      if (!showDisabled && u.disabledAt) return false;
      if (!needle) return true;
      return `${u.email} ${u.tier ?? ''} ${u.role ?? ''}`.toLowerCase().includes(needle);
    });
  }

  async function patchUser(userId, body, successMessage) {
    try {
      await api.patch(`/api/v1/admin/users/${userId}`, body);
      toast(successMessage);
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function editSubscriptionDialog(user) {
    const tierSel = h('select', {},
      ...['free', 'standard', 'pro'].map((t) => h('option', { value: t, selected: (user.tier ?? 'free') === t }, t)),
    );
    const statusSel = h('select', {},
      ...['active', 'expired', 'revoked'].map((s) => h('option', { value: s, selected: (user.subscriptionStatus ?? 'active') === s }, s)),
    );
    const periodInput = h('input', { type: 'date', value: (user.currentPeriodEnd ?? '').slice(0, 10) });

    const dlg = h('dialog', {},
      h('div', { class: 'dlg-head' }, h('h3', {}, `Subscription — ${user.email}`)),
      h('div', { class: 'dlg-body' },
        h('label', { class: 'field' }, h('span', {}, 'Tier'), tierSel),
        h('label', { class: 'field' }, h('span', {}, 'Status'), statusSel),
        h('label', { class: 'field' }, h('span', {}, 'Current period ends'), periodInput),
        h('p', { class: 'muted small' },
          'A status other than “active” revokes the user’s refresh tokens and every node credential immediately.'),
      ),
      h('div', { class: 'dlg-foot' },
        h('button', { class: 'btn', onClick: () => dlg.close() }, 'Cancel'),
        h('button', {
          class: 'btn primary',
          onClick: async () => {
            const body = { tier: tierSel.value, status: statusSel.value };
            if (periodInput.value) body.currentPeriodEnd = new Date(`${periodInput.value}T23:59:59Z`).toISOString();
            dlg.close();
            try {
              await api.patch(`/api/v1/admin/users/${user.id}/subscription`, body);
              toast('Subscription updated');
              await load();
            } catch (err) {
              toast(err.message, 'err');
            }
          },
        }, 'Save'),
      ),
    );
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove(), { once: true });
    dlg.showModal();
  }

  function draw() {
    const list = visible();
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Users'),
          h('p', {}, 'Accounts, roles and subscription state.'),
        ),
        h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
      ),
      h('div', { class: 'toolbar' },
        h('input', {
          type: 'search',
          placeholder: 'Filter by email, tier or role…',
          value: filter,
          onInput: (e) => { filter = e.target.value; draw(); },
        }),
        h('label', { class: 'row small muted' },
          h('input', {
            type: 'checkbox',
            checked: showDisabled,
            onChange: (e) => { showDisabled = e.target.checked; draw(); },
            style: 'width:auto',
          }),
          ' show disabled',
        ),
        h('span', { class: 'muted small' }, `${list.length} shown`),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          list.length === 0
            ? h('div', { class: 'empty' }, 'No users match this filter.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Email'),
                h('th', {}, 'Role'),
                h('th', {}, 'Tier'),
                h('th', {}, 'Status'),
                h('th', {}, 'Period ends'),
                h('th', {}, 'Created'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...list.map((u) => h('tr', {},
                h('td', {},
                  h('div', {}, u.email),
                  u.disabledAt ? h('span', { class: 'muted small' }, 'disabled') : null,
                ),
                h('td', {}, badge(u.role ?? 'user')),
                h('td', {}, badge(u.tier ?? 'free')),
                h('td', {}, badge(u.subscriptionStatus ?? 'active')),
                h('td', { class: 'small muted' }, date(u.currentPeriodEnd)),
                h('td', { class: 'small muted' }, date(u.createdAt)),
                h('td', { class: 'actions' },
                  h('button', { class: 'btn sm', onClick: () => editSubscriptionDialog(u) }, 'Subscription'),
                  ' ',
                  u.disabledAt
                    ? h('button', { class: 'btn sm', onClick: () => patchUser(u.id, { disabled: false }, 'User re-enabled') }, 'Enable')
                    : h('button', {
                        class: 'btn sm danger',
                        onClick: async () => {
                          const ok = await confirmDialog({
                            title: 'Disable this user?',
                            body: h('p', {}, `Disabling ${u.email} revokes their refresh tokens and every node credential immediately.`),
                            confirmLabel: 'Disable',
                            danger: true,
                          });
                          if (ok) await patchUser(u.id, { disabled: true }, 'User disabled');
                        },
                      }, 'Disable'),
                  ' ',
                  h('button', {
                    class: 'btn sm',
                    onClick: async () => {
                      const next = (u.role ?? 'user') === 'admin' ? 'user' : 'admin';
                      try {
                        await api.patch(`/api/v1/admin/users/${u.id}`, { role: next });
                        toast(`Role changed to ${next}`);
                        await load();
                      } catch (err) {
                        toast(err.message, 'err');
                      }
                    },
                  }, (u.role ?? 'user') === 'admin' ? 'Demote' : 'Promote'),
                ),
              ))),
            ),
        ),
      ),
    );
  }

  await load();
  void rerender;
  return host;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * Issues a node enrollment token.
 *
 * Module level rather than a closure inside `nodesView` because the enrollment
 * list needs the same dialog: it was previously reached through a
 * `[data-open-enroll]` selector that nothing ever rendered, so "Issue new" on
 * that screen silently did nothing but refresh.
 */
function issueEnrollmentDialog(api, onIssued) {
  const region = h('input', { placeholder: 'eu-central' });
  const label = h('input', { placeholder: 'Frankfurt 1' });
  const ttl = h('input', { type: 'number', value: '30', min: '5', max: '1440' });

  const output = h('div', { class: 'stack' });

  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, 'Issue node enrollment token')),
    h('div', { class: 'dlg-body' },
      h('label', { class: 'field' }, h('span', {}, 'Region'), region),
      h('label', { class: 'field' }, h('span', {}, 'Label (optional)'), label),
      h('label', { class: 'field' }, h('span', {}, 'TTL (minutes, 5–1440)'), ttl),
      output,
      h('p', { class: 'muted small' },
        'The token is shown once. Run it on the VPS as NODE_ENROLLMENT_TOKEN; only its hash is stored.'),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          try {
            const res = await api.post('/api/v1/admin/node-enrollments', {
              region: region.value.trim(),
              label: label.value.trim() || undefined,
              ttlMinutes: Number(ttl.value),
            });
            mount(output,
              h('p', { class: 'muted small' }, 'One-time token — copy it now:'),
              h('div', { class: 'copy' }, res.token),
              h('button', { class: 'btn sm', onClick: () => copyText(res.token) }, 'Copy token'),
              h('p', { class: 'muted small' },
                'On the VPS: bash apps/node-agent/deploy/install-node.sh with CONTROLLER_URL, NODE_ENROLLMENT_TOKEN and NODE_HOSTNAME set. NODE_PUBLIC_IP is optional — the node detects and reports it.'),
            );
            // Let the caller re-read the list so the token it just issued shows
            // up in the screen the operator was looking at.
            if (onIssued) await onIssued();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, 'Issue token'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
}

export async function nodesView(api) {
  const host = h('div', {});
  let rows = [];

  async function load() {
    const data = await api.get('/api/v1/admin/nodes');
    rows = data.nodes ?? [];
    draw();
  }

  async function act(fn, message) {
    try {
      await fn();
      toast(message);
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function draw() {
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Node fleet'),
          h('p', {}, 'Exit nodes, their health, and enrollment.'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
          h('button', { class: 'btn primary sm', onClick: () => issueEnrollmentDialog(api, load) }, 'Enroll a node'),
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          rows.length === 0
            ? h('div', { class: 'empty' }, 'No nodes yet. Issue an enrollment token to add one.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Hostname'),
                h('th', {}, 'Region'),
                h('th', {}, 'Public IP'),
                h('th', {}, 'Status'),
                h('th', {}, 'Load'),
                h('th', {}, 'Last heartbeat'),
                h('th', {}, 'Engine'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...rows.map((n) => h('tr', {},
                h('td', {},
                  h('div', {}, n.hostname),
                  n.label ? h('span', { class: 'muted small' }, n.label) : null,
                ),
                h('td', { class: 'small' }, n.region),
                h('td', {},
                  h('div', { class: 'mono' }, n.publicIp),
                  n.publicIpSource === 'autodetect'
                    ? h('span', { class: 'muted small', title: `Auto-detected ${date(n.publicIpUpdatedAt)}` }, 'auto-detected')
                    : n.publicIpSource === 'manual'
                      ? h('span', { class: 'muted small' }, 'set by admin')
                      : null,
                ),
                h('td', {}, badge(n.status)),
                h('td', {}, h('span', { class: 'small' }, `${n.loadScore}%`)),
                h('td', { class: 'small muted', title: date(n.lastHeartbeatAt) }, ago(n.lastHeartbeatAt)),
                h('td', { class: 'small muted mono' }, n.engineVersion),
                h('td', { class: 'actions' },
                  n.status === 'draining'
                    ? h('button', {
                        class: 'btn sm',
                        onClick: () => act(() => api.patch(`/api/v1/admin/nodes/${n.id}`, { status: 'online' }), 'Node resumed'),
                      }, 'Resume')
                    : h('button', {
                        class: 'btn sm',
                        onClick: () => act(() => api.patch(`/api/v1/admin/nodes/${n.id}`, { status: 'draining' }), 'Node draining'),
                      }, 'Drain'),
                  ' ',
                  h('button', {
                    class: 'btn sm danger',
                    onClick: async () => {
                      const ok = await confirmDialog({
                        title: 'Delete this node?',
                        body: h('div', {},
                          h('p', {}, `Delete ${n.hostname}? Users routed to it lose their credential on the next sync.`),
                          h('p', { class: 'muted small' }, 'Draining is reversible; deleting is not.'),
                        ),
                        confirmLabel: 'Delete node',
                        danger: true,
                      });
                      if (ok) await act(() => api.del(`/api/v1/admin/nodes/${n.id}`), 'Node deleted');
                    },
                  }, 'Delete'),
                ),
              ))),
            ),
        ),
      ),
    );
  }

  await load();
  return host;
}

// ---------------------------------------------------------------------------
// Enrollment tokens
// ---------------------------------------------------------------------------

export async function enrollmentsView(api) {
  const host = h('div', {});

  async function load() {
    const data = await api.get('/api/v1/admin/node-enrollments');
    const rows = data.enrollments ?? [];
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Enrollment tokens'),
          h('p', {}, 'One-time, short-lived tokens used to add a VPS to the fleet.'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
          h('button', { class: 'btn primary sm', onClick: () => issueEnrollmentDialog(api, load) }, 'Issue new'),
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          rows.length === 0
            ? h('div', { class: 'empty' }, 'No enrollment tokens have been issued.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Region'),
                h('th', {}, 'Label'),
                h('th', {}, 'State'),
                h('th', {}, 'Expires'),
                h('th', {}, 'Created'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...rows.map((e) => {
                const expired = e.expiresAt && new Date(e.expiresAt).getTime() <= Date.now();
                const state = e.usedAt ? 'used' : expired ? 'expired' : 'active';
                return h('tr', {},
                  h('td', {}, e.region),
                  h('td', { class: 'small muted' }, e.label ?? '—'),
                  h('td', {}, badge(state)),
                  h('td', { class: 'small muted' }, date(e.expiresAt)),
                  h('td', { class: 'small muted' }, date(e.createdAt)),
                  h('td', { class: 'actions' },
                    !e.usedAt && !expired
                      ? h('button', {
                          class: 'btn sm danger',
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: 'Revoke this token?',
                              body: h('p', {}, 'The token becomes unusable immediately. It cannot be reinstated.'),
                              confirmLabel: 'Revoke',
                              danger: true,
                            });
                            if (!ok) return;
                            try {
                              await api.del(`/api/v1/admin/node-enrollments/${e.id}`);
                              toast('Token revoked');
                              await load();
                            } catch (err) {
                              toast(err.message, 'err');
                            }
                          },
                        }, 'Revoke')
                      : h('span', { class: 'muted small' }, '—'),
                  ),
                );
              })),
            ),
        ),
      ),
    );
  }

  // Reuse the node view's dialog so token issuance lives in one place.
  mount(host, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  const nodesNode = await nodesView(api);
  void nodesNode;
  await load();
  return host;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export async function paymentsView(api) {
  const host = h('div', {});
  let filter = '';

  async function load() {
    const [events, billing, checkouts] = await Promise.all([
      api.get('/api/v1/admin/payments/events?limit=200'),
      api.get('/api/v1/admin/billing/summary').catch(() => null),
      api.get('/api/v1/admin/billing/checkouts?limit=100').catch(() => null),
    ]);
    const rows = (events.events ?? []).filter((e) =>
      !filter.trim() || `${e.id} ${e.type} ${e.reason ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
    const checkoutRows = checkouts?.checkouts ?? [];

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Payments'),
          h('p', {}, 'Verified webhook events and the checkout ledger.'),
        ),
        h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
      ),
      billing
        ? h('div', { class: 'stats' },
            h('div', { class: 'stat' },
              h('div', { class: 'label' }, 'Gross revenue'),
              h('div', { class: 'value' }, money(billing.revenue.grossMinor, billing.revenue.currency)),
            ),
            h('div', { class: 'stat' },
              h('div', { class: 'label' }, 'Settled checkouts'),
              h('div', { class: 'value' }, String(billing.checkouts.paid)),
            ),
            h('div', { class: 'stat' },
              h('div', { class: 'label' }, 'Awaiting payment'),
              h('div', { class: 'value' }, String(billing.checkouts.open)),
            ),
          )
        : null,
      h('div', { class: 'toolbar' },
        h('input', {
          type: 'search',
          placeholder: 'Filter by event id, type or reason…',
          value: filter,
          onInput: (e) => { filter = e.target.value; load(); },
        }),
      ),
      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Checkout ledger'),
          h('span', { class: 'muted small' }, 'What was offered, and whether it settled'),
        ),
        h('div', { class: 'table-wrap' },
          checkoutRows.length === 0
            ? h('div', { class: 'empty' }, 'No checkouts have been opened yet.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Reference'),
                h('th', {}, 'Customer'),
                h('th', {}, 'Plan'),
                h('th', {}, 'Amount'),
                h('th', {}, 'Status'),
                h('th', {}, 'Opened'),
              )),
              h('tbody', {}, ...checkoutRows.map((c) => h('tr', {},
                h('td', {},
                  h('div', { class: 'mono' }, c.reference),
                  c.providerReference ? h('span', { class: 'muted small mono' }, c.providerReference) : null,
                ),
                h('td', { class: 'small' }, c.user?.email ?? '—'),
                h('td', {}, badge(c.tier)),
                h('td', { class: 'small' }, money(c.amountMinor, c.currency)),
                h('td', {}, badge(c.status)),
                h('td', { class: 'small muted' }, date(c.createdAt)),
              ))),
            ),
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          rows.length === 0
            ? h('div', { class: 'empty' }, 'No payment events yet.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Event'),
                h('th', {}, 'Type'),
                h('th', {}, 'Outcome'),
                h('th', {}, 'Reason'),
                h('th', {}, 'Received'),
              )),
              h('tbody', {}, ...rows.map((e) => h('tr', {},
                h('td', { class: 'mono' }, e.id),
                h('td', { class: 'small' }, e.type),
                h('td', {}, badge(e.applied ? 'applied' : 'ignored')),
                h('td', { class: 'small muted' }, e.reason ?? '—'),
                h('td', { class: 'small muted' }, date(e.receivedAt)),
              ))),
            ),
        ),
      ),
    );
  }

  await load();
  return host;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function usageView(api) {
  const host = h('div', {});
  const [billing] = await Promise.all([api.get('/api/v1/admin/billing/summary').catch(() => null)]);

  // Per-node usage comes from the fleet view's data; reuse it rather than
  // adding an endpoint that exists only for this page.
  const nodes = await api.get('/api/v1/admin/nodes').catch(() => ({ nodes: [] }));

  mount(host,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, 'Usage & bandwidth'),
        h('p', {}, 'Where reported bandwidth is landing, and how the ledger is tracking.'),
      ),
    ),
    h('div', { class: 'panel' },
      h('header', {}, h('h3', {}, 'Quota model')),
      h('div', { class: 'body' },
        h('p', { class: 'small muted' },
          'Bandwidth is summed from the per-credential windows nodes report, over a rolling 30-day window. ' +
          'The free tier is capped at 10 GiB; standard and pro are unlimited. Report deduplication is keyed on ' +
          '(credential, window start, window end), so node retries never double-count.'),
      ),
    ),
    h('div', { class: 'panel' },
      h('header', {}, h('h3', {}, 'Ledger')),
      h('div', { class: 'body' },
        billing
          ? h('div', { class: 'row' },
              badge(`open: ${billing.checkouts.open}`),
              badge(`paid: ${billing.checkouts.paid}`),
              badge(`expired: ${billing.checkouts.expired}`),
              h('span', { class: 'muted small' }, `gross ${money(billing.revenue.grossMinor, billing.revenue.currency)}`),
            )
          : h('div', { class: 'muted' }, 'Billing summary unavailable.'),
      ),
    ),
    h('div', { class: 'panel' },
      h('header', {}, h('h3', {}, 'Fleet')),
      h('div', { class: 'table-wrap' },
        (nodes.nodes ?? []).length === 0
          ? h('div', { class: 'empty' }, 'No nodes in the fleet.')
          : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Node'),
                h('th', {}, 'Region'),
                h('th', {}, 'Status'),
                h('th', {}, 'Reported load'),
              )),
              h('tbody', {}, ...nodes.nodes.map((n) => h('tr', {},
                h('td', {}, n.hostname),
                h('td', { class: 'small' }, n.region),
                h('td', {}, badge(n.status)),
                h('td', {}, h('span', { class: 'small' }, `${n.loadScore}%`)),
              ))),
            ),
      ),
    ),
  );
  return host;
}
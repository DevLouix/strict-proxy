/**
 * Admin dashboard views.
 *
 * Each view is an async function that fetches its own data and returns a DOM
 * node, so the shell only has to swap the main region. Errors are surfaced as
 * toasts rather than blank screens.
 */
import { h, mount, bytes, money, date, ago, badge, toast, confirmDialog, copyText, emailInput } from './dom.js';

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

/**
 * Opens one account in full: subscription, devices, credentials, payments and
 * recent operator actions, plus the out-of-band password reset the admin API
 * already supported but had no control for.
 */
function userDetailDialog(api, user, onChanged) {
  const body = h('div', { class: 'dlg-body' }, h('p', { class: 'muted small' }, 'Loading account…'));
  const tokenBox = h('div', { class: 'stack' });
  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, user.email)),
    body,
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();

  async function load() {
    let data;
    try {
      data = await api.get(`/api/v1/admin/users/${encodeURIComponent(user.id)}`);
    } catch (err) {
      mount(body, h('div', { class: 'empty' }, err.message || 'Could not load this account.'));
      return;
    }

    const { user: account = user, subscription, devices = [], credentials = [], checkouts = [], audit = [] } = data;

    const reset = h('button', { class: 'btn sm' }, 'Issue password reset');
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      reset.textContent = 'Issuing…';
      try {
        const issued = await api.post(`/api/v1/admin/users/${encodeURIComponent(user.id)}/password-reset`, {});
        mount(tokenBox,
          h('p', { class: 'muted small' }, `One-time token, shown once. Expires ${date(issued.expiresAt)}.`),
          h('div', { class: 'copy' }, issued.token),
          h('button', { class: 'btn sm', onClick: () => copyText(issued.token) }, 'Copy token'),
        );
        toast('Reset token issued');
        if (onChanged) await onChanged();
      } catch (err) {
        toast(err.message || 'Could not issue a reset token', 'err');
        reset.disabled = false;
        reset.textContent = 'Issue password reset';
      }
    });

    mount(body,
      h('div', { class: 'row' }, badge(account.role ?? 'user'), account.disabledAt ? badge('disabled') : badge('active')),
      h('table', {},
        h('tbody', {}, ...[...[
          ['User id', account.id],
          ['Email', account.email],
          ['Role', account.role],
          ['Created', date(account.createdAt)],
          ['Tier', subscription?.tier ?? 'free'],
          ['Subscription', subscription?.status ?? '—'],
          ['Period ends', subscription ? date(subscription.currentPeriodEnd) : '—'],
          ['Auto-renew', subscription?.providerSubscriptionId ? 'yes' : 'no'],
        ].map(([label, value]) => h('tr', {},
          h('th', { class: 'small muted', style: 'width:160px;text-align:left' }, label),
          h('td', { class: 'small' }, value ?? '—'),
        ))]),
      ),
      h('h4', {}, 'Devices'),
      devices.length === 0
        ? h('div', { class: 'empty' }, 'No devices have signed in.')
        : h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Name'), h('th', {}, 'Last seen'))),
              h('tbody', {}, ...devices.map((d) => h('tr', {},
                h('td', { class: 'small mono' }, d.deviceId),
                h('td', { class: 'small' }, d.deviceName ?? '—'),
                h('td', { class: 'small muted', title: date(d.lastSeenAt) }, ago(d.lastSeenAt)),
              ))),
            ),
          ),
      h('h4', {}, 'Node credentials'),
      credentials.length === 0
        ? h('div', { class: 'empty' }, 'No node credentials issued.')
        : h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Region'), h('th', {}, 'State'), h('th', {}, 'Used'))),
              h('tbody', {}, ...credentials.map((c) => h('tr', {},
                h('td', {}, h('div', {}, c.hostname), h('span', { class: 'muted small mono' }, c.nodeId)),
                h('td', { class: 'small' }, c.region),
                h('td', {}, badge(c.revoked ? 'revoked' : 'active')),
                h('td', { class: 'small' }, bytes(c.bytesUsed)),
              ))),
            ),
          ),
      h('h4', {}, 'Payments'),
      checkouts.length === 0
        ? h('div', { class: 'empty' }, 'No checkouts.')
        : h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Reference'), h('th', {}, 'Plan'), h('th', {}, 'Amount'), h('th', {}, 'Status'), h('th', {}, 'Created'))),
              h('tbody', {}, ...checkouts.map((c) => h('tr', {},
                h('td', { class: 'mono small' }, c.reference),
                h('td', {}, badge(c.tier)),
                h('td', { class: 'small' }, money(c.amountMinor, c.currency)),
                h('td', {}, badge(c.status)),
                h('td', { class: 'small muted' }, date(c.createdAt)),
              ))),
            ),
          ),
      h('h4', {}, 'Recent operator actions'),
      audit.length === 0
        ? h('div', { class: 'empty' }, 'Nothing recorded against this account.')
        : h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Actor'), h('th', {}, 'Action'), h('th', {}, 'Summary'))),
              h('tbody', {}, ...audit.map((e) => h('tr', {},
                h('td', { class: 'small muted', title: date(e.createdAt) }, ago(e.createdAt)),
                h('td', { class: 'small' }, e.actorEmail ?? '—'),
                h('td', { class: 'small mono' }, e.action),
                h('td', { class: 'small' }, e.summary),
              ))),
            ),
          ),
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Recovery')),
        h('div', { class: 'body' },
          h('p', { class: 'muted small' },
            'Issuing a reset token does not sign the user out by itself. The token is single-use and short-lived; relay it out of band.'),
          h('div', { class: 'actions' }, reset),
          tokenBox,
        ),
      ),
    );
  }

  void load();
}

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

  /**
   * Creates an account without leaving the dashboard.
   *
   * Only the fields the server requires are collected; the account starts on
   * the free tier, and the password is stored hashed, so the copy says to share
   * it now rather than implying it can be read back later.
   */
  function createUserDialog() {
    const email = emailInput({ placeholder: 'user@example.com', autocomplete: 'off' });
    const password = h('input', { type: 'password', placeholder: 'at least 10 characters', autocomplete: 'new-password' });
    const role = h('select', {},
      h('option', { value: 'user' }, 'User'),
      h('option', { value: 'admin' }, 'Administrator'),
    );
    // Set after the options exist: the browser default is the first option, but
    // the DOM shim used by the tests has no such default.
    role.value = 'user';
    const error = h('p', { class: 'muted small', style: 'min-height:18px' });
    const submit = h('button', { class: 'btn primary', type: 'button' }, 'Create user');

    const dlg = h('dialog', {},
      h('div', { class: 'dlg-head' }, h('h3', {}, 'Create user')),
      h('div', { class: 'dlg-body' },
        h('label', { class: 'field' }, h('span', {}, 'Email'), email),
        h('label', { class: 'field' }, h('span', {}, 'Password'), password),
        h('label', { class: 'field' }, h('span', {}, 'Role'), role),
        h('p', { class: 'muted small' },
          'The account starts on the free tier. Share the password now: it is stored hashed and cannot be read back.'),
        error,
      ),
      h('div', { class: 'dlg-foot' },
        h('button', { class: 'btn', onClick: () => dlg.close() }, 'Cancel'),
        submit,
      ),
    );

    submit.addEventListener('click', async () => {
      error.textContent = '';
      submit.disabled = true;
      try {
        await api.post('/api/v1/admin/users', {
          email: email.value.trim(),
          password: password.value,
          role: role.value,
        });
        toast('User created');
        dlg.close();
        await load();
      } catch (err) {
        error.textContent = err.message || 'Could not create the user';
        submit.disabled = false;
      }
    });

    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove(), { once: true });
    dlg.showModal();
    email.focus?.();
  }

  function draw() {
    const list = visible();
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Users'),
          h('p', {}, 'Accounts, roles and subscription state.'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', onClick: createUserDialog }, 'Create user'),
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
        ),
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
                  h('button', { class: 'btn sm', onClick: () => userDetailDialog(api, u, load) }, 'Details'),
                  ' ',
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

/** Shows a replacement token exactly once, with its expiry and copy control. */
function showRotatedEnrollmentToken({ token, expiresAt }) {
  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, 'Replacement enrollment token')),
    h('div', { class: 'dlg-body' },
      h('p', { class: 'muted small' }, 'The previous token is revoked. Copy the replacement now — it is shown once.'),
      h('div', { class: 'copy' }, token),
      h('button', { class: 'btn sm', onClick: () => copyText(token) }, 'Copy token'),
      h('p', { class: 'muted small' }, `Expires ${date(expiresAt)}.`),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
}

/**
 * Edits the fleet-facing fields of a node. Credentials, status and REALITY keys
 * are deliberately not here: draining has its own control, and rotating the
 * signing material is a separate, audited action.
 */
function editNodeDialog(api, node, onSaved) {
  const hostname = h('input', { value: node.hostname });
  const region = h('input', { value: node.region });
  const label = h('input', { value: node.label ?? '', placeholder: 'Optional display label' });
  const publicIp = h('input', { value: node.publicIp, placeholder: '203.0.113.10' });
  const tunnelPort = h('input', { type: 'number', min: '1', max: '65535', value: String(node.tunnelPort) });

  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, `Edit ${node.hostname}`)),
    h('div', { class: 'dlg-body' },
      h('label', { class: 'field' }, h('span', {}, 'Hostname'), hostname),
      h('label', { class: 'field' }, h('span', {}, 'Region'), region),
      h('label', { class: 'field' }, h('span', {}, 'Label'), label),
      h('label', { class: 'field' }, h('span', {}, 'Public IP'), publicIp),
      h('label', { class: 'field' }, h('span', {}, 'Tunnel port'), tunnelPort),
      h('p', { class: 'muted small' },
        'Saving a public IP marks it as admin-set, which overrides auto-detection until the node reports a new address.'),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const nextHostname = hostname.value.trim();
          const nextRegion = region.value.trim();
          const nextIp = publicIp.value.trim();
          const nextPort = Number(tunnelPort.value);
          if (!nextHostname || !nextRegion) {
            toast('Hostname and region are required', 'err');
            return;
          }
          if (!nextIp) {
            toast('Public IP is required', 'err');
            return;
          }
          if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) {
            toast('Tunnel port must be an integer from 1 to 65535', 'err');
            return;
          }
          try {
            await api.patch(`/api/v1/admin/nodes/${node.id}`, {
              hostname: nextHostname,
              region: nextRegion,
              label: label.value.trim() || null,
              publicIp: nextIp,
              tunnelPort: nextPort,
            });
            dlg.close();
            toast('Node updated');
            await onSaved();
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

/** Shows a freshly issued node secret exactly once, with the update steps. */
function showRotatedNodeSecret({ hostname, secret, previousValidUntil }) {
  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, `New secret — ${hostname}`)),
    h('div', { class: 'dlg-body' },
      h('p', { class: 'muted small' }, 'Shown once. Copy it now — it cannot be read back.'),
      h('div', { class: 'copy' }, secret),
      h('button', { class: 'btn sm', onClick: () => copyText(secret) }, 'Copy secret'),
      h('p', { class: 'muted small' },
        previousValidUntil
          ? `The old secret stops working ${date(previousValidUntil)}. Set NODE_HMAC_SECRET on the node (or in its identity file) and restart the agent before then.`
          : 'The old secret stopped working immediately. Set NODE_HMAC_SECRET on the node (or in its identity file) and restart the agent.'),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
}

/**
 * Rotates a node's HMAC secret in place. The old secret keeps working for the
 * chosen grace window so the operator can update the agent and restart it
 * without the node going offline in between; zero is for a leaked secret.
 */
function nodeLogsDialog(api, node) {
  const body = h('div', { class: 'dlg-body' }, h('p', { class: 'muted small' }, 'Asking the node for its recent log lines. The node answers on its next heartbeat, so this can take up to a minute.'));
  // Filled once the lines arrive. Staying disabled until then keeps a click
  // during the wait from copying an empty string and reporting success.
  let text = '';
  const copyBtn = h('button', { class: 'btn', disabled: true, onClick: () => copyText(text) }, 'Copy');
  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' },
      h('h3', {}, `Logs: ${node.hostname}`),
      // Names the build whose lines these are. A node on an image too old to
      // report one shows nothing rather than a placeholder it never sent.
      node.agentBuild ? h('p', { class: 'muted small mono' }, `agent build ${node.agentBuild}`) : null,
    ),
    body,
    h('div', { class: 'dlg-foot' },
      copyBtn,
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
  api.get(`/api/v1/admin/nodes/${encodeURIComponent(node.id)}/logs`)
    .then((data) => {
      const lines = data.lines || [];
      text = lines.map((l) => `${l.at} [${l.level}] ${l.msg}`).join('\n');
      copyBtn.disabled = lines.length === 0;
      body.replaceChildren(lines.length === 0
        ? h('div', { class: 'empty' }, 'The node sent no log lines.')
        : h('pre', { class: 'mono small logs' }, text));
    })
    .catch((err) => {
      body.replaceChildren(
        h('p', { class: 'muted small' }, err.message || 'Could not fetch the node logs.'),
        // A 55s wait that ends in a dead end is what made this button feel
        // broken; the same request is worth one more tap once the cause named
        // above has been dealt with.
        h('button', {
          class: 'btn sm',
          onClick: () => {
            dlg.close();
            nodeLogsDialog(api, node);
          },
        }, 'Try again'),
      );
    });
}

function rotateNodeSecretDialog(api, node, onRotated) {
  const grace = h('input', { type: 'number', min: '0', max: '168', value: '24' });
  const submit = h('button', { class: 'btn danger' }, 'Rotate secret');

  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, `Rotate secret — ${node.hostname}`)),
    h('div', { class: 'dlg-body' },
      h('p', {}, 'Issuing a new HMAC secret invalidates the current one after a grace window.'),
      h('label', { class: 'field' }, h('span', {}, 'Hours the old secret keeps working (0–168)'), grace),
      h('p', { class: 'muted small' },
        'Use 0 if the current secret has already leaked. The new secret is shown once.'),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Cancel'),
      submit,
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();

  submit.addEventListener('click', async () => {
    const hours = Number(grace.value);
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      toast('Grace must be between 0 and 168 hours', 'err');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Rotating…';
    try {
      const res = await api.post(`/api/v1/admin/nodes/${node.id}/rotate-secret`, { graceHours: hours });
      dlg.close();
      showRotatedNodeSecret({ hostname: node.hostname, secret: res.secret, previousValidUntil: res.previousValidUntil });
      toast('Node secret rotated');
      await onRotated();
    } catch (err) {
      toast(err.message, 'err');
      submit.disabled = false;
      submit.textContent = 'Rotate secret';
    }
  });
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
                h('th', {}, 'Tunnel'),
                h('th', {}, 'Status'),
                h('th', {}, 'Load'),
                h('th', {}, 'Usage'),
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
                h('td', {},
                  h('div', { class: 'mono small' }, `${n.publicIp}:${n.tunnelPort}`),
                  n.engineHealthy === false
                    ? h('span', { class: 'muted small' }, 'not offered: engine down')
                    : null,
                ),
                h('td', {}, badge(n.status)),
                h('td', {}, h('span', { class: 'small' }, `${n.loadScore}%`)),
                h('td', { title: `Total ${bytes(n.usageTotalBytes)}; last report ${date(n.usageLastReportedAt)}` },
                  h('div', { class: 'small' }, bytes(n.usage24hBytes), h('span', { class: 'muted' }, ' / 24h')),
                  h('span', { class: 'muted small' }, `${bytes(n.usageTotalBytes)} total`),
                ),
                h('td', { class: 'small muted', title: date(n.lastHeartbeatAt) }, ago(n.lastHeartbeatAt)),
                h('td', {},
                  h('div', { class: 'small muted mono' }, n.engineVersion),
                  h('div', {
                    class: 'small muted mono',
                    title: n.agentBuild
                      ? `Agent image build reported by the node: ${n.agentBuild}`
                      : 'The node has not reported its agent build, so its image predates this field',
                  }, n.agentBuild ? `agent ${n.agentBuild.slice(0, 7)}` : 'agent build unknown'),
                  n.engineHealthy == null
                    ? h('span', { class: 'badge muted', title: 'The agent has not reported engine health yet' }, 'health unknown')
                    : !n.engineHealthy
                      ? h('span', { class: 'badge offline', title: `Engine was not running at the last check (${date(n.engineHealthCheckedAt)})` }, 'engine down')
                      : n.statsApiHealthy === false
                        ? h('span', { class: 'badge degraded', title: `Usage collection failed at the last check (${date(n.engineHealthCheckedAt)})` }, 'usage failing')
                        : h('span', { class: 'badge online', title: `Checked ${date(n.engineHealthCheckedAt)}` }, 'healthy'),
                ),
                h('td', { class: 'actions' },
                  h('button', { class: 'btn sm', onClick: () => nodeLogsDialog(api, n) }, 'Logs'),
                  ' ',
                  h('button', { class: 'btn sm', onClick: () => editNodeDialog(api, n, load) }, 'Edit'),
                  ' ',
                  h('button', { class: 'btn sm', onClick: () => rotateNodeSecretDialog(api, n, load) }, 'Rotate secret'),
                  ' ',
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
          h('button', {
            class: 'btn sm',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Clear finished tokens?',
                body: h('p', {}, 'Deletes every used, revoked or expired token record. Active tokens are kept, so an enrollment in progress still works.'),
                confirmLabel: 'Clear finished',
                danger: true,
              });
              if (!ok) return;
              try {
                const res = await api.del('/api/v1/admin/node-enrollments');
                toast(`${res.deleted ?? 0} finished token${res.deleted === 1 ? '' : 's'} cleared`);
                await load();
              } catch (err) {
                toast(err.message, 'err');
              }
            },
          }, 'Clear finished'),
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
                          class: 'btn sm',
                          onClick: async () => {
                            const ok = await confirmDialog({
                              title: 'Rotate this enrollment token?',
                              body: h('div', {},
                                h('p', {}, `A new token for ${e.region}${e.label ? ` (${e.label})` : ''} replaces this one.`),
                                h('p', { class: 'muted small' }, 'The current token stops working immediately. The replacement keeps the original lifetime and is shown once.'),
                              ),
                              confirmLabel: 'Rotate token',
                            });
                            if (!ok) return;
                            try {
                              const res = await api.post(`/api/v1/admin/node-enrollments/${e.id}/rotate`, {});
                              showRotatedEnrollmentToken({ token: res.token, expiresAt: res.expiresAt });
                              toast('Token rotated');
                              await load();
                            } catch (err) {
                              toast(err.message, 'err');
                            }
                          },
                        }, 'Rotate')
                      : null,
                    !e.usedAt && !expired ? ' ' : null,
                    h('button', {
                      class: 'btn sm danger',
                      onClick: async () => {
                        const active = !e.usedAt && !expired;
                        const ok = await confirmDialog({
                          title: active ? 'Delete this active token?' : 'Delete this token record?',
                          body: h('p', {}, active
                            ? 'Deleting the token revokes it immediately; it cannot be used to enroll a node.'
                            : 'This removes the finished token from the list. It is already unusable.'),
                          confirmLabel: 'Delete',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await api.del(`/api/v1/admin/node-enrollments/${e.id}`);
                          toast('Enrollment token deleted');
                          await load();
                        } catch (err) {
                          toast(err.message, 'err');
                        }
                      },
                    }, !e.usedAt && !expired ? 'Revoke & delete' : 'Delete'),
                  ),
                );
              })),
            ),
        ),
      ),
    );
  }

  mount(host, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  await load();
  return host;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Refunds a settled checkout. The control states what a full refund does before
 * it is issued: cancelling access is a consequence, not a hidden side effect.
 */
function refundDialog(api, checkout, reload) {
  const amount = h('input', { type: 'number', min: '0.01', step: '0.01', value: (checkout.amountMinor / 100).toFixed(2) });
  const full = h('input', { type: 'checkbox', checked: true });
  const reason = h('input', { placeholder: 'Reason recorded with the refund (optional)' });
  const warning = h('p', { class: 'muted small' });
  const submit = h('button', { class: 'btn danger' }, 'Issue refund');

  const explain = () => {
    amount.disabled = full.checked;
    warning.textContent = full.checked
      ? 'A full refund cancels the subscription, revokes every node credential and refresh token, and stops service immediately.'
      : 'A partial refund leaves the subscription and access in place.';
  };
  full.addEventListener('change', explain);
  explain();

  const dlg = h('dialog', {},
    h('div', { class: 'dlg-head' }, h('h3', {}, `Refund ${checkout.reference}`)),
    h('div', { class: 'dlg-body' },
      h('p', { class: 'small' },
        `${checkout.user?.email ?? 'unknown customer'} · ${money(checkout.amountMinor, checkout.currency)} · ${checkout.tier}`),
      h('label', { class: 'inline' }, full, h('span', { class: 'small' }, 'Refund the full amount')),
      h('label', { class: 'field' }, h('span', {}, `Amount (${checkout.currency})`), amount),
      h('label', { class: 'field' }, h('span', {}, 'Reason'), reason),
      warning,
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Cancel'),
      submit,
    ),
  );

  submit.addEventListener('click', async () => {
    const partial = Math.round(Number(amount.value) * 100);
    if (!full.checked && (!Number.isFinite(partial) || partial <= 0 || partial > checkout.amountMinor)) {
      toast(`Enter an amount between 0.01 and ${(checkout.amountMinor / 100).toFixed(2)} ${checkout.currency}`, 'err');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Refunding…';
    try {
      const result = await api.post('/api/v1/admin/billing/refund', {
        reference: checkout.reference,
        ...(full.checked ? {} : { amountMinor: partial }),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
      });
      toast(result.accessRevoked ? 'Full refund issued; access revoked' : 'Refund issued');
      dlg.close();
      await reload();
    } catch (err) {
      toast(err.message || 'Refund failed', 'err');
      submit.disabled = false;
      submit.textContent = 'Issue refund';
    }
  });

  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
}

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
                h('th', { class: 'right' }, 'Actions'),
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
                h('td', { class: 'actions' },
                  c.status === 'paid'
                    ? h('button', { class: 'btn sm', onClick: () => refundDialog(api, c, load) }, 'Refund')
                    : h('span', { class: 'muted small' }, '—'),
                ),
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
          'Free accounts are not served a tunnel; standard and pro are unlimited. Report deduplication is keyed on ' +
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
                h('th', {}, 'Last 24h'),
                h('th', {}, 'Total'),
                h('th', {}, 'Last report'),
              )),
              h('tbody', {}, ...nodes.nodes.map((n) => h('tr', {},
                h('td', {}, n.hostname),
                h('td', { class: 'small' }, n.region),
                h('td', {}, badge(n.status)),
                h('td', {}, h('span', { class: 'small' }, `${n.loadScore}%`)),
                h('td', { class: 'small' }, bytes(n.usage24hBytes)),
                h('td', { class: 'small' }, bytes(n.usageTotalBytes)),
                h('td', { class: 'small muted' }, ago(n.usageLastReportedAt)),
              ))),
            ),
      ),
    ),
  );
  return host;
}
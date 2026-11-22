/**
 * Operator-managed gated links & Gatekeeper site integration kit.
 *
 * Operators publish sites they have placed behind the Gatekeeper middleware,
 * naming the minimum plan each site accepts. This screen also surfaces the
 * live Ed25519 public key, active exit node IPs, and ready-to-paste snippets
 * for Node/Express (`@strict-proxy/gatekeeper`), Caddy, and Nginx.
 */
import { h, mount, badge, date, toast, confirmDialog, copyText } from './dom.js';

const TIERS = ['standard', 'pro'];

/** Create/edit dialog. `link` is null when publishing a new one. */
function linkDialog(api, link, onSaved) {
  const title = h('input', { value: link?.title ?? '', placeholder: 'Partner portal' });
  const url = h('input', {
    value: link?.url ?? '',
    placeholder: 'https://partner.example.com',
  });
  const description = h('textarea', {
    rows: '3',
    placeholder: 'What this site is for (optional)',
  });
  description.value = link?.description ?? '';
  const tier = h('select', {},
    ...TIERS.map((t) => h('option', { value: t, selected: (link?.requiredTier ?? 'standard') === t }, t)),
  );
  const order = h('input', {
    type: 'number',
    value: String(link?.sortOrder ?? 0),
    min: '-10000',
    max: '10000',
  });
  const active = h('input', { type: 'checkbox', checked: link?.active ?? true });

  const submit = h('button', { class: 'btn primary' }, link ? 'Save link' : 'Publish link');

  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, link ? `Edit ${link.title}` : 'Publish a gated link')),
    h('div', { class: 'dlg-body' },
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'URL'), url),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      h('label', { class: 'field' }, h('span', {}, 'Minimum plan'), tier),
      h('label', { class: 'field' }, h('span', {}, 'Sort order (lower first)'), order),
      h('label', { class: 'row small' }, active, ' visible to users'),
      h('p', { class: 'muted small' },
        'The site must already be protected by the Gatekeeper with the same requiredTier. '
        + 'Opening a link from the app carries a short-lived ticket; the Gatekeeper validates it '
        + 'and stores an HttpOnly session cookie so browsing the site keeps working seamlessly.'),
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
    const body = {
      title: title.value.trim(),
      url: url.value.trim(),
      description: description.value.trim() || null,
      requiredTier: tier.value,
      sortOrder: Number(order.value),
      active: active.checked,
    };
    if (!body.title) {
      toast('A title is required', 'err');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      if (link) await api.patch(`/api/v1/admin/links/${link.id}`, body);
      else await api.post('/api/v1/admin/links', body);
      dlg.close();
      toast(link ? 'Link updated' : 'Link published');
      await onSaved();
    } catch (err) {
      toast(err.message, 'err');
      submit.disabled = false;
      submit.textContent = link ? 'Save link' : 'Publish link';
    }
  });
}

function controllerOrigin() {
  try {
    if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
      return location.origin;
    }
  } catch {
    // non-browser test environment
  }
  return 'https://controller.example.com';
}

function expressSnippet(gk, requiredTier) {
  const origin = controllerOrigin();
  const keyId = gk?.keyId ?? 'primary';
  const tierLine = requiredTier === 'proxy-only'
    ? '  // Proxy-only mode: any user connected through your StrictProxy fleet is admitted.'
    : `  requiredTier: '${requiredTier}', // admits ${requiredTier === 'pro' ? 'pro only' : 'standard and pro'}`;
  return [
    "import express from 'express';",
    "import { createGatekeeperMiddleware } from '@strict-proxy/gatekeeper';",
    '',
    'const app = express();',
    '',
    'app.use(createGatekeeperMiddleware({',
    `  controllerBaseUrl: process.env.STRICT_PROXY_CONTROLLER_URL ?? '${origin}',`,
    '  publicKeys: {',
    `    ${JSON.stringify(keyId)}: process.env.STRICT_PROXY_PUBLIC_KEY_PEM!,`,
    '  },',
    tierLine,
    '  trustForwardedFor: true,',
    '  trustedProxyHops: 1, // set to the number of reverse proxies in front of your app',
    "  failureMode: 'closed',",
    '}));',
    '',
    "app.get('/', (req, res) => {",
    '  res.json({ ok: true, user: req.strictProxy ?? null });',
    '});',
  ].join('\n');
}

function caddySnippet(gk) {
  const ips = (gk?.allowedIps ?? []).map((n) => n.publicIp).filter(Boolean);
  const ipList = ips.length ? ips.join(' ') : 'YOUR_PROXY_NODE_IP';
  return [
    '# Caddyfile — proxy-only IP gate (pair with @strict-proxy/gatekeeper for per-plan gating)',
    'private.example.com {',
    `  @strict_proxy remote_ip ${ipList}`,
    '  handle @strict_proxy {',
    '    reverse_proxy 127.0.0.1:4000',
    '  }',
    '  handle {',
    '    respond "Connect to StrictProxy to access this site." 403',
    '  }',
    '}',
  ].join('\n');
}

function nginxSnippet(gk) {
  const ips = (gk?.allowedIps ?? []).map((n) => n.publicIp).filter(Boolean);
  const allowLines = (ips.length ? ips : ['YOUR_PROXY_NODE_IP']).map((ip) => `    allow ${ip};`);
  return [
    '# Nginx server block — proxy-only IP gate',
    'server {',
    '  listen 443 ssl;',
    '  server_name private.example.com;',
    '',
    '  location / {',
    ...allowLines,
    '    deny all;',
    '    proxy_pass http://127.0.0.1:4000;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '  }',
    '}',
  ].join('\n');
}

export async function linksView(api) {
  const host = h('div', {});
  let rows = [];
  let gatekeeper = null;
  let snippetKind = 'express';
  let snippetTier = 'standard';

  async function load() {
    const [linksData, gkData] = await Promise.all([
      api.get('/api/v1/admin/links'),
      api.get('/api/v1/admin/gatekeeper').catch(() => null),
    ]);
    rows = linksData.links ?? [];
    gatekeeper = gkData;
    draw();
  }

  async function remove(link) {
    const ok = await confirmDialog({
      title: 'Delete this link?',
      body: h('p', {}, `“${link.title}” disappears from every user’s Links screen. The site itself stays protected by the Gatekeeper.`),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/admin/links/${link.id}`);
      toast('Link deleted');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function toggleActive(link) {
    try {
      await api.patch(`/api/v1/admin/links/${link.id}`, { active: !link.active });
      toast(link.active ? 'Link hidden from users' : 'Link visible to users');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function gatekeeperPanel() {
    const ips = gatekeeper?.allowedIps ?? [];
    const origin = controllerOrigin();
    const publicIpsUrl = `${origin}${gatekeeper?.publicIpsPath ?? '/api/v1/network/nodes/public-ips'}`;
    const snippetText = snippetKind === 'caddy'
      ? caddySnippet(gatekeeper)
      : snippetKind === 'nginx'
        ? nginxSnippet(gatekeeper)
        : expressSnippet(gatekeeper, snippetTier);

    const tierSelect = h('select', {
      class: 'snippet-select',
      'aria-label': 'Snippet tier mode',
      onChange: (e) => {
        snippetTier = e.target.value;
        draw();
      },
    },
      h('option', { value: 'proxy-only', selected: snippetTier === 'proxy-only' }, 'Proxy-only (any connected user)'),
      h('option', { value: 'standard', selected: snippetTier === 'standard' }, 'Standard & Pro plans'),
      h('option', { value: 'pro', selected: snippetTier === 'pro' }, 'Pro plan only'),
    );

    const tabBtn = (id, label) => h('button', {
      class: `btn sm${snippetKind === id ? ' primary' : ''}`,
      type: 'button',
      onClick: () => {
        snippetKind = id;
        draw();
      },
    }, label);

    return h('div', { class: 'panel' },
      h('header', {},
        h('h3', {}, 'Protect a site (Gatekeeper setup)'),
        h('span', { class: 'muted small' },
          gatekeeper ? `Key ID: ${gatekeeper.keyId}` : 'Ed25519 signed allowlist'),
      ),
      h('div', { class: 'body stack' },
        h('p', { class: 'muted small', style: 'margin:0' },
          'Sites protected with the Gatekeeper only admit traffic exiting your StrictProxy nodes. '
          + 'Set requiredTier to standard or pro to enforce subscriptions offline, then publish the URL below so users can open it with a one-click ticket.'),
        gatekeeper && ips.length === 0
          ? h('div', { class: 'notice warn' },
              'No online proxy nodes are enrolled yet. Enroll and bring at least one node online so the Gatekeeper allowlist has exit IPs to admit.')
          : null,
        gatekeeper
          ? h('div', { class: 'grid-2' },
              h('div', { class: 'stack' },
                h('div', { class: 'row', style: 'justify-content:space-between' },
                  h('span', { class: 'small muted' }, `Active exit IPs (${ips.length})`),
                  h('button', {
                    class: 'btn sm',
                    type: 'button',
                    onClick: () => copyText(publicIpsUrl, 'Allowlist URL copied'),
                  }, 'Copy allowlist URL'),
                ),
                ips.length
                  ? h('div', { class: 'row' },
                      ...ips.map((n) => h('span', { class: 'badge online mono' }, `${n.publicIp} · ${n.region}`)),
                    )
                  : h('span', { class: 'muted small' }, 'No active exit IPs yet.'),
                h('div', { class: 'small muted mono', style: 'overflow-wrap:anywhere' }, publicIpsUrl),
              ),
              h('div', { class: 'stack' },
                h('div', { class: 'row', style: 'justify-content:space-between' },
                  h('span', { class: 'small muted' }, `Signing public key (${gatekeeper.algorithm})`),
                  h('button', {
                    class: 'btn sm',
                    type: 'button',
                    onClick: () => copyText(gatekeeper.publicKeyPem, 'Public key copied'),
                  }, 'Copy public key'),
                ),
                h('pre', { class: 'copy', style: 'margin:0;max-height:110px;overflow:auto' }, gatekeeper.publicKeyPem),
              ),
            )
          : null,
        h('div', { class: 'snippet-bar' },
          h('div', { class: 'row' },
            tabBtn('express', 'Express / Node'),
            tabBtn('caddy', 'Caddy'),
            tabBtn('nginx', 'Nginx'),
          ),
          h('div', { class: 'row' },
            snippetKind === 'express' ? tierSelect : null,
            h('button', {
              class: 'btn sm',
              type: 'button',
              onClick: () => copyText(snippetText, 'Integration snippet copied'),
            }, 'Copy snippet'),
          ),
        ),
        h('pre', { class: 'copy', style: 'margin:0;overflow:auto' }, snippetText),
      ),
    );
  }

  function draw() {
    const standard = rows.filter((r) => r.requiredTier === 'standard').length;
    const pro = rows.filter((r) => r.requiredTier === 'pro').length;
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Links'),
          h('p', {}, 'Sites you gate with StrictProxy, published to accounts by plan.'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
          h('button', { class: 'btn primary sm', onClick: () => linkDialog(api, null, load) }, 'Publish link'),
        ),
      ),
      gatekeeperPanel(),
      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Published sites'),
          h('div', { class: 'row' },
            badge(`standard: ${standard}`),
            badge(`pro: ${pro}`),
            h('span', { class: 'muted small' }, `${rows.length} total`),
          ),
        ),
        h('div', { class: 'table-wrap' },
          rows.length === 0
            ? h('div', { class: 'empty' }, 'No links published yet.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Title'),
                h('th', {}, 'URL'),
                h('th', {}, 'Plan'),
                h('th', {}, 'Order'),
                h('th', {}, 'State'),
                h('th', {}, 'Updated'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...rows.map((link) => h('tr', {},
                h('td', {},
                  h('div', {}, link.title),
                  link.description ? h('span', { class: 'muted small' }, link.description) : null,
                ),
                h('td', { class: 'small mono' }, link.url),
                h('td', {}, badge(link.requiredTier)),
                h('td', { class: 'small muted' }, String(link.sortOrder ?? 0)),
                h('td', {}, badge(link.active ? 'active' : 'hidden')),
                h('td', { class: 'small muted' }, date(link.updatedAt)),
                h('td', { class: 'actions' },
                  h('button', { class: 'btn sm', onClick: () => linkDialog(api, link, load) }, 'Edit'),
                  ' ',
                  h('button', { class: 'btn sm', onClick: () => toggleActive(link) }, link.active ? 'Hide' : 'Show'),
                  ' ',
                  h('button', { class: 'btn sm danger', onClick: () => remove(link) }, 'Delete'),
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

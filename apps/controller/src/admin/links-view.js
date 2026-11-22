/**
 * Gated links, Gatekeeper Key Factory, and site integration kit.
 *
 * Operators issue per-site API keys (`sp_gk_...`) from the Key Factory, grab
 * ready-to-paste snippets for Node/Python/Caddy/Nginx, and publish sites they
 * have placed behind the Gatekeeper middleware so users can open them with a
 * one-click ticket.
 */
import { h, mount, badge, date, ago, toast, confirmDialog, copyText } from './dom.js';

const TIERS = ['standard', 'pro'];

/** Create/edit link dialog. `link` is null when publishing a new one. */
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

/** One-time secret reveal dialog after creating or rotating a site key. */
function passRedirectUrlFor(keyMeta) {
  const origin = controllerOrigin();
  return `${origin}/pass?site=${encodeURIComponent(keyMeta.keyPrefix)}`;
}

function secretRevealDialog(heading, keyMeta, secret) {
  const origin = controllerOrigin();
  const envLines = [
    `STRICT_PROXY_CONTROLLER_URL=${origin}`,
    `STRICT_PROXY_GATEKEEPER_KEY=${secret}`,
  ];
  if (keyMeta.siteUrl) {
    envLines.push(`STRICT_PROXY_ENTITLEMENT_REDIRECT_URL=${passRedirectUrlFor(keyMeta)}`);
  }
  const envSnippet = envLines.join('\n');

  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, heading)),
    h('div', { class: 'dlg-body stack' },
      h('div', { class: 'notice warn' },
        `Save this key for “${keyMeta.name}” now — for security, the raw secret is only shown once and cannot be read back later.`),
      h('div', { class: 'stack' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', { class: 'small muted' }, 'Site API key (single-line secret)'),
          h('button', {
            class: 'btn sm primary',
            type: 'button',
            onClick: () => copyText(secret, 'Site API key copied'),
          }, 'Copy key'),
        ),
        h('pre', { class: 'copy', style: 'margin:0;overflow:auto' }, secret),
      ),
      h('div', { class: 'stack' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('span', { class: 'small muted' }, 'Ready-to-paste .env variables'),
          h('button', {
            class: 'btn sm',
            type: 'button',
            onClick: () => copyText(envSnippet, '.env snippet copied'),
          }, 'Copy .env'),
        ),
        h('pre', { class: 'copy', style: 'margin:0;overflow:auto' }, envSnippet),
      ),
    ),
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn primary', onClick: () => dlg.close() }, 'Done'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();
}

/** Key Factory creation dialog. */
function createKeyDialog(api, onCreated) {
  const name = h('input', { placeholder: 'e.g. Partner Portal' });
  const siteUrl = h('input', { placeholder: 'https://partner.example.com (recommended for plan-pass redirect)' });
  const note = h('input', { placeholder: 'Internal notes (optional)' });
  const expiry = h('select', {},
    h('option', { value: '', selected: true }, 'Never expires'),
    h('option', { value: '30' }, '30 days'),
    h('option', { value: '90' }, '90 days'),
    h('option', { value: '365' }, '1 year'),
  );
  const submit = h('button', { class: 'btn primary' }, 'Generate site key');

  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, 'Create Gatekeeper site key')),
    h('div', { class: 'dlg-body' },
      h('label', { class: 'field' }, h('span', {}, 'Site name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Site URL (origin for browser pass handoff)'), siteUrl),
      h('label', { class: 'field' }, h('span', {}, 'Note (optional)'), note),
      h('label', { class: 'field' }, h('span', {}, 'Expiration'), expiry),
      h('p', { class: 'muted small' },
        'Generates a single-line sp_gk_… secret for this site. Setting Site URL locks '
        + 'browser plan-pass redirects (/pass) strictly to your site’s origin so visitors '
        + 'arriving via bookmarks can sign in once and return with a signed pass automatically.'),
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
    const trimmedName = name.value.trim();
    if (!trimmedName) {
      toast('Site name is required', 'err');
      return;
    }
    const payload = {
      name: trimmedName,
      siteUrl: siteUrl.value.trim() || null,
      note: note.value.trim() || null,
      ...(expiry.value ? { expiresInDays: Number(expiry.value) } : {}),
    };
    submit.disabled = true;
    submit.textContent = 'Generating…';
    try {
      const created = await api.post('/api/v1/admin/gatekeeper/keys', payload);
      dlg.close();
      toast('Site key created');
      await onCreated();
      secretRevealDialog('New Gatekeeper site key', created.key, created.secret);
    } catch (err) {
      toast(err.message, 'err');
      submit.disabled = false;
      submit.textContent = 'Generate site key';
    }
  });
}

/** Edit site key metadata (name, siteUrl, note) without rotating the secret. */
function editKeyDialog(api, item, onSaved) {
  const name = h('input', { value: item.name ?? '' });
  const siteUrl = h('input', { value: item.siteUrl ?? '', placeholder: 'https://partner.example.com' });
  const note = h('input', { value: item.note ?? '', placeholder: 'Optional note' });
  const submit = h('button', { class: 'btn primary' }, 'Save changes');

  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, `Edit ${item.name}`)),
    h('div', { class: 'dlg-body' },
      h('label', { class: 'field' }, h('span', {}, 'Site name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Site URL (origin for /pass handoff)'), siteUrl),
      h('label', { class: 'field' }, h('span', {}, 'Note (optional)'), note),
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
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await api.patch(`/api/v1/admin/gatekeeper/keys/${item.id}`, {
        name: name.value.trim(),
        siteUrl: siteUrl.value.trim() || null,
        note: note.value.trim() || null,
      });
      dlg.close();
      toast('Site key updated');
      await onSaved();
    } catch (err) {
      toast(err.message, 'err');
      submit.disabled = false;
      submit.textContent = 'Save changes';
    }
  });
}

function expressSnippet(gk, requiredTier) {
  const origin = controllerOrigin();
  const tierLine = requiredTier === 'proxy-only'
    ? '  // Proxy-only mode: any user connected through your StrictProxy fleet is admitted.'
    : `  requiredTier: '${requiredTier}', // admits ${requiredTier === 'pro' ? 'pro only' : 'standard and pro'}`;
  return [
    '// npm install @strict-proxy/gatekeeper',
    "import express from 'express';",
    "import { Gatekeeper } from '@strict-proxy/gatekeeper';",
    '',
    'const app = express();',
    '',
    '// 1. Init (using a single-line site key from the Key Factory above)',
    'const gk = Gatekeeper.init({',
    `  controllerUrl: process.env.STRICT_PROXY_CONTROLLER_URL ?? '${origin}',`,
    '  apiKey: process.env.STRICT_PROXY_GATEKEEPER_KEY!, // sp_gk_…',
    tierLine,
    '  trustForwardedFor: true,',
    '  trustedProxyHops: 1, // number of reverse proxies (Caddy/Nginx/Cloudflare) in front of your app',
    '});',
    '',
    '// 2. Auth',
    'app.use(gk.auth());',
    '',
    "app.get('/', (req, res) => {",
    '  res.json({ ok: true, user: req.strictProxy ?? null });',
    '});',
  ].join('\n');
}

function pythonSnippet(gk, requiredTier) {
  const origin = controllerOrigin();
  const tierLine = requiredTier === 'proxy-only'
    ? '    # Proxy-only mode: any user connected through your StrictProxy fleet is admitted.'
    : `    required_tier="${requiredTier}",  # admits ${requiredTier === 'pro' ? 'pro only' : 'standard and pro'}`;
  return [
    '# pip install strict-proxy-gatekeeper',
    'import os',
    'from fastapi import FastAPI, Request',
    'from strict_proxy_gatekeeper import Gatekeeper',
    '',
    'app = FastAPI()',
    '',
    '# 1. Init (using a single-line site key from the Key Factory above)',
    'gk = Gatekeeper.init(',
    `    controller_url=os.environ.get("STRICT_PROXY_CONTROLLER_URL", "${origin}"),`,
    '    api_key=os.environ["STRICT_PROXY_GATEKEEPER_KEY"],  # sp_gk_…',
    tierLine,
    '    trust_forwarded_for=True,',
    '    trusted_proxy_hops=1,  # number of reverse proxies (Caddy/Nginx/Cloudflare) in front of your app',
    ')',
    '',
    '# 2. Auth',
    'app.add_middleware(gk.asgi_middleware())',
    '',
    '@app.get("/")',
    'def index(request: Request):',
    '    return {"ok": True, "user": getattr(request.state, "strict_proxy", None)}',
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
  let siteKeys = [];
  let snippetKind = 'express';
  let snippetTier = 'proxy-only';

  async function load() {
    const [linksData, gkData, keysData] = await Promise.all([
      api.get('/api/v1/admin/links'),
      api.get('/api/v1/admin/gatekeeper').catch(() => null),
      api.get('/api/v1/admin/gatekeeper/keys').catch(() => ({ keys: [] })),
    ]);
    rows = linksData.links ?? [];
    gatekeeper = gkData;
    siteKeys = keysData?.keys ?? [];
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

  async function rotateKey(item) {
    const ok = await confirmDialog({
      title: `Rotate key for “${item.name}”?`,
      body: h('p', {}, 'The old secret stops working immediately. Update STRICT_PROXY_GATEKEEPER_KEY on that site with the new secret.'),
      confirmLabel: 'Rotate key',
    });
    if (!ok) return;
    try {
      const rotated = await api.post(`/api/v1/admin/gatekeeper/keys/${item.id}/rotate`, {});
      toast('Site key rotated');
      await load();
      secretRevealDialog('Rotated Gatekeeper site key', rotated.key, rotated.secret);
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function revokeKey(item) {
    const ok = await confirmDialog({
      title: `Revoke key for “${item.name}”?`,
      body: h('p', {}, 'The site will no longer be able to refresh exit IPs from this controller until a new key is issued or rotated.'),
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/api/v1/admin/gatekeeper/keys/${item.id}/revoke`, {});
      toast('Site key revoked');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function deleteKey(item) {
    const ok = await confirmDialog({
      title: `Delete key “${item.name}”?`,
      body: h('p', {}, 'Permanently removes this key record. Any site still using it will fail closed.'),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/admin/gatekeeper/keys/${item.id}`);
      toast('Site key deleted');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function keyFactoryPanel() {
    const activeCount = siteKeys.filter((k) => k.status === 'active').length;
    return h('div', { class: 'panel' },
      h('header', {},
        h('div', { class: 'row' },
          h('h3', {}, 'Gatekeeper Key Factory (Site API keys)'),
          badge(`${activeCount} active`),
        ),
        h('button', {
          class: 'btn primary sm',
          type: 'button',
          onClick: () => createKeyDialog(api, load),
        }, 'Create site key'),
      ),
      h('div', { class: 'body stack' },
        h('p', { class: 'muted small', style: 'margin:0' },
          'Issue one single-line sp_gk_… secret per gated web app. Pass it as apiKey in the Gatekeeper SDK — '
          + 'it automatically fetches your active exit IPs and controller signing key in one request (never paste a proxy node public key).'),
        h('div', { class: 'table-wrap' },
          siteKeys.length === 0
            ? h('div', { class: 'empty' }, 'No site keys issued yet. Click “Create site key” to generate a single-line secret for your first gated site.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Site'),
                h('th', {}, 'Key prefix'),
                h('th', {}, 'Status'),
                h('th', {}, 'Last used'),
                h('th', {}, 'Expires'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...siteKeys.map((item) => h('tr', {},
                h('td', {},
                  h('div', {}, item.name),
                  item.siteUrl ? h('div', { class: 'small mono muted' }, item.siteUrl) : null,
                  item.note ? h('span', { class: 'muted small' }, item.note) : null,
                ),
                h('td', { class: 'small mono' }, `${item.keyPrefix}_…`),
                h('td', {}, badge(item.status)),
                h('td', { class: 'small muted' },
                  item.lastUsedAt
                    ? `${ago(item.lastUsedAt)}${item.lastUsedIp ? ` · ${item.lastUsedIp}` : ''}`
                    : 'never',
                ),
                h('td', { class: 'small muted' }, item.expiresAt ? date(item.expiresAt) : 'Never'),
                h('td', { class: 'actions' },
                  item.siteUrl
                    ? h('button', {
                        class: 'btn sm',
                        type: 'button',
                        onClick: () => copyText(passRedirectUrlFor(item), 'Pass redirect URL copied'),
                      }, 'Copy pass URL')
                    : null,
                  item.siteUrl ? ' ' : null,
                  h('button', { class: 'btn sm', type: 'button', onClick: () => editKeyDialog(api, item, load) }, 'Edit'),
                  ' ',
                  h('button', { class: 'btn sm', type: 'button', onClick: () => rotateKey(item) }, 'Rotate'),
                  ' ',
                  item.status === 'active'
                    ? h('button', { class: 'btn sm danger', type: 'button', onClick: () => revokeKey(item) }, 'Revoke')
                    : null,
                  item.status === 'active' ? ' ' : null,
                  h('button', { class: 'btn sm danger', type: 'button', onClick: () => deleteKey(item) }, 'Delete'),
                ),
              ))),
            ),
        ),
      ),
    );
  }

  function gatekeeperPanel() {
    const ips = gatekeeper?.allowedIps ?? [];
    const origin = controllerOrigin();
    const bootstrapUrl = `${origin}${gatekeeper?.bootstrapPath ?? '/api/v1/gatekeeper/bootstrap'}`;
    const snippetText = snippetKind === 'python'
      ? pythonSnippet(gatekeeper, snippetTier)
      : snippetKind === 'caddy'
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
          + 'Leave requiredTier unset for proxy-only browsing, or set requiredTier to standard/pro to enforce subscriptions offline via a one-click ticket.'),
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
                    onClick: () => copyText(bootstrapUrl, 'Bootstrap URL copied'),
                  }, 'Copy bootstrap URL'),
                ),
                ips.length
                  ? h('div', { class: 'row' },
                      ...ips.map((n) => h('span', { class: 'badge online mono' }, `${n.publicIp} · ${n.region}`)),
                    )
                  : h('span', { class: 'muted small' }, 'No active exit IPs yet.'),
                h('div', { class: 'small muted mono', style: 'overflow-wrap:anywhere' }, bootstrapUrl),
              ),
              h('div', { class: 'stack' },
                h('div', { class: 'row', style: 'justify-content:space-between' },
                  h('span', { class: 'small muted' }, `Controller signing key (${gatekeeper.algorithm}, optional)`),
                  h('button', {
                    class: 'btn sm',
                    type: 'button',
                    onClick: () => copyText(gatekeeper.publicKeyPem, 'Controller signing key copied'),
                  }, 'Copy signing PEM'),
                ),
                h('pre', { class: 'copy', style: 'margin:0;max-height:110px;overflow:auto' }, gatekeeper.publicKeyPem),
                h('span', { class: 'small muted' },
                  'Only needed if you pin PEMs manually instead of using a site API key. Never use a proxy node public key here.'),
              ),
            )
          : null,
        h('div', { class: 'snippet-bar' },
          h('div', { class: 'row' },
            tabBtn('express', 'Node / npm'),
            tabBtn('python', 'Python / pip'),
            tabBtn('caddy', 'Caddy'),
            tabBtn('nginx', 'Nginx'),
          ),
          h('div', { class: 'row' },
            (snippetKind === 'express' || snippetKind === 'python') ? tierSelect : null,
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
          h('p', {}, 'Issue Gatekeeper site keys, protect web apps, and publish links to accounts by plan.'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
          h('button', { class: 'btn primary sm', onClick: () => linkDialog(api, null, load) }, 'Publish link'),
        ),
      ),
      keyFactoryPanel(),
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

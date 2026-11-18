/**
 * Admin: gated links.
 *
 * A link is published *after* the site has been put behind the Gatekeeper, so
 * this screen is deliberately about discovery, not enforcement: the site's own
 * middleware admits or denies a request, and `requiredTier` here only has to
 * match it so the app can tell users what their plan unlocks.
 */
import { h, mount, badge, date, toast, confirmDialog } from './dom.js';

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
        + 'Opening a link from the app carries a short-lived ticket; the site then admits the '
        + 'request only when the account’s plan meets this minimum.'),
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

export async function linksView(api) {
  const host = h('div', {});
  let rows = [];

  async function load() {
    const data = await api.get('/api/v1/admin/links');
    rows = data.links ?? [];
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
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'How gating works')),
        h('div', { class: 'body' },
          h('p', { class: 'muted small' },
            'Protect the site with the Gatekeeper middleware and set its requiredTier to standard or pro. '
            + 'Then publish it here. Registered users see the link on their Links screen; accounts below '
            + 'the tier see it locked, with a prompt that a higher plan unlocks it.'),
          h('div', { class: 'row' },
            badge(`standard: ${standard}`),
            badge(`pro: ${pro}`),
            h('span', { class: 'muted small' }, `${rows.length} total`),
          ),
        ),
      ),
      h('div', { class: 'panel' },
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

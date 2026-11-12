/**
 * Coupon management: what offers exist, how much they take off, and how many
 * times they have been used.
 *
 * Codes are deliberately local. The customer's discounted amount is decided by
 * the controller, so an operator can create a code without waiting on the
 * payment provider and can stop it with one click. Deactivation keeps the
 * redemptions legible; a code that was used is never deleted out from under its
 * receipts.
 */
import { h, mount, toast, money, badge, date } from './dom.js';

export async function couponsView(api) {
  const host = h('div', {});
  let rows = [];

  async function load() {
    const data = await api.get('/api/v1/admin/coupons');
    rows = data.coupons ?? [];
    draw();
  }

  function amountLabel(c) {
    if (c.kind === 'percent') return `${c.percentOff}% off`;
    return `${money(c.amountOffMinor, c.currency)} off`;
  }

  function draw() {
    const code = h('input', { placeholder: 'WELCOME10', autocomplete: 'off' });
    const kind = h('select', {},
      h('option', { value: 'percent' }, 'Percentage'),
      h('option', { value: 'amount' }, 'Fixed amount'),
    );
    const value = h('input', { type: 'number', min: '1', step: '1', placeholder: '10' });
    const valueHint = h('span', { class: 'muted small' }, '% off');
    const maxUses = h('input', { type: 'number', min: '1', step: '1', placeholder: 'unlimited' });
    const expires = h('input', { type: 'datetime-local' });
    const note = h('input', { placeholder: 'Optional internal note' });

    kind.addEventListener('change', () => {
      valueHint.textContent = kind.value === 'percent' ? '% off' : 'minor units';
      value.placeholder = kind.value === 'percent' ? '10' : '200';
    });

    const create = h('button', { class: 'btn primary' }, 'Create coupon');
    create.addEventListener('click', async () => {
      create.disabled = true;
      try {
        const body = {
          code: code.value.trim(),
          kind: kind.value,
          ...(kind.value === 'percent'
            ? { percentOff: Number(value.value) }
            : { amountOffMinor: Number(value.value), currency: undefined }),
          ...(maxUses.value.trim() ? { maxRedemptions: Number(maxUses.value) } : {}),
          ...(expires.value ? { expiresAt: new Date(expires.value).toISOString() } : {}),
          ...(note.value.trim() ? { note: note.value.trim() } : {}),
        };
        await api.post('/api/v1/admin/coupons', body);
        toast('Coupon created');
        await load();
      } catch (err) {
        toast(err.message || 'Could not create the coupon', 'err');
        create.disabled = false;
      }
    });

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Coupons'),
          h('p', {}, 'Discount codes customers can enter at checkout. Each account can use a code once.'),
        ),
        h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
      ),
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Create a code')),
        h('div', { class: 'body' },
          h('div', { class: 'row', style: 'flex-wrap:wrap;gap:10px' },
            h('label', { class: 'field' }, h('span', {}, 'Code'), code),
            h('label', { class: 'field' }, h('span', {}, 'Type'), kind),
            h('label', { class: 'field' }, h('span', {}, 'Value'), h('div', { class: 'row' }, value, valueHint)),
            h('label', { class: 'field' }, h('span', {}, 'Max uses'), maxUses),
            h('label', { class: 'field' }, h('span', {}, 'Expires'), expires),
            h('label', { class: 'field' }, h('span', {}, 'Note'), note),
          ),
          create,
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          rows.length === 0
            ? h('div', { class: 'empty' }, 'No coupons yet.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Code'),
                h('th', {}, 'Discount'),
                h('th', {}, 'Used'),
                h('th', {}, 'Expires'),
                h('th', {}, 'Status'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...rows.map((c) => h('tr', {},
                h('td', {},
                  h('div', { class: 'mono' }, c.code),
                  c.note ? h('span', { class: 'muted small' }, c.note) : null,
                ),
                h('td', { class: 'small' }, amountLabel(c)),
                h('td', { class: 'small' }, c.maxRedemptions ? `${c.timesRedeemed} / ${c.maxRedemptions}` : `${c.timesRedeemed}`),
                h('td', { class: 'small muted' }, c.expiresAt ? date(c.expiresAt) : 'never'),
                h('td', {}, badge(c.active ? 'online' : 'offline')),
                h('td', { class: 'actions' },
                  h('button', {
                    class: 'btn sm',
                    onClick: async () => {
                      try {
                        await api.patch(`/api/v1/admin/coupons/${c.id}`, { active: !c.active });
                        toast(c.active ? 'Coupon disabled' : 'Coupon enabled');
                        await load();
                      } catch (err) {
                        toast(err.message || 'Could not update the coupon', 'err');
                      }
                    },
                  }, c.active ? 'Disable' : 'Enable'),
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

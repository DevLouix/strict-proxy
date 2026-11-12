/**
 * Operator billing actions: provider plans and subscription cancellation.
 *
 * Plans used to be created by hand in the provider's dashboard. This view makes
 * them a first-class, inspectable thing: what the catalog intends, what the
 * provider actually has, and where the two disagree.
 *
 * A price mismatch is called out rather than fixed. Silently repricing a live
 * plan changes what existing subscribers are billed, so that is never an
 * automatic action.
 */
import { h, mount, toast, money, badge, date } from './dom.js';

export async function plansView(api) {
  const host = h('div', {});
  let state = null;
  let providers = null;

  async function load() {
    state = await api.get('/api/v1/admin/billing/plans');
    // Asked separately so a gateway hiccup cannot blank the plan table; the
    // panel reports the failure instead of the whole screen going empty.
    try {
      providers = await api.get('/api/v1/admin/billing/providers');
    } catch (err) {
      providers = { error: err.message || String(err) };
    }
    render();
  }

  /**
   * Whether the gateway can actually take money right now, and if not, whether
   * the problem is ours (a bad key) or the merchant's account. The two look
   * identical in a failed charge, so this is shown before one happens.
   *
   * Both verdicts are shown because they disagree in practice: readiness says
   * whether the provider is routable at all, while the saved test says whether
   * the key is accepted. A green key check with an unroutable provider is a
   * real state — it is what a merchant account that cannot take money looks
   * like — so neither verdict is allowed to stand in for the other.
   */
  function providerPanel() {
    if (!providers) return null;
    if (providers.error) {
      return h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Payment gateway')),
        h('div', { class: 'empty' }, `Could not read provider status: ${providers.error}`),
      );
    }

    const rows = providers.providers ?? [];
    const configs = new Map((providers.configs ?? []).map((c) => [c.provider, c]));

    const testBtn = h('button', { class: 'btn sm' }, 'Test connection');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing…';
      try {
        const result = await api.post('/api/v1/admin/billing/providers/test', {});
        const bad = (result.results ?? []).filter((r) => !r.ok);
        if (bad.length === 0) toast('Provider connection test passed');
        else toast(bad[0].message || 'Provider connection test failed', 'err');
        await load();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test connection';
      }
    });

    return h('div', { class: 'panel' },
      h('header', {},
        h('h3', {}, 'Payment gateway'),
        h('div', { class: 'row' },
          h('span', { class: 'muted small' }, `${providers.currency} · health ${providers.health?.status ?? 'unknown'}`),
          testBtn,
        ),
      ),
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Provider'),
            h('th', {}, 'Can charge'),
            h('th', {}, 'Key mode'),
            h('th', {}, 'Credentials'),
            h('th', {}, 'What to do'),
          )),
          h('tbody', {}, ...rows.map((p) => {
            const config = configs.get(p.provider);
            // Two different verdicts, and they disagree in practice: the routing
            // view (`credentials`) is what actually gates a charge, while the
            // saved test only proves the key is accepted. Showing the key check
            // alone would let a green result imply payments work when they do
            // not, so both are shown, labelled.
            const routing = p.credentials ?? '—';
            const saved = config?.connectionError
              ? config.connectionError
              : config?.connectionStatus
                ? `${config.connectionStatus}${config.checkedAt ? ` (${date(config.checkedAt)})` : ''}`
                : 'not tested';
            const advice = p.next_steps?.length ? p.next_steps.join(' ') : (p.reasons ?? []).join(' ');
            return h('tr', {},
              h('td', {}, p.provider),
              h('td', {}, badge(p.available ? 'online' : p.configured ? 'degraded' : 'offline')),
              h('td', { class: 'small mono' }, p.key_mode ?? config?.keyMode ?? '—'),
              h('td', { class: 'small' },
                h('div', {}, `routing: ${routing}`),
                h('div', { class: 'muted', title: 'the key check — it does not prove the account can take money' }, `key check: ${saved}`),
              ),
              h('td', { class: 'small muted' }, advice || '—'),
            );
          })),
        ),
      ),
    );
  }

  /**
   * The currency new charges are opened in.
   *
   * Amounts are minor units, so the panel says what 200 means instead of leaving
   * an operator to guess, and it states the limit of the change: plans already at
   * the provider keep the currency they were created with.
   */
  function currencyPanel() {
    if (!state) return null;

    const input = h('input', {
      class: 'mono',
      maxlength: '3',
      size: '4',
      value: state.currency ?? '',
      title: 'ISO 4217 code, e.g. USD',
    });
    const save = h('button', { class: 'btn sm primary' }, 'Save currency');
    save.addEventListener('click', async () => {
      const code = String(input.value || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        toast('Enter a 3-letter ISO currency code, e.g. USD', 'err');
        return;
      }
      save.disabled = true;
      try {
        const result = await api.put('/api/v1/admin/billing/settings', { currency: code });
        toast(result.note || `Currency changed to ${result.currency}`);
        await load();
      } catch (err) {
        toast(err.message || 'Currency change failed', 'err');
        save.disabled = false;
      }
    });

    return h('div', { class: 'panel' },
      h('header', {},
        h('h3', {}, 'Currency'),
        h('span', { class: 'muted small' },
          state.currencyOverridden
            ? `overriding the deployment default ${state.defaultCurrency}`
            : `deployment default ${state.defaultCurrency}`),
      ),
      h('div', { class: 'row' }, input, save),
      h('p', { class: 'muted small' },
        'Prices are in minor units: 200 is 2.00 in a two-decimal currency. New checkouts and newly created plans use this; plans already at the provider keep the currency they were made with.'),
    );
  }

  function render() {
    const providerPlans = state?.providerPlans ?? [];
    // A tier's tag can sit on more than one plan when a delete archived one and a
    // replacement was created. Show the one that can actually be sold, so the
    // dashboard agrees with what provisioning will use.
    const byTier = new Map();
    for (const p of providerPlans) {
      if (!p.tier) continue;
      const seen = byTier.get(p.tier);
      if (!seen || (!seen.usable && p.usable)) byTier.set(p.tier, p);
    }
    const syncBtn = h('button', { class: 'btn primary' }, 'Create missing plans');

    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      try {
        const result = await api.post('/api/v1/admin/billing/plans/sync', {});
        const bits = [];
        if (result.created) bits.push(`${result.created} created`);
        if (result.reused) bits.push(`${result.reused} already present`);
        if (result.replaced?.length) bits.push(`${result.replaced.length} replaced`);
        if (result.errors?.length) bits.push(`${result.errors.length} failed`);
        toast(bits.join(', ') || 'Nothing to do');
        await load();
      } catch (err) {
        toast(err.message || 'Sync failed', 'error');
        syncBtn.disabled = false;
        syncBtn.textContent = 'Create missing plans';
      }
    });

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Plans'),
          h('p', {}, 'Recurring billing needs a provider plan per tier. These are created from the catalog, not by hand.'),
        ),
        syncBtn,
      ),
      currencyPanel(),
      providerPanel(),
      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Catalog vs provider'),
          state?.merchantId ? h('span', { class: 'muted small' }, `merchant ${state.merchantId}`) : null,
        ),
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Tier'),
              h('th', {}, 'Catalog price'),
              h('th', {}, 'Provider price'),
              h('th', {}, 'Interval'),
              h('th', {}, 'Status'),
              h('th', {}, 'Price'),
            )),
            h('tbody', {}, ...(state?.tiers ?? []).map((t) => {
              const plan = byTier.get(t.tier);
              const mismatch = plan && plan.amount !== t.expectedAmountMinor;
              return h('tr', {},
                h('td', {},
                  t.label,
                  // Showing the configured default makes an overridden price
                  // legible as a deliberate choice rather than the only price
                  // this deployment has ever had.
                  t.overridden
                    ? h('div', { class: 'muted small' }, `configured default ${money(t.configuredAmountMinor, t.currency)}`)
                    : null,
                ),
                h('td', {}, money(t.expectedAmountMinor, t.currency)),
                h('td', {}, plan ? money(plan.amount, plan.currency) : h('span', { class: 'muted' }, 'not created')),
                h('td', {}, plan?.interval ?? '—'),
                h('td', {},
                  !plan
                    ? h('span', { class: 'badge pending' }, 'missing')
                    : !plan.usable
                      // An archived plan is what a delete leaves behind when
                      // history references it — it cannot be subscribed to, and
                      // syncing now creates a replacement for it.
                      ? h('span', { class: 'badge failed', title: 'Kept by the provider for billing history, but it cannot be subscribed to. Syncing creates a replacement from the catalog price.' }, plan.status)
                      : mismatch
                        ? h('span', { class: 'badge degraded', title: 'The provider price does not match the catalog. Repricing a live plan would change what subscribers are billed, so this is not fixed automatically — use the Price control to change it deliberately.' }, 'price drift')
                        : h('span', { class: 'badge active' }, 'in sync'),
                ),
                h('td', {}, priceControl(t)),
              );
            })),
          ),
        ),
      ),
      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Plans at the provider'),
          h('p', { class: 'muted small' }, 'Everything the provider holds. Removing a plan the provider cannot drop outright leaves it archived — that is reported, because the tier is then left without a sellable plan.'),
        ),
        providerPlans.length === 0
          ? h('div', { class: 'empty' }, 'No plans at the provider yet.')
          : h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, 'Name'),
                  h('th', {}, 'Price'),
                  h('th', {}, 'Interval'),
                  h('th', {}, 'Tier'),
                  h('th', {}, 'Status'),
                  h('th', {}, ''),
                )),
                h('tbody', {}, ...providerPlans.map((p) => h('tr', {},
                  h('td', {}, p.name),
                  h('td', {}, money(p.amount, p.currency)),
                  h('td', {}, p.interval),
                  h('td', {}, p.tier
                    ? h('span', { class: 'small' }, p.tier)
                    : h('span', { class: 'muted small', title: 'Not created by this platform, so it is never adopted or modified.' }, 'not ours')),
                  h('td', {},
                    !p.usable
                      ? h('span', {
                          class: 'badge failed',
                          title: 'Cannot be subscribed to. An archived plan is what a delete leaves behind when billing history references it.',
                        }, p.status)
                      : h('span', { class: 'badge active' }, p.status),
                  ),
                  h('td', {}, removeButton(p)),
                ))),
              ),
            ),
      ),
    );
  }

  /**
   * An inline price editor.
   *
   * Deliberately not a bare number box: a price is what a customer is charged, so
   * the control says what the change will do before it is made, and states
   * plainly the one thing this platform cannot determine for itself — whether a
   * subscription already in flight is repriced by OpenPay.
   */
  function priceControl(t) {
    const cell = h('div', { class: 'price-control' });
    const change = h('button', { class: 'btn sm' }, 'Change');
    change.addEventListener('click', () => openEditor(t, cell));
    cell.append(change);

    if (t.overridden) {
      const reset = h('button', { class: 'btn sm', title: `Back to the configured ${money(t.configuredAmountMinor, t.currency)}` }, 'Reset');
      reset.addEventListener('click', async () => {
        reset.disabled = true;
        try {
          await api.del(`/api/v1/admin/billing/plans/price/${t.tier}`);
          toast('Reset to the price configured for this deployment');
          await load();
        } catch (err) {
          toast(err.message || 'Reset failed', 'error');
          reset.disabled = false;
        }
      });
      cell.append(reset);
    }
    return cell;
  }

  function openEditor(t, cell) {
    const input = h('input', {
      type: 'number',
      min: '0',
      step: '0.01',
      class: 'price-input',
      value: (t.expectedAmountMinor / 100).toFixed(2),
    });
    const save = h('button', { class: 'btn sm primary' }, 'Save');
    const cancel = h('button', { class: 'btn sm' }, 'Cancel');

    save.addEventListener('click', async () => {
      const major = Number(input.value);
      if (!Number.isFinite(major) || major <= 0) {
        toast('Enter an amount greater than zero', 'error');
        return;
      }
      save.disabled = true;
      try {
        const result = await api.put('/api/v1/admin/billing/plans/price', {
          tier: t.tier,
          amountMinor: Math.round(major * 100),
        });
        toast(result.note || 'Price updated');
        await load();
      } catch (err) {
        toast(err.message || 'Price change failed', 'error');
        save.disabled = false;
      }
    });
    cancel.addEventListener('click', () => render());

    mount(
      cell,
      input,
      save,
      cancel,
      h('p', { class: 'muted small' }, `${t.currency}. New customers are charged this amount. Whether a subscription already in flight is repriced is OpenPay's behaviour and cannot be checked from here — confirm it with OpenPay before relying on it.`),
    );
  }

  function removeButton(p) {
    const btn = h('button', { class: 'btn sm danger' }, 'Remove');
    btn.addEventListener('click', async () => {
      // Plan deletion cannot be undone, and a plan with subscribers behind it
      // will be archived rather than removed — say so before acting.
      if (!confirm(`Remove plan "${p.name}"? If any charge references it, the provider will archive it instead of deleting it.`)) return;
      btn.disabled = true;
      try {
        const result = await api.post('/api/v1/admin/billing/plans/delete', { planId: p.id });
        toast(
          result.archived
            ? 'Archived, not removed: billing history references this plan. That tier now has no sellable plan.'
            : 'Plan removed',
          result.archived ? 'error' : undefined,
        );
        await load();
      } catch (err) {
        toast(err.message || 'Remove failed', 'error');
        btn.disabled = false;
      }
    });
    return btn;
  }

  await load();
  return host;
}

/**
 * Lists the provider's subscriptions so an operator can cancel one.
 *
 * Read-only apart from the cancel action, which asks first — it ends a paying
 * customer's service immediately.
 */
export async function subscriptionsView(api) {
  const host = h('div', {});
  let rows = [];

  async function load() {
    const data = await api.get('/api/v1/admin/billing/subscriptions');
    rows = data.subscriptions ?? [];
    render();
  }

  function render() {
    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Subscriptions'),
          h('p', {}, 'Recurring subscriptions at the provider.'),
        ),
        h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
      ),
      rows.length === 0
        ? h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'No subscriptions at the provider yet.'))
        : h('div', { class: 'panel' },
            h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, 'Subscription'),
                  h('th', {}, 'Local user'),
                  h('th', {}, 'Status'),
                  h('th', {}, 'Current period ends'),
                  h('th', {}, ''),
                )),
                h('tbody', {}, ...rows.map((s) => h('tr', {},
                  h('td', { class: 'small mono' }, s.id),
                  h('td', {}, s.userId ? h('span', { class: 'small' }, s.userId) : h('span', { class: 'muted' }, 'unknown')),
                  h('td', {}, h('span', { class: `badge ${s.status === 'active' ? 'active' : 'muted'}` }, s.status)),
                  h('td', { class: 'small' }, s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—'),
                  h('td', {}, cancelButton(s)),
                ))),
              ),
            ),
          ),
    );
  }

  function cancelButton(s) {
    const btn = h('button', { class: 'btn sm danger' }, 'Cancel');
    btn.addEventListener('click', async () => {
      if (!confirm(`Cancel subscription ${s.id}? This ends the customer's access immediately.`)) return;
      btn.disabled = true;
      try {
        await api.post('/api/v1/admin/billing/subscriptions/cancel', {
          providerSubscriptionId: s.id,
          ...(s.userId ? { userId: s.userId } : {}),
        });
        toast('Subscription cancelled');
        await load();
      } catch (err) {
        toast(err.message || 'Cancel failed', 'error');
        btn.disabled = false;
      }
    });
    return btn;
  }

  await load();
  return host;
}

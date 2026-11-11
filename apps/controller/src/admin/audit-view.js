/**
 * Operator audit log.
 *
 * Every destructive admin action writes a row: who, what, to which object, and
 * when. This screen is what makes a second administrator account safe to hand
 * out — without it, "the plan was revoked" has no answer.
 *
 * The list is read-only by design. Nothing in the dashboard may edit or delete
 * an audit row; retention is an operational decision, not a UI one.
 */
import { h, mount, date, ago, badge, toast } from './dom.js';

export async function auditView(api) {
  const host = h('div', {});
  let rows = [];
  let filter = '';

  async function load() {
    const data = await api.get('/api/v1/admin/audit?limit=200');
    rows = data.entries ?? [];
    draw();
  }

  function draw() {
    const needle = filter.trim().toLowerCase();
    const visible = rows.filter((row) => {
      if (!needle) return true;
      return `${row.actorEmail ?? ''} ${row.action ?? ''} ${row.targetType ?? ''} ${row.targetId ?? ''} ${row.summary ?? ''}`
        .toLowerCase()
        .includes(needle);
    });

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Audit log'),
          h('p', {}, 'Who did what to which account, node or checkout. Append-only.'),
        ),
        h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
      ),
      h('div', { class: 'toolbar' },
        h('input', {
          type: 'search',
          placeholder: 'Filter by actor, action, target or summary…',
          value: filter,
          onInput: (e) => { filter = e.target.value; draw(); },
        }),
        h('span', { class: 'muted small' }, `${visible.length} of ${rows.length} shown`),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'table-wrap' },
          visible.length === 0
            ? h('div', { class: 'empty' },
                rows.length === 0
                  ? 'No operator actions have been recorded yet.'
                  : 'No recorded actions match this filter.')
            : h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, 'When'),
                  h('th', {}, 'Actor'),
                  h('th', {}, 'Action'),
                  h('th', {}, 'Target'),
                  h('th', {}, 'Summary'),
                )),
                h('tbody', {}, ...visible.map((row) => h('tr', {},
                  h('td', { class: 'small muted', title: date(row.createdAt) }, ago(row.createdAt)),
                  h('td', { class: 'small' },
                    h('div', {}, row.actorEmail ?? '—'),
                    row.actorId ? h('span', { class: 'muted small mono' }, row.actorId) : null,
                  ),
                  h('td', {}, badge(row.action ?? 'unknown')),
                  h('td', { class: 'small' },
                    h('div', {}, row.targetType ?? '—'),
                    row.targetId ? h('span', { class: 'muted small mono' }, row.targetId) : null,
                  ),
                  h('td', { class: 'small' },
                    h('div', {}, row.summary ?? '—'),
                    row.metadata
                      ? h('details', {},
                          h('summary', { class: 'muted small' }, 'Details'),
                          h('pre', { class: 'copy', style: 'max-height:160px;overflow:auto;margin-top:6px' },
                            JSON.stringify(row.metadata, null, 2)),
                        )
                      : null,
                  ),
                ))),
              ),
        ),
      ),
    );
  }

  try {
    await load();
  } catch (err) {
    toast(err.message || 'Could not load the audit log', 'err');
    mount(host,
      h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, 'Audit log'))),
      h('div', { class: 'panel' }, h('div', { class: 'empty' }, err.message || 'Could not load the audit log.')),
    );
  }
  return host;
}
